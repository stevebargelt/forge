# Designer worker — extends agent-dev-worker with the Pencil CLI, the pencil-design
# Claude skill, and the Pencil MCP server registered as a Claude Code MCP server.
# Used by designer agents for UI/UX design tasks. Built separately so Pencil's deps
# don't bloat the default agent image.
#
# Build agent-dev-worker first (or alongside): docker/build.sh && docker/build-designer.sh
FROM agent-dev-worker

USER root

# Pencil CLI. Installed globally so `pencil` is on PATH for the agent user. Ships
# native MCP server binaries for darwin/linux/windows in dist/out/. We symlink the
# right Linux binary to a stable path so the MCP config can reference it without
# arch-conditional logic.
RUN npm install -g @pencil.dev/cli \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         arm64) bin=mcp-server-linux-arm64 ;; \
         amd64) bin=mcp-server-linux-x64 ;; \
         *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
       esac \
    && ln -s "/usr/lib/node_modules/@pencil.dev/cli/dist/out/$bin" /usr/local/bin/pencil-mcp-server

# Skill installation: copy the pencil-design skill into the agent user's Claude Code
# skills dir. Claude Code discovers skills under ~/.claude/skills/<name>/SKILL.md and
# auto-loads them based on the description in the skill's frontmatter.
COPY designer-skills/pencil-design/SKILL.md /home/agent/.claude/skills/pencil-design/SKILL.md
RUN chown -R agent:agent /home/agent/.claude/skills

# Pencil MCP server config. Loaded into the agent's Claude session via --mcp-config
# at spawn time (see src/spine/spawn.ts). Pencil's MCP tools become first-class
# mcp__pencil__* tools in the agent's toolbox — no Bash gymnastics needed.
COPY designer-mcp.json /etc/forge/designer-mcp.json

USER agent
WORKDIR /workspace
