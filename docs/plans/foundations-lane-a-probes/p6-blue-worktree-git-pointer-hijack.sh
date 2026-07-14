#!/usr/bin/env bash
# FG-559 PROBE 6 — NEGATIVE CONTROL for the blue worktree-local `.git` pointer seam.
#
# ############################################################################
# ## ROLE: NEGATIVE CONTROL. This probe tests a pointer-hijack variant that ##
# ## git DEFEATS, and shows it does NOT reproduce the escape. It is NOT the ##
# ## reproduction. The observed-red reproduction is its sibling probe P6b   ##
# ## (p6b-real-vector-standalone-alternates.{sh,out}), executed on the host ##
# ## 2026-07-14. A clean result HERE is the EXPECTED negative-control       ##
# ## outcome, NOT evidence the seam is closed. See PRD D10/AC-7.            ##
# ############################################################################
#
# WHY P5 DID NOT COVER THIS SEAM AT ALL. P5 mounted /project:ro for every
# direction it tested, so the worktree-local `.git` POINTER FILE was never
# writable. A BLUE agent gets /project:RW. The pointer file `<wt>/.git` lives
# INSIDE that rw mount (not in the common dir), so a blue agent can REPLACE it.
# The read-only common `.git` (D2) protects the common dir; it does NOTHING
# about the pointer. That the pointer is writable is real — the question this
# probe answers is WHICH repoint actually yields execution.
#
# WHAT THIS NEGATIVE CONTROL ATTEMPTS (and why git defeats it):
#   - rewrite <wt>/.git to point `gitdir:` at a FAKE gitdir UNDER the writable
#     worktree, whose `commondir` still points at the real (ro-mounted) common
#     dir so objects/refs keep resolving — the Layer-2 rev-parse/log detector
#     still passes;
#   - put in that fake gitdir a `config` setting `core.hooksPath` (and a
#     `filter.*.clean`) at attacker-controlled scripts.
# THE DEFEAT: a fake gitdir WITH a `commondir` is a *linked* worktree gitdir,
#   and git reads a linked worktree's config from the COMMON dir, NEVER from a
#   plain `config` in the per-worktree gitdir. So the planted hooksPath/filter
#   are IGNORED — git never reads them. forge's host-side autoCommitSource
#   (integration-publisher.ts:304-312) runs, finds no honored attacker config,
#   and executes NOTHING. This path is therefore NOT a viable escape.
#
# The earlier "THE ESCAPE … executes host code" theory that lived here was the
# hypothesis P6b later CORRECTED: the working vector is a STANDALONE gitdir
# (NO commondir) + objects/info/alternates, not this linked variant. P6b is the
# real, executed reproduction; P6 stays as the negative control that proves the
# linked-gitdir path is the one git already defeats.
#
# THE FIX (PRD D10) — verified in P6b, NOT here. Because this negative control's
# linked-gitdir config is never read by git, its STEP A already shows no
# execution; the FIX steps below therefore cannot *prove* fix efficacy against a
# working attack (there is none here to stop). The load-bearing fix verification
# — FIX-A killing the hook, FIX-B removing the precondition — is the reproduction
# probe P6b (STEPS 2 and 3). The steps below are retained only to mirror P6b's
# shape; read them as "even the git-defeated variant stays dead under the fixes."
#   FIX-A: every host-side git in an agent worktree uses `-c core.hooksPath=/dev/null`.
#   FIX-B: the worktree-local `.git` pointer is made NON-WRITABLE to the container
#     (forge's real mechanism: a `-v realpath(<wt>/.git):same:ro` bind-mount OVER
#     the pointer, on top of the rw /project mount; this probe emulates it with
#     `chflags uchg` / `chmod`).
#
# Run on the host:  bash p6-blue-worktree-git-pointer-hijack.sh
set -u

R="${TMPDIR:-/tmp}/fg559-p6"
rm -rf "$R"; mkdir -p "$R"
REPO="$R/proj"
WT="$R/worktrees/run1/task1"
PWNED="$R/PWNED"          # a host marker only the injected code can create
EVIL="$R/evil"            # a writable dir the agent controls, under nothing ro

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email f@l; git -C "$REPO" config user.name forge
printf 'v1\n' > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm c1
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q "$WT" -b forge/run1/task1
COMMON="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"

# The genuine pointer forge created:
echo "=== setup ==="
echo "  genuine pointer : $(cat "$WT/.git")"
echo "  common dir (ro) : $COMMON"

# ---------------------------------------------------------------------------
run_host_autocommit () {   # emulate integration-publisher.ts autoCommitSource
  local extra_c="$1"       # "" for today's forge; hooksPath=/dev/null for FIX-A
  git -C "$WT" $extra_c status --porcelain >/dev/null
  git -C "$WT" $extra_c add . 2>/dev/null || true
  git -C "$WT" $extra_c -c user.name=forge -c user.email=forge@local \
      commit -m "forge: auto-commit task1 output" >/dev/null 2>&1 || true
}

plant_attack () {          # what a blue agent does with rw /project
  rm -f "$PWNED"
  mkdir -p "$EVIL/hooks"
  # malicious hook
  cat > "$EVIL/hooks/pre-commit" <<EOF
#!/bin/sh
echo "pre-commit-RCE" > "$PWNED"
EOF
  chmod +x "$EVIL/hooks/pre-commit"
  # malicious clean filter (independent, hook-free vector)
  cat > "$EVIL/clean.sh" <<EOF
#!/bin/sh
echo "clean-filter-RCE" >> "$PWNED"
cat
EOF
  chmod +x "$EVIL/clean.sh"
  # a fake gitdir the agent fully controls, reachable because pointer is rw
  local FAKE="$WT/.evil-gitdir"
  mkdir -p "$FAKE"
  printf '%s\n' "$COMMON" > "$FAKE/commondir"          # keep objects/refs resolving
  cp "$COMMON/HEAD" "$FAKE/HEAD" 2>/dev/null || printf 'ref: refs/heads/forge/run1/task1\n' > "$FAKE/HEAD"
  cat > "$FAKE/config" <<EOF
[core]
	repositoryformatversion = 0
	hooksPath = $EVIL/hooks
[filter "pwn"]
	clean = $EVIL/clean.sh
EOF
  # redirect the worktree-local pointer at the attacker gitdir
  printf 'gitdir: %s\n' "$FAKE" > "$WT/.git"
  # route a tracked file through the malicious filter
  printf 'a.txt filter=pwn\n' > "$WT/.gitattributes"
  printf 'v2-agent-edit\n' > "$WT/a.txt"
}

detector_passes () {       # PRD D6 Layer-2, run against the (hijacked) pointer
  git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 && \
  git -C "$WT" log -1 --oneline    >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
echo
echo "=== STEP A — NEGATIVE CONTROL, TODAY (no fix): linked-gitdir config  [NO execution expected] ==="
echo "    git reads a linked worktree's config from the COMMON dir, so the planted hooksPath/filter is IGNORED"
plant_attack
if detector_passes; then echo "  D6 Layer-2 detector : PASSES against the hijacked pointer (blind to it)"; \
  else echo "  D6 Layer-2 detector : failed (would have caught it)"; fi
run_host_autocommit ""
[ -f "$PWNED" ] && echo "  *** UNEXPECTED: HOST EXECUTED AGENT CODE: $(tr '\n' ';' < "$PWNED")PWNED ***" \
                || echo "  no host execution — EXPECTED: git ignored the linked-gitdir config (see P6b for the real vector)"

echo
echo "=== STEP B — FIX-A only (host git -c core.hooksPath=/dev/null) ==="
echo "    NEGATIVE CONTROL: still no execution — git ignored the whole linked-gitdir config, so"
echo "    there is no hook OR filter to kill here. The FIX-A-kills-hook / filter-survives result"
echo "    lives in P6b STEP 2 (the working standalone-gitdir vector), not in this control."
plant_attack
run_host_autocommit "-c core.hooksPath=/dev/null"
if [ -f "$PWNED" ]; then echo "  residual  : $(tr '\n' ';' < "$PWNED") — UNEXPECTED for the linked-gitdir control"; \
  else echo "  clean     : no execution (expected — config never read)"; fi

echo
echo "=== STEP C — FIX-B (pointer made immutable) + FIX-A ==="
echo "    expected: pointer overwrite REFUSED — no agent-writable git config can exist"
plant_attack
# emulate the ro pointer bind-mount: restore the genuine pointer, freeze it
printf 'gitdir: %s\n' "$COMMON/worktrees/task1" > "$WT/.git"
chmod 0444 "$WT/.git" 2>/dev/null || true
( chflags uchg "$WT/.git" 2>/dev/null ) || true    # macOS immutable flag
# agent re-attempts the hijack against the frozen pointer:
if printf 'gitdir: %s\n' "$WT/.evil-gitdir" > "$WT/.git" 2>/dev/null; then
  echo "  pointer overwrite: SUCCEEDED (emulation not enforcing immutability on this fs)"
else
  echo "  pointer overwrite: REFUSED — agent cannot repoint the worktree gitdir"
fi
run_host_autocommit "-c core.hooksPath=/dev/null"
[ -f "$PWNED" ] && echo "  *** STILL PWNED — FIX-B emulation did not hold on this fs ***" \
                || echo "  clean     : no host execution under FIX-B"
( chflags nouchg "$WT/.git" 2>/dev/null ) || true
chmod 0644 "$WT/.git" 2>/dev/null || true

echo
echo "=== NOTE ON RESIDUAL (see PRD D10 residual table) ==="
echo "  FIX-B closes config-driven exec (hooksPath/filter/textconv/fsmonitor/merge-driver)"
echo "  because it removes the only agent-writable git config. What REMAINS after FIX-B:"
echo "   - a LEGIT common-config driver (e.g. git-lfs smudge) triggered on agent-chosen"
echo "     paths via .gitattributes in the tree — trusted code, attacker-influenced input."
echo "   - objects/info/alternates lives in the ro common dir: not agent-writable. Closed."
