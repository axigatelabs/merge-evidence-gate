# Merge-Evidence Gate

**Did the agent actually do what it says it did?**

AI coding agents open pull requests that *say* "tests pass". In a 12,000-run
study, 75.8% of failing agent runs still reported success (arXiv 2606.09863) —
the Claim–Reality Gap. Every review tool today reads the diff and gives an
opinion. None of them run the pull request and check the description against
what actually happens.

The Merge-Evidence Gate is a GitHub Action that:

1. **Re-runs the pull request in a clean environment** — the runner is ephemeral,
   the checkout is the exact head SHA, the install is lockfile-frozen, retries and
   result caching are off.
2. **Reads what the description claims** — the commands, counts, test names, and
   checkboxes in the pull request body.
3. **Compares claims to what actually happened** — using the test runner's own
   machine-readable output (`go test -json`, pytest JUnit, Jest/Vitest JSON,
   cargo-nextest JUnit).
4. **Checks the verification layer** — tests deleted, skipped, or focused; CI
   workflows or coverage thresholds edited; lockfiles changed without a word;
   snapshots quietly updated.
5. **Posts a one-screen receipt** on the pull request and sets a check that can be
   **required before merge**.

No model judges the code. Every finding is deterministic and comes with evidence
you can re-run yourself.

## Quick start

### 1. Add the workflow

```yaml
# .github/workflows/merge-evidence.yml
name: merge-evidence
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0            # the gate compares head against base
      # set up your toolchain here (actions/setup-node, setup-go, setup-python …)
      - uses: AbhiKumawat/merge-evidence-gate@v1
        with:
          # optional — auto-detected from your repo when omitted
          test-command: 'go test ./...'
```

`fetch-depth: 0` matters: the gate needs the base commit to compare test sets and
classify the diff.

### 2. Make it a required check

Branch protection is what turns the receipt from a comment into a gate. In the
GitHub UI:

**Repository → Settings → Rules → Rulesets → New ruleset → New branch ruleset**

- **Name**: `merge-evidence`
- **Enforcement status**: Active
- **Target branches** → *Add target* → *Include default branch*
- **Rules** → check **Require status checks to pass**
- Under it, **Add checks** → type `gate` → select it (it appears in the list once
  the workflow has run at least once on any pull request)
- Optionally check **Require branches to be up to date before merging**
- **Create**

The check name is the **job** name in your workflow — `gate` in the snippet
above. If you rename the job, add the new name here.

Agent pull requests can now no longer merge on a claim alone.

## How it works

1. **Detect.** Decide whether this pull request looks agent-authored — bot login,
   branch prefix, body marker, or co-author trailer
   (`src/core/claims/detect.ts`; the full table is in
   [docs/agent-signals.md](docs/agent-signals.md)). With the default
   `agents-only: true`, a pull request with no signal is left alone and the
   verdict is `NEUTRAL`.
2. **Extract.** Read the pull request body as markdown and emit one claim per
   assertion it makes: commands, counts, test names, checkboxes, and caveats
   (`src/core/claims/extract.ts`). Fenced code blocks and HTML comments are
   skipped — pasted tool output is not a statement by the author.
3. **Run.** Resolve the repository's own test command, inject a machine-readable
   reporter, disable retries and caching, and execute it at the head SHA
   (`src/core/runners/detect.ts`). Parse the reporter output into one normalized
   list of tests that actually ran (`src/core/runners/index.ts`).
4. **Analyze the diff.** Classify every changed path: test files, dependency
   manifests, snapshots, verification-layer files. Find skip and focus markers on
   lines this pull request *adds* (`src/core/diff/`).
5. **Reconcile and report.** Apply the checks below, produce a receipt, post it as
   a sticky comment, and set the job status from the verdict.

## What it checks

| ID | What it catches | Default verdict on hit |
|----|-----------------|------------------------|
| C1 | A claimed command never ran, or failed on a clean runner | **FAIL** |
| C2 | The stated test count does not match what ran | needs human |
| C3 | Tests deleted, renamed away, skipped, or `.only`-focused | **FAIL** |
| C4 | CI workflow, coverage threshold, agent-rules file, or `conftest.py` edited; failure suppressed with `\|\| true` / `continue-on-error` | **FAIL** |
| C5 | Dependency manifest or lockfile changed without being mentioned | needs human |
| C6 | Snapshot or golden files updated | needs human |
| C7 | *reserved — not assigned in v1* | — |
| C8 | Files changed outside what the description covers | info |

Each claim ends as **Confirmed**, **Unsupported**, or **Contradicted**. Only
Contradicted raises a discrepancy; a claim the gate cannot check is never counted
against the author.

Every check, its exact detection rule, the evidence it records, and the failure
mode it prevents: [docs/checks.md](docs/checks.md).

## Supported runners

The gate rewrites your test command so it emits per-test machine-readable output,
with retries and result caching off. A human-readable summary can be forged by a
`|| true`; a per-test event stream cannot be summarized away.

Every run also gets `CI=1`, `TZ=UTC`, `LANG=C.UTF-8`.

| Runner | What the gate runs | Report lands at |
|--------|--------------------|-----------------|
| Go | `go test -json -count=1 …` — the flags are inserted immediately after `go test`, and skipped if already present | `.merge-evidence/go-test.json` |
| Go behind a wrapper (`make test`, an npm script) | the wrapper unchanged, with `GOFLAGS=-json -count=1` in the environment | `.merge-evidence/go-test.json` |
| pytest | `<your command> -p no:rerunfailures -o junit_family=xunit1 --junitxml=.merge-evidence/pytest-junit.xml` | `.merge-evidence/pytest-junit.xml` |
| pytest behind a wrapper | the wrapper unchanged, with those same flags in `PYTEST_ADDOPTS` | `.merge-evidence/pytest-junit.xml` |
| Jest | `<your command> --json --outputFile=.merge-evidence/jest-results.json --ci`, plus `FORCE_COLOR=0` | `.merge-evidence/jest-results.json` |
| Vitest | `<your command> --reporter=json --outputFile=.merge-evidence/vitest-results.json`, plus `FORCE_COLOR=0` | `.merge-evidence/vitest-results.json` |
| cargo-nextest | `<your command> --profile ci`, plus `NEXTEST_PROFILE=ci` | `target/nextest/ci/junit.xml` |
| plain `cargo test` | unchanged — no per-test output exists; the receipt records a note | `.merge-evidence/cargo-test.txt` |
| anything else | unchanged; the receipt records that per-test evidence is unavailable | `.merge-evidence/test-output.txt` |

For npm and pnpm the injected flags are separated with ` --` so they reach the
underlying script; yarn and bun forward trailing arguments directly.

nextest only writes JUnit when the repository has a `ci` profile configured —
`[profile.ci.junit] path = "junit.xml"` in `.config/nextest.toml`. Without it the
gate says so on the receipt rather than reporting an empty run.

### How the command is chosen

First hit wins (`detectTestCommand` in `src/core/runners/detect.ts`):

1. the `test-command` action input;
2. `test-command:` in `.merge-evidence.yml`;
3. the `test` target in a `Makefile`;
4. `scripts.test` in `package.json` — invoked through the package manager implied
   by the lockfile present (`pnpm-lock.yaml` → `pnpm test --`, `yarn.lock` →
   `yarn test`, `bun.lockb` → `bun run test`, otherwise `npm test --`);
5. `go.mod` → `go test ./...`;
6. `pyproject.toml`, `pytest.ini`, or `setup.cfg` → `pytest`;
7. `Cargo.toml` → `cargo nextest run` when `.config/nextest.toml` exists,
   otherwise `cargo test`.

If none of those exist, the gate abstains: verdict `NEUTRAL`, no failure. It does
not guess.

## Configuration

### Action inputs

All optional. Defaults are from [`action.yml`](action.yml).

| Input | Default | What it does |
|-------|---------|--------------|
| `github-token` | `${{ github.token }}` | Token used to read the pull request and post the receipt comment. |
| `test-command` | *(empty)* | Explicit test command. Overrides every form of detection. |
| `agents-only` | `true` | Only run when the pull request looks agent-authored. `false` gates every pull request. |
| `fail-on` | `fail` | Verdict at or above which the job fails. `fail` fails only on `FAIL`; `needs-human` also fails on `NEEDS_HUMAN`. |
| `comment` | `true` | Post and update the sticky receipt comment. |
| `upload-receipt` | `true` | Upload `receipt.json` as a workflow artifact. |
| `policy-file` | `.merge-evidence.yml` | Path to the policy file. |
| `working-directory` | `.` | Directory to run the test command in. |

### Action outputs

| Output | Value |
|--------|-------|
| `verdict` | `PASS` \| `NEEDS_HUMAN` \| `FAIL` \| `NEUTRAL` |
| `receipt-path` | Path to the generated `receipt.json` |
| `discrepancies` | Number of discrepancies found |

### `.merge-evidence.yml`

Copy [`.merge-evidence.example.yml`](.merge-evidence.example.yml) to
`.merge-evidence.yml` in your repository root. Every key is optional.

```yaml
version: 1

# Explicit test command; same meaning as the action input, which wins over this.
test-command: go test ./...

# Only gate pull requests that look agent-authored (default true).
agents-only: true

# Override the severity of individual checks: fail | needs-human | info
severity:
  C2: needs-human
  C5: needs-human
  C8: info

# Paths allowed to change without being mentioned in the body (globs, minimatch).
scope-allow:
  - "docs/**"
  - "CHANGELOG.md"
```

| Key | Type | Meaning |
|-----|------|---------|
| `version` | `1` | Config format version. |
| `test-command` | string | The command to run. Read with a single-key line scan, not a YAML parser — the gate takes no YAML dependency. |
| `agents-only` | bool | Same as the action input; the input wins. |
| `severity` | map of check id → `fail` \| `needs-human` \| `info` | Raise or lower any check. Setting a check to `info` never blocks a merge. |
| `scope-allow` | list of globs | Paths excluded from the C8 scope comparison. Matched with `minimatch`, `dot: true`. |

Today only `test-command` is read from this file (`readYamlTestCommand` in
`src/core/runners/detect.ts`); loading the rest of the policy is part of the
planned Action wiring. The keys and defaults are fixed — `Policy` in
`src/core/types.ts` — so a file written now will be honored when it lands.

## Reading a receipt

The comment is the product. It fits on one screen and every line points at
something you can check.

```
Merge-Evidence Gate — FAIL  (head 3f2a1c9)
Claims vs observed
  `go test ./...`             ran ✔  412/412 pass   (claimed 68 → observed 412) ✘ count
  "tests pass locally"        unverifiable
Verification layer
  ✘ TestPrune deleted (pkg/node)     ✘ .github/workflows/ci.yml edited (unmentioned)
  ✔ lockfile frozen install OK       ✔ no skip/only markers added
Details: receipt.json (artifact) · rerun: `go test -json -count=1 ./...` · 1m58s
```

- **Line 1** — the verdict and the head SHA it applies to. A receipt is bound to
  one commit; if the pull request has been pushed to since, this receipt is about
  a different commit.
- **Claims vs observed** — one row per claim the body made. `ran ✔` means the
  claimed command was covered by the run. `unverifiable` means the gate could not
  check it, and it is not held against the author.
- **Verification layer** — findings about what the diff did *around* the tests.
  These do not depend on any claim; they fire on a pull request with an empty
  description too.
- **Details** — where the machine-readable receipt is, and the exact command to
  reproduce the run.

The full receipt (`merge-evidence/receipt/v1`) is an open format, MIT-licensed
and designed to be emitted as an in-toto Statement with predicate type
`https://merge-evidence.dev/receipt/v1`. Field reference:
[docs/receipt-spec.md](docs/receipt-spec.md).

## Verifying a receipt by hand

You should not have to trust this tool. Confirm the head SHA, re-run
`observed.command`, recompute `tests_digest` with a five-line Node script, and
compare — the whole procedure is in
[docs/verify-a-receipt.md](docs/verify-a-receipt.md).

Want to see it work on a prepared example first? [`demo/`](demo/README.md) has a
six-test project and two pull requests against it: one whose claims match, one
whose claims are contradicted by the diff. The numbers in that README come from
running the commands it lists.

## Limitations

Stated plainly, because a gate that overstates what it verifies is worse than no
gate.

- **Pull requests from forks get a read-only token.** GitHub does not give
  `pull_request` workflows write access on fork pull requests, so the gate cannot
  post the comment. The job still runs and still fails, so a required check still
  blocks the merge — you just read the result in the job log and the uploaded
  receipt instead of in a comment.
- **Unverifiable claims never fail.** A claim the extractor cannot parse, or one
  about something the receipt does not record ("I checked this manually"), is
  recorded as Unsupported and ignored in the verdict. The gate under-reports on
  purpose.
- **Plain `cargo test` has no per-test machine output.** The gate can record that
  the command ran and what it exited with, but cannot enumerate tests, so C2 and
  the test-set half of C3 do not apply. Install `cargo-nextest` and add a `ci`
  profile with JUnit enabled to get full coverage.
- **Opaque wrappers degrade.** A `make test` that shells out to Jest, Vitest, or
  cargo cannot have a reporter injected through the environment the way Go
  (`GOFLAGS`) and pytest (`PYTEST_ADDOPTS`) can. Those runs are recorded with a
  note saying per-test evidence is unavailable.
- **Jest and Vitest report absolute test file paths.** The test id, and therefore
  `tests_digest`, depends on the checkout directory. Reproducing a digest from a
  hosted runner means checking out at the same path; comparing the sorted id
  lists works regardless.
- **v1 receipts are not signed.** Signing via `actions/attest` is planned for
  v1.1. Until then a receipt's integrity comes from where you got it: a workflow
  artifact on a run you can inspect.
- **The gate re-runs your tests; it does not sandbox them.** A test suite that
  reaches the network still reaches the network. v2 plans a scrubbed-environment
  run to close that.

## Cost

One job per pull request. The gate itself is a single Node action; essentially
all of the wall-clock time is your own test suite, which for most repositories
means about five minutes on a `ubuntu-latest` runner.

Two ways to spend less:

- Leave `agents-only: true` (the default). Human pull requests start the job and
  it exits immediately with `NEUTRAL`.
- Skip the job entirely with an `if:` on the agent signals, so no runner starts
  at all — see
  [docs/agent-signals.md](docs/agent-signals.md#restricting-by-signal-in-the-workflow).
  Be aware that a skipped required check can block a merge under some rulesets;
  `agents-only` is the safer default of the two.

There is no second run: the gate reuses the same job that ran your suite, rather
than adding one.

## FAQ

**Why not just have a model review the pull request?**
Because the failure this addresses is a model reporting on its own work. In a
12,000-run study, 75.8% of failing agent runs still reported success (arXiv
2606.09863). A reviewer model reads the same description and the same diff — it
has no access to what actually happened when the code ran. The gate's entire
contribution is running the thing and recording the result.

**Why deterministic checks only?**
Three reasons. A deterministic finding can be re-run by a skeptic, which is the
whole point of a receipt. It has a stable false-positive rate you can reason
about, so it is safe to make a required check. And it costs nothing per pull
request beyond the test suite you were already running. A check that cannot point
at a file, a test id, or a number does not belong in this tool.

**What about human pull requests?**
Off by default, because most of the claim-checking machinery has nothing to read
in a two-line human description. But `agents-only: false` gates everyone, and the
verification-layer checks — C3 (tests deleted, skipped, focused) and C4 (CI or
coverage weakened) — are worth having on any pull request regardless of who wrote
it. Those checks do not depend on the description at all.

**Does it block me if my description is vague?**
No. Fewer claims means fewer things to check, not a worse verdict. The gate only
raises a discrepancy when the run *contradicts* something the description says.

**Can an agent defeat it by writing a description with no claims?**
It can avoid C1, C2, and C5 that way. C3, C4, C6, and C8 read the diff and the
run, not the description, so they still fire. And a pull request that claims
nothing is a pull request a reviewer knows to read carefully.

## Status

Under active development on the `build` branch. Not yet published to the
Marketplace.

Implemented today: agent detection, claim extraction, test-command detection and
reporter injection, the runner adapters and normalization, the tests digest, and
diff analysis (`src/core/`). Planned: the reconcile step that turns those into
discrepancies, the receipt and comment renderers, and the Action wiring —
`src/main.ts` is currently a stub.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: task branches merge into
`build`, one pull request goes from `build` to `main`, and `npm run check` passes
before every commit.

## Roadmap

- **v1.1 — signed receipts.** Emit the receipt as an in-toto Statement with
  predicate type `https://merge-evidence.dev/receipt/v1` and sign it with
  [`actions/attest`](https://github.com/actions/attest), so
  `gh attestation verify` becomes the last step of
  [docs/verify-a-receipt.md](docs/verify-a-receipt.md).
- **v2 — scrubbed-environment run.** Execute the suite with network egress and
  ambient credentials removed, so a green run cannot depend on anything outside
  the repository.
- **GitHub App.** An installable app that owns the check run directly, so the
  receipt is a first-class check with its own annotations instead of a job status
  plus a comment — and so fork pull requests get a comment too.

## License

MIT — see [LICENSE](LICENSE). The receipt format is MIT as well; implement it
anywhere.
