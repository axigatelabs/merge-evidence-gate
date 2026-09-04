#!/usr/bin/env bash
# Shared by run-batch.sh and rerun-inconclusive.sh: size the per-container
# memory ceiling from the Docker VM and the number of parallel slots, unless
# the caller already exported MEG_MEM.
#
#   budget_memory <parallel-slots>   → exports MEG_MEM (e.g. "3353m")
budget_memory() {
  local par="${1:-1}" vm per
  [ -n "${MEG_MEM:-}" ] && return 0
  vm="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  if [ "${vm:-0}" -gt 0 ]; then
    per=$(( (vm - 1024 * 1024 * 1024) / par / 1024 / 1024 ))
    [ "$per" -gt 5120 ] && per=5120
    [ "$per" -lt 1024 ] && per=1024
    export MEG_MEM="${per}m"
  else
    export MEG_MEM="5g"
  fi
}
