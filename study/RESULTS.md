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
   test names, checkboxes, caveats — is extracted. The ones a rule can check
   are compared with what actually ran and with what the diff changed around
   the tests.

Only **checkable** claims are scored: a command the body says was run (C1), a
test count it states (C2), and a ticked "I have added tests" box (C7 — checked
against the diff). Each ends in one of three states:

| Outcome | Meaning |
|---|---|
| **Confirmed** | The gate mapped the claim to the run or the diff and found it consistent. |
| **Unsupported** | The gate could not map or check the claim. Never counted against the author. |
| **Contradicted** | A discrepancy names the claim: a command that failed, a count that differs, a "tests added" box with no test file in the diff. |

Every other checkbox and caveat ("Documentation update", "My PR's scope is as
isolated as possible", "Bug fix") is **stated, not checkable**. It is counted so
the reader can see how much of a PR body is unverifiable by construction, and
it is never scored either way.

A pull request whose re-run produced no per-test evidence at all (the runner
was killed by the sandbox's memory ceiling, a toolchain missing from the image)
is **run-inconclusive** and is reported separately — it is never counted as a
pass, and its command and count claims are never counted as contradicted. Its
diff-based findings (deleted tests, weakened CI, a "tests added" box with no
test file) still count, because they need no run; when none fired, its verdict
is NEUTRAL.

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
| Repository | PRs | Run inconclusive | Verdicts | Checkable claims | Confirmed | Unsupported | Contradicted | Stated, not checkable | PRs flagged | Checks fired |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| mastra-ai/mastra (devin:40) | 40 | 0 | FAIL:1 PASS:39 | 13 | 77% | 15% | 8% | 226 | 1 | C1:1 C8:23 |
| **All** | 40 | 0 | FAIL:1 PASS:39 | 13 | 77% | 15% | 8% | 226 | 1 | C1:1 C8:23 |

- **Run inconclusive**: the re-run produced no per-test evidence (the sandbox killed the runner, or a toolchain is missing), so command and count claims are unsupported. Diff-based findings still count; NEUTRAL is the verdict when nothing else fired.
- **Checkable**: command and count claims, and a ticked "tests added" box — the claims a rule can confirm or contradict against the re-run or the diff.
- **Stated, not checkable**: every other checkbox and caveat. Reported so the reader sees how much of a PR body is unverifiable by construction; never scored.
- **PRs flagged**: at least one contradicted claim, or a verification-layer finding (C3/C4) above info. This is the headline, not the share of green receipts.
<!-- summarize:end -->

### mastra-ai/mastra — 40 Devin pull requests (2026-09-04)

Every one of the 40 re-runs executed the whole monorepo suite offline —
between 3,400 and 5,900 tests per PR, about four minutes each including a
frozen install from a warm store. Nothing came back inconclusive once the
sandbox's memory ceiling was set per container (the first pass lost 14 of 40
to the kernel's OOM killer; see "Reproduce").

What the bodies contain is the finding. Devin fills the repository's PR
template: across 40 bodies there are 226 ticked or unticked template lines and
**13 claims the gate can check** — 10 ticked "I have added tests" boxes, 2
test counts, 1 command. The 10 "tests added" boxes are all **confirmed**: each
of those PRs adds or modifies a test file. The 2 counts ("1480 tests", "322
tests") describe one package while the gate ran the whole monorepo, so they
are **unsupported** — deliberately, since the run's totals say nothing about
that subset.

The one **contradicted** claim, and the one flagged PR, is `pnpm test` on
#22963: the clean re-run exited 1 with 203 failing tests. Read this with the
caveat above. The same failures appear on every mastra re-run in the sample —
between 162 and 206 per run, dominated by package-import and network-dependent
tests that cannot pass with the network off — so this is "not reproduced on a
clean runner", not evidence that the claim was false. This row was produced by
0.2.0; 0.3.0 added base-commit comparison, which re-runs the command at the
base and attributes only introduced failures to the PR — the re-run of #22963
under 0.3.0 is recorded below.

No PR in the sample deleted, skipped, or focused a test, edited CI, or touched a
lockfile without saying so. The 23 scope notes (C8, informational) are
changeset files and build configs the bodies do not name.

## Reading the numbers honestly

- **"Confirmed" is a floor, not a grade.** A body that claims little
  (template checkboxes, prose) has little to contradict — most agent PR bodies
  in this sample contain **no checkable command or count at all**; the
  checklist is the whole description. The headline is the share of PRs with at
  least one contradicted claim or a failing verification-layer check (C3/C4),
  not the share of green receipts.
- **A failing suite is not, by itself, a contradiction.** Many repositories
  fail some tests on a clean runner (network-dependent tests, missing keys).
  The gate only counts a failure against a PR when the PR *claimed* the run
  passed, and — since 0.3.0 — only for failures the base commit does not show:
  the same command is re-run at base, and a test that fails at both commits is
  reported as already failing, not as a contradiction.
- **Where "Unsupported" comes from.** One shape so far, and it is deliberate:
  a count that describes one package ("1480 tests", "322 tests") while the gate
  ran the whole monorepo. The run's totals say nothing about that subset, so
  the claim is not held against the author. A bare `pnpm test` claim, by
  contrast, maps onto the root run the same invocation started — that is why
  #22963 is a C1 finding rather than an Unsupported claim.
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
