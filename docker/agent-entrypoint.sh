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

# FG-376: worktree mode shadows one node_modules volume per workspace member
# (repo root plus every npm workspace), not just the single legacy path above.
# spawn.ts passes them as a colon-separated FORGE_NM_SHADOW_PATHS list; chown
# each one to agent for the same root-owned-volume reason as FORGE_NM_SHADOW.
if [ -n "${FORGE_NM_SHADOW_PATHS:-}" ]; then
  IFS=':' read -r -a _forge_nm_shadow_path_list <<<"${FORGE_NM_SHADOW_PATHS}"
  for _forge_nm_shadow_path in "${_forge_nm_shadow_path_list[@]}"; do
    if [ -n "${_forge_nm_shadow_path}" ] && [ -d "${_forge_nm_shadow_path}" ]; then
      sudo chown agent:agent "${_forge_nm_shadow_path}" 2>/dev/null || true
    fi
  done
  unset _forge_nm_shadow_path_list _forge_nm_shadow_path
fi

# FG-376: when spawn.ts provisions a dependency install root (worktree mode),
# install real dependencies from there before handing off to the agent so npm
# workspace linking and @forge/* aliases resolve the same way they do on the
# host. `npm ci` when a lockfile is present (matches host installs exactly and
# fails fast on a stale lockfile), `npm install` otherwise. A failed install is
# an environment problem, not a test failure: exit with the shared
# DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE (123 — must match
# src/v2/dependency-provisioning.ts) before exec, so invoke.ts/runNext.ts
# classify it as verification_environment_unavailable instead of a generic
# container crash. The install's own stderr is left un-redirected so it lands
# on the container's stderr stream for those handlers to scrape.
if [ -n "${FORGE_NM_INSTALL_ROOT:-}" ]; then
  if [ -f "${FORGE_NM_INSTALL_ROOT}/package-lock.json" ]; then
    _forge_nm_install_cmd=(npm ci)
  else
    _forge_nm_install_cmd=(npm install)
  fi
  if ! (cd "${FORGE_NM_INSTALL_ROOT}" && "${_forge_nm_install_cmd[@]}"); then
    echo "forge: dependency install failed in ${FORGE_NM_INSTALL_ROOT}" >&2
    exit 123
  fi
  unset _forge_nm_install_cmd
fi

# FG-559: prove git actually RESOLVES in the project mount before handing off.
# A linked worktree's .git is a `gitdir:` pointer into the PARENT repo's .git,
# which forge bind-mounts read-only at its own host absolute path (spawn.ts,
# planWorktreeGitMounts). The host mount-plan assertion proves the mount was
# PLANNED; this proves it RESOLVED — they fail for different reasons, and this
# is what catches a regression in a mount set nobody regenerated. Without it the
# failure is silent: every git command fails, the agent works from the file tree
# and reports success. Exit with the shared sentinel (122 — must match
# GIT_UNAVAILABLE_EXIT_CODE in src/v2/spawn.ts) so the runner classifies it as
# verification_environment_unavailable, not a generic container crash.
# The refusal is unconditional: there is no env-var bypass, because a bypass is
# exactly the silent history-blind dispatch this probe exists to prevent.
if [ -e .git ]; then
  if ! _forge_git_probe=$(git rev-parse --git-dir 2>&1); then
    echo "forge: git is unusable in $(pwd): ${_forge_git_probe}" >&2
    echo "forge: if this project is a linked git worktree, its parent .git is not mounted (FG-559)." >&2
    echo "forge: fix the mount (dispatch against the parent repo, or restore the repo the worktree points at)." >&2
    exit 122
  fi
  unset _forge_git_probe
fi

exec "$@"
