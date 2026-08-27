#!/usr/bin/env bash
# Copy seed agent, constraint, runtime, and workflow files into ~/.forge/.
# Idempotent — skips files that already exist by default.
#
# FG-777 — THE FORCE CONTRACT (verbatim; the same text is carried by
# src/v2/seed-drift.ts and, via the documentation-maintainer, by
# docs/how-to-upgrade.md + README):
#
#   FORCE overwrites forge-owned files. Host authored seeds — agents (per-role
#   CLAUDE.md), constraints, and forge-raci.md — are forge-owned and ALWAYS
#   upgraded. Customization lives in <project>/.forge, which upgrade never
#   touches: an agent gets a project ADDENDUM (<project>/.forge/agents/<role>/
#   CLAUDE.md, appended to the always-current host base), constraints are an
#   additive UNION (host always applies; a project can only add/tighten), and
#   raci is a full-replacement project override (<project>/.forge/forge-raci.md).
#   Before the FIRST always-upgrade, forge backs up any host authored file you
#   had edited to $FORGE_HOME/pre-upgrade-backup/<timestamp>/ and prints how to
#   re-express it as a project override; the flip refuses to run until that
#   backup pass has completed. A genuine operator edit is never destroyed.
#
# The "refuses to run until that backup pass has completed" clause is THE GATE
# (below): the always-upgrade of agents/constraints/raci is withheld until
# FG-776's one-time host-edit backup has written its completion latch. Absent the
# latch, those three fall back to the pre-flip create-only + retain behavior and
# the operator is told the migration must run first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FORGE_HOME:-$HOME/.forge}"
CLAUDE_SKILLS_DEST="${CLAUDE_SKILLS_DEST:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"

mkdir -p "$DEST/agents" "$DEST/constraints" "$DEST/runs" "$DEST/runtimes" "$DEST/workflows" "$DEST/codex"

# FG-777 — THE OWNERSHIP DECLARATION, NOW EMPTY. Before FG-777 agents, constraints
# and forge-raci.md were AUTHORED_EXEMPT — forge seeded them once and never wrote
# over them (FG-578). FG-777 FLIPS them to forge-owned and always-upgraded: FORCE
# overwrites them exactly as it overwrites runtimes/workflows/codex, and a bare
# install refreshes them like any forge-owned file. So NO category is permanently
# operator-authored any more, and this set collapses to empty.
#
# It stays declared (empty) rather than deleted for two reasons: it remains the
# single greppable "categories forge will NEVER overwrite" tier — currently none —
# and src/v2/fg578-ownership-agreement.test.ts gates it against seed-drift.ts's
# operator-authored SEED_SPECS, which is now likewise empty. Perturb either side
# and that test fails naming both.
#
# The always-upgrade of the three flipped categories is not unconditional: it is
# GATED on the host-edit backup latch (see below). AUTHORED_EXEMPT is the PERMANENT
# never-overwrite tier; the latch gate is the TRANSITIONAL one that withholds the
# overwrite only until FG-776's one-time backup has run.
AUTHORED_EXEMPT=()

is_authored_exempt() {
  local candidate="$1" category
  # `${a[@]+"${a[@]}"}`: an EMPTY array expanded as `"${a[@]}"` under `set -u`
  # aborts on bash 3.2 (macOS's default) with "unbound variable". AUTHORED_EXEMPT
  # is empty since FG-777, so guard the expansion or a bare install breaks there.
  for category in ${AUTHORED_EXEMPT[@]+"${AUTHORED_EXEMPT[@]}"}; do
    [[ "$category" == "$candidate" ]] && return 0
  done
  return 1
}

# FG-777 — THE GATE (load-bearing safety, from FG-776). The three flipped
# categories are forge-owned, but their FORCE-overwrite MUST NOT fire until
# FG-776's one-time host-edit backup has run and written its completion latch —
# otherwise the very first always-upgrade could destroy an operator edit with no
# backup taken. This lives HERE, in the writer, for the same reason the ownership
# policy does: FORCE is a published operator-facing contract that four documented
# entry points invoke this script directly, and a guard in the `forge upgrade`
# caller alone would leave the bash overwrite able to fire unlatched on the other
# three. Absent the latch, the three fall back to the pre-flip create-only +
# retain behavior and the operator is told the migration must run first.
#
# `forge upgrade` runs the FG-776 backup ahead of this installer (upgrade.ts step
# 3-pre), so on the normal upgrade path the latch is already present and the flip
# takes effect; a bare `FORCE=1 scripts/install-seeds.sh` on a host that never ran
# the migration keeps retaining, safely.
LATCH_GATED_CATEGORIES=(agents constraints raci)
HOST_EDIT_MIGRATION_LATCH="$DEST/pre-upgrade-backup/.host-edit-migration-complete"

host_edit_migration_complete() {
  [[ -e "$HOST_EDIT_MIGRATION_LATCH" ]]
}

is_latch_gated() {
  local candidate="$1" category
  for category in "${LATCH_GATED_CATEGORIES[@]}"; do
    [[ "$category" == "$candidate" ]] && return 0
  done
  return 1
}

# Whether the gate WITHHELD an always-upgrade this run — i.e. a latch-gated file
# existed, diverged, and was retained because the migration has not run. Drives
# the "migration must run first" note in the final report.
GATE_WITHHELD=0

# Files forge declined to write because the operator owns them and their copy has
# diverged from this release's seed. Reported at the end, and parsed out of this
# script's stdout by `forge upgrade` — informational, never a failure.
RETAINED=()

# Installs ONE seed file. Outcomes:
#
#   absent                       -> create. The seed's authority is CREATION, and
#                                   neither the exemption nor the gate disables it.
#   present, permanently exempt  -> RETAIN, whatever FORCE says (AUTHORED_EXEMPT —
#                                   empty since FG-777, so unreachable today).
#   present, latch-gated + the   -> RETAIN (the FG-777 gate withholds the flip
#     migration has NOT run          until FG-776's backup latch exists). Reported
#                                     so the operator is told what forge did NOT do
#                                     and that the migration must run first.
#   present, forge-owned         -> FORCE overwrites, bare skips. The three flipped
#     (incl. latch-gated once        categories join this tier once the latch is
#      the migration has run)        present.
#
# A retained file that DIFFERS from the seed is recorded in RETAINED so the caller
# reports what forge did NOT do rather than silently no-op'ing.
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
  # Retain when the category is permanently operator-owned (AUTHORED_EXEMPT — none
  # today) OR it is one of the flipped categories and the FG-776 host-edit backup
  # has not yet run (THE GATE). Either way forge does not overwrite it here.
  if is_authored_exempt "$category" || { is_latch_gated "$category" && ! host_edit_migration_complete; }; then
    if ! cmp -s "$src" "$dstfile"; then
      RETAINED+=("${dstfile#"$DEST"/}")
      if is_latch_gated "$category"; then GATE_WITHHELD=1; fi
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

# FG-583 — DISPATCH NO LONGER CONSUMES THIS FLAT SURFACE. workflows and runtimes are
# forge-owned, dispatch-coupled surfaces. A sequential per-file `cp` loop into the
# SHARED flat $FORGE_HOME/{workflows,runtimes} could expose a torn or old/new MIXED
# set to a concurrent `forge next` — every file Zod-valid, the SET one no release
# shipped. That defect is CLOSED at the consume side: `forge upgrade` also publishes
# workflows + runtimes + the derived routing-policy.yml as ONE atomic generation via
# publishSeedGeneration (src/v2/seed-generation.ts), committed with a single
# rename(2) over the seed pointer and sourced strictly from the executing release
# (FG-577 assetRoot). Every DISPATCH entry (forge next / invoke / gate / campaign)
# now resolves workflows, runtimes, and the derived policy EXCLUSIVELY from the
# anchored generation and REFUSES a named incomplete/torn generation — it never
# consumes this flat per-file surface. The flat copies below are retained ONLY for
# the out-of-scope consumers that still read $FORGE_HOME directly: the FG-577/578/579
# seed-drift detector + FORCE remedy (seed-drift.ts SEED_SPECS) and `forge doctor`'s
# provider-runtime-registry enumeration. Migrating THOSE to the generation is the
# deferred FG-579 SEED_SPECS coverage work, explicitly out of scope here.

# Runtime YAML seeds (v2). Forge-owned execution artifacts: FORCE refreshes them —
# the drift detector's #265 (stale pi-apikey.yml rebinds the provider) remedy — and
# `forge doctor` enumerates this dir as the provider-runtime registry. DISPATCH reads
# runtimes from the atomic generation (above), not from here.
if [[ -d "$HERE/seeds/runtimes" ]]; then
  install_category "$HERE/seeds/runtimes" "$DEST/runtimes" runtimes
fi

# Workflow YAML seeds (v2). Retained flat ONLY for the seed-drift detector's
# executable-coupling readiness check; DISPATCH reads workflows from the atomic
# generation (above), never from this flat surface.
if [[ -d "$HERE/seeds/workflows" ]]; then
  install_category "$HERE/seeds/workflows" "$DEST/workflows" workflows
fi

# FG-576 (D8) — the Forge-owned Codex instruction carrier's SCAFFOLDING. Forge-owned,
# NOT in AUTHORED_EXEMPT: FORCE refreshes it exactly as it refreshes runtimes and
# workflows, because Codex's instructions file SUBSTITUTES the base instruction surface
# and a stale one silently mis-instructs an interactive orchestrator.
#
# Same flat-copy discipline as workflows: retained here ONLY so the seed-drift detector
# (seed-drift.ts SEED_SPECS `codex`) has a $FORGE_HOME baseline to measure and a
# converging `forge upgrade` remedy to name. The carrier a LAUNCH binds is the RENDERED
# artifact inside the atomic seed generation, never this flat copy.
#
# What this deliberately does NOT touch: the operator's Codex config root. Nothing is
# written under $CODEX_HOME or ~/.codex, CODEX_HOME is never redirected, and AGENTS.md,
# CLAUDE.md, config.toml and plugins are never spliced or overwritten — FORCE=1
# included. The carrier lives under Forge's own root only.
if [[ -d "$HERE/seeds/codex" ]]; then
  install_category "$HERE/seeds/codex" "$DEST/codex" codex
fi

# Host/orchestrator workflow skills (forge-campaign, forge-review-loop, etc.).
# These are discovered by Claude Code from the user-global skills dir, not
# ~/.forge/ — installing them there makes every project using forge pick them
# up, not just the forge repo. Container-agent skills (browser-tools) are a
# separate, container-only mount (src/v2/spawn.ts) and are not touched here.
#
# Skills are forge-owned: FORCE overwrites, bare skips — the same write policy as
# runtimes and workflows, and NOT in AUTHORED_EXEMPT above.
#
# FG-579: seed-drift.ts now covers this dir too. Its `skills` spec compares the
# installed CLAUDE_SKILLS_DEST tree against seeds/skills (root: "claude-skills"),
# classified forge-owned + prose — so a drifted host skill is REPORTED by
# `forge doctor` and `forge upgrade` (FORCE=1) is named as the converging remedy,
# exactly as for runtimes/workflows. The historical contract is unchanged; it is
# now detected rather than trusted to operator discipline.
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
# FG-777: the `raci` category is now forge-owned and always-upgraded (latch-gated),
# so once FG-776's host-edit backup has run this SEEDS the file and then FORCE
# refreshes it on every upgrade — the operator's routing customization moves to a
# full-replacement project override at <project>/.forge/forge-raci.md, which
# upgrade never touches. Absent the latch, seed_install_file retains the host copy
# (the gate) exactly as the pre-flip behavior did.
if [[ -f "$HERE/seeds/forge-raci.md" ]]; then
  seed_install_file "$HERE/seeds/forge-raci.md" "$DEST/forge-raci.md" raci
  if (( COPIED > 0 )); then
    echo "Installing forge-raci.md into $DEST/"
  fi
fi

# FG-777 — say what forge did NOT do, and why. A silent no-op and a silent
# clobber are the same defect wearing different clothes: in both, the operator
# cannot tell what state their host is in.
#
# On the flipped host, the only way a file is retained is THE GATE: a latch-gated
# host authored seed (agents/constraints/raci) diverged, and the FG-776 one-time
# backup has not run, so forge withheld the always-upgrade rather than overwrite an
# edit it had not yet backed up. This is transitional, not a standing exemption —
# once the migration runs, these become forge-owned and are always upgraded.
if [[ ${#RETAINED[@]} -gt 0 ]]; then
  echo ""
  echo "Retained (host authored seeds — forge did not overwrite these, and did not refresh them):"
  for r in "${RETAINED[@]}"; do
    echo "Retained: $r (differs from this release's seed at $HERE/seeds/$r)"
  done
  if (( GATE_WITHHELD )); then
    echo "These are forge-owned and ALWAYS upgraded once the one-time pre-upgrade backup has run — the"
    echo "flip is GATED on it and has NOT run on this host. Run 'forge upgrade' (it backs up any edited"
    echo "host authored file first, then refreshes these). Re-express local customization as a project"
    echo "override under <project>/.forge, which upgrade never touches."
  else
    echo "These files are yours: forge seeds them once, then leaves them alone (FORCE=1 included)."
    echo "To take this release's defaults, diff and merge them in by hand."
  fi
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
