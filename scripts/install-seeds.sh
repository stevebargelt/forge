#!/usr/bin/env bash
# Copy seed agent and constraint files into ~/.forge/. Idempotent — uses cp -n by default.
# FORCE=1 to overwrite.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FORGE_HOME:-$HOME/.forge}"

mkdir -p "$DEST/agents" "$DEST/constraints" "$DEST/runs"

CP_FLAG="-n"
if [[ "${FORCE:-0}" == "1" ]]; then CP_FLAG="-f"; fi

echo "Installing agents into $DEST/agents/"
cp -R $CP_FLAG "$HERE/seeds/agents/." "$DEST/agents/"

echo "Installing constraints into $DEST/constraints/"
cp -R $CP_FLAG "$HERE/seeds/constraints/." "$DEST/constraints/"

echo "Done."
echo "Run 'forge status' to verify."
