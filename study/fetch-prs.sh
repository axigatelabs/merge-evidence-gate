#!/usr/bin/env bash
# Fetch public agent pull requests for the Claim–Reality Gap study.
#
#   study/fetch-prs.sh <owner/repo> <agent-app-slug> [limit] [since-date]
#   e.g. study/fetch-prs.sh mastra-ai/mastra devin-ai-integration 40 2026-06-05
#
# Read-only: uses the GitHub search + pulls APIs through `gh`. Writes
#   study/data/<owner>__<repo>/prs.jsonl        one record per PR
#   study/data/<owner>__<repo>/<N>.body.md      the PR description
#   study/data/<owner>__<repo>/<N>.commits.txt  commit messages (co-author trailers)
# Nothing is posted, commented, or modified anywhere.
set -euo pipefail

REPO="${1:?owner/repo}"; APP="${2:?agent app slug, e.g. devin-ai-integration}"
LIMIT="${3:-40}"; SINCE="${4:-2026-06-05}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/data/${REPO/\//__}"; mkdir -p "$OUT"
: > "$OUT/prs.jsonl"

echo "search: is:pr repo:$REPO author:app/$APP created:>$SINCE (limit $LIMIT)" >&2
# One page (max 100) is plenty for a batch; `--paginate` + `head` under pipefail
# closed the pipe early and yielded an empty list on the first run.
PAGE=$(( LIMIT < 100 ? LIMIT : 100 ))
numbers=$(gh api -X GET search/issues \
  -f q="is:pr repo:$REPO author:app/$APP created:>$SINCE" \
  -f sort=created -f order=desc -f per_page="$PAGE" \
  -q '.items[].number')

n=0
for num in $numbers; do
  pr=$(gh api "repos/$REPO/pulls/$num" -q '{number: .number, title: .title, author: .user.login, head_sha: .head.sha, base_sha: .base.sha, head_ref: .head.ref, base_ref: .base.ref, state: .state, merged: .merged, created_at: .created_at, changed_files: .changed_files}') || { echo "skip #$num (pulls api)" >&2; continue; }
  # `base.sha` is the base branch's tip, which may be ahead of the commit the
  # PR forked from; a two-dot diff against it shows upstream additions as the
  # PR's deletions. The merge base is the commit the change is really against.
  mb=$(gh api "repos/$REPO/compare/$(echo "$pr" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["base_sha"]+"..."+d["head_sha"])')" -q '.merge_base_commit.sha' 2>/dev/null || true)
  pr=$(echo "$pr" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["merge_base_sha"]=sys.argv[1] if len(sys.argv[1])==40 else d["base_sha"];print(json.dumps(d,sort_keys=True))' "$mb")
  gh api "repos/$REPO/pulls/$num" -q '.body // ""' > "$OUT/$num.body.md"
  gh api "repos/$REPO/pulls/$num/commits" -q '.[].commit.message' | awk 'NR>1{print ""} {print}' > "$OUT/$num.commits.txt" || true
  echo "$pr" >> "$OUT/prs.jsonl"
  n=$((n+1)); printf '  #%s %s\n' "$num" "$(echo "$pr" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["head_sha"][:7], d["title"][:60])')" >&2
  sleep 0.3
done
echo "fetched $n PRs -> $OUT/prs.jsonl" >&2
