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
   * Ids of claims the gate could not map to the observed run (a different
   * runner family, an unknown command, or selectors naming tests that were not
   * executed). Reported on the comment, never counted against the PR.
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

/** True when the observed run plausibly IS the run the claim describes. */
function isMappable(parsed: ParsedCommand, observed: ObservedRun): boolean {
  if (observed.noTestCommand === true) return false;
  if (parsed.runner === 'unknown' || observed.runner === 'none') return false;
  if (parsed.runner !== observed.runner) return false;
  const testIds = observed.tests.map((test) => test.id);
  if (!parsed.paths.every((path) => selectorMatches(path, testIds))) return false;
  const filters = parsed.nameFilters.map(normalizeNameFilter).filter((f) => f !== '');
  return filters.every((filter) => testIds.some((id) => id.includes(filter)));
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

  for (const claim of claims) {
    const parsed = commandParsed(claim);
    if (parsed === undefined) continue;

    if (!isMappable(parsed, observed)) {
      unverifiable.push(claim.id);
      continue;
    }
    if (observed.exitCode === 0) continue;

    const failed = sorted(
      observed.tests.filter((test) => test.status === 'failed').map((test) => test.id),
    );
    discrepancies.push({
      check: 'C1',
      severity: resolveSeverity('C1', policy),
      claim: claim.id,
      summary: `Claimed \`${parsed.raw}\` passed; the re-run exited ${observed.exitCode}`,
      evidence: [
        `claimed command: ${parsed.raw}`,
        `observed command: ${observed.command}`,
        `observed exit_code=${observed.exitCode}`,
        ...capped(failed.map((id) => `failed: ${id}`), MAX_EVIDENCE),
      ],
    });
  }

  return { discrepancies, unverifiable };
}

/** C2 — the test count the agent stated does not match what ran. */
function checkC2(claims: readonly Claim[], observed: ObservedRun, policy: Policy): Discrepancy[] {
  if (observed.noTestCommand === true) return [];
  const discrepancies: Discrepancy[] = [];

  for (const claim of claims) {
    const parsed = countParsed(claim);
    if (parsed === undefined) continue;

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

  return discrepancies;
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
 * Verdict precedence: a run with no test command abstains (NEUTRAL) unless the
 * verification-layer checks found something on their own; otherwise any `fail`
 * wins, then any `needs-human`, else PASS.
 */
export function decideVerdict(discrepancies: readonly Discrepancy[], observed: ObservedRun): Verdict {
  const hasFail = discrepancies.some((d) => d.severity === 'fail');
  const hasNeedsHuman = discrepancies.some((d) => d.severity === 'needs-human');

  if (observed.noTestCommand === true) {
    const blocking = discrepancies.some(
      (d) =>
        (d.check === 'C3' || d.check === 'C4' || d.check === 'C5' || d.check === 'C6') &&
        (d.severity === 'fail' || d.severity === 'needs-human'),
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
  const discrepancies: Discrepancy[] = [
    ...c1.discrepancies,
    ...checkC2(claims, observed, policy),
    ...checkC3(diff, observed, policy),
    ...checkC4(diff, policy),
    ...checkC5(diff, pr, policy),
    ...checkC6(diff, policy),
    ...checkC8(diff, pr, policy),
  ];

  return {
    discrepancies,
    verdict: decideVerdict(discrepancies, observed),
    unverifiable: c1.unverifiable,
  };
}
