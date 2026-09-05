/**
 * The reconciler: claims (what the agent SAID) vs. the observed run (what
 * ACTUALLY happened) vs. the diff (what the PR CHANGED around the tests).
 *
 * Every discrepancy here is produced by a rule with concrete evidence — test
 * ids, file paths, counts — that a stranger can re-check against the receipt.
 * No heuristics that guess intent, and, crucially, no failure for anything the
 * gate could not verify: a claim that cannot be mapped to the observed run is
 * reported as `unverifiable`, never held against the author.
 */

import type {
  Claim,
  Discrepancy,
  DiffAnalysis,
  ObservedRun,
  ParsedCommand,
  ParsedCount,
  Policy,
  PullRequestFacts,
  Verdict,
} from '../types.js';
import { DEFAULT_POLICY, resolveSeverity } from './policy.js';

export interface ReconcileInput {
  pr: PullRequestFacts;
  claims: Claim[];
  observed: ObservedRun;
  diff: DiffAnalysis;
  policy?: Policy;
}

export interface ReconcileResult {
  discrepancies: Discrepancy[];
  verdict: Verdict;
  /**
   * Ids of claims the gate could not check: a command it could not map to the
   * observed run (a different runner family, an unknown command, selectors
   * naming tests that were not executed), a count with no run to compare
   * against, or a "tests added" box with no diff to compare against. Reported
   * on the comment, never counted against the PR.
   */
  unverifiable: string[];
}

/** How many evidence items a single discrepancy carries before it is capped. */
const MAX_EVIDENCE = 10;
/** How many scope-creep files C8 lists. */
const MAX_SCOPE_FILES = 20;

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function capped(values: readonly string[], limit: number): string[] {
  if (values.length <= limit) return [...values];
  return [...values.slice(0, limit), `… and ${values.length - limit} more`];
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += (ch ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * Reduce a command-line selector to the prefix an executed test id would start
 * with: `./...` → everything, `pkg/x/...` → `pkg/x`, `tests/**` → `tests`.
 */
function normalizeSelector(selector: string): string {
  let path = selector.trim();
  if (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/?\.\.\.$/, '');
  path = path.replace(/\/?\*\*$/, '');
  path = path.replace(/\/$/, '');
  return path;
}

/** Strip the anchors a `-run` / `-k` filter often carries. */
function normalizeNameFilter(filter: string): string {
  return filter.trim().replace(/^\^/, '').replace(/\$$/, '');
}

/**
 * True when a claimed path selector names something in the executed set. A
 * selector that resolves to "everything" (`./...`, `.`) matches as soon as any
 * test ran.
 */
function selectorMatches(selector: string, testIds: readonly string[]): boolean {
  const path = normalizeSelector(selector);
  if (path === '' || path === '.') return testIds.length > 0;
  if (path.includes('*') || path.includes('?')) {
    const re = globToRegExp(path);
    return testIds.some((id) => re.test(id) || id.split('::').some((part) => re.test(part)));
  }
  return testIds.some((id) => id === path || id.startsWith(path));
}

/** Runner families a package script resolves to: `pnpm test` → vitest, jest, or an opaque script. */
const NODE_SCRIPT_RUNNERS: ReadonlySet<ObservedRun['runner']> = new Set(['jest', 'vitest', 'npm']);

/**
 * The package-manager invocation a command makes, reduced to its first two
 * words: `npm run test -- --json` and `npm test` are the same one. The observed
 * command may be a workspace composite (`f=0; (cd 'pkg' && pnpm test …) || f=1;
 * …`); the invocation is the first package-manager call inside it.
 */
function scriptInvocation(command: string): string {
  const call = /(?:^|[\s(;&|])((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[^\s;&|)]+)/.exec(command.trim());
  const invocation = (call?.[1] ?? command.trim()).replace(/^(npm|pnpm|yarn|bun)\s+run\s+/, '$1 ');
  return invocation.split(/\s+/).slice(0, 2).join(' ');
}

/** True when the observed run plausibly IS the run the claim describes. */
function isMappable(parsed: ParsedCommand, observed: ObservedRun): boolean {
  if (observed.noTestCommand === true) return false;
  if (parsed.runner === 'unknown' || observed.runner === 'none') return false;
  if (parsed.runner === 'npm') {
    // A claimed `pnpm test` names a package script whose runner the extractor
    // cannot know; the run resolved that script (to vitest, jest, or an opaque
    // one). It maps when the run was started by the same invocation.
    if (!NODE_SCRIPT_RUNNERS.has(observed.runner)) return false;
    if (scriptInvocation(parsed.raw) !== scriptInvocation(observed.command)) return false;
  } else if (parsed.runner !== observed.runner) {
    return false;
  }
  const testIds = observed.tests.map((test) => test.id);
  if (!parsed.paths.every((path) => selectorMatches(path, testIds))) return false;
  const filters = parsed.nameFilters.map(normalizeNameFilter).filter((f) => f !== '');
  return filters.every((filter) => testIds.some((id) => id.includes(filter)));
}

/** Exit statuses of 128 and above are 128 + signal by shell convention: the runner was killed. */
const KILLED_EXIT = 128;
/** `bash -c` could not run the command at all: not executable (126) or not found (127). */
const CANNOT_RUN_EXITS: ReadonlySet<number> = new Set([126, 127]);
/**
 * Families with no per-test output ever. Their exit code is the only evidence,
 * and some of their runners (mocha) exit with the failure COUNT, so a status of
 * 130 there is 130 failed tests, not SIGINT — the 128+ rule does not apply.
 */
const OPAQUE_RUNNERS: ReadonlySet<ObservedRun['runner']> = new Set(['cargo', 'make', 'npm']);

/**
 * True when the command ran but produced NO evidence about the PR: the runner
 * died by signal (OOM, SIGTERM), could not start at all (exit 126/127 — a
 * toolchain missing from the runner), or the family writes a report and none
 * was found. Nothing in such a run can confirm or contradict a claim, so the
 * claims become unverifiable and the verdict abstains.
 *
 * Deliberately narrow. A report that says the suite failed to load (jest and
 * vitest write one, with zero tests and a non-zero exit) IS evidence: the PR
 * broke the tests. A plain `cargo test` or `make test` has no per-test output
 * ever, and its normal exit code is still the evidence C1 reads. A run with no
 * test command at all is a separate state (`noTestCommand`).
 */
export function hasNoEvidence(observed: ObservedRun): boolean {
  if (observed.noTestCommand === true) return false;
  if (observed.tests.length > 0 || observed.totals.run > 0) return false;
  if (observed.reportMissing === true) return true;
  if (observed.signal !== undefined) return true;
  if (CANNOT_RUN_EXITS.has(observed.exitCode)) return true;
  return observed.exitCode >= KILLED_EXIT && !OPAQUE_RUNNERS.has(observed.runner);
}

/** Head failures split by whether the base commit shows them too; undefined without a baseline. */
export function partitionFailures(
  observed: ObservedRun,
): { introduced: string[]; preExisting: string[] } | undefined {
  const baseline = observed.baseline;
  if (baseline === undefined) return undefined;
  const atBase = new Set(baseline.failed);
  const failed = sorted(observed.tests.filter((test) => test.status === 'failed').map((test) => test.id));
  return {
    introduced: failed.filter((id) => !atBase.has(id)),
    preExisting: failed.filter((id) => atBase.has(id)),
  };
}

/**
 * True when a failed head run is this pull request's doing: some failing test
 * passes (or does not exist) at base, or the run failed as a whole — nothing
 * per-test to compare — while the base run succeeded. Without a baseline, or
 * with one that produced no evidence, the head failure stands as observed.
 */
export function failureIntroduced(observed: ObservedRun): boolean {
  const baseline = observed.baseline;
  const split = partitionFailures(observed);
  if (baseline === undefined || split === undefined) return true;
  if (baseline.noEvidence === true) return true;
  if (split.introduced.length > 0) return true;
  if (split.preExisting.length === 0) return baseline.exitCode === 0;
  return false;
}

function commandParsed(claim: Claim): ParsedCommand | undefined {
  return claim.parsed.kind === 'command' ? claim.parsed : undefined;
}

function countParsed(claim: Claim): ParsedCount | undefined {
  return claim.parsed.kind === 'count' ? claim.parsed : undefined;
}

/**
 * C1 — a command the agent claimed to run never ran, or failed.
 *
 * Mapping is deliberately conservative: same runner family, every claimed path
 * present in the executed set, every name filter matched by some executed id.
 * Anything short of that is `unverifiable`, not a failure.
 */
function checkC1(
  claims: readonly Claim[],
  observed: ObservedRun,
  policy: Policy,
): { discrepancies: Discrepancy[]; unverifiable: string[] } {
  const discrepancies: Discrepancy[] = [];
  const unverifiable: string[] = [];
  const noEvidence = hasNoEvidence(observed);

  for (const claim of claims) {
    const parsed = commandParsed(claim);
    if (parsed === undefined) continue;

    // A run that produced no per-test evidence cannot contradict anything —
    // "exit 137, 0 tests" is a sandbox fact about the runner, not about the PR.
    if (noEvidence || !isMappable(parsed, observed)) {
      unverifiable.push(claim.id);
      continue;
    }
    if (observed.exitCode === 0) continue;

    // The same command fails at the base commit in the same way: the
    // repository fails on a clean runner regardless of this PR. The claim is
    // "not reproduced" here, which is unverifiable — never a contradiction.
    if (!failureIntroduced(observed)) {
      unverifiable.push(claim.id);
      continue;
    }

    const split = partitionFailures(observed);
    const failed =
      split === undefined
        ? sorted(observed.tests.filter((test) => test.status === 'failed').map((test) => test.id))
        : split.introduced;
    const baseline = observed.baseline;
    discrepancies.push({
      check: 'C1',
      severity: resolveSeverity('C1', policy),
      claim: claim.id,
      summary: `Claimed \`${parsed.raw}\` passed; the re-run exited ${observed.exitCode}`,
      evidence: [
        `claimed command: ${parsed.raw}`,
        `observed command: ${observed.command}`,
        `observed exit_code=${observed.exitCode}`,
        ...capped(failed.map((id) => `${split === undefined ? 'failed' : 'introduced'}: ${id}`), MAX_EVIDENCE),
        ...(baseline === undefined || split === undefined
          ? []
          : [
              `base ${baseline.sha.slice(0, 7)}: exit_code=${baseline.exitCode}, ${split.preExisting.length} of these failures also present there`,
            ]),
      ],
    });
  }

  return { discrepancies, unverifiable };
}

/**
 * C2 — the test count the agent stated does not match what ran.
 *
 * Needs per-test evidence on the observed side: with no run (no test
 * command), no evidence, or an opaque runner that enumerates nothing, there is
 * no observed count to compare against and every count claim is unverifiable —
 * never "claimed 1480; 0 observed". A claim about fewer tests than the run
 * executed is a subset claim (one package of a monorepo) and is unverifiable
 * too.
 */
function checkC2(
  claims: readonly Claim[],
  observed: ObservedRun,
  policy: Policy,
): { discrepancies: Discrepancy[]; unverifiable: string[] } {
  const discrepancies: Discrepancy[] = [];
  const unverifiable: string[] = [];
  const noCounts =
    observed.noTestCommand === true || hasNoEvidence(observed) || observed.totals.run === 0;

  for (const claim of claims) {
    const parsed = countParsed(claim);
    if (parsed === undefined) continue;
    if (noCounts) {
      unverifiable.push(claim.id);
      continue;
    }

    // A claim smaller than the run describes a subset — "322 tests" for one
    // package while the gate ran the whole monorepo (5,904). The observed
    // totals then say nothing about that subset, failures included, so the
    // claim is unverifiable. The claim's size is its total, or the sum of the
    // parts it states ("400 passed, 12 skipped" describes 412). A bare failure
    // count has no size and is always compared. A claim LARGER than the run is
    // still compared: more tests than exist is a real discrepancy.
    const claimedSize =
      parsed.total ??
      (parsed.passed !== undefined
        ? parsed.passed + (parsed.failed ?? 0) + (parsed.skipped ?? 0)
        : undefined);
    if (claimedSize !== undefined && claimedSize < observed.totals.run) {
      unverifiable.push(claim.id);
      continue;
    }

    const comparisons: Array<{ label: string; claimed: number; observed: number }> = [];
    if (parsed.total !== undefined && parsed.total !== observed.totals.run) {
      comparisons.push({ label: 'total', claimed: parsed.total, observed: observed.totals.run });
    }
    if (parsed.passed !== undefined && parsed.passed !== observed.totals.passed) {
      comparisons.push({ label: 'passed', claimed: parsed.passed, observed: observed.totals.passed });
    }
    if (parsed.failed !== undefined && parsed.failed !== observed.totals.failed) {
      comparisons.push({ label: 'failed', claimed: parsed.failed, observed: observed.totals.failed });
    }
    if (comparisons.length === 0) continue;

    const first = comparisons[0];
    discrepancies.push({
      check: 'C2',
      severity: resolveSeverity('C2', policy),
      claim: claim.id,
      summary:
        first === undefined
          ? 'Claimed counts differ from the observed run'
          : `Claimed ${first.claimed} ${first.label}; ${first.observed} observed`,
      evidence: comparisons.flatMap((c) => [
        `claimed ${c.label}=${c.claimed}`,
        `observed ${c.label === 'total' ? 'run' : c.label}=${c.observed}`,
      ]),
    });
  }

  return { discrepancies, unverifiable };
}

/**
 * A ticked checklist item that asserts tests were ADDED. Two shapes:
 *
 *   verb → allow-listed modifiers → tests   "I have added meaningful tests",
 *                                           "added tests that prove …",
 *                                           "wrote unit tests for the parser"
 *   tests → (were | have been) → added      "Tests added for X", "New tests
 *     (anchored at the start of the label)  were added" — never "removed the
 *                                           flaky tests added in #99"
 *
 * The verb list is short on purpose and never includes a bare "new" or "add":
 * "New and existing unit tests pass" asserts passing, not adding, and sits in
 * the most-copied PR template directly under the real "I have added tests"
 * line. The noun must be plural, or an explicit "test case", "test coverage",
 * or "a test for": "added a test account", "added a test plan section",
 * "added unit test helpers", "added the `--skip-tests` flag" never count.
 *
 * `study/summarize.mjs` carries a verbatim copy; a test keeps them identical.
 */
export const TESTS_ADDED_LABEL =
  /\b(?:added|adds|wrote|written|created|introduced|implemented)(?:\/(?:updated|extended|adjusted|improved|expanded|fixed))?(?:\s+(?:a|an|the|some|new|more|additional|meaningful|comprehensive|thorough|unit|integration|regression|e2e|end-to-end|corresponding|relevant|appropriate|missing|extra|basic|initial|proper|automated|dedicated|targeted|several|two|three|few))*\s+(?:tests|test\s+cases?|test\s+coverage|test\s+for)\b|^\s*(?:new|additional|more|missing|corresponding|unit|integration|regression|e2e)?\s*tests\s+(?:were\s+|have\s+been\s+)?(?:added|created)\b/i;

/**
 * Negations and hedges: "no tests added", "tests weren't added", "N/A",
 * "Tests added: 0", "(if applicable)", "in a follow-up", "if fixing a bug",
 * "or this PR is test-exempt", "tests were added in another PR" / "in #99".
 * A ticked box with one of these is an honest statement, a template hedge, or
 * a claim about a different change — never a hit.
 */
export const TESTS_ADDED_NEGATION =
  /\b(?:no|not|none|without|n\/a|todo|later|follow-?up|exempt|optional|unless)\b|n't\b|\b(?:if|where|when|as)\s+(?:applicable|appropriate|needed|necessary|relevant|required)\b|\bif\s+\w+ing\b|\bonly\s+if\b|\bor\s+(?:this|the|it|we|i)\b|\b(?:another|separate|previous|earlier|prior|different|other|upstream)\s+(?:PR|pull\s+request|change|changeset|commit|branch)\b|\bin\s+#\d+|:\s*(?:0|zero|none)\b/i;

/** True for a checked checkbox claim whose label asserts tests were added. */
export function claimsTestsAdded(claim: Claim): boolean {
  if (claim.parsed.kind !== 'checkbox' || !claim.parsed.checked) return false;
  const label = claim.parsed.label;
  return TESTS_ADDED_LABEL.test(label) && !TESTS_ADDED_NEGATION.test(label);
}

function changedFileCount(diff: DiffAnalysis): number {
  return (
    diff.testFiles.added.length +
    diff.testFiles.modified.length +
    diff.testFiles.deleted.length +
    diff.testFiles.renamed.length +
    diff.dependencyFiles.length +
    diff.snapshotFiles.length +
    diff.sourceFiles.length
  );
}

/**
 * C7 — the body says tests were added; the diff touches no test file.
 *
 * Purely structural: a checked "I have added tests" box against the diff's
 * test-file categories. Modified and renamed test files count as touched — the
 * check is about a claim with nothing behind it, not about how much. A diff
 * with no changed files at all (an empty PR, or a base that could not be
 * compared) gives the check nothing to look at, so the claim is unverifiable —
 * never a hit, never a confirmation.
 */
function checkC7(
  claims: readonly Claim[],
  diff: DiffAnalysis,
  policy: Policy,
): { discrepancies: Discrepancy[]; unverifiable: string[] } {
  const eligible = claims.filter(claimsTestsAdded);
  if (eligible.length === 0) return { discrepancies: [], unverifiable: [] };

  const changed = diff.fileCount ?? changedFileCount(diff);
  if (changed === 0) return { discrepancies: [], unverifiable: eligible.map((claim) => claim.id) };

  const touched =
    diff.testFiles.added.length + diff.testFiles.modified.length + diff.testFiles.renamed.length;
  if (touched > 0) return { discrepancies: [], unverifiable: [] };

  return {
    discrepancies: eligible.map((claim) => ({
      check: 'C7' as const,
      severity: resolveSeverity('C7', policy),
      claim: claim.id,
      summary: 'Claimed tests were added; the diff touches no test file',
      evidence: [
        `claimed: "${claim.parsed.kind === 'checkbox' ? claim.parsed.label : claim.text}"`,
        'test files added=0 modified=0 renamed=0',
        `changed files: ${changed}`,
      ],
    })),
    unverifiable: [],
  };
}

/** Test ids enumerated at base that are gone at head. */
export function missingAtHead(observed: ObservedRun): string[] {
  const base = observed.enumeratedAtBase;
  const head = observed.enumeratedAtHead;
  if (base === undefined || head === undefined) return [];
  const present = new Set(head);
  return sorted(base.filter((id) => !present.has(id)));
}

/**
 * C3 — tests deleted, renamed away, skipped, or focused.
 *
 * Emitted as one discrepancy per kind of evidence so the comment can show each
 * hit on its own line instead of a single opaque bundle.
 */
function checkC3(diff: DiffAnalysis, observed: ObservedRun, policy: Policy): Discrepancy[] {
  const severity = resolveSeverity('C3', policy);
  const discrepancies: Discrepancy[] = [];

  const gone = missingAtHead(observed);
  if (gone.length > 0) {
    discrepancies.push({
      check: 'C3',
      severity,
      summary: `${gone.length} test${gone.length === 1 ? '' : 's'} present at base ${gone.length === 1 ? 'is' : 'are'} absent at head`,
      evidence: capped(gone, MAX_EVIDENCE).map((id) => `${id} enumerated at base, absent at head`),
    });
  }

  const deleted = sorted(diff.testFiles.deleted);
  if (deleted.length > 0) {
    discrepancies.push({
      check: 'C3',
      severity,
      summary: `${deleted.length} test file${deleted.length === 1 ? '' : 's'} deleted in this PR`,
      evidence: capped(deleted, MAX_EVIDENCE),
    });
  }

  const renamed = [...diff.testFiles.renamed]
    .map((rename) => `${rename.from} → ${rename.to}`)
    .sort();
  if (renamed.length > 0) {
    discrepancies.push({
      check: 'C3',
      severity,
      summary: `${renamed.length} test file${renamed.length === 1 ? '' : 's'} renamed in this PR`,
      evidence: capped(renamed, MAX_EVIDENCE),
    });
  }

  const skips = [...diff.skipMarkersAdded].map((hit) => `${hit.file}: ${hit.marker}`).sort();
  if (skips.length > 0) {
    discrepancies.push({
      check: 'C3',
      severity,
      summary: `${skips.length} skip marker${skips.length === 1 ? '' : 's'} added in this PR`,
      evidence: capped(skips, MAX_EVIDENCE),
    });
  }

  const focus = [...diff.focusMarkersAdded].map((hit) => `${hit.file}: ${hit.marker}`).sort();
  if (focus.length > 0) {
    discrepancies.push({
      check: 'C3',
      severity,
      summary: `${focus.length} focus marker${focus.length === 1 ? '' : 's'} added in this PR`,
      evidence: capped(focus, MAX_EVIDENCE),
    });
  }

  return discrepancies;
}

/** C4 — CI workflow, coverage threshold, or agent-rules file edited. */
function checkC4(diff: DiffAnalysis, policy: Policy): Discrepancy[] {
  const severity = resolveSeverity('C4', policy);
  return [...diff.verificationLayerEdits]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.reason < b.reason ? -1 : 1))
    .map((edit) => ({
      check: 'C4' as const,
      severity,
      summary: `${edit.file} edited`,
      evidence: [edit.reason],
    }));
}

/** True when the PR body names the file, by full path or by basename. */
function mentionedInBody(path: string, body: string): boolean {
  if (path === '') return false;
  if (body.includes(path)) return true;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename !== '' && body.includes(basename);
}

/** C5 — lockfile / dependency manifest changed without being mentioned. */
function checkC5(diff: DiffAnalysis, pr: PullRequestFacts, policy: Policy): Discrepancy[] {
  const files = sorted(diff.dependencyFiles);
  if (files.length === 0) return [];
  if (files.some((file) => mentionedInBody(file, pr.body))) return [];
  return [
    {
      check: 'C5',
      severity: resolveSeverity('C5', policy),
      summary: `${files.length} dependency file${files.length === 1 ? '' : 's'} changed, none mentioned in the PR body`,
      evidence: capped(files, MAX_EVIDENCE),
    },
  ];
}

/** C6 — snapshot or golden files updated. */
function checkC6(diff: DiffAnalysis, policy: Policy): Discrepancy[] {
  const files = sorted(diff.snapshotFiles);
  if (files.length === 0) return [];
  return [
    {
      check: 'C6',
      severity: resolveSeverity('C6', policy),
      summary: `${files.length} snapshot/golden file${files.length === 1 ? '' : 's'} updated`,
      evidence: capped(files, MAX_EVIDENCE),
    },
  ];
}

/** C8 — files changed outside what the PR describes (informational). */
function checkC8(diff: DiffAnalysis, pr: PullRequestFacts, policy: Policy): Discrepancy[] {
  const allow = policy.scopeAllow ?? [];
  const unmentioned = sorted(diff.sourceFiles).filter(
    (file) => !mentionedInBody(file, pr.body) && !matchesAnyGlob(file, allow),
  );
  if (unmentioned.length === 0) return [];
  return [
    {
      check: 'C8',
      severity: resolveSeverity('C8', policy),
      summary: `${unmentioned.length} changed file${unmentioned.length === 1 ? '' : 's'} not mentioned in the PR body`,
      evidence: capped(unmentioned, MAX_SCOPE_FILES),
    },
  ];
}

/**
 * The checks that need no test run: they read the diff (and, for C7, the diff
 * against a claim), so their findings stand even when the run said nothing.
 * C8 is here so a repository that raises its severity gets what it asked for.
 */
const RUN_INDEPENDENT_CHECKS: ReadonlySet<Discrepancy['check']> = new Set([
  'C3',
  'C4',
  'C5',
  'C6',
  'C7',
  'C8',
]);

/**
 * Verdict precedence: a run with no test command — or one that produced no
 * per-test evidence — abstains (NEUTRAL) unless a run-independent check found
 * something above `info`; otherwise any `fail` wins, then any `needs-human`,
 * else PASS.
 */
export function decideVerdict(discrepancies: readonly Discrepancy[], observed: ObservedRun): Verdict {
  const hasFail = discrepancies.some((d) => d.severity === 'fail');
  const hasNeedsHuman = discrepancies.some((d) => d.severity === 'needs-human');

  if (observed.noTestCommand === true || hasNoEvidence(observed)) {
    const blocking = discrepancies.some(
      (d) =>
        RUN_INDEPENDENT_CHECKS.has(d.check) && (d.severity === 'fail' || d.severity === 'needs-human'),
    );
    if (!blocking) return 'NEUTRAL';
  }

  if (hasFail) return 'FAIL';
  if (hasNeedsHuman) return 'NEEDS_HUMAN';
  return 'PASS';
}

/** Run every check, in receipt order, and decide the verdict. */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const policy = input.policy ?? DEFAULT_POLICY;
  const { pr, claims, observed, diff } = input;

  const c1 = checkC1(claims, observed, policy);
  const c2 = checkC2(claims, observed, policy);
  const c7 = checkC7(claims, diff, policy);
  const discrepancies: Discrepancy[] = [
    ...c1.discrepancies,
    ...c2.discrepancies,
    ...checkC3(diff, observed, policy),
    ...checkC4(diff, policy),
    ...checkC5(diff, pr, policy),
    ...checkC6(diff, policy),
    ...c7.discrepancies,
    ...checkC8(diff, pr, policy),
  ];

  return {
    discrepancies,
    verdict: decideVerdict(discrepancies, observed),
    unverifiable: [...c1.unverifiable, ...c2.unverifiable, ...c7.unverifiable],
  };
}
