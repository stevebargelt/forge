#!/usr/bin/env bash
# fg857-native-prebuild-check — runs INSIDE an agent-image container (piped in by
# docker/verify-native-prebuild-in-image.sh; never COPYed into the image, so it is
# not a build input). FG-857: a project depending on better-sqlite3@13.0.1 must
# load its linux PREBUILD in the image, which needs glibc >= 2.38.
#
#   bash fg857-native-prebuild-check.sh                # image facts + native prebuild
#   bash fg857-native-prebuild-check.sh --native-only  # native prebuild only (pre-fix image)
#
# Network: installs better-sqlite3@13.0.1 from the npm registry into a temp dir.
# 13.x ships its prebuilt binaries INSIDE the package (prebuilds/<platform>-<arch>.node),
# so the registry is the only network dependency; there is no cached-tarball path.
# --ignore-scripts because npm runs `node-gyp rebuild` by default for any package
# with a binding.gyp and no install script. A source build links against whatever
# glibc the image has and loads on any image, so it would make this check pass on
# exactly the image it exists to reject. The check also asserts the binding that
# loaded is the shipped prebuild and that no build/ dir exists.
#
# Every failure prints a `FG857 FAIL <reason>:` line; the host script attributes the
# pre-fix falsification by those reasons. Exits non-zero if any check failed.

set -uo pipefail

GLIBC_FLOOR=2.38
BETTER_SQLITE3_VERSION=13.0.1
NATIVE_ONLY=0
[[ "${1:-}" == "--native-only" ]] && NATIVE_ONLY=1

FAILS=0
fail() {
  echo "FG857 FAIL $1: $2"
  FAILS=$((FAILS + 1))
}
pass() { echo "FG857 ok $1: $2"; }

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

echo "\$ ldd --version | head -1"
ldd --version | head -1
GLIBC="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
echo "glibc: $GLIBC (floor $GLIBC_FLOOR)"
if [[ -n "$GLIBC" ]] && version_ge "$GLIBC" "$GLIBC_FLOOR"; then
  pass glibc-floor "glibc $GLIBC >= $GLIBC_FLOOR"
else
  fail glibc-floor "glibc ${GLIBC:-unknown} is below $GLIBC_FLOOR — better-sqlite3@$BETTER_SQLITE3_VERSION's linux prebuild cannot load (rebuild the image on ubuntu:24.04)"
fi

if [[ "$NATIVE_ONLY" -eq 0 ]]; then
  # AC3: DEC-009 agent user, exactly 1000:1000, and nothing else holds uid 1000.
  echo "\$ id agent"
  id agent
  if [[ "$(id -u agent 2>/dev/null):$(id -g agent 2>/dev/null)" == "1000:1000" ]]; then
    pass agent-uid "agent is uid 1000 gid 1000"
  else
    fail agent-uid "agent is not 1000:1000"
  fi
  holders="$(getent passwd | awk -F: '$3 == 1000 {print $1}' | tr '\n' ' ')"
  if [[ "$holders" == "agent " ]]; then
    pass uid-1000-owner "only agent holds uid 1000"
  else
    fail uid-1000-owner "uid 1000 is held by: ${holders:-nobody}"
  fi
  if id ubuntu >/dev/null 2>&1; then fail ubuntu-user "the base image's ubuntu user is still present"; else pass ubuntu-user "no ubuntu user"; fi
  home="$(getent passwd agent | cut -d: -f6)"
  if [[ "$home" == "/home/agent" ]]; then pass agent-home "$home"; else fail agent-home "agent home is ${home:-unset}"; fi
  echo "\$ sudo -n true (as $(id -un))"
  if sudo -n true; then pass sudo "NOPASSWD sudo works"; else fail sudo "sudo -n true failed for $(id -un)"; fi

  for cmd in "node --version" "git --version" "gh --version" "python3 --version" "tmux -V" "command -v forge"; do
    echo "\$ $cmd"
    if out="$($cmd 2>&1)"; then
      echo "$out" | head -1
      pass tool "$cmd"
    else
      echo "$out"
      fail tool "$cmd"
    fi
  done
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [[ "$node_major" == "24" ]]; then pass node-major "24"; else fail node-major "node major is ${node_major:-missing}, expected 24"; fi
  if [[ "$(git config --system --get-all safe.directory)" == "/project" ]]; then
    pass fg856-safe-directory "system safe.directory is exactly /project"
  else
    fail fg856-safe-directory "system safe.directory is '$(git config --system --get-all safe.directory | tr '\n' ' ')', expected exactly /project"
  fi
fi

WORK="$(mktemp -d -t fg857-native.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1
echo "\$ npm install --ignore-scripts better-sqlite3@$BETTER_SQLITE3_VERSION (in $WORK)"
npm init -y >/dev/null
if ! npm install --ignore-scripts --no-audit --no-fund "better-sqlite3@$BETTER_SQLITE3_VERSION"; then
  fail npm-install "npm install better-sqlite3@$BETTER_SQLITE3_VERSION failed (registry unreachable?)"
  echo "FG857 summary: $FAILS failure(s)"
  exit 1
fi

if [[ -e node_modules/better-sqlite3/build ]]; then
  fail source-build "node_modules/better-sqlite3/build exists — a source build would mask the prebuild's glibc requirement"
fi

echo "\$ node -e \"new (require('better-sqlite3'))(':memory:')\""
if out="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const prebuild = Object.keys(require.cache).find((k) => k.endsWith('/prebuilds/linux-' + process.arch + '.node'));
if (!prebuild) throw new Error('the loaded binding is not the shipped linux-' + process.arch + ' prebuild');
console.log('better-sqlite3 loaded ' + prebuild + '; sqlite ' + db.prepare('select sqlite_version() v').get().v + '; glibc ' + process.report.getReport().header.glibcVersionRuntime);
db.close();
" 2>&1)"; then
  echo "$out"
  pass require "better-sqlite3@$BETTER_SQLITE3_VERSION prebuild loads"
else
  echo "$out"
  if grep -q "GLIBC_" <<<"$out"; then
    fail require-glibc "require('better-sqlite3') failed on a glibc symbol version: $(grep -o "GLIBC_[0-9.]*' not found" <<<"$out" | head -1)"
  else
    fail require "require('better-sqlite3') failed"
  fi
fi

echo "FG857 summary: $FAILS failure(s)"
[[ "$FAILS" -eq 0 ]]
