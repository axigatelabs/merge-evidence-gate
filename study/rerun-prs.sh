#!/usr/bin/env bash
# Re-run specific PRs of a repository regardless of an existing receipt — for
# regenerating conclusive rows after a reconciler change (run-batch.sh skips
# PRs that already have a receipt; rerun-inconclusive.sh only redoes rows with
# no evidence).
#
#   study/rerun-prs.sh <owner/repo> <parallel> <pr-number>...
set -euo pipefail
REPO="${1:?owner/repo}"; PAR="${2:?parallel}"; shift 2
[ "$#" -gt 0 ] || { echo "no PR numbers given" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${REPO/\//__}"; OUT="$HERE/out/$KEY"; mkdir -p "$OUT"
source "$HERE/lib-resources.sh"; budget_memory "$PAR"
echo "[$KEY] re-running $# PR(s), $PAR at a time, ${MEG_MEM} per container" >&2
export REPO HERE OUT
printf '%s\n' "$@" | xargs -P "$PAR" -I{} bash -c '
  if "$HERE/run-one.sh" "$REPO" "{}"; then :; else echo "{}" >> "$OUT/FAILED"; fi
'
echo "[$KEY] done; receipts: $(ls "$OUT"/*.meta.json 2>/dev/null | wc -l | tr -d ' ')" >&2
