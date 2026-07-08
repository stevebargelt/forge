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
#   forge-test                        # unit tier (test:unit if present, else npm test)
#   forge-test --unit                 # npm run test:unit
#   forge-test --integration          # npm run test:integration
#   forge-test --worktree             # npm run test:worktree
#   forge-test --extended             # npm run test:extended (integration + worktree, slow, CI tier — FG-495)
#   forge-test --all                  # npm run test:all (canonical CI gate: unit + dashboard, fast — FG-495)
#   forge-test src/spine/foo.test.ts  # run a single test file directly with tsx
#   forge-test --test pattern         # any flags passed to tsx/node:test
#
# Tier flags are the first argument only; --test and file paths are passthroughs
# to the underlying runner (tsx/jest/vitest) and are unaffected.
#
# Exit code: forwarded from the test runner.
#
# FORGE_TEST_PRINT_CMD=1: resolve which command would run, print it to stdout,
# and exit 0 WITHOUT copying/rebuilding/running. Used by tests to verify
# selection logic without the container scratch setup.
# FORGE_SRC_DIR: override the project root checked for package.json scripts
# (default: /project). Only meaningful with FORGE_TEST_PRINT_CMD=1.

set -euo pipefail

WORK_DIR="/tmp/forge-work"
SRC_DIR="${FORGE_SRC_DIR:-/project}"

# Returns 0 if the named npm script exists in the given package.json file.
_pkg_has_script() {
  node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      process.exit((p.scripts && p.scripts[process.argv[2]]) ? 0 : 1);
    } catch(e) { process.exit(1); }
  " "$1" "$2" 2>/dev/null
}

# ── PRINT-CMD MODE ──────────────────────────────────────────────────────────
# Exit early: print the resolved command without running the scratch setup.
if [[ "${FORGE_TEST_PRINT_CMD:-}" == "1" ]]; then
  if [[ $# -eq 0 ]]; then
    if _pkg_has_script "$SRC_DIR/package.json" "test:unit"; then
      echo "npm run test:unit"
    else
      echo "npm test"
    fi
  elif [[ "$1" == "--unit" ]]; then
    echo "npm run test:unit"
  elif [[ "$1" == "--integration" ]]; then
    echo "npm run test:integration"
  elif [[ "$1" == "--worktree" ]]; then
    echo "npm run test:worktree"
  elif [[ "$1" == "--extended" ]]; then
    echo "npm run test:extended"
  elif [[ "$1" == "--all" ]]; then
    echo "npm run test:all"
  else
    echo "tsx --test $*"
  fi
  exit 0
fi

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

# Returns 0 if the named npm script exists in ./package.json (work dir).
_has_script() {
  _pkg_has_script "./package.json" "$1"
}

# ── TIER FLAGS (first arg only) ─────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  case "$1" in
    --unit|--integration|--worktree|--extended|--all)
      _npm_script="test:${1#--}"
      if ! _has_script "$_npm_script"; then
        echo "forge-test: no \"$_npm_script\" script in $WORK_DIR/package.json" >&2
        exit 2
      fi
      exec npm run "$_npm_script"
      ;;
  esac
fi

# ── NO-ARGS DEFAULT ──────────────────────────────────────────────────────────
if [[ $# -eq 0 ]]; then
  if _has_script "test:unit"; then
    exec npm run test:unit
  elif ! grep -q '"test"' package.json 2>/dev/null; then
    echo "forge-test: no \"test\" script in $WORK_DIR/package.json — this project has no test runner to invoke." >&2
    echo "forge-test: add a test script, or call \`forge-test <file.test.ts>\` to run files directly with tsx." >&2
    exit 2
  else
    exec npm test
  fi
fi

# ── FILE / PATTERN PASSTHROUGH ──────────────────────────────────────────────
# Detect the test runner from package.json.
# Priority: scripts.test pattern -> devDependencies jest/vitest -> node:test.
detect_runner() {
  if [[ ! -f ./package.json ]]; then
    echo "node:test"
    return
  fi
  node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync('./package.json', 'utf8'));
      const ts = (p.scripts && p.scripts.test) || '';
      const deps = Object.assign({}, p.dependencies || {}, p.devDependencies || {});
      if (ts.includes('jest'))        { process.stdout.write('jest'); }
      else if (ts.includes('vitest')) { process.stdout.write('vitest'); }
      else if (ts)                    { process.stdout.write('node:test'); }
      else if (deps.jest)             { process.stdout.write('jest'); }
      else if (deps.vitest)           { process.stdout.write('vitest'); }
      else                            { process.stdout.write('node:test'); }
    } catch(e) { process.stdout.write('node:test'); }
  " 2>/dev/null || echo "node:test"
}

RUNNER=$(detect_runner)

case "$RUNNER" in
  jest)
    JEST_BIN="./node_modules/.bin/jest"
    if [[ ! -x "$JEST_BIN" ]]; then
      echo "forge-test: jest detected but $JEST_BIN not found — is jest installed?" >&2
      exit 127
    fi
    echo "forge-test: detected runner: jest" >&2
    exec "$JEST_BIN" "$@"
    ;;
  vitest)
    VITEST_BIN="./node_modules/.bin/vitest"
    if [[ ! -x "$VITEST_BIN" ]]; then
      echo "forge-test: vitest detected but $VITEST_BIN not found — is vitest installed?" >&2
      exit 127
    fi
    echo "forge-test: detected runner: vitest" >&2
    exec "$VITEST_BIN" run "$@"
    ;;
  *)
    # node:test with tsx (original behavior)
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
    ;;
esac
