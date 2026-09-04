/**
 * `evaluate` end to end: a real repository, a real test run, a real verdict.
 *
 * `test/action/e2e.test.ts` walks the pipeline step by step to prove the core
 * modules compose. This suite exercises the composed function both front-ends
 * actually call — the Action and the offline CLI both hand `evaluate` a work
 * directory and a `PullRequestFacts`, so what it decides here is what a PR gets.
 *
 * Nothing touches the network: the demo repository's dependencies are this
 * repository's own `node_modules`, symlinked in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/core/reconcile/index.js';
import type { PullRequestFacts } from '../../src/core/types.js';
import { evaluate, type EvaluateResult } from '../../src/pipeline.js';

/** Vitest runs from the repository root, as the other suites here assume. */
const REPO_ROOT = process.cwd();

/** Generous: each case spawns a real test command inside a temp checkout. */
const E2E_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// The demo repository
// ---------------------------------------------------------------------------

const MATH_SOURCE = `export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
export const mul = (a, b) => a * b;
export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
`;

const STRINGS_SOURCE = `export const upper = (s) => s.toUpperCase();
export const trim = (s) => s.trim();
`;

/** Eight passing tests; the contradicted PR mutates one of them. */
const MATH_TESTS = `import { describe, expect, it } from 'vitest';
import { add, sub, mul, clamp } from '../src/math.js';

describe('math', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('adds negatives', () => { expect(add(-1, -2)).toBe(-3); });
  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });
  it('subtracts to zero', () => { expect(sub(2, 2)).toBe(0); });
  it('multiplies', () => { expect(mul(2, 3)).toBe(6); });
  it('multiplies by zero', () => { expect(mul(2, 0)).toBe(0); });
  it('clamps low', () => { expect(clamp(-5, 0, 10)).toBe(0); });
  it('clamps high', () => { expect(clamp(50, 0, 10)).toBe(10); });
});
`;

/** Four passing tests, in the file the contradicted PR deletes. */
const STRINGS_TESTS = `import { describe, expect, it } from 'vitest';
import { upper, trim } from '../src/strings.js';

describe('strings', () => {
  it('uppercases', () => { expect(upper('a')).toBe('A'); });
  it('uppercases empty', () => { expect(upper('')).toBe(''); });
  it('trims', () => { expect(trim(' a ')).toBe('a'); });
  it('trims empty', () => { expect(trim('   ')).toBe(''); });
});
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'demo-agent-pr',
    private: true,
    type: 'module',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^3.2.4' },
  },
  null,
  2,
)}\n`;

function write(dir: string, relativePath: string, contents: string): void {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'meg-eval-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * A checkout with the base commit in place: twelve passing tests across two
 * files, and this repository's `node_modules` symlinked in so the test command
 * runs offline.
 */
function createBaseRepo(): { dir: string; baseSha: string } {
  const dir = initRepo();
  write(dir, '.gitignore', 'node_modules/\n.merge-evidence/\n');
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'src/math.js', MATH_SOURCE);
  write(dir, 'src/strings.js', STRINGS_SOURCE);
  write(dir, 'test/math.test.js', MATH_TESTS);
  write(dir, 'test/strings.test.js', STRINGS_TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base: math and string helpers with tests');

  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD').trim() };
}

/**
 * The contradicted PR: it deletes a whole test file and focuses one of the
 * survivors, then reports twelve green tests — the number that passed *before*
 * the change.
 */
function applyContradictedChange(dir: string): string {
  rmSync(join(dir, 'test/strings.test.js'));
  write(dir, 'test/math.test.js', MATH_TESTS.replace("it('adds',", "it.only('adds',"));
  write(dir, 'src/math.js', `${MATH_SOURCE}export const div = (a, b) => a / b;\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add div and tidy the suite');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** The honest PR: one new helper, one new test for it, nothing hidden. */
function applyHonestChange(dir: string): string {
  write(dir, 'src/math.js', `${MATH_SOURCE}export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;\n`);
  write(
    dir,
    'test/math.test.js',
    MATH_TESTS.replace(
      "import { add, sub, mul, clamp } from '../src/math.js';",
      "import { add, sub, mul, clamp, mean } from '../src/math.js';",
    ).replace(
      "  it('clamps high', () => { expect(clamp(50, 0, 10)).toBe(10); });\n",
      "  it('clamps high', () => { expect(clamp(50, 0, 10)).toBe(10); });\n  it('means', () => { expect(mean([1, 2, 3])).toBe(2); });\n",
    ),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add mean');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const CLAUDE_FOOTER = `\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;

const CONTRADICTED_BODY = `## Summary

Adds \`div\` to the math helpers and tidies the test suite.

## Test plan

- [x] \`npm test\` — 12 tests, 0 failures
${CLAUDE_FOOTER}`;

const HONEST_BODY = `## Summary

Adds \`mean\` to \`src/math.js\`, with a test for it in \`test/math.test.js\`.

## Test plan

- [x] \`npm test\` — 13 tests, 0 failures
${CLAUDE_FOOTER}`;

function facts(overrides: Partial<PullRequestFacts>): PullRequestFacts {
  return {
    repo: 'example/demo',
    number: 7,
    headSha: '',
    baseSha: '',
    baseRef: 'main',
    headRef: 'claude/add-div',
    authorLogin: 'demo-agent',
    body: '',
    title: 'math: add div',
    commitMessages: [],
    ...overrides,
  };
}

/**
 * Run `evaluate` with the variables this outer vitest sets for its own children
 * removed — `mergedEnv` hands the whole environment to the test command, and a
 * nested vitest must not inherit its parent's worker wiring.
 */
async function evaluateOffline(
  options: Parameters<typeof evaluate>[0],
): Promise<EvaluateResult> {
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  try {
    return await evaluate(options);
  } finally {
    for (const [key, value] of saved) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('evaluate: a PR whose claims the run contradicts', () => {
  let dir: string;
  let result: EvaluateResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyContradictedChange(dir);
    result = await evaluateOffline({
      workDir: dir,
      pr: facts({ baseSha: repo.baseSha, headSha, body: CONTRADICTED_BODY }),
      policy: { ...DEFAULT_POLICY },
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('fails the PR', () => {
    expect(result.skipped).toBeUndefined();
    expect(result.verdict).toBe('FAIL');
    expect(result.receipt?.verdict).toBe('FAIL');
  });

  it('fires C3 for the deleted test file and the added focus marker', () => {
    const c3 = result.discrepancies.filter((d) => d.check === 'C3');
    expect(c3.length).toBeGreaterThan(0);
    expect(c3.some((d) => d.severity === 'fail')).toBe(true);

    const evidence = c3.flatMap((d) => d.evidence).join('\n');
    expect(evidence).toContain('test/strings.test.js');
    expect(evidence).toContain('it.only(');
  });

  it('records the run it judged, and recognises the agent', () => {
    expect(result.agent.detected).toBe('claude');
    expect(result.receipt?.observed.command).toContain('--reporter=json');
    expect(result.receipt?.observed.tests_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.receipt?.observed.totals.run).not.toBe(12);
  });

  it('renders one comment and a receipt ready to write', () => {
    expect(result.rendered?.markdown).toContain(result.rendered?.marker ?? '');
    expect(result.rendered?.title).toContain('FAIL');
    expect(result.receiptJson?.endsWith('\n')).toBe(true);
    expect(JSON.parse(result.receiptJson ?? '{}')).toEqual(result.receipt);
  });
});

describe('evaluate: an honest PR', () => {
  let dir: string;
  let result: EvaluateResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyHonestChange(dir);
    result = await evaluateOffline({
      workDir: dir,
      pr: facts({
        baseSha: repo.baseSha,
        headSha,
        headRef: 'claude/add-mean',
        title: 'math: add mean',
        body: HONEST_BODY,
      }),
      policy: { ...DEFAULT_POLICY },
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('runs all thirteen tests green and passes', () => {
    expect(result.receipt?.observed.exit_code).toBe(0);
    expect(result.receipt?.observed.totals).toMatchObject({ run: 13, passed: 13, failed: 0 });
    expect(result.verdict).toBe('PASS');
    expect(result.discrepancies.filter((d) => d.severity !== 'info')).toEqual([]);
  });
});

describe('evaluate: a human PR under agents-only', () => {
  let dir: string;
  let baseSha: string;
  let headSha: string;

  beforeAll(() => {
    const repo = createBaseRepo();
    dir = repo.dir;
    baseSha = repo.baseSha;
    headSha = applyHonestChange(dir);
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  const humanPr = (): PullRequestFacts =>
    facts({
      baseSha,
      headSha,
      headRef: 'feature/add-mean',
      authorLogin: 'a-person',
      title: 'math: add mean',
      body: '## Summary\n\nAdds `mean`.\n',
    });

  it('skips without running anything', async () => {
    const result = await evaluateOffline({
      workDir: dir,
      pr: humanPr(),
      policy: { ...DEFAULT_POLICY },
      agentsOnly: true,
    });
    expect(result.skipped).toBe('not-agent');
    expect(result.verdict).toBe('NEUTRAL');
    expect(result.agent.isAgent).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(result.rendered).toBeUndefined();
    expect(result.receiptJson).toBeUndefined();
  });

  it('gates it anyway when agents-only is off', async () => {
    const result = await evaluateOffline({
      workDir: dir,
      pr: humanPr(),
      policy: { ...DEFAULT_POLICY },
      agentsOnly: false,
    });
    expect(result.skipped).toBeUndefined();
    expect(result.verdict).toBe('PASS');
  }, E2E_TIMEOUT_MS);
});

describe('evaluate: skipInstall', () => {
  let dir: string;
  let result: EvaluateResult;

  beforeAll(async () => {
    // A checkout with a lockfile and no `node_modules`: the install plan would
    // be `npm ci`, which is exactly what `skipInstall` must not run.
    dir = initRepo();
    write(dir, 'package.json', PACKAGE_JSON);
    write(dir, 'package-lock.json', '{ "lockfileVersion": 3 }\n');
    write(dir, 'src/math.js', MATH_SOURCE);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base: math helpers');
    const baseSha = git(dir, 'rev-parse', 'HEAD').trim();

    write(dir, 'src/math.js', `${MATH_SOURCE}export const div = (a, b) => a / b;\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'math: add div');
    const headSha = git(dir, 'rev-parse', 'HEAD').trim();

    result = await evaluateOffline({
      workDir: dir,
      pr: facts({ baseSha, headSha, body: `Adds \`div\`.${CLAUDE_FOOTER}` }),
      policy: { ...DEFAULT_POLICY },
      testCommand: 'echo "no dependencies needed"',
      skipInstall: true,
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the dependencies alone', () => {
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect(result.notes.filter((note) => note.startsWith('dependencies:'))).toEqual([]);
  });

  it('still runs the command it was given and reaches a verdict', () => {
    expect(result.receipt?.observed.command).toBe('echo "no dependencies needed"');
    expect(result.receipt?.observed.exit_code).toBe(0);
    expect(['PASS', 'NEUTRAL', 'NEEDS_HUMAN']).toContain(result.verdict);
  });
});
