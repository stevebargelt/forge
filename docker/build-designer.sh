#!/usr/bin/env bash
# Build the agent-designer-worker image. Requires agent-dev-worker to be built first
# (this image FROM's it). Re-run after editing the Dockerfile or the pencil skill.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

# The skill file lives under seeds/agents/designer/skills/. Stage it into the build
# context so the Dockerfile's COPY can see it. Same pattern as corp-root.pem.
SKILL_SRC="$REPO_ROOT/seeds/agents/designer/skills/pencil-design/SKILL.md"
if [[ ! -f "$SKILL_SRC" ]]; then
  echo "ERROR: pencil skill not found at $SKILL_SRC" >&2
  exit 1
fi
mkdir -p "$HERE/designer-skills/pencil-design"
cp "$SKILL_SRC" "$HERE/designer-skills/pencil-design/SKILL.md"

# designer-mcp.json is checked in alongside the Dockerfile, so it's already in the
# context — but the Dockerfile COPYs it from a relative path, so we don't need to
# stage it separately. (Keeping it next to the Dockerfile keeps things simple.)

trap 'rm -rf "$HERE/designer-skills"' EXIT

# Verify the base image exists; FROM agent-dev-worker fails confusingly otherwise.
if ! docker image inspect agent-dev-worker >/dev/null 2>&1; then
  echo "ERROR: agent-dev-worker image not found. Run docker/build.sh first." >&2
  exit 1
fi

docker build -t agent-designer-worker -f "$HERE/agent-designer-worker.Dockerfile" "$HERE"
echo "Built agent-designer-worker."
