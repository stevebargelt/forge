---
id: FG-448
type: story
status: active
title: "Dashboard: capture and display the Claude Code remote-control URL (claude.ai/code/session_...) on the project card for the active orchestrator session"
created: 2026-07-03
---

## Problem

When an orchestrator session is running inside Claude Code with remote-control enabled, Claude Code exposes a remote-control URL (`/remote-control` prints e.g. `https://claude.ai/code/session_01BR4kQAYSdYZSvB8tt4tBHN`) that lets you view/drive that session from a browser. Forge's dashboard already knows a project has a live orchestrator session (Projects view / project card, "Live now: N orchestrator session(s)") but there is no way to jump to that session's remote-control URL — you have to be in the terminal and run `/remote-control` yourself.

NOTE: this is the CLAUDE remote-control URL, NOT the git/GitHub repo URL (that is FG-438). Different artifact entirely.

## What we know about capturing it

The remote-control token is NOT in the environment (`CLAUDE_CODE_SESSION_ID` is a different UUID, e.g. `5480f705-...`, not the `session_01...` token). But it IS persisted on disk:

- `~/.claude/projects/<project-slug>/<CLAUDE_CODE_SESSION_ID>.jsonl` — the per-session transcript (project-slug = project path with `/`→`-`); contains the `https://claude.ai/code/session_...` URL/token.
- `~/.claude/history.jsonl` — global history; also contains the token.
- `~/.claude/settings.json` has `remoteControlAtStartup` (whether the URL exists without a manual `/remote-control`).

Cleanest source: forge reads `CLAUDE_CODE_SESSION_ID` from its own env when an orchestrator command runs, derives the project transcript path, and extracts the URL — associating it with the project's active orchestrator session/run.

## Goal

The dashboard project card (or the live-session indicator) surfaces the Claude Code remote-control URL for the active orchestrator session, so an operator can open the browser session directly from the dashboard.

## Acceptance Criteria

- When a forge orchestrator command runs inside a Claude Code session that has a remote-control URL, forge captures that URL and associates it with the project's active orchestrator session/run (source: the per-session transcript keyed by `CLAUDE_CODE_SESSION_ID`, or `history.jsonl`).
- The dashboard project card renders the URL as an openable link for a project with a live orchestrator session; absent/none when there is no remote-control URL.
- Capture degrades gracefully: `remoteControlAtStartup` off / `/remote-control` never run / transcript unreadable → no link, no error.
- The captured URL is scoped to the correct session — do not show a stale URL from a previous, ended session as if it were live.

## Security / caveats (call out in design)

- The remote-control URL grants control of the session. Surfacing it in the dashboard means anyone with dashboard access (port 8024) can open/drive the session. Decide whether it should be gated / masked / copy-only, and whether it is shown only for currently-live sessions.
- The Claude Code transcript/history jsonl is an undocumented internal format; parsing it is inherently fragile and may break across Claude Code versions. Isolate the parsing and fail closed.
- Do not persist the URL longer than the session is live (it is a live-control credential, not durable project metadata).

## Refs

- ~/.claude/projects/<slug>/<sessionId>.jsonl, ~/.claude/history.jsonl, ~/.claude/settings.json (remoteControlAtStartup)
- Distinct from FG-438 (GitHub repo link). Related surface: the dashboard Projects live-session indicator (`forge projects show` "Live now").
