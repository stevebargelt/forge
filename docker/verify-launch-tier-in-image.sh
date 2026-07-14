#!/usr/bin/env bash
# verify-launch-tier-in-image — FG-551's image-level verification, made reproducible.
#
# WHAT IT DOES, LITERALLY: builds the agent image with docker/build.sh, copies this
# working tree (minus node_modules) into a container of THAT image, runs `npm ci`
# there, and executes the FG-535 launch tier plus the FG-551 image guard INSIDE the
# container with node:test's TAP reporter. It prints the full per-test inventory and
# the TAP totals, and exits non-zero on any failure OR any skip.
#
# A skip is a failure here on purpose. FG-551's whole point is that a tmux-less image
# must stay RED — "make it green by skipping" must be impossible — so this script
# refuses to call a run with skipped tests a pass.
#
# REQUIRES A WORKING DOCKER DAEMON on the machine that runs it. It is therefore NOT
# part of any npm test tier (`test`, `test:unit`, `test:integration`, `test:worktree`)
# — those tiers run inside agent containers, which have no Docker. This is a
# standalone operator/CI verification entry point: run it by hand, or from a CI job
# that has Docker.
#
#   ./docker/verify-launch-tier-in-image.sh
#
# SCOPE — what this script can and cannot do. It reproducibly verifies the POST-FIX
# image: run it on any Docker host and it re-derives, from scratch, that the launch tier
# is clean inside the image forge actually ships.
#
# It does NOT reproduce the pre-fix inventory (36 tests / 26 pass / 10 fail / 0 skip on
# the tmux-less image). It cannot: neither this script nor the FG-551 guard tests exist
# at the pre-fix commit, and running today's tree against the old Dockerfile would
# execute a different, larger test set. That inventory is preserved as historical
# evidence in the FG-551 ticket, not re-derivable here. There is no pre-fix mode.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE=agent-dev-worker
DEST=/home/agent/forge

# The tier under verification: the three FG-535 launch files (unit + both integration
# files, the last of which drives a real tmux server) plus the FG-551 image guard.
TESTS=(
  src/v2/launch.test.ts
  src/v2/launch.integration.test.ts
  src/v2/launch-cli.integration.test.ts
  src/v2/fg551-agent-image-tmux.test.ts
)

if ! docker info >/dev/null 2>&1; then
  echo "verify-launch-tier-in-image: no working Docker daemon — this script builds and runs the agent image." >&2
  echo "verify-launch-tier-in-image: it cannot run inside an agent container. Run it on a host with Docker." >&2
  exit 2
fi

echo "==> building the agent image via docker/build.sh"
"$HERE/build.sh"

echo "==> starting a container of the freshly built $IMAGE"
CID=$(docker run -d -e FORGE_NO_BROWSER=1 "$IMAGE" sleep 7200)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
echo "container: $CID"

# node_modules is excluded because the host's is built for the host (macOS arm64
# esbuild / better-sqlite3 bindings) and will not load on the container's platform;
# `npm ci` below builds the right one. .git is carried in: forge's own tests walk up
# from cwd looking for a repo, same reason forge-test cold-copies it.
echo "==> copying the working tree into $DEST (excluding node_modules)"
docker exec -u agent "$CID" mkdir -p "$DEST"
tar -cf - -C "$REPO_ROOT" \
  --exclude='*/node_modules' \
  --exclude='*/node_modules/*' \
  . | docker exec -i -u agent "$CID" tar -xf - -C "$DEST"

echo "==> npm ci inside the container"
docker exec -u agent -w "$DEST" "$CID" npm ci

echo "==> running the FG-535 launch tier + FG-551 guard INSIDE the image"
TAP_LOG="$(mktemp -t forge-fg551-tap.XXXXXX)"
set +e
docker exec -u agent -w "$DEST" "$CID" \
  node --import tsx --import ./src/test-setup.ts --test --test-reporter=tap "${TESTS[@]}" \
  | tee "$TAP_LOG"
RUNNER_STATUS=${PIPESTATUS[0]}
set -e

echo
echo "=== per-test inventory (name + outcome, as reported by TAP inside the image) ==="
grep -E '^[[:space:]]*(not )?ok [0-9]+' "$TAP_LOG" || echo "(no test result lines — the runner produced no tests)"

echo
echo "=== TAP totals ==="
grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ' "$TAP_LOG" || echo "(no TAP totals emitted)"

_total() {
  local n
  n=$(grep -E "^# $1 [0-9]+$" "$TAP_LOG" | tail -1 | awk '{print $3}')
  echo "${n:-}"
}

TESTS_N=$(_total tests)
FAIL_N=$(_total fail)
SKIP_N=$(_total skipped)
TODO_N=$(_total todo)
CANCELLED_N=$(_total cancelled)

echo
if [[ -z "$TESTS_N" || -z "$FAIL_N" || -z "$SKIP_N" ]]; then
  echo "FAIL: the run produced no parseable TAP totals — treat this as a failed verification, not a pass." >&2
  echo "      runner exit status: $RUNNER_STATUS" >&2
  exit 1
fi

if [[ "$TESTS_N" -eq 0 ]]; then
  echo "FAIL: zero tests ran inside the image. A tier that runs nothing verifies nothing." >&2
  exit 1
fi

if [[ "$FAIL_N" -ne 0 || "$SKIP_N" -ne 0 || "${TODO_N:-0}" -ne 0 || "${CANCELLED_N:-0}" -ne 0 || "$RUNNER_STATUS" -ne 0 ]]; then
  echo "FAIL: in-image launch tier is not clean — $TESTS_N tests, $FAIL_N failed, $SKIP_N skipped, ${TODO_N:-0} todo, ${CANCELLED_N:-0} cancelled (runner exit $RUNNER_STATUS)." >&2
  echo "      A SKIP counts as a failure here: FG-551 requires that a tmux-less image stay red rather than go quietly green." >&2
  exit 1
fi

echo "PASS: $TESTS_N tests ran inside $IMAGE, all passed, none skipped."
