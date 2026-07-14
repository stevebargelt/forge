#!/usr/bin/env bash
# FG-559 PROBE 4 — the FAIL-LOUD DETECTOR (ticket direction 4).
#
# FG-559: "silent degradation must be impossible regardless of which fix is
# chosen." This probe exercises the exact predicate proposed for the plan, in
# both of its homes, and shows it classifies every case correctly.
#
# HOST-SIDE predicate (proposed home: spawn.ts, alongside preflightProjectMount)
#   Input: the EFFECTIVE MOUNT ROOT — `worktreePath ?? projectDir`
#   (runNext.ts:2838 `repoRootForMount`). NOTE the live defect this probe also
#   demonstrates: preflightProjectMount today is called with args.projectDir
#   (runNext.ts:572, :2467, :2957; invoke.ts:548) — the MAIN CHECKOUT — never
#   with the worktree that is actually mounted. So no existing check can see a
#   dangling gitdir even in principle.
#     1. read <root>/.git
#     2. if it is a DIRECTORY  -> ordinary checkout, nothing to do
#     3. if it is a FILE       -> linked worktree. Parse `gitdir: <target>`.
#                                 The common dir is <target>/../.. (via commondir).
#                                 Assert BOTH are in the container's mount set.
#     4. if the pointer is dangling on the HOST -> the worktree is corrupt.
#
# CONTAINER-SIDE assertion (proposed home: docker/agent-entrypoint.sh, which has
# no git awareness at all today). This is the one that makes silent degradation
# IMPOSSIBLE, because it tests the RUNTIME property by EXECUTING it rather than
# inferring it from the mount arguments:
#     git -C /project rev-parse --git-dir && git -C /project log -1
# If /project is a git repo of ANY kind and this fails, refuse to start the agent.
# Per FG-551's rule: a property of the final runtime is demonstrated by executing
# it, not by pattern-matching the docker argv that was supposed to produce it.
#
# Run: bash p4-fail-loud-detector.sh
set -u

R=/tmp/fg559-p4
rm -rf "$R"; mkdir -p "$R"
REPO="$R/host/code/proj"; WT="$R/host/dotforge/worktrees/run1/task1"

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'v1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c1
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1

# ── the proposed HOST-SIDE predicate, verbatim in shell ──────────────────────
# Returns: OK | NEEDS_MOUNT <commondir> | DANGLING <target>
classify_mount_root() {
  local root="$1"
  local dotgit="$root/.git"
  if [ -d "$dotgit" ]; then echo "OK plain-checkout"; return 0; fi
  if [ ! -f "$dotgit" ]; then echo "OK not-a-git-repo"; return 0; fi
  local target
  target=$(sed -n 's/^gitdir: //p' "$dotgit")
  if [ ! -d "$target" ]; then echo "DANGLING $target"; return 0; fi
  local common
  common=$(cd "$target" && cd "$(cat commondir 2>/dev/null || echo ../..)" && pwd)
  echo "NEEDS_MOUNT $common (gitdir=$target)"
}

echo "=== HOST-SIDE PREDICATE ==="
echo "--- case 1: the MAIN CHECKOUT (what preflightProjectMount is handed today)"
echo "    => $(classify_mount_root "$REPO")"
echo "       NOTE: this is why the bug is invisible to the current preflight —"
echo "       it is never handed the worktree, so it always sees a plain checkout."
echo
echo "--- case 2: the WORKTREE (the dir actually bind-mounted at /project)"
echo "    => $(classify_mount_root "$WT")"
echo "       the detector names the exact host path that must also be mounted."
echo
echo "--- case 3: a worktree whose parent repo is GONE (corrupt on the host)"
mv "$REPO" "$REPO.gone"
echo "    => $(classify_mount_root "$WT")"
mv "$REPO.gone" "$REPO"
echo
echo "--- case 4: a plain non-git directory"
mkdir -p "$R/plain"; echo "    => $(classify_mount_root "$R/plain")"

# ── the proposed CONTAINER-SIDE assertion ────────────────────────────────────
# Reproduce the container's view (worktree only; parent path absent) and run the
# assertion. This is the check that cannot be fooled by a plausible-but-wrong
# mount set, because it executes git instead of reasoning about argv.
echo
echo "=== CONTAINER-SIDE ASSERTION (executed, not inferred) ==="
CTR="$R/ctr/project"; mkdir -p "$(dirname "$CTR")"; cp -R "$WT" "$CTR"

assert_git_usable() {   # the exact entrypoint check being proposed
  local p="$1"
  [ -e "$p/.git" ] || { echo "SKIP  (/project is not a git repo — nothing to assert)"; return 0; }
  if git -C "$p" rev-parse --git-dir >/dev/null 2>&1 && git -C "$p" log -1 --oneline >/dev/null 2>&1; then
    echo "PASS  git is usable inside the container"
    return 0
  fi
  echo "REFUSE  /project is a git worktree whose gitdir is NOT reachable in this"
  echo "        container. Every git command would fail. An agent that consults"
  echo "        history (reviewer/red/fixer) would silently work from the file"
  echo "        tree and report success on evidence it never had."
  echo "        detail: $(git -C "$p" rev-parse --git-dir 2>&1 | head -1)"
  return 1
}

echo "--- TODAY'S SHAPE: only the worktree is mounted (parent .git absent)"
mv "$REPO" "$REPO.hidden"
assert_git_usable "$CTR" && echo "  [!!] detector FAILED to catch it" || echo "  [OK] detector REFUSED — silent degradation prevented"

echo
echo "--- FIXED SHAPE: parent .git also mounted, at its host absolute path (read-only)"
mv "$REPO.hidden" "$REPO"
chmod -R a-w "$REPO/.git"
assert_git_usable "$CTR" && echo "  [OK] detector PASSES — git works, agent starts" || echo "  [!!] detector wrongly refused"
chmod -R u+w "$REPO/.git"

echo
echo "=== done ==="
