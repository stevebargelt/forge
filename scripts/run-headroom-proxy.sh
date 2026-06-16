#!/usr/bin/env bash
# run-headroom-proxy.sh
#
# Headroom proxy background service for forge compression.
# Starts the headroom proxy server on localhost:8787 with all features enabled:
# - CacheAligner (stabilizes prefixes for KV cache hits)
# - ContentRouter (smart routing for JSON/code/text)
# - SmartCrusher (lossless compression)
# - CCR (reversible compression with retrieval)
#
# Usage:
#   bash run-headroom-proxy.sh &
#   PROXY_PID=$!
#   # ... run forge ...
#   kill "$PROXY_PID" 2>/dev/null
#
# Or use install-headroom.sh for managed start/stop:
#   bash scripts/install-headroom.sh start
#   bash scripts/install-headroom.sh stop
#
# Env vars:
#   HEADROOM_VENV  — Path to headroom Python venv (default: ~/.forge/headroom-env)
#   HEADROOM_PORT  — Port to listen on (default: 8787)

set -euo pipefail

HEADROOM_VENV="${HEADROOM_VENV:-$HOME/.forge/headroom-env}"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"
PID_FILE="${TMPDIR:-/tmp}/headroom-proxy.pid"
LOG_FILE="${HEADROOM_LOG_FILE:-$HOME/.forge/logs/headroom-proxy.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Write PID for stop/status commands
echo $$ > "$PID_FILE"

echo "[headroom] Proxy starting (PID $$) — port=${HEADROOM_PORT} venv=${HEADROOM_VENV}"
echo "[headroom] Logs: $LOG_FILE"

# Activate venv
if [[ ! -d "$HEADROOM_VENV" ]]; then
    echo "[headroom] ERROR: venv not found at $HEADROOM_VENV" >&2
    echo "[headroom] Run: bash scripts/install-headroom.sh" >&2
    exit 1
fi

source "$HEADROOM_VENV/bin/activate"

# Verify headroom is installed
if ! python -c "import headroom_ai" 2>/dev/null; then
    echo "[headroom] ERROR: headroom-ai not installed in venv" >&2
    echo "[headroom] Run: bash scripts/install-headroom.sh" >&2
    exit 1
fi

# Start proxy with all features enabled
# The Python module provides a CLI: python -m headroom_ai.proxy
echo "[headroom] Starting proxy on localhost:${HEADROOM_PORT}..."
exec python -m headroom_ai.proxy \
    --port "$HEADROOM_PORT" \
    --host 127.0.0.1 \
    --enable-cache-aligner \
    --enable-content-router \
    --enable-smart-crusher \
    --enable-ccr \
    >> "$LOG_FILE" 2>&1
