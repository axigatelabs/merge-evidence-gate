/**
 * End-to-end: a real repository, a real test run, a real verdict.
 *
 * The unit tests cover each module against fixtures; this one proves the pieces
 * compose. It builds a git repository with a small vitest suite in a temp
 * directory, commits a base, applies a pull request on top, and then walks the
 * exact sequence `src/main.ts` walks — detect → run → normalize → diff → claims
 * → reconcile → receipt → render — asserting the verdict a reviewer would get.
 *
 * Nothing here touches the network or GitHub: the PR is a `PullRequestFacts`
 * object, and the repository's dependencies are the ones this repo already has
 * (its `node_modules` is symlinked in), so the suite stays hermetic.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as exec from '@actions/exec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNameStatus, readManifests, readReport } from '../../src/action/env.js';
import { detectAgent, extractClaims } from '../../src/core/claims/index.js';
import { analyzeDiff } from '../../src/core/diff/index.js';
import {
  buildReceipt,
  DEFAULT_POLICY,
  MAX_COMMENT_BYTES,
  reconcile,
  renderComment,
} from '../../src/core/reconcile/index.js';
import { detectTestCommand, normalize } from '../../src/core/runners/index.js';
import type { ObservedRun, PullRequestFacts, Receipt, RenderedComment, RunnerFamily } from '../../src/core/types.js';

/** Vitest runs from the repository root, as the other suites here assume. */
const REPO_ROOT = process.cwd();

/** Generous: each case spawns a real `npm test` inside a temp checkout. */
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

/** Eight passing tests; the PR mutates one of them. */
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

/** Four passing tests, in the file the lying PR deletes. */
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
    name: 'demo-lying-pr',
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

/**
 * A checkout with the base commit in place: twelve passing tests across two
 * files, and this repository's `node_modules` symlinked in so `npm test` runs
 * offline.
 */
function createBaseRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-e2e-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');

  write(dir, '.gitignore', 'node_modules/\n.merge-evidence/\n');
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'src/math.js', MATH_SOURCE);
  write(dir, 'src/strings.js', STRINGS_SOURCE);
  write(dir, 'test/math.test.js', MATH_TESTS);
  write(dir, 'test/strings.test.js', STRINGS_TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base: math and string helpers with tests');

  // Dependencies come from this repository, so the demo never hits the network.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');

  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD').trim() };
}

/**
 * The lying PR: it deletes a whole test file and focuses one of the survivors,
 * then reports twelve green tests — the number that passed *before* the change.
 */
function applyLyingChange(dir: string): string {
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

const LYING_BODY = `## Summary

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

// ---------------------------------------------------------------------------
// The pipeline, exactly as src/main.ts runs it
// ---------------------------------------------------------------------------

/** The runner's env, minus the vars this outer vitest sets for its own children. */
function childEnv(overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST')) continue;
    if (key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') continue;
    env[key] = value;
  }
  return { ...env, ...overlay };
}

interface PipelineResult {
  observed: ObservedRun;
  receipt: Receipt;
  rendered: RenderedComment;
  unverifiable: string[];
}

/**
 * Detect the command, run it, normalize the report, diff base against head,
 * extract the claims, reconcile, build the receipt and render the comment.
 */
async function runPipeline(
  dir: string,
  pr: PullRequestFacts,
  expectedFamily: RunnerFamily = 'vitest',
): Promise<PipelineResult> {
  const detected = detectTestCommand({ files: readManifests(dir) });
  expect(detected).not.toBeNull();
  if (detected === null) throw new Error('unreachable');
  expect(detected.family).toBe(expectedFamily);

  mkdirSync(join(dir, '.merge-evidence'), { recursive: true });
  let stdout = '';
  const started = Date.now();
  const exitCode = await exec.exec('bash', ['-c', detected.command], {
    cwd: dir,
    env: childEnv(detected.env),
    ignoreReturnCode: true,
    silent: true,
    listeners: { stdout: (data: Buffer) => { stdout += data.toString(); } },
  });
  const durationMs = Date.now() - started;

  const raw = readReport(join(dir, detected.reportPath)) ?? stdout;
  const { tests, totals } = normalize(detected.family, raw, { cwd: realpathSync(dir) });

  const observed: ObservedRun = {
    command: detected.command,
    runner: detected.family,
    exitCode,
    durationMs,
    toolchain: { node: process.version.replace(/^v/, '') },
    totals,
    tests,
    reportPath: detected.reportPath,
  };

  const changed = parseNameStatus(
    git(dir, 'diff', '--name-status', '-M', `${pr.baseSha}...${pr.headSha}`),
    git(dir, 'diff', '--unified=0', '-M', `${pr.baseSha}...${pr.headSha}`),
  );
  const diff = analyzeDiff(changed, {});

  const agent = detectAgent(pr);
  const claims = extractClaims(pr);
  const { discrepancies, verdict, unverifiable } = reconcile({
    pr,
    claims,
    observed,
    diff,
    policy: DEFAULT_POLICY,
  });
  const receipt = buildReceipt({
    pr,
    agent,
    claims,
    observed,
    diff,
    discrepancies,
    verdict,
    policy: DEFAULT_POLICY,
    now: new Date('2026-01-01T00:00:00Z'),
  });

  return { observed, receipt, rendered: renderComment(receipt, { unverifiable }), unverifiable };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('end to end: a lying agent PR', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyLyingChange(dir);
    result = await runPipeline(
      dir,
      facts({ baseSha: repo.baseSha, headSha, body: LYING_BODY }),
    );
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('recognises the PR as agent-authored', () => {
    expect(result.receipt.agent.detected).toBe('claude');
    expect(result.receipt.agent.signals.length).toBeGreaterThan(0);
  });

  it('records a real run whose numbers are not the claimed twelve', () => {
    expect(result.observed.command).toContain('--reporter=json');
    expect(result.observed.tests.length).toBeGreaterThan(0);
    expect(result.observed.totals.run).not.toBe(12);
    expect(result.receipt.observed.tests_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fails the PR', () => {
    expect(result.receipt.verdict).toBe('FAIL');
  });

  it('fires C3 for the deleted test file and the added focus marker', () => {
    const c3 = result.receipt.discrepancies.filter((d) => d.check === 'C3');
    expect(c3.length).toBeGreaterThan(0);
    expect(c3.some((d) => d.severity === 'fail')).toBe(true);

    const evidence = c3.flatMap((d) => d.evidence).join('\n');
    expect(evidence).toContain('test/strings.test.js');
    expect(evidence).toContain('it.only(');
  });

  it('fires C2 because the claimed count is not what ran', () => {
    const c2 = result.receipt.discrepancies.filter((d) => d.check === 'C2');
    expect(c2).toHaveLength(1);
    expect(c2[0]?.evidence).toContain('claimed total=12');
  });

  it('renders one comment that fits on a screen', () => {
    expect(result.rendered.markdown).toContain(result.rendered.marker);
    expect(result.rendered.marker).toContain('merge-evidence-gate');
    expect(Buffer.byteLength(result.rendered.markdown, 'utf8')).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
    expect(result.rendered.markdown).toContain('FAIL');
    expect(result.rendered.title).toContain('FAIL');
  });

  it('writes a receipt that names the commits it judged', () => {
    expect(result.receipt.schema).toBe('merge-evidence/receipt/v1');
    expect(result.receipt.diff.tests.deleted).toContain('test/strings.test.js');
    expect(JSON.stringify(result.receipt, null, 2)).toContain('"verdict": "FAIL"');
  });
});

describe('end to end: an honest agent PR', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyHonestChange(dir);
    result = await runPipeline(
      dir,
      facts({
        baseSha: repo.baseSha,
        headSha,
        headRef: 'claude/add-mean',
        title: 'math: add mean',
        body: HONEST_BODY,
      }),
    );
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('runs all thirteen tests green', () => {
    expect(result.observed.exitCode).toBe(0);
    expect(result.observed.totals).toMatchObject({ run: 13, passed: 13, failed: 0 });
  });

  it('passes, with nothing held against it', () => {
    expect(result.receipt.discrepancies.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(result.receipt.verdict).toBe('PASS');
  });

  it('renders a passing comment with the same marker', () => {
    expect(result.rendered.markdown).toContain(result.rendered.marker);
    expect(result.rendered.markdown).toContain('PASS');
    expect(Buffer.byteLength(result.rendered.markdown, 'utf8')).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
  });
});

// ---------------------------------------------------------------------------
// node's built-in test runner: no dependencies, reporter through NODE_OPTIONS
// ---------------------------------------------------------------------------

const NODE_PACKAGE_JSON = `${JSON.stringify(
  { name: 'demo-node-test', private: true, type: 'module', scripts: { test: 'node --test' } },
  null,
  2,
)}\n`;

const NODE_MATH_TESTS = `import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub } from '../src/math.js';

describe('math', () => {
  test('adds', () => { assert.equal(add(1, 2), 3); });
  test('subtracts', () => { assert.equal(sub(2, 1), 1); });
});
test('top level: adds negatives', () => { assert.equal(add(-1, -2), -3); });
`;

const NODE_BODY = `## Summary

Adds \`mul\` to \`src/math.js\`, with a test in \`test/math.test.js\`.

## Test plan

- [x] \`npm test\` — 4 tests, 0 failures
${CLAUDE_FOOTER}`;

function createNodeTestRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-e2e-node-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, '.gitignore', '.merge-evidence/\n');
  write(dir, 'package.json', NODE_PACKAGE_JSON);
  write(dir, 'src/math.js', MATH_SOURCE);
  write(dir, 'test/math.test.js', NODE_MATH_TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base: math helpers tested with node --test');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD').trim() };
}

function applyNodeHonestChange(dir: string): string {
  write(
    dir,
    'test/math.test.js',
    NODE_MATH_TESTS.replace("import { add, sub } from '../src/math.js';", "import { add, sub, mul } from '../src/math.js';").replace(
      "  test('subtracts', () => { assert.equal(sub(2, 1), 1); });\n",
      "  test('subtracts', () => { assert.equal(sub(2, 1), 1); });\n  test('multiplies', () => { assert.equal(mul(2, 3), 6); });\n",
    ),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: test mul');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

describe("end to end: a PR tested with node's built-in runner", () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    const repo = createNodeTestRepo();
    dir = repo.dir;
    const headSha = applyNodeHonestChange(dir);
    result = await runPipeline(dir, facts({ headSha, baseSha: repo.baseSha, body: NODE_BODY }), 'node-test');
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the package script unchanged, with the junit reporter attached through the environment', () => {
    expect(result.observed.command).toBe('npm test');
    expect(result.observed.runner).toBe('node-test');
    expect(result.observed.exitCode).toBe(0);
  });

  it('enumerates every test with a repository-relative id and the describe path', () => {
    expect(result.observed.tests.map((t) => t.id)).toEqual([
      'test/math.test.js::math > adds',
      'test/math.test.js::math > multiplies',
      'test/math.test.js::math > subtracts',
      'test/math.test.js::top level: adds negatives',
    ]);
    expect(result.observed.totals).toEqual({ run: 4, passed: 4, failed: 0, skipped: 0, retried: 0 });
  });

  it('maps the claimed `npm test` onto the run and confirms the count', () => {
    expect(result.unverifiable).toEqual([]);
    expect(result.receipt.discrepancies).toEqual([]);
    expect(result.receipt.verdict).toBe('PASS');
    expect(result.rendered.markdown).toContain('- `npm test` — ran ✔  4/4 pass');
  });
});
