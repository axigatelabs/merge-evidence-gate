/**
 * Base-commit comparison: a failed head run is held against the PR only for
 * failures the base commit does not show. This is the rule behind "a failing
 * suite is not, by itself, a contradiction" — every mastra re-run in the
 * study failed 162–206 environment-bound tests, with or without the PR.
 */
import { describe, expect, it } from 'vitest';

import { parsePolicyYaml } from '../../src/core/reconcile/policy.js';
import { buildReceipt } from '../../src/core/reconcile/receipt.js';
import {
  failureIntroduced,
  partitionFailures,
  reconcile,
} from '../../src/core/reconcile/reconcile.js';
import { renderComment } from '../../src/core/reconcile/render.js';
import { DEFAULT_POLICY } from '../../src/core/reconcile/policy.js';
import type { BaselineRun, Claim, ExecutedTest, ObservedRun } from '../../src/core/types.js';
import { agent, commandClaim, diff, observed, pr } from './fixtures.js';

const ZERO = { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 };
const VITEST_CMD = 'pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json';

const t = (id: string, status: ExecutedTest['status'] = 'passed'): ExecutedTest => ({ id, status });

/** A head run with two environment failures and, optionally, one the PR broke. */
function headRun(extraFailure = false): ObservedRun {
  const tests = [
    t('src/a.test.ts::adds'),
    t('obs/import.test.ts::imports arize', 'failed'),
    t('obs/import.test.ts::imports datadog', 'failed'),
    ...(extraFailure ? [t('src/b.test.ts::subtracts', 'failed')] : []),
  ];
  return observed({ runner: 'vitest', command: VITEST_CMD, exitCode: 1, tests });
}

function base(overrides: Partial<BaselineRun> = {}): BaselineRun {
  return {
    sha: '45dd6ee0000000000000000000000000000000ab',
    exitCode: 1,
    totals: { run: 3, passed: 1, failed: 2, skipped: 0, retried: 0 },
    failed: ['obs/import.test.ts::imports arize', 'obs/import.test.ts::imports datadog'],
    ...overrides,
  };
}

const claim = (): Claim => commandClaim('c1', 'pnpm test', { runner: 'npm' });

const run = (obs: ObservedRun, claims: Claim[] = [claim()]) =>
  reconcile({ pr: pr(), claims, observed: obs, diff: diff(), policy: DEFAULT_POLICY });

describe('partitionFailures / failureIntroduced', () => {
  it('is undefined without a baseline, and the head failure then stands', () => {
    expect(partitionFailures(headRun())).toBeUndefined();
    expect(failureIntroduced(headRun())).toBe(true);
  });

  it('splits head failures into introduced and pre-existing', () => {
    const obs: ObservedRun = { ...headRun(true), baseline: base() };
    expect(partitionFailures(obs)).toEqual({
      introduced: ['src/b.test.ts::subtracts'],
      preExisting: ['obs/import.test.ts::imports arize', 'obs/import.test.ts::imports datadog'],
    });
    expect(failureIntroduced(obs)).toBe(true);
  });

  it('is not introduced when every head failure fails at base too', () => {
    expect(failureIntroduced({ ...headRun(), baseline: base() })).toBe(false);
  });

  it('treats a suite-level failure (no per-test failure) by comparing exit codes', () => {
    const loadFailure = observed({ runner: 'jest', exitCode: 1, tests: [], totals: ZERO });
    expect(failureIntroduced({ ...loadFailure, baseline: base({ exitCode: 0, failed: [], totals: { ...ZERO, run: 3, passed: 3 } }) })).toBe(true);
    expect(failureIntroduced({ ...loadFailure, baseline: base({ exitCode: 1, failed: [] }) })).toBe(false);
  });

  it('never lets a baseline that produced no evidence excuse a failure', () => {
    expect(failureIntroduced({ ...headRun(), baseline: base({ noEvidence: true, failed: [], exitCode: 137 }) })).toBe(true);
  });
});

describe('C1 with a baseline', () => {
  it('does not fire when the base commit fails the same tests; the claim is unverifiable, verdict PASS', () => {
    const result = run({ ...headRun(), baseline: base() });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('PASS');
  });

  it('fires for a failure the PR introduced, listing only that test and the base facts', () => {
    const result = run({ ...headRun(true), baseline: base() });
    expect(result.discrepancies.map((d) => d.check)).toEqual(['C1']);
    const [hit] = result.discrepancies;
    expect(hit?.evidence).toContain('introduced: src/b.test.ts::subtracts');
    expect(hit?.evidence).not.toContain('introduced: obs/import.test.ts::imports arize');
    expect(hit?.evidence).toContain('base 45dd6ee: exit_code=1, 2 of these failures also present there');
    expect(result.verdict).toBe('FAIL');
  });

  it('still fires without a baseline, exactly as before', () => {
    const result = run(headRun());
    expect(result.discrepancies.map((d) => d.check)).toEqual(['C1']);
    expect(result.discrepancies[0]?.evidence).toContain('failed: obs/import.test.ts::imports arize');
  });

  it('opaque runner: fires only when base passed', () => {
    const opaque = (exitCode: number): ObservedRun =>
      observed({ runner: 'cargo', command: 'cargo test', exitCode, tests: [], totals: ZERO });
    const cargo = commandClaim('c1', 'cargo test', { runner: 'cargo' });
    expect(run({ ...opaque(101), baseline: base({ exitCode: 101, failed: [], totals: ZERO }) }, [cargo]).discrepancies).toEqual([]);
    expect(run({ ...opaque(101), baseline: base({ exitCode: 0, failed: [], totals: ZERO }) }, [cargo]).discrepancies.map((d) => d.check)).toEqual(['C1']);
  });
});

describe('receipt and comment carry the comparison', () => {
  const build = (obs: ObservedRun, claims: Claim[] = [claim()]) => {
    const result = reconcile({ pr: pr(), claims, observed: obs, diff: diff(), policy: DEFAULT_POLICY });
    const receipt = buildReceipt({
      pr: pr(),
      agent: agent(),
      claims,
      observed: obs,
      diff: diff(),
      discrepancies: result.discrepancies,
      verdict: result.verdict,
      policy: DEFAULT_POLICY,
      now: new Date('2026-09-05T00:00:00Z'),
    });
    return { result, receipt, comment: renderComment(receipt, { unverifiable: result.unverifiable }) };
  };

  it('projects observed.baseline with pre_existing count and introduced ids', () => {
    const { receipt } = build({ ...headRun(true), baseline: base() });
    expect(receipt.observed.baseline).toEqual({
      sha: '45dd6ee0000000000000000000000000000000ab',
      exit_code: 1,
      totals: { run: 3, passed: 1, failed: 2, skipped: 0, retried: 0 },
      pre_existing: 2,
      introduced: ['src/b.test.ts::subtracts'],
    });
    expect(build(headRun()).receipt.observed.baseline).toBeUndefined();
  });

  it('renders the excused command line, the introduced line, and the banner without a command claim', () => {
    const excused = build({ ...headRun(), baseline: base() });
    expect(excused.comment.title).toContain('PASS');
    expect(excused.comment.markdown).toContain(
      '- `pnpm test` — ran ✘  exit 1, 2 failed — all also fail at base 45dd6ee; nothing introduced by this PR',
    );

    const introduced = build({ ...headRun(true), baseline: base() });
    expect(introduced.comment.markdown).toContain(
      '- `pnpm test` — ran ✘  exit 1, 3 failed — 1 introduced by this PR, 2 also failing at base 45dd6ee',
    );

    const noClaim = build({ ...headRun(), baseline: base() }, []);
    expect(noClaim.comment.markdown).toContain(
      '- the suite fails at head (2 failed) and at base 45dd6ee (2 failed): nothing introduced by this PR',
    );
  });
});

describe('C1 mapping through a workspace composite command', () => {
  it('maps a claimed package script to the package-manager call inside the composite', () => {
    const composite: ObservedRun = observed({
      runner: 'npm',
      command: `f=0; (cd 'e2e/studio' && export PATH="$PWD/node_modules/.bin:$PATH" && mkdir -p .merge-evidence && pnpm test:studio) || f=1; exit "$f"`,
      exitCode: 1,
      tests: [],
      totals: ZERO,
    });
    const result = run(composite, [commandClaim('c1', 'pnpm test:studio', { runner: 'npm' })]);
    expect(result.discrepancies.map((d) => d.check)).toEqual(['C1']);
    const other = run(composite, [commandClaim('c1', 'pnpm test', { runner: 'npm' })]);
    expect(other.unverifiable).toEqual(['c1']);
  });
});

describe('policy: base-comparison', () => {
  it('parses auto and never, ignores anything else', () => {
    expect(parsePolicyYaml('base-comparison: never\n').baseComparison).toBe('never');
    expect(parsePolicyYaml('base-comparison: Auto\n').baseComparison).toBe('auto');
    expect(parsePolicyYaml('base-comparison: sometimes\n').baseComparison).toBeUndefined();
  });
});
