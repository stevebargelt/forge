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
# FG-520: the scratch is re-synced from $SRC_DIR on EVERY invocation (source in,
# deletions propagated, node_modules preserved) and its deps are validated before
# anything runs. The old copy-once guard tested the first snapshot forever, so an
# agent that edited source and re-ran got a green against stale code; and a scratch
# whose node_modules came up empty (the mount is an empty volume) failed every test
# with ERR_MODULE_NOT_FOUND: 'tsx' — an environment fault masquerading as red tests.
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
# FORGE_SRC_DIR / FORGE_WORK_DIR: override the project root and the scratch dir
# (defaults: /project, /tmp/forge-work). The container never sets them; they exist
# so the sync/repair logic can be driven against temp dirs from a host-side test.

set -euo pipefail

SRC_DIR="${FORGE_SRC_DIR:-/project}"
WORK_DIR="${FORGE_WORK_DIR:-/tmp/forge-work}"
# Sibling of the scratch, not inside it — the sync's delete pass removes anything
# in the scratch that has no source counterpart, which would include this marker.
DEPS_MARKER="${WORK_DIR%/}.deps"

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
  echo "forge-test: $SRC_DIR not mounted; nothing to test" >&2
  exit 2
fi

# ── SOURCE RE-SYNC (FG-520) ─────────────────────────────────────────────────
# Mirror SRC_DIR into WORK_DIR: copy files whose CONTENT differs, delete
# scratch paths whose source is gone, leave everything else alone. Skipped at
# every depth: node_modules (the scratch owns its own, natively built — copying
# the host's back over it is the mismatch this script exists to avoid), .git
# (history is not test input; see the cold-copy note below) and .terraform
# (hundreds of MB of provider binaries). rsync is not in the agent image, and a
# tar pipe would rewrite every file each run; node is already a hard dependency
# of this script and does the whole mirror in one process, subsecond.
_sync_sources() {
  node -e '
const fs = require("fs"), path = require("path");
const [src, dst] = process.argv.slice(1);
const SKIP = new Set(["node_modules", ".git", ".terraform"]);
let copied = 0, deleted = 0;

const clear = (p) => fs.rmSync(p, { recursive: true, force: true });

function mirror(rel) {
  const s = path.join(src, rel), d = path.join(dst, rel);
  const from = fs.readdirSync(s, { withFileTypes: true }).filter((e) => !SKIP.has(e.name));
  const keep = new Set(from.map((e) => e.name));
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name) || keep.has(e.name)) continue;
    clear(path.join(d, e.name));
    deleted++;
  }
  for (const e of from) {
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    let ds = null;
    try { ds = fs.lstatSync(dp); } catch {}
    if (e.isDirectory()) {
      if (ds && !ds.isDirectory()) clear(dp);
      if (!ds || !ds.isDirectory()) fs.mkdirSync(dp);
      mirror(path.join(rel, e.name));
    } else if (e.isSymbolicLink()) {
      if (ds) clear(dp);
      fs.symlinkSync(fs.readlinkSync(sp), dp);
      copied++;
    } else if (e.isFile()) {
      const ss = fs.statSync(sp);
      if (ds && !ds.isFile()) { clear(dp); ds = null; }
      // Content, not stat metadata: mtime is not a trustworthy change signal here.
      // A bind-mounted /project can report coarse (whole-second) or host-clock mtimes,
      // so a same-size edit can land with the mtime the scratch already has — and a
      // stat-only predicate would skip it, which is exactly the false green FG-520 kills.
      if (ds && ds.size === ss.size && fs.readFileSync(dp).equals(fs.readFileSync(sp))) {
        // Same bytes still means a stale scratch if the mode moved: chmod +x on a
        // helper or test script changes whether it RUNS, and a content-only predicate
        // would keep grading the agent against the old permissions.
        if ((ds.mode & 0o777) !== (ss.mode & 0o777)) {
          fs.chmodSync(dp, ss.mode & 0o777);
          copied++;
        }
        continue;
      }
      fs.copyFileSync(sp, dp);
      // copyFileSync into an EXISTING file keeps the old mode on it.
      fs.chmodSync(dp, ss.mode & 0o777);
      fs.utimesSync(dp, ss.atime, ss.mtime);
      copied++;
    }
  }
}
mirror(".");
process.stderr.write(`forge-test: re-synced source from ${src} — ${copied} file(s) updated, ${deleted} stale path(s) deleted\n`);
' "$SRC_DIR" "$WORK_DIR"
}

# sha1 of the files npm ci is a function of. Compared against DEPS_MARKER so a
# dependency bump in source forces a reinstall in the scratch. node, not md5sum,
# so this works unchanged when the test drives the script on a macOS host.
_deps_fingerprint() {
  node -e '
const fs = require("fs"), crypto = require("crypto");
const h = crypto.createHash("sha1");
for (const f of ["package.json", "package-lock.json"]) {
  try { h.update(fs.readFileSync(f)); } catch { h.update("absent"); }
}
process.stdout.write(h.digest("hex"));
'
}

# Returns 0 if ./package.json declares the named package as a (dev)dependency.
# The deps probes below are gated on this: a project that does not use tsx or
# better-sqlite3 must not be dragged through an install because they don't load.
_declares_dep() {
  node -e '
const fs = require("fs");
try {
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const deps = Object.assign({}, p.dependencies, p.devDependencies);
  process.exit(deps[process.argv[1]] ? 0 : 1);
} catch { process.exit(1); }
' "$1" 2>/dev/null
}

# The exact load path `npm test` takes (node --import tsx). Catches both a missing
# local tsx (ERR_MODULE_NOT_FOUND) and an esbuild whose platform binary never got
# fetched — npm's ignore-scripts default has blocked that one before.
_tsx_loads() {
  node --import tsx -e "" >/dev/null 2>&1
}

# Requiring better-sqlite3 dlopens its native binding, so this fails loudly on a
# .node built for the host's platform rather than this container's.
_sqlite_loads() {
  node -e "require('better-sqlite3')" >/dev/null 2>&1
}

# Whole-tree integrity. The tsx and better-sqlite3 probes only prove THOSE TWO load:
# a scratch with both intact but some other package missing or gutted sails past them,
# and the tests die ERR_MODULE_NOT_FOUND — the environment fault reported as red tests
# that this ticket exists to kill. `npm ls` walks the tree npm ci would produce and
# exits non-zero on anything missing or version-invalid.
#
# --all is load-bearing, not thoroughness for its own sake: plain `npm ls` validates
# only depth 0 and exits 0 with a transitive dependency deleted (measured — delete
# node_modules/bindings, a dep of better-sqlite3: `npm ls` says 0, `npm ls --all` says
# 1). Dev deps stay IN scope (no --omit=dev) because tsx, the runner itself, is one.
#
# Cost, measured on forge's healthy 67-package scratch: 0.15s, against an npm boot
# floor of 0.04s. That is inside the noise of a tier run, so it runs every invocation
# rather than being traded for a cheaper partial check.
_deps_tree_intact() {
  [[ ! -f package.json ]] || npm ls --all >/dev/null 2>&1
}

_node_modules_is_empty() {
  [[ ! -d node_modules ]] || [[ -z "$(ls -A node_modules 2>/dev/null)" ]]
}

# Every install/rebuild on the repair path runs through here. Under `set -e` a bare
# `npm ci` that fails (no network, corrupt lockfile, compile error) would kill the
# script with npm's own exit code — indistinguishable from a red test run, and the
# FATAL diagnostic below would never print. The contract is: a scratch that cannot
# be repaired exits 2 with a FATAL line, never test results. npm's stderr passes
# through untouched so the actual cause is still on screen.
_npm_or_fatal() {
  local what="$1"; shift
  local code=0
  "$@" >&2 || code=$?
  if [[ $code -ne 0 ]]; then
    echo "forge-test: FATAL: \`$*\` failed with exit $code while $what in $WORK_DIR (see npm's output above)." >&2
    echo "forge-test: this is an ENVIRONMENT failure, not a test failure — do not report it as red tests." >&2
    exit 2
  fi
}

# Every invocation: prove the scratch can actually load the deps the tests need,
# and repair it if it can't. Loud on stderr about what it is doing and why — a
# silent broken scratch is how ERR_MODULE_NOT_FOUND gets reported as failing tests.
_ensure_deps() {
  local reason=""
  if _node_modules_is_empty; then
    reason="$WORK_DIR/node_modules is missing or empty (the /project mount usually carries none)"
  elif [[ "$(_deps_fingerprint)" != "$(cat "$DEPS_MARKER" 2>/dev/null)" ]]; then
    reason="package.json/package-lock.json changed since these node_modules were installed"
  elif _declares_dep tsx && ! _tsx_loads; then
    reason="the 'tsx' runner does not load from $WORK_DIR/node_modules"
  elif ! _deps_tree_intact; then
    reason="$WORK_DIR/node_modules is incomplete — \`npm ls --all\` reports missing or invalid packages"
  fi

  if [[ -n "$reason" ]]; then
    echo "forge-test: installing deps in $WORK_DIR — $reason" >&2
    echo "forge-test: this must succeed before any test result is trustworthy; installing now (first run in a container takes a minute)" >&2
    if [[ -f package-lock.json ]]; then
      _npm_or_fatal "installing deps" npm ci
    else
      _npm_or_fatal "installing deps" npm install
    fi
    _deps_fingerprint > "$DEPS_MARKER"
    echo "forge-test: deps installed" >&2
  fi

  if _declares_dep tsx && ! _tsx_loads; then
    echo "forge-test: 'tsx' still will not load — rebuilding esbuild's platform binary (npm's ignore-scripts default blocks it)" >&2
    _npm_or_fatal "rebuilding esbuild's platform binary" npm rebuild esbuild
    if ! _tsx_loads; then
      echo "forge-test: FATAL: 'tsx' cannot load from $WORK_DIR after install + esbuild rebuild." >&2
      echo "forge-test: this is an ENVIRONMENT failure, not a test failure — do not report it as red tests." >&2
      exit 2
    fi
  fi

  if _declares_dep better-sqlite3 && ! _sqlite_loads; then
    echo "forge-test: better-sqlite3's native binding will not load — rebuilding it from source for this container" >&2
    # --build-from-source forces a native compile rather than reusing a prebuilt
    # .node from another platform. The image ships build-essential + python3.
    _npm_or_fatal "rebuilding better-sqlite3 from source" npm rebuild better-sqlite3 --build-from-source
    if ! _sqlite_loads; then
      echo "forge-test: FATAL: better-sqlite3 will not load after a from-source rebuild." >&2
      echo "forge-test: this is an ENVIRONMENT failure, not a test failure — do not report it as red tests." >&2
      exit 2
    fi
  fi

  # Last gate before the runner gets the scratch. Only after a repair: if no reason
  # fired above, the chain already proved the tree intact and re-probing would just
  # pay npm ls twice on the healthy fast path.
  if [[ -n "$reason" ]] && ! _deps_tree_intact; then
    echo "forge-test: FATAL: $WORK_DIR/node_modules is still incomplete after installing — the packages below are missing or invalid:" >&2
    npm ls --all >&2 || true
    echo "forge-test: this is an ENVIRONMENT failure, not a test failure — do not report it as red tests." >&2
    exit 2
  fi
}

if [[ ! -d "$WORK_DIR" ]]; then
  echo "forge-test: setting up writable scratch at $WORK_DIR" >&2
  mkdir -p "$WORK_DIR"
  # Once, cold: the scratch carries the source's .git, so any test whose code
  # walks up from cwd looking for one still finds it. The per-run sync skips
  # .git — nothing under test reads history, and it is the biggest dir in the tree.
  #
  # FG-559: -e, not -d. On a linked worktree .git is a `gitdir:` POINTER FILE,
  # so the old -d guard was FALSE and the scratch was silently created with no
  # git at all — on the path every agent uses to run tests. Copying the pointer
  # verbatim works because forge bind-mounts the parent .git read-only at its own
  # host absolute path, so the same absolute target resolves from the scratch.
  # (It then shares the worktree's admin dir rather than being an independent
  # copy, and that mount is read-only — fine here, since nothing under test
  # reads history or writes git state.)
  if [[ -e "$SRC_DIR/.git" ]]; then
    cp -R "$SRC_DIR/.git" "$WORK_DIR/.git"
  fi
fi

_sync_sources
cd "$WORK_DIR"
_ensure_deps

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
