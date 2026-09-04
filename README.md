# Merge-Evidence Gate

**Did the agent actually do what it says it did?**

AI coding agents open pull requests that *say* "tests pass" — and a 12,000-run study found that
**75.8% of failing agent runs still claimed success**. Every review tool today reads the diff and
gives an opinion. None of them run the PR and check the agent's story against reality.

The Merge-Evidence Gate is a GitHub Action that:

1. **Re-runs the pull request in a clean environment** — the runner is ephemeral, the checkout is
   the exact head SHA, the install is lockfile-frozen, retries are off.
2. **Reads what the agent claimed** — the commands, counts, test names, and checkboxes in the PR body.
3. **Compares claims to what actually happened** — using the test runner's own machine-readable
   output (`go test -json`, pytest JUnit, Jest/Vitest JSON, cargo-nextest JUnit).
4. **Checks the verification layer** — tests deleted, skipped, or focused; CI workflows or coverage
   thresholds edited; lockfiles changed without a word; snapshots quietly updated.
5. **Posts a one-screen receipt** on the PR and sets a check that can be **required before merge**.

No LLM judges the code. Every finding is deterministic and comes with evidence you can re-run.

## Usage

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
      # set up your toolchain here (actions/setup-node, setup-go, setup-python …)
      - uses: AbhiKumawat/merge-evidence-gate@v1
        with:
          # optional — auto-detected from your repo when omitted
          test-command: 'go test ./...'
```

Then make **`gate`** a required status check in your branch protection / ruleset, and agent PRs
can no longer merge on a claim alone.

## What the receipt looks like

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

The full machine-readable receipt (`merge-evidence/receipt/v1`) is an open format —
see [docs/receipt-spec.md](docs/receipt-spec.md).

## The checks

| ID | What it catches | Verdict on hit |
|----|-----------------|----------------|
| C1 | A command the agent claimed to run never ran, or failed | **FAIL** |
| C2 | The test count the agent stated doesn't match what ran | needs human |
| C3 | Tests deleted, renamed away, skipped, or `.only`-focused | **FAIL** |
| C4 | CI workflow, coverage threshold, or agent-rules file edited | **FAIL** |
| C5 | Lockfile / dependency manifest changed without being mentioned | needs human |
| C6 | Snapshot or golden files updated | needs human |
| C8 | Files changed outside what the PR describes | info |

## Supported test runners (v1)

Go (`go test -json`), Python (pytest, JUnit XML), Jest, Vitest, Rust (cargo-nextest JUnit),
plus any runner via a `Makefile` `test` target or explicit `test-command`.

## Status

Under active development on the `build` branch. Not yet published to the Marketplace.

## License

MIT
