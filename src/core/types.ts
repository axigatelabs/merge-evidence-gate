/**
 * Shared contracts for the Merge-Evidence Gate core.
 *
 * Every core module (claims, runners, diff, reconcile, render) implements
 * against these types and nothing else, so the modules can be built and
 * tested independently. The GitHub Action (src/main.ts) is the only place
 * that touches @actions/* — the core is pure, synchronous where possible,
 * and runs anywhere Node runs.
 *
 * The receipt shape here IS the open format ("merge-evidence/receipt/v1");
 * see docs/receipt-spec.md. Treat field names as an API.
 */

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

export type AgentKind =
  | 'copilot'
  | 'devin'
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'opencode'
  | 'unknown';

export interface AgentDetection {
  /** Best guess at which agent authored the PR; 'unknown' when no signal. */
  detected: AgentKind;
  /** Which signals fired, e.g. 'login', 'branch-prefix', 'body-marker', 'coauthor-trailer'. */
  signals: string[];
  /** True when at least one signal fired — the gate only runs for agent PRs by default. */
  isAgent: boolean;
}

/** The PR facts the detector and extractor need; filled by the Action from the event payload. */
export interface PullRequestFacts {
  repo: string; // "owner/name"
  number: number;
  headSha: string;
  baseSha: string;
  /**
   * The commit the change forked from, when the caller knows it (the study
   * harness records it; the Action asks the API when the checkout is shallow).
   * `baseSha` is the base branch's tip, which may be ahead of it.
   */
  mergeBaseSha?: string;
  baseRef: string;
  headRef: string;
  authorLogin: string;
  body: string;
  title: string;
  /** Commit message trailers/bodies for the PR's commits (best-effort; may be empty). */
  commitMessages: string[];
}

// ---------------------------------------------------------------------------
// Claims (what the agent SAID)
// ---------------------------------------------------------------------------

export type ClaimKind =
  | 'command' // a backticked test command, e.g. `go test ./...`
  | 'count' // "68 tests, 0 failures" / "48 pass, 0 fail"
  | 'test' // a named test the agent says it ran or added
  | 'checkbox' // "- [x] tests pass" (checked) or "- [ ]" (unchecked = honest, unenforced)
  | 'caveat'; // "blocked by…", "not verified", "could not run"

export interface Claim {
  id: string; // "c1", "c2", …
  kind: ClaimKind;
  /** Verbatim text as it appeared in the PR body. */
  text: string;
  /** Structured parse; shape depends on kind. */
  parsed: ParsedCommand | ParsedCount | ParsedTest | ParsedCheckbox | ParsedCaveat;
  /** Where in the body it came from (heading context), e.g. "Test plan". */
  section?: string;
  /**
   * For a count: the id of the command claim it follows in the same section
   * (or on the same line) — the run it reports on. A count bound to a command
   * that was not the one executed cannot be compared.
   */
  commandRef?: string;
}

export interface ParsedCommand {
  kind: 'command';
  /** Normalized runner family the command belongs to. */
  runner: RunnerFamily | 'unknown';
  /** The raw command string without backticks. */
  raw: string;
  /** Path/package selectors found in the command, e.g. ["./...", "pkg/x"]. */
  paths: string[];
  /** Name filters found in the command (-run, -k, -t), if any. */
  nameFilters: string[];
}

export interface ParsedCount {
  kind: 'count';
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

export interface ParsedTest {
  kind: 'test';
  /** The test identifier as written, e.g. "TestPrune" or "test_login". */
  name: string;
}

export interface ParsedCheckbox {
  kind: 'checkbox';
  checked: boolean;
  label: string;
}

export interface ParsedCaveat {
  kind: 'caveat';
  reason: string;
}

// ---------------------------------------------------------------------------
// Observed execution (what ACTUALLY ran)
// ---------------------------------------------------------------------------

export type RunnerFamily = 'go' | 'pytest' | 'jest' | 'vitest' | 'node-test' | 'cargo' | 'junit' | 'make' | 'npm';

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'focused' | 'todo';

export interface ExecutedTest {
  /** Stable identity: go "pkg/Test/Sub", pytest nodeid, jest "file::fullName", cargo "bin::mod::test". */
  id: string;
  status: TestStatus;
  /** Source file when the reporter provides it. */
  file?: string;
  durationMs?: number;
  /** Times this test was invoked; >1 means a retry happened (flaky masking signal). */
  invocations?: number;
}

/**
 * The same command executed at the base commit, in the same environment. Taken
 * only when the head run failed with evidence — never when it passed, so a
 * baseline can only ever turn a failure into "the repository already fails".
 */
export interface BaselineRun {
  /** Commit the baseline ran at (the pull request's base). */
  sha: string;
  exitCode: number;
  totals: ObservedRun['totals'];
  /** Ids of tests that failed at base. */
  failed: string[];
  /** True when the base run itself produced no per-test evidence (killed, report missing). */
  noEvidence?: boolean;
}

export interface ObservedRun {
  /** The exact command executed, after reporter injection. */
  command: string;
  runner: RunnerFamily | 'none';
  /**
   * Exit status. When the process died by signal the shell convention
   * 128 + signal number is recorded (137 for SIGKILL) and `signal` is set.
   */
  exitCode: number;
  /** Signal that terminated the runner (`SIGKILL`, `SIGTERM`), when it died by one. */
  signal?: string;
  durationMs: number;
  /** Toolchain versions recorded from the runner, e.g. { go: "1.25.1", node: "24.4.0" }. */
  toolchain: Record<string, string>;
  totals: { run: number; passed: number; failed: number; skipped: number; retried: number };
  tests: ExecutedTest[];
  /** Tests enumerated at HEAD before running (for exact deleted/renamed detection), when available. */
  enumeratedAtHead?: string[];
  /** Tests enumerated at BASE, when available. */
  enumeratedAtBase?: string[];
  /** True when no test command could be determined — verdict becomes neutral. */
  noTestCommand?: boolean;
  /**
   * True when the runner family writes a machine-readable report and none was
   * found (or it could not be parsed) after the command ran: the runner was
   * killed or crashed before the reporter wrote. Distinct from a report that
   * says zero tests ran — that is evidence.
   */
  reportMissing?: boolean;
  /**
   * The same command run at the base commit, present when the head run failed
   * and the gate could take one. Lets C1 tell a failure this PR introduced from
   * one the repository already had on a clean runner.
   */
  baseline?: BaselineRun;
  /** Raw reporter output path for the receipt artifact (never inlined). */
  reportPath?: string;
  /** The claim whose command this run executed, when the run came from a claim. */
  claimId?: string;
}

/** Context an adapter may use while parsing; every field is optional. */
export interface ParseOptions {
  /** The directory the tests ran in, symlinks resolved — absolute file paths are made relative to it. */
  cwd?: string;
}

/** A runner adapter turns a reporter's machine output into ExecutedTest[]. */
export interface RunnerAdapter {
  family: RunnerFamily;
  /**
   * Parse the raw reporter output (JSON text, JUnit XML text, go -json stream).
   * `options.cwd` lets an adapter whose reporter writes absolute paths (node's
   * test runner) relativise them, so ids are the same on every machine.
   */
  parse(raw: string, options?: ParseOptions): { tests: ExecutedTest[]; totals: ObservedRun['totals'] };
}

// ---------------------------------------------------------------------------
// Diff analysis (what the PR CHANGED around the tests)
// ---------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldPath?: string; // for renames
  /** Unified patch text for this file, when available (used by content detectors). */
  patch?: string;
}

export interface DiffAnalysis {
  /** Test files touched, by category. */
  testFiles: { added: string[]; modified: string[]; deleted: string[]; renamed: Array<{ from: string; to: string }> };
  /** Skip/focus/xfail markers ADDED in the diff, with file + the matched marker. */
  skipMarkersAdded: Array<{ file: string; marker: string }>;
  focusMarkersAdded: Array<{ file: string; marker: string }>;
  /** Verification-layer edits: CI workflows, coverage thresholds, agent rule files, conftest, "|| true" etc. */
  verificationLayerEdits: Array<{ file: string; reason: string }>;
  /** Dependency manifests / lockfiles touched. */
  dependencyFiles: string[];
  /** Snapshot / golden / testdata files touched. */
  snapshotFiles: string[];
  /** All non-test source files touched (for scope comparison). */
  sourceFiles: string[];
  /**
   * Number of changed files git reported, before categorisation and before
   * `scopeAllow` filtering. Zero means an empty diff or a base that could not
   * be compared; absent when the analysis was built without that count.
   */
  fileCount?: number;
  /**
   * True when the change list came from a two-dot diff against the base tip
   * because no merge base was reachable (a shallow checkout). Such a list
   * mixes the pull request's changes with everything the base branch did
   * since the fork point — upstream additions read as the PR's deletions —
   * so no change-based check may draw on it.
   */
  unreliable?: boolean;
}

// ---------------------------------------------------------------------------
// Reconciliation → discrepancies → verdict → receipt
// ---------------------------------------------------------------------------

/** Stable check identifiers (from the build spec). Treat as an API. */
export type CheckId =
  | 'C1' // claimed command failed on the clean re-run (unmappable claims are unverifiable, not C1)
  | 'C2' // claimed count ≠ observed
  | 'C3' // tests deleted / renamed / skipped / focused
  | 'C4' // verification-layer edits
  | 'C5' // unmentioned dependency / lockfile change
  | 'C6' // snapshot / golden updates
  | 'C7' // "tests added" ticked, diff touches no test file
  | 'C8' // scope creep (info)
  | 'C9'; // tests that pass at base fail at head (introduced failures)

export type Severity = 'fail' | 'needs-human' | 'info';

export interface Discrepancy {
  check: CheckId;
  severity: Severity;
  /** Which claim this concerns, if any. */
  claim?: string;
  /** One-line human explanation shown on the receipt. */
  summary: string;
  /** Concrete evidence: test ids, file paths, counts. */
  evidence: string[];
}

export type Verdict = 'PASS' | 'NEEDS_HUMAN' | 'FAIL' | 'NEUTRAL';

/** Policy knobs; defaults produce the v1 near-zero-false-positive behaviour. */
export interface Policy {
  version: string;
  /** Override severity per check, e.g. { C2: 'info' }. */
  severity?: Partial<Record<CheckId, Severity>>;
  /** Paths that are allowed to change without being mentioned (globs). */
  scopeAllow?: string[];
  /** Skip the gate entirely when the PR author is not a detected agent. */
  agentsOnly?: boolean;
}

export interface Receipt {
  schema: 'merge-evidence/receipt/v1';
  generatedAt: string; // ISO-8601
  pr: {
    repo: string;
    number: number;
    head_sha: string;
    base_sha: string;
    author: string;
  };
  agent: { detected: AgentKind; signals: string[] };
  claims: Array<Claim & { body_hash: string }>;
  observed: {
    command: string;
    exit_code: number;
    toolchain: Record<string, string>;
    totals: ObservedRun['totals'];
    /** sha256 over the sorted executed test ids — lets a stranger verify the set without the raw log. */
    tests_digest: string;
    duration_s: number;
    /** The claim whose command this run executed, when the run came from a claim. */
    claim?: string;
    no_test_command?: boolean;
    /**
     * True when the command ran but produced no evidence about the PR: the
     * runner died by signal, could not start (exit 126/127), or its report is
     * missing or unparsable. Claims about the run are unverifiable and the
     * verdict abstains — inconclusive, not failed. A report that says zero
     * tests ran is evidence and does not set this.
     */
    no_evidence?: boolean;
    /**
     * Present when the head run failed and the gate re-ran the same command at
     * the base commit. `introduced` lists head failures that pass (or do not
     * exist) at base — the ones this pull request is answerable for;
     * `pre_existing` counts head failures that fail at base too.
     */
    baseline?: {
      sha: string;
      exit_code: number;
      totals: ObservedRun['totals'];
      pre_existing: number;
      introduced: string[];
    };
  };
  diff: {
    tests: { added: string[]; deleted: string[]; skipped_added: string[]; focused: string[] };
    sensitive_paths: string[];
    lockfiles: string[];
    snapshots: string[];
    /** Present and `true` when no merge base was reachable and the change-based checks did not run. */
    unreliable?: boolean;
  };
  discrepancies: Discrepancy[];
  verdict: Verdict;
  policy_version: string;
  /** Filled in v1.1 when the receipt is attested via actions/attest. */
  signature?: { attestation_id?: string; predicate_type: string };
}

/** What the render module produces for the sticky PR comment. */
export interface RenderedComment {
  /** Hidden HTML marker used to find and update the same comment idempotently. */
  marker: string;
  /** Markdown body, ≤ 8 KB. */
  markdown: string;
  /** Short title suitable for a check-run title (≤ 255 chars). */
  title: string;
}
