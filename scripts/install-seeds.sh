#!/usr/bin/env bash
# Copy seed agent, constraint, runtime, and workflow files into ~/.forge/.
# Idempotent — skips files that already exist by default. FORCE=1 to overwrite.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FORGE_HOME:-$HOME/.forge}"
CLAUDE_SKILLS_DEST="${CLAUDE_SKILLS_DEST:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"

mkdir -p "$DEST/agents" "$DEST/constraints" "$DEST/runs" "$DEST/runtimes" "$DEST/workflows"

# Recursively copies regular files from $1 into $2. Default (FORCE unset):
# skips any file that already exists at the destination, preserving local
# edits, while still installing newly-seeded files that aren't there yet.
# Deliberately avoids `cp -n`'s exit status: BSD cp (macOS) exits 1 when it
# skips an existing file, while GNU cp exits 0 for the same skip — under
# `set -e` that made every re-run abort on macOS despite nothing going wrong.
seed_copy() {
  local src="$1" dst="$2" file rel
  if [[ ! -d "$src" ]]; then
    echo "seed_copy: source dir missing: $src" >&2
    return 1
  fi
  while IFS= read -r -d '' file; do
    rel="${file#"$src"/}"
    mkdir -p "$dst/$(dirname "$rel")"
    if [[ "${FORCE:-0}" == "1" || ! -e "$dst/$rel" ]]; then
      cp -f "$file" "$dst/$rel"
    fi
  done < <(find "$src" -type f -print0)
}

echo "Installing agents into $DEST/agents/"
seed_copy "$HERE/seeds/agents" "$DEST/agents"

echo "Installing constraints into $DEST/constraints/"
seed_copy "$HERE/seeds/constraints" "$DEST/constraints"

# Runtime YAML seeds (v2). Required for the v2 YAML-driven runner to find
# bedrock/oauth/apikey runtime definitions. Installs alongside agents.
if [[ -d "$HERE/seeds/runtimes" ]]; then
  echo "Installing runtimes into $DEST/runtimes/"
  seed_copy "$HERE/seeds/runtimes" "$DEST/runtimes"
fi

# Workflow YAML seeds (v2). Installed lazily — the .yml.draft files in
# docs/prds/yaml-orchestrator-116/ become seeds/workflows/*.yml when v2
# cutover happens. Stub the install path so the dir exists in the meantime.
if [[ -d "$HERE/seeds/workflows" ]]; then
  echo "Installing workflows into $DEST/workflows/"
  seed_copy "$HERE/seeds/workflows" "$DEST/workflows"
fi

# Host/orchestrator workflow skills (forge-campaign, forge-review-loop, etc.).
# These are discovered by Claude Code from the user-global skills dir, not
# ~/.forge/ — installing them there makes every project using forge pick them
# up, not just the forge repo. Container-agent skills (browser-tools) are a
# separate, container-only mount (src/v2/spawn.ts) and are not touched here.
if [[ -d "$HERE/seeds/skills" ]]; then
  echo "Installing skills into $CLAUDE_SKILLS_DEST/"
  mkdir -p "$CLAUDE_SKILLS_DEST"
  for skill_dir in "$HERE"/seeds/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    mkdir -p "$CLAUDE_SKILLS_DEST/$skill_name"
    seed_copy "${skill_dir%/}" "$CLAUDE_SKILLS_DEST/$skill_name"
  done
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
if [[ -f "$HERE/seeds/forge-raci.md" ]]; then
  if [[ "${FORCE:-0}" == "1" || ! -f "$DEST/forge-raci.md" ]]; then
    echo "Installing forge-raci.md into $DEST/"
    cp "$HERE/seeds/forge-raci.md" "$DEST/forge-raci.md"
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
