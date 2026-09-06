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
      "text": "480 tests, 0 failures",
      "parsed": { "kind": "count", "total": 480, "failed": 0 },
      "body_hash": "sha256:…"
    }
  ],
  "observed": {
    "command": "go test -json -count=1 ./...",
    "exit_code": 0,
    "toolchain": { "go": "1.25.1" },
    "totals": { "run": 412, "passed": 412, "failed": 0, "skipped": 0, "retried": 0 },
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
      "check": "C2",
      "severity": "needs-human",
      "claim": "c2",
      "summary": "Claimed 480 total; 412 observed",
      "evidence": ["claimed total=480", "observed run=412"]
    },
    {
      "check": "C3",
      "severity": "fail",
      "summary": "1 test present at base is absent at head",
      "evidence": ["pkg/node/TestPrune enumerated at base, absent at head"]
    },
    {
      "check": "C4",
      "severity": "fail",
      "summary": ".github/workflows/ci.yml edited",
      "evidence": ["CI workflow edited"]
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
| `claims[].commandRef` | For a count: the id of the command claim it follows in the same section. C2 compares it only when that command is the one the run executed. |
| `observed.claim` | Present when the run executed a command the body claimed: that claim's id. |
| `observed.command` | The exact command the gate executed, after injecting a machine-readable reporter. |
| `observed.totals.retried` | Tests invoked more than once. Non-zero means retries were on — a flaky-masking signal. |
| `observed.tests_digest` | `sha256:` over the sorted list of executed test ids. Lets a verifier confirm the set without the raw log. |
| `observed.baseline` | Present when the head run failed and the same command was run at the base commit. `sha`, `exit_code`, `totals` describe the base run; `introduced` lists head failures that pass (or do not exist) at base — the ones the pull request is answerable for; `pre_existing` counts head failures that fail at base too. Absent when the head run passed, produced no evidence, or the base run could not be taken (the receipt's notes say why). |
| `observed.no_evidence` | Present and `true` when the command ran but produced no evidence about the PR: the runner died by signal (exit 128 + signal), could not start (exit 126/127 — the toolchain is missing), or its report is missing or unparsable. Command and count claims are then unverifiable and the verdict abstains — inconclusive, not failed. A report that says the suite failed to load, or a plain `cargo test` exit code, is evidence and does not set this. |
| `observed.source` | Absent for the gate's own run. `report`: read from the repository's own test report — nothing was re-run, `exit_code` is inferred from the report's failures, `duration_s` is 0. `none`: the run was skipped by configuration; command and count claims are unverifiable. |
| `observed.report_sha256` | With `source: report`: `sha256:` over the report bytes (over the per-file digests when several were read). Binds the receipt to the exact report it judged. |
| `diff.tests.deleted` | Test ids present at base and absent at head — computed from runner enumeration, not regex. |
| `diff.sensitive_paths` | Verification-layer files touched: CI workflows, coverage config, `conftest.py`, agent rule files. |
| `diff.unreliable` | Present and `true` when no merge base was reachable and the change list is a two-dot diff against the base tip. The change-based checks did not run on it. |
| `discrepancies[]` | One entry per rule hit. `severity` ∈ `fail`, `needs-human`, `info`. |
| `verdict` | `PASS` (no fail/needs-human hits) · `NEEDS_HUMAN` · `FAIL` · `NEUTRAL` (no test command found, or the run produced no per-test evidence — the gate abstains unless a check that needs no run, C3–C8, fired above `info`). |
| `policy_version` | Version of the severity policy applied, so a receipt can be re-interpreted. |
| `signature` | Always present. `predicate_type` is the in-toto predicate type the receipt is attested under. `method` is set before signing — `attest` (a GitHub artifact attestation whose subject is this file's sha256) or `key` (a detached Ed25519 signature in `receipt.sig.json`) — and absent on an unsigned receipt. The attestation id or the signature itself never sit here: they are computed over these very bytes, so they live in the job outputs and the sidecar files. |

## Signing

Both methods sign the exact bytes of `receipt.json`; nothing is canonicalised.

**`attest`** — an in-toto v1 statement: `subject` = `[{ name: "receipt.json",
digest: { sha256 } }]`, `predicateType` = `https://merge-evidence.dev/receipt/v1`,
`predicate` = the receipt. Signed through GitHub artifact attestations with the
workflow's OIDC identity and stored with the repository; the Sigstore bundle is
also written to `receipt.sigstore.json` beside the receipt. Only the signing
certificate and the witnessed timestamps are outside the workflow's control;
the predicate is what the workflow said.

**`key`** — `receipt.sig.json`, schema `merge-evidence/signature/v1`:

| Field | Meaning |
|---|---|
| `algorithm` | `ed25519`. |
| `subject.name` / `subject.sha256` | The file signed and its sha256 (hex). |
| `signature` | Base64 of the 64-byte Ed25519 signature over the subject's bytes. |
| `public_key` | The signing key's public half, PEM. Informational: a verifier uses its own copy. |
| `key_id` | `sha256:` over the public key's SPKI DER — the name a verifier trusts. |
| `signed_at` | When it was signed (informational; not covered by the signature). |

## Verdict policy (v1 defaults)

| Check | Default severity |
|-------|------------------|
| C1 claimed command failed on the clean re-run | `fail` |
| C2 claimed count ≠ observed | `needs-human` |
| C3 tests deleted / renamed / skipped / focused | `fail` |
| C4 verification-layer edits | `fail` |
| C5 unmentioned dependency / lockfile change | `needs-human` |
| C6 snapshot / golden updates | `needs-human` |
| C7 "tests added" ticked, diff touches no test file | `needs-human` |
| C8 scope creep | `info` |
| C9 tests that pass at base fail at head | `needs-human` |

Overrides live in `.merge-evidence.yml` (see `.merge-evidence.example.yml`).

## Verifying a receipt

1. Check `pr.head_sha` matches the commit you are about to merge.
2. Re-run `observed.command` on that commit; hash the sorted executed test ids and compare to
   `observed.tests_digest`.
3. If `signature.method` is `attest`: `gh attestation verify receipt.json -R owner/name --predicate-type https://merge-evidence.dev/receipt/v1 --signer-workflow owner/name/.github/workflows/<file>.yml`. If it is `key`: `merge-evidence verify --receipt receipt.json --signature receipt.sig.json --public-key <the key you hold>`.
