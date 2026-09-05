# The checks

Every check is a deterministic rule over three inputs: the claims extracted from
the pull request body, the observed run of the test suite, and the analysis of
what the diff changed. No model reads the code, and no check has an opinion.
A check either points at a file, a test id, and a number, or it does not fire.

## Claim outcomes

Each claim the gate extracts ends in one of three states, and only one of them
counts against a pull request.

| Outcome | Meaning |
|---------|---------|
| **Confirmed** | The observed run supports the claim. |
| **Unsupported** | The gate could not check the claim — it names a runner with no machine-readable output, a command the gate did not run, or a fact the receipt does not record. Never counted against the author. |
| **Contradicted** | The observed run says something different from the claim. This is what raises a discrepancy. |

The bias is deliberate and stated in `docs/receipt-spec.md`: *unverifiable is not
failed*. A claim the extractor cannot parse is dropped rather than guessed at
(`src/core/claims/extract.ts`).

## Severities

`fail`, `needs-human`, and `info` (`Severity` in `src/core/types.ts`). The verdict
is the worst severity that fired: any `fail` → `FAIL`, any `needs-human` →
`NEEDS_HUMAN`, otherwise `PASS`. When no test command can be determined, or the
run produced no evidence at all (the runner was killed, or its reporter never
wrote — `observed.no_evidence` on the receipt), the gate abstains with `NEUTRAL`
rather than guessing: C1 and C2 have nothing to compare against and their claims
are reported as unverifiable. The checks that need no run — C3 through C8 — still
decide the verdict when one of them fires above `info`. Severities are
overridable per check in `.merge-evidence.yml`.

## Implementation status

Everything below is implemented: claim extraction (`src/core/claims/`),
test-command detection and runner normalization (`src/core/runners/`), diff
analysis (`src/core/diff/`), the reconcile rules (`src/core/reconcile/`), and
the two front-ends that run them — the Action (`src/main.ts`) and the offline
CLI (`src/cli.ts`) — over one shared pipeline (`src/pipeline.ts`). Each section
ends with a note of which sources feed it.

---

## C1 — a claimed command failed on the clean re-run

**What it catches.** The pull request says a command was run and passed. On a
clean runner the same command does not pass. A claim the gate cannot map to
what ran (a different runner family, selectors naming tests that never
executed) is reported unverifiable — never a hit; see "How it is detected".

**How it is detected.** `extractClaims` emits a `command` claim for every inline
code span whose opening matches a known test-runner invocation — `go test`,
`pytest`, `python -m pytest`, `npm test`, `npm run test`, `pnpm test`,
`yarn test`, `bun test`, `bun run test`, `cargo test`, `cargo nextest`,
`make test`, `jest`, `vitest`, `./gradlew …`, `dotnet test`, `mvn …`, or a
repo-local `scripts/test*.sh` (`COMMAND_PREFIXES` in
`src/core/claims/extract.ts`). The prefix only matches at an identifier
boundary, so `go testdata` is not a command claim. Path selectors and name
filters (`-run`, `-k`, `-t`, `--grep`, `-p`) are parsed out into
`ParsedCommand.paths` and `ParsedCommand.nameFilters`.

Separately, `detectTestCommand` (`src/core/runners/detect.ts`) resolves the
command the repository actually uses, injects a machine-readable reporter, and
the Action executes it. C1 fires when the claim maps to the executed run and
that run exited non-zero. A claim maps when its runner family, path selectors,
and name filters are covered by what ran; a package-script claim (`pnpm test`,
`npm test`, `yarn test`) maps when the run was started by the same invocation
and the script resolved to jest, vitest, or an opaque script. A claim that does not map — a different
runner family, selectors naming tests that never executed — is reported
**unverifiable**, never as C1. A non-zero exit counts even with zero tests
recorded — a jest or vitest suite that fails to load still writes its report,
and a plain `cargo test` never has per-test output — but not when the run
produced no evidence at all (killed, could not start, or the reporter never
wrote): the claim is then unverifiable.

*Implemented:* claim parsing, command detection and reporter injection, the
execution, and the comparison rule.

**Evidence recorded.** The claimed command verbatim, `observed.command` (the
command after reporter injection), and `observed.exit_code`.

**Default severity.** `fail`.

**Failure mode it prevents.** A pull request states `go test ./...` passes. It
passed on the agent's machine, where an uncommitted helper file existed. On a
clean checkout of the head SHA the package does not compile. A reviewer reading
the description has no way to tell; the gate runs it and the build failure is on
the receipt.

---

## C2 — the stated test count does not match what ran

**What it catches.** "480 tests, 0 failures" when 412 ran; "68 tests" when 1
ran; "0 failures" when 6 failed.

**How it is detected.** `extractClaims` merges adjacent `<number> <noun>` pairs
on one line into a single `count` claim, so `12 tests, 0 failures` parses as
`{ total: 12, failed: 0 }` rather than two half-claims (`COUNT_TOKEN` and
`COUNT_JOINER` in `src/core/claims/extract.ts`). Recognized nouns cover pass,
fail, error, skip, ignored, and total; a short list of adjectives is allowed
between the number and the noun so `(11 related tests)` still parses.

The comparison only runs when the claim and the run plausibly describe the same
set. A claim smaller than the run — "322 tests" for one package while the gate
ran the whole monorepo — is a subset claim: the run's totals, failures
included, say nothing about that subset, so the claim is reported unverifiable.
A claim larger than the run is compared (more tests than exist is a real
discrepancy), as is a claim of equal size, and a bare failure count with no
size of its own. With no run, or a run that produced no evidence, every count
claim is unverifiable.

The observed side comes from `normalize()` in `src/core/runners/index.ts`, which
recomputes totals from the per-test list the runner adapter produced — so the
totals on the receipt always agree with the list of tests they summarize.

*Implemented:* both sides and the comparison rule.

**Evidence recorded.** `claimed total=480`, `observed run=412`, and the per-field
comparison for whichever of passed, failed, and total the claim stated (a
skipped count is parsed and recorded, not compared).

**Default severity.** `needs-human`. A count can differ for honest reasons — a
different filter, tests skipped on the runner's platform. This is a "look at
this" signal, not a rejection.

**Failure mode it prevents.** A body that overstates the run — "480 tests, 0
failures" when the suite has 412 — or reports "0 failures" for a suite that has
six on a clean runner. The subset case an agent produces most often — it ran the
12 tests of the one package it touched and wrote "12 tests, 0 failures" — is
deliberately *not* a C2 hit: the whole-suite run says nothing about those 12,
so the claim is reported unverifiable, and the three failures elsewhere in the
suite reach the receipt through C1 when the body also names the command.

---

## C3 — tests deleted, renamed away, skipped, or focused

**What it catches.** The cheapest way to turn a red suite green: remove the test,
skip it, or focus a different one.

**How it is detected.** Three independent sources.

1. **Test files added, modified, deleted, or renamed.** `analyzeDiff`
   (`src/core/diff/analyze.ts`) classifies each changed path with `isTestFile`
   (`src/core/diff/classify.ts`): `*_test.go`, `test_*.py` / `*_test.py` /
   Django's `tests.py`, `conftest.py`, `*.test.*` / `*.spec.*`, Cypress
   `*.cy.<script>`, `_test` / `_unittest` suffixes for Deno, gtest, Dart and
   Elixir, RSpec's `*_spec.rb` (below `spec/`) with `spec_helper.rb` /
   `rails_helper.rb` and `spec/support/`, `spec/factories/`; anything under a
   `test/`, `tests/`, `__tests__/`, `testdata/`, Flutter `integration_test/` /
   `test_driver/`, Android `androidTest/`, or .NET `*.Tests/` directory
   (case-insensitive, so `Tests/` counts); and source files under `e2e/` or
   `cypress/`. Class-per-file names (`SpeedTest.java`) and `spec/` documents
   are deliberately not tests on their own. A Rust source file whose patch adds
   `#[test]` or `#[cfg(test)]` counts as a test edit. `spec/` directories and
   `*Spec.java` names are deliberately not tests — OpenAPI documents and
   product classes live there. A rename counts as touching a test when *either*
   endpoint is a test path, so `a_test.go → b.go` is caught.

2. **Individual test cases that disappeared.** `diff.tests.deleted` on the
   receipt also carries the set difference between the tests enumerated at base
   and at head (`ObservedRun.enumeratedAtBase` / `enumeratedAtHead` in
   `src/core/types.ts`) — runner enumeration, not a regex over the patch. This is
   how a test deleted from inside a surviving file would be found. The
   reconciler and the receipt implement it; the pipeline does not yet enumerate
   tests at both commits, so today this source is empty and a test removed
   from inside a surviving file is reported only through the file-level and
   marker rules.

3. **Skip and focus markers added by this diff.** `findSkipMarkers` and
   `findFocusMarkers` (`src/core/diff/markers.ts`) read only the `+` lines of the
   patch, so a marker that already existed at base is never reported as new.

   Skip markers: `@pytest.mark.skip`, `@pytest.mark.xfail`, `pytest.skip(`,
   `t.Skip(`, `t.Skipf(`, `it.skip(`, `test.skip(`, `describe.skip(`, `xit(`,
   `xdescribe(`, `xtest(`, `#[ignore]`, `@Ignore`, `@Disabled`.

   Focus markers: `it.only(`, `test.only(`, `describe.only(`, `fit(`,
   `fdescribe(`, `--only`.

   Every pattern is anchored on an identifier boundary, so `process.exit(` is not
   read as `xit(` and `benefit(` is not read as `fit(`. Hits are deduplicated per
   (file, marker) pair.

*Implemented:* sources 1 and 3, and the reconciliation of source 2.
*Planned:* the pipeline step that enumerates tests at both commits to feed
source 2.

**Evidence recorded.** For markers: the file path and the marker string verbatim
(`test/cart.test.js`, `it.only(`). For deleted files: the path. For a test id
that vanished: `<id> enumerated at base, absent at head` — the receipt's
`pr.base_sha` and `pr.head_sha` say which commits.

**Default severity.** `fail`.

**Failure mode it prevents.** A change makes `applyDiscount` clamp instead of
throw. The test asserting the throw now fails. The test is removed in the same
commit and `it.only(` lands on an unrelated test, so the suite reports one green
test. See `demo/lying-pr/` for exactly this diff.

---

## C4 — the verification layer was edited

**What it catches.** Changes to the machinery that decides whether a pull request
is green, rather than to the code being reviewed.

**How it is detected.** `verificationLayerReason(path, patch)` in
`src/core/diff/classify.ts` returns one of five stable reason strings, checked
most-specific first:

| Reason | Fires on |
|--------|----------|
| `CI failure suppressed` | An **added** line matching `continue-on-error: true`, `\|\| true`, `--no-verify`, `set +e`, or `allow_failure`. Checked on every file, not just workflows — a `\|\| true` in a shell script counts. |
| `CI workflow edited` | Any path matching `.github/workflows/<file>`, including nested checkouts in a monorepo. |
| `coverage threshold changed` | A coverage-capable config — `pytest.ini`, `setup.cfg`, `pyproject.toml`, `.coveragerc`, `codecov.yml`, `.codecov.yml`, `jest.config.*`, `vitest.config.*` — where the patch has at least one changed line **and** one of `coverageThreshold`, `fail_under`, `--cov-fail-under`, or `thresholds` appears within the hunk. Context lines count, because a lowered threshold usually shows the token on an unchanged line three rows above the edit. |
| `agent rules edited` | `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, anything under `.cursor/rules/`, `.github/copilot-instructions.md`. |
| `test infrastructure edited` | `conftest.py` at any depth — pytest loads it as part of the run, so weakening it weakens the tests. |

The token gate on coverage config is deliberate: a `pyproject.toml` edited to add
a dependency is not a threshold change, and v1 only reports a threshold change it
can point at a line for.

*Implemented:* the whole classifier and the rule that turns its output into a
discrepancy.

**Evidence recorded.** The file path and the reason string.

**Default severity.** `fail`.

**Failure mode it prevents.** The integration job fails. Rather than fixing the
integration, the pull request adds `continue-on-error: true` to that step. Every
check on the pull request is now green and the job that was protecting the branch
is inert.

---

## C5 — a dependency or lockfile changed without being mentioned

**What it catches.** New or upgraded dependencies that arrive silently in a pull
request about something else.

**How it is detected.** `isDependencyFile` (`src/core/diff/classify.ts`) matches
on basename: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
`bun.lockb`, `bun.lock`, `go.mod`, `go.sum`, `pyproject.toml`, `poetry.lock`,
`uv.lock`, `Cargo.toml`, `Cargo.lock`, `packages.lock.json`, plus
`requirements*.txt`, `Pipfile*`, `Gemfile*`, and any `*.csproj`. The check fires
when one of those changed and the pull request body never names it.

*Implemented:* the classifier and the mention-matching rule.

**Evidence recorded.** The dependency file paths that changed, and the fact that
the body did not name them.

**Default severity.** `needs-human`. A dependency change is often exactly the
point of the pull request; the finding is that it was not disclosed, and a human
decides whether that matters.

**Failure mode it prevents.** A pull request described as a one-line bug fix also
adds a runtime dependency, because that was the fastest way to make a helper
function work. The dependency is now in production and nobody reviewed it. The
demo fixture does this with `decimal.js`.

---

## C6 — snapshots or golden files were updated

**What it catches.** Re-recording the expected output instead of fixing the
behavior. `jest -u` and `go test -update` make a failing assertion pass by
changing what "correct" means.

**How it is detected.** `isSnapshotFile` (`src/core/diff/classify.ts`): any
`*.snap` or `*.golden` file anywhere in the tree, anything under `testdata/`, and
anything under a `fixtures/` directory **that sits inside a test tree**. A bare
`src/fixtures/` is product data, not evidence, and is not counted.

*Implemented:* the classifier and the rule.

**Evidence recorded.** The snapshot and golden file paths that changed.

**Default severity.** `needs-human`. Snapshot updates are routine and often
correct; the point is that a human sees the new expected output.

**Failure mode it prevents.** A refactor changes a rendered component's markup in
a way that is actually a regression. The snapshot test fails; the snapshot is
regenerated; the test passes again and asserts the regression.

---

## C7 — the description says tests were added; the diff touches no test file

**What it catches.** A ticked checklist item asserting that tests were added —
"I have added tests that prove my fix is effective or that my feature works",
"I have added meaningful tests" — on a pull request whose diff adds, modifies,
or renames no test file. Across 140 public agent PR bodies fetched for the
Claim–Reality Gap study, one of those two lines is ticked in 49; it is the most
common substantive claim an agent PR body makes.

**How it is detected.** A checked `checkbox` claim whose label matches a narrow
verb-based pattern — "added/wrote/created … tests", "tests were added" — is
compared with `analyzeDiff`'s `testFiles`: any added, modified, or renamed test
file satisfies it (Rust source files that gain an inline `#[test]` count too).
Deleting tests does not. The pattern never matches the sibling template line
"New and existing unit tests pass", compound nouns such as "added a test plan
section", negations ("no tests added"), or hedges ("if applicable", "in a
follow-up"). A diff with no changed files at all — an empty PR, or a base
commit that could not be compared — gives the check nothing to look at, so the
claim is reported as unverifiable rather than confirmed or contradicted.

**Evidence recorded.** The claim's label, the three test-file counts, and the
number of changed files.

**Known limit.** With a shallow checkout the diff falls back to a two-dot
comparison against the base branch tip, and test files changed on the base
branch since the fork point can satisfy the check for a PR that added none. The
README's `fetch-depth: 0` avoids this.

*Implemented:* both sides and the rule.

**Default severity.** `needs-human`. The claim may be honest in a repository
whose test files the classifier does not recognise; a reviewer settles that in
seconds with the file list in front of them.

**Failure mode it prevents.** A template checkbox ticked by habit — the agent
fills the whole checklist, including "I have added tests", on a change that
touched only source. The reviewer reads the checklist as a summary and merges
untested code believing it was tested.

---

## C8 — the diff reaches outside what the pull request describes

**What it catches.** Files changed that the description never mentions —
opportunistic reformatting, an unrelated fix, a config tweak.

**How it is detected.** `analyzeDiff` collects `sourceFiles`: every changed path
that is not a test file, not a dependency file, not a snapshot file, and not
covered by a `scope-allow` glob from `.merge-evidence.yml` (matched with
`minimatch`, `dot: true`). Those paths are compared against the paths named in
the pull request body.

*Implemented:* the source-file collection, scope-allow filtering, and the
body-mention comparison.

**Evidence recorded.** The unmentioned source paths.

**Default severity.** `info`. It appears on the receipt and never blocks a merge
unless a repository raises it in `.merge-evidence.yml`.

**Failure mode it prevents.** A pull request titled "fix null check in parser"
also rewrites the logging module, because the agent noticed something on the way
past. The rewrite gets the review attention of a null check.
