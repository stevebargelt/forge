#!/usr/bin/env bash
# verify-launch-tier-in-image — FG-551's image-level verification, made reproducible.
#
# WHAT IT DOES, LITERALLY: builds the agent image with docker/build.sh, copies this
# working tree (minus node_modules) into a container of THAT image, runs `npm ci`
# there, and executes the FG-535 launch tier plus the FG-551 image guard INSIDE the
# container with node:test's TAP reporter. It prints the full per-test inventory and
# the TAP totals.
#
# TWO MODES — the fix, and its falsification:
#
#   ./docker/verify-launch-tier-in-image.sh              # post-fix (default)
#   ./docker/verify-launch-tier-in-image.sh --pre-fix    # falsification: tmux-less image
#   ./docker/verify-launch-tier-in-image.sh --both       # both, in order
#
# POST-FIX asserts the tier is CLEAN inside the image forge actually ships: it exits
# non-zero on any failure OR any skip. A skip is a failure here on purpose — FG-551's
# whole point is that a tmux-less image must stay RED, so "make it green by skipping"
# must be impossible.
#
# PRE-FIX is the executable falsification the PRD's campaign rule demands: a guard that
# cannot go red against an unfixed image proves nothing. It derives a TMUX-LESS image
# from the shipped one (`FROM agent-dev-worker` + `apt-get remove tmux`, verified absent),
# runs the SAME tier inside it, and asserts the tier goes RED — with FAILURES and ZERO
# skips. It INVERTS the pass condition: a clean or skip-laden run in pre-fix mode is a
# FAILED falsification and exits non-zero, because it would mean the guard does not
# actually catch a tmux-less image.
#
# The derived tmux-less image reproduces the one property the pre-fix Dockerfile had —
# no tmux on PATH — against today's tier. It is not a checkout of the pre-fix commit
# (neither this script nor the FG-551 guard tests exist there, so that tree would run a
# different, smaller test set); the historical 36/26/10/0 inventory recorded in the
# ticket is what that commit produced. What is re-derivable here, on any Docker host, is
# the property closure actually depends on: remove tmux from the shipped image and the
# launch tier hard-FAILS rather than skipping.
#
# REQUIRES A WORKING DOCKER DAEMON on the machine that runs it. It is therefore NOT
# part of any npm test tier (`test`, `test:unit`, `test:integration`, `test:worktree`)
# — those tiers run inside agent containers, which have no Docker. This is a
# standalone operator/CI verification entry point: run it by hand, or from a CI job
# that has Docker.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE=agent-dev-worker
PREFIX_IMAGE=agent-dev-worker-fg551-prefix
DEST=/home/agent/forge

# The tier under verification: the three FG-535 launch files (unit + both integration
# files, the last of which drives a real tmux server) plus the FG-551 image guard.
TESTS=(
  src/v2/launch.test.ts
  src/v2/launch.integration.test.ts
  src/v2/launch-cli.integration.test.ts
  src/v2/fg551-agent-image-tmux.test.ts
)

MODE=post-fix
case "${1:-}" in
  "") ;;
  --pre-fix) MODE=pre-fix ;;
  --post-fix) MODE=post-fix ;;
  --both) MODE=both ;;
  *)
    echo "usage: $0 [--pre-fix | --post-fix | --both]" >&2
    exit 2
    ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "verify-launch-tier-in-image: no working Docker daemon — this script builds and runs the agent image." >&2
  echo "verify-launch-tier-in-image: it cannot run inside an agent container. Run it on a host with Docker." >&2
  exit 2
fi

CONTAINERS=()
cleanup() {
  for cid in "${CONTAINERS[@]:-}"; do
    [[ -n "$cid" ]] && docker rm -f "$cid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "==> building the agent image via docker/build.sh"
"$HERE/build.sh"

# Derive the tmux-less image from the shipped one. `! command -v tmux` is what makes this
# fail-closed: if the remove silently leaves a tmux on PATH, the image build fails rather
# than handing the falsification a tmux-HAVING image it would then "prove" red against.
build_prefix_image() {
  echo "==> deriving the tmux-less falsification image ($PREFIX_IMAGE) from $IMAGE"
  docker build -t "$PREFIX_IMAGE" -f - "$HERE" <<EOF
FROM $IMAGE
USER root
RUN apt-get remove -y tmux && rm -rf /var/lib/apt/lists/* && ! command -v tmux
USER agent
EOF
}

# Runs the tier inside $1 and sets TESTS_N / FAIL_N / SKIP_N / TODO_N / CANCELLED_N /
# RUNNER_STATUS. Prints the per-test inventory and TAP totals. Asserts nothing — the
# mode-specific pass condition is the caller's job, because pre-fix INVERTS it.
run_tier_in_image() {
  local image="$1"
  local tap_log
  tap_log="$(mktemp -t forge-fg551-tap.XXXXXX)"

  echo "==> starting a container of $image"
  local cid
  cid=$(docker run -d -e FORGE_NO_BROWSER=1 "$image" sleep 7200)
  CONTAINERS+=("$cid")
  echo "container: $cid"

  echo "==> tmux in $image: $(docker exec -u agent "$cid" sh -c 'command -v tmux || echo "NOT FOUND"')"

  # node_modules is excluded because the host's is built for the host (macOS arm64
  # esbuild / better-sqlite3 bindings) and will not load on the container's platform;
  # `npm ci` below builds the right one. .git is carried in: forge's own tests walk up
  # from cwd looking for a repo, same reason forge-test cold-copies it.
  echo "==> copying the working tree into $DEST (excluding node_modules)"
  docker exec -u agent "$cid" mkdir -p "$DEST"
  tar -cf - -C "$REPO_ROOT" \
    --exclude='*/node_modules' \
    --exclude='*/node_modules/*' \
    . | docker exec -i -u agent "$cid" tar -xf - -C "$DEST"

  echo "==> npm ci inside the container"
  docker exec -u agent -w "$DEST" "$cid" npm ci

  echo "==> running the FG-535 launch tier + FG-551 guard INSIDE $image"
  set +e
  docker exec -u agent -w "$DEST" "$cid" \
    node --import tsx --import ./src/test-setup.ts --test --test-reporter=tap "${TESTS[@]}" \
    | tee "$tap_log"
  RUNNER_STATUS=${PIPESTATUS[0]}
  set -e

  echo
  echo "=== per-test inventory (name + outcome, as reported by TAP inside $image) ==="
  grep -E '^[[:space:]]*(not )?ok [0-9]+' "$tap_log" || echo "(no test result lines — the runner produced no tests)"

  echo
  echo "=== TAP totals ($image) ==="
  grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ' "$tap_log" || echo "(no TAP totals emitted)"

  _total() {
    local n
    n=$(grep -E "^# $1 [0-9]+$" "$tap_log" | tail -1 | awk '{print $3}')
    echo "${n:-}"
  }

  TESTS_N=$(_total tests)
  FAIL_N=$(_total fail)
  SKIP_N=$(_total skipped)
  TODO_N=$(_total todo)
  CANCELLED_N=$(_total cancelled)

  if [[ -z "$TESTS_N" || -z "$FAIL_N" || -z "$SKIP_N" ]]; then
    echo "FAIL: the run produced no parseable TAP totals — treat this as a failed verification, not a pass." >&2
    echo "      runner exit status: $RUNNER_STATUS" >&2
    exit 1
  fi

  if [[ "$TESTS_N" -eq 0 ]]; then
    echo "FAIL: zero tests ran inside $image. A tier that runs nothing verifies nothing." >&2
    exit 1
  fi
}

verify_post_fix() {
  echo
  echo "############ POST-FIX: the shipped image must run the tier CLEAN ############"
  run_tier_in_image "$IMAGE"

  echo
  if [[ "$FAIL_N" -ne 0 || "$SKIP_N" -ne 0 || "${TODO_N:-0}" -ne 0 || "${CANCELLED_N:-0}" -ne 0 || "$RUNNER_STATUS" -ne 0 ]]; then
    echo "FAIL: in-image launch tier is not clean — $TESTS_N tests, $FAIL_N failed, $SKIP_N skipped, ${TODO_N:-0} todo, ${CANCELLED_N:-0} cancelled (runner exit $RUNNER_STATUS)." >&2
    echo "      A SKIP counts as a failure here: FG-551 requires that a tmux-less image stay red rather than go quietly green." >&2
    exit 1
  fi

  echo "PASS (post-fix): $TESTS_N tests ran inside $IMAGE, all passed, none skipped."
}

# The pass condition is INVERTED: red is the expected, required outcome.
verify_pre_fix() {
  echo
  echo "############ PRE-FIX FALSIFICATION: a tmux-less image must go RED ############"
  build_prefix_image
  run_tier_in_image "$PREFIX_IMAGE"

  echo
  if [[ "$SKIP_N" -ne 0 || "${TODO_N:-0}" -ne 0 ]]; then
    echo "FAILED FALSIFICATION: the tmux-less image produced $SKIP_N skipped / ${TODO_N:-0} todo tests." >&2
    echo "      A tmux-less image must HARD-FAIL, never skip. A skip route is how a missing tmux goes quietly green." >&2
    exit 1
  fi

  if [[ "$FAIL_N" -eq 0 || "$RUNNER_STATUS" -eq 0 ]]; then
    echo "FAILED FALSIFICATION: the tier passed on a tmux-less image — $TESTS_N tests, $FAIL_N failed (runner exit $RUNNER_STATUS)." >&2
    echo "      The guard proves nothing if it cannot go red against an image with no tmux. Something is gating the tmux path away." >&2
    exit 1
  fi

  echo "PASS (pre-fix falsification): the tmux-less $PREFIX_IMAGE ran $TESTS_N tests — $FAIL_N FAILED, $SKIP_N skipped (runner exit $RUNNER_STATUS)."
  echo "      Red, with failures and no skips. The guard catches a tmux-less image."
}

case "$MODE" in
  post-fix) verify_post_fix ;;
  pre-fix) verify_pre_fix ;;
  both)
    verify_pre_fix
    verify_post_fix
    ;;
esac
