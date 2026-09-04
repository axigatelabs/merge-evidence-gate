#!/usr/bin/env bash
# Re-run ONE public agent PR inside the sandbox and produce its receipt.
#
#   study/run-one.sh <owner/repo> <pr-number> [test-command]
#
# Phase 1 (network ON):  clone the repo at the PR head, fetch the base, install
#                        dependencies with the gate's own frozen-install plan.
# Phase 2 (network OFF): run the gate CLI — the repo's own test command with a
#                        machine-readable reporter, retries off — and write the
#                        receipt. Tests cannot reach the network, exactly like
#                        the Action's clean re-run.
#
# Requires: docker, the image built from study/Dockerfile (study/build-image.sh),
# and a local build of the gate CLI at dist/cli/index.js (npm run build).
set -euo pipefail

REPO="${1:?owner/repo}"; NUM="${2:?pr number}"; TEST_CMD="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"; GATE="$(cd "$HERE/.." && pwd)"
IMG="${MEG_IMAGE:-merge-evidence-study:latest}"
KEY="${REPO/\//__}"; DATA="$HERE/data/$KEY"; OUT="$HERE/out/$KEY"; WORK="$HERE/work/$KEY/$NUM"
TIMEOUT="${MEG_TIMEOUT:-1500}"   # seconds per phase
mkdir -p "$OUT" "$WORK"

# Records are one compact JSON object per line with keys in alphabetical order
# (gh's jq sorts them), so select by parsing rather than by pattern.
rec=$(python3 - "$DATA/prs.jsonl" "$NUM" <<'PY'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if line and json.loads(line).get("number") == int(sys.argv[2]):
        print(line); break
PY
)
[ -n "$rec" ] || { echo "no record for #$NUM in $DATA/prs.jsonl" >&2; exit 2; }
field() { echo "$rec" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
HEAD=$(field head_sha); BASE=$(field base_sha); AUTHOR=$(field author); HREF=$(field head_ref); BREF=$(field base_ref); TITLE=$(field title)
cp "$DATA/$NUM.body.md" "$WORK/body.md"; cp "$DATA/$NUM.commits.txt" "$WORK/commits.txt" 2>/dev/null || : > "$WORK/commits.txt"
[ -f "$GATE/dist/cli/index.js" ] || { echo "gate CLI not built: run 'npm run build' in $GATE" >&2; exit 2; }

echo "[$KEY#$NUM] phase 1: clone @ ${HEAD:0:7} (base ${BASE:0:7}) + install" >&2
rm -rf "$WORK/repo"
docker run --rm --name "meg-$KEY-$NUM-p1" \
  -v "$WORK:/work" -v "$GATE:/gate:ro" "$IMG" bash -lc "
    set -e
    git clone -q --no-checkout --filter=blob:none https://github.com/$REPO.git /work/repo
    cd /work/repo
    git fetch -q --depth=1 origin $HEAD && git fetch -q --depth=1 origin $BASE
    git checkout -q $HEAD
    timeout $TIMEOUT node /gate/dist/cli/index.js --install-only --work /work/repo --head $HEAD --base $BASE --out /work/install.json || echo 'install phase ended non-zero (recorded)'
  " > "$WORK/phase1.log" 2>&1 || { echo "[$KEY#$NUM] phase 1 failed — see $WORK/phase1.log" >&2; exit 1; }

echo "[$KEY#$NUM] phase 2: clean re-run, network off" >&2
docker run --rm --network none --name "meg-$KEY-$NUM-p2" \
  -v "$WORK:/work" -v "$GATE:/gate:ro" "$IMG" bash -lc "
    cd /work/repo
    timeout $TIMEOUT node /gate/dist/cli/index.js --skip-install --work /work/repo \
      --repo '$REPO' --pr $NUM --head $HEAD --base $BASE --author '$AUTHOR' \
      --head-ref '$HREF' --base-ref '$BREF' --title \"\$(printf '%s' '$TITLE' | tr -d \"'\\\"\")\" \
      --body-file /work/body.md --commits-file /work/commits.txt --agents-only false \
      ${TEST_CMD:+--test-command \"$TEST_CMD\"} \
      --out /work/receipt.json --markdown /work/receipt.md
  " > "$WORK/phase2.log" 2>&1 || true

if [ -f "$WORK/receipt.json" ]; then
  cp "$WORK/receipt.json" "$OUT/$NUM.json"; cp "$WORK/receipt.json.meta.json" "$OUT/$NUM.meta.json" 2>/dev/null || true
  cp "$WORK/receipt.md" "$OUT/$NUM.md" 2>/dev/null || true
  tail -1 "$WORK/phase2.log" | sed "s/^/[$KEY#$NUM] /" >&2
  rm -rf "$WORK/repo"   # reclaim disk; logs + receipt stay
else
  echo "[$KEY#$NUM] NO RECEIPT — harness error, see $WORK/phase2.log" >&2; exit 1
fi
