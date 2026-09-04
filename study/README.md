# The Claim–Reality Gap study harness

Re-runs real, public, agent-authored pull requests through the gate — offline,
in a throwaway container — and tallies how each claim held up: **Confirmed**,
**Unsupported**, or **Contradicted**. Nothing here posts, comments, or touches
any repository; it reads public data and executes code in a sandbox.

Wording rule for anything published from this data: agents have no intent, so
say *not reproduced*, *unsupported*, or *contradicted* — never "lie".

## How a PR is re-run

```
fetch-prs.sh  ──►  data/<owner>__<repo>/prs.jsonl (+ body, commit messages)
                          │
run-one.sh  phase 1 (network ON)   clone @ head sha, fetch base, frozen install
            phase 2 (network OFF)  gate CLI: claimed/detected test command with a
                                   machine-readable reporter → receipt.json
                          │
summarize.mjs ──►  the table (per repository, per agent)
```

- **Phase 1** runs `docker run` with the network on: `git clone --filter=blob:none`
  at the PR's head commit, fetch the base commit, then the gate's own
  frozen-install plan (`--install-only`).
- **Phase 2** runs `docker run --network none`: the gate CLI with
  `--skip-install --prefer-claimed-command`. Tests cannot reach the network —
  the same "clean environment" guarantee the Action gives.
- The clone lives in a per-PR Docker **volume** (`meg-work-<repo>-<n>`), so
  installs are fast and cleanup is instant; the bind-mounted `work/` directory
  carries only the PR body, commit messages, logs, and the receipt.
- Package caches persist across runs in named volumes (`meg-pnpm-store`,
  `meg-npm-cache`, `meg-uv-cache`, `meg-go-cache`, `meg-corepack`).

## Run it

```bash
# 1. build the sandbox image (once)
study/build-image.sh

# 2. build the gate CLI the sandbox mounts (dist/cli/index.js)
npm ci && npm run build

# 3. fetch public agent PRs (read-only; uses your `gh` login)
study/fetch-prs.sh mastra-ai/mastra devin-ai-integration 40
study/fetch-prs.sh supabase/supabase claude 30

# 4. re-run one PR, or a batch (2 at a time)
study/run-one.sh mastra-ai/mastra 22471
study/run-batch.sh mastra-ai/mastra 40 2

# 5. after a harness fix: redo only the inconclusive/missing rows, one at a time
study/rerun-inconclusive.sh mastra-ai/mastra

# 6. after a reconciler change: regenerate specific rows (existing receipts are
#    replaced; run-batch.sh would skip them). No test-command override here.
study/rerun-prs.sh mastra-ai/mastra 1 22963 20938

# 7. the table
node study/summarize.mjs
```

Each container is capped at `MEG_CPUS` CPUs (default 6, via `--cpuset-cpus`) and
`MEG_MEM` memory (default 5g, swap off). The CPU pin is what bounds a vitest or
jest suite's worker count — the runners size themselves from the CPUs they can
see — so a suite that would fork 18 workers on the host forks 6 in the sandbox,
without touching the repository's test command. Without the cap, two large
suites side by side exhausted the Docker VM and the kernel killed the runner
(exit 137) before it wrote its report.

Receipts land in `study/out/<owner>__<repo>/<n>.json` with a `.meta.json`
sidecar (verdict, agent signals, unverifiable claims, notes) and `.md` (the
comment as it would appear on the PR). Harness failures — no receipt at all —
are listed in `study/out/<owner>__<repo>/FAILED`.

## Reading the table

| Column | Meaning |
|---|---|
| Run inconclusive | The re-run produced no per-test evidence (the sandbox killed the runner, a toolchain is missing). Its command and count claims are unsupported, never contradicted; its diff-based findings (C3–C8) still count. |
| Verdicts | PASS / NEEDS_HUMAN / FAIL / NEUTRAL over every PR. NEUTRAL is a run-inconclusive PR on which no diff-based check fired above info. |
| Checkable claims | Claims a rule can confirm or contradict: a claimed command (C1), a stated count (C2), a ticked "tests added" box (C7). |
| Confirmed | Checkable claims the gate mapped to the run or the diff and found consistent. |
| Unsupported | Checkable claims the gate could not map. Never counted against the author. |
| Contradicted | Checkable claims a discrepancy names (a command that failed, a count that differs, a "tests added" box with no test file in the diff). |
| Stated, not checkable | Every other checkbox and caveat. Shown so the reader sees how much of a body is unverifiable by construction; never scored. |
| PRs flagged | PRs with at least one contradicted claim or a verification-layer finding (C3/C4) above info — the headline number. |
| Checks fired | C1–C8 hits across the repository. |

## Known limits

- One test command per PR: the first claimed command with a known runner, else
  the repository default. A PR that claims several commands has only the first
  verified in v1.
- Monorepo suites can be large; the harness caps each phase (`MEG_TIMEOUT`,
  default 1500 s) and each container's CPUs and memory (`MEG_CPUS`, `MEG_MEM`;
  the batch scripts size `MEG_MEM` from the Docker VM and the parallel slots
  unless it is set). A memory kill (exit 137) leaves a receipt whose
  `observed.no_evidence` is set — the claims are unverifiable, not contradicted.
  A phase timeout kills the CLI itself, so it leaves no receipt: the PR is
  listed in `FAILED` and picked up by `rerun-inconclusive.sh`.
- Toolchains in the image: Node 24 (npm, pnpm, yarn), Python 3 + uv, Go, git.
  Repositories needing others (Rust, .NET, JVM) come back inconclusive until
  the image grows.
- Everything runs as an unprivileged user inside the container, but phase 1
  executes the repository's install scripts with the network on. Run this on a
  machine you would be comfortable running unknown `npm install`s on.
