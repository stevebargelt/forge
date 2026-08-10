#!/usr/bin/env bash
# fg698-measure-temp-peak — the cheap peak temporary-space sampler FG-698 AC4's
# before/after figures must BOTH be produced with.
#
# WHY THIS EXISTS. AC4 wants a MEASURED before/after peak, not an intention. A
# before figure taken one way and an after figure taken another way is not a
# comparison, so this wrapper is the single method: same script, same interval,
# same container, one file at a time.
#
# WHY df AND NOT du. The thing being measured is a multi-GB tree of frozen
# release fixtures. A recursive `du` over that tree walks the same inodes the
# run is writing, competes for the same I/O, and perturbs exactly what it is
# supposed to observe. One `df -kP <path>` per sample is a single statfs — O(1),
# independent of how large the tree got, and it sees space the run allocated
# through ANY path (mkdtemp, inner spawned runs, the copy of node_modules).
#
# WHAT THE NUMBER IS, AND IS NOT. df reports the whole FILESYSTEM holding the
# sampled path. In the agent container /tmp is the overlay root, so the figure
# includes anything else writing to that filesystem: run it with the container
# otherwise idle, and read the delta as "peak growth of the filesystem while
# this command ran", not "bytes this command allocated".
#
# THE INTERVAL IS PART OF THE FIGURE. A fixed-interval sampler cannot see a
# spike shorter than its interval — a fixture that is built and freed between
# two samples is invisible. That is why the interval is printed next to the
# peak, in the same block, every time: the number is uninterpretable without
# it, and a reported peak is always a LOWER BOUND on the true peak.
#
# It never touches the checkout it lives in and never reads the repo, so it can
# be invoked by absolute path against a different checkout — which is how the
# "before" measurement runs it against a clone at the pre-change commit:
#
#   bash /project/scripts/fg698-measure-temp-peak.sh -- \
#     node --import tsx --import ./src/test-setup.ts --test src/v2/release.integration.test.ts
#
# Coreutils only (df, sleep, sort, tail, wc, mktemp). No node, no awk, no repo.
#
# USAGE
#   bash scripts/fg698-measure-temp-peak.sh [--interval N] [--path DIR] -- <command…>
#
#   --interval N   seconds between samples, fractional allowed (default: 1)
#   --path DIR     sample the filesystem holding DIR (default: /tmp)
#   --             required; everything after it is the command and its argv
#
# The report goes to STDERR so the measured command's stdout stays untouched —
# a release-tier run's stdout is TAP and something downstream may parse it.
# The command's exit status is this script's exit status.

set -euo pipefail

SELF=fg698-measure-temp-peak
INTERVAL=1
SAMPLE_PATH=/tmp

fatal() {
  echo "$SELF: FATAL: $*" >&2
  exit 2
}

usage() {
  cat >&2 <<USAGE
usage: bash $0 [--interval N] [--path DIR] -- <command…>

  --interval N   seconds between samples, fractional allowed (default: 1)
  --path DIR     sample the filesystem holding DIR (default: /tmp)
  --             required; everything after it is the command and its argv

Samples the USED space of the filesystem holding DIR while <command…> runs and
prints baseline / peak / peak-minus-baseline, the sample count, the interval and
the command's exit status to STDERR. Exits with the command's exit status.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval)
      [ $# -ge 2 ] || fatal "--interval needs a value"
      INTERVAL="$2"
      shift 2
      ;;
    --path)
      [ $# -ge 2 ] || fatal "--path needs a value"
      SAMPLE_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 2
      ;;
    --)
      shift
      break
      ;;
    *)
      fatal "unknown argument: $1 (the command must come after '--'; see --help)"
      ;;
  esac
done

[ $# -gt 0 ] || { echo "$SELF: FATAL: no command given after '--'." >&2; usage; exit 2; }

case "$INTERVAL" in
  ''|*[!0-9.]*|.|*.*.*) fatal "--interval must be a positive number of seconds, got: $INTERVAL" ;;
esac
# Zero is not merely useless, it is a busy loop that would itself distort the
# measurement: anything made only of 0s and a dot is rejected.
[ -n "${INTERVAL//[0.]/}" ] || fatal "--interval must be greater than 0, got: $INTERVAL"

[ -d "$SAMPLE_PATH" ] || fatal "--path is not a directory: $SAMPLE_PATH"
df -kP "$SAMPLE_PATH" >/dev/null 2>&1 || fatal "df cannot stat the filesystem holding $SAMPLE_PATH"

# One statfs, POSIX output (-P keeps a long device name on ONE line), 1 KiB
# blocks. Prints the USED field. Returns non-zero without printing if df fails
# or its output is not the shape we expect, so a transient failure loses one
# sample instead of poisoning the peak with garbage.
read_used() {
  local line used
  line=$(df -kP "$SAMPLE_PATH" 2>/dev/null | tail -n 1) || return 1
  # Deliberate word splitting: df -P columns are whitespace separated.
  # shellcheck disable=SC2086
  set -- $line
  [ $# -ge 6 ] || return 1
  used=$3
  case "$used" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$used"
}

df_field() { # $1 = 1-based column of the df -kP data row; for the report header only
  local column=$1 line
  line=$(df -kP "$SAMPLE_PATH" 2>/dev/null | tail -n 1) || return 1
  # shellcheck disable=SC2086
  set -- $line
  [ "$#" -ge "$column" ] || return 1
  shift "$(( column - 1 ))"
  printf '%s\n' "$1"
}

kib_to_mib() { # integer KiB -> MiB with one decimal, no floating point needed
  local kib=$1
  printf '%s.%s' "$(( kib / 1024 ))" "$(( (kib % 1024) * 10 / 1024 ))"
}

SAMPLES=$(mktemp "${TMPDIR:-/tmp}/fg698-peak-samples.XXXXXX")
SAMPLER_PID=""
MAIN_PID=$$

cleanup() {
  if [ -n "$SAMPLER_PID" ]; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=""
  fi
  rm -f "$SAMPLES"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

FS_DEVICE=$(df_field 1 || echo '?')
FS_MOUNT=$(df_field 6 || echo '?')

BASELINE=$(read_used) || fatal "could not read baseline used space for $SAMPLE_PATH"
printf '%s\n' "$BASELINE" >> "$SAMPLES"

# The samples file is append-only and each line is a handful of bytes, so the
# sampler and the reader never need a lock: every write is a single O_APPEND
# write well under PIPE_BUF.
#
# The parent-liveness check is not decoration. If this wrapper is SIGKILLed —
# uncatchable, so the EXIT trap never runs — an unguarded sampler would outlive
# it, sampling forever and growing a temp file nobody owns. In a ticket about
# temporary-space discipline that is not an acceptable failure mode, so the
# sampler notices the parent is gone, removes the samples file itself, and exits.
sample_loop() {
  local used
  while :; do
    sleep "$INTERVAL"
    if ! kill -0 "$MAIN_PID" 2>/dev/null; then
      rm -f "$SAMPLES"
      return 0
    fi
    # `if`, not `A && B`: under `set -e` a failed AND-list at the end of the
    # loop body would exit the sampler outright, so one transient df failure
    # would silently stop sampling and quietly understate the peak.
    if used=$(read_used); then
      printf '%s\n' "$used" >> "$SAMPLES"
    fi
  done
}

sample_loop &
SAMPLER_PID=$!

SECONDS=0
set +e
"$@"
STATUS=$?
set -e
ELAPSED=$SECONDS

kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=""

# A final sample after the command has exited: it cannot see the peak the run
# already freed, but it does show what the command LEFT BEHIND, which is the
# other half of what FG-698 cares about.
FINAL=$(read_used) || FINAL="$BASELINE"
printf '%s\n' "$FINAL" >> "$SAMPLES"

PEAK=$(sort -n "$SAMPLES" | tail -n 1)
COUNT=$(wc -l < "$SAMPLES")
COUNT=$(( COUNT + 0 ))
DELTA=$(( PEAK - BASELINE ))
RESIDUE=$(( FINAL - BASELINE ))

{
  echo "$SELF: ============================================================"
  echo "$SELF: sampled path        : $SAMPLE_PATH  (filesystem $FS_DEVICE mounted on $FS_MOUNT)"
  echo "$SELF: sampling interval   : ${INTERVAL}s"
  echo "$SELF: samples taken       : $COUNT  (over ${ELAPSED}s of command wall time)"
  echo "$SELF: baseline used       : $BASELINE KiB ($(kib_to_mib "$BASELINE") MiB)"
  echo "$SELF: peak used           : $PEAK KiB ($(kib_to_mib "$PEAK") MiB)"
  echo "$SELF: peak - baseline     : $(kib_to_mib "$DELTA") MiB ($DELTA KiB)"
  echo "$SELF: left behind at exit : $(kib_to_mib "$RESIDUE") MiB ($RESIDUE KiB)"
  echo "$SELF: command exit status : $STATUS"
  echo "$SELF: command             : $*"
  echo "$SELF: the peak is a LOWER BOUND — a spike shorter than ${INTERVAL}s is invisible to"
  echo "$SELF: this sampler, and df measures the WHOLE filesystem, so quote the interval"
  echo "$SELF: with the figure and run with the machine otherwise idle."
  echo "$SELF: ============================================================"
} >&2

exit "$STATUS"
