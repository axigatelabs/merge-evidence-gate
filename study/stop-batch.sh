#!/usr/bin/env bash
# Stop every batch process and sandbox container for one repository, cleanly:
# the batch scripts, their xargs, the per-PR run-one.sh instances, the
# containers, and the per-PR volumes they were using. Receipts already written
# stay; PRs that were mid-run are simply missing and picked up by
# rerun-inconclusive.sh.
#
#   study/stop-batch.sh <owner/repo>
set -uo pipefail
REPO="${1:?owner/repo}"; KEY="${REPO/\//__}"
pkill -f "run-batch.sh $REPO" 2>/dev/null && echo "stopped run-batch.sh"
pkill -f "rerun-inconclusive.sh $REPO" 2>/dev/null && echo "stopped rerun-inconclusive.sh"
pkill -f "rerun-prs.sh $REPO" 2>/dev/null && echo "stopped rerun-prs.sh"
# xargs children carry the repo in their command line through run-one.sh
pkill -f "run-one.sh $REPO" 2>/dev/null && echo "stopped run-one.sh instances"
sleep 1
ids=$(docker ps -aq --filter "name=meg-$KEY-")
[ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 && echo "removed containers"
vols=$(docker volume ls -q --filter "name=meg-work-$KEY-")
[ -n "$vols" ] && docker volume rm -f $vols >/dev/null 2>&1 && echo "removed per-PR volumes"
left=$(ps -axo command | grep -c "[r]un-one.sh $REPO")
echo "remaining run-one.sh processes: $left"
