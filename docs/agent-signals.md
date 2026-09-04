# Agent signals

By default the gate only runs on pull requests that look agent-authored. This
page lists exactly what "looks agent-authored" means, so you can predict whether
the gate will run before you install it — and turn the restriction off if you
want every pull request gated.

Everything here is implemented in `src/core/claims/detect.ts`. Nothing is
inferred by a model; every entry is a literal string comparison.

## The four signal families

| Family | Read from | Match |
|--------|-----------|-------|
| `login` | the pull request author's login | equality, after trimming |
| `branch-prefix` | the head branch name | prefix |
| `coauthor-trailer` | the pull request's commit messages, joined | substring |
| `body-marker` | the pull request body | substring |

All four are compared case-insensitively, because GitHub logins and branch names
are case-insensitive and trailer casing varies between agent versions
(`Co-Authored-By` and `Co-authored-by` both appear in the wild).

Each family is a hint, never proof, so **every** hit is reported. A body carrying
both a Claude Code footer and a Codex task link reports `body-marker:claude` and
`body-marker:codex`. `AgentDetection.signals` entries have the shape
`<family>:<agent>`, deduplicated.

`AgentDetection.detected` is the agent named by the strongest family that fired,
in the precedence order **login > branch-prefix > coauthor-trailer > body-marker**.
Within one family, the table order below breaks ties.

`AgentDetection.isAgent` is true when at least one signal fired. That is the
value `agents-only` gates on.

## Signals by product

### GitHub Copilot coding agent

| Family | Value |
|--------|-------|
| `login` | `copilot-swe-agent[bot]` |
| `branch-prefix` | `copilot/` |
| `body-marker` | `<!-- START COPILOT CODING AGENT` |
| `coauthor-trailer` | `Co-authored-by: Copilot` |

### Devin

| Family | Value |
|--------|-------|
| `login` | `devin-ai-integration[bot]` |
| `branch-prefix` | `devin/` |
| `body-marker` | `app.devin.ai/sessions/` |

### Claude Code

| Family | Value |
|--------|-------|
| `login` | `claude[bot]` |
| `branch-prefix` | `claude/` |
| `body-marker` | `Generated with [Claude Code]` |
| `body-marker` | `claude.ai/code/session` |
| `body-marker` | `ccr-projects-attribution` |
| `coauthor-trailer` | `Co-Authored-By: Claude` |

### Cursor

| Family | Value |
|--------|-------|
| `login` | `cursor[bot]` |
| `branch-prefix` | `cursor/` |
| `body-marker` | `cursor.com/agents/` |
| `body-marker` | `CURSOR_AGENT_PR_BODY_BEGIN` |
| `coauthor-trailer` | `Cursor Agent <cursoragent@cursor.com>` |

### Codex

| Family | Value |
|--------|-------|
| `branch-prefix` | `codex/` |
| `body-marker` | `chatgpt.com/codex/tasks/` |

Codex pull requests are opened under the human's own account, so there is no bot
login to match. If your team uses Codex through a workflow that rewrites the
branch name, add `agents-only: false` (below) rather than relying on detection.

### OpenCode

| Family | Value |
|--------|-------|
| `login` | `opencode-agent[bot]` |

## What happens when nothing fires

`isAgent` is false. With the default `agents-only: true`, the gate does no work
and the check is neutral — it neither passes nor fails on merit. The pull request
is not blocked by the gate.

## Forcing the gate on for every pull request

Two ways, both supported. The action input wins over the config file.

**Action input** (`action.yml`):

```yaml
- uses: AbhiKumawat/merge-evidence-gate@v1
  with:
    agents-only: 'false'
```

**Repository config** (`.merge-evidence.yml`):

```yaml
version: 1
agents-only: false
```

The config-file form is part of the planned policy loading; only
`test-command` is read from `.merge-evidence.yml` today. The action input is the
form to use until that lands.

With `agents-only: false` the gate runs on human pull requests too. It behaves
identically: it re-runs the suite, extracts whatever claims the body contains,
and reports what it found. Human descriptions are usually shorter, so most human
pull requests produce a receipt with few claims and no discrepancies — the
verification-layer checks (C3, C4) still apply, and they are the ones worth
having on a human pull request.

## Restricting by signal in the workflow

If you would rather decide in the workflow than in the action — for example to
skip the job entirely and save the runner minutes — gate the job with an `if:`
on the same facts:

```yaml
jobs:
  gate:
    if: >-
      github.event.pull_request.user.login == 'copilot-swe-agent[bot]' ||
      github.event.pull_request.user.login == 'claude[bot]' ||
      startsWith(github.event.pull_request.head.ref, 'codex/')
    runs-on: ubuntu-latest
```

Note the difference: an `if:` that evaluates false means the job never starts, so
the check reports as skipped. `agents-only: true` means the job starts, decides
there is nothing to verify, and reports `NEUTRAL`. If the gate is a required
check, prefer `agents-only` — a required check that never runs can block a merge
in some ruleset configurations.

## Related

- [checks.md](checks.md) — what the gate looks for once it decides to run.
- [receipt-spec.md](receipt-spec.md) — where `agent.detected` and `agent.signals`
  land in the receipt.
