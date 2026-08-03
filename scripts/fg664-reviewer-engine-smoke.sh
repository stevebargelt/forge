#!/usr/bin/env bash
# fg664-reviewer-engine-smoke — the OPERATOR-RUN live proof for FG-664 AC 1:
# a READ-ONLY reviewer container can load the project's SHIPPING native database
# driver, and cannot fall back to the host's darwin build of it.
#
# WHY THIS EXISTS AT ALL — THE CIRCULARITY. FG-664 repairs the review-rechecker
# lane. The review of that change RUNS THROUGH THE VERY LANE BEING REPAIRED, so
# its own recheck is evidence of nothing in either direction: a passing recheck
# could be the old improvisation (a `node:sqlite` shim substituted for the real
# driver after an ABI mismatch), and a blocking one could be the new fail-closed
# refusal firing exactly as designed. Half (A)'s claim — that a reviewer
# container can load the project's real driver — is a property of a REAL kernel,
# a REAL image and a REAL mount shape. It has to be proven where those exist,
# host-side, outside the mechanism it repairs. That is this script.
#
# WHY A SCRIPT AND NOT A TEST. This repo has no test tier that can run a real
# Docker container: agent containers have no daemon, and no CI job builds or
# runs the agent image. The only test that could exist would be skip-capable,
# and A GREEN SKIP IS A FALSE PROOF — here doubly so, because the defect being
# closed is precisely a lane reporting a result it never actually executed. So
# this is proven the way FG-559 and FG-621 proved their own: once, host-side on
# macOS, against the candidate implementation and image, with the evidence block
# pasted into the FG-664 ticket. Deliberately OUTSIDE every npm tier (`test`,
# `test:unit`, `test:integration`, `test:worktree`) and outside CI. Do not add a
# CI job for it and do not make it a required check.
#
# COVERAGE BOUNDARY — READ THIS BEFORE QUOTING A GREEN RUN.
#   * This proves HALF (A) — the hazard is REMOVED — on the darwin + npm-lockfile
#     configuration ONLY. That is the only configuration where the hazard exists:
#     on Linux the host's `node_modules` already carry the container's platform,
#     so the ABI mismatch that triggered the substitution never arises. It is
#     therefore also the only configuration where (A)'s evidence is obtainable,
#     which is why this script REFUSES to run anywhere else rather than printing
#     a green that means something narrower than it reads as.
#   * It does NOT prove HALF (B) — that a lane which cannot load the real driver
#     FAILS CLOSED as `blocked_environment`. Half (B) holds on every host and is
#     covered by the unit suites (the dispatch-side refusal and the recheck
#     coverage classifier). A green run here must NEVER be presented as evidence
#     that a blocked lane blocks. The two halves are separate claims with
#     separate evidence, and neither substitutes for the other.
#   * It does NOT prove that forge EMITS this mount shape for a reviewer. That is
#     the job of the argv-shape assertions in
#     src/v2/fg664-reviewer-dependency-environment.test.ts (which run with an
#     injected fake docker and assert `/project:ro`, `PROJECT_MODE=ro`, every
#     lockfile-keyed volume `:ro`, and no read-write dependency mount). This
#     script pins what that shape DOES on a real kernel. The two halves together
#     are AC 1's coverage — the same split FG-621 uses.
#   * It does NOT and CANNOT prove that an agent which CAN load the real driver
#     will not fabricate output anyway. Engine-difference failures emit genuine
#     `not ok` lines, and the agent has passwordless root. This change removes
#     the environmental CAUSE and the incentive; it does not detect deliberate
#     fabrication, and nothing here should be read as claiming otherwise.
#
# IT RUNS FORGE'S OWN PROBE, NOT A SUBSTITUTE FOR IT. The load decision in P1/P2
# comes from executing `DEPENDENCY_PROBE_SCRIPT` — the exact string
# src/v2/spawn.ts hands its probe container — with the same
# FORGE_PROBE_ROOTS / FORGE_PROBE_INSTALL_ROOT / FORGE_PROBE_NONCE env the real
# dispatch passes, and adjudicating the report it prints under the nonce this run
# minted. An earlier cut of this script hand-rolled its own `require()` instead,
# which meant a green run said nothing about the script that actually gates a
# dispatch — the same "verification that does not exercise what ships" defect
# FG-664 exists to close. The hand-rolled round-trip query survives as a SECOND,
# corroborating probe (it proves the driver answers real SQL, which the shipped
# probe's dlopen deliberately does not ask); it is no longer the evidence.
#
# THE THREE PROBES, AND WHY THE NEGATIVE ONE IS LOAD-BEARING.
#   P1  With the dependency cache provisioned, run a container with the EXACT
#       mount shape forge's read-only reviewer planner emits — project `:ro`,
#       the lockfile-keyed volumes `:ro`, NO read-write dependency mount — and
#       assert FORGE'S OWN PROBE reports the project's real driver LOADED, that
#       the driver executes a real query and reports the CONTAINER's
#       `process.versions.modules`, and that the artifact behind it has ELF magic.
#   P2  The same container with the dependency volumes ABSENT: assert forge's
#       probe reports the driver UNLOADED, on a Mach-O artifact seen through the
#       read-only project bind. This reproduces the live defect that produced
#       FG-662's three false "still present" verdicts, and it is what makes P1
#       mean anything: without it, a green P1 could be the host's darwin-arm64
#       `node_modules` being read straight through the project bind.
#   P3  Assert the argv carries no read-write dependency mount, no
#       FORGE_NM_INSTALL_ROOT and no install command, and corroborate that in
#       the kernel (writes into `/project` and into the mounted `node_modules`
#       are REFUSED) — so FG-376's "reviewer containers never install" invariant
#       is visible in the proof rather than asserted in prose.
#
# FAILS CLOSED IS THE WHOLE POINT. Every missing prerequisite — not macOS, no
# docker binary, no reachable daemon, no image, no node, an unusable project dir,
# a driver package that is absent or not a darwin build — exits NONZERO with a
# `FATAL:` line naming what was missing. Nothing here skips. There is exactly one
# literal `exit 0` and it is the LAST LINE, reached only when every assertion
# below passed. (`--help` also exits 0, through `$HELP_EXIT_STATUS` — a usage
# request is not a proof outcome, and keeping the literal to one occurrence is
# what makes "the success exit is the last line" a checkable property.)
#
# HOST-SIDE EFFECTS, STATED UP FRONT. Unlike the FG-621 smoke, this script does
# NOT redirect FORGE_HOME. It must not: the dependency-cache LOCK and READY
# MARKER under `~/.forge/dependency-cache` are the real, shared, per-cache-key
# mutual exclusion (FG-376). A redirected FORGE_HOME would take a DIFFERENT lock
# and let this script's provisioner write the same docker volume a live dispatch
# was already installing into — the exact corruption that lock exists to prevent.
# So it uses the real one, and consequently:
#   * it may WAIT on a provisioner another forge process is running;
#   * on a cold cache key it runs ONE real `npm ci` provisioner container (the
#     product's own, via buildProvisionerDockerArgs) and, on success, leaves the
#     ready marker a subsequent real dispatch would have written anyway;
#   * on a cache key whose ready marker this run DISPROVES — marked ready, install
#     root empty, which is what a `docker volume prune` or a Docker Desktop
#     factory reset leaves behind — it invalidates that marker and re-provisions
#     ONCE through the product's own repairDisprovenDependencyCache, under the
#     same lock. That is the repair a real dispatch performs on the same
#     discovery, not something this script does instead of it;
#   * forge's own createDependencyMountpoints creates EMPTY `node_modules`
#     mountpoint directories in the project tree (gitignored, invisible to
#     `git status --porcelain --ignored`) — the same precondition every
#     read-only dispatch establishes.
# It never writes into the project's tracked tree and never mounts a dependency
# volume read-write for anything but the product's own provisioner container.
#
# USAGE
#   ./scripts/fg664-reviewer-engine-smoke.sh [--project-dir DIR] [--image IMAGE]
#                                            [--package NAME] [--runtime NAME]
#
#   --project-dir  the project whose reviewer environment is under proof
#                  (default: this repo)
#   --image        the candidate agent image (default: $FORGE_AGENT_IMAGE, else
#                  the resolved runtime's own image — build with ./docker/build.sh)
#   --package      the native dependency to prove loadable
#                  (default: better-sqlite3 — the project's shipping database
#                  driver, per learnings/decisions/2026-05-06_better-sqlite3-over-node-sqlite.md)
#   --runtime      the forge runtime to resolve the image and project mount path
#                  from (default: claude — the same auto-detection a dispatch does)
#
#   FORGE_SMOKE_RUN_ID   override the generated run id (evidence label)
#   FORGE_SMOKE_WORKDIR  parent dir for the throwaway work dir (default: mktemp -d)
#   FORGE_SMOKE_KEEP_WORK=1  keep the work dir (argv + container logs) even on a
#                  clean pass; it is ALWAYS kept when the run fails

set -euo pipefail

SELF="fg664-reviewer-engine-smoke"
PROJECT_DIR_ARG=""
IMAGE_ARG="${FORGE_AGENT_IMAGE:-}"
PKG="better-sqlite3"
RUNTIME_NAME="claude"

# See the header: --help is a usage request, not a proof outcome, so it exits 0
# without spending the one literal `exit 0` that marks an all-pass run.
HELP_EXIT_STATUS=0

fatal() {
  echo "$SELF: FATAL: $*" >&2
  echo "$SELF: this script fails closed — a missing prerequisite is never a pass." >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) [ $# -ge 2 ] || fatal "--project-dir needs a value"; PROJECT_DIR_ARG="$2"; shift 2 ;;
    --image)       [ $# -ge 2 ] || fatal "--image needs a value";       IMAGE_ARG="$2";       shift 2 ;;
    --package)     [ $# -ge 2 ] || fatal "--package needs a value";     PKG="$2";             shift 2 ;;
    --runtime)     [ $# -ge 2 ] || fatal "--runtime needs a value";     RUNTIME_NAME="$2";    shift 2 ;;
    -h|--help)     sed -n '2,135p' "$0"; exit "$HELP_EXIT_STATUS" ;;
    *)             fatal "unknown argument: $1 (see --help)" ;;
  esac
done

# ── Prerequisites, in the order that gives the most useful diagnostic ─────────

# The coverage boundary is enforced, not merely documented. On Linux the host's
# node_modules already carry the container's platform, so P2 (the load MUST
# fail without the volumes) would not reproduce the hazard — it would either
# pass for the wrong reason or fail for one. A proof that cannot fail for the
# reason it is about is not a proof, so this refuses rather than reports.
[ "$(uname -s)" = "Darwin" ] \
  || fatal "this proof is obtainable on macOS ONLY ($(uname -s) here). The hazard it closes — a darwin-arm64 \
host node_modules seen through a read-only project bind by a linux container — does not exist on this platform, \
so a run here would prove something other than what it prints. See the coverage boundary in the header."

command -v docker >/dev/null 2>&1 \
  || fatal "no 'docker' on PATH — this script runs real containers against the agent image."

docker info >/dev/null 2>&1 \
  || fatal "no reachable Docker daemon ('docker info' failed) — run this on the macOS host, not in an agent container."

# An EXPLICIT image is checked here, before anything slower runs; the default is
# read off the resolved runtime below and checked at the same gate. Both go
# through the same fatal, so "the image is absent" is reported the same way
# whichever way the operator named it.
if [ -n "$IMAGE_ARG" ]; then
  docker image inspect "$IMAGE_ARG" >/dev/null 2>&1 \
    || fatal "candidate image '$IMAGE_ARG' is absent — build it with ./docker/build.sh, or pass a different --image."
fi

command -v node >/dev/null 2>&1 \
  || fatal "no 'node' on PATH — the mount shape is derived from forge's OWN planners, which run under node."
HOST_NODE="$(node -p 'process.version + " modules=" + process.versions.modules' 2>/dev/null || echo unknown)"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd -P)"
PROJECT_DIR="$(cd "${PROJECT_DIR_ARG:-$REPO_ROOT}" 2>/dev/null && pwd -P)" \
  || fatal "project dir '${PROJECT_DIR_ARG:-$REPO_ROOT}' does not exist."

[ -d "$REPO_ROOT/node_modules/tsx" ] \
  || fatal "$REPO_ROOT/node_modules/tsx is absent — the plan is computed by forge's OWN \
planDependencyVolumes / buildProvisionerDockerArgs, not by a hand-rolled volume-name guess. Run 'npm install' in $REPO_ROOT."

# A path holding a quote or a colon cannot be expressed in a `docker -v` spec or
# quoted safely into the in-container probe strings. Refuse rather than emit an
# argv that means something other than what it reads as.
case "$PROJECT_DIR" in
  *:*|*\'*|*\"*) fatal "project dir contains a ':' or a quote ($PROJECT_DIR); a docker -v spec cannot express it." ;;
esac

case "$PKG" in
  ""|*/*|*:*|*\'*|*\"*|*' '*) fatal "--package '$PKG' is not a bare package name; it is interpolated into a container command." ;;
esac

[ -f "$PROJECT_DIR/package-lock.json" ] \
  || fatal "$PROJECT_DIR/package-lock.json is absent. The lockfile-keyed dependency cache — the whole mechanism \
under proof — is npm-lockfile-gated; without one, forge mounts no dependency volume and there is nothing here to prove."

# The project must be a plain repository, not a linked worktree or an FG-621
# private clone. Those substrates add a read-only parent-.git bind to the
# reviewer's mount set (planWorktreeGitMounts), which this script deliberately
# does not model — their boundaries are proven by the FG-559 and FG-621 smokes.
# Running here anyway would emit an INCOMPLETE reviewer shape and call it exact.
[ -d "$PROJECT_DIR/.git" ] \
  || fatal "$PROJECT_DIR/.git is not a directory — this proof models a plain project mount, not the worktree/clone \
substrates (whose extra read-only parent-.git bind is proven by scripts/fg621-clone-boundary-smoke.sh)."

# THE HAZARD PRECONDITION. P2's negative is only the live defect if the driver
# the container sees through the project bind really is the host's darwin build.
# Assert that here, on the host, before any container runs — otherwise P2 could
# "fail to load" merely because nothing was there to load, and the reproduction
# would be theatre.
HOST_ARTIFACT="$(find "$PROJECT_DIR/node_modules/$PKG" -name '*.node' -type f -print -quit 2>/dev/null || true)"
[ -n "$HOST_ARTIFACT" ] \
  || fatal "no compiled .node artifact under $PROJECT_DIR/node_modules/$PKG — run 'npm install' in $PROJECT_DIR. \
Without the host's own build of the driver, P2 cannot reproduce the ABI mismatch it exists to reproduce."
HOST_MAGIC="$(od -An -tx1 -N4 < "$HOST_ARTIFACT" | tr -s ' ' | sed 's/^ //;s/ $//')"
case "$HOST_MAGIC" in
  cf\ fa\ ed\ fe|ce\ fa\ ed\ fe|ca\ fe\ ba\ be|be\ ba\ fe\ ca) : ;;
  *) fatal "$HOST_ARTIFACT has magic bytes [$HOST_MAGIC], which is not a Mach-O/universal binary. The host build of \
$PKG is what P2 must fail on; if it is not a darwin binary, this host is not the configuration the hazard lives on." ;;
esac

RUN_ID="${FORGE_SMOKE_RUN_ID:-fg664-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
TASK_ID="task-$RUN_ID"

WORK="$(mktemp -d "${FORGE_SMOKE_WORKDIR:-${TMPDIR:-/tmp}}/fg664-smoke.XXXXXX")" \
  || fatal "cannot create a work dir."
# A proof whose diagnostic evidence deletes itself on failure cannot be acted on:
# the argv, the plan and both container logs live under $WORK, and a failed
# assertion is exactly when someone needs to read them. Kept on ANY nonzero exit
# (a failed assertion or an early fatal), removed only on a clean all-pass run.
cleanup() {
  _rc=$?
  if [ "$_rc" -ne 0 ] || [ "${FAILURES:-0}" -ne 0 ] || [ "${FORGE_SMOKE_KEEP_WORK:-0}" = "1" ]; then
    echo "$SELF: work dir PRESERVED for diagnosis: $WORK" >&2
    echo "  P1 argv exactly as handed to docker (one element per line): $WORK/p1.log.argv" >&2
    echo "  P1/P2 container logs: $WORK/p1.log $WORK/p2.log" >&2
    return
  fi
  rm -rf "$WORK" || true
}
trap cleanup EXIT

OUT="$WORK/plan"
mkdir -p "$OUT"

# ── The mount shape, computed by THE PRODUCT ─────────────────────────────────
#
# planDependencyVolumes is the exact function spawn.ts's reviewer branch calls
# to decide what a read-only dispatch mounts, and buildProvisionerDockerArgs is
# the exact function that builds the one container allowed to write those
# volumes. Deriving both here — instead of reconstructing volume names from the
# lockfile hash by hand — is the difference between evidence and theatre: a
# hand-rolled name that drifted from dependencyVolumeName would mount an EMPTY
# volume, P1 would fail, and the failure would be about this script.
#
# The same reasoning is why DEPENDENCY_PROBE_SCRIPT is read out of spawn.ts here
# rather than transcribed: a transcription is a copy that can drift, and a copy
# that drifted would prove something about the copy.

HELPER='
const projectDir = process.env.FG664_PROJECT_DIR;
const outDir = process.env.FG664_OUT;
const fs = await import("node:fs");
const { loadRuntime } = await import("./src/v2/loader.js");
const { resolveProjectContainerPath, buildProvisionerDockerArgs, DEPENDENCY_PROBE_SCRIPT } = await import("./src/v2/spawn.js");
const deps = await import("./src/v2/dependency-provisioning.js");
const base = loadRuntime(process.env.FG664_RUNTIME, { projectDir });
const runtime = process.env.FG664_IMAGE ? { ...base, image: process.env.FG664_IMAGE } : base;
const projectContainerPath = resolveProjectContainerPath(runtime) ?? "/project";
// FG-627/FG-628: docker cannot mkdir a mountpoint inside a read-only rootfs, so
// every read-only dispatch establishes this precondition against the tree it is
// about to bind. Same call, same tree, same reason.
deps.createDependencyMountpoints(projectDir);
const plan = deps.planDependencyVolumes(projectDir, projectContainerPath);
const provisionerArgs = buildProvisionerDockerArgs(
  runtime,
  { TASK_ID: process.env.FG664_TASK_ID, PROJECT_DIR: projectDir, CANONICAL_PROJECT_DIR: projectDir },
  plan,
);
const write = (name, text) => fs.writeFileSync(outDir + "/" + name, text);
write("image", runtime.image);
write("pcp", projectContainerPath);
write("cache_key", plan.lockfileHash);
write("ready", deps.isDependencyCacheReady(plan.lockfileHash) ? "1" : "0");
write("ready-marker", deps.readDependencyCacheMarker(plan.lockfileHash) ?? "");
write("ro-mounts", plan.volumes.map((v) => v.name + ":" + v.containerPath + ":ro").join("\n"));
write("volume-names", plan.volumes.map((v) => v.name).join("\n"));
write("root-volume", plan.volumes.find((v) => v.containerPath === plan.installRoot + "/node_modules")?.name ?? "");
write("provisioner-argv", provisionerArgs.join("\n"));
// The SHIPPED probe, and the two env values buildDependencyProbeDockerArgs
// derives for it. The nonce is minted per run by the caller, as the resolver does.
write("probe-script", DEPENDENCY_PROBE_SCRIPT);
write("probe-roots", plan.volumes.map((v) => v.containerPath).join(":"));
write("probe-install-root", plan.installRoot + "/node_modules");
const runProvisioner = async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("docker", provisionerArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(process.env.FG664_PROVISION_LOG, (r.stdout || "") + (r.stderr || ""));
  const tail = (r.stderr || "").trim().split("\n").slice(-8).join(" | ");
  return { exitCode: r.status === null ? 1 : r.status, stderrTail: tail };
};
if (process.env.FG664_MODE === "provision") {
  const outcome = await deps.provisionDependencyCache(plan.lockfileHash, runProvisioner);
  write("provision-outcome", outcome.outcome);
  write("provision-error", outcome.outcome === "failed" ? outcome.error : "");
}
// The marker this run DISPROVED (the caller measured the install root empty for a
// key marked ready) is repaired through the product itself: the same
// invalidate-then-reprovision, under the same per-cache-key lock, that
// resolveDependencyEnvironment runs on a real dispatch. Reimplementing it here
// would prove something about this script.
if (process.env.FG664_MODE === "repair") {
  const outcome = await deps.repairDisprovenDependencyCache(
    plan.lockfileHash,
    process.env.FG664_DISPROVEN_MARKER,
    runProvisioner,
  );
  write("repair-outcome", outcome.outcome);
  write("repair-error", outcome.outcome === "failed" ? outcome.error : "");
}
'

run_helper() { # $1 = mode (plan|provision)
  (
    cd "$REPO_ROOT" \
      && FG664_PROJECT_DIR="$PROJECT_DIR" \
         FG664_OUT="$OUT" \
         FG664_RUNTIME="$RUNTIME_NAME" \
         FG664_IMAGE="$IMAGE_ARG" \
         FG664_TASK_ID="$TASK_ID" \
         FG664_MODE="$1" \
         FG664_DISPROVEN_MARKER="${DISPROVEN_MARKER:-}" \
         FG664_PROVISION_LOG="$WORK/provisioner.log" \
         node --import tsx --input-type=module -e "$HELPER"
  )
}

run_helper plan \
  || fatal "forge's own planners could not describe this dispatch (loadRuntime/planDependencyVolumes/buildProvisionerDockerArgs \
failed above). Pass --runtime if '$RUNTIME_NAME' is not the runtime this host dispatches with."

IMAGE="$(cat "$OUT/image")"
PCP="$(cat "$OUT/pcp")"
CACHE_KEY="$(cat "$OUT/cache_key")"
CACHE_READY="$(cat "$OUT/ready")"
PROBE_SCRIPT="$(cat "$OUT/probe-script")"
PROBE_ROOTS="$(cat "$OUT/probe-roots")"
PROBE_INSTALL_ROOT="$(cat "$OUT/probe-install-root")"

# Minted here, per run, exactly as resolveDependencyEnvironment mints it per
# dispatch. A report that does not carry it back is not this run's report.
PROBE_NONCE="$(node -p 'require("crypto").randomBytes(16).toString("hex")')" \
  || fatal "could not mint a probe nonce."

[ -n "$PROBE_SCRIPT" ] || fatal "spawn.ts exported no DEPENDENCY_PROBE_SCRIPT — this proof runs FORGE's probe, not a substitute."
[ -n "$PROBE_ROOTS" ] || fatal "forge's plan names no dependency container paths for the probe to scan."
[ -n "$IMAGE" ] || fatal "the resolved runtime declares no image."
[ -s "$OUT/ro-mounts" ] || fatal "forge's plan for $PROJECT_DIR contains NO dependency volumes — there is no read-only \
dependency mount to prove anything about."

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fatal "candidate image '$IMAGE' is absent — build it with ./docker/build.sh, or pass --image."

# ── Provision the cache, through the product, under the product's lock ───────

PROVISIONED="reused an already-ready cache key"
if [ "$CACHE_READY" != "1" ]; then
  echo "==> cache key $CACHE_KEY is cold — running forge's own provisioner (npm ci in a container; this can take minutes)"
  if ! run_helper provision; then
    if [ -f "$WORK/provisioner.log" ]; then
      echo "$SELF: provisioner output tail:" >&2
      tail -n 40 "$WORK/provisioner.log" >&2
    fi
    fatal "the provisioning helper died before it could report an outcome."
  fi
  if [ "$(cat "$OUT/provision-outcome" 2>/dev/null || echo failed)" != "ready" ]; then
    if [ -f "$WORK/provisioner.log" ]; then
      echo "$SELF: provisioner output tail:" >&2
      tail -n 40 "$WORK/provisioner.log" >&2
    fi
    fatal "dependency provisioning FAILED for cache key $CACHE_KEY: $(cat "$OUT/provision-error" 2>/dev/null || true)"
  fi
  PROVISIONED="provisioned cold, in this run, by forge's own provisioner container"
fi

# ── The ready marker is a claim about the past, and it gets checked ──────────
#
# A ready marker records that an install SUCCEEDED for this lockfile hash. The
# volumes it speaks for are separate docker objects that a `docker volume prune`,
# a `docker volume rm`, or a Docker Desktop factory reset removes independently —
# the markers live under ~/.forge and survive all three. Mounting an absent volume
# gives docker an EMPTY anonymous one, and an empty install root reads to the
# probe as "no native packages, nothing failed to load": P1 fails with a mystery.
#
# So the volume is ASKED, before anything slower runs. A marker the volume
# disproves is repaired through the product — forge's own
# repairDisprovenDependencyCache, which invalidates the marker and re-provisions
# once under the FG-376 per-cache-key lock, exactly as a real dispatch does when
# its probe finds the same thing. This used to tell the operator to go delete a
# file under ~/.forge by hand; that instruction was the same closed loop the
# product had, written down.
ROOT_VOLUME="$(cat "$OUT/root-volume")"
[ -n "$ROOT_VOLUME" ] || fatal "forge's plan names no install-root dependency volume — there is nothing to check for emptiness."

# The count is printed behind a marker and read back with sed rather than piped
# through `tr -cd 0-9`: the image's entrypoint can print its own lines (the FG-608
# backlog-authority warning, for one), and a digit-scraping read would splice them
# into the number. Same reason parseDependencyProbeOutput scans for a shape.
install_root_entries() { # -> the number of entries in the install-root volume
  docker run --rm -e FORGE_NO_BROWSER=1 -v "$ROOT_VOLUME:/nm:ro" "$IMAGE" \
    sh -c 'printf "FG664_ENTRIES=%s\n" "$(ls -A /nm 2>/dev/null | wc -l | tr -cd "0-9")"' 2>/dev/null \
    | sed -n 's/^FG664_ENTRIES=\([0-9][0-9]*\)$/\1/p' \
    | tail -n 1
}

if [ "$CACHE_READY" = "1" ]; then
  ENTRIES="$(install_root_entries)"
  [ -n "$ENTRIES" ] || fatal "could not count the entries in dependency volume '$ROOT_VOLUME' (docker run failed)."
  if [ "$ENTRIES" -eq 0 ]; then
    DISPROVEN_MARKER="$(cat "$OUT/ready-marker")"
    [ -n "$DISPROVEN_MARKER" ] || fatal "cache key $CACHE_KEY reads ready but carries no marker value to invalidate."
    echo "==> cache key $CACHE_KEY is marked ready but its install root is EMPTY (the volume was pruned or reset)."
    echo "==> invalidating the disproven marker and re-provisioning ONCE through forge, under its own lock."
    run_helper repair || fatal "the repair helper died before it could report an outcome."
    REPAIR_OUTCOME="$(cat "$OUT/repair-outcome" 2>/dev/null || echo failed)"
    if [ "$REPAIR_OUTCOME" = "failed" ]; then
      if [ -f "$WORK/provisioner.log" ]; then
        echo "$SELF: provisioner output tail:" >&2
        tail -n 40 "$WORK/provisioner.log" >&2
      fi
      fatal "re-provisioning cache key $CACHE_KEY failed: $(cat "$OUT/repair-error" 2>/dev/null || true)"
    fi
    ENTRIES="$(install_root_entries)"
    [ "${ENTRIES:-0}" -gt 0 ] \
      || fatal "cache key $CACHE_KEY was re-provisioned ($REPAIR_OUTCOME) and its install root is STILL empty — \
this is not a stale marker, and P1 below could not be attributed to the mounted cache."
    PROVISIONED="re-provisioned after a DISPROVEN ready marker was invalidated ($REPAIR_OUTCOME)"
  fi
fi

# Every OTHER member's volume still has to exist before the reviewer argv binds
# it; an absent one would silently become a fresh empty anonymous volume.
while IFS= read -r vol; do
  [ -n "$vol" ] || continue
  docker volume inspect "$vol" >/dev/null 2>&1 \
    || fatal "cache key $CACHE_KEY is marked ready but docker volume '$vol' does not exist (pruned?), while its \
install root is populated — so the self-healing repair above does not fire. Run 'forge dependency-cache prune' and \
re-run to re-provision the whole key."
done < "$OUT/volume-names"

# ── The reviewer argv, and the probe program it carries ──────────────────────
#
# THE MOUNT SHAPE UNDER PROOF: the project bound `:ro`, every lockfile-keyed
# dependency volume bound `:ro` at its planned path INSIDE that read-only bind,
# and nothing else. No read-write dependency mount, no FORGE_NM_INSTALL_ROOT, no
# install command — which is FG-376's invariant, asserted on this argv by P3
# below and corroborated in the kernel by the two refusal probes.

REVIEWER_MOUNTS=( -v "$PROJECT_DIR:$PCP:ro" )
DEP_MOUNTS=()
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  REVIEWER_MOUNTS+=( -v "$spec" )
  DEP_MOUNTS+=( "$spec" )
done < "$OUT/ro-mounts"

# The load program, passed by ENV rather than interpolated into the probe
# command, so no quoting layer can mangle it. It does not merely `require` the
# driver: it opens a database, writes, reads back, and asks SQLITE ITSELF for
# its version — a shim that only satisfied `require` would still be caught.
LOADER='
const pkg = process.env.FG664_PKG;
const Driver = require(pkg);
const db = new Driver(":memory:");
db.exec("create table fg664(x integer)");
db.prepare("insert into fg664 values (?)").run(664);
const row = db.prepare("select x from fg664").get();
const ver = db.prepare("select sqlite_version() as v").get();
console.log(JSON.stringify({
  driver: pkg,
  resolved: require.resolve(pkg),
  abi: process.versions.modules,
  node: process.version,
  platform: process.platform + "-" + process.arch,
  roundtrip: row.x,
  sqlite: ver.v,
}));
'

# Every probe is REPORT-ONLY: it records that it started, what it ran, its
# output and its exit code, and never decides anything. The host adjudicates
# from that record. That is what separates "refused" from "never ran" — a probe
# whose command name is a typo produces a 127/"not found" record the host
# rejects, and a probe the container never reached produces no PROBE_BEGIN at
# all. A container-side `set -e` or an early exit therefore cannot turn a
# missing assertion into a pass. (Same discipline as the FG-621 smoke.)
CONTAINER_SCRIPT=$(cat <<'CEOF'
set -u

probe() {
  _id="$1"; _cmd="$2"
  echo "PROBE_BEGIN $_id"
  echo "PROBE_CMD $_id | $_cmd"
  _out="$(sh -c "$_cmd" 2>&1)"; _rc=$?
  printf '%s\n' "$_out" | sed "s/^/PROBE_OUT $_id | /"
  echo "PROBE_RC $_id $_rc"
}

# Control: if node is not here, nothing below means anything either way.
probe "${FG664_PROBE}_node_present" 'command -v node'

# What the container ACTUALLY resolves the driver to, and what kind of binary
# that is. The magic bytes are the whole argument: 7f 45 4c 46 is ELF (a linux
# build, which can only have come from the mounted volume), cf fa ed fe is
# Mach-O (the host's darwin build, seen straight through the project bind).
probe "${FG664_PROBE}_driver_artifact" 'f=$(find "$FG664_PCP/node_modules/$FG664_PKG" -name "*.node" -type f -print -quit 2>/dev/null); echo "artifact=$f"; od -An -tx1 -N4 < "$f"'

# FORGE'S OWN PROBE — the string spawn.ts hands its probe container, run with
# the env buildDependencyProbeDockerArgs derives, under this run's nonce. This
# is the evidence; everything else about the load corroborates it.
probe "${FG664_PROBE}_forge_probe" 'cd "$FG664_PCP" && node -e "$FG664_PROBE_SCRIPT"'

# Corroboration, not evidence: require, open, write, read back, and ask sqlite
# its version. Forge's probe deliberately stops at dlopen (it never executes a
# package entry point), so this is the one assertion that the driver answers
# real SQL rather than merely mapping into the process.
probe "${FG664_PROBE}_driver_load" 'cd "$FG664_PCP" && node -e "$FG664_LOADER"'

# FG-376 / the `:ro` enforcement primitive, corroborated in the kernel rather
# than inferred from the argv: neither the project nor the dependency mount is
# writable by a container whose user has passwordless root.
probe "${FG664_PROBE}_project_write" 'touch "$FG664_PCP/fg664-smoke-intruder"'
probe "${FG664_PROBE}_node_modules_write" 'touch "$FG664_PCP/node_modules/fg664-smoke-intruder"'

# The install triggers the entrypoint gates on. All three MUST be empty: their
# presence is what makes a container install, and a reviewer never installs.
probe "${FG664_PROBE}_no_install_env" 'echo "FORGE_NM_INSTALL_ROOT=[${FORGE_NM_INSTALL_ROOT:-}] FORGE_NM_SHADOW=[${FORGE_NM_SHADOW:-}] FORGE_NM_SHADOW_PATHS=[${FORGE_NM_SHADOW_PATHS:-}]"'

echo "CONTAINER_DONE"
CEOF
)

# PROBE_ARGS is a global rather than a `local args=(...)`: bash 3.2 — still
# /bin/bash on macOS, and this script's target host — is unreliable with a
# compound array assignment to a `local`. Nothing else reads it.
PROBE_ARGS=()
run_probe_container() { # $1 = probe prefix (p1|p2), $2 = log path, $3.. = extra docker args
  local prefix="$1" log="$2" rc; shift 2
  PROBE_ARGS=(
    run --rm
    -e FORGE_NO_BROWSER=1
    -e "FG664_PROBE=$prefix"
    -e "FG664_PCP=$PCP"
    -e "FG664_PKG=$PKG"
    -e "FG664_LOADER=$LOADER"
    # Forge's own probe, and the env buildDependencyProbeDockerArgs derives for it.
    -e "FG664_PROBE_SCRIPT=$PROBE_SCRIPT"
    -e "FORGE_PROBE_ROOTS=$PROBE_ROOTS"
    -e "FORGE_PROBE_INSTALL_ROOT=$PROBE_INSTALL_ROOT"
    -e "FORGE_PROBE_NONCE=$PROBE_NONCE"
    "$@"
    -w "$PCP"
    "$IMAGE"
    bash -c "$CONTAINER_SCRIPT"
  )
  printf '%s\n' "${PROBE_ARGS[@]}" > "$log.argv"
  # `&& rc=0 || rc=$?`, never a set +e / set -e sandwich around the call: a
  # function that re-enables errexit and THEN returns nonzero kills the caller
  # before it can read the exit code — which for a failed container is exactly
  # the case this script has to keep reporting on.
  docker "${PROBE_ARGS[@]}" > "$log" 2>&1 && rc=0 || rc=$?
  return "$rc"
}

P1LOG="$WORK/p1.log"
P2LOG="$WORK/p2.log"

echo "==> P1: reviewer mount shape WITH the lockfile-keyed dependency volumes (:ro)"
P1_RC=0
run_probe_container p1 "$P1LOG" "${REVIEWER_MOUNTS[@]}" || P1_RC=$?
# P1's argv as an ARRAY, kept because the P2 run below overwrites PROBE_ARGS.
# The env assertion has to read elements, not the flattened text — see p3 below.
P1_ARGS=( "${PROBE_ARGS[@]}" )

echo "==> P2: the same container with the dependency volumes ABSENT (the live defect)"
P2_RC=0
run_probe_container p2 "$P2LOG" -v "$PROJECT_DIR:$PCP:ro" || P2_RC=$?

# ── Adjudication ─────────────────────────────────────────────────────────────

FAILURES=0
RESULTS=""
CLOG="$P1LOG"

record() { # id verdict detail
  RESULTS="${RESULTS}$(printf '%-30s %-4s %s' "$1" "$2" "$3")
"
  [ "$2" = "PASS" ] || FAILURES=$((FAILURES + 1))
}

# Trimming happens in the shell, never with `| head`. head exits as soon as it
# has its lines and SIGPIPEs whatever is still writing; under this script's
# pipefail+errexit that is a silent 141 death whose likelihood grows with the
# input — and a probe's output is whatever the container chose to print.
first_line() { printf '%s' "${1%%$'\n'*}"; }

probe_ran() { grep -q "^PROBE_BEGIN $1\$" "$CLOG"; }
probe_cmd() { first_line "$(sed -n "s/^PROBE_CMD $1 | //p" "$CLOG")"; }
probe_out() { sed -n "s/^PROBE_OUT $1 | //p" "$CLOG"; }
probe_rc()  { first_line "$(sed -n "s/^PROBE_RC $1 //p" "$CLOG")"; }

# `grep -q <<<` and not `printf | grep -q`: grep -q exits at the FIRST match and
# SIGPIPEs the writer, which pipefail turns into a nonzero pipeline — safe
# inside an `if`, but a matched pattern in a long output would then read as NO
# match and be recorded wrongly. No pipe, no race.

# A probe record that exists and carries an exit code, or a recorded failure
# explaining which of those was missing. Every adjudicator starts here, so
# "never ran" and "died mid-probe" can never be scored as an outcome.
#
# It reports through a GLOBAL, not through stdout. `rc="$(probe_status ...)"`
# would run it in a command substitution — a subshell — and the FAIL it records
# there would be discarded along with the subshell: a probe that never ran would
# vanish from the results and from the failure count instead of failing the run.
# That is the one bug class this whole file exists to not have.
PROBE_RC_VALUE=""
probe_status() { # id label -> sets PROBE_RC_VALUE; nonzero (and records FAIL) when unusable
  local id="$1" label="$2" rc
  if ! probe_ran "$id"; then
    record "$id" FAIL "NEVER RAN — no PROBE_BEGIN in the container log ($label)"; return 1
  fi
  rc="$(probe_rc "$id")"
  if [ -z "$rc" ]; then
    record "$id" FAIL "NO EXIT CODE — the container script died inside this probe ($label)"; return 1
  fi
  PROBE_RC_VALUE="$rc"
  return 0
}

expect_success() { # id label [expected-substring]
  local id="$1" label="$2" want="${3:-}" rc out
  probe_status "$id" "$label" || return 0
  rc="$PROBE_RC_VALUE"
  out="$(probe_out "$id")"
  if [ "$rc" -ne 0 ]; then
    record "$id" FAIL "FAILED rc=$rc ($label): $(first_line "$out")"; return
  fi
  if [ -n "$want" ] && ! grep -qF "$want" <<<"$out"; then
    record "$id" FAIL "succeeded but output does not contain '$want' ($label): $(first_line "$out")"; return
  fi
  record "$id" PASS "ok rc=0: $(first_line "$out")"
}

REFUSAL_RE='[Rr]ead-only file system|Permission denied|Operation not permitted|cannot touch|cannot create'

expect_refused() { # id label
  local id="$1" label="$2" rc out
  probe_status "$id" "$label" || return 0
  rc="$PROBE_RC_VALUE"
  out="$(probe_out "$id")"
  if [ "$rc" -eq 0 ]; then
    record "$id" FAIL "NOT REFUSED — the write SUCCEEDED (rc=0): $label"; return
  fi
  if [ "$rc" -eq 127 ] || grep -Eq 'not found|command not found' <<<"$out"; then
    record "$id" FAIL "COMMAND DID NOT RUN (rc=$rc, 'not found') — a typo must never read as a refusal: $label"; return
  fi
  if grep -Eq "$REFUSAL_RE" <<<"$out"; then
    record "$id" PASS "refused rc=$rc: $(first_line "$out")"
  else
    record "$id" FAIL "rc=$rc but no recognizable refusal message — investigate: $(first_line "$out")"
  fi
}

# The messages a genuine engine/ABI mismatch produces. As with expect_refused, a
# match is not what makes P2 pass on its own — a nonzero exit that is NOT a
# missing-binary error is — but requiring a recognizable dlopen/format failure
# keeps a load that failed for some unrelated reason from being read as the
# reproduction of the defect.
DLOPEN_RE='ERR_DLOPEN_FAILED|invalid ELF header|wrong ELF class|Exec format error|not a valid Win32|mach-o|Mach-O|NODE_MODULE_VERSION|was compiled against a different Node.js version|Cannot find module|MODULE_NOT_FOUND|dlopen'

expect_load_failed() { # id label
  local id="$1" label="$2" rc out
  probe_status "$id" "$label" || return 0
  rc="$PROBE_RC_VALUE"
  out="$(probe_out "$id")"
  if [ "$rc" -eq 0 ]; then
    record "$id" FAIL "THE DRIVER LOADED WITHOUT THE DEPENDENCY VOLUMES — P1's green would then prove nothing, \
because the container can reach a working driver through the project bind alone: $label"; return
  fi
  if [ "$rc" -eq 127 ] || grep -Eq 'not found|command not found' <<<"$out"; then
    record "$id" FAIL "COMMAND DID NOT RUN (rc=$rc, 'not found') — a typo must never read as a reproduction: $label"; return
  fi
  if grep -Eq "$DLOPEN_RE" <<<"$out"; then
    record "$id" PASS "load failed rc=$rc as required: $(first_line "$out")"
  else
    record "$id" FAIL "rc=$rc but no recognizable native-load failure — the load may have failed for an unrelated \
reason, which does not reproduce the defect: $(first_line "$out")"; return
  fi
}

expect_host() { # id ok? label detail
  if [ "$2" = "0" ]; then record "$1" PASS "$3"; else record "$1" FAIL "$3 — $4"; fi
}

# Forge's probe prints ONE JSON line carrying this run's nonce. Everything below
# reads that line and nothing else — a probe that never ran, exited nonzero, or
# printed a report bound to some other nonce is a FAIL, never a verdict.
FORGE_PROBE_REPORT=""
forge_probe_report() { # id -> sets FORGE_PROBE_REPORT; nonzero (and records FAIL) when unusable
  local id="$1" label="$2" rc out line
  FORGE_PROBE_REPORT=""
  probe_status "$id" "$label" || return 1
  rc="$PROBE_RC_VALUE"
  out="$(probe_out "$id")"
  if [ "$rc" -ne 0 ]; then
    record "$id" FAIL "forge's probe script exited $rc ($label): $(first_line "$out")"; return 1
  fi
  line="$(grep -F "\"nonce\":\"$PROBE_NONCE\"" <<<"$out" || true)"
  if [ -z "$line" ]; then
    record "$id" FAIL "forge's probe printed no report carrying THIS run's nonce ($label): $(first_line "$out")"; return 1
  fi
  FORGE_PROBE_REPORT="$line"
  return 0
}

# Whether the report says $PKG loaded. Deliberately a per-package read rather
# than "no unloaded packages anywhere": the gate refuses on the natives the
# PROJECT declares, and this proof is about one named driver.
forge_probe_says_loaded() { # report -> 0 when $PKG is present with loaded:true
  node -e '
    const report = JSON.parse(process.argv[1]);
    const pkg = (report.packages || []).find((p) => p.name === process.argv[2]);
    if (!pkg) { console.log("ABSENT"); process.exit(2); }
    console.log(pkg.loaded ? "LOADED" : "UNLOADED " + (pkg.error || "no error recorded"));
    process.exit(pkg.loaded ? 0 : 1);
  ' "$1" "$PKG" 2>&1
}

if [ "$P1_RC" -eq 122 ]; then
  echo "$SELF: the agent entrypoint's FG-559 git probe refused the project mount (exit 122)." >&2
fi
if [ "$P1_RC" -eq 123 ]; then
  echo "$SELF: the container attempted a DEPENDENCY INSTALL and failed (exit 123) — the reviewer shape must never \
install at all. That is an FG-376 violation, not an environment problem." >&2
fi

# ---- P1: the driver loads, from the container's own ELF artifact ------------
CLOG="$P1LOG"
if grep -q '^CONTAINER_DONE$' "$P1LOG"; then
  record p1_container_completed PASS "the P1 probe program reached its end (docker rc=$P1_RC)"
else
  record p1_container_completed FAIL "the P1 probe program did NOT reach its end (docker rc=$P1_RC) — every verdict below is suspect"
fi
expect_success p1_node_present "CONTROL: node is on PATH in the container"
expect_success p1_driver_artifact \
  "P1: the resolved $PKG artifact is an ELF binary — it came from the mounted volume, not the darwin host tree" \
  "7f 45 4c 46"

# THE EVIDENCE: forge's own probe, run in the reviewer's mount shape, says the
# driver loaded. This is the same script, the same env and the same nonce
# discipline a real read-only dispatch gates on.
P1_FORGE_STATUS=""
if forge_probe_report p1_forge_probe "P1: FORGE'S OWN probe attests the engine in the reviewer mount shape"; then
  P1_FORGE_STATUS="$(forge_probe_says_loaded "$FORGE_PROBE_REPORT")" && P1_FORGE_RC=0 || P1_FORGE_RC=$?
  if [ "$P1_FORGE_RC" -eq 0 ]; then
    record p1_forge_probe PASS "forge's probe reports $PKG LOADED under this run's nonce"
  else
    record p1_forge_probe FAIL "forge's probe reports $PKG $P1_FORGE_STATUS — the gate that ships would REFUSE this dispatch"
  fi
fi

expect_success p1_driver_load \
  "P1 (corroboration): the project's REAL driver opens a database and answers a query (AC 1)" \
  "\"driver\":\"$PKG\""

# The resolution path and the container's ABI are read off the SAME probe record
# rather than re-run, so the evidence block cannot report a different execution
# than the one that was adjudicated.
P1_LOAD_JSON="$(probe_out p1_driver_load | grep -F '{"driver"' || true)"
if grep -qF "\"resolved\":\"$PCP/node_modules/$PKG" <<<"$P1_LOAD_JSON"; then
  record p1_resolved_from_mount PASS "the driver resolved beneath $PCP/node_modules/$PKG"
else
  record p1_resolved_from_mount FAIL "the driver did not resolve beneath $PCP/node_modules/$PKG: ${P1_LOAD_JSON:-<no load output>}"
fi
CONTAINER_ABI="$(sed -n 's/.*"abi":"\([0-9]*\)".*/\1/p' <<<"$P1_LOAD_JSON")"
CONTAINER_NODE="$(sed -n 's/.*"node":"\([^"]*\)".*/\1/p' <<<"$P1_LOAD_JSON")"
CONTAINER_PLATFORM="$(sed -n 's/.*"platform":"\([^"]*\)".*/\1/p' <<<"$P1_LOAD_JSON")"
CONTAINER_SQLITE="$(sed -n 's/.*"sqlite":"\([^"]*\)".*/\1/p' <<<"$P1_LOAD_JSON")"
if [ -n "$CONTAINER_ABI" ]; then
  record p1_container_abi_reported PASS "the driver reported the CONTAINER's ABI: modules=$CONTAINER_ABI (node $CONTAINER_NODE, $CONTAINER_PLATFORM)"
else
  record p1_container_abi_reported FAIL "the load produced no process.versions.modules — there is no engine identity to record"
fi

# ---- P3, kernel half: nothing in the reviewer shape is writable -------------
expect_refused p1_project_write "P3: the project mount is read-only to a root-capable container"
expect_refused p1_node_modules_write "P3: the dependency volume is read-only to a root-capable container"
expect_success p1_no_install_env \
  "P3/FG-376: no install trigger reached the reviewer container" \
  "FORGE_NM_INSTALL_ROOT=[] FORGE_NM_SHADOW=[] FORGE_NM_SHADOW_PATHS=[]"

# ---- P2: without the volumes, the load MUST fail ---------------------------
CLOG="$P2LOG"
if grep -q '^CONTAINER_DONE$' "$P2LOG"; then
  record p2_container_completed PASS "the P2 probe program reached its end (docker rc=$P2_RC)"
else
  record p2_container_completed FAIL "the P2 probe program did NOT reach its end (docker rc=$P2_RC) — a load that never ran is not a load that failed"
fi
expect_success p2_node_present "CONTROL: node is on PATH in the P2 container too, so a failed load is the driver's, not the container's"
expect_success p2_driver_artifact \
  "P2: an artifact IS visible without the volumes — the load below fails on a real file, not on an absent one"

# Which BINARY the container reaches without the volumes is the reproduction
# itself. Any Mach-O flavour counts (thin or universal, either endianness);
# ELF here would mean a linux build reached the container by some path other
# than the dependency volumes, which would invalidate P1's whole argument.
P2_ART="$(probe_out p2_driver_artifact)"
if grep -qF "7f 45 4c 46" <<<"$P2_ART"; then
  record p2_artifact_not_elf FAIL "an ELF artifact is reachable WITHOUT the dependency volumes — P1's green would not be \
attributable to the mounted cache: $(first_line "$P2_ART")"
elif grep -Eq 'cf fa ed fe|ce fa ed fe|ca fe ba be|be ba fe ca' <<<"$P2_ART"; then
  record p2_artifact_not_elf PASS "the container reaches the HOST's Mach-O build through the read-only project bind: $(first_line "$P2_ART")"
else
  record p2_artifact_not_elf FAIL "the artifact reachable without the volumes is neither ELF nor Mach-O — investigate: $(first_line "$P2_ART")"
fi

# The negative, through the SAME script the positive went through. A probe that
# reported "loaded" here would mean the shipped gate cannot tell the reviewer's
# mount shape from the bare project bind — which is the whole distinction.
if forge_probe_report p2_forge_probe "P2: FORGE'S OWN probe, with the dependency volumes ABSENT"; then
  P2_FORGE_STATUS="$(forge_probe_says_loaded "$FORGE_PROBE_REPORT")" && P2_FORGE_RC=0 || P2_FORGE_RC=$?
  if [ "$P2_FORGE_RC" -eq 1 ]; then
    record p2_forge_probe PASS "forge's probe reports $PKG unloadable without the cache: $P2_FORGE_STATUS"
  elif [ "$P2_FORGE_RC" -eq 0 ]; then
    record p2_forge_probe FAIL "forge's probe reports $PKG LOADED WITHOUT the dependency volumes — P1's green would then \
prove nothing, because the shipped gate cannot distinguish the two mount shapes"
  else
    record p2_forge_probe FAIL "forge's probe did not report $PKG at all ($P2_FORGE_STATUS) — a package it never \
considered is not a load that failed"
  fi
fi

expect_load_failed p2_driver_load \
  "P2 (corroboration): the real driver CANNOT load without the dependency volumes (this is what the rechecker met, and improvised around)"

# ---- P3, argv half: the FG-376 invariant is visible in what we handed docker
CLOG="$P1LOG"
P1_ARGV="$(cat "$P1LOG.argv")"

if grep -qxF "$PROJECT_DIR:$PCP:ro" <<<"$P1_ARGV"; then
  record p3_project_bind_ro PASS "the project is bound read-only: $PROJECT_DIR:$PCP:ro"
else
  record p3_project_bind_ro FAIL "the argv carries no '$PROJECT_DIR:$PCP:ro' bind"
fi

DEP_RO_OK=0
DEP_DETAIL=""
for spec in "${DEP_MOUNTS[@]}"; do
  case "$spec" in
    *:ro) ;;
    *) DEP_RO_OK=1; DEP_DETAIL="$spec is not :ro" ;;
  esac
  grep -qxF "$spec" <<<"$P1_ARGV" || { DEP_RO_OK=1; DEP_DETAIL="$spec absent from the argv"; }
done
expect_host p3_dependency_mounts_ro "$DEP_RO_OK" \
  "P3: all ${#DEP_MOUNTS[@]} lockfile-keyed dependency volume(s) are mounted :ro and nothing else" "$DEP_DETAIL"

# Read pairwise off the argv ARRAY, never as a grep over the flattened text. The
# container script is itself one argv element and it contains the literal string
# `FORGE_NM_INSTALL_ROOT=[${FORGE_NM_INSTALL_ROOT:-}] FORGE_NM_SHADOW=...` — that
# is the p1_no_install_env probe, the assertion that proves these are EMPTY in
# the container. A text grep matches its own proof and reports it as the
# violation it disproves. Only a real `-e FORGE_NM_*` entry counts.
P1_NM_ENV=""
PREV=""
for a in "${P1_ARGS[@]}"; do
  if [ "$PREV" = "-e" ] || [ "$PREV" = "--env" ]; then
    case "$a" in FORGE_NM_*) P1_NM_ENV="$a" ;; esac
  fi
  case "$a" in --env=FORGE_NM_*) P1_NM_ENV="$a" ;; esac
  PREV="$a"
done
if [ -n "$P1_NM_ENV" ]; then
  record p3_no_install_root FAIL "the argv carries an install/shadow env entry (-e $P1_NM_ENV) — FG-376 says a reviewer container never installs"
else
  record p3_no_install_root PASS "no -e FORGE_NM_INSTALL_ROOT and no -e FORGE_NM_SHADOW* among the argv's env entries"
fi

if grep -Eq 'npm (ci|install)|yarn install|pnpm install' <<<"$P1_ARGV"; then
  record p3_no_install_command FAIL "the container command contains an install"
else
  record p3_no_install_command PASS "the container command contains no install of any kind"
fi

# A read-WRITE bind of any dependency container path would defeat the whole
# invariant, so it is checked as its own assertion rather than inferred from
# the `:ro` check above (which only inspects the specs we planned).
RW_DEP=""
for spec in "${DEP_MOUNTS[@]}"; do
  cpath="${spec#*:}"; cpath="${cpath%:ro}"
  while IFS= read -r line; do
    case "$line" in
      *":$cpath") RW_DEP="$line" ;;
    esac
  done <<<"$P1_ARGV"
done
if [ -n "$RW_DEP" ]; then
  record p3_no_rw_dependency_mount FAIL "a read-write dependency mount is present: $RW_DEP"
else
  record p3_no_rw_dependency_mount PASS "no read-write dependency mount in the argv"
fi

# ── Evidence block ───────────────────────────────────────────────────────────

echo
echo "Paste everything between the fences into FG-664 as the AC 1 evidence."
echo
echo '```'
echo "FG-664 reviewer database-engine smoke — $SELF"
echo "run id       : $RUN_ID"
echo "host         : $(uname -srm)"
echo "docker       : $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "image        : $IMAGE ($(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || echo unknown))"
echo "runtime      : $RUNTIME_NAME"
echo "project dir  : $PROJECT_DIR"
echo "project sha  : $(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "driver       : $PKG"
echo "cache key    : $CACHE_KEY ($PROVISIONED)"
echo "host artifact: $HOST_ARTIFACT"
echo "host magic   : $HOST_MAGIC   (Mach-O — what a container sees through the project bind alone)"
echo "host node    : $HOST_NODE"
echo "container    : node $CONTAINER_NODE modules=$CONTAINER_ABI $CONTAINER_PLATFORM, sqlite $CONTAINER_SQLITE"
echo "docker rc    : P1=$P1_RC P2=$P2_RC"
echo
echo "P1 mount argv (the read-only reviewer shape, from forge's own planners):"
echo "  -v $PROJECT_DIR:$PCP:ro"
for spec in "${DEP_MOUNTS[@]}"; do echo "  -v $spec"; done
echo "  -w $PCP"
echo "  (no read-write dependency mount, no FORGE_NM_INSTALL_ROOT, no install command)"
echo
echo "P2 mount argv (the same container, dependency volumes ABSENT — the live defect):"
echo "  -v $PROJECT_DIR:$PCP:ro"
echo "  -w $PCP"
echo
echo "provisioner argv (forge's buildProvisionerDockerArgs — the ONLY container that writes these volumes):"
while IFS= read -r a; do [ -n "$a" ] && echo "    $a"; done < "$OUT/provisioner-argv"
echo
echo "probes — id, verdict, and the command actually attempted:"
CLOG="$P1LOG"
printf '%s' "$RESULTS" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  pid="${line%% *}"
  case "$pid" in p2_*) CLOG="$P2LOG" ;; *) CLOG="$P1LOG" ;; esac
  echo "  $line"
  cmd="$(probe_cmd "$pid")"
  if [ -n "$cmd" ]; then echo "        \$ $cmd"; fi
done
echo
echo "probe nonce  : $PROBE_NONCE (minted this run; forge's probe report must carry it)"
echo "forge probe  : the shipped DEPENDENCY_PROBE_SCRIPT from src/v2/spawn.ts, not a substitute"
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "P1 (FORGE'S OWN probe attests the driver loads in the reviewer shape) : PASS"
  echo "P2 (the same probe reports it unloadable without the volumes)         : PASS"
  echo "P3 (no rw dependency mount, no install: FG-376 invariant holds)      : PASS"
  echo "FG-664 AC 1 : PASS on darwin + npm-lockfile. This says NOTHING about half (B):"
  echo "              that a lane which cannot load the driver is recorded blocked_environment"
  echo "              is proven by the unit suites, not by this script."
else
  echo "FG-664 AC 1 : FAIL — $FAILURES assertion(s) failed. See the verdicts above."
fi
echo '```'

if [ "$FAILURES" -ne 0 ]; then
  echo
  echo "$SELF: $FAILURES assertion(s) failed. Full P1 container log:" >&2
  cat "$P1LOG" >&2
  echo "$SELF: full P2 container log:" >&2
  cat "$P2LOG" >&2
  exit 1
fi

echo
echo "$SELF: ALL PASS — a read-only reviewer container loads the project's real $PKG, and cannot without the cache."
exit 0
