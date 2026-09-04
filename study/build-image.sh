#!/usr/bin/env bash
# Build the sandbox image used by study/run-one.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
docker build -t "${MEG_IMAGE:-merge-evidence-study:latest}" "$HERE"
