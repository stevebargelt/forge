#!/usr/bin/env bash
# Copy seed agent, constraint, runtime, and workflow files into ~/.forge/.
# Idempotent — uses cp -n by default. FORCE=1 to overwrite.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FORGE_HOME:-$HOME/.forge}"

mkdir -p "$DEST/agents" "$DEST/constraints" "$DEST/runs" "$DEST/runtimes" "$DEST/workflows"

CP_FLAG="-n"
if [[ "${FORCE:-0}" == "1" ]]; then CP_FLAG="-f"; fi

echo "Installing agents into $DEST/agents/"
cp -R $CP_FLAG "$HERE/seeds/agents/." "$DEST/agents/"

echo "Installing constraints into $DEST/constraints/"
cp -R $CP_FLAG "$HERE/seeds/constraints/." "$DEST/constraints/"

# Runtime YAML seeds (v2). Required for the v2 YAML-driven runner to find
# bedrock/oauth/apikey runtime definitions. Installs alongside agents.
if [[ -d "$HERE/seeds/runtimes" ]]; then
  echo "Installing runtimes into $DEST/runtimes/"
  cp -R $CP_FLAG "$HERE/seeds/runtimes/." "$DEST/runtimes/"
fi

# Workflow YAML seeds (v2). Installed lazily — the .yml.draft files in
# docs/prds/yaml-orchestrator-116/ become seeds/workflows/*.yml when v2
# cutover happens. Stub the install path so the dir exists in the meantime.
if [[ -d "$HERE/seeds/workflows" ]]; then
  echo "Installing workflows into $DEST/workflows/"
  cp -R $CP_FLAG "$HERE/seeds/workflows/." "$DEST/workflows/"
fi

# Orphan-warning for pre-rename seed dirs. After the v2 agent rename
# (architect → architecture-advisor, etc.), users with prior installs will
# have the old dirs sitting alongside the new ones. They're harmless but
# confusing. Surface them.
ORPHANS=()
for old in architect planner implementer verifier frontend-implementer backend-implementer infosec-implementer investigator; do
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
