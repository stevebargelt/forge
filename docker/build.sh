#!/usr/bin/env bash
# Build the agent-dev-worker image. Re-run after editing any build input: the
# Dockerfile or any file it COPYs (forge-test.sh, agent-entrypoint.sh). Editing
# one of those leaves the built image stale even though the Dockerfile is
# untouched; `forge doctor` flags this.
#
# Behind a corporate TLS proxy (Zscaler, etc.): set FORGE_CA_BUNDLE to a PEM file
# containing your corporate root cert(s). Defaults to ~/root.pem if present.
# The bundle is copied into the build context as corp-root.pem and trusted before
# any HTTPS call inside the image.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CA_BUNDLE="${FORGE_CA_BUNDLE:-$HOME/root.pem}"
if [[ -f "$CA_BUNDLE" ]]; then
  echo "Using corporate CA bundle: $CA_BUNDLE"
  cp "$CA_BUNDLE" "$HERE/corp-root.pem"
else
  echo "No corporate CA bundle found at $CA_BUNDLE; building without one."
  : > "$HERE/corp-root.pem"
fi

# Trap cleans up the staged cert even on failure.
trap 'rm -f "$HERE/corp-root.pem"' EXIT

# FG-543: record the build-input CONTENT digest as an image LABEL. Computed by the
# SAME function doctor recomputes at check time (src/v2/build-input-digest.ts, via
# the printer), so the two can't drift. A `--label` on the build command is applied
# to the final image config even when every layer is CACHED — so a fully-cached
# rebuild still stamps the current-inputs digest onto the new image ID, which is
# exactly what lets a cached rebuild clear a STALE flag (FG-543 AC1).
REPO_ROOT="$(cd "$HERE/.." && pwd)"
BUILD_INPUT_DIGEST="$(cd "$REPO_ROOT" && node --import tsx src/v2/print-build-input-digest.ts "$HERE")"

# Native build (#187): no --platform pin, so the image is built for the host's
# architecture (arm64 on Apple Silicon, amd64 on Linux/CI) and runs natively —
# no Rosetta tax. The amd64 pin only ever existed to satisfy the amd64-only
# Chrome-for-Testing for browser-tools; #187 repointed that at Playwright's
# arm64-capable chromium, so the pin's sole justification is gone. If you ever
# need a cross-arch image (e.g. amd64 from this Mac for a Linux server), use
# `docker buildx build --platform linux/amd64` explicitly for that one-off.
docker build --label "forge.build-inputs.digest=${BUILD_INPUT_DIGEST}" \
  -t agent-dev-worker -f "$HERE/agent-dev-worker.Dockerfile" "$HERE"
echo "Built agent-dev-worker (build-input digest ${BUILD_INPUT_DIGEST})."
