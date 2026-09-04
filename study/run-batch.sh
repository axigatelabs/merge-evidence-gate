#!/usr/bin/env bash
# Run the gate over every fetched PR of one repository (skips PRs already done).
#
#   study/run-batch.sh <owner/repo> [limit] [parallel] [test-command]
#
# Receipts land in study/out/<owner>__<repo>/<N>.json (+ .meta.json, .md).
# Harness failures (no receipt) are listed in study/out/<owner>__<repo>/FAILED.
set -euo pipefail

REPO="${1:?owner/repo}"; LIMIT="${2:-40}"; PAR="${3:-3}"; TEST_CMD="${4:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${REPO/\//__}"; DATA="$HERE/data/$KEY"; OUT="$HERE/out/$KEY"; mkdir -p "$OUT"
[ -f "$DATA/prs.jsonl" ] || { echo "no data: run study/fetch-prs.sh $REPO <app> first" >&2; exit 2; }

todo=$(python3 - "$DATA/prs.jsonl" "$OUT" "$LIMIT" <<'PY'
import sys,json,os
src,out,limit=sys.argv[1],sys.argv[2],int(sys.argv[3])
nums=[json.loads(l)["number"] for l in open(src) if l.strip()]
print("\n".join(str(n) for n in nums[:limit] if not os.path.exists(f"{out}/{n}.json")))
PY
)
total=$(echo "$todo" | grep -c . || true)
echo "batch: $REPO — $total PR(s) to run, $PAR at a time" >&2
[ "$total" -gt 0 ] || exit 0

export REPO TEST_CMD HERE OUT
echo "$todo" | xargs -P "$PAR" -I{} bash -c '
  if "$HERE/run-one.sh" "$REPO" "{}" "$TEST_CMD"; then :; else echo "{}" >> "$OUT/FAILED"; fi
'
echo "batch done: $(ls "$OUT"/*.json 2>/dev/null | grep -vc meta) receipts, $(wc -l < "$OUT/FAILED" 2>/dev/null || echo 0) harness failures" >&2
