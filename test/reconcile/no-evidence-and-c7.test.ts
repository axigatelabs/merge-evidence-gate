/**
 * Rules that came out of the first real batch (mastra, 40 Devin PRs) and two
 * adversarial review rounds of the first cut:
 *
 *   1. A run that produced NO evidence (the kernel OOM-killed vitest, the
 *      reporter never wrote, the toolchain was missing) must not contradict
 *      anything. Before this, a body that said "1480 tests" got "Claimed 1480
 *      total; 0 observed" → NEEDS_HUMAN, which blames the author for a sandbox
 *      limit. The rule is narrow on purpose: a report that says the suite
 *      failed to load IS evidence, and an opaque runner's exit code IS evidence.
 *   2. C7 — the most common checkbox across 140 real agent PR bodies is
 *      "I have added tests …". A ticked box while the diff touches no test file
 *      is a claim with nothing behind it. The pattern must not catch the
 *      sibling template line "New and existing unit tests pass".
 *   3. C2 — a count claim smaller than the run describes a subset (one package
 *      of a monorepo) and is unverifiable, not a mismatch.
 *   4. C1 — a claimed `pnpm test` / `npm test` maps to the run that the same
 *      invocation started, whatever runner the script resolved to.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHECK_IDS, DEFAULT_POLICY, parsePolicyYaml } from '../../src/core/reconcile/policy.js';
import { buildReceipt } from '../../src/core/reconcile/receipt.js';
import {
  TESTS_ADDED_LABEL,
  TESTS_ADDED_NEGATION,
  claimsTestsAdded,
  hasNoEvidence,
  reconcile,
} from '../../src/core/reconcile/reconcile.js';
import { renderComment } from '../../src/core/reconcile/render.js';
import type { Claim, DiffAnalysis, Discrepancy, ObservedRun } from '../../src/core/types.js';
import {
  agent,
  checkboxClaim,
  commandClaim,
  countClaim,
  diff,
  noTestCommandRun,
  observed,
  pr,
} from './fixtures.js';

const checks = (discrepancies: Discrepancy[]): string[] => discrepancies.map((d) => d.check);

const run = (input: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({ pr: pr(), claims: [], observed: observed(), diff: diff(), ...input });

const ZERO = { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 };
const VITEST_CMD = 'pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json';
const JEST_CMD = 'npm test -- --json --outputFile=.merge-evidence/jest-results.json';

/** The harness case: the kernel killed the runner before the reporter wrote. */
const killedRun = (exitCode = 137): ObservedRun =>
  observed({ runner: 'vitest', command: VITEST_CMD, exitCode, tests: [], totals: ZERO, reportMissing: true });

/** jest wrote a report saying the suite failed to load: zero tests, exit 1. */
const suiteFailedToLoad = (): ObservedRun =>
  observed({ runner: 'jest', command: JEST_CMD, exitCode: 1, tests: [], totals: ZERO });

/** Plain `cargo test`: no per-test output ever, exit code is the evidence. */
const opaqueRun = (exitCode: number, extra: Partial<ObservedRun> = {}): ObservedRun =>
  observed({ runner: 'cargo', command: 'cargo test', exitCode, tests: [], totals: ZERO, ...extra });

/** A vitest run with real per-test evidence that failed. */
const failedVitest = (): ObservedRun =>
  observed({
    runner: 'vitest',
    command: VITEST_CMD,
    exitCode: 1,
    tests: [
      { id: 'src/a.test.ts::adds', status: 'passed' },
      { id: 'src/a.test.ts::subtracts', status: 'failed' },
    ],
  });

const build = (obs: ObservedRun, claims: Claim[], d: DiffAnalysis = diff()) => {
  const result = reconcile({ pr: pr(), claims, observed: obs, diff: d });
  const receipt = buildReceipt({
    pr: pr(),
    agent: agent(),
    claims,
    observed: obs,
    diff: d,
    discrepancies: result.discrepancies,
    verdict: result.verdict,
    policy: DEFAULT_POLICY,
    now: new Date('2026-09-04T00:00:00Z'),
  });
  return { result, receipt, comment: renderComment(receipt, { unverifiable: result.unverifiable }) };
};

// ---------------------------------------------------------------------------
// What counts as "no evidence"
// ---------------------------------------------------------------------------

describe('hasNoEvidence is narrow: killed, could not start, or missing report', () => {
  it('is true when the report is missing, whatever the exit code', () => {
    expect(hasNoEvidence(killedRun(137))).toBe(true);
    expect(hasNoEvidence(killedRun(1))).toBe(true);
    expect(hasNoEvidence(killedRun(0))).toBe(true);
  });

  it('is true when the process died by signal, for any family', () => {
    expect(hasNoEvidence(opaqueRun(137, { signal: 'SIGKILL' }))).toBe(true);
    expect(hasNoEvidence(opaqueRun(128, { signal: 'unknown' }))).toBe(true);
  });

  it('is true when the command could not run at all (126/127: toolchain missing)', () => {
    expect(hasNoEvidence(opaqueRun(127))).toBe(true);
    expect(hasNoEvidence(opaqueRun(126))).toBe(true);
    expect(hasNoEvidence(observed({ runner: 'pytest', exitCode: 127, tests: [], totals: ZERO }))).toBe(true);
  });

  it('applies the 128+ rule to families that write reports, not to opaque ones (mocha exits with the failure count)', () => {
    expect(hasNoEvidence(observed({ runner: 'jest', exitCode: 137, tests: [], totals: ZERO }))).toBe(true);
    expect(hasNoEvidence(opaqueRun(137))).toBe(false);
    expect(hasNoEvidence(observed({ runner: 'npm', command: 'npm test', exitCode: 130, tests: [], totals: ZERO }))).toBe(false);
  });

  it('is false when the reporter wrote a report with zero tests — the suite failed to load', () => {
    expect(hasNoEvidence(suiteFailedToLoad())).toBe(false);
  });

  it('is false for an opaque runner that exited normally, pass or fail', () => {
    expect(hasNoEvidence(opaqueRun(0))).toBe(false);
    expect(hasNoEvidence(opaqueRun(101))).toBe(false);
  });

  it('is false when any test ran, and for the no-test-command state', () => {
    expect(hasNoEvidence(observed())).toBe(false);
    expect(hasNoEvidence(observed({ exitCode: 137 }))).toBe(false);
    expect(hasNoEvidence(noTestCommandRun())).toBe(false);
  });
});

describe('a run with no evidence is inconclusive, never a contradiction', () => {
  it('marks a mappable command claim unverifiable instead of C1, and abstains', () => {
    const result = run({
      claims: [commandClaim('c1', 'pnpm test', { runner: 'npm' })],
      observed: killedRun(),
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('marks a count claim unverifiable instead of "claimed N; 0 observed"', () => {
    const result = run({
      claims: [countClaim('c1', '1480 tests', { total: 1480 })],
      observed: killedRun(),
    });
    expect(checks(result.discrepancies)).not.toContain('C2');
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('abstains for a toolchain missing from the runner (exit 127) instead of failing C1 and C2', () => {
    const result = run({
      claims: [commandClaim('c1', 'cargo test', { runner: 'cargo' }), countClaim('c2', '68 tests, 0 failures', { total: 68, failed: 0 })],
      observed: opaqueRun(127),
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1', 'c2']);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('lists command and count claims together in unverifiable, in claim order', () => {
    const result = run({
      claims: [
        commandClaim('c1', 'pnpm test', { runner: 'npm' }),
        countClaim('c2', '12 tests, 0 failures', { total: 12, failed: 0 }),
      ],
      observed: killedRun(),
    });
    expect(result.unverifiable).toEqual(['c1', 'c2']);
  });

  it('still fails on a diff-only finding: a deleted test file needs no run to be seen', () => {
    const result = run({
      observed: killedRun(),
      diff: diff({ testFiles: { added: [], modified: [], deleted: ['pkg/node/prune_test.go'], renamed: [] } }),
    });
    expect(checks(result.discrepancies)).toEqual(['C3']);
    expect(result.verdict).toBe('FAIL');
  });

  it('stays NEUTRAL when only an info-level C8 fired, but honours a raised C8 severity', () => {
    const scope = diff({ sourceFiles: ['src/unrelated.ts'] });
    expect(run({ observed: killedRun(), diff: scope }).verdict).toBe('NEUTRAL');
    const raised = run({
      observed: killedRun(),
      diff: scope,
      policy: { version: '1.0.0', severity: { C8: 'fail' } },
    });
    expect(raised.verdict).toBe('FAIL');
  });
});

describe('runs WITH evidence keep failing C1', () => {
  it('a jest suite that failed to load — report present, zero tests, exit 1 — fails C1 on a real `npm test` claim', () => {
    const result = run({
      claims: [commandClaim('c1', 'npm test', { runner: 'npm' })],
      observed: suiteFailedToLoad(),
    });
    expect(checks(result.discrepancies)).toEqual(['C1']);
    expect(result.verdict).toBe('FAIL');
  });

  it('a plain `cargo test` that exited 101 fails C1; exit 0 passes', () => {
    const failed = run({
      claims: [commandClaim('c1', 'cargo test', { runner: 'cargo' })],
      observed: opaqueRun(101),
    });
    expect(checks(failed.discrepancies)).toEqual(['C1']);
    expect(failed.verdict).toBe('FAIL');

    const passed = run({
      claims: [commandClaim('c1', 'cargo test', { runner: 'cargo' })],
      observed: opaqueRun(0),
    });
    expect(passed.discrepancies).toEqual([]);
    expect(passed.verdict).toBe('PASS');
  });

  it('a mocha script that exited with 130 failures still fails C1 (no signal, opaque family)', () => {
    const result = run({
      claims: [commandClaim('c1', 'npm test', { runner: 'npm' })],
      observed: observed({ runner: 'npm', command: 'npm test', exitCode: 130, tests: [], totals: ZERO }),
    });
    expect(checks(result.discrepancies)).toEqual(['C1']);
  });

  it('a run that produced evidence and failed is unchanged', () => {
    const result = run({
      claims: [commandClaim('c1', 'go test ./...', { paths: ['./...'] })],
      observed: observed({ exitCode: 1, tests: [{ id: 'pkg/node/TestPrune', status: 'failed' }] }),
    });
    expect(checks(result.discrepancies)).toEqual(['C1']);
    expect(result.verdict).toBe('FAIL');
  });
});

// ---------------------------------------------------------------------------
// C1 — package-script claims map to the run the same invocation started
// ---------------------------------------------------------------------------

describe('C1 — a claimed `pnpm test` maps to the run it started', () => {
  it('maps `pnpm test` (claim family npm) onto the vitest run and fails it', () => {
    const result = run({
      claims: [commandClaim('c1', 'pnpm test', { runner: 'npm' })],
      observed: failedVitest(),
    });
    expect(checks(result.discrepancies)).toEqual(['C1']);
    expect(result.discrepancies[0]?.evidence).toContain('failed: src/a.test.ts::subtracts');
    expect(result.unverifiable).toEqual([]);
  });

  it('treats `npm run test` and `npm test` as the same invocation', () => {
    const result = run({
      claims: [commandClaim('c1', 'npm run test', { runner: 'npm' })],
      observed: observed({ runner: 'jest', command: JEST_CMD, exitCode: 0 }),
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual([]);
  });

  it('does not map a script claim onto a run started by a different invocation or family', () => {
    const filtered = run({
      claims: [commandClaim('c1', 'pnpm test', { runner: 'npm' })],
      observed: observed({ runner: 'vitest', command: 'pnpm --filter core test --reporter=json', exitCode: 1 }),
    });
    expect(filtered.unverifiable).toEqual(['c1']);

    const otherScript = run({
      claims: [commandClaim('c1', 'pnpm test:unit', { runner: 'npm' })],
      observed: failedVitest(),
    });
    expect(otherScript.unverifiable).toEqual(['c1']);

    const goRun = run({
      claims: [commandClaim('c1', 'pnpm test', { runner: 'npm' })],
      observed: observed({ exitCode: 1 }),
    });
    expect(goRun.unverifiable).toEqual(['c1']);
  });
});

// ---------------------------------------------------------------------------
// C2 — subset claims and runs without counts
// ---------------------------------------------------------------------------

describe('C2 — a count claim about a subset of what ran is unverifiable', () => {
  // mastra #22963: the body said "322 tests" for one package; the gate ran the
  // whole monorepo, 5,904 tests with 203 environment failures.
  const bigRun = (): ObservedRun =>
    observed({
      runner: 'vitest',
      command: VITEST_CMD,
      exitCode: 1,
      tests: [
        ...Array.from({ length: 5701 }, (_, i) => ({ id: `pkg/t${i}`, status: 'passed' as const })),
        ...Array.from({ length: 203 }, (_, i) => ({ id: `pkg/f${i}`, status: 'failed' as const })),
      ],
    });

  /** 412 tests: 394 passed, 6 failed, 12 skipped. */
  const mixedRun = (): ObservedRun =>
    observed({
      exitCode: 1,
      tests: [
        ...Array.from({ length: 394 }, (_, i) => ({ id: `p${i}`, status: 'passed' as const })),
        ...Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, status: 'failed' as const })),
        ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, status: 'skipped' as const })),
      ],
    });

  it('is unverifiable when the claimed total is smaller than the run', () => {
    const result = run({ claims: [countClaim('c1', '322 tests', { total: 322 })], observed: bigRun() });
    expect(checks(result.discrepancies)).not.toContain('C2');
    expect(result.unverifiable).toEqual(['c1']);
  });

  it('is unverifiable for "N passed, 0 failed" when N is smaller than the run — the failures may lie outside the claim', () => {
    const result = run({
      claims: [countClaim('c1', '322 passed, 0 failed', { passed: 322, failed: 0 })],
      observed: bigRun(),
    });
    expect(checks(result.discrepancies)).not.toContain('C2');
    expect(result.unverifiable).toEqual(['c1']);
  });

  it('sizes a claim by the parts it states, so a pasted whole-suite summary is still compared', () => {
    // "400 passed | 12 skipped (412)" describes the whole run; passed is wrong.
    const result = run({
      claims: [countClaim('c1', '400 passed, 12 skipped', { passed: 400, skipped: 12 })],
      observed: mixedRun(),
    });
    expect(checks(result.discrepancies)).toEqual(['C2']);
    expect(result.discrepancies[0]?.evidence).toContain('claimed passed=400');
    expect(result.discrepancies[0]?.evidence).toContain('observed passed=394');
  });

  it('still fires when the claim is larger than the run, or equal with different failures', () => {
    const larger = run({ claims: [countClaim('c1', '6000 tests', { total: 6000 })], observed: bigRun() });
    expect(checks(larger.discrepancies)).toContain('C2');

    const equal = run({
      claims: [countClaim('c1', '5904 tests, 0 failures', { total: 5904, failed: 0 })],
      observed: bigRun(),
    });
    expect(checks(equal.discrepancies)).toContain('C2');
    expect(equal.discrepancies[0]?.evidence).toContain('claimed failed=0');
  });

  it('still compares a bare failure count, which carries no scope of its own', () => {
    const result = run({ claims: [countClaim('c1', '0 failures', { failed: 0 })], observed: bigRun() });
    expect(checks(result.discrepancies)).toContain('C2');
  });

  it('is unverifiable on an opaque runner that enumerates nothing — never "0 observed"', () => {
    const result = run({
      claims: [countClaim('c1', '12 tests, 0 failures', { total: 12, failed: 0 })],
      observed: opaqueRun(0),
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('PASS');
  });
});

describe('a count claim with no run at all is unverifiable too', () => {
  it('is listed under unverifiable for the no-test-command state, never "counts match"', () => {
    const claims = [countClaim('c1', '68 tests', { total: 68 })];
    const { result, comment } = build(noTestCommandRun(), claims);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('NEUTRAL');
    expect(comment.markdown).toContain('"68 tests" — unverifiable');
    expect(comment.markdown).not.toContain('counts match');
  });
});

// ---------------------------------------------------------------------------
// The receipt and the comment
// ---------------------------------------------------------------------------

describe('the receipt and the comment say what happened', () => {
  it('records observed.no_evidence only for an evidence-less run', () => {
    const claims = [countClaim('c1', '1480 tests', { total: 1480 })];
    expect(build(killedRun(), claims).receipt.observed.no_evidence).toBe(true);
    expect(build(opaqueRun(127), claims).receipt.observed.no_evidence).toBe(true);
    expect(build(observed(), claims).receipt.observed.no_evidence).toBeUndefined();
    expect(build(suiteFailedToLoad(), claims).receipt.observed.no_evidence).toBeUndefined();
    expect(build(opaqueRun(101), claims).receipt.observed.no_evidence).toBeUndefined();
    expect(build(noTestCommandRun(), claims).receipt.observed.no_evidence).toBeUndefined();
  });

  it('renders the abstain line with the exit code and the count claim as unverifiable', () => {
    const { comment } = build(killedRun(), [countClaim('c1', '1480 tests', { total: 1480 })]);
    expect(comment.title).toContain('NEUTRAL');
    expect(comment.markdown).toContain('no per-test evidence (exit 137)');
    expect(comment.markdown).toContain('the gate abstains');
    expect(comment.markdown).toContain('"1480 tests" — unverifiable');
    expect(comment.markdown).not.toContain('counts match');
  });

  it('renders a pipeline note as a note, not as an unverifiable claim', () => {
    const claims = [countClaim('c1', '1480 tests', { total: 1480 })];
    const result = reconcile({ pr: pr(), claims, observed: killedRun(), diff: diff() });
    const receipt = buildReceipt({
      pr: pr(),
      agent: agent(),
      claims,
      observed: killedRun(),
      diff: diff(),
      discrepancies: result.discrepancies,
      verdict: result.verdict,
      policy: DEFAULT_POLICY,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    const note = 'runner: running the command the PR claimed (c1): `pnpm test`';
    const { markdown } = renderComment(receipt, { unverifiable: [...result.unverifiable, note] });
    expect(markdown).toContain(`- ${note}\n`);
    expect(markdown).not.toContain(`${note} — unverifiable`);
    expect(markdown).toContain('"1480 tests" — unverifiable');
  });

  it('does not say "abstains" when a diff finding decided the verdict', () => {
    const deleted = diff({ testFiles: { added: [], modified: [], deleted: ['pkg/node/prune_test.go'], renamed: [] } });
    const evidenceless = build(killedRun(), [], deleted);
    expect(evidenceless.comment.title).toContain('FAIL');
    expect(evidenceless.comment.markdown).toContain('the verdict rests on the diff alone');
    expect(evidenceless.comment.markdown).not.toContain('the gate abstains');

    const noCommand = build(noTestCommandRun(), [], deleted);
    expect(noCommand.comment.title).toContain('FAIL');
    expect(noCommand.comment.markdown).toContain('no test command found — the verdict rests on the diff alone');
    expect(noCommand.comment.markdown).not.toContain('the gate abstains');
  });
});

// ---------------------------------------------------------------------------
// C7 — "I have added tests" with no test file in the diff
// ---------------------------------------------------------------------------

const sourceOnly = (): DiffAnalysis =>
  diff({ sourceFiles: ['packages/core/src/index.ts', '.changeset/x.md'], fileCount: 2 });

describe('C7 label pattern — what asserts that tests were added', () => {
  const asserts = (label: string): boolean => claimsTestsAdded(checkboxClaim('c1', label));

  it('matches the wordings real agent PRs use', () => {
    for (const label of [
      'I have added tests that prove my fix is effective or that my feature works',
      'I have added meaningful tests',
      'I have added/updated tests',
      'Wrote unit tests for the new parser',
      'New tests added for the edge case',
      'Tests added for the parser',
      'Unit tests were added',
      'Added a test for the empty-input case',
      'Added test coverage for the retry path',
      'Created regression tests',
      'Added missing tests and updated docs',
    ]) {
      expect(asserts(label), label).toBe(true);
    }
  });

  it('never matches "tests pass" lines, compound nouns, other verbs, or hedged template lines', () => {
    for (const label of [
      'New and existing unit tests pass locally with my changes',
      'All new and existing tests passed',
      'New and existing tests pass',
      'Ran the new tests locally',
      'Add tests for new functionality (if applicable)',
      'I have added tests to cover my changes (if applicable)',
      'Added a test plan section',
      'Added the new test command to the README',
      'Added a test account for QA',
      'Added the `--skip-tests` flag',
      'Documented the new `pnpm test:watch` script',
      'Added a new feature and all existing tests pass',
      'Docs added, tests pass',
      'I have added a screenshot of my new test passing locally',
      'Removed the flaky tests added in #99',
      'Reverted the tests introduced by #99',
      'Unit tests are written in Vitest',
      'Tests are written using the existing harness',
      'I added new tests to check the change I am making, or this PR is test-exempt',
      'Added tests if fixing a bug or adding a new feature',
      'Test update',
      'New feature (non-breaking change that adds functionality)',
      'Bug fix (non-breaking change that fixes an issue)',
      'The handful of test files covering my change pass locally',
      'The tests check the right things, including the edge cases',
      'I have made corresponding changes to the documentation (if applicable)',
      'No tests added — docs only',
      "Tests weren't added: pure refactor",
      'Tests will be added in a follow-up',
      'Added tests: N/A',
    ]) {
      expect(asserts(label), label).toBe(false);
    }
  });

  it('never matches an unticked box', () => {
    expect(claimsTestsAdded(checkboxClaim('c1', 'I have added meaningful tests', false))).toBe(false);
  });

  it('is copied verbatim into study/summarize.mjs', () => {
    // vitest runs from the repository root.
    const summarize = readFileSync(join(process.cwd(), 'study', 'summarize.mjs'), 'utf8');
    expect(summarize).toContain(TESTS_ADDED_LABEL.source);
    expect(summarize).toContain(TESTS_ADDED_NEGATION.source);
  });
});

describe('C7 — a ticked "tests added" box against the diff', () => {
  it('fires with the claim id, the file counts, and a needs-human verdict', () => {
    const result = run({ claims: [checkboxClaim('c1', 'I have added meaningful tests')], diff: sourceOnly() });
    // C8 also fires: the source files are not mentioned in the fixture body.
    expect(checks(result.discrepancies)).toEqual(['C7', 'C8']);
    const [hit] = result.discrepancies;
    expect(hit?.claim).toBe('c1');
    expect(hit?.severity).toBe('needs-human');
    expect(hit?.evidence).toContain('test files added=0 modified=0 renamed=0');
    expect(hit?.evidence).toContain('changed files: 2');
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('is satisfied by an added, a modified, or a renamed test file', () => {
    const claims = [checkboxClaim('c1', 'I have added meaningful tests')];
    const touched = [
      { added: ['src/a.test.ts'], modified: [], deleted: [], renamed: [] },
      { added: [], modified: ['src/a.test.ts'], deleted: [], renamed: [] },
      { added: [], modified: [], deleted: [], renamed: [{ from: 'a.test.ts', to: 'b.test.ts' }] },
    ];
    for (const testFiles of touched) {
      const result = run({ claims, diff: diff({ testFiles, sourceFiles: ['src/a.ts'], fileCount: 2 }) });
      expect(checks(result.discrepancies), JSON.stringify(testFiles)).not.toContain('C7');
      expect(result.unverifiable).toEqual([]);
    }
  });

  it('is not satisfied by deleting tests', () => {
    const result = run({
      claims: [checkboxClaim('c1', 'I have added meaningful tests')],
      diff: diff({
        testFiles: { added: [], modified: [], deleted: ['src/a.test.ts'], renamed: [] },
        sourceFiles: ['src/a.ts'],
        fileCount: 2,
      }),
    });
    expect(checks(result.discrepancies)).toContain('C7');
  });

  it('is unverifiable, not silent, when the diff has no changed files', () => {
    const result = run({ claims: [checkboxClaim('c1', 'I have added meaningful tests')], diff: diff() });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('PASS');
  });

  it('uses the raw file count, so a scope-allowed docs-only change still gets checked', () => {
    // docs/** is scope-allowed: sourceFiles is empty, but git saw one changed file.
    const result = run({
      claims: [checkboxClaim('c1', 'I have added meaningful tests')],
      diff: diff({ fileCount: 1 }),
    });
    expect(checks(result.discrepancies)).toEqual(['C7']);
  });

  it('blocks a run with no evidence: the diff alone supports it', () => {
    const result = run({
      claims: [checkboxClaim('c1', 'I have added meaningful tests')],
      observed: killedRun(),
      diff: sourceOnly(),
    });
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('honours a policy override to info', () => {
    const result = run({
      claims: [checkboxClaim('c1', 'I have added meaningful tests')],
      diff: sourceOnly(),
      policy: { version: '1.0.0', severity: { C7: 'info' } },
    });
    expect(result.discrepancies[0]?.severity).toBe('info');
    expect(result.verdict).toBe('PASS');
  });

  it('is a known check id with a needs-human default, and parses from .merge-evidence.yml', () => {
    expect(CHECK_IDS).toContain('C7');
    expect(DEFAULT_POLICY.severity?.C7).toBe('needs-human');
    expect(parsePolicyYaml('severity:\n  C7: info\n').severity).toEqual({ C7: 'info' });
  });

  it('renders under "Claims vs observed" as a claim line, in all three states', () => {
    const claims = [checkboxClaim('c1', 'I have added meaningful tests')];
    const section = (markdown: string): string =>
      markdown.slice(markdown.indexOf('**Claims vs observed**'), markdown.indexOf('**Verification layer**'));

    const hit = build(observed(), claims, sourceOnly());
    expect(section(hit.comment.markdown)).toContain(
      '"I have added meaningful tests" — ⚠ no test file added, modified, or renamed in the diff',
    );
    expect(hit.comment.markdown.slice(hit.comment.markdown.indexOf('**Verification layer**'))).not.toContain(
      'Claimed tests were added',
    );

    const ok = build(
      observed(),
      claims,
      diff({ testFiles: { added: ['src/a.test.ts'], modified: [], deleted: [], renamed: [] }, fileCount: 1 }),
    );
    expect(section(ok.comment.markdown)).toContain('"I have added meaningful tests" — test files in the diff ✔');

    const unknown = build(observed(), claims, diff());
    expect(section(unknown.comment.markdown)).toContain('"I have added meaningful tests" — unverifiable');
  });
});
