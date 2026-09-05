# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The receipt format is versioned separately from the action: field names in
`merge-evidence/receipt/v1` are an API, additions are allowed in a minor version,
and renames or removals require `/v2`. See
[docs/receipt-spec.md](docs/receipt-spec.md).

## 0.2.0 — unreleased

Findings from the first real batch of the Claim–Reality Gap study (40 public
Devin pull requests on mastra-ai/mastra re-run offline) and an adversarial
review of the fix.

### Added

- **C7 — "tests added" with no test file in the diff.** A ticked checklist
  line asserting that tests were added ("I have added meaningful tests", "I have
  added tests that prove my fix is effective…" — ticked in 49 of the 140 agent
  PR bodies sampled) is compared with the diff's test-file categories. Default
  severity `needs-human`. The label pattern is verb-based and never matches the
  sibling template line "New and existing unit tests pass", compound nouns
  ("added a test plan section"), negations, or hedges ("if applicable"). With no
  changed files to look at the claim is reported unverifiable. Rendered under
  "Claims vs observed" as a claim line.
- **`observed.no_evidence`** on the receipt: the command ran but produced no
  evidence about the PR — the runner died by signal (exit 128 + signal), could
  not start at all (exit 126/127: a toolchain missing from the runner), or its
  report is missing or unparsable. Command and count claims are then
  unverifiable and the verdict is `NEUTRAL` unless a check that needs no run
  (C3–C8) fired above `info`. Before this, an OOM-killed run reported "Claimed
  1480 total; 0 observed" and blocked the PR for a sandbox limit. Opaque
  runners (plain `cargo test`, `make test`, a package script with no adapter)
  keep their normal exit code as C1 evidence; the 128+ rule is not applied to
  them because mocha and friends exit with the failure count.
- **A killed runner is recorded as such.** When the test process dies by
  signal, `exit_code` carries the shell's 128 + signal number instead of
  `null`, and `ObservedRun.signal` names the signal when the shell's kill
  notice identifies it (`Killed`, `Terminated`; `unknown` otherwise).
- **Package-script claims map to their resolved runner.** A claimed
  `pnpm test` / `npm test` / `yarn test` (claim family `npm`) now maps to the
  observed run when the run was started by the same invocation, whether the
  script resolved to vitest, jest, or an opaque runner — so C1 can fire on the
  most common JavaScript claim. Before, such claims were always unverifiable.
- **`ObservedRun.reportMissing`** and **`DiffAnalysis.fileCount`** (additive
  contract fields) so the reconciler can tell "the reporter never wrote" from
  "the report says zero tests ran", and "no changed files" from "only
  allow-listed paths changed".
- Test-file recognition for RSpec (`*_spec.rb` below `spec/`, `spec_helper.rb`,
  `spec/support/`), Django's `tests.py`, `_test` / `_unittest` suffixes (Deno,
  gtest, Dart, Elixir), Cypress `.cy.<script>` files, source files under `e2e/`
  and `cypress/`, .NET `*.Tests/` projects, Flutter and Android test
  directories, case-insensitive test directories (`Tests/`), and Rust inline
  `#[test]` / `#[tokio::test]`-style blocks added to a source file. `spec/`
  documents and class names such as `SpeedTest.java` or `V1PodSpec.java` are
  deliberately not tests.
- Study harness: per-container CPU and memory ceilings, memory sized from the
  Docker VM and the parallel slots (`study/lib-resources.sh`),
  `study/rerun-inconclusive.sh`, and `study/rerun-prs.sh` for specific rows.

### Changed

- A count claim on a run with no test command is reported unverifiable instead
  of silently passing as "counts match". The same applies to an opaque runner
  that enumerates no tests: nothing to compare, so nothing is "0 observed".
- **C2 subset rule.** A count claim smaller than the run — "322 tests" for one
  package while the gate ran a 5,904-test monorepo — is a subset claim and is
  reported unverifiable; the run's failures may lie outside it. The claim's
  size is its total or the sum of the parts it states; a bare failure count is
  always compared, and a claim larger than the run still fires.
- The "tests added" wordings are counted from the real extractor: a ticked
  tests-added line appears in 49 of the 140 sampled bodies.
- A raised `C8` severity now decides the verdict on a run that abstained for
  lack of evidence, like every other run-independent check.
- `study/summarize.mjs` scores only checkable claims (command, count, "tests
  added"); every other checkbox is counted as stated, not checkable, and a
  run-inconclusive PR still contributes its diff-based findings.

### Fixed

- **The published Action crashed on load.** `dist/index.js` was built with
  ncc's `--source-map`, which prepends `require('./sourcemap-register.js')`;
  that helper is gitignored, so every `uses: …@v1` run since 0.1.0 died with
  `MODULE_NOT_FOUND` before reading the pull request. The action bundle is now
  built without source maps, CI fails when the committed bundle differs from a
  fresh build or does not load on its own, and the repository's own dogfood
  workflow exercises the bundle on every pull request.

### Known limitations

- A bare `pnpm test` claim in a monorepo maps to the root run, although the
  body may have meant one package's script. Combined with the next item this
  can fail a PR for failures outside its package. Planned: scope the mapping
  by workspace.
- A suite that fails on a clean runner for reasons outside the diff (network,
  missing keys) still fails C1 when the body claims the command. Base-commit
  comparison is planned so that failures also present at the base are reported
  as environment, not as a contradiction.

## 0.1.0 — unreleased

First development release. Not published to the Marketplace; the Action entry
point is a stub, so nothing here is usable as a gate yet.

### Added

- **Receipt format `merge-evidence/receipt/v1`** — the open, MIT-licensed record
  of what a pull request claimed, what actually ran, what the diff changed around
  the tests, and the resulting verdict. Schema, field reference, and default
  verdict policy in `docs/receipt-spec.md`.
- **Agent detection** (`src/core/claims/detect.ts`) — four signal families (bot
  login, head-branch prefix, co-author trailer, body marker) across the GitHub
  Copilot coding agent, Devin, Claude Code, Cursor, Codex, and OpenCode. Every
  signal that fires is reported as `<family>:<agent>`; `detected` follows the
  precedence login > branch-prefix > coauthor-trailer > body-marker.
- **Claim extraction** (`src/core/claims/extract.ts`) — a deterministic markdown
  reader that emits one claim per assertion in a pull request body: commands,
  counts, test names, checkboxes, and caveats. Fenced code blocks and HTML
  comments are skipped. Phrases that cannot be parsed confidently are dropped
  rather than guessed at.
- **Test-command detection and reporter injection**
  (`src/core/runners/detect.ts`) — resolves how a repository runs its tests from
  an explicit input, `.merge-evidence.yml`, a `Makefile` target, `package.json`,
  `go.mod`, pytest manifests, or `Cargo.toml`, then rewrites the command so it
  emits per-test machine-readable output with retries and result caching
  disabled. Returns `null` — the gate abstains — when nothing indicates how to
  run tests.
- **Runner adapters** (`src/core/runners/adapters/`) — `go test -json`, Jest and
  Vitest JSON, and JUnit XML (pytest and cargo-nextest), normalized into one
  sorted list of executed tests with recomputed totals.
- **`tests_digest`** (`src/core/runners/index.ts`) — `sha256:` over the sorted,
  newline-joined executed test ids, so a stranger can confirm which tests ran
  without the raw log.
- **Diff analysis** (`src/core/diff/`) — classifies changed paths into test files,
  dependency manifests, snapshots, and verification-layer edits (CI workflows,
  coverage thresholds, agent rule files, `conftest.py`, suppressed failures), and
  finds skip and focus markers on lines the pull request adds. Every output array
  is sorted and deduplicated, so the same input always produces the same
  analysis.
- **Documentation** — `README.md` (quick start, checks, supported runners,
  configuration, limitations, FAQ), `docs/checks.md`, `docs/agent-signals.md`,
  `docs/verify-a-receipt.md`, `CONTRIBUTING.md`.
- **Demo fixture** (`demo/lying-pr/`) — a six-test Node project with two pull
  requests against it, one whose claims match and one whose claims are
  contradicted by the diff, as PR bodies plus applicable patches.

### Planned for this release

Not implemented yet; `src/main.ts` is a stub.

- The reconcile step: turning claims, the observed run, and the diff analysis
  into `Discrepancy[]` and a verdict.
- Receipt emission and the sticky pull request comment.
- Action wiring: checkout, execution, artifact upload, and job status.
- Test enumeration at base and head, which is what `diff.tests.deleted` is
  computed from.

### Known limitations

- Fork pull requests receive a read-only token, so the receipt comment cannot be
  posted. The job status still gates the merge.
- Plain `cargo test` produces no per-test machine-readable output; cargo-nextest
  with a JUnit `ci` profile is required for per-test evidence.
- Jest and Vitest report absolute test file paths, so `tests_digest` depends on
  the checkout directory.
- Receipts are unsigned. Signing as an in-toto Statement with predicate type
  `https://merge-evidence.dev/receipt/v1` via `actions/attest` is planned for
  v1.1.
