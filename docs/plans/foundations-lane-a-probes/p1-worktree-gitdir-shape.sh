#!/usr/bin/env bash
# FG-559 PROBE 1 — the linked-worktree .git shape, and the MINIMAL set of host
# paths that must be visible for git history commands to work inside a container
# whose only mount is the worktree directory.
#
# WHAT THIS REPRODUCES, EXACTLY:
#   A bind mount's ONLY effect on git's path resolution is WHICH ABSOLUTE PATHS
#   ARE VISIBLE inside the container. `docker run -v H:C` makes host path H
#   readable at container path C; every other host path is simply absent. So the
#   question "is mount set S sufficient for git?" is exactly the question "does
#   git succeed when precisely the paths in S exist and nothing else does?"
#
#   This script controls that directly: it builds a real parent repo + a real
#   linked worktree, then HIDES the parent repo (rename) to reproduce the
#   container's view (worktree present, parent .git absent), and MATERIALIZES
#   candidate path subsets back at their exact absolute paths — one bind mount
#   per materialized path.
#
# WHAT IT DOES NOT PROVE (stated so it is not overclaimed):
#   - It is not a container. It does not test the Docker boundary, uid mapping,
#     macOS grpcfuse/VirtioFS semantics, or Docker's auto-creation of parent
#     dirs for a nested mount target. Those are P5's job (docker-host probe).
#   It DOES conclusively settle git's own path-resolution requirements, which is
#   what determines the mount set.
#
# Run: bash p1-worktree-gitdir-shape.sh
set -u

R=/tmp/fg559-p1
rm -rf "$R"; mkdir -p "$R"
HOST="$R/host"          # stands for the macOS host filesystem
REPO="$HOST/code/proj"  # stands for the operator's projectDir  (e.g. /Users/x/code/forge)
WT="$HOST/dotforge/worktrees/run1/task1"   # stands for ~/.forge/worktrees/<run>/<task>
CTR="$R/ctr/project"    # stands for the container's /project

echo "=== git version ==="; git --version

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'line1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm "c1: add a.txt"
printf 'line1\nline2\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm "c2: extend a.txt"
SHA_A=$(git -C "$REPO" rev-parse HEAD~1); SHA_B=$(git -C "$REPO" rev-parse HEAD)

mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1
printf 'line1\nline2\nline3-agent\n' > "$WT/a.txt"   # the agent's edit

echo
echo "=== [FACT] the worktree's .git is a FILE, not a directory ==="
ls -la "$WT/.git"
echo "--- its content:"; cat "$WT/.git"
echo "--- git's own view from inside the worktree:"
echo "  --git-dir        = $(git -C "$WT" rev-parse --git-dir)"
echo "  --git-common-dir = $(git -C "$WT" rev-parse --git-common-dir)"
echo
echo "=== [FACT] what lives in the per-worktree gitdir vs the common dir ==="
echo "--- \$REPO/.git/worktrees/task1/ (per-worktree: HEAD, index, logs):"
ls "$REPO/.git/worktrees/task1/"
echo "--- commondir file points back to the shared .git:"; cat "$REPO/.git/worktrees/task1/commondir"
echo "--- OBJECTS + REFS live ONLY in the common dir (never in the worktree):"
ls -d "$REPO/.git/objects" "$REPO/.git/refs" 2>&1
echo "--- the worktree dir itself contains NO objects:"
find "$WT" -name objects -o -name "*.pack" | grep -c . | sed 's/^/  object-store entries under worktree: /'

# ---- container-view harness --------------------------------------------------
# hide the whole parent repo => reproduces "only the worktree dir is mounted"
hide()   { mv "$REPO" "$REPO.hidden"; }
unhide() { rm -rf "$REPO"; mv "$REPO.hidden" "$REPO"; }
# materialize a path from the hidden repo back at its EXACT absolute path.
# each call == one `docker run -v <hostpath>:<samepath>` bind mount.
mount_path() {  # $1 = path relative to .git
  local rel="$1"
  local src="$REPO.hidden/.git/$rel"
  local dst="$REPO/.git/$rel"
  [ -e "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
}
reset_ctr_view() { rm -rf "$REPO"; mkdir -p "$REPO/.git"; }

try() {  # run the four history commands in the container's /project
  local label="$1"
  echo "--- $label"
  for cmd in "log --oneline -3" "diff $SHA_A..$SHA_B" "show --stat $SHA_B" "blame a.txt" "status --porcelain" "diff HEAD"; do
    # shellcheck disable=SC2086
    if out=$(git -C "$CTR" $cmd 2>&1); then
      echo "      git $(echo "$cmd" | cut -d' ' -f1)  -> OK  ($(echo "$out" | head -1 | cut -c1-52))"
    else
      echo "      git $(echo "$cmd" | cut -d' ' -f1)  -> FAIL: $(echo "$out" | head -1 | cut -c1-72)"
    fi
  done
}

# the container sees ONLY the worktree directory, at /project
mkdir -p "$(dirname "$CTR")"; cp -R "$WT" "$CTR"
hide

echo
echo "==================== MOUNT SET EXPERIMENTS ===================="
echo "(container's /project = the worktree dir; parent repo path is otherwise absent)"
echo
echo "SET 0 — TODAY'S SHAPE: worktree dir only, nothing else mounted  [EXPECT: total failure]"
try "set0 (today)"

echo
echo "SET 1 — + .git/worktrees/task1 ONLY (the gitdir target, no object store)"
reset_ctr_view; mount_path "worktrees/task1"
try "set1 (gitdir target, no objects)"

echo
echo "SET 2 — + objects  (gitdir target + object store, no refs/config/HEAD)"
reset_ctr_view; mount_path "worktrees/task1"; mount_path "objects"
try "set2 (+objects)"

echo
echo "SET 3 — + refs + packed-refs + HEAD + config  (the candidate MINIMAL set)"
reset_ctr_view
mount_path "worktrees/task1"; mount_path "objects"; mount_path "refs"
mount_path "packed-refs"; mount_path "HEAD"; mount_path "config"
try "set3 (minimal candidate)"

echo
echo "SET 4 — the ENTIRE parent .git  [EXPECT: full success]"
reset_ctr_view; rm -rf "$REPO/.git"; cp -R "$REPO.hidden/.git" "$REPO/.git"
try "set4 (whole .git)"

echo
echo "SET 5 — whole parent .git, mounted READ-ONLY (the RED-agent shape)"
reset_ctr_view; rm -rf "$REPO/.git"; cp -R "$REPO.hidden/.git" "$REPO/.git"
chmod -R a-w "$REPO/.git"
try "set5 (whole .git, ro)"
chmod -R u+w "$REPO/.git"

unhide
echo
echo "=== SHAs used: A=$SHA_A B=$SHA_B ==="
echo "=== done ==="
