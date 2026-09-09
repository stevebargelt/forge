#!/usr/bin/env bash
set -euo pipefail

# Single source of truth for the ROOT integration file-selection contract.
# Usable unsharded (dev, `npm run test:integration`) and sharded (CI, one job
# per shard). The file list is SORTED so every shard sees an identical ordering.
#
# FG-704 restored the sub-five-minute integration objective with a 9-JOB
# topology, invoked entirely through this script:
#   - EIGHT bulk shards (selector `k/8`), bin-packed by the BATCHED-execution
#     cost of each file — MEASURED per-file duration (scripts/integration-timings
#     .json) discounted by an estimated per-file `node --test` startup, see
#     src/test-shards.ts's packWeight — over (discovered − fg576).
#   - ONE dedicated SERIAL lane (the literal argument `serial`, no k/N selector)
#     that runs ONLY fg576-codex-adapter.integration.test.ts under
#     `--test-concurrency=1`. fg576 is EXCLUDED from the bin-packer entirely, so
#     it never lands on a bulk shard; the serial lane accounts for it exactly.
#     (bulk ∪ serial) == discovered, disjoint.
#
# FG-624: the k/N partition is NOT Node's --test-shard (which splits by FILE
# INDEX — an arbitrary split of cost). The sorted list is piped to
# src/test-shards.ts, which bin-packs it by measured per-file duration and
# prints just this shard's files. Selection happens here; only the partition
# moved.
#
# FORGE_INTEGRATION_LIST_ONLY=1 prints the selected files instead of running
# them — how src/test-shards.integration.test.ts proves the census: the union of
# the eight bulk shards is exactly (discovered − fg576), and the serial lane lists
# exactly fg576.
#
# FG-681: fg576's AC9 correlation tests observe a real 30s production window.
# They prove correlation at ordinary operating capacity and must therefore run
# ALONE, not merely in a smaller concurrent bucket (which would only postpone
# the same scheduling flake). The dedicated serial lane is what guarantees that.
#
# The bulk and serial runners below are kept as BARE `node ... --test <files>`
# lines: forge-test's narrowed --integration runner reproduces this exact runner
# (FG-695), and node:test's TAP therefore streams straight to the job log so a
# job-clock kill still shows partial progress (AC8). The per-run capture is set
# up out-of-band via `exec` (start_capture/end_capture_and_report) so the runner
# lines stay unwrapped.
#
# FG-792 tree-purity guard: the integration tier must leave the real checkout
# byte-identical. A test that stages a transient file under $REPO_ROOT (fg543 once
# staged docker/corp-root.pem) races the tree-purity snapshot another integration
# test takes of the SAME checkout in the SAME shard, so the tier flakes on unrelated
# PRs. This script snapshots `git status --porcelain` (untracked included) before the
# tier runs and again at exit; any difference is a hard, named failure ("integration
# tier dirtied the real checkout") so the class cannot recur silently. It wraps every
# run path — a bulk shard, the serial lane, and the unsharded dev run (bulk + serial
# tail). Bypass ONLY for local debugging by exporting FORGE_SKIP_TREE_PURITY_GUARD=1
# — never silently. The installing runner exports FORGE_INTEGRATION_TREE_GUARD_ACTIVE
# = its OWN pid so a genuinely NESTED runner (the fg704 runner test, forge-test's
# reproduced --integration runner) does not install a second guard whose before/after
# window would straddle the parent's concurrent siblings and false-positive on their
# transient files. That skip is honored ONLY when the marker names a pid that is a LIVE
# ANCESTOR of the nested runner, and it announces itself on stderr — it is not silent.
# A stale marker (owning runner already exited) or an externally/inherited-set marker
# (e.g. FORGE_INTEGRATION_TREE_GUARD_ACTIVE=1 in the ambient environment) is NOT a live
# ancestor, so the guard installs anyway rather than being silently disabled.

ARG="${1:-}"

MODE="bulk"
SHARD=""
if [ "$ARG" = "serial" ]; then
  MODE="serial"
elif [ -n "$ARG" ]; then
  if ! [[ "$ARG" =~ ^[0-9]+/[0-9]+$ ]]; then
    echo "error: argument must be a k/N shard selector (e.g. 1/8) or the literal 'serial'; got: $ARG" >&2
    exit 2
  fi
  SHARD="$ARG"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---- FG-792 tree-purity guard ----------------------------------------------
# See the header note. Installed once, at the OUTERMOST run only; covers the serial
# lane, a bulk shard, and the unsharded dev run since every one of them exits through
# this trap. LIST_ONLY runs no tests, so it needs no guard.
PURITY_BEFORE=""
# is_live_ancestor <pid>: true when <pid> is a live process AND an ancestor of this
# runner ($$). Walks the parent chain via `ps -o ppid=` (portable to macOS/BSD, unlike
# /proc) and stops before pid 1 — init is an ancestor of everything and is never a
# runner, so it can never make an external `=1` marker look legitimate.
is_live_ancestor() {
  local target="$1" pid ppid
  case "$target" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$target" -gt 1 ] || return 1
  pid=$$
  while [ "$pid" -gt 1 ]; do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || ppid=""
    [ -n "$ppid" ] || return 1
    case "$ppid" in ''|*[!0-9]*) return 1 ;; esac
    [ "$ppid" = "$target" ] && return 0
    pid="$ppid"
  done
  return 1
}
check_tree_purity() {
  local orig_exit=$?
  local after
  after="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)"
  if [ "$after" != "$PURITY_BEFORE" ]; then
    {
      echo ""
      echo "error: integration tier dirtied the real checkout (FG-792 tree-purity guard)"
      echo "  a test wrote into or removed a path under $REPO_ROOT instead of a temp dir."
      echo "  git status --porcelain (before -> after):"
      diff <(printf '%s\n' "$PURITY_BEFORE") <(printf '%s\n' "$after") | sed 's/^/    /' || true
      echo "  bypass for local debugging with FORGE_SKIP_TREE_PURITY_GUARD=1."
    } >&2
    exit 1
  fi
  exit "$orig_exit"
}
GUARD_MARKER="${FORGE_INTEGRATION_TREE_GUARD_ACTIVE:-}"
if [ "${FORGE_INTEGRATION_LIST_ONLY:-}" = "1" ]; then
  : # list mode runs no tests, so it needs no guard
elif [ "${FORGE_SKIP_TREE_PURITY_GUARD:-}" = "1" ]; then
  echo "notice: FG-792 tree-purity guard BYPASSED (FORGE_SKIP_TREE_PURITY_GUARD=1) — the integration tier may dirty the real checkout; local debugging only" >&2
elif [ -n "$GUARD_MARKER" ] && is_live_ancestor "$GUARD_MARKER"; then
  # Genuinely nested: an ancestor runner (pid $GUARD_MARKER) already installed the
  # guard over this whole process tree. Skip the second guard — but never silently.
  echo "notice: FG-792 tree-purity guard already active in ancestor runner (pid ${GUARD_MARKER}); nested runner installs no second guard" >&2
else
  # No marker, or a stale/external one that is NOT a live ancestor (e.g. an inherited
  # FORGE_INTEGRATION_TREE_GUARD_ACTIVE=1): install the guard rather than let an
  # unrelated marker silently disable it. Re-stamp the marker with our own pid so our
  # real nested children can recognize it.
  if [ -n "$GUARD_MARKER" ]; then
    echo "notice: FG-792 tree-purity guard marker FORGE_INTEGRATION_TREE_GUARD_ACTIVE=${GUARD_MARKER} is not a live ancestor runner; installing the guard anyway" >&2
  fi
  export FORGE_INTEGRATION_TREE_GUARD_ACTIVE=$$
  PURITY_BEFORE="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)"
  trap check_tree_purity EXIT
fi

ALL=()
while IFS= read -r f; do
  ALL+=("$f")
done < <(find src -name '*.integration.test.ts' -type f | sort)

# fg576 also carries the shared disposable-Codex harness used by AC9. Keeping the
# whole file together avoids copying that harness into a second test file and
# lets every one of its cases retain the same fixture lifecycle.
SERIAL_FILE="src/orchestrator/fg576-codex-adapter.integration.test.ts"

if [[ ! " ${ALL[*]} " =~ " ${SERIAL_FILE} " ]]; then
  echo "error: required serial integration file is missing: $SERIAL_FILE" >&2
  exit 1
fi

# fg576 is excluded from the set fed to the bin-packer: bulk packing is a clean
# 8-way over (discovered − fg576). The serial lane runs fg576 by itself.
BULK_ALL=()
for f in "${ALL[@]}"; do
  if [ "$f" != "$SERIAL_FILE" ]; then
    BULK_ALL+=("$f")
  fi
done

# ---- AC6/AC7/AC8 operator-visible surfaces ---------------------------------
# start_capture / end_capture_and_report bracket a bare node:test runner. They
# tee the run's output to a temp log (so the per-job summary can restate
# node:test's pass/fail counts) WHILE streaming it live to the job log, without
# wrapping the runner line itself. `wait` on the tee makes the captured log
# race-free before it is read.
CAPTURE_LOG=""
CAPTURE_START=0
CAPTURE_TEE_PID=0

# epoch_ms: portable epoch-milliseconds. GNU date supports `date +%s%3N`, but BSD
# date (macOS) does NOT support `%N` — it emits a literal `N`, so `$((end-start))`
# dies with `value too great for base`. Both GNU and BSD date DO support `%s`, so
# take epoch SECONDS and append a literal `000`: second-granular ms, which is
# plenty for a multi-minute integration run's duration. Command substitution
# strips the trailing newline, leaving a bare integer for the arithmetic.
# (Stays on `date` so the fg704 runner test can inject a fake duration by
# shadowing `date` on PATH.)
epoch_ms() {
  date +%s000
}

start_capture() {
  CAPTURE_LOG="$(mktemp)"
  CAPTURE_START=$(epoch_ms)
  exec 3>&1 4>&2
  exec > >(tee "$CAPTURE_LOG") 2>&1
  CAPTURE_TEE_PID=$!
}

# emit_job_summary: surface the per-job census on stdout (machine-readable) and
# to $GITHUB_STEP_SUMMARY (rendered per job in the Checks UI): selected files,
# projected weight (from the manifest), actual duration, manifest coverage, and
# projected-vs-actual skew (AC6).
#
# AC8: node:test's own pass/fail counts are parsed from the captured TAP summary
# (`ℹ pass N` / `ℹ fail N` under the spec reporter, `# pass N` under tap).
# Present ⇒ the run completed; `fail N` (N>0) is a genuine assertion failure.
# Absent ⇒ no summary was emitted because the process was killed mid-run
# (job-clock cancellation / crash), which GitHub renders as "The operation was
# canceled." — a cancellation is thus distinguishable from an assertion failure
# on the surface, not just reported as a red exit.
emit_job_summary() {
  local label="$1" logfile="$2" duration_ms="$3" exit_code="$4"
  shift 4
  local files=("$@")

  # Projected weight and manifest coverage of THIS job's selected files. This
  # mirrors src/test-shards.ts's packing cost model so projected_weight_ms is on
  # the SAME batched-execution basis the bin-packer balances — the p75 default for
  # unmeasured files (defaultWeight) AND the FG-704 startup discount (packWeight:
  # max(FLOOR_MS, raw − STARTUP_DISCOUNT_MS)). Keep these two constants in sync
  # with test-shards.ts; the manifest weights are serial per-file measures, so a
  # projection that skipped the discount would over-count by ~startup·nfiles and
  # the projected-vs-actual skew (how we validate the model held) would be
  # meaningless. Relative weight only — see the manifest's $comment.
  local nfiles=0 measured=0 weight=0 cov="0.0"
  read -r nfiles measured weight cov < <(
    FORGE_JOB_FILES="$(printf '%s\n' ${files[@]+"${files[@]}"})" node -e '
      const STARTUP_DISCOUNT_MS = 2400, FLOOR_MS = 400;
      const pack = (raw) => Math.max(FLOOR_MS, raw - STARTUP_DISCOUNT_MS);
      const m = (require("./scripts/integration-timings.json").files) || {};
      const vals = Object.values(m).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
      const p75 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))] : 1;
      const fs = (process.env.FORGE_JOB_FILES || "").split("\n").filter(Boolean);
      let weight = 0, measured = 0;
      for (const f of fs) {
        const v = m[f];
        if (typeof v === "number" && v > 0) { weight += pack(v); measured++; } else { weight += pack(p75); }
      }
      const cov = fs.length ? (100 * measured / fs.length) : 0;
      console.log(fs.length, measured, Math.round(weight), cov.toFixed(1));
    ' 2>/dev/null || true
  ) || true

  # node:test's summary block lines end in a bare count (`… pass 8` / `… fail 0`);
  # anchoring on the trailing count matches only the summary, never a per-test
  # line (which ends in `(…ms)`). The final block wins for a multi-file run.
  local pass fail status
  pass=$(grep -aoE 'pass [0-9]+$' "$logfile" 2>/dev/null | tail -n1 | grep -oE '[0-9]+' || true)
  fail=$(grep -aoE 'fail [0-9]+$' "$logfile" 2>/dev/null | tail -n1 | grep -oE '[0-9]+' || true)
  if [ "$exit_code" -eq 0 ]; then
    status="passed"
  elif [ -n "$fail" ] && [ "$fail" -gt 0 ]; then
    status="assertion_failure"
  elif [ -z "$fail" ]; then
    status="no_node_test_summary_likely_cancelled"
  else
    status="nonzero_exit"
  fi

  local skew
  skew=$(awk -v p="$weight" -v a="$duration_ms" 'BEGIN { if (p > 0) printf "%d", (a - p) / p * 100; else printf "0" }')

  # AC6: machine-readable line on stdout for log scraping / dashboards.
  echo "FORGE_INTEGRATION_JOB_SUMMARY label=${label} selected_files=${nfiles} projected_weight_ms=${weight} manifest_coverage_pct=${cov} measured_files=${measured} actual_duration_ms=${duration_ms} projected_vs_actual_skew_pct=${skew} node_test_pass=${pass:-NA} node_test_fail=${fail:-NA} status=${status} exit=${exit_code}"

  # AC7: an actionable warning once a job crosses 4 minutes — well before the
  # 10-minute kill ceiling, so the sub-5-minute objective slipping is visible as
  # a warning rather than only as a red cancellation at the ceiling.
  if [ "$duration_ms" -gt 240000 ]; then
    echo "::warning title=Integration job ${label} crossed 4 minutes::actual ${duration_ms}ms over ${nfiles} files — approaching the 10-minute kill ceiling; the sub-5-minute objective is at risk (projected weight ${weight}ms)."
  fi

  # AC6: per-job summary rendered in the Checks UI.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Integration job \`${label}\`"
      echo ""
      echo "| metric | value |"
      echo "| --- | --- |"
      echo "| selected files | ${nfiles} |"
      echo "| projected weight (manifest) | ${weight} ms |"
      echo "| actual test duration | ${duration_ms} ms |"
      echo "| projected-vs-actual skew | ${skew}% |"
      echo "| timing-manifest coverage | ${cov}% (${measured}/${nfiles}) |"
      echo "| node:test pass / fail | ${pass:-NA} / ${fail:-NA} |"
      echo "| status | ${status} (exit ${exit_code}) |"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

# end_capture_and_report: restore the real stdout/stderr, flush+await the tee (so
# the captured log is complete), then emit the per-job summary.
end_capture_and_report() {
  local label="$1" exit_code="$2"
  shift 2
  local files=("$@")
  exec 1>&3 2>&4 3>&- 4>&-
  wait "$CAPTURE_TEE_PID" 2>/dev/null || true
  local end duration_ms
  end=$(epoch_ms)
  duration_ms=$((end - CAPTURE_START))
  emit_job_summary "$label" "$CAPTURE_LOG" "$duration_ms" "$exit_code" "${files[@]}"
  rm -f "$CAPTURE_LOG"
}

# ---- serial lane (the 9th job) ---------------------------------------------
if [ "$MODE" = "serial" ]; then
  if [ "${FORGE_INTEGRATION_LIST_ONLY:-}" = "1" ]; then
    printf '%s\n' "$SERIAL_FILE"
    exit 0
  fi
  start_capture
  set +e
  node --import tsx --import ./src/integration-build-preload.ts --import ./src/test-setup.ts --test-concurrency=1 --test "$SERIAL_FILE"
  SERIAL_STATUS=$?
  set -e
  end_capture_and_report "serial" "$SERIAL_STATUS" "$SERIAL_FILE"
  exit "$SERIAL_STATUS"
fi

# ---- bulk shards -----------------------------------------------------------
BULK_FILES=()
if [ -n "$SHARD" ]; then
  while IFS= read -r f; do
    BULK_FILES+=("$f")
  done < <(printf '%s\n' ${BULK_ALL[@]+"${BULK_ALL[@]}"} | node --import tsx src/test-shards.ts --shard "$SHARD")
else
  BULK_FILES=(${BULK_ALL[@]+"${BULK_ALL[@]}"})
fi

if [ "${FORGE_INTEGRATION_LIST_ONLY:-}" = "1" ]; then
  # A bulk shard lists only its packed bulk files (never fg576). The unsharded
  # census also accounts for the serial file, so (unsharded list) == discovered.
  if [ -z "$SHARD" ]; then
    { printf '%s\n' ${BULK_FILES[@]+"${BULK_FILES[@]}"}; printf '%s\n' "$SERIAL_FILE"; } | sort
  else
    printf '%s\n' ${BULK_FILES[@]+"${BULK_FILES[@]}"}
  fi
  exit 0
fi

# An empty shard (more shards than files) must exit clean — `node --test` with no
# file arguments would otherwise fall back to discovering and running EVERYTHING.
if [ ${#BULK_FILES[@]} -eq 0 ]; then
  echo "no integration test files selected for shard ${SHARD:-all}; nothing to run" >&2
  exit 0
fi

start_capture
set +e
node --import tsx --import ./src/integration-build-preload.ts --import ./src/test-setup.ts --test "${BULK_FILES[@]}"
BULK_STATUS=$?
set -e
end_capture_and_report "bulk ${SHARD:-all}" "$BULK_STATUS" "${BULK_FILES[@]}"
if [ "$BULK_STATUS" -ne 0 ]; then
  exit "$BULK_STATUS"
fi

# The unsharded dev run also executes the serial lane so `npm run
# test:integration` still runs the whole tier locally (in CI the dedicated serial
# JOB covers fg576). Do not `exec` the bulk run above: its success must be
# followed by the serial tail, and a failure from either must surface as this
# script's exit.
if [ -z "$SHARD" ]; then
  start_capture
  set +e
  node --import tsx --import ./src/integration-build-preload.ts --import ./src/test-setup.ts --test-concurrency=1 --test "$SERIAL_FILE"
  SERIAL_STATUS=$?
  set -e
  end_capture_and_report "serial" "$SERIAL_STATUS" "$SERIAL_FILE"
  exit "$SERIAL_STATUS"
fi

exit 0
