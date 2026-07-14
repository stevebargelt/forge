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
# runs the SAME tier inside it, and INVERTS the pass condition: a clean or skip-laden run
# in pre-fix mode is a FAILED falsification and exits non-zero.
#
# But "it went red" is NOT the assertion — any broken tier is red, so a bare failure count
# would still be satisfied if the ten tmux tests were DELETED and something unrelated failed
# in their place. The assertion is the tmux-specific failure INVENTORY: exactly
# EXPECTED_TMUX_FAILURES tests fail, each one citing the launch tier's tmux precondition
# message in its TAP diagnostic (so they failed BECAUSE tmux is absent), and ZERO are skipped
# or todo'd. Deleting the tmux tests, re-gating them, or having them fail for an unrelated
# reason each fails the falsification loudly, with the inventory printed.
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

# The falsification's BASELINE INVENTORY — the exact number of tests that must fail on a
# tmux-less image, and the reason they must fail with.
#
# DERIVED, NOT CHOSEN. src/v2/launch-cli.integration.test.ts holds 10 top-level tests behind
# a file-wide `before` hook that runs `assert.ok(hasTmux, "these tests require tmux — ...")`.
# node:test fails a hook-failed file test-by-test, so a tmux-less image fails exactly those 10,
# each carrying the precondition message below in its TAP diagnostic. Nothing else in the tier
# needs a real tmux: launch.test.ts and launch.integration.test.ts drive a tmux STUB, and the
# FG-551 guard asserts against the Dockerfile/test SOURCE, so all three stay green regardless.
#
# IF THIS COUNT DRIFTS, DO NOT EDIT THE NUMBER TO MAKE THE SCRIPT PASS. A different count means
# the tier changed — tmux tests added, deleted, or re-gated — and which of those it was decides
# whether the guard still holds (deletion and re-gating are precisely how a tmux-less image goes
# quietly green). Re-derive the inventory from the test file and have a human accept the new
# baseline. A count silently "fixed" here turns this back into what it replaced: an assertion
# that any red run satisfies, which proves nothing about the tmux path at all.
EXPECTED_TMUX_FAILURES=10
TMUX_PRECONDITION_MSG="these tests require tmux"

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
  TAP_LOG="$(mktemp -t forge-fg551-tap.XXXXXX)"
  local tap_log="$TAP_LOG"

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

# Prints the name of every FAILING test whose TAP diagnostic carries the tmux precondition
# message — i.e. the tests that failed BECAUSE tmux is absent, not merely at the same time.
#
# It walks each `not ok` block to its `...` terminator and only counts the failure if the
# message appears INSIDE that block, so an unrelated failure cannot inherit the attribution
# from a neighbouring test's diagnostic. This attribution is the whole point: a bare failure
# count cannot tell "the tmux tests went red" from "the tmux tests were deleted and something
# else went red", and those two look identical to the falsification unless the reason is read.
tmux_caused_failures() {
  awk -v msg="$TMUX_PRECONDITION_MSG" '
    /^[[:space:]]*not ok [0-9]+/ {
      if (open && hit) print name
      name = $0; open = 1; hit = 0; next
    }
    open && /^[[:space:]]*\.\.\.[[:space:]]*$/ { if (hit) print name; open = 0; hit = 0; next }
    open && index($0, msg) { hit = 1 }
    END { if (open && hit) print name }
  ' "$1"
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

  # Red is necessary but NOT sufficient. Prove the TMUX path specifically went red: the right
  # NUMBER of tests failed, and they failed FOR THE RIGHT REASON. Without this, deleting the ten
  # tmux tests while any unrelated test failed would still "pass" the falsification.
  local tmux_fails tmux_fail_n
  tmux_fails="$(tmux_caused_failures "$TAP_LOG")"
  tmux_fail_n="$(printf '%s' "$tmux_fails" | grep -c . || true)"

  echo "=== tmux-caused failures (failing tests whose diagnostic carries \"$TMUX_PRECONDITION_MSG\") ==="
  if [[ -n "$tmux_fails" ]]; then printf '%s\n' "$tmux_fails"; else echo "(none — no failure was attributed to a missing tmux)"; fi
  echo "tmux-caused: $tmux_fail_n | total failing: $FAIL_N | expected tmux-caused: $EXPECTED_TMUX_FAILURES"
  echo

  if [[ "$tmux_fail_n" -ne "$EXPECTED_TMUX_FAILURES" ]]; then
    echo "FAILED FALSIFICATION: expected exactly $EXPECTED_TMUX_FAILURES tmux-caused failures, found $tmux_fail_n." >&2
    echo "      (total failing: $FAIL_N of $TESTS_N tests; runner exit $RUNNER_STATUS)" >&2
    echo >&2
    echo "      A red run is not the claim. The claim is that THE TMUX TESTS went red BECAUSE tmux is gone." >&2
    if [[ "$tmux_fail_n" -lt "$EXPECTED_TMUX_FAILURES" ]]; then
      echo "      Too few: tmux tests were DELETED or RE-GATED away — the exact hole this falsification exists to catch." >&2
      echo "      A tmux-less image would then look red for some other reason while the tmux path was never exercised." >&2
    else
      echo "      Too many: the tmux precondition now gates more tests than the recorded baseline." >&2
    fi
    echo >&2
    echo "      Full failing inventory from the tmux-less image:" >&2
    grep -E '^[[:space:]]*not ok [0-9]+' "$TAP_LOG" >&2 || echo "      (no failing test lines at all)" >&2
    echo >&2
    echo "      Do NOT edit EXPECTED_TMUX_FAILURES to match this run. Re-derive the inventory from" >&2
    echo "      src/v2/launch-cli.integration.test.ts and have a human accept the new baseline." >&2
    exit 1
  fi

  # Extra failures don't sink the falsification — the tmux path still demonstrably went red —
  # but they mean something ELSE is broken in the tier, and that must not hide inside a PASS.
  if [[ "$FAIL_N" -gt "$tmux_fail_n" ]]; then
    echo "WARNING: $((FAIL_N - tmux_fail_n)) failing test(s) were NOT caused by the missing tmux."
    echo "         The falsification still holds, but the tier is red for an unrelated reason too — investigate:"
    grep -E '^[[:space:]]*not ok [0-9]+' "$TAP_LOG" | grep -vxF "$tmux_fails" || true
    echo
  fi

  echo "PASS (pre-fix falsification): the tmux-less $PREFIX_IMAGE ran $TESTS_N tests — $FAIL_N FAILED, $SKIP_N skipped (runner exit $RUNNER_STATUS)."
  echo "      All $tmux_fail_n expected tmux-gated tests failed, each citing \"$TMUX_PRECONDITION_MSG\" — no skips, no deletions."
  echo "      The tmux path itself went red. The guard catches a tmux-less image."
}

case "$MODE" in
  post-fix) verify_post_fix ;;
  pre-fix) verify_pre_fix ;;
  both)
    verify_pre_fix
    verify_post_fix
    ;;
esac
