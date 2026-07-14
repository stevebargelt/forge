#!/usr/bin/env bash
# FG-559 PROBE 5 — THE REAL CONTAINER. Both directions, on a real docker host.
#
# ############################################################################
# ## STATUS: NOT EXECUTED BY THE ARCHITECTURE PASS.                         ##
# ## The planning container has NO docker daemon, no root, no unshare, and  ##
# ## an EMPTY node_modules. This script is written to be run BY THE OPERATOR##
# ## on the macOS host where forge actually runs. Until its .out exists,    ##
# ## every claim it would settle is INFERENCE from P1-P4, not a container-  ##
# ## executed fact. See the plan's evidence table.                          ##
# ############################################################################
#
# What it settles that P1-P4 cannot:
#   - that Docker BIND-MOUNT semantics (not just path visibility) reproduce the
#     P1 result — including Docker auto-creating the nested parent directories
#     for a path-identity mount like -v /Users/x/code/forge/.git:/Users/x/code/forge/.git
#   - that macOS Docker Desktop's file-sharing (gRPC-FUSE/VirtioFS) serves the
#     .git directory correctly, and that :ro is enforced by the mount
#   - that `git diff <shaA>..<shaB>` REALLY fails today and REALLY works fixed
#
# Run on the host:  bash p5-docker-container-git.sh
set -u

IMG="${FORGE_PROBE_IMAGE:-alpine/git:latest}"
R="${TMPDIR:-/tmp}/fg559-p5"
rm -rf "$R"; mkdir -p "$R"
REPO="$R/proj"
WT="$R/worktrees/run1/task1"

command -v docker >/dev/null || { echo "FAIL: no docker on PATH — run this on the forge host."; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon unreachable."; exit 1; }

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'line1\n'              > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm "c1"
printf 'line1\nline2\n'       > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm "c2"
SHA_A=$(git -C "$REPO" rev-parse HEAD~1)
SHA_B=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1
printf 'line1\nline2\nline3-agent\n' > "$WT/a.txt"

GITDIR_TARGET=$(sed -n 's/^gitdir: //p' "$WT/.git")
COMMON="$REPO/.git"
echo "=== setup ==="
echo "  worktree .git pointer : $(cat "$WT/.git")"
echo "  common dir            : $COMMON"
echo "  SHAs                  : A=$SHA_A  B=$SHA_B"
echo "  image                 : $IMG"
echo

run_in_container() {   # "$@" = extra -v args ; runs the four history commands
  docker run --rm "$@" -v "$WT:/project:ro" -w /project --entrypoint sh "$IMG" -c '
    for c in "log --oneline -3" "diff '"$SHA_A"'..'"$SHA_B"'" "show --stat '"$SHA_B"'" "blame a.txt" "diff HEAD"; do
      if out=$(git $c 2>&1); then
        printf "      git %-6s -> OK   %s\n" "${c%% *}" "$(echo "$out" | head -1 | cut -c1-48)"
      else
        printf "      git %-6s -> FAIL %s\n" "${c%% *}" "$(echo "$out" | head -1 | cut -c1-64)"
      fi
    done'
}

echo "=== DIRECTION 1 — TODAY: only the worktree is mounted  [MUST FAIL] ==="
run_in_container
echo
echo "=== DIRECTION 2 — FIXED: + parent .git at its HOST ABSOLUTE PATH, READ-ONLY  [MUST WORK] ==="
echo "    (this is the shape the plan chooses: -v $COMMON:$COMMON:ro)"
run_in_container -v "$COMMON:$COMMON:ro"
echo
echo "=== DIRECTION 3 — the RED shape: /project ro AND .git ro; prove WRITES are refused ==="
docker run --rm -v "$WT:/project:ro" -v "$COMMON:$COMMON:ro" -w /project --entrypoint sh "$IMG" -c '
  git log --oneline -1 >/dev/null 2>&1 && echo "      read  : OK (git log works)" || echo "      read  : FAIL"
  if git update-ref refs/heads/main HEAD 2>/dev/null; then echo "      WRITE : *** SUCCEEDED — .git is writable, mount is NOT ro ***"
  else echo "      WRITE : refused (read-only .git) — host repo cannot be mutated"; fi
  if printf x | git hash-object -w --stdin >/dev/null 2>&1; then echo "      OBJECT: *** SUCCEEDED — object store writable ***"
  else echo "      OBJECT: refused (read-only .git)"; fi
  if echo "#!/bin/sh" > '"$COMMON"'/hooks/pre-commit 2>/dev/null; then echo "      HOOK  : *** PLANTED — host code execution reachable (see P3) ***"
  else echo "      HOOK  : refused (read-only .git) — P3 escape closed"; fi'
echo
echo "=== DIRECTION 4 — the rejected RW shape: prove the P3 escape is REAL in a container ==="
echo "    (only run this to confirm the danger; the plan REJECTS this shape)"
docker run --rm -v "$WT:/project" -v "$COMMON:$COMMON" -w /project --entrypoint sh "$IMG" -c '
  if git update-ref refs/heads/main $(git rev-parse HEAD) 2>/dev/null; then
    echo "      *** container REWROTE the host repo main ref ***"; else echo "      refs not writable"; fi
  if printf "#!/bin/sh\necho PWNED > '"$R"'/LOOT\n" > '"$COMMON"'/hooks/pre-commit 2>/dev/null; then
    chmod +x '"$COMMON"'/hooks/pre-commit
    echo "      *** container PLANTED a hook in the shared .git/hooks ***"; fi'
echo "    now the HOST runs forge's merge-back auto-commit (worktree-lifecycle.ts:274-279):"
printf 'more\n' >> "$WT/a.txt"
git -C "$WT" add . >/dev/null 2>&1
git -C "$WT" -c user.name=forge -c user.email=forge@local commit -qm "forge: auto-commit" >/dev/null 2>&1
if [ -f "$R/LOOT" ]; then
  echo "      *** HOST EXECUTED THE CONTAINER'S HOOK: $(cat "$R/LOOT") ***"
  echo "      => confirms P3 in a real container. RW .git is a container->host escape."
else
  echo "      (hook did not fire — investigate before trusting this negative)"
fi
rm -f "$COMMON/hooks/pre-commit"
echo
echo "=== done ==="
