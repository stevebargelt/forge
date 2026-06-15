---
id: FG-153
type: story
status: done
title: "Orchestrator heartbeats: track live Claude Code sessions running forge orchestrator"
---

**Closed:** 2026-05-26.

Filed 2026-05-26. Third piece of the project-registry / orchestrator-tracking arc.

**Problem.** Forge doesn't know which projects have a live Claude Code orchestrator session open. The dashboard / future Projects view can show "this project had recent forge activity" but can't show "the user has a terminal open in this project RIGHT NOW driving forge."

The user explicitly asked for the latter in 2026-05-26 conversation. Two interpretations were considered:
- A. "Projects with recent forge activity" — derivable from existing DB. Approximate (a project can have an active in-flight run with no open terminal, or an open terminal with no recent dispatch). User rejected; wants the literal answer.
- B. "Live Claude Code sessions running the forge orchestrator block" — needs the orchestrator to actively announce itself.

This ticket implements B.

**Shape.** Heartbeat-driven liveness via Claude Code hooks installed by \`forge init\`:

1. **SessionStart hook** — when Claude Code starts in a project with the forge orchestrator block, the hook writes \`~/.forge/orchestrators/<session-id>.json\`:
\`\`\`json
{
  "sessionId": "abc123",
  "projectDir": "/Users/steve/code/my-app",
  "startedAt": "2026-05-26T10:00:00Z",
  "lastSeen": "2026-05-26T10:00:00Z"
}
\`\`\`

2. **Stop hook** (fires after every agent turn) — touches \`lastSeen\` in the same file.

3. **SessionEnd hook** — deletes the file.

4. **Liveness rule** (read side): a session with \`lastSeen\` newer than N minutes is "live"; older is "stale" (the SessionEnd hook didn't fire — terminal force-killed, etc.). Stale entries can be auto-garbage-collected after some threshold.

**Installation:**
- \`forge init\` writes the hook config to \`<project>/.claude/settings.json\`, alongside existing project setup (CLAUDE.md, .forge/).
- \`--no-install-hooks\` flag (already exists for commit-msg) extends to also suppress this hook install.
- Hook script lives at \`scripts/claude-hooks/orchestrator-heartbeat\` (shell, ~30 LoC) and is symlinked into projects.

**Composes with:**
- #152 (projects registry) — Projects view displays a "🟢 live now" badge on the card for any project with a fresh heartbeat.
- #154 (dashboard Projects page) — renders the live status.

**Out of scope:**
- Live-streaming the orchestrator's CONVERSATION (just liveness, not content).
- Showing what the orchestrator is doing right now (just "alive y/n").
- Multi-user / multi-machine orchestrator visibility — single Mac, single user.

**Sizing.** Medium. Hook scripts + install flow + tests + dashboard cross-reference.

**Tradeoff to flag at implementation time:** every \`forge init\`'d project gets a Claude Code hook installed in \`<project>/.claude/settings.json\`. Some users may find that intrusive. The \`--no-install-hooks\` opt-out covers it.

**Caught:** 2026-05-26 design conversation.