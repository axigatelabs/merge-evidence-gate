# Merge-Evidence Receipt — `merge-evidence/receipt/v1`

The receipt is the product's atom: a machine-readable record of **what an agent claimed**, **what
actually ran**, **what the PR changed around the tests**, and **the resulting verdict** — shaped so a
stranger can verify it later without trusting the tool that produced it.

The format is open (MIT). Field names are an API: additions are allowed in minor versions; renames
and removals require a new major (`/v2`).

## Design rules

- **Deterministic.** Every discrepancy is produced by a rule with concrete evidence (test ids, file
  paths, counts) — never by an LLM opinion.
- **Bound to a SHA.** The receipt names the exact `head_sha` that was executed. A receipt for a
  different commit is a different receipt.
- **Hashes, not raw text.** The PR body is recorded as a hash; the executed test set as a digest.
  Public attestations land in a public transparency log, so the receipt must be safe to publish.
- **Unverifiable ≠ failed.** A claim the extractor cannot parse or map is recorded as
  `unverifiable`, never counted against the author.

## Schema

```json
{
  "schema": "merge-evidence/receipt/v1",
  "generatedAt": "2026-09-04T18:22:31Z",
  "pr": {
    "repo": "owner/name",
    "number": 341,
    "head_sha": "3f2a1c9…",
    "base_sha": "9b0e7d2…",
    "author": "copilot-swe-agent[bot]"
  },
  "agent": { "detected": "copilot", "signals": ["login", "branch-prefix", "body-marker"] },
  "claims": [
    {
      "id": "c1",
      "kind": "command",
      "text": "`go test ./...`",
      "parsed": { "kind": "command", "runner": "go", "raw": "go test ./...", "paths": ["./..."], "nameFilters": [] },
      "section": "Test plan",
      "body_hash": "sha256:…"
    },
    {
      "id": "c2",
      "kind": "count",
      "text": "68 tests, 0 failures",
      "parsed": { "kind": "count", "total": 68, "failed": 0 },
      "body_hash": "sha256:…"
    }
  ],
  "observed": {
    "command": "go test -json -count=1 ./...",
    "exit_code": 0,
    "toolchain": { "go": "1.25.1" },
    "totals": { "run": 412, "passed": 412, "failed": 0, "skipped": 3, "retried": 0 },
    "tests_digest": "sha256:…",
    "duration_s": 118
  },
  "diff": {
    "tests": { "added": [], "deleted": ["pkg/node/TestPrune"], "skipped_added": [], "focused": [] },
    "sensitive_paths": [".github/workflows/ci.yml"],
    "lockfiles": ["go.sum"],
    "snapshots": []
  },
  "discrepancies": [
    {
      "check": "C3",
      "severity": "fail",
      "summary": "TestPrune was deleted in this PR",
      "evidence": ["pkg/node/TestPrune present at base 9b0e7d2, absent at head 3f2a1c9"]
    },
    {
      "check": "C2",
      "severity": "needs-human",
      "claim": "c2",
      "summary": "Claimed 68 tests; 412 ran",
      "evidence": ["claimed total=68", "observed run=412"]
    }
  ],
  "verdict": "FAIL",
  "policy_version": "1.0.0",
  "signature": { "predicate_type": "https://merge-evidence.dev/receipt/v1" }
}
```

## Field reference

| Field | Meaning |
|-------|---------|
| `pr.head_sha` | The commit that was checked out and executed. The receipt is meaningless for any other commit. |
| `agent.signals` | Which agent signals fired: `login` (bot account), `branch-prefix` (`copilot/`, `devin/`, `cursor/`, `claude/`, `codex/`), `body-marker` (vendor HTML markers / footers), `coauthor-trailer` (`Co-Authored-By: Claude|Copilot|Cursor Agent`). |
| `claims[]` | Every parseable claim from the PR body, in order. `kind` ∈ `command`, `count`, `test`, `checkbox`, `caveat`. |
| `claims[].body_hash` | `sha256:` of the full PR body at evaluation time, so a later edit to the body is detectable. |
| `observed.command` | The exact command the gate executed, after injecting a machine-readable reporter. |
| `observed.totals.retried` | Tests invoked more than once. Non-zero means retries were on — a flaky-masking signal. |
| `observed.tests_digest` | `sha256:` over the sorted list of executed test ids. Lets a verifier confirm the set without the raw log. |
| `diff.tests.deleted` | Test ids present at base and absent at head — computed from runner enumeration, not regex. |
| `diff.sensitive_paths` | Verification-layer files touched: CI workflows, coverage config, `conftest.py`, agent rule files. |
| `discrepancies[]` | One entry per rule hit. `severity` ∈ `fail`, `needs-human`, `info`. |
| `verdict` | `PASS` (no fail/needs-human hits) · `NEEDS_HUMAN` · `FAIL` · `NEUTRAL` (no test command found — the gate abstains). |
| `policy_version` | Version of the severity policy applied, so a receipt can be re-interpreted. |
| `signature` | Present when the receipt was attested (`actions/attest`, in-toto v1 statement). `attestation_id` links to the Sigstore/GitHub record. |

## Verdict policy (v1 defaults)

| Check | Default severity |
|-------|------------------|
| C1 claimed command never ran / failed | `fail` |
| C2 claimed count ≠ observed | `needs-human` |
| C3 tests deleted / renamed / skipped / focused | `fail` |
| C4 verification-layer edits | `fail` |
| C5 unmentioned dependency / lockfile change | `needs-human` |
| C6 snapshot / golden updates | `needs-human` |
| C8 scope creep | `info` |

Overrides live in `.merge-evidence.yml` (see `.merge-evidence.example.yml`).

## Verifying a receipt

1. Check `pr.head_sha` matches the commit you are about to merge.
2. Re-run `observed.command` on that commit; hash the sorted executed test ids and compare to
   `observed.tests_digest`.
3. If `signature.attestation_id` is present: `gh attestation verify receipt.json -R owner/name --predicate-type https://merge-evidence.dev/receipt/v1`.
