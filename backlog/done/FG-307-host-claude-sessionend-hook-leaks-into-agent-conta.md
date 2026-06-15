---
id: FG-307
type: story
status: done
title: Host Claude SessionEnd hook leaks into agent containers
---

**Closed:** 2026-06-09. Commit `6fe5cb8`.

**Bug.** Hit live 2026-06-06 during #252 review-loop fixer task `task-engineer-605e97`. (Renumbered from #306 — concurrent filing collided with the doctor/upgrade follow-ups #306.) The task itself completed successfully, but dashboard stderr showed:

`SessionEnd hook [/Users/stevebargelt/code/forge/scripts/claude-hooks/orchestrator-heartbeat end] failed: /bin/sh: 1: /Users/stevebargelt/code/forge/scripts/claude-hooks/orchestrator-heartbeat: not found`

**Root cause shape:** containerized Claude Code appears to inherit the host Claude hook configuration. The configured `SessionEnd` hook points at a host absolute path under `/Users/...`, which exists on the host but not inside the agent container, so the hook logs a failure at session end. This is NOT the ntfy/Twilio notification path; it is the orchestrator-heartbeat hook used for host-side orchestrator/session liveness.

**Why it matters:** the task can be complete while the dashboard bottom stderr looks like a task failure. For a portable work-laptop setup this is confusing noise, and it suggests host-local Claude settings are leaking into agent runtime environments.

**Acceptance:**
- Containerized Forge agent runs do not attempt to execute host-only Claude hooks, OR the hook command reliably no-ops when the host path is absent.
- The fix preserves host-side orchestrator heartbeat behavior.
- A regression test covers a container/agent-style environment with a host-absolute `SessionEnd` hook and asserts the task/session does not emit a misleading hook failure.

Relations: #222 (orchestrator heartbeat/reaper), #252 (portable forge-on-forge setup), #301 (review-loop agent sessions).