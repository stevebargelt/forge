#!/usr/bin/env bash
# verify-native-prebuild-in-image — FG-857's image-level regression.
#
# The agent image moved to ubuntu:24.04 because 22.04's glibc 2.35 is below what
# better-sqlite3@13.0.1's linux prebuild links against (GLIBC_2.38). This script
# proves that on a real image and proves the check can go red.
#
#   ./docker/verify-native-prebuild-in-image.sh              # post-fix (default)
#   ./docker/verify-native-prebuild-in-image.sh --pre-fix    # falsification: a 22.04 image
#   ./docker/verify-native-prebuild-in-image.sh --both       # post-fix FIRST, then the falsification
#   FG857_SKIP_BUILD=1 ./docker/verify-native-prebuild-in-image.sh   # use the already-built image
#
# POST-FIX builds the image with docker/build.sh, then inside a container of it, as the
# agent user: runs docker/fg857-native-prebuild-check.sh (glibc floor, DEC-009 agent user
# at 1000:1000 with no leftover `ubuntu`, NOPASSWD sudo, every tool, the FG-856
# safe.directory entry, and an npm-installed better-sqlite3@13.0.1 loading its shipped
# prebuild), then copies this working tree in, runs `npm ci`, and runs the FG-559 / FG-856
# worktree-tier and FG-376 entrypoint suites. Any failure or skip fails the arm.
#
# PRE-FIX derives a minimal image FROM ubuntu:22.04 with the shipped image's CA and Node 24
# install, runs the same check (native part only), and INVERTS the pass condition: it must
# fail, and it must fail for the named reasons — the glibc-floor assertion AND a
# require() that dies on `GLIBC_2.38' not found`. A red run for any other reason (registry
# unreachable, a missing prebuild) is a FAILED falsification, because it proves nothing
# about glibc.
#
# Needs a Docker daemon and registry access from inside the container (npm install). Like
# verify-launch-tier-in-image.sh it is NOT part of any npm test tier.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE=agent-dev-worker
PREFIX_IMAGE=agent-dev-worker-fg857-prefix
CHECK="$HERE/fg857-native-prebuild-check.sh"
DEST=/home/agent/forge

SUITES=(
  src/v2/fg559-worktree-git-mount.worktree.test.ts
  src/v2/fg559-worktree-git-enforcement.worktree.test.ts
  src/v2/fg856-root-owned-mount-git-trust.worktree.test.ts
  src/v2/fg376-agent-entrypoint.integration.test.ts
)

MODE=post-fix
case "${1:-}" in
  "" | --post-fix) ;;
  --pre-fix) MODE=pre-fix ;;
  --both) MODE=both ;;
  *)
    echo "usage: $0 [--pre-fix | --post-fix | --both]" >&2
    exit 2
    ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "verify-native-prebuild-in-image: no working Docker daemon — run this on a host with Docker." >&2
  exit 2
fi

CONTAINERS=()
CTX=""
cleanup() {
  for cid in "${CONTAINERS[@]:-}"; do
    [[ -n "$cid" ]] && docker rm -f "$cid" >/dev/null 2>&1 || true
  done
  [[ -n "$CTX" ]] && rm -rf "$CTX"
}
trap cleanup EXIT

verify_post_fix() {
  echo
  echo "############ POST-FIX: $IMAGE must load better-sqlite3@13.0.1's prebuild ############"
  if [[ "${FG857_SKIP_BUILD:-0}" != "1" ]]; then
    echo "==> building the agent image via docker/build.sh"
    "$HERE/build.sh" || { echo "FAIL: docker/build.sh failed." >&2; return 1; }
  fi
  echo "image: $IMAGE $(docker image inspect -f '{{.Id}}' "$IMAGE")"

  local cid
  cid=$(docker run -d -e FORGE_NO_BROWSER=1 "$IMAGE" sleep 7200) || { echo "FAIL: could not start a container of $IMAGE." >&2; return 1; }
  CONTAINERS+=("$cid")
  echo "container: $cid"

  echo "==> fg857-native-prebuild-check.sh inside $IMAGE (as agent)"
  docker exec -i -u agent "$cid" bash -s <"$CHECK" || {
    echo "FAIL (post-fix): the FG-857 in-image check failed — see the 'FG857 FAIL' lines above." >&2
    return 1
  }

  echo "==> copying the working tree into $DEST (excluding node_modules)"
  docker exec -u agent "$cid" mkdir -p "$DEST" || return 1
  tar -cf - -C "$REPO_ROOT" --exclude='*/node_modules' --exclude='*/node_modules/*' . \
    | docker exec -i -u agent "$cid" tar -xf - -C "$DEST" \
    || { echo "FAIL: could not copy the working tree into $IMAGE." >&2; return 1; }
  local branch
  branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
  docker exec -u agent -w "$DEST" "$cid" bash docker/commit-scratch-tree.sh "$DEST" --branch "$branch" \
    || { echo "FAIL: could not commit the copied tree inside $IMAGE." >&2; return 1; }
  echo "==> npm ci inside the container"
  docker exec -u agent -w "$DEST" "$cid" npm ci || { echo "FAIL: npm ci failed inside $IMAGE." >&2; return 1; }

  echo "==> FG-559 / FG-856 / FG-376 suites INSIDE $IMAGE"
  local tap_log rc
  tap_log="$(mktemp -t forge-fg857-tap.XXXXXX)"
  set +e
  docker exec -u agent -w "$DEST" "$cid" \
    node --import tsx --import ./src/test-setup.ts --test --test-reporter=tap "${SUITES[@]}" | tee "$tap_log"
  rc=${PIPESTATUS[0]}
  set -e
  echo
  echo "=== TAP totals ($IMAGE) ==="
  grep -E '^# (tests|pass|fail|cancelled|skipped|todo) ' "$tap_log" || true
  local tests fail skip todo
  tests=$(grep -E '^# tests [0-9]+$' "$tap_log" | tail -1 | awk '{print $3}')
  fail=$(grep -E '^# fail [0-9]+$' "$tap_log" | tail -1 | awk '{print $3}')
  skip=$(grep -E '^# skipped [0-9]+$' "$tap_log" | tail -1 | awk '{print $3}')
  todo=$(grep -E '^# todo [0-9]+$' "$tap_log" | tail -1 | awk '{print $3}')
  rm -f "$tap_log"
  if [[ -z "$tests" || "$tests" -eq 0 || "${fail:-1}" -ne 0 || "${skip:-1}" -ne 0 || "${todo:-0}" -ne 0 || "$rc" -ne 0 ]]; then
    echo "FAIL (post-fix): suites not clean in $IMAGE — ${tests:-?} tests, ${fail:-?} failed, ${skip:-?} skipped, ${todo:-?} todo (runner exit $rc)." >&2
    return 1
  fi
  echo "PASS (post-fix): FG-857 check clean and $tests suite tests passed inside $IMAGE, none skipped."
}

verify_pre_fix() {
  echo
  echo "############ PRE-FIX FALSIFICATION: a ubuntu:22.04 image must go RED for the glibc reason ############"
  CTX="$(mktemp -d -t forge-fg857-ctx.XXXXXX)"
  local ca="${FORGE_CA_BUNDLE:-$HOME/root.pem}"
  if [[ -f "$ca" ]]; then cp "$ca" "$CTX/corp-root.pem"; else : >"$CTX/corp-root.pem"; fi
  cat >"$CTX/Dockerfile" <<'EOF'
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY corp-root.pem /usr/local/share/ca-certificates/corp-root.crt
RUN update-ca-certificates
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt
EOF
  docker build -t "$PREFIX_IMAGE" "$CTX" || { echo "FAILED FALSIFICATION: could not build $PREFIX_IMAGE." >&2; return 1; }
  echo "image: $PREFIX_IMAGE $(docker image inspect -f '{{.Id}}' "$PREFIX_IMAGE")"

  local out rc
  set +e
  out=$(docker run --rm -i "$PREFIX_IMAGE" bash -s -- --native-only <"$CHECK" 2>&1)
  rc=$?
  set -e
  echo "$out"
  echo

  if [[ "$rc" -eq 0 ]]; then
    echo "FAILED FALSIFICATION: the check PASSED on a ubuntu:22.04 image — it cannot detect the glibc floor." >&2
    return 1
  fi
  if ! grep -q '^FG857 FAIL glibc-floor:' <<<"$out"; then
    echo "FAILED FALSIFICATION: the 22.04 run went red without the glibc-floor assertion firing." >&2
    return 1
  fi
  if ! grep -q "^FG857 FAIL require-glibc:.*GLIBC_2.38" <<<"$out"; then
    echo "FAILED FALSIFICATION: require('better-sqlite3') did not fail on GLIBC_2.38 — the red run is not the FG-857 failure." >&2
    return 1
  fi
  echo "PASS (pre-fix falsification): on ubuntu:22.04 the glibc floor fired and the prebuild failed on GLIBC_2.38."
}

POST_RC=""
PRE_RC=""
case "$MODE" in
  post-fix) POST_RC=0; verify_post_fix || POST_RC=$? ;;
  pre-fix) PRE_RC=0; verify_pre_fix || PRE_RC=$? ;;
  both)
    POST_RC=0; verify_post_fix || POST_RC=$?
    PRE_RC=0; verify_pre_fix || PRE_RC=$?
    ;;
esac

outcome() { [[ "$1" -eq 0 ]] && echo PASS || echo FAIL; }
echo
echo "############ SUMMARY ############"
[[ -n "$POST_RC" ]] && echo "post-fix ($IMAGE loads better-sqlite3@13.0.1's prebuild; suites clean): $(outcome "$POST_RC")"
[[ -n "$PRE_RC" ]] && echo "pre-fix falsification (ubuntu:22.04 must fail on the glibc floor): $(outcome "$PRE_RC")"
if [[ "${POST_RC:-0}" -ne 0 || "${PRE_RC:-0}" -ne 0 ]]; then
  exit 1
fi
exit 0
