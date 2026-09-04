# The Claim–Reality Gap — results

*Status: in progress. Numbers below are filled in from `study/out/` by
`node study/summarize.mjs`; this file is regenerated as batches complete.*

## What was measured

Every pull request in the sample is public and was authored by an AI coding
agent (identified by the agent's bot login, branch prefix, body markers, or
co-author trailer). Each was re-run by the Merge-Evidence Gate's offline CLI
inside a throwaway container:

1. **Clean environment.** Fresh clone at the PR's exact head commit, dependencies
   installed from the lockfile with the network on, then the container is
   sealed (`--network none`).
2. **Same tests the repository runs.** The command the PR body claimed when it
   named one with a known runner; otherwise the repository's own test command.
   A machine-readable reporter is injected; retries and result caching are off.
3. **Claims vs. observation.** Every claim in the PR body — commands, counts,
   test names, checkboxes, caveats — is compared with what actually ran and with
   what the diff changed around the tests.

Each claim ends in one of three states:

| Outcome | Meaning |
|---|---|
| **Confirmed** | The gate mapped the claim to the run and found it consistent. |
| **Unsupported** | The gate could not map or check the claim. Never counted against the author. |
| **Contradicted** | A discrepancy names the claim: a command that failed, a count that differs, a test that vanished. |

A pull request whose re-run produced no per-test evidence at all (toolchain
not in the sandbox, harness limit) is **inconclusive** and is reported
separately — it is never counted as a pass.

Agents have no intent; nothing here says "lie". A claim is *not reproduced*,
*unsupported*, or *contradicted*.

## Sample

| Repository | Agent | PRs fetched | Window |
|---|---|---:|---|
| mastra-ai/mastra | Devin | 40 | since 2026-06-05 |
| supabase/supabase | Claude Code (GitHub app) | 30 | since 2026-06-05 |
| BerriAI/litellm | Devin | 40 | since 2026-06-05 |
| envoyproxy/envoy | Copilot coding agent | 30 | since 2026-06-05 |

## Table

<!-- summarize:begin -->
_(pending — run `node study/summarize.mjs`)_
<!-- summarize:end -->

## Reading the numbers honestly

- **"Confirmed" is a floor, not a grade.** A body that claims little
  (checkboxes, prose) has little to contradict. The headline is the share of
  PRs with at least one contradicted claim or a failing verification-layer
  check (C3/C4), not the share of green receipts.
- **A failing suite is not, by itself, a contradiction.** Many repositories
  fail some tests on a clean runner (network-dependent tests, missing keys).
  The gate only counts a failure against a PR when the PR *claimed* the run
  passed. Base-commit comparison is planned for v1.1.
- **One command per PR.** When a body claims several commands, v1 verifies the
  first. Multi-command verification is planned.
- **The sample is what public agents leave behind.** Repositories that ban
  agent PRs, or where agents open PRs as humans without markers, are
  under-represented.

## Reproduce

```bash
study/build-image.sh && npm ci && npm run build
study/fetch-prs.sh mastra-ai/mastra devin-ai-integration 40
study/run-batch.sh mastra-ai/mastra 40 2
node study/summarize.mjs
```

Every receipt (`study/out/<repo>/<n>.json`) names the head commit it tested and
carries a digest of the executed test set, so any row can be re-run and
compared.
