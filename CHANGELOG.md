# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The receipt format is versioned separately from the action: field names in
`merge-evidence/receipt/v1` are an API, additions are allowed in a minor version,
and renames or removals require `/v2`. See
[docs/receipt-spec.md](docs/receipt-spec.md).

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
