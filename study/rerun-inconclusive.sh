#!/usr/bin/env bash
# Re-run every PR of a repository whose receipt is INCONCLUSIVE for the run (no
# per-test evidence) or missing, one at a time by default. Used after a harness
# fix — the first mastra batch lost 12 of 31 runs to the Linux OOM killer
# (exit 137) because two unbounded vitest suites shared one Docker VM.
#
#   study/rerun-inconclusive.sh <owner/repo> [parallel=1] [test-command]
#
# Harness failures (no receipt) are appended to study/out/<owner>__<repo>/FAILED,
# exactly as run-batch.sh does.
set -euo pipefail
REPO="${1:?owner/repo}"; PAR="${2:-1}"; TEST_CMD="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${REPO/\//__}"; DATA="$HERE/data/$KEY"; OUT="$HERE/out/$KEY"
[ -f "$DATA/prs.jsonl" ] || { echo "no data for $REPO — run study/fetch-prs.sh first" >&2; exit 2; }
mkdir -p "$OUT" "$HERE/work"
source "$HERE/lib-resources.sh"; budget_memory "$PAR"

python3 - "$DATA/prs.jsonl" "$OUT" <<'PY' > "$HERE/work/$KEY.rerun.txt"
import json, os, sys
data, out = sys.argv[1], sys.argv[2]
for line in open(data):
    line = line.strip()
    if not line: continue
    n = json.loads(line)["number"]
    path = os.path.join(out, f"{n}.json")
    if not os.path.exists(path):
        print(n); continue
    try:
        r = json.load(open(path)); o = r.get("observed", {})
    except Exception:
        print(n); continue
    # The receipt says so (observed.no_evidence, v0.2+); older receipts: zero
    # tests and a kill signal (exit 128+) mean the runner died before reporting.
    inconclusive = o.get("no_evidence") is True or o.get("no_test_command") is True or \
        (o.get("no_evidence") is None and o.get("totals", {}).get("run", 0) == 0 and o.get("exit_code", 0) >= 128)
    if inconclusive: print(n)
PY
COUNT=$(wc -l < "$HERE/work/$KEY.rerun.txt" | tr -d ' ')
echo "[$KEY] re-running $COUNT inconclusive/missing PR(s), $PAR at a time, ${MEG_MEM} per container" >&2
[ "$COUNT" -gt 0 ] || exit 0

export REPO TEST_CMD HERE OUT
xargs -P "$PAR" -I{} bash -c '
  if "$HERE/run-one.sh" "$REPO" "{}" "$TEST_CMD"; then :; else echo "{}" >> "$OUT/FAILED"; fi
' < "$HERE/work/$KEY.rerun.txt"
echo "[$KEY] rerun done; receipts: $(ls "$OUT"/*.meta.json 2>/dev/null | wc -l | tr -d ' '), harness failures: $(wc -l < "$OUT/FAILED" 2>/dev/null || echo 0)" >&2
