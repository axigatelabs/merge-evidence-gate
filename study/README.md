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

# 4. re-run one PR, or a batch (3 at a time)
study/run-one.sh mastra-ai/mastra 22471
study/run-batch.sh mastra-ai/mastra 40 3

# 5. the table
node study/summarize.mjs
```

Receipts land in `study/out/<owner>__<repo>/<n>.json` with a `.meta.json`
sidecar (verdict, agent signals, unverifiable claims, notes) and `.md` (the
comment as it would appear on the PR). Harness failures — no receipt at all —
are listed in `study/out/<owner>__<repo>/FAILED`.

## Reading the table

| Column | Meaning |
|---|---|
| Inconclusive | The re-run produced no per-test evidence (environment, toolchain, harness). Reported, **never counted as a pass**. |
| Verdicts | PASS / NEEDS_HUMAN / FAIL over the conclusive PRs. |
| Confirmed | Claims the gate mapped to the run and found consistent. |
| Unsupported | Claims the gate could not map or check. Never counted against the author. |
| Contradicted | Claims a discrepancy names (a command that failed, a count that differs, a test that vanished). |
| Checks fired | C1–C8 hits across the repository. |

## Known limits

- One test command per PR: the first claimed command with a known runner, else
  the repository default. A PR that claims several commands has only the first
  verified in v1.
- Monorepo suites can be large; the harness caps each phase (`MEG_TIMEOUT`,
  default 1500 s). A timeout is recorded as inconclusive.
- Toolchains in the image: Node 24 (npm, pnpm, yarn), Python 3 + uv, Go, git.
  Repositories needing others (Rust, .NET, JVM) come back inconclusive until
  the image grows.
- Everything runs as an unprivileged user inside the container, but phase 1
  executes the repository's install scripts with the network on. Run this on a
  machine you would be comfortable running unknown `npm install`s on.
