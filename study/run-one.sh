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

# Persistent package caches shared by every run (named Docker volumes): the
# second PR from the same repository reuses the store instead of downloading
# thousands of packages again. Longer fetch timeouts + retries absorb slow
# registry responses. Phase 2 (network off) can still read the caches.
CACHE_ARGS=(
  -v meg-pnpm-store:/caches/pnpm -e npm_config_store_dir=/caches/pnpm
  -v meg-npm-cache:/caches/npm   -e npm_config_cache=/caches/npm
  -v meg-uv-cache:/caches/uv     -e UV_CACHE_DIR=/caches/uv -e PIP_CACHE_DIR=/caches/uv/pip
  -v meg-go-cache:/caches/go     -e GOMODCACHE=/caches/go/mod -e GOCACHE=/caches/go/build
  # corepack downloads the package manager version pinned in package.json
  # (`packageManager`); phase 2 runs offline, so that download must persist.
  -v meg-corepack:/caches/corepack -e COREPACK_HOME=/caches/corepack
  -e npm_config_fetch_timeout=180000 -e npm_config_fetch_retries=5 -e npm_config_fetch_retry_maxtimeout=120000
)

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
[ -d "$WORK/repo" ] && { docker run --rm -v "$WORK:/work" "$IMG" bash -c 'rm -rf /work/repo' >/dev/null 2>&1 || rm -rf "$WORK/repo"; }
# Named volumes are created root-owned; the sandbox runs as `node` (uid 1000).
docker run --rm --user root "${CACHE_ARGS[@]}" "$IMG" bash -c 'mkdir -p /caches/pnpm /caches/npm /caches/uv /caches/go /caches/corepack && chown -R 1000:1000 /caches' >/dev/null 2>&1 || true
docker run --rm --name "meg-$KEY-$NUM-p1" "${CACHE_ARGS[@]}" \
  -v "$WORK:/work" -v "$GATE:/gate:ro" "$IMG" bash -lc "
    set -e
    git clone -q --no-checkout --filter=blob:none https://github.com/$REPO.git /work/repo
    cd /work/repo
    git fetch -q --depth=1 origin $HEAD && git fetch -q --depth=1 origin $BASE
    git checkout -q $HEAD
    timeout $TIMEOUT node /gate/dist/cli/index.js --install-only --work /work/repo --head $HEAD --base $BASE --out /work/install.json || echo 'install phase ended non-zero (recorded)'
  " > "$WORK/phase1.log" 2>&1 || { echo "[$KEY#$NUM] phase 1 failed — see $WORK/phase1.log" >&2; exit 1; }

echo "[$KEY#$NUM] phase 2: clean re-run, network off" >&2
# PR facts travel as environment variables and are expanded by the container's
# own shell (single-quoted script): titles and branch names can contain quotes.
docker run --rm --network none --name "meg-$KEY-$NUM-p2" \
  -e MEG_REPO="$REPO" -e MEG_NUM="$NUM" -e MEG_HEAD="$HEAD" -e MEG_BASE="$BASE" \
  -e MEG_AUTHOR="$AUTHOR" -e MEG_HREF="$HREF" -e MEG_BREF="$BREF" -e MEG_TITLE="$TITLE" \
  -e MEG_TEST_CMD="$TEST_CMD" -e MEG_TIMEOUT="$TIMEOUT" "${CACHE_ARGS[@]}" \
  -v "$WORK:/work" -v "$GATE:/gate:ro" "$IMG" bash -lc '
    cd /work/repo
    extra=(); [ -n "$MEG_TEST_CMD" ] && extra=(--test-command "$MEG_TEST_CMD")
    timeout "$MEG_TIMEOUT" node /gate/dist/cli/index.js --skip-install --work /work/repo \
      --repo "$MEG_REPO" --pr "$MEG_NUM" --head "$MEG_HEAD" --base "$MEG_BASE" --author "$MEG_AUTHOR" \
      --head-ref "$MEG_HREF" --base-ref "$MEG_BREF" --title "$MEG_TITLE" \
      --body-file /work/body.md --commits-file /work/commits.txt --agents-only false \
      "${extra[@]}" --out /work/receipt.json --markdown /work/receipt.md
  ' > "$WORK/phase2.log" 2>&1 || true

if [ -f "$WORK/receipt.json" ]; then
  cp "$WORK/receipt.json" "$OUT/$NUM.json"; cp "$WORK/receipt.json.meta.json" "$OUT/$NUM.meta.json" 2>/dev/null || true
  cp "$WORK/receipt.md" "$OUT/$NUM.md" 2>/dev/null || true
  tail -1 "$WORK/phase2.log" | sed "s/^/[$KEY#$NUM] /" >&2
  # Reclaim disk (node_modules can be 300k files). Deleting through the
  # container is far faster than a host-side rm over the bind mount on macOS.
  docker run --rm -v "$WORK:/work" "$IMG" bash -c 'rm -rf /work/repo' >/dev/null 2>&1 || rm -rf "$WORK/repo"
else
  echo "[$KEY#$NUM] NO RECEIPT — harness error, see $WORK/phase2.log" >&2; exit 1
fi
