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
#   forge-test --unit src/a.test.ts   # NARROW the unit tier to those files (same for
#                                     # --integration / --worktree)
#   forge-test src/spine/foo.test.ts  # run a single test file directly with tsx
#   forge-test --test pattern         # any flags passed to tsx/node:test
#
# A tier flag is the first argument only. Paths AFTER one narrow that tier's run to
# exactly those files, with the tier's own runner (preloads included) — and only if
# every path is a member of that tier's own file set. Such a path may be relative to
# the project root or absolute under either the source checkout or the scratch; all
# three name the same file. A non-member path, any other flag, or a tier whose file
# set this script cannot reproduce is REFUSED with a diagnostic. FG-695: a tier flag
# used to discard its remaining arguments silently and run the whole tier, so an
# agent that asked for one integration file got all of them and reported the result
# as evidence for the narrow run it thought it made.
# `--extended` and `--all` chain other tiers (and the dashboard workspace), so they
# have no single file set to narrow: a path after either is refused, never widened.
#
# With NO tier flag, --test and file paths are passthroughs to the underlying runner
# (tsx/jest/vitest) and are unaffected.
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

# Prints the named npm script's command line from the given package.json; returns 1
# if the file or the script is absent.
_pkg_script() {
  node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const s = p.scripts && p.scripts[process.argv[2]];
      if (!s) process.exit(1);
      process.stdout.write(s);
    } catch(e) { process.exit(1); }
  " "$1" "$2" 2>/dev/null
}

# Returns 0 if the named npm script exists in the given package.json file.
_pkg_has_script() {
  _pkg_script "$1" "$2" >/dev/null
}

# ── TIER FLAGS ──────────────────────────────────────────────────────────────
# One definition of what a tier flag is and what it resolves to, shared by
# PRINT-CMD mode and the real run below. They used to carry a copy each, so a fix
# to one graded a code path the other did not take (FG-695).
_is_tier_flag() {
  case "$1" in
    --unit|--integration|--worktree|--extended|--all) return 0 ;;
    *) return 1 ;;
  esac
}

# The files a tier runs, one per line, derived from the tier's OWN selection so the
# two cannot drift: the unit/worktree scripts embed a `$(find ...)`, and the
# integration script lists its selection under FORGE_INTEGRATION_LIST_ONLY=1.
# Returns 1 for a selection this script cannot reproduce — the caller must then
# refuse, never fall back to the whole tier.
_tier_files() {
  local root="$1" script="$2" expr
  case "$script" in
    *'$(find '*)
      # Anything after the substitution would be dropped by the narrowing below.
      [[ -z "${script##*\)}" ]] || return 1
      expr="${script#*\$(}"
      expr="${expr%%)*}"
      ( cd "$root" && eval "$expr" )
      ;;
    *run-integration-tests.sh*)
      [[ -f "$root/scripts/run-integration-tests.sh" ]] || return 1
      FORGE_INTEGRATION_LIST_ONLY=1 bash "$root/scripts/run-integration-tests.sh"
      ;;
    *) return 1 ;;
  esac
}

# The tier's runner with its file list removed, word-split into _TIER_CMD.
_tier_runner() {
  local script="$1"
  case "$script" in
    *'$(find '*) read -ra _TIER_CMD <<<"${script%%\$(find*}" ;;
    # scripts/run-integration-tests.sh's own exec line, which this cannot invoke
    # (that script selects its files itself). Kept honest by a test in
    # src/v2/forge-test-wrapper.test.ts that fails if the two ever diverge.
    *run-integration-tests.sh*) _TIER_CMD=(node --import tsx --import ./src/test-setup.ts --test) ;;
    *) return 1 ;;
  esac
}

# A caller's path, made relative to the tier's file list (which the tier's own
# selection produces relative to the project root).
#
# FG-695: both roots are stripped, not just the one the tier was resolved against.
# The production call site resolves against the SCRATCH, but an agent in a container
# naturally names a file under the /project mount it is editing — and stripping only
# the scratch prefix left that path absolute, so membership failed and the run was
# refused with a diagnostic saying the file was not in the tier. It was. The two
# roots are the same tree, so a path under either strips to the same relative path.
_tier_rel() {
  local arg="${1#./}" root
  for root in "$SRC_DIR" "$WORK_DIR"; do
    root="${root%/}"
    if [[ "$arg" == "$root"/* ]]; then
      printf '%s' "${arg#"$root"/}"
      return 0
    fi
  done
  printf '%s' "$arg"
}

# Resolve a tier flag plus its (optional) path arguments into _TIER_CMD. Returns 1
# with a diagnostic on stderr for any combination that cannot be honoured exactly
# as asked.
_resolve_tier_cmd() {
  local root="$1" flag="$2"; shift 2
  local tier="${flag#--}" name="test:${flag#--}" script files rel arg
  script=$(_pkg_script "$root/package.json" "$name") || {
    echo "forge-test: no \"$name\" script in $root/package.json" >&2
    return 1
  }

  if [[ $# -eq 0 ]]; then
    _TIER_CMD=(npm run "$name")
    return 0
  fi

  for arg in "$@"; do
    if [[ "$arg" == -* ]]; then
      echo "forge-test: $flag $arg is not supported — a tier flag takes file paths, not other flags." >&2
      echo "forge-test: run \`forge-test $flag\` for the whole tier, or \`forge-test $arg ...\` to pass flags straight to the runner." >&2
      return 1
    fi
  done

  if [[ "$tier" == "extended" || "$tier" == "all" ]]; then
    echo "forge-test: $flag does not accept file paths — \"$name\" is \`$script\`, which chains other tiers, so there is no single file set to narrow." >&2
    echo "forge-test: run \`forge-test --unit|--integration|--worktree <path>\` to narrow the tier that owns those files, or \`forge-test $flag\` for the whole thing." >&2
    return 1
  fi

  if ! files=$(_tier_files "$root" "$script"); then
    echo "forge-test: cannot narrow $flag — this script cannot reproduce which files \"$name\" (\`$script\`) selects, and will not run the whole tier when you asked for $# file(s)." >&2
    echo "forge-test: run \`forge-test <path>...\` to run those files directly, or \`forge-test $flag\` for the whole tier." >&2
    return 1
  fi

  local narrowed=()
  for arg in "$@"; do
    rel=$(_tier_rel "$arg")
    if ! grep -Fxq -- "$rel" <<<"$files"; then
      echo "forge-test: $arg is not part of the $tier tier (\"$name\" does not select it), so $flag cannot run it." >&2
      echo "forge-test: paths resolve against the source checkout ($SRC_DIR) and the scratch ($WORK_DIR)." >&2
      echo "forge-test: run it under the tier that owns it, or as \`forge-test $rel\` to run the file directly." >&2
      return 1
    fi
    narrowed+=("$rel")
  done

  _tier_runner "$script" || return 1
  _TIER_CMD+=("${narrowed[@]}")
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
  elif _is_tier_flag "$1"; then
    _resolve_tier_cmd "$SRC_DIR" "$@" || exit 2
    echo "${_TIER_CMD[*]}"
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
fi

# ── SCRATCH GIT (FG-644) ────────────────────────────────────────────────────
# The scratch is a re-synced COPY of a checkout the agent is actively editing, so
# every in-flight edit lands here as an UNCOMMITTED change. forge refuses to build
# a release from a dirty tree (FG-569 GAP 2), which made the three release-build
# suites unrunnable for any agent with work in progress — and the two ways out
# were both worthless: skip them (validates nothing) or build HEAD (validates the
# wrong bytes). So the scratch gets its OWN throwaway git repo and every sync is
# committed into it. The tree the release builder sees is then CLEAN and its HEAD
# describes exactly the source the agent just wrote.
#
# The repo is always one this script created. The scratch used to inherit a
# `cp -R` of the source's .git, and on a linked worktree that is a `gitdir:`
# POINTER into the operator's real admin dir — committing through it would write
# into the operator's repository, the exact FG-575 defect. The marker below is
# what distinguishes "a repo I made" from "something I inherited"; anything
# without it is replaced rather than committed into.
SCRATCH_REPO_MARKER=".forge-scratch-repo"

_scratch_git() {
  git -C "$WORK_DIR" -c user.email=forge-test@local -c user.name=forge-test "$@"
}

_ensure_scratch_repo() {
  [[ ! -f "$WORK_DIR/.git/$SCRATCH_REPO_MARKER" ]] || return 0
  rm -rf "$WORK_DIR/.git" || return 1
  git -C "$WORK_DIR" init -q || return 1
  # Mirror the source's branch name so anything that reads it sees the branch the
  # agent is working on rather than git's default.
  local branch
  branch=$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [[ -n "$branch" && "$branch" != "HEAD" ]] || branch="main"
  git -C "$WORK_DIR" symbolic-ref HEAD "refs/heads/$branch" || return 1
  # node_modules is install OUTPUT, bound to the lockfile separately — never part
  # of a commit's source identity, and by far the biggest thing in the tree.
  printf 'node_modules/\n' > "$WORK_DIR/.git/info/exclude" || return 1
  : > "$WORK_DIR/.git/$SCRATCH_REPO_MARKER" || return 1
}

# Make HEAD describe the bytes just synced. Loud but non-fatal on failure: a
# scratch without git still runs every suite that does not build a release, and
# killing the run here would report an environment fault as red tests.
_commit_scratch() {
  if ! command -v git >/dev/null 2>&1; then
    echo "forge-test: git is not installed — the scratch cannot be made a clean release candidate" >&2
    return 0
  fi
  if ! _ensure_scratch_repo; then
    echo "forge-test: WARNING: could not initialise a scratch git repo in $WORK_DIR — release-build suites will refuse this tree as dirty" >&2
    return 0
  fi
  if ! _scratch_git add -A; then
    echo "forge-test: WARNING: \`git add\` failed in $WORK_DIR — release-build suites will refuse this tree as dirty" >&2
    return 0
  fi
  if git -C "$WORK_DIR" diff --cached --quiet 2>/dev/null; then
    echo "forge-test: scratch git already describes the synced source" >&2
    return 0
  fi
  if _scratch_git commit -q -m "forge-test: scratch sync"; then
    echo "forge-test: committed the synced source into the scratch's own git — the release builder sees a CLEAN tree carrying your in-flight edits" >&2
  else
    echo "forge-test: WARNING: could not commit the synced source in $WORK_DIR — release-build suites will refuse this tree as dirty" >&2
  fi
}

_sync_sources
_commit_scratch
cd "$WORK_DIR"
_ensure_deps

# Returns 0 if the named npm script exists in ./package.json (work dir).
_has_script() {
  _pkg_has_script "./package.json" "$1"
}

# ── TIER FLAGS (first arg only) ─────────────────────────────────────────────
if [[ $# -ge 1 ]] && _is_tier_flag "$1"; then
  _resolve_tier_cmd "$WORK_DIR" "$@" || exit 2
  exec "${_TIER_CMD[@]}"
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
