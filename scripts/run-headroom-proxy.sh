#!/usr/bin/env bash
# run-headroom-proxy.sh
#
# Headroom proxy background service for forge compression.
# Starts the Rust headroom-proxy on localhost:8787 with native Bedrock support.
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
#   HEADROOM_BIN_DIR    — Directory containing headroom-proxy binary (default: ~/.forge/bin)
#   HEADROOM_PORT       — Port to listen on (default: 8787)
#   HEADROOM_VENV       — Fallback Python venv path (default: ~/.forge/headroom-env)
#   BEDROCK_REGION      — AWS region for Bedrock (default: us-east-1)

set -euo pipefail

HEADROOM_BIN_DIR="${HEADROOM_BIN_DIR:-$HOME/.forge/bin}"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"
HEADROOM_VENV="${HEADROOM_VENV:-$HOME/.forge/headroom-env}"
BEDROCK_REGION="${BEDROCK_REGION:-us-east-1}"
PID_FILE="${TMPDIR:-/tmp}/headroom-proxy.pid"
LOG_FILE="${HEADROOM_LOG_FILE:-$HOME/.forge/logs/headroom-proxy.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Write PID for stop/status commands
echo $$ > "$PID_FILE"

RUST_BINARY="$HEADROOM_BIN_DIR/headroom-proxy"

if [[ -x "$RUST_BINARY" ]]; then
  echo "[headroom] Starting Rust proxy (PID $$) — port=${HEADROOM_PORT} region=${BEDROCK_REGION}"
  echo "[headroom] Binary: $RUST_BINARY"
  echo "[headroom] Logs: $LOG_FILE"

  exec "$RUST_BINARY" \
      --listen "127.0.0.1:${HEADROOM_PORT}" \
      --upstream "http://127.0.0.1:8788" \
      --bedrock-region "$BEDROCK_REGION" \
      --enable-bedrock-native=true \
      >> "$LOG_FILE" 2>&1
else
  # Fallback to Python proxy
  echo "[headroom] Rust binary not found at $RUST_BINARY, falling back to Python proxy"
  echo "[headroom] Run 'bash scripts/install-headroom.sh install-rust-proxy' to install Rust binary"

  if [[ ! -d "$HEADROOM_VENV" ]]; then
    echo "[headroom] ERROR: venv not found at $HEADROOM_VENV" >&2
    echo "[headroom] Run: bash scripts/install-headroom.sh install" >&2
    exit 1
  fi

  source "$HEADROOM_VENV/bin/activate"

  if ! python -c "import headroom" 2>/dev/null; then
    echo "[headroom] ERROR: headroom not installed in venv" >&2
    echo "[headroom] Run: bash scripts/install-headroom.sh install" >&2
    exit 1
  fi

  echo "[headroom] Starting Python proxy (PID $$) — port=${HEADROOM_PORT} venv=${HEADROOM_VENV}"
  echo "[headroom] Logs: $LOG_FILE"

  exec headroom proxy \
      --port "$HEADROOM_PORT" \
      --host 127.0.0.1 \
      >> "$LOG_FILE" 2>&1
fi
