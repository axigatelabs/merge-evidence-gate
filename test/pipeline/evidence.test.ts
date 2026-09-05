/**
 * The evidence modes: read the report the repository's own test step wrote
 * (`report`), or take no test evidence at all (`none`). Both run nothing.
 *
 * The rule under test everywhere here: a report that is missing, empty,
 * unreadable or lists no tests is no evidence — never a pass. A job whose
 * test step was skipped by a condition still "succeeds", and that green is
 * exactly what this mode must not mistake for one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/core/reconcile/index.js';
import { detectTestCommand, parseJestJson, sniffReportFormat } from '../../src/core/runners/index.js';
import type { PullRequestFacts } from '../../src/core/types.js';
import { bareCommand, evaluate, observeFromReports, type EvaluateResult } from '../../src/pipeline.js';

const REPO_ROOT = process.cwd();
const E2E_TIMEOUT_MS = 180_000;
const fixture = (name: string): string => readFileSync(join(REPO_ROOT, 'test/runners/fixtures', name), 'utf8');

// ---------------------------------------------------------------------------
// Recognising a report by its content
// ---------------------------------------------------------------------------

describe('sniffReportFormat', () => {
  it('tells jest/vitest JSON, go -json, pytest JUnit and node junit apart', () => {
    expect(sniffReportFormat(fixture('vitest-results.json'))).toBe('jest');
    expect(sniffReportFormat(fixture('vitest-results.json'), 'vitest')).toBe('vitest');
    expect(sniffReportFormat(fixture('jest-results.json'), 'jest')).toBe('jest');
    expect(sniffReportFormat(fixture('go-test.jsonl'))).toBe('go');
    expect(sniffReportFormat(fixture('pytest-junit.xml'))).toBe('junit');
    expect(sniffReportFormat(fixture('pytest-junit.xml'), 'pytest')).toBe('pytest');
    expect(sniffReportFormat(fixture('nextest-junit.xml'))).toBe('junit');
    expect(sniffReportFormat(fixture('node-test-junit.xml'))).toBe('node-test');
  });

  it('refuses what it does not read', () => {
    expect(sniffReportFormat('')).toBeUndefined();
    expect(sniffReportFormat('   \n')).toBeUndefined();
    expect(sniffReportFormat('PASS  test/math.test.js\n  ✓ adds')).toBeUndefined();
    expect(sniffReportFormat('{"not": "a report"}')).toBeUndefined();
    expect(sniffReportFormat('<html><body>404</body></html>')).toBeUndefined();
  });
});

describe('bareCommand', () => {
  it('strips the injected reporter flags and a dangling npm separator', () => {
    const vitest = JSON.stringify({ scripts: { test: 'vitest run' } });
    const viaNpm = detectTestCommand({ files: { 'package.json': vitest, 'package-lock.json': '{}' } });
    expect(viaNpm?.command).toContain('--reporter=json');
    expect(bareCommand(viaNpm!)).toBe('npm test');
    const viaPnpm = detectTestCommand({ files: { 'package.json': vitest, 'pnpm-lock.yaml': '' } });
    expect(bareCommand(viaPnpm!)).toBe('pnpm test');
    expect(bareCommand(detectTestCommand({ files: {}, explicit: 'go test ./...' })!)).toBe('go test ./...');
    expect(bareCommand(detectTestCommand({ files: {}, explicit: 'pytest tests/' })!)).toBe('pytest tests/');
    expect(bareCommand(detectTestCommand({ files: {}, explicit: 'node --test' })!)).toBe('node --test');
  });
});

// ---------------------------------------------------------------------------
// Building an observation from report files
// ---------------------------------------------------------------------------

describe('observeFromReports', () => {
  let dir: string;
  const notes: string[] = [];
  const VITEST_PKG = JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3' } });
  const detected = detectTestCommand({ files: { 'package.json': VITEST_PKG, 'pnpm-lock.yaml': '' } });
  const expected = parseJestJson(fixture('vitest-results.json'));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'meg-evidence-'));
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text, 'utf8');
    };
    put('reports/vitest.json', fixture('vitest-results.json'));
    put('reports/pytest.xml', fixture('pytest-junit.xml'));
    put('reports/node.xml', fixture('node-test-junit.xml'));
    put('reports/empty.json', '');
    put('reports/blank.json', '   \n');
    put('reports/console.txt', 'PASS  test/math.test.js\n  ✓ adds\n');
    put('reports/no-tests.json', JSON.stringify({ testResults: [] }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a vitest report as the repository runner, infers the exit code, and says nothing was re-run', () => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: ['reports/vitest.json'] }, dir, detected, notes);
    expect(run.source).toBe('report');
    expect(run.runner).toBe('vitest');
    expect(run.tests.map((t) => t.id)).toEqual(expected.tests.map((t) => t.id));
    expect(run.totals).toEqual(expected.totals);
    expect(run.exitCode).toBe(expected.totals.failed > 0 ? 1 : 0);
    expect(run.durationMs).toBe(0);
    expect(run.reportMissing).toBeUndefined();
    expect(run.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.reportPath).toBe('reports/vitest.json');
    expect(run.command).toBe('pnpm test');
    expect(notes.some((n) => n.includes('presumed from the repository (`pnpm test`)'))).toBe(true);
    expect(notes.some((n) => n.includes('nothing was re-run'))).toBe(true);
  });

  it('records the command the operator names instead of presuming one', () => {
    const notes: string[] = [];
    const run = observeFromReports(
      { kind: 'report', paths: ['reports/vitest.json'], command: 'pnpm test:unit -- --shard=1/2' },
      dir,
      detected,
      notes,
    );
    expect(run.command).toBe('pnpm test:unit -- --shard=1/2');
    expect(notes.some((n) => n.includes('presumed'))).toBe(false);
  });

  it('honours an explicit format and notes a runner mismatch', () => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: ['reports/pytest.xml'], format: 'junit' }, dir, detected, notes);
    expect(run.runner).toBe('junit');
    expect(run.totals.run).toBe(4);
    expect(notes.some((n) => n.includes('the report is junit output while the repository\'s own test command is vitest'))).toBe(true);
  });

  it('merges several reports and digests them together', () => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: ['reports/vitest.json', 'reports/node.xml'] }, dir, detected, notes);
    expect(run.totals.run).toBe(expected.totals.run + 8);
    expect(run.runner).toBe('vitest');
    expect(run.reportDigest).toMatch(/^sha256:/);
    expect(run.reportPath).toBe('reports/vitest.json, reports/node.xml');
  });

  it.each([
    ['a missing file', 'reports/does-not-exist.json', 'missing or empty'],
    ['an empty file', 'reports/empty.json', 'missing or empty'],
    ['a blank file', 'reports/blank.json', 'missing or empty'],
    ['console text', 'reports/console.txt', 'no format the gate reads'],
    ['a report listing no tests', 'reports/no-tests.json', 'lists no tests'],
  ])('%s is no evidence, never a pass', (_label, path, expectedNote) => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: [path] }, dir, detected, notes);
    expect(run.reportMissing).toBe(true);
    expect(run.tests).toEqual([]);
    expect(run.totals.run).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(notes.some((n) => n.includes(expectedNote))).toBe(true);
  });

  it('keeps the readable report when one of several is missing', () => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: ['reports/missing.xml', 'reports/vitest.json'] }, dir, detected, notes);
    expect(run.reportMissing).toBeUndefined();
    expect(run.totals.run).toBe(expected.totals.run);
    expect(notes.some((n) => n.includes('reports/missing.xml is missing or empty'))).toBe(true);
  });

  it('works without a detected repository command', () => {
    const notes: string[] = [];
    const run = observeFromReports({ kind: 'report', paths: ['reports/vitest.json'] }, dir, null, notes);
    expect(run.runner).toBe('jest');
    expect(run.command).toBe('');
    expect(run.totals.run).toBe(expected.totals.run);
  });
});

// ---------------------------------------------------------------------------
// evaluate() in report and none modes: a real repository, no re-run
// ---------------------------------------------------------------------------

const MATH_SOURCE = `export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
`;
const STRINGS_SOURCE = `export const upper = (s) => s.toUpperCase();
`;
const MATH_TESTS = `import { describe, expect, it } from 'vitest';
import { add, sub } from '../src/math.js';

describe('math', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('adds negatives', () => { expect(add(-1, -2)).toBe(-3); });
  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });
});
`;
const STRINGS_TESTS = `import { describe, expect, it } from 'vitest';
import { upper } from '../src/strings.js';

describe('strings', () => {
  it('uppercases', () => { expect(upper('a')).toBe('A'); });
  it('uppercases empty', () => { expect(upper('')).toBe(''); });
});
`;
const PACKAGE_JSON = `${JSON.stringify(
  { name: 'demo-report-mode', private: true, type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.2.4' } },
  null,
  2,
)}\n`;
const FOOTER = '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
const HONEST_BODY = `## Summary\n\nAdds \`mul\` with a test.\n\n## Test plan\n\n- [x] \`npm test\` — 6 tests, 0 failures\n${FOOTER}`;
const CONTRADICTED_BODY = `## Summary\n\nAdds \`div\` and tidies the suite.\n\n## Test plan\n\n- [x] \`npm test\` — 5 tests, 0 failures\n${FOOTER}`;
const REPORT = '.merge-evidence/own-run.json';

function write(dir: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), contents, 'utf8');
}
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}
function createBaseRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-report-'));
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
  git(dir, 'commit', '-qm', 'base');
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD').trim() };
}
function applyHonestChange(dir: string): string {
  write(dir, 'src/math.js', `${MATH_SOURCE}export const mul = (a, b) => a * b;\n`);
  write(
    dir,
    'test/math.test.js',
    MATH_TESTS.replace("import { add, sub } from '../src/math.js';", "import { add, sub, mul } from '../src/math.js';").replace(
      "  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });\n",
      "  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });\n  it('multiplies', () => { expect(mul(2, 3)).toBe(6); });\n",
    ),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add mul');
  return git(dir, 'rev-parse', 'HEAD').trim();
}
/**
 * The focus marker the contradicted PR adds, assembled so this file's own diff
 * does not read as a focused test — the gate that guards this repository
 * would flag it, and did.
 */
const FOCUSED = ['it', 'only'].join('.');

function applyContradictedChange(dir: string): string {
  rmSync(join(dir, 'test/strings.test.js'));
  write(dir, 'test/math.test.js', MATH_TESTS.replace("it('adds',", `${FOCUSED}('adds',`));
  write(dir, 'src/math.js', `${MATH_SOURCE}export const div = (a, b) => a / b;\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add div and tidy the suite');
  return git(dir, 'rev-parse', 'HEAD').trim();
}
/** What the repository's own CI step would do: run the suite, write a report. */
function runOwnSuite(dir: string): void {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('VITEST') || key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') continue;
    env[key] = value;
  }
  mkdirSync(join(dir, '.merge-evidence'), { recursive: true });
  try {
    execFileSync(join(dir, 'node_modules/.bin/vitest'), ['run', '--reporter=json', `--outputFile=${REPORT}`], {
      cwd: dir,
      env,
      stdio: 'pipe',
    });
  } catch {
    // a failing suite still writes its report; the exit code is not the point here
  }
}
function facts(overrides: Partial<PullRequestFacts>): PullRequestFacts {
  return {
    repo: 'example/demo',
    number: 9,
    headSha: '',
    baseSha: '',
    baseRef: 'main',
    headRef: 'claude/add-mul',
    authorLogin: 'demo-agent',
    body: '',
    title: 'math: add mul',
    commitMessages: [],
    ...overrides,
  };
}

describe('evaluate — evidence: report', () => {
  let dir: string;
  let honest: EvaluateResult;
  let missing: EvaluateResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyHonestChange(dir);
    runOwnSuite(dir);
    const pr = facts({ headSha, baseSha: repo.baseSha, body: HONEST_BODY });
    honest = await evaluate({ workDir: dir, pr, policy: DEFAULT_POLICY, evidence: { kind: 'report', paths: [REPORT] } });
    missing = await evaluate({
      workDir: dir,
      pr,
      policy: DEFAULT_POLICY,
      evidence: { kind: 'report', paths: ['.merge-evidence/never-written.json'] },
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('confirms the claims from the repository\'s own report without re-running anything', () => {
    expect(honest.verdict).toBe('PASS');
    expect(honest.receipt?.observed.source).toBe('report');
    expect(honest.receipt?.observed.totals).toEqual({ run: 6, passed: 6, failed: 0, skipped: 0, retried: 0 });
    expect(honest.receipt?.observed.duration_s).toBe(0);
    expect(honest.receipt?.observed.report_sha256).toMatch(/^sha256:/);
    expect(honest.receipt?.observed.command).toBe('npm test');
    expect(honest.unverifiable).toEqual([]);
    // C8 (scope, info) notes the files the body does not name; nothing above info.
    expect(honest.discrepancies.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('says so on the comment', () => {
    const markdown = honest.rendered?.markdown ?? '';
    expect(markdown).toContain("- read from the repository's own test report (6 tests), nothing re-run");
    expect(markdown).toContain('- `npm test` — ran ✔  6/6 pass');
    expect(markdown).toContain("evidence: the repository's own test report, nothing re-run");
    expect(markdown).not.toContain('rerun:');
  });

  it('treats a report that was never written as no evidence — the skipped-step green', () => {
    expect(missing.verdict).toBe('NEUTRAL');
    expect(missing.receipt?.observed.no_evidence).toBe(true);
    expect(missing.receipt?.observed.totals.run).toBe(0);
    expect(missing.unverifiable.length).toBeGreaterThan(0);
    expect(missing.notes.some((n) => n.includes('never-written.json is missing or empty'))).toBe(true);
    expect(missing.rendered?.markdown).toContain('- the test report is missing, empty or unreadable — nothing was re-run');
  });
});

describe('evaluate — evidence: report still catches a contradicted PR', () => {
  let dir: string;
  let result: EvaluateResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyContradictedChange(dir);
    runOwnSuite(dir);
    result = await evaluate({
      workDir: dir,
      pr: facts({ headSha, baseSha: repo.baseSha, body: CONTRADICTED_BODY, headRef: 'claude/add-div' }),
      policy: DEFAULT_POLICY,
      evidence: { kind: 'report', paths: [REPORT], command: 'npm test' },
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails it: the deleted test file and the focus marker are in the diff, the count is not what the report shows', () => {
    expect(result.verdict).toBe('FAIL');
    const checks = result.discrepancies.map((d) => d.check);
    expect(checks).toContain('C3');
    expect(checks).toContain('C2');
    expect(result.receipt?.observed.source).toBe('report');
    expect(result.receipt?.observed.totals.run).toBeLessThan(5);
  });
});

describe('evaluate — evidence: none', () => {
  let dir: string;
  let result: EvaluateResult;

  beforeAll(async () => {
    const repo = createBaseRepo();
    dir = repo.dir;
    const headSha = applyHonestChange(dir);
    result = await evaluate({
      workDir: dir,
      pr: facts({ headSha, baseSha: repo.baseSha, body: HONEST_BODY }),
      policy: DEFAULT_POLICY,
      evidence: { kind: 'none' },
    });
  }, E2E_TIMEOUT_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs nothing, leaves the run claims unverifiable, and abstains when the diff is clean', () => {
    expect(result.verdict).toBe('NEUTRAL');
    expect(result.receipt?.observed.source).toBe('none');
    expect(result.receipt?.observed.no_test_command).toBeUndefined();
    expect(result.receipt?.observed.totals.run).toBe(0);
    expect(result.unverifiable.length).toBeGreaterThan(0);
    expect(result.rendered?.markdown).toContain('- test run skipped (evidence: none) — claims about the run are unverifiable; the gate abstains');
    expect(result.rendered?.markdown).toContain('evidence: none — diff-based checks only');
  });
});
