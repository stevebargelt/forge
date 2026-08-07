#!/usr/bin/env bash
# fg591-falsification-smoke — the one-time OPERATOR-RUN live proof for FG-591.
#
# WHY A SCRIPT AND NOT A CI TEST. The three falsification cases intentionally
# drive the ordinary `forge new` path. That path must validate real agent
# credentials before it creates a run. CI has no such credentials by design, so
# a CI timeout proves only that the guard worked. D15 records the FG-621
# precedent: run this once on the operator host and paste its complete output
# into FG-591. It is deliberately OUTSIDE every npm tier and outside CI. Do not
# add a CI job or make it a required check.
#
# FAILS CLOSED. No node, git, tmux, usable project checkout, installed tsx, or
# usable agent credentials is a nonzero result with a diagnostic. Nothing
# skips. There is exactly one exit 0, on the final line, after all three live
# assertions pass. The runner retains child exit/never-started records and each
# tmux launch's argv, cwd, owner PID liveness, session liveness, exit record,
# and full out.log, because D15's root cause was readable only from that evidence.
#
# Usage: ./scripts/fg591-falsification-smoke.sh [--project-dir DIR]

set -euo pipefail

SELF=fg591-falsification-smoke
PROJECT_ARG=""

fatal() {
  echo "$SELF: FATAL: $*" >&2
  echo "$SELF: this script fails closed — a missing prerequisite is never a pass." >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) [ $# -ge 2 ] || fatal "--project-dir needs a value"; PROJECT_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 2 ;;
    *) fatal "unknown argument: $1 (see --help)" ;;
  esac
done

command -v node >/dev/null 2>&1 || fatal "no 'node' on PATH — the live runner is TypeScript."
command -v git >/dev/null 2>&1 || fatal "no 'git' on PATH — the disposable queue fixture is a real repository."
command -v tmux >/dev/null 2>&1 || fatal "no 'tmux' on PATH — tmux ownership transfer is case (a)'s subject."
tmux -V >/dev/null 2>&1 || fatal "tmux is not usable — the ownership-transfer proof cannot be run."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/.." && pwd -P)"
PROJECT_DIR="$(cd "${PROJECT_ARG:-$REPO_ROOT}" 2>/dev/null && pwd -P)" || fatal "project dir '${PROJECT_ARG:-$REPO_ROOT}' does not exist."
[ -d "$PROJECT_DIR/.git" ] || fatal "$PROJECT_DIR/.git is not a directory — use a real Forge checkout."
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fatal "$PROJECT_DIR is not a usable git worktree."
[ -x "$REPO_ROOT/bin/forge" ] || fatal "$REPO_ROOT/bin/forge is absent or not executable."
[ -d "$REPO_ROOT/node_modules/tsx" ] || fatal "$REPO_ROOT/node_modules/tsx is absent — install this checkout's declared dependencies first."

# This is the same production preflight `forge new` executes. Calling it here
# does not bypass or stub it; it makes the D15 failure immediate and actionable
# instead of letting every leg wait for a run row that authentication forbids.
(
  cd "$REPO_ROOT"
  node --import tsx --input-type=module -e 'import { validateCredsForNewRun } from "./src/util/creds.js"; validateCredsForNewRun();'
) || fatal "agent credentials are unavailable — run 'forge auth login' (or repair the selected provider) and retry on the operator host."

echo "==> FG-591 operator-run falsification: cases (a), (b), and (c)"
echo "==> project: $PROJECT_DIR"
echo "==> runner:  src/queue/fg591-falsification-smoke-runner.ts"

cd "$REPO_ROOT"
node --import tsx --test src/queue/fg591-falsification-smoke-runner.ts

echo "==> PASS: all three FG-591 live falsification cases passed. Paste this complete output into FG-591."
exit 0
