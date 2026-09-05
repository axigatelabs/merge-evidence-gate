# The Claim–Reality Gap — results

*Status: the first sample is complete — 140 pull requests from four
repositories, every receipt regenerated under Merge-Evidence Gate 0.8.0 on
2026-09-05. Numbers are produced from `study/out/` by
`node study/summarize.mjs`; the tables and the per-repository sections below
are kept in step with it.*

## What was measured

Every pull request in the sample is public and was authored by an AI coding
agent (identified by the agent's bot login, branch prefix, body markers, or
co-author trailer). Each was re-run by the Merge-Evidence Gate's offline CLI
inside a throwaway container:

1. **Clean environment.** Fresh clone at the PR's exact head commit, dependencies
   installed from the lockfile with the network on, then the container is
   sealed (`--network none`). The diff and the base run are taken against the
   commit the PR forked from (its merge base, recorded from the compare API),
   never against the base branch's later tip.
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
| Infisical/infisical | Claude Code (GitHub app) | 30 | since 2026-06-05 |

envoyproxy/envoy (Copilot, 30 PRs) was fetched and set aside: its C++/Bazel
build cannot run in the sandbox image, so every row would be inconclusive.

## Table

<!-- summarize:begin -->
| Repository | PRs | Run inconclusive | Verdicts | Checkable claims | Confirmed | Unsupported | Contradicted | Stated, not checkable | PRs flagged | Checks fired |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| BerriAI/litellm (devin:40) | 40 | 38 | FAIL:2 NEUTRAL:36 PASS:2 | 53 | 81% | 19% | 0% | 221 | 2 | C3:1 C4:1 C8:34 |
| Infisical/infisical (claude:30) | 30 | 29 | NEUTRAL:29 PASS:1 | 3 | 0% | 100% | 0% | 320 | 0 | C8:22 |
| mastra-ai/mastra (devin:40) | 40 | 0 | NEEDS_HUMAN:1 PASS:39 | 13 | 77% | 23% | 0% | 226 | 0 | C6:1 C8:31 |
| supabase/supabase (claude:30) | 30 | 1 | FAIL:2 NEUTRAL:1 PASS:27 | 13 | 46% | 46% | 8% | 5 | 1 | C1:1 C3:1 C8:8 |
| **All** | 140 | 68 | FAIL:4 NEEDS_HUMAN:1 NEUTRAL:66 PASS:69 | 82 | 72% | 27% | 1% | 772 | 3 | C1:1 C3:2 C4:1 C6:1 C8:95 |

- **Run inconclusive**: the re-run produced no per-test evidence (the sandbox killed the runner, or a toolchain is missing), so command and count claims are unsupported. Diff-based findings still count; NEUTRAL is the verdict when nothing else fired.
- **Checkable**: command and count claims, and a ticked "tests added" box — the claims a rule can confirm or contradict against the re-run or the diff.
- **Stated, not checkable**: every other checkbox and caveat. Reported so the reader sees how much of a PR body is unverifiable by construction; never scored.
- **PRs flagged**: at least one contradicted claim, or a verification-layer finding (C3/C4/C9) above info. This is the headline, not the share of green receipts.
- **Not comparable here**: 1 C1 finding(s) whose base comparison the offline harness could not take (dependency manifests changed; installs are disabled). Counted as contradicted claims, not as flagged PRs; the Action online would have compared them.
<!-- summarize:end -->

### mastra-ai/mastra — 40 Devin pull requests

Every one of the 40 re-runs executed the whole monorepo suite offline —
between 3,400 and 6,400 tests per PR, about four minutes each including a
frozen install from a warm store — and all 40 are conclusive.

What the bodies contain is the finding. Devin fills the repository's PR
template: across 40 bodies there are 226 ticked or unticked template lines and
**13 claims the gate can check** — 10 ticked "I have added tests" boxes, 2
test counts, 1 command. The 10 "tests added" boxes are all **confirmed**: each
of those PRs adds or modifies a test file. The 2 counts ("1480 tests", "322
tests") describe one package while the gate ran the whole monorepo, so they
are **unsupported**. The 1 command, `pnpm test` on #22963, failed at head with
203 failing tests and failed at the merge base with the same 203 — the
package-import and network-bound tests every mastra re-run shows — so it is
**unsupported** ("not reproduced on a clean runner"), not contradicted. The
base comparison did that work: one extra 87-second run, for the one PR whose
run failed with a command claim.

**No PR is flagged.** One PR (#20938, a refactor renaming "stored workflows"
to "dynamic workflows") is `NEEDS_HUMAN` for updating a test fixture (C6),
which is what that check is for. The same PR had been `FAIL` under 0.6.0 for
"renaming away" seven test files it merely renamed to other test paths; 0.6.1
corrected the rule, and the receipt was regenerated. The 31 scope notes (C8,
informational) are changeset files and build configs the bodies do not name.

### supabase/supabase — 30 Claude Code pull requests

supabase's root `package.json` carries only turbo tasks; the tests live in
`apps/studio`, `apps/www`, `apps/docs` and `packages/*`. Until workspace
scoping (0.4.0) every one of these PRs came back NEUTRAL with "no test command".
With it, 27 of 30 produced evidence: `apps/studio` runs of 4,900 to 6,400
tests, `apps/www` 71 to 83, `apps/docs` 171 to 186. Two of the remaining three
are honest abstentions — one PR touches only packages without a test script
(#49454), one ran a Playwright end-to-end script the sandbox cannot host
(#49198, below).

Claude Code's bodies are prose, not templates: 30 bodies hold **5 stated
template lines** and **13 checkable claims** — commands (`vitest`, `pnpm test`,
`pnpm test:studio`) and a few counts. Six are **confirmed**, six
**unsupported** (subset counts, and commands the base comparison excused: five
PRs failed 11 or 23 environment-bound tests at head that fail identically at
the merge base), one **contradicted**: `pnpm test:studio` on #49198 exited 1,
and the base comparison could not be taken because the PR changes a lockfile
and the sealed container cannot install the base's dependencies. That row is
reported as *not comparable here*; the Action, online, would have compared it.

**One PR is flagged, and it is real.** #49375 ("render Sign in with ChatGPT
unconditionally") deletes three test files — the opt-in hook's test and the
sign-in and sign-up page tests — which the compare API confirms. That is C3
doing its job: a human decides whether the deleted coverage was only about the
removed flag.

This batch also produced the study's most important correction. Under 0.6.0
four supabase PRs were `FAIL` on C3 for "deleting" test files they never
touched: the harness had compared each PR against its base branch's *tip*, not
the commit it forked from, and a two-dot diff showed the base branch's later
additions as the PR's deletions. 0.6.0 diffs against the merge base — recorded
from the compare API for every PR in the sample; 27 of 170 differed from the
base tip — and marks a diff without one *unreliable* so no change-based check
reads it. Every receipt in this document was regenerated after that fix. One
more PR (#49692) introduced four failures that pass at base and claimed
nothing; C9 (0.6.0) now reports that shape on its own.

### BerriAI/litellm — 40 Devin pull requests

litellm's own test command is `make test`, and that target installs
dependencies from the network before it runs pytest. In the sealed container
it exits before producing any per-test evidence, so 38 of 40 rows are
**run-inconclusive** for a reason that is the sandbox's, not the repository's
or the agent's; online, the Action runs that target as written. (The full
unit suite also needs a system library the sandbox image lacks, `libsndfile`,
so a direct `pytest tests/test_litellm` aborts at collection.) Two pull
requests name a concrete command in their body — `uv run pytest
tests/test_litellm/…` — and the gate ran exactly those: #39467, 61 tests
passing, its "61 passed" **confirmed**; #39687, 141 tests passing.

The diff-based checks need no run, and here they carry the batch. Every
litellm body ticks the template line "I have added meaningful tests" (39 of
40); each of those ticks is **confirmed** by a test file the diff adds or
modifies. Two pull requests are **flagged**, and both are real: #39695 edits a
CI workflow (`.github/workflows/test-terraform-modules.yml`, C4), and #39717
adds a `pytest.skip(` to a test file (C3). Both are exactly the edits a
reviewer wants pointed at. Under 0.6.x, before "before/after" sections were
recognised, #39467 had also carried two C2 findings — one from a count in a
"Before (sha)" section that describes the bug, one from a count that belongs
to a second command — and 0.8.0 removed both.

### Infisical/infisical — 30 Claude Code pull requests

Infisical is two projects side by side, `backend/` and `frontend/`, each with
its own lockfile. 23 of the 30 pull requests touch only `frontend/`, which has
no test scripts at all; for those the gate has nothing to run and says so
(**NEUTRAL**, "no test command"). Seven touch `backend/`, whose `test` script
is npm's placeholder while the real suite is `test:unit` — a shape the gate
learned to follow in 0.7.0, with the package's own dependencies installed in
0.7.1. One of the seven ran end to end: #7904, 1,520 backend unit tests, one
failure that also fails at the merge base and is excused. The other six could
not install `backend/`'s dependencies in this sandbox — its lockfile carries no
arm64 build of one optional package, and another needs a native `odbc` build
the image cannot do — so they are **run-inconclusive** here and would run on
GitHub's x64 runners. No Infisical pull request is flagged.

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
- **A sealed sandbox is stricter than the Action.** Two harness limits show up
  as inconclusive rows and are reported as such: a repository whose own test
  command installs from the network first (litellm's `make test`), and a base
  comparison that needs the base commit's dependencies when the PR changed a
  lockfile. Online, the Action does both. Neither is counted as a pass or as a
  finding.
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
