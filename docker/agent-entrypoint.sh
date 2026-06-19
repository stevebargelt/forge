#!/usr/bin/env bash
# Start headless Chromium on :9222 in the background, then exec the agent
# command. browser-tools scripts (mounted at /home/agent/.claude/skills/browser-tools)
# attach via puppeteer-core. Container teardown kills Chromium.
#
# Skipped when FORGE_NO_BROWSER=1 — useful for tests of spawn() that don't
# need browser tooling.
set -eu

if [ "${FORGE_NO_BROWSER:-0}" != "1" ] && command -v chromium >/dev/null 2>&1; then
  CHROMIUM_DATA_DIR="${CHROMIUM_DATA_DIR:-$HOME/.cache/browser-tools}"
  mkdir -p "$CHROMIUM_DATA_DIR"
  # --no-sandbox: required inside a container without a sandbox-capable kernel
  # config (containers usually don't have user namespaces enabled).
  # --disable-dev-shm-usage: /dev/shm is tiny in Docker by default; Chromium
  # crashes without this on screenshot-heavy workloads.
  # --headless=new: Chromium's modern headless mode; supports CDP fully.
  chromium \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --remote-debugging-port=9222 \
    --remote-debugging-address=127.0.0.1 \
    --user-data-dir="$CHROMIUM_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    >/tmp/chromium.log 2>&1 &
fi

# Codex (AWN-7 Walk): when the RO-mounted subscription credential is present,
# copy it into a writable CODEX_HOME so `codex` can refresh tokens in-container.
# The refreshed copy dies with the container; the host ~/.codex/auth.json (the
# source of truth) is never written from here. No-op for non-codex runtimes.
if [ -f /forge-codex-auth/auth.json ]; then
  CODEX_HOME="${CODEX_HOME:-/tmp/codex-home}"
  mkdir -p "$CODEX_HOME"
  chmod 700 "$CODEX_HOME"
  cp /forge-codex-auth/auth.json "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
  export CODEX_HOME
fi

# pi (#266): same pattern for pi's OAuth credential. Copy the RO-mounted auth.json
# into a writable PI_CODING_AGENT_DIR (pi reads + refreshes its token there). The
# refreshed copy dies with the container; the host source of truth is never
# written from here. No-op for non-pi runtimes. PI_CODING_AGENT_DIR defaults here
# if the runtime didn't set it.
if [ -f /forge-pi-auth/auth.json ]; then
  PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"
  mkdir -p "$PI_CODING_AGENT_DIR"
  chmod 700 "$PI_CODING_AGENT_DIR"
  cp /forge-pi-auth/auth.json "$PI_CODING_AGENT_DIR/auth.json"
  chmod 600 "$PI_CODING_AGENT_DIR/auth.json"
  export PI_CODING_AGENT_DIR
fi

# #245: when forge mounts a container-local node_modules shadow volume (set via
# spawn.ts), Docker creates it root-owned. The agent runs as UID 1000 and must
# be able to `npm install` into it, so chown it to agent. Only touches the
# explicit shadow path, never the bind-mounted host node_modules (which has no
# FORGE_NM_SHADOW set), so host files are never written through grpcfuse.
if [ -n "${FORGE_NM_SHADOW:-}" ] && [ -d "${FORGE_NM_SHADOW}" ]; then
  sudo chown agent:agent "${FORGE_NM_SHADOW}" 2>/dev/null || true
fi

exec "$@"
