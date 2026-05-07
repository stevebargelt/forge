# Designer worker — extends agent-dev-worker with the Pencil CLI and the
# pencil-design Claude skill. Used by designer agents for UI/UX design tasks.
# Built separately so Pencil's deps don't bloat the default agent image.
#
# Note on MCP: Pencil ships native MCP server binaries in its dist/out/, but they
# require an --app argument pointing at a running Pencil desktop/IDE app to bridge
# to. We have no Pencil app in this headless container, so the MCP path doesn't
# apply. The agent drives `pencil interactive` (REPL via stdin) instead — see the
# pencil-design skill in seeds/agents/designer/.
#
# Build agent-dev-worker first (or alongside): docker/build.sh && docker/build-designer.sh
FROM agent-dev-worker

USER root

# Pencil CLI. Installed globally so `pencil` is on PATH for the agent user.
RUN npm install -g @pencil.dev/cli

# Skill installation: copy the pencil-design skill into the agent user's Claude Code
# skills dir. Claude Code discovers skills under ~/.claude/skills/<name>/SKILL.md and
# auto-loads them based on the description in the skill's frontmatter.
COPY designer-skills/pencil-design/SKILL.md /home/agent/.claude/skills/pencil-design/SKILL.md
RUN chown -R agent:agent /home/agent/.claude/skills

USER agent
WORKDIR /workspace
