#!/usr/bin/env bash
# Build the agent-dev-worker image. Re-run after editing the Dockerfile.
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

# Native build (#187): no --platform pin, so the image is built for the host's
# architecture (arm64 on Apple Silicon, amd64 on Linux/CI) and runs natively —
# no Rosetta tax. The amd64 pin only ever existed to satisfy the amd64-only
# Chrome-for-Testing for browser-tools; #187 repointed that at Playwright's
# arm64-capable chromium, so the pin's sole justification is gone. If you ever
# need a cross-arch image (e.g. amd64 from this Mac for a Linux server), use
# `docker buildx build --platform linux/amd64` explicitly for that one-off.
docker build -t agent-dev-worker -f "$HERE/agent-dev-worker.Dockerfile" "$HERE"
echo "Built agent-dev-worker."
