#!/usr/bin/env bash
# fg621-clone-boundary-smoke — the one-time OPERATOR-RUN live proof for FG-621
# AC 2 (the parent repo is unwritable from inside a container) and AC 11
# (a mutating task really does get a private writable clone it can commit in).
#
# WHY A SCRIPT AND NOT A TEST. This repo has no test tier that can run a real
# Docker container: agent containers have no daemon, and no CI job builds or
# runs the agent image. A skip-capable CI test is not acceptable as the live
# proof of a security boundary — a green skip IS a false security proof. So the
# boundary is proven the same way FG-559 proved its own
# (`run-fg-559-live-worktree-smoke-42c126`): once, host-side on macOS, against
# the candidate implementation and image, with the output pasted into the
# ticket. Deliberately OUTSIDE every npm tier (`test`, `test:unit`,
# `test:integration`, `test:worktree`) and outside CI. Do not add a CI job for
# it and do not make it a required check — that decision is recorded in FG-621.
#
# REQUIRES A WORKING DOCKER DAEMON and the agent image on the machine that runs
# it. Run it on the macOS host, never inside an agent container. It also requires
# this repo's node_modules, because the fixture clone is built by forge's OWN
# createTaskClone rather than by a hand-rolled `git clone --shared` — see the
# fixture section for why that distinction is the difference between evidence and
# theatre.
#
# FAILS CLOSED IS THE WHOLE POINT. Every missing prerequisite — no docker
# binary, no reachable daemon, no image, no git, an unusable project dir —
# exits NONZERO. There is exactly one `exit 0` in this file and it is the last
# line, reached only when every assertion below passed. Nothing here skips.
#
# WHAT IT PROVES, AND WHAT IT DOES NOT. It runs a container with the exact
# mount shape forge's planner emits for a private clone — the workspace bound
# rw at /project, and ONLY `<parent>/.git/objects` identity-bind-mounted `:ro`
# — and shows that shape is genuinely safe on a real kernel. It does NOT prove
# forge emits that shape; that is the job of the argv-shape assertions in
# src/v2/fg621-clone-git-mount.worktree.test.ts and
# src/v2/fg559-worktree-git-mount.worktree.test.ts. The two halves together are
# AC 2's coverage: the tests pin what forge builds, this pins what that build
# does to a real parent repository.
#
# USAGE
#   ./scripts/fg621-clone-boundary-smoke.sh [--project-dir DIR] [--image IMAGE]
#
#   --project-dir  the PARENT repo to prove unwritable (default: this repo)
#   --image        the candidate agent image (default: $FORGE_AGENT_IMAGE or
#                  agent-dev-worker:latest — build with ./docker/build.sh)
#
#   FORGE_SMOKE_RUN_ID   override the generated run id (evidence label)
#   FORGE_SMOKE_TASK_ID  override the generated task id
#   FORGE_SMOKE_WORKDIR  parent dir for the throwaway clone (default: mktemp -d)
#
# It writes to the parent repo exactly once, on purpose: AC 11 requires that the
# agent's commit be FETCHABLE BY THE HOST, and forge's real capture step fetches
# the task branch into the parent's ref namespace. That fetch happens strictly
# AFTER the parent-unchanged comparison, and the ref is deleted on exit.

set -euo pipefail

SELF="fg621-clone-boundary-smoke"
PROJECT_DIR_ARG=""
IMAGE="${FORGE_AGENT_IMAGE:-agent-dev-worker:latest}"

fatal() {
  echo "$SELF: FATAL: $*" >&2
  echo "$SELF: this script fails closed — a missing prerequisite is never a pass." >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) [ $# -ge 2 ] || fatal "--project-dir needs a value"; PROJECT_DIR_ARG="$2"; shift 2 ;;
    --image)       [ $# -ge 2 ] || fatal "--image needs a value";       IMAGE="$2";           shift 2 ;;
    -h|--help)     sed -n '2,60p' "$0"; exit 2 ;;
    *)             fatal "unknown argument: $1 (see --help)" ;;
  esac
done

# ── Prerequisites, in the order that gives the most useful diagnostic ─────────

command -v docker >/dev/null 2>&1 \
  || fatal "no 'docker' on PATH — this script runs a real container against the agent image."

docker info >/dev/null 2>&1 \
  || fatal "no reachable Docker daemon ('docker info' failed) — run this on the macOS host, not in an agent container."

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fatal "candidate image '$IMAGE' is absent — build it with ./docker/build.sh, or pass --image."

command -v git >/dev/null 2>&1 \
  || fatal "no 'git' on PATH — the fixture is a real 'git clone --shared'."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${PROJECT_DIR_ARG:-$HERE/..}" 2>/dev/null && pwd -P)" \
  || fatal "project dir '${PROJECT_DIR_ARG:-$HERE/..}' does not exist."

# A path holding a quote or a colon cannot be expressed in a `docker -v` spec or
# quoted safely into the in-container probe strings. Refuse rather than emit an
# argv that means something other than what it reads as.
case "$PROJECT_DIR" in
  *:*|*\'*|*\"*) fatal "project dir contains a ':' or a quote ($PROJECT_DIR); a docker -v spec cannot express it." ;;
esac

[ -d "$PROJECT_DIR/.git" ] \
  || fatal "$PROJECT_DIR/.git is not a directory — this proof is about a real parent repository, not a linked worktree."

PARENT_GIT_DIR="$(cd "$PROJECT_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" \
  || fatal "$PROJECT_DIR is not a git repository."
PARENT_OBJECTS="$(cd "$PROJECT_DIR" && cd "$(git rev-parse --git-path objects)" && pwd -P)" \
  || fatal "cannot resolve the object store of $PROJECT_DIR."

case "$PARENT_OBJECTS" in
  *:*|*\'*|*\"*) fatal "parent object store path contains a ':' or a quote ($PARENT_OBJECTS)." ;;
esac

[ -d "$PARENT_OBJECTS/pack" ] \
  || fatal "$PARENT_OBJECTS/pack is missing — the object-store deletion probe needs a real directory to be refused on."

# A real file inside the object store for the deletion probe. Excluding info/
# keeps it to an actual object (loose or pack), not the alternates bookkeeping.
#
# `-print -quit`, NOT `| head -n 1`: head closes the pipe after the first line
# and a real repo's object store is big enough that find is still walking when
# it does. find takes SIGPIPE, pipefail makes the pipeline 141, and errexit
# kills the script — with the variable already correctly assigned, and only on
# repos large enough for the race to be lost. `|| true` would hide a genuinely
# failing find too, so the fix is to stop building the pipe: find quits itself
# at the first match, on BSD/macOS and GNU alike.
PARENT_OBJECT_FILE="$(find "$PARENT_OBJECTS" -type f -not -path "$PARENT_OBJECTS/info/*" -print -quit 2>/dev/null)"
[ -n "$PARENT_OBJECT_FILE" ] \
  || fatal "$PARENT_OBJECTS holds no object files — nothing for the deletion probe to be refused on."

# AC 2 names packed-ref updates specifically, so the probe needs a genuinely
# PACKED ref to aim at. Refuse rather than quietly pack the operator's refs.
[ -f "$PARENT_GIT_DIR/packed-refs" ] \
  || fatal "$PARENT_GIT_DIR/packed-refs does not exist — run 'git -C $PROJECT_DIR pack-refs --all' and re-run, so the packed-ref probe has a real target."
# Deliberately not an interval expression ({7,}) — macOS's awk does not support
# them, and a silently-empty match here would look like "the repo has no refs".
PACKED_REF="$(awk '/^[0-9a-f][0-9a-f]* refs\// { print $2; exit }' "$PARENT_GIT_DIR/packed-refs")"
[ -n "$PACKED_REF" ] \
  || fatal "$PARENT_GIT_DIR/packed-refs holds no refs — the packed-ref probe has no target."

BASE_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)" \
  || fatal "$PROJECT_DIR has no HEAD commit."

RUN_ID="${FORGE_SMOKE_RUN_ID:-fg621-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
TASK_ID="${FORGE_SMOKE_TASK_ID:-task-clone-boundary}"
BRANCH="forge/$RUN_ID/$TASK_ID"

# ── Fixture: the private writable clone, BUILT BY THE PRODUCT ────────────────
#
# createTaskClone, not a hand-rolled `git clone --shared`. The workspace an agent
# is handed is not just a clone: it is a clone plus everything forge writes into
# it at creation, and the identity a mutating agent commits under is part of that
# (worktree-lifecycle.ts, AGENT_IDENTITY — a clone inherits no local config, the
# agent image sets none, and the container has no global file). A fixture that
# built the clone itself and then handed the container GIT_AUTHOR_*/GIT_COMMITTER_*
# would report AC 11 SUCCESS while real dispatch failed with "Author identity
# unknown" — the evidence papering over the exact gap it exists to prove. So this
# script supplies the container NOTHING the real dispatch path does not: no
# identity env, no git config of any kind. If the p5 commit probe fails on
# identity, the product is broken and that is the finding.
#
# FORGE_HOME is redirected into the throwaway work dir, so the product's own
# path layout (WORKTREES_DIR/clones/...) lands there and never in the operator's
# real ~/.forge.

WORK="$(mktemp -d "${FORGE_SMOKE_WORKDIR:-${TMPDIR:-/tmp}}/fg621-smoke.XXXXXX")" \
  || fatal "cannot create a work dir."
CLOG="$WORK/container.log"
FETCHED_REF=""
ANCHOR_REF=""

cleanup() {
  # One deletion covers both: capture fetches onto the SAME ref createTaskClone
  # anchored, so a successful run leaves one ref, not two.
  for ref in "$FETCHED_REF" "$ANCHOR_REF"; do
    [ -n "$ref" ] || continue
    git -C "$PROJECT_DIR" update-ref -d "$ref" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" || true
}
trap cleanup EXIT

REPO_ROOT="$(cd "$HERE/.." && pwd -P)"
[ -d "$REPO_ROOT/node_modules/tsx" ] \
  || fatal "$REPO_ROOT/node_modules/tsx is absent — the fixture is built by forge's OWN createTaskClone; run 'npm install' in $REPO_ROOT."

CLONE="$(
  cd "$REPO_ROOT" \
    && FORGE_HOME="$WORK/forge-home" \
       FG621_PROJECT_DIR="$PROJECT_DIR" FG621_RUN_ID="$RUN_ID" FG621_TASK_ID="$TASK_ID" FG621_BASE_SHA="$BASE_SHA" \
       node --import tsx --input-type=module -e '
         const { createTaskClone } = await import("./src/v2/worktree-lifecycle.js");
         const r = createTaskClone(
           process.env.FG621_PROJECT_DIR,
           process.env.FG621_RUN_ID,
           process.env.FG621_TASK_ID,
           process.env.FG621_BASE_SHA,
         );
         process.stdout.write(r.clonePath);
       '
)" || fatal "forge's createTaskClone failed to provision the fixture clone."
[ -d "$CLONE" ] || fatal "createTaskClone reported '$CLONE', which is not a directory."
ANCHOR_REF="refs/heads/$BRANCH"

[ "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] \
  || fatal "the product's clone is not on $BRANCH — the branch name this script derives no longer matches worktreeBranchName."

# The identity the PRODUCT wrote into the clone, read back off disk rather than
# restated here — this is the value the container's commit must turn out to carry.
# Empty means the clone was handed no identity, which is AC 1 broken before a
# container has even started: `git commit` in there cannot resolve an author.
AGENT_IDENTITY="$(git -C "$CLONE" config --local --get user.name) <$(git -C "$CLONE" config --local --get user.email)>"
[ "$AGENT_IDENTITY" != " <>" ] \
  || fatal "the product's clone carries no local git identity — a mutating agent cannot commit in it (FG-621 AC 1)."

ALTERNATES="$CLONE/.git/objects/info/alternates"
[ -f "$ALTERNATES" ] \
  || fatal "the clone has no objects/info/alternates — it is not sharing the parent object store, so this proof would be vacuous."
ALT_RESOLVED="$(cd "$(cat "$ALTERNATES")" 2>/dev/null && pwd -P)" \
  || fatal "the clone's alternates entry does not resolve to a directory."
[ "$ALT_RESOLVED" = "$PARENT_OBJECTS" ] \
  || fatal "the clone's alternates resolve to $ALT_RESOLVED, not the parent object store $PARENT_OBJECTS."

# The clone must own NO objects of its own yet. That is what makes the
# in-container `git log` / `cat-file` positives meaningful: every object they
# read has to come through the read-only alternates mount, not a local copy.
LOCAL_OBJECTS="$(find "$CLONE/.git/objects" -type f -not -path "$CLONE/.git/objects/info/*" 2>/dev/null | wc -l | tr -d ' ')"
[ "$LOCAL_OBJECTS" = "0" ] \
  || fatal "the fresh clone already holds $LOCAL_OBJECTS local object file(s); in-container reads would not prove the alternates mount works."

# ── Parent baseline, captured BEFORE the container runs ──────────────────────

snapshot() { # $1 = destination prefix
  git -C "$PROJECT_DIR" for-each-ref --format='%(objectname) %(refname)' | sort > "$1.refs"
  git -C "$PROJECT_DIR" rev-parse HEAD > "$1.head"
  find "$PARENT_OBJECTS" -type f | sort > "$1.objects"
  cp "$PARENT_GIT_DIR/packed-refs" "$1.packed-refs"
}
snapshot "$WORK/before"

# ── The in-container probe program ───────────────────────────────────────────
#
# Every probe is REPORT-ONLY: it records that it started, what it ran, its
# output and its exit code, and never decides anything. The host adjudicates
# from that record. That is what separates "refused" from "never ran" — a probe
# whose command name is a typo produces a 127/"not found" record the host
# rejects, and a probe the container never reached produces no PROBE_BEGIN at
# all. A container-side `set -e` or an early exit therefore cannot turn a
# missing assertion into a pass.

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

# ---- controls: prove the tooling itself works in here ----------------------
probe p0_git_present "command -v git"
probe c1_clone_ref_create "git --git-dir=/project/.git update-ref refs/heads/fg621-smoke-control $FG621_BASE_SHA"
probe c2_clone_object_store_writable "touch /project/.git/objects/fg621-smoke-control && rm -f /project/.git/objects/fg621-smoke-control"

# ---- AC 11 positives: real parent history is readable through the ro mount --
probe p1_parent_history_readable "git -C /project log --oneline -n 5"
probe p2_parent_history_depth "git -C /project rev-list --count HEAD"
probe p3_parent_object_readable "git -C /project cat-file -t $FG621_BASE_SHA"
probe p4_private_branch_checked_out "git -C /project rev-parse --abbrev-ref HEAD"

# ---- AC 2 negatives: every write at the PARENT must be refused -------------
probe n1_parent_ref_create "git --git-dir='$FG621_PARENT_GIT_DIR' update-ref refs/heads/fg621-smoke-intruder $FG621_BASE_SHA"
probe n2_parent_main_update "git --git-dir='$FG621_PARENT_GIT_DIR' update-ref refs/heads/main $FG621_BASE_SHA"
probe n3_parent_remote_ref_update "git --git-dir='$FG621_PARENT_GIT_DIR' update-ref refs/remotes/origin/main $FG621_BASE_SHA"
probe n4_parent_packed_ref_update "git --git-dir='$FG621_PARENT_GIT_DIR' update-ref '$FG621_PACKED_REF' $FG621_BASE_SHA"
probe n5_parent_packed_refs_raw_write "printf 'fg621 intruder\n' >> '$FG621_PARENT_GIT_DIR/packed-refs'"
probe n6_parent_object_delete "rm -f '$FG621_PARENT_OBJECT_FILE'"
probe n7_parent_object_store_write "touch '$FG621_PARENT_OBJECTS/fg621-smoke-intruder'"
probe n8_parent_object_dir_delete "rm -rf '$FG621_PARENT_OBJECTS/pack'"
probe n9_parent_index_write "printf 'fg621 intruder\n' >> '$FG621_PARENT_GIT_DIR/index'"
probe n10_parent_head_write "printf 'fg621 intruder\n' >> '$FG621_PARENT_GIT_DIR/HEAD'"
probe n11_push_to_parent_target "git -C /project push origin HEAD:refs/heads/fg621-smoke-push"

# ---- AC 11: the agent commits in its own repository ------------------------
# A BARE `git commit` — no `-c user.name=…`, and nothing in this container's env
# supplies one. It resolves an author only because forge wrote one into the clone
# at creation, which is the property p7 then reads back.
probe p5_agent_commit "cd /project && printf 'fg621 agent output for %s\n' \"\$FG621_RUN_ID\" > fg621-agent-output.txt && git add -A && git commit -q -m 'fg621: agent commit inside the private clone' && git rev-parse HEAD"
probe p6_clone_branch_tip "git -C /project rev-parse 'refs/heads/$FG621_BRANCH'"
probe p7_agent_commit_identity "git -C /project log -1 --format='%an <%ae>' 'refs/heads/$FG621_BRANCH'"

echo "CONTAINER_DONE"
CEOF
)

DOCKER_ARGS=(
  run --rm
  -e FORGE_NO_BROWSER=1
  -e "FG621_RUN_ID=$RUN_ID"
  -e "FG621_BASE_SHA=$BASE_SHA"
  -e "FG621_BRANCH=$BRANCH"
  -e "FG621_PARENT_GIT_DIR=$PARENT_GIT_DIR"
  -e "FG621_PARENT_OBJECTS=$PARENT_OBJECTS"
  -e "FG621_PARENT_OBJECT_FILE=$PARENT_OBJECT_FILE"
  -e "FG621_PACKED_REF=$PACKED_REF"
  # NOTHING GIT-RELATED IS PASSED IN, deliberately. Earlier revisions exported
  # GIT_AUTHOR_*/GIT_COMMITTER_* (an identity) and GIT_CONFIG_COUNT
  # safe.directory=* (a config the dispatch path does not set either). Both made
  # this script supply on the product's behalf: p5 would report the agent
  # committing successfully while a real mutating dispatch died with "Author
  # identity unknown". The container gets exactly the env real dispatch gives it,
  # so every probe below measures the product. FORGE_NO_BROWSER and the FG621_*
  # probe parameters are the only additions, and neither touches git.
  #
  # If git ever refuses /project here as "dubious ownership", that is a REAL
  # finding, not a fixture problem: real dispatch mounts a host-owned workspace
  # the same way and would be refused identically — loudly, by the entrypoint's
  # FG-559 probe (exit 122), which this script already reports on.
  # THE MOUNT SHAPE UNDER TEST. The workspace rw at /project, and the parent's
  # OBJECT STORE ALONE, identity-mounted read-only. The parent's refs, index,
  # HEAD and packed-refs are ABSENT from the container, not merely read-only —
  # which is why the n1..n5/n9..n11 probes are refused by absence and n6..n8 by
  # the kernel's read-only bind.
  -v "$CLONE:/project:rw"
  -v "$PARENT_OBJECTS:$PARENT_OBJECTS:ro"
  -w /project
  "$IMAGE"
  bash -c "$CONTAINER_SCRIPT"
)

echo "==> running the boundary probes in $IMAGE"
set +e
docker "${DOCKER_ARGS[@]}" > "$CLOG" 2>&1
CONTAINER_RC=$?
set -e

# ── Parent comparison, BEFORE the host's own capture fetch ───────────────────

snapshot "$WORK/after"

# ── Adjudication ─────────────────────────────────────────────────────────────

FAILURES=0
RESULTS=""

record() { # id verdict detail
  RESULTS="${RESULTS}$(printf '%-34s %-4s %s' "$1" "$2" "$3")
"
  [ "$2" = "PASS" ] || FAILURES=$((FAILURES + 1))
}

# Trimming happens in the shell, never with `| head`. head exits as soon as it
# has its lines and SIGPIPEs whatever is still writing; under this script's
# pipefail+errexit that is a silent 141 death whose likelihood grows with the
# input — the container log grows with the probe set, and a probe's output is
# whatever the container chose to print. No pipe, no race.
first_line()  { printf '%s' "${1%%$'\n'*}"; }
first_lines() { # $1 = text, $2 = how many lines, space-joined
  local line n=0 out=""
  while IFS= read -r line; do
    n=$((n + 1))
    [ "$n" -le "$2" ] || break
    out="$out$line "
  done <<<"$1"
  printf '%s' "$out"
}

probe_ran()  { grep -q "^PROBE_BEGIN $1\$" "$CLOG"; }
probe_cmd()  { first_line "$(sed -n "s/^PROBE_CMD $1 | //p" "$CLOG")"; }
probe_out()  { sed -n "s/^PROBE_OUT $1 | //p" "$CLOG"; }
probe_rc()   { first_line "$(sed -n "s/^PROBE_RC $1 //p" "$CLOG")"; }

# Messages that constitute a genuine kernel/git refusal. Matching one is not
# what makes a negative pass on its own — a nonzero exit that is NOT a
# missing-binary error is — but requiring a recognizable refusal keeps a probe
# that failed for some incidental reason from being read as a boundary proof.
REFUSAL_RE='not a git repository|[Rr]ead-only file system|Permission denied|Operation not permitted|cannot lock|unable to|cannot create|No such file or directory|does not appear to be a git repository|could not read from remote|Directory nonexistent|Not a directory'

expect_refused() { # id label
  local id="$1" label="$2" rc out
  if ! probe_ran "$id"; then
    record "$id" FAIL "NEVER RAN — no PROBE_BEGIN in the container log ($label)"; return
  fi
  rc="$(probe_rc "$id")"
  if [ -z "$rc" ]; then
    record "$id" FAIL "NO EXIT CODE — the container script died inside this probe ($label)"; return
  fi
  out="$(probe_out "$id")"
  if [ "$rc" -eq 0 ]; then
    record "$id" FAIL "NOT REFUSED — the write SUCCEEDED (rc=0): $label"; return
  fi
  # `grep -q <<<` and not `printf | grep -q`: grep -q exits at the FIRST match,
  # SIGPIPEs the writer, and pipefail turns that into a nonzero pipeline. These
  # are `if` conditions, so errexit spares them — a matched refusal in a long
  # probe output would instead read as NO match and be recorded FAIL. Safe, but
  # a misreport, and the container decides how much it prints.
  if [ "$rc" -eq 127 ] || grep -Eq 'not found|command not found' <<<"$out"; then
    record "$id" FAIL "COMMAND DID NOT RUN (rc=$rc, 'not found') — a typo must never read as a refusal: $label"; return
  fi
  if grep -Eq "$REFUSAL_RE" <<<"$out"; then
    record "$id" PASS "refused rc=$rc: $(first_line "$out")"
  else
    record "$id" FAIL "rc=$rc but no recognizable refusal message — investigate: $(first_line "$out")"
  fi
}

expect_success() { # id label [expected-substring]
  local id="$1" label="$2" want="${3:-}" rc out
  if ! probe_ran "$id"; then
    record "$id" FAIL "NEVER RAN — no PROBE_BEGIN in the container log ($label)"; return
  fi
  rc="$(probe_rc "$id")"
  if [ -z "$rc" ]; then
    record "$id" FAIL "NO EXIT CODE — the container script died inside this probe ($label)"; return
  fi
  out="$(probe_out "$id")"
  if [ "$rc" -ne 0 ]; then
    record "$id" FAIL "FAILED rc=$rc ($label): $(first_line "$out")"; return
  fi
  if [ -n "$want" ] && ! grep -qF "$want" <<<"$out"; then
    record "$id" FAIL "succeeded but output does not contain '$want' ($label)"; return
  fi
  record "$id" PASS "ok rc=0: $(first_line "$out")"
}

expect_host() { # id ok? label detail
  if [ "$2" = "0" ]; then record "$1" PASS "$3"; else record "$1" FAIL "$3 — $4"; fi
}

if [ "$CONTAINER_RC" -eq 122 ]; then
  echo "$SELF: the agent entrypoint's FG-559 git probe refused the clone (exit 122)." >&2
  echo "$SELF: git could not resolve inside /project — the objects mount is wrong or absent." >&2
fi

if grep -q '^CONTAINER_DONE$' "$CLOG"; then
  record container_ran_to_completion PASS "the probe program reached its end (docker rc=$CONTAINER_RC)"
else
  record container_ran_to_completion FAIL "the probe program did NOT reach its end (docker rc=$CONTAINER_RC) — every 'refusal' below is suspect"
fi

# Controls first: if these fail, nothing else in here means anything.
expect_success p0_git_present "git is on PATH in the container"
expect_success c1_clone_ref_create "CONTROL: the same update-ref SUCCEEDS against the clone's own git dir"
expect_success c2_clone_object_store_writable "CONTROL: the clone's own object store IS writable"

# AC 11 positives.
expect_success p1_parent_history_readable "AC11: parent history readable through the :ro alternates"
expect_success p2_parent_history_depth "AC11: HEAD has real ancestry"
expect_success p3_parent_object_readable "AC11: a parent object resolves through alternates" "commit"
expect_success p4_private_branch_checked_out "AC11: the deterministic private branch is checked out" "$BRANCH"
expect_success p5_agent_commit "AC11: the agent commits inside its private clone"
expect_success p6_clone_branch_tip "AC11: the private branch holds the agent's commit"
expect_success p7_agent_commit_identity \
  "AC11: the commit carries the identity the PRODUCT put in the clone ($AGENT_IDENTITY), not one this script supplied" \
  "$AGENT_IDENTITY"

# AC 2 negatives.
expect_refused n1_parent_ref_create "AC2: creating a ref in the PARENT repo"
expect_refused n2_parent_main_update "AC2: updating the parent's main"
expect_refused n3_parent_remote_ref_update "AC2: updating a parent origin/* ref"
expect_refused n4_parent_packed_ref_update "AC2: updating a parent PACKED ref ($PACKED_REF)"
expect_refused n5_parent_packed_refs_raw_write "AC2: raw append to the parent's packed-refs file"
expect_refused n6_parent_object_delete "AC2: deleting from the parent OBJECT STORE"
expect_refused n7_parent_object_store_write "AC2: writing into the parent object store"
expect_refused n8_parent_object_dir_delete "AC2: deleting the parent's objects/pack directory"
expect_refused n9_parent_index_write "AC2: writing the parent's index"
expect_refused n10_parent_head_write "AC2: writing the parent's HEAD"
expect_refused n11_push_to_parent_target "AC2: pushing to the parent target branch"

# AC 11 host side: the parent is byte-identically unchanged, then the commit is
# retrievable by the host exactly the way forge's capture step retrieves it.

# diff_detail is called only where `diff -q` has ALREADY decided the two snapshots differ, so
# diff's nonzero "they differ" status carries no information here and is
# discarded — but it would otherwise trip errexit, and `| head -n 5` would
# SIGPIPE diff, exactly when the diff runs long. That is the parent-WAS-modified
# case: the one result this script must never fail to report.
diff_detail() { first_lines "$(diff "$1" "$2" || true)" 5; }

DIFF_DETAIL=""
if diff -q "$WORK/before.refs" "$WORK/after.refs" >/dev/null 2>&1; then h=0; else h=1; DIFF_DETAIL="$(diff_detail "$WORK/before.refs" "$WORK/after.refs")"; fi
expect_host h1_parent_refs_unchanged "$h" "AC11: parent ref listing identical before/after" "$DIFF_DETAIL"

if diff -q "$WORK/before.head" "$WORK/after.head" >/dev/null 2>&1; then h=0; else h=1; fi
expect_host h2_parent_head_unchanged "$h" "AC11: parent HEAD identical before/after" "HEAD moved"

if diff -q "$WORK/before.packed-refs" "$WORK/after.packed-refs" >/dev/null 2>&1; then h=0; else h=1; fi
expect_host h3_parent_packed_refs_unchanged "$h" "AC11: parent packed-refs byte-identical before/after" "packed-refs changed"

if diff -q "$WORK/before.objects" "$WORK/after.objects" >/dev/null 2>&1; then h=0; else h=1; DIFF_DETAIL="$(diff_detail "$WORK/before.objects" "$WORK/after.objects")"; fi
expect_host h4_parent_object_store_unchanged "$h" "AC11: parent object store file list identical before/after ($(wc -l < "$WORK/before.objects" | tr -d ' ') files)" "$DIFF_DETAIL"

AGENT_SHA="$(probe_out p5_agent_commit | grep -Eo '^[0-9a-f]{40}$' | tail -n 1 || true)"
if [ -z "$AGENT_SHA" ]; then
  record h5_host_fetch_from_clone FAIL "the container reported no commit sha, so there is nothing to fetch"
  record h6_agent_output_in_fetched_tree FAIL "no commit sha to inspect"
else
  if git -C "$PROJECT_DIR" fetch --quiet --no-tags "$CLONE" "refs/heads/$BRANCH:refs/heads/$BRANCH" >/dev/null 2>&1; then
    FETCHED_REF="refs/heads/$BRANCH"
    FETCHED_SHA="$(git -C "$PROJECT_DIR" rev-parse "$FETCHED_REF")"
    if [ "$FETCHED_SHA" = "$AGENT_SHA" ]; then
      record h5_host_fetch_from_clone PASS "host fetched $AGENT_SHA from the clone into $FETCHED_REF"
    else
      record h5_host_fetch_from_clone FAIL "fetched $FETCHED_SHA but the container committed $AGENT_SHA"
    fi
    if git -C "$PROJECT_DIR" show "$FETCHED_REF:fg621-agent-output.txt" >/dev/null 2>&1; then
      record h6_agent_output_in_fetched_tree PASS "the agent's file is present in the fetched tree"
    else
      record h6_agent_output_in_fetched_tree FAIL "the agent's file is missing from the fetched tree"
    fi
  else
    record h5_host_fetch_from_clone FAIL "'git fetch $CLONE $BRANCH' failed on the host"
    record h6_agent_output_in_fetched_tree FAIL "nothing was fetched"
  fi
fi

# ── Evidence block ───────────────────────────────────────────────────────────

echo
echo "Paste everything between the fences into FG-621 as the AC 2 / AC 11 evidence."
echo
echo '```'
echo "FG-621 private-clone boundary smoke — $SELF"
echo "run id      : $RUN_ID"
echo "task id     : $TASK_ID"
echo "branch      : $BRANCH"
echo "host        : $(uname -srm)"
echo "docker      : $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "image       : $IMAGE ($(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || echo unknown))"
echo "project dir : $PROJECT_DIR"
echo "base sha    : $BASE_SHA"
echo "parent .git : $PARENT_GIT_DIR   (NOT mounted)"
echo "parent objs : $PARENT_OBJECTS   (identity-mounted :ro)"
echo "clone       : $CLONE            (built by forge's createTaskClone, mounted rw at /project)"
echo "agent ident : $AGENT_IDENTITY   (written into the clone BY THE PRODUCT; no git env passed to the container)"
echo "packed ref  : $PACKED_REF"
echo "docker rc   : $CONTAINER_RC"
echo
echo "mounts handed to docker:"
echo "  -v $CLONE:/project:rw"
echo "  -v $PARENT_OBJECTS:$PARENT_OBJECTS:ro"
echo "  (no parent .git / refs / index / HEAD / packed-refs mount of any kind)"
echo
echo "probes — id, verdict, and the command actually attempted:"
printf '%s' "$RESULTS" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  pid="${line%% *}"
  echo "  $line"
  cmd="$(probe_cmd "$pid")"
  # `if`, not `&&` — a false `&&` list would be the loop body's last status,
  # which under `set -e` would abort the script before the verdict prints.
  if [ -n "$cmd" ]; then echo "        \$ $cmd"; fi
done
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "AC 2  (parent repo unwritable from the container) : PASS"
  echo "AC 11 (private clone received, committed in, host retrieved the commit, parent untouched) : PASS"
else
  echo "AC 2 / AC 11 : FAIL — $FAILURES assertion(s) failed. See the verdicts above."
fi
echo '```'

if [ "$FAILURES" -ne 0 ]; then
  echo
  echo "$SELF: $FAILURES assertion(s) failed. Full container log:" >&2
  cat "$CLOG" >&2
  exit 1
fi

echo
echo "$SELF: ALL PASS — the parent repository is unwritable from the container, and the private clone is."
exit 0
