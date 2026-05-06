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

docker build -t agent-dev-worker -f "$HERE/agent-dev-worker.Dockerfile" "$HERE"
echo "Built agent-dev-worker."
