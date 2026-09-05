/**
 * Findings from the supabase batch:
 *
 *   - Four PRs "deleted" test files they never touched: the study's base was
 *     the base branch's tip, three commits ahead of the fork point, and the
 *     two-dot diff showed upstream additions as this PR's deletions. A diff
 *     without a merge base is now `unreliable`, and the change-based checks
 *     abstain on it.
 *   - One PR introduced four failures that pass at base and claimed nothing,
 *     so nothing fired. C9 reports introduced failures on their own.
 *   - One body said "404 error"; the extractor read a claim of 404 failing
 *     tests. An HTTP status is not a count.
 *   - A count claim "0 failures" met 11 failures the base commit shows too;
 *     C2 now compares against introduced failures.
 */
import { describe, expect, it } from 'vitest';

import { extractClaims } from '../../src/core/claims/extract.js';
import { CHECK_IDS, DEFAULT_POLICY, parsePolicyYaml } from '../../src/core/reconcile/policy.js';
import { buildReceipt } from '../../src/core/reconcile/receipt.js';
import { reconcile } from '../../src/core/reconcile/reconcile.js';
import { renderComment } from '../../src/core/reconcile/render.js';
import type { BaselineRun, Claim, DiffAnalysis, ExecutedTest, ObservedRun } from '../../src/core/types.js';
import { agent, checkboxClaim, commandClaim, countClaim, diff, observed, pr } from './fixtures.js';

const ZERO = { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 };
const t = (id: string, status: ExecutedTest['status'] = 'passed'): ExecutedTest => ({ id, status });
const checks = (r: ReturnType<typeof reconcile>): string[] => r.discrepancies.map((d) => d.check);
const run = (input: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({ pr: pr(), claims: [], observed: observed(), diff: diff(), policy: DEFAULT_POLICY, ...input });

/** Everything the diff-based checks could fire on, but from a two-dot diff with no merge base. */
const suspicious = (): DiffAnalysis =>
  diff({
    testFiles: { added: [], modified: [], deleted: ['apps/studio/a.test.tsx'], renamed: [] },
    skipMarkersAdded: [{ file: 'apps/studio/b.test.tsx', marker: 'it.skip' }],
    verificationLayerEdits: [{ file: '.github/workflows/ci.yml', reason: 'CI workflow edited' }],
    dependencyFiles: ['package-lock.json'],
    snapshotFiles: ['a.snap'],
    sourceFiles: ['src/x.ts'],
    fileCount: 6,
    unreliable: true,
  });

describe('an unreliable diff (no merge base) silences every change-based check', () => {
  it('fires nothing from the diff, and reports a "tests added" box as unverifiable', () => {
    const result = run({ claims: [checkboxClaim('c1', 'I have added meaningful tests')], diff: suspicious() });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('PASS');
  });

  it('fires all of them when the same diff is reliable', () => {
    const reliable = { ...suspicious(), unreliable: false };
    const result = run({ claims: [checkboxClaim('c1', 'I have added meaningful tests')], diff: reliable });
    expect(checks(result)).toEqual(['C3', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  });

  it('still reports a test enumerated at base and absent at head — that comes from the run, not the diff', () => {
    const result = run({
      observed: observed({ enumeratedAtBase: ['pkg/TestA', 'pkg/TestGone'], enumeratedAtHead: ['pkg/TestA'] }),
      diff: suspicious(),
    });
    expect(checks(result)).toEqual(['C3']);
    expect(result.discrepancies[0]?.evidence).toEqual(['pkg/TestGone enumerated at base, absent at head']);
  });

  it('is written on the receipt and explained on the comment, without the ✔ lines that would be untrue', () => {
    const claims: Claim[] = [];
    const result = reconcile({ pr: pr(), claims, observed: observed(), diff: suspicious(), policy: DEFAULT_POLICY });
    const receipt = buildReceipt({ pr: pr(), agent: agent(), claims, observed: observed(), diff: suspicious(), discrepancies: result.discrepancies, verdict: result.verdict, policy: DEFAULT_POLICY, now: new Date('2026-09-05T00:00:00Z') });
    expect(receipt.diff.unreliable).toBe(true);
    const { markdown } = renderComment(receipt, { unverifiable: result.unverifiable });
    expect(markdown).toContain('no merge base with the base commit (shallow checkout?)');
    expect(markdown).not.toContain('no skip/only markers added');
    expect(markdown).not.toContain('lockfile install OK');
  });
});

const headWithIntroduced = (): ObservedRun =>
  observed({ runner: 'vitest', exitCode: 1, tests: [t('a::ok'), t('a::broken', 'failed'), t('b::env', 'failed')] });
const base = (o: Partial<BaselineRun> = {}): BaselineRun => ({
  sha: 'f1e0808000000000000000000000000000000000',
  exitCode: 1,
  totals: { run: 3, passed: 2, failed: 1, skipped: 0, retried: 0 },
  failed: ['b::env'],
  ...o,
});

describe('C9 — failures the pull request introduced, with or without a claim', () => {
  it('fires on introduced failures and names only those', () => {
    const result = run({ observed: { ...headWithIntroduced(), baseline: base() } });
    expect(checks(result)).toEqual(['C9']);
    const [hit] = result.discrepancies;
    expect(hit?.severity).toBe('needs-human');
    expect(hit?.summary).toBe('1 test passes at base f1e0808 and fails at head');
    expect(hit?.evidence).toContain('introduced: a::broken');
    expect(hit?.evidence).not.toContain('introduced: b::env');
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('stays silent when every failure is pre-existing, when there is no baseline, or when the base run had no evidence', () => {
    const allPre = { ...headWithIntroduced(), baseline: base({ failed: ['a::broken', 'b::env'], totals: { run: 3, passed: 1, failed: 2, skipped: 0, retried: 0 } }) };
    expect(checks(run({ observed: allPre }))).toEqual([]);
    expect(checks(run({ observed: headWithIntroduced() }))).toEqual([]);
    expect(checks(run({ observed: { ...headWithIntroduced(), baseline: base({ noEvidence: true, failed: [] }) } }))).toEqual([]);
  });

  it('sits next to C1 when a command was claimed, and is a known id with a policy default', () => {
    const result = run({
      claims: [commandClaim('c1', 'pnpm test', { runner: 'npm' })],
      observed: { ...headWithIntroduced(), command: 'pnpm test --reporter=json', baseline: base() },
    });
    expect(checks(result)).toEqual(['C1', 'C9']);
    expect(CHECK_IDS).toContain('C9');
    expect(DEFAULT_POLICY.severity?.C9).toBe('needs-human');
    expect(parsePolicyYaml('severity:\n  C9: fail\n').severity).toEqual({ C9: 'fail' });
    expect(run({ observed: { ...headWithIntroduced(), baseline: base() }, policy: { version: '1.0.0', severity: { C9: 'info' } } }).verdict).toBe('PASS');
  });

  it('renders under the verification layer', () => {
    const obs = { ...headWithIntroduced(), baseline: base() };
    const result = reconcile({ pr: pr(), claims: [], observed: obs, diff: diff(), policy: DEFAULT_POLICY });
    const receipt = buildReceipt({ pr: pr(), agent: agent(), claims: [], observed: obs, diff: diff(), discrepancies: result.discrepancies, verdict: result.verdict, policy: DEFAULT_POLICY, now: new Date('2026-09-05T00:00:00Z') });
    const { markdown } = renderComment(receipt, { unverifiable: [] });
    const verification = markdown.slice(markdown.indexOf('**Verification layer**'));
    expect(verification).toContain('⚠ 1 test passes at base f1e0808 and fails at head — introduced: a::broken');
  });
});

describe('C2 with a baseline counts only introduced failures', () => {
  const docs = (): ObservedRun =>
    observed({
      runner: 'vitest',
      exitCode: 1,
      tests: [...Array.from({ length: 160 }, (_, i) => t(`d::p${i}`)), ...Array.from({ length: 11 }, (_, i) => t(`d::env${i}`, 'failed'))],
      baseline: { sha: '47b8660000000000000000000000000000000000', exitCode: 1, totals: { run: 171, passed: 160, failed: 11, skipped: 0, retried: 0 }, failed: Array.from({ length: 11 }, (_, i) => `d::env${i}`) },
    });

  it('"171 tests, 0 failures" matches a run whose 11 failures all fail at base', () => {
    const result = run({ claims: [countClaim('c1', '171 tests, 0 failures', { total: 171, failed: 0 })], observed: docs() });
    expect(checks(result)).not.toContain('C2');
    expect(result.unverifiable).toEqual([]);
  });

  it('"171 passed" matches too, since the environment failures would have passed for the author', () => {
    const result = run({ claims: [countClaim('c1', '171 passed', { passed: 171 })], observed: docs() });
    expect(checks(result)).not.toContain('C2');
  });

  it('still fires when the claim ignores an introduced failure, and says how many were excused', () => {
    const obs = docs();
    const withIntroduced: ObservedRun = { ...obs, tests: [...obs.tests, t('d::new', 'failed')] };
    const result = run({ claims: [countClaim('c1', '172 tests, 0 failures', { total: 172, failed: 0 })], observed: withIntroduced });
    expect(checks(result)).toEqual(['C2', 'C9']);
    expect(result.discrepancies[0]?.evidence).toContain('claimed failed=0');
    expect(result.discrepancies[0]?.evidence).toContain('observed failed=1');
    expect(result.discrepancies[0]?.evidence).toContain('11 failure(s) also present at base, not counted');
  });
});

describe('an HTTP status is not a test count', () => {
  const counts = (body: string) =>
    extractClaims({ ...pr(), body }).filter((c) => c.kind === 'count').map((c) => c.parsed);
  it('ignores "404 error" and "500 errors", keeps "2 errors" and "404 tests"', () => {
    expect(counts('Returns a 404 error when the project is gone.')).toEqual([]);
    expect(counts('We saw 500 errors during rollout.')).toEqual([]);
    expect(counts('2 errors in the log.')).toEqual([{ kind: 'count', failed: 2 }]);
    expect(counts('404 tests ran.')).toEqual([{ kind: 'count', total: 404 }]);
  });
});
