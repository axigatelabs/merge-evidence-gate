# Sandbox image for the Claim–Reality Gap study.
#
# One image runs any target repository's own test command with the gate's
# offline CLI. Phase 1 (network ON) clones + installs; phase 2 (network OFF,
# `docker run --network none`) runs the tests and produces the receipt, so the
# re-run is exactly as clean as the Action's: no network, pinned env, frozen
# install, retries off.
#
# Toolchains: Node 24 (npm/pnpm/yarn via corepack), Python 3 + uv, Go, git.
# Extend when a target repo needs more (Rust, .NET) — keep it boring.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 TZ=UTC LANG=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl build-essential pkg-config \
      python3 python3-venv python3-pip python3-dev \
      golang-go \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate \
 && pip3 install --break-system-packages --no-cache-dir uv

# Unprivileged runner; the target repo is mounted at /work, the gate at /gate.
RUN mkdir -p /work /gate && chown -R node:node /work
USER node
WORKDIR /work
