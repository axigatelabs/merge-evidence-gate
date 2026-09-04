/**
 * The offline CLI, driven the way a study harness drives it.
 *
 * `main(argv)` is exported precisely so this suite can run it in-process: the
 * bundle it ships in adds nothing but an entry guard, and building it here would
 * cost a minute of CI for no extra coverage. What is asserted is the contract a
 * harness depends on — the receipt, the meta sidecar, the one-line summary, and
 * the exit codes, which say "the gate ran" or "the gate could not run" and never
 * encode the verdict.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../../src/cli.js';

/** Vitest runs from the repository root, as the other suites here assume. */
const REPO_ROOT = process.cwd();

/** Generous: the passing cases spawn a real test command inside a temp checkout. */
const E2E_TIMEOUT_MS = 180_000;

const MATH_SOURCE = `export const add = (a, b) => a + b;
export const mul = (a, b) => a * b;
`;

const MATH_TESTS = `import { describe, expect, it } from 'vitest';
import { add, mul } from '../src/math.js';

describe('math', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('multiplies', () => { expect(mul(2, 3)).toBe(6); });
});
`;

const STRINGS_TESTS = `import { describe, expect, it } from 'vitest';

describe('strings', () => {
  it('uppercases', () => { expect('a'.toUpperCase()).toBe('A'); });
  it('trims', () => { expect(' a '.trim()).toBe('a'); });
});
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'demo-cli-pr',
    private: true,
    type: 'module',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^3.2.4' },
  },
  null,
  2,
)}\n`;

/** The claims the PR makes: four green tests, when the change leaves two. */
const CONTRADICTED_BODY = `## Summary

Adds \`div\`.

## Test plan

- [x] \`npm test\` — 4 tests, 0 failures

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;

function write(dir: string, relativePath: string, contents: string): void {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/**
 * A checkout whose head deletes a test file: four tests at the base, two at the
 * head, and a PR body that still reports four.
 */
function createRepo(): { dir: string; baseSha: string; headSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-cli-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');

  write(dir, '.gitignore', 'node_modules/\n.merge-evidence/\n');
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'src/math.js', MATH_SOURCE);
  write(dir, 'test/math.test.js', MATH_TESTS);
  write(dir, 'test/strings.test.js', STRINGS_TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base: math helpers with tests');
  const baseSha = git(dir, 'rev-parse', 'HEAD').trim();

  rmSync(join(dir, 'test/strings.test.js'));
  write(dir, 'src/math.js', `${MATH_SOURCE}export const div = (a, b) => a / b;\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add div');
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();

  // Dependencies come from this repository, so the demo never hits the network.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, baseSha, headSha };
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI in this process with the streams captured and the variables the
 * outer vitest sets for its own children removed — a nested vitest must not
 * inherit its parent's worker wiring.
 */
async function runCli(argv: string[]): Promise<CliRun> {
  const savedEnv = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') {
      savedEnv.set(key, value);
      delete process.env[key];
    }
  }

  let stdout = '';
  let stderr = '';
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const [key, value] of savedEnv) process.env[key] = value;
  }
}

/** The `merge-evidence: …` line the CLI prints last. */
function summaryLine(stdout: string): string {
  const lines = stdout.split('\n').filter((candidate) => candidate.startsWith('merge-evidence: verdict='));
  return lines[lines.length - 1] ?? '';
}

describe('cli', () => {
  let repo: { dir: string; baseSha: string; headSha: string };
  let outDir: string;

  beforeAll(() => {
    repo = createRepo();
    outDir = mkdtempSync(join(tmpdir(), 'meg-cli-out-'));
    write(repo.dir, 'PR_BODY.md', CONTRADICTED_BODY);
  });

  afterAll(() => {
    for (const dir of [repo?.dir, outDir]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a receipt, a sidecar and a summary line, and still exits 0 on FAIL', async () => {
    const out = join(outDir, 'fail', 'receipt.json');
    const markdown = join(outDir, 'fail', 'receipt.md');
    const run = await runCli([
      '--work', repo.dir,
      '--repo', 'example/demo',
      '--pr', '42',
      '--head', repo.headSha,
      '--base', repo.baseSha,
      '--author', 'demo-agent',
      '--head-ref', 'claude/add-div',
      '--base-ref', 'main',
      '--title', 'math: add div',
      '--body-file', join(repo.dir, 'PR_BODY.md'),
      '--out', out,
      '--markdown', markdown,
    ]);

    // A verdict is a result, not a failure of the tool.
    expect(run.code).toBe(0);

    const receipt: unknown = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt).toMatchObject({
      schema: 'merge-evidence/receipt/v1',
      verdict: 'FAIL',
      pr: { repo: 'example/demo', number: 42, head_sha: repo.headSha, author: 'demo-agent' },
    });

    const meta: unknown = JSON.parse(readFileSync(`${out}.meta.json`, 'utf8'));
    expect(meta).toMatchObject({
      verdict: 'FAIL',
      skipped: null,
      agent: { detected: 'claude', isAgent: true },
    });
    expect((meta as { title: string }).title).toContain('FAIL');
    expect(Array.isArray((meta as { unverifiable: unknown }).unverifiable)).toBe(true);
    expect(Array.isArray((meta as { notes: unknown }).notes)).toBe(true);

    expect(readFileSync(markdown, 'utf8')).toContain('merge-evidence-gate');
    expect(summaryLine(run.stdout)).toMatch(
      /^merge-evidence: verdict=FAIL discrepancies=[1-9]\d* tests=\d+\/\d+ unverifiable=\d+$/,
    );
  }, E2E_TIMEOUT_MS);

  it('records the skip for a human PR, receipt or no receipt', async () => {
    const out = join(outDir, 'skip', 'receipt.json');
    const run = await runCli([
      '--work', repo.dir,
      '--head', repo.headSha,
      '--base', repo.baseSha,
      '--author', 'a-person',
      '--head-ref', 'feature/add-div',
      '--title', 'math: add div',
      '--out', out,
    ]);

    expect(run.code).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(JSON.parse(readFileSync(`${out}.meta.json`, 'utf8'))).toMatchObject({
      verdict: 'NEUTRAL',
      skipped: 'not-agent',
      title: '',
    });
    expect(summaryLine(run.stdout)).toBe(
      'merge-evidence: verdict=NEUTRAL discrepancies=0 tests=0/0 unverifiable=0',
    );
  }, E2E_TIMEOUT_MS);

  it('reads commit messages, so a co-author trailer still gates the PR', async () => {
    const commitsFile = join(outDir, 'commits.txt');
    writeFileSync(
      commitsFile,
      'math: add div\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nchore: tidy\n',
      'utf8',
    );
    const out = join(outDir, 'coauthor', 'receipt.json');
    const run = await runCli([
      '--work', repo.dir,
      '--head', repo.headSha,
      '--base', repo.baseSha,
      '--author', 'a-person',
      '--head-ref', 'feature/add-div',
      '--commits-file', commitsFile,
      '--test-command', 'echo "already verified upstream"',
      '--out', out,
    ]);

    expect(run.code).toBe(0);
    expect(JSON.parse(readFileSync(`${out}.meta.json`, 'utf8'))).toMatchObject({
      skipped: null,
      agent: { detected: 'claude', isAgent: true },
    });
  }, E2E_TIMEOUT_MS);

  it('gates a human PR when --agents-only false', async () => {
    const out = join(outDir, 'everyone', 'receipt.json');
    const run = await runCli([
      '--work', repo.dir,
      '--head', repo.headSha,
      '--author', 'a-person',
      '--agents-only', 'false',
      '--test-command', 'echo "already verified upstream"',
      '--out', out,
    ]);

    expect(run.code).toBe(0);
    expect(JSON.parse(readFileSync(`${out}.meta.json`, 'utf8'))).toMatchObject({ skipped: null });
    expect(existsSync(out)).toBe(true);
  }, E2E_TIMEOUT_MS);

  it('exits 2 without --work, and says so on stderr', async () => {
    const run = await runCli(['--head', 'deadbeef', '--out', join(outDir, 'never.json')]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--work');
    expect(run.stdout).toBe('');
  });

  it('exits 2 on a work directory that is not there', async () => {
    const run = await runCli([
      '--work', join(outDir, 'no-such-checkout'),
      '--head', 'deadbeef',
      '--out', join(outDir, 'never.json'),
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('is not a directory');
  });

  it('exits 2 on an unknown flag, and prints the usage', async () => {
    const run = await runCli(['--work', repo.dir, '--head', repo.headSha, '--nope']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--nope');
    expect(run.stderr).toContain('Usage: merge-evidence');
  });

  it('exits 2 without --out', async () => {
    const run = await runCli(['--work', repo.dir, '--head', repo.headSha]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--out');
  });
});
