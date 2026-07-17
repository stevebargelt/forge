#!/usr/bin/env bash
# Copy seed agent, constraint, runtime, and workflow files into ~/.forge/.
# Idempotent — skips files that already exist by default. FORCE=1 to overwrite.
#
# FG-578: FORCE=1 does NOT mean "overwrite everything". It means "overwrite every
# file FORGE owns". The categories in AUTHORED_EXEMPT below are the operator's;
# forge seeds them once and never writes over them again. See that declaration.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FORGE_HOME:-$HOME/.forge}"
CLAUDE_SKILLS_DEST="${CLAUDE_SKILLS_DEST:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"

mkdir -p "$DEST/agents" "$DEST/constraints" "$DEST/runs" "$DEST/runtimes" "$DEST/workflows"

# FG-578 — THE OWNERSHIP DECLARATION. Categories the OPERATOR authors. forge may
# CREATE these (a host with no RACI has nothing to route with), but may never
# re-install over them — not under FORCE=1, not from any of the four documented
# entry points. The policy lives HERE, in the writer, because FORCE is a
# published operator-facing contract (docs/how-to-upgrade.md, README.md,
# how-to-new-workflow.md and seed-drift.ts all tell operators to run this script
# directly); a guard in the `forge upgrade` caller would protect one caller and
# leave the other three clobbering.
#
# Why these three:
#   raci        — ~/.forge/forge-raci.md is "the installed host RACI source
#                 (authoring view)" (util/paths.ts). Operators change it through
#                 `forge raci apply`, the gated confirm-before-write channel that
#                 exists precisely so routing changes are reviewable, and every
#                 such change is audited to raci-audit.log. A surface the
#                 operator is INVITED to edit cannot be legally re-installed.
#   agents      — no project-level override exists (util/paths.ts), so ~/.forge
#   constraints   IS the only place an operator can edit them. That makes them
#                 authored surfaces by construction, not by convention.
#
# This is not a new policy: seed-drift.ts already classifies exactly these three
# autoRefreshable:false — "prose that may carry local edits → warn, never
# auto-overwrite" — and runtimes autoRefreshable:true, "forge-owned execution
# artifact, safe to overwrite". FG-335 decided it and shipped only the detector.
# This is its unbuilt half. The two sets MUST stay identical;
# src/v2/fg578-ownership-agreement.test.ts fails if they ever disagree.
#
# Deliberately NOT here: routing-policy.yml (lives beside forge-raci.md in
# $FORGE_HOME but is DERIVED — its correctness depends on being overwritten;
# ownership is not location) and the skills dir (unchanged on purpose — see the
# skills block below).
AUTHORED_EXEMPT=(agents constraints raci)

is_authored_exempt() {
  local candidate="$1" category
  for category in "${AUTHORED_EXEMPT[@]}"; do
    [[ "$category" == "$candidate" ]] && return 0
  done
  return 1
}

# Files forge declined to write because the operator owns them and their copy has
# diverged from this release's seed. Reported at the end, and parsed out of this
# script's stdout by `forge upgrade` — informational, never a failure.
RETAINED=()

# Installs ONE seed file. Three outcomes, because neither of the two the old
# single predicate offered was correct for an authored file — FORCE clobbered
# authored work, and a bare run skipped existing files, making a plain re-install
# a no-op against drift by construction:
#
#   absent                    -> create. The seed's authority is CREATION; the
#                                exemption limits it, it does not disable it.
#   present, authored-exempt  -> RETAIN, whatever FORCE says. Report it if it
#                                differs from the seed, so the operator is told
#                                what forge did NOT do rather than silently
#                                no-op'd.
#   present, forge-owned      -> FORCE overwrites, bare skips. Unchanged.
#
# Sets COPIED=1 only when bytes were actually written. The caller prints its
# "Installing …" header from that and nothing else: `forge upgrade` counts those
# lines to report what it refreshed, so echoing one for a file that was retained
# would be a false refresh claim manufactured by a string-matching seam.
seed_install_file() {
  local src="$1" dstfile="$2" category="$3"
  COPIED=0
  if [[ ! -e "$dstfile" ]]; then
    cp -f "$src" "$dstfile"
    COPIED=1
    return 0
  fi
  if is_authored_exempt "$category"; then
    if ! cmp -s "$src" "$dstfile"; then
      RETAINED+=("${dstfile#"$DEST"/}")
    fi
    return 0
  fi
  if [[ "${FORCE:-0}" == "1" ]]; then
    cp -f "$src" "$dstfile"
    COPIED=1
  fi
}

# Recursively copies regular files from $1 into $2, under $3's ownership policy.
# Deliberately avoids `cp -n`'s exit status: BSD cp (macOS) exits 1 when it
# skips an existing file, while GNU cp exits 0 for the same skip — under
# `set -e` that made every re-run abort on macOS despite nothing going wrong.
# Sets SEED_COPY_WROTE to the number of files actually written.
seed_copy() {
  local src="$1" dst="$2" category="$3" file rel
  SEED_COPY_WROTE=0
  if [[ ! -d "$src" ]]; then
    echo "seed_copy: source dir missing: $src" >&2
    return 1
  fi
  while IFS= read -r -d '' file; do
    rel="${file#"$src"/}"
    mkdir -p "$dst/$(dirname "$rel")"
    seed_install_file "$file" "$dst/$rel" "$category"
    SEED_COPY_WROTE=$(( SEED_COPY_WROTE + COPIED ))
  done < <(find "$src" -type f -print0)
}

# Header AFTER the copy, and only if the copy wrote something: a category whose
# every file was retained or already current was not "installed", and saying so
# would be the false-refresh claim above.
install_category() {
  local src="$1" dst="$2" category="$3"
  seed_copy "$src" "$dst" "$category"
  if (( SEED_COPY_WROTE > 0 )); then
    echo "Installing $category into $dst/"
  fi
}

install_category "$HERE/seeds/agents" "$DEST/agents" agents

install_category "$HERE/seeds/constraints" "$DEST/constraints" constraints

# Runtime YAML seeds (v2). Required for the v2 YAML-driven runner to find
# bedrock/oauth/apikey runtime definitions. Installs alongside agents. Forge-owned
# execution artifacts: FORCE refreshes them, which is the whole point of the
# drift detector's remedy.
if [[ -d "$HERE/seeds/runtimes" ]]; then
  install_category "$HERE/seeds/runtimes" "$DEST/runtimes" runtimes
fi

# Workflow YAML seeds (v2). Installed lazily — the .yml.draft files in
# docs/prds/yaml-orchestrator-116/ become seeds/workflows/*.yml when v2
# cutover happens. Stub the install path so the dir exists in the meantime.
if [[ -d "$HERE/seeds/workflows" ]]; then
  install_category "$HERE/seeds/workflows" "$DEST/workflows" workflows
fi

# Host/orchestrator workflow skills (forge-campaign, forge-review-loop, etc.).
# These are discovered by Claude Code from the user-global skills dir, not
# ~/.forge/ — installing them there makes every project using forge pick them
# up, not just the forge repo. Container-agent skills (browser-tools) are a
# separate, container-only mount (src/v2/spawn.ts) and are not touched here.
#
# FG-578: knowingly UNCHANGED, said out loud rather than left to silence. The
# skills dir is outside $FORGE_HOME, so seed-drift.ts cannot see it and there is
# no detector for forge to agree with — giving it an ownership policy here would
# invent one surface's taxonomy in isolation. Its remedy story is FG-582's shape.
# So skills keep the historical contract exactly: FORCE overwrites, bare skips.
if [[ -d "$HERE/seeds/skills" ]]; then
  mkdir -p "$CLAUDE_SKILLS_DEST"
  skills_wrote=0
  for skill_dir in "$HERE"/seeds/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    mkdir -p "$CLAUDE_SKILLS_DEST/$skill_name"
    seed_copy "${skill_dir%/}" "$CLAUDE_SKILLS_DEST/$skill_name" skills
    skills_wrote=$(( skills_wrote + SEED_COPY_WROTE ))
  done
  if (( skills_wrote > 0 )); then
    echo "Installing skills into $CLAUDE_SKILLS_DEST/"
  fi
fi

# Model-policy example (v2, AWN-7). Installed as model-policy.EXAMPLE.yml — NOT
# the active model-policy.yml. Model resolution stays in legacy mode until a user
# deliberately copies the example to ~/.forge/model-policy.yml. Installing the
# example must never flip behavior.
if [[ -f "$HERE/seeds/model-policy.example.yml" ]]; then
  if [[ "${FORCE:-0}" == "1" || ! -f "$DEST/model-policy.example.yml" ]]; then
    echo "Installing model-policy.example.yml into $DEST/"
    cp "$HERE/seeds/model-policy.example.yml" "$DEST/model-policy.example.yml"
  fi
fi

# RACI seed (v2). The orchestrator references this at
# `~/.forge/forge-raci.md` to classify prompts and route work.
#
# FG-578: the `raci` category is AUTHORED_EXEMPT, so this SEEDS the file and
# never re-installs over it. That is the same discipline model-policy.example.yml
# above already follows — install the example under a non-active name so
# installing it can never flip behavior, leaving the operator's active copy
# untouchable. The RACI is the surface that escaped it, not an innovation.
if [[ -f "$HERE/seeds/forge-raci.md" ]]; then
  seed_install_file "$HERE/seeds/forge-raci.md" "$DEST/forge-raci.md" raci
  if (( COPIED > 0 )); then
    echo "Installing forge-raci.md into $DEST/"
  fi
fi

# FG-578 — say what forge did NOT do, and why. A silent no-op and a silent
# clobber are the same defect wearing different clothes: in both, the operator
# cannot tell what state their host is in.
#
# NAME THE FAILURE THIS EXEMPTION INTRODUCES: an operator whose authored file is
# now never refreshed runs old prose against new forge code. The exemption is
# still right — losing an audited routing change is worse — but the drift is real
# and is reported here informationally. It is NOT an error and NOT a refresh:
# these files are out of forge's control path, and only the operator can decide
# whether their edits still want this release's defaults merged in.
if [[ ${#RETAINED[@]} -gt 0 ]]; then
  echo ""
  echo "Retained (operator-authored — forge did not overwrite these, and did not refresh them):"
  for r in "${RETAINED[@]}"; do
    echo "Retained: $r (differs from this release's seed at $HERE/seeds/$r)"
  done
  echo "These files are yours: forge seeds them once, then leaves them alone (FORCE=1 included)."
  echo "To take this release's defaults, diff and merge them in by hand."
fi

# Orphan-warning for pre-rename seed dirs. After the v2 agent rename
# (architect → architecture-advisor, etc.), users with prior installs will
# have the old dirs sitting alongside the new ones. They're harmless but
# confusing. Surface them.
ORPHANS=()
for old in architect planner implementer verifier frontend-implementer backend-implementer infosec-implementer investigator framer recommender assessor reporter; do
  if [[ -d "$DEST/agents/$old" ]]; then
    ORPHANS+=("$old")
  fi
done
if [[ ${#ORPHANS[@]} -gt 0 ]]; then
  echo ""
  echo "Note: pre-rename agent dirs detected at $DEST/agents/ (orphaned by v2 rename):"
  for o in "${ORPHANS[@]}"; do echo "  $o"; done
  echo "These are not referenced by anything; safe to remove with:"
  echo "  rm -rf $DEST/agents/{$(IFS=,; echo "${ORPHANS[*]}")}"
fi

echo ""
echo "Done."
echo "Run 'forge status' to verify."
