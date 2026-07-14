#!/usr/bin/env bash
# FG-559 PROBE 2 — can GIT_DIR / GIT_COMMON_DIR / core.worktree / .git-pointer
# rewriting make git work inside the container WITHOUT reproducing the parent
# repo's host absolute path — and is the OBJECT STORE avoidable at all?
#
# Two independent questions, deliberately separated:
#   Q1. Is the object store avoidable? (i.e. can any rewrite make `git diff
#       A..B` work without the parent's objects being visible?)
#   Q2. Must the parent .git be mounted at its HOST ABSOLUTE PATH (path-identity
#       mount, e.g. /Users/x/code/forge/.git -> same path in the container), or
#       can it be mounted at a CLEAN container path (e.g. /gitcommon) with the
#       pointer rewritten?
#
# Q2 matters architecturally: a path-identity mount leaks the host's directory
# layout into every container and makes the mount set depend on where the
# operator happens to keep their repo. A clean fixed container path does not.
#
# Same path-visibility harness as P1 (see its header for what this does and does
# not prove).
# Run: bash p2-rewrite-vs-mount.sh
set -u

R=/tmp/fg559-p2
rm -rf "$R"; mkdir -p "$R"
HOST="$R/host"; REPO="$HOST/code/proj"; WT="$HOST/dotforge/worktrees/run1/task1"
CTR="$R/ctr/project"          # container's /project  (the worktree)
CMN="$R/ctr/gitcommon"        # container's /gitcommon (candidate CLEAN mount point)

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'line1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c1
printf 'line1\nline2\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c2
SHA_A=$(git -C "$REPO" rev-parse HEAD~1); SHA_B=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1
printf 'line1\nline2\nline3-agent\n' > "$WT/a.txt"

mkdir -p "$(dirname "$CTR")"; cp -R "$WT" "$CTR"

probe() {  # $1=label ; runs with whatever GIT_* env the caller exported
  echo "--- $1"
  for cmd in "log --oneline -2" "diff $SHA_A..$SHA_B" "show --stat $SHA_B" "blame a.txt" "diff HEAD"; do
    # shellcheck disable=SC2086
    if out=$(git -C "$CTR" $cmd 2>&1); then
      echo "      git $(echo "$cmd" | cut -d' ' -f1) -> OK  ($(echo "$out" | head -1 | cut -c1-50))"
    else
      echo "      git $(echo "$cmd" | cut -d' ' -f1) -> FAIL: $(echo "$out" | head -1 | cut -c1-70)"
    fi
  done
}

echo "=== git version: $(git --version) ==="
echo

# ============================================================================
# Q1 — is the OBJECT STORE avoidable?
# Give git EVERYTHING from P1's minimal set EXCEPT objects, at the host abs path.
# ============================================================================
echo "==== Q1: minimal set MINUS objects (everything else present) ===="
mv "$REPO" "$REPO.hidden"
mkdir -p "$REPO/.git/worktrees"
for p in worktrees/task1 refs packed-refs HEAD config; do
  [ -e "$REPO.hidden/.git/$p" ] && cp -R "$REPO.hidden/.git/$p" "$REPO/.git/$p"
done
echo "  (mounted: $(cd "$REPO/.git" && ls | tr '\n' ' ') — note: NO objects/)"
probe "no objects mounted (refs/HEAD/config/gitdir all present)"
echo "  [Q1 VERDICT] objects are the CONTENT of every history command."
echo "               No rewrite can synthesize them. If the commands above failed,"
echo "               the object store is UNAVOIDABLE."
rm -rf "$REPO"; mv "$REPO.hidden" "$REPO"

# ============================================================================
# Q2 — can the parent .git live at a CLEAN container path instead of the
#      host absolute path? Parent repo stays HIDDEN throughout (its host
#      absolute path never exists in the container's view).
# ============================================================================
echo
echo "==== Q2: parent .git mounted at a CLEAN container path ($CMN), host path ABSENT ===="
mv "$REPO" "$REPO.hidden"
rm -rf "$CMN"; cp -R "$REPO.hidden/.git" "$CMN"     # == docker -v <host>/.git:/gitcommon
echo "  (the host path $REPO/.git does NOT exist in this view)"
echo

# --- 2a: pointer file left ALONE (still names the host absolute path) --------
cp -R "$WT/.git" "$CTR/.git"
probe "2a: .git pointer untouched, /gitcommon mounted  [EXPECT: FAIL — pointer names a path that isn't there]"

# --- 2b: rewrite the .git POINTER FILE inside the container ------------------
echo
echo "gitdir: $CMN/worktrees/task1" > "$CTR/.git"
probe "2b: .git pointer REWRITTEN to $CMN/worktrees/task1"
echo "      (note: commondir inside that dir is the RELATIVE '../..' -> $CMN, so the"
echo "       layout carries over intact; nothing else needed rewriting)"

# --- 2c: GIT_DIR + GIT_WORK_TREE env, pointer file left BROKEN ---------------
echo
echo "gitdir: $REPO/.git/worktrees/task1" > "$CTR/.git"   # restore the BROKEN pointer
(
  export GIT_DIR="$CMN/worktrees/task1"
  export GIT_WORK_TREE="$CTR"
  probe "2c: GIT_DIR + GIT_WORK_TREE env set (broken .git pointer file still on disk)"
)

# --- 2d: GIT_COMMON_DIR variant ---------------------------------------------
echo
(
  export GIT_DIR="$CMN/worktrees/task1"
  export GIT_COMMON_DIR="$CMN"
  export GIT_WORK_TREE="$CTR"
  probe "2d: GIT_DIR + GIT_COMMON_DIR + GIT_WORK_TREE env set"
)

# --- 2e: does the per-worktree gitdir BACK-POINTER matter? -------------------
echo
echo "--- 2e: the back-pointer $CMN/worktrees/task1/gitdir currently reads:"
echo "        $(cat "$CMN/worktrees/task1/gitdir")   <- names the HOST worktree path"
echo "gitdir: $CMN/worktrees/task1" > "$CTR/.git"
probe "2e: back-pointer left naming the (absent) host worktree path, pointer rewritten"
echo "      [if OK] git does NOT need the back-pointer to resolve for read commands;"
echo "              it is used by 'git worktree list/prune' bookkeeping, not by log/diff."

mv "$REPO.hidden" "$REPO" 2>/dev/null || true
echo
echo "=== SHAs: A=$SHA_A B=$SHA_B ==="
echo "=== done ==="
