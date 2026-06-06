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

# Forward all arguments to the test runner. Default to `npm test` when called
# with no args (the project's own script, which finds tsx on PATH — global, #299
# — when it's not in node_modules/.bin); otherwise run the given files directly.
#
# #299: the file-args path uses the `tsx` CLI binary, NOT `node --import tsx` — a
# GLOBAL tsx install is not resolvable by `node --import tsx` (global modules
# aren't on node's import path), whereas the `tsx` CLI is self-contained on PATH.
# Fail loud with a useful diagnostic if the runner genuinely isn't present.
if [[ $# -eq 0 ]]; then
  if ! grep -q '"test"' package.json 2>/dev/null; then
    echo "forge-test: no \"test\" script in $WORK_DIR/package.json — this project has no test runner to invoke." >&2
    echo "forge-test: add a test script, or call \`forge-test <file.test.ts>\` to run files directly with tsx." >&2
    exit 2
  fi
  exec npm test
fi

if ! command -v tsx >/dev/null 2>&1; then
  echo "forge-test: the 'tsx' runner is not available in this container." >&2
  echo "forge-test: rebuild the agent image (./docker/build.sh) — tsx ships in it as of #299. Do NOT 'npm i -g tsx' ad hoc." >&2
  exit 127
fi

# forge's OWN suite needs src/test-setup.ts loaded (points FORGE_HOME at a temp
# dir to isolate the real ~/.forge/forge.db, and clears FORGE_NOTIFY so the suite
# never fires real notifications — #199). Gate this on BEING THE FORGE REPO
# (package.json name == "forge") AND the file existing — src/test-setup.ts is a
# common project-local filename, so file-existence alone would wrongly preload a
# stranger's setup file and could alter its env or fail before the target test
# runs. A generic tsx project (or one with its own src/test-setup.ts) runs plain.
if [[ -f ./package.json ]] \
  && grep -Eq '"name"[[:space:]]*:[[:space:]]*"forge"[[:space:]]*,?' package.json \
  && [[ -f ./src/test-setup.ts ]]; then
  exec tsx --import ./src/test-setup.ts --test "$@"
else
  exec tsx --test "$@"
fi
