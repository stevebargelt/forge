#!/usr/bin/env bash
# install-headroom.sh
#
# Multi-command script for managing the headroom compression proxy.
#
# Commands:
#   install            — Install headroom-ai in a Python venv (one-time setup)
#   install-rust-proxy — Build and install the Rust headroom-proxy binary
#   start              — Start the proxy in the background
#   stop               — Stop the running proxy
#   restart            — Stop then start
#   status             — Check if proxy is running and healthy
#
# Env vars:
#   HEADROOM_VENV     — Path to Python venv (default: ~/.forge/headroom-env)
#   HEADROOM_PORT     — Port to listen on (default: 8787)
#   HEADROOM_BIN_DIR  — Directory for Rust binary (default: ~/.forge/bin)

set -e

HEADROOM_VENV="${HEADROOM_VENV:-$HOME/.forge/headroom-env}"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"
HEADROOM_BIN_DIR="${HEADROOM_BIN_DIR:-$HOME/.forge/bin}"
PID_FILE="${TMPDIR:-/tmp}/headroom-proxy.pid"
LOG_FILE="${HEADROOM_LOG_FILE:-$HOME/.forge/logs/headroom-proxy.log}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/run-headroom-proxy.sh"

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_install_rust_proxy() {
  echo "Installing Rust headroom-proxy binary..."
  echo "  Target: $HEADROOM_BIN_DIR/headroom-proxy"

  # Ensure Rust toolchain is available
  if ! command -v cargo &>/dev/null; then
    echo "Installing Rust toolchain..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
    rustup default stable
  fi

  local repo_dir="${HEADROOM_RUST_REPO:-/tmp/headroom}"

  if [[ ! -d "$repo_dir" ]]; then
    echo "ERROR: headroom repo not found at $repo_dir" >&2
    echo "Clone or set HEADROOM_RUST_REPO to the repo path." >&2
    exit 1
  fi

  echo "Building headroom-proxy (cargo build --release)..."
  (cd "$repo_dir" && cargo build --release -p headroom-proxy)

  local binary="$repo_dir/target/release/headroom-proxy"
  if [[ ! -f "$binary" ]]; then
    echo "ERROR: build succeeded but binary not found at $binary" >&2
    exit 1
  fi

  mkdir -p "$HEADROOM_BIN_DIR"
  cp "$binary" "$HEADROOM_BIN_DIR/headroom-proxy"
  chmod +x "$HEADROOM_BIN_DIR/headroom-proxy"

  echo ""
  echo "✓ headroom-proxy installed to $HEADROOM_BIN_DIR/headroom-proxy"
  echo ""
  echo "Start the proxy:"
  echo "  $0 start"
}

cmd_install() {
  echo "Installing headroom proxy..."
  echo "  Virtual env: $HEADROOM_VENV"
  echo "  Port: $HEADROOM_PORT"

  # Create venv if needed
  if [ ! -d "$HEADROOM_VENV" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$HEADROOM_VENV"
  fi

  # Install headroom
  echo "Installing headroom-ai[all]..."
  source "$HEADROOM_VENV/bin/activate"

  # Try prebuilt wheel first (faster, avoids Rust compilation)
  if pip install --only-binary :all: "headroom-ai[all]" 2>/dev/null; then
    echo "✓ Installed headroom from prebuilt wheel"
  else
    echo "Prebuilt wheel not available, building from source..."
    echo "  (This requires Rust and may take 5-10 minutes)"

    # Ensure Rust is installed
    if ! command -v rustc &> /dev/null; then
      echo "Installing Rust..."
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
      source "$HOME/.cargo/env"
      rustup default stable
    fi

    # Install with source build
    pip install "headroom-ai[all]"
  fi

  echo ""
  echo "✓ Headroom installed successfully"
  echo ""
  echo "Start the proxy:"
  echo "  $0 start"
}

cmd_start() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Proxy already running (PID $pid)"
      return 0
    fi
    # Stale PID file
    rm -f "$PID_FILE"
  fi

  if [[ ! -d "$HEADROOM_VENV" ]]; then
    echo "ERROR: Headroom not installed. Run: $0 install" >&2
    exit 1
  fi

  echo "Starting headroom proxy on localhost:${HEADROOM_PORT}..."
  mkdir -p "$(dirname "$LOG_FILE")"

  # Start in background, redirecting to log
  bash "$RUN_SCRIPT" >> "$LOG_FILE" 2>&1 &
  local pid=$!

  # Give it a moment to start
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    echo "✓ Proxy started (PID $pid)"
    echo "  Logs: $LOG_FILE"
    echo "  Health: http://localhost:${HEADROOM_PORT}/health"
  else
    echo "ERROR: Proxy failed to start. Check logs: $LOG_FILE" >&2
    exit 1
  fi
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "Proxy not running (no PID file)"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")

  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping proxy (PID $pid)..."
    kill "$pid"
    sleep 1

    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force stopping..."
      kill -9 "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    echo "✓ Proxy stopped"
  else
    echo "Proxy not running (stale PID file)"
    rm -f "$PID_FILE"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  local running=false
  local pid=""

  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      running=true
    fi
  fi

  if [[ "$running" == "true" ]]; then
    echo "Proxy running (PID $pid)"
    echo "  Port: $HEADROOM_PORT"
    echo "  Logs: $LOG_FILE"

    # Check health endpoint
    if command -v curl &>/dev/null; then
      echo -n "  Health: "
      if health=$(curl -s -m 2 "http://localhost:${HEADROOM_PORT}/health" 2>/dev/null); then
        status=$(echo "$health" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        version=$(echo "$health" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        echo "$status${version:+ (v$version)}"
      else
        echo "unreachable"
      fi
    fi
  else
    echo "Proxy not running"
    if [[ -f "$PID_FILE" ]]; then
      echo "  (stale PID file exists)"
    fi
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

CMD="${1:-}"

case "$CMD" in
  install-rust-proxy)
    cmd_install_rust_proxy
    ;;
  install)
    cmd_install
    ;;
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  "")
    # No args: show usage
    cat <<EOF
Usage: $0 <command>

Commands:
  install            Install headroom-ai in Python venv (one-time setup)
  install-rust-proxy Build and install the Rust headroom-proxy binary
  start              Start the proxy in background
  stop               Stop the running proxy
  restart            Stop then start
  status             Check if proxy is running and healthy

Environment:
  HEADROOM_VENV       Python venv path (default: ~/.forge/headroom-env)
  HEADROOM_PORT       Port to listen on (default: 8787)
  HEADROOM_BIN_DIR    Rust binary install dir (default: ~/.forge/bin)
  HEADROOM_RUST_REPO  Path to headroom repo for Rust build (default: /tmp/headroom)

Examples:
  $0 install-rust-proxy  # Build + install Rust binary (preferred)
  $0 install             # Fallback: install Python proxy
  $0 start               # Start proxy
  $0 status              # Check if running
  $0 stop                # Stop proxy
EOF
    exit 1
    ;;
  *)
    echo "ERROR: Unknown command: $CMD" >&2
    echo "Run '$0' with no args for usage" >&2
    exit 1
    ;;
esac
