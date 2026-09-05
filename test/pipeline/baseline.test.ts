/**
 * Base-commit comparison end to end: a real repository, a real failing test at
 * base, a real re-run at both commits. The dependencies are this repository's
 * own `node_modules`, symlinked in, so nothing touches the network.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/core/reconcile/index.js';
import type { PullRequestFacts } from '../../src/core/types.js';
import { evaluate, installPlan, manifestsDiffer, needsBaseline, type EvaluateResult } from '../../src/pipeline.js';

const REPO_ROOT = process.cwd();
const E2E_TIMEOUT_MS = 240_000;

const PACKAGE_JSON = `${JSON.stringify(
  { name: 'demo-baseline', private: true, type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.2.4' } },
  null,
  2,
)}\n`;

/** One honest test plus one that needs something the sandbox lacks — it fails at base AND head. */
const MATH_TESTS = `import { describe, expect, it } from 'vitest';
import { add } from '../src/math.js';

describe('math', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); });
  it('needs the network', () => { expect(process.env.DEMO_NETWORK).toBe('yes'); });
});
`;

function write(dir: string, rel: string, contents: string): void {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function createBaseRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-baseline-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, '.gitignore', 'node_modules/\n.merge-evidence/\n.merge-evidence.head/\n.merge-evidence.base/\n');
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/math.test.js', MATH_TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD') };
}

/** The honest PR: adds `sub` and a test for it. The network test still fails. */
function applyHonestChange(dir: string): string {
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  write(
    dir,
    'test/math.test.js',
    MATH_TESTS.replace("import { add } from", 'import { add, sub } from').replace(
      "  it('adds', () => { expect(add(1, 2)).toBe(3); });\n",
      "  it('adds', () => { expect(add(1, 2)).toBe(3); });\n  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });\n",
    ),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: add sub');
  return git(dir, 'rev-parse', 'HEAD');
}

/** The breaking PR: changes `add` so the honest test fails; the network test still fails too. */
function applyBreakingChange(dir: string): string {
  write(dir, 'src/math.js', 'export const add = (a, b) => a - b;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'math: break add');
  return git(dir, 'rev-parse', 'HEAD');
}

const BODY = '## Test plan\n\n- [x] `npm test`\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';

function facts(dir: string, baseSha: string, headSha: string): PullRequestFacts {
  return {
    repo: 'example/demo',
    number: 9,
    headSha,
    baseSha,
    baseRef: 'main',
    headRef: 'claude/add-sub',
    authorLogin: 'demo-agent',
    body: BODY,
    title: 'math: add sub',
    commitMessages: [],
  };
}

async function evaluateOffline(options: Parameters<typeof evaluate>[0]): Promise<EvaluateResult> {
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

describe('evaluate with base comparison', () => {
  it(
    'excuses a failure the base commit shows too: PASS, claim unverifiable, baseline on the receipt, checkout back at head',
    async () => {
      const { dir, baseSha } = createBaseRepo();
      const headSha = applyHonestChange(dir);
      const result = await evaluateOffline({ workDir: dir, pr: facts(dir, baseSha, headSha), policy: { ...DEFAULT_POLICY } });

      expect(result.verdict).toBe('PASS');
      expect(result.discrepancies.map((d) => d.check)).not.toContain('C1');
      // the body line is a checkbox AND a command claim; the command one is excused
      const command = result.receipt?.claims.find((c) => c.kind === 'command');
      expect(command).toBeDefined();
      expect(result.unverifiable).toContain(command?.id);
      const baseline = result.receipt?.observed.baseline;
      expect(baseline?.sha).toBe(baseSha);
      expect(baseline?.exit_code).not.toBe(0);
      expect(baseline?.pre_existing).toBe(1);
      expect(baseline?.introduced).toEqual([]);
      expect(result.receipt?.observed.totals.run).toBe(3);
      expect(baseline?.totals.run).toBe(2);
      expect(result.rendered?.markdown).toContain('nothing introduced by this PR');
      // the checkout is back at head and the head run's report survived the base run
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(headSha);
      expect(existsSync(join(dir, '.merge-evidence', 'vitest-results.json'))).toBe(true);
      expect(readFileSync(join(dir, 'src/math.js'), 'utf8')).toContain('sub');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'still fails C1 for a failure the PR introduced, naming that test and not the environment one',
    async () => {
      const { dir, baseSha } = createBaseRepo();
      const headSha = applyBreakingChange(dir);
      const result = await evaluateOffline({ workDir: dir, pr: facts(dir, baseSha, headSha), policy: { ...DEFAULT_POLICY } });

      expect(result.verdict).toBe('FAIL');
      const c1 = result.discrepancies.find((d) => d.check === 'C1');
      expect(c1?.evidence.some((e) => e.startsWith('introduced: ') && e.includes('adds'))).toBe(true);
      expect(c1?.evidence.some((e) => e.startsWith('introduced: ') && e.includes('network'))).toBe(false);
      expect(result.receipt?.observed.baseline?.introduced).toHaveLength(1);
      expect(result.receipt?.observed.baseline?.pre_existing).toBe(1);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(headSha);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "takes no baseline with 'never', so the environment failure counts against the PR as before",
    async () => {
      const { dir, baseSha } = createBaseRepo();
      const headSha = applyHonestChange(dir);
      const result = await evaluateOffline({
        workDir: dir,
        pr: facts(dir, baseSha, headSha),
        policy: { ...DEFAULT_POLICY },
        baseComparison: 'never',
      });
      expect(result.receipt?.observed.baseline).toBeUndefined();
      expect(result.discrepancies.map((d) => d.check)).toContain('C1');
      expect(result.verdict).toBe('FAIL');
    },
    E2E_TIMEOUT_MS,
  );
});

describe('helpers', () => {
  it('needsBaseline: only a failed run with evidence', () => {
    const base = { command: 'x', runner: 'vitest' as const, durationMs: 0, toolchain: {}, totals: { run: 1, passed: 0, failed: 1, skipped: 0, retried: 0 }, tests: [{ id: 'a', status: 'failed' as const }] };
    expect(needsBaseline({ ...base, exitCode: 1 })).toBe(true);
    expect(needsBaseline({ ...base, exitCode: 0 })).toBe(false);
    expect(needsBaseline({ ...base, exitCode: 137, tests: [], totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 }, reportMissing: true })).toBe(false);
    expect(needsBaseline({ ...base, exitCode: 1, noTestCommand: true })).toBe(false);
  });

  it('manifestsDiffer: dependency manifests only', () => {
    expect(manifestsDiffer({ 'package.json': 'a' }, { 'package.json': 'a' })).toBe(false);
    expect(manifestsDiffer({ 'package.json': 'a', 'pnpm-lock.yaml': '1' }, { 'package.json': 'a', 'pnpm-lock.yaml': '2' })).toBe(true);
    expect(manifestsDiffer({ 'package.json': 'a', 'README.md': 'x' }, { 'package.json': 'a', 'README.md': 'y' })).toBe(false);
  });

  it('installPlan: force installs even when node_modules is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meg-plan-'));
    mkdirSync(join(dir, 'node_modules'));
    const files = { 'package.json': '{}', 'package-lock.json': '{}' };
    expect(installPlan(dir, files)).toEqual([]);
    expect(installPlan(dir, files, { force: true })).toEqual([{ command: 'npm ci', frozen: true }]);
  });
});
