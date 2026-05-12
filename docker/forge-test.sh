#!/usr/bin/env bash
# forge-test — run forge's test suite inside an agent container, working
# around the better-sqlite3 native-module mismatch (#111).
#
# Why this exists: forge mounts the host project at /project. The host's
# node_modules/better-sqlite3/build/Release/better_sqlite3.node is built for
# macOS arm64; the container is Linux x86_64 (or arm64 on Apple Silicon
# hosts). Any test that imports from src/store/* triggers ERR_DLOPEN_FAILED.
#
# The fix: copy the project to /tmp/forge-work (writable, inside the
# container's overlay layer), rebuild better-sqlite3 there, and run the
# tests from /tmp/forge-work — leaving the host's node_modules untouched.
#
# Usage:
#   forge-test                      # run all tests (npm test)
#   forge-test src/spine/foo.test.ts  # run a single test file
#   forge-test --test pattern         # any flags passed to tsx/node:test
#
# Exit code: forwarded from the test runner.

set -euo pipefail

WORK_DIR="/tmp/forge-work"
SRC_DIR="/project"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "forge-test: /project not mounted; nothing to test" >&2
  exit 2
fi

# First-time setup: copy + rebuild. Idempotent — subsequent invocations
# inside the same container reuse the work dir without rebuilding.
if [[ ! -d "$WORK_DIR" ]]; then
  echo "forge-test: setting up writable scratch at $WORK_DIR" >&2
  cp -r "$SRC_DIR" "$WORK_DIR"
  cd "$WORK_DIR"
  echo "forge-test: rebuilding better-sqlite3 for this container's platform" >&2
  # --build-from-source forces a native compile rather than reusing the
  # host's prebuilt .node. The container image ships build-essential +
  # python3 so this Just Works.
  npm rebuild better-sqlite3 --build-from-source >/dev/null 2>&1
  echo "forge-test: setup complete" >&2
else
  cd "$WORK_DIR"
fi

# Forward all arguments to the test runner. Default to `npm test` when
# called with no args; otherwise pass straight through to tsx --test.
if [[ $# -eq 0 ]]; then
  exec npm test
else
  exec npx tsx --test "$@"
fi
