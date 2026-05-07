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

trap 'rm -rf "$HERE/designer-skills"' EXIT

# Verify the base image exists. Use `docker images -q` rather than `docker image
# inspect` because the latter fails on Docker Desktop's containerd-store images
# (where `docker images` lists the image fine but `docker image inspect` says
# "no such image"). We just need to know the build will find the FROM target.
if [[ -z "$(docker images -q agent-dev-worker:latest 2>/dev/null)" ]]; then
  echo "ERROR: agent-dev-worker image not found. Run docker/build.sh first." >&2
  exit 1
fi

docker build -t agent-designer-worker -f "$HERE/agent-designer-worker.Dockerfile" "$HERE"
echo "Built agent-designer-worker."
