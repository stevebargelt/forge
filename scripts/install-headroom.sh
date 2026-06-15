#!/bin/bash
# Install headroom proxy for forge compression
# Run this once to set up headroom as a background service

set -e

HEADROOM_VENV="${HEADROOM_VENV:-$HOME/.forge/headroom-env}"
HEADROOM_PORT="${HEADROOM_PORT:-8787}"

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
echo "To start the proxy:"
echo "  $0 start"
echo ""
echo "To check status:"
echo "  $0 status"
