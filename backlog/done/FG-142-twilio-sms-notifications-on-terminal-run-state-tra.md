---
id: FG-142
type: story
status: done
title: Twilio SMS notifications on terminal run-state transitions
---

**Closed:** 2026-05-25. Commit `277279cba7919e86243e9959f8ea112505d9c86a`.

Filed 2026-05-25. Add an opt-in notification surface to forge so the host gets pinged when a workflow finishes (or otherwise stops making autonomous progress).

**Why filed.** Today a forge workflow ends silently. The user has to keep tabs on the orchestrator or refresh the dashboard to know when a run finished. For long-running multi-phase work (architect → plan → build with fanout → verify), that's friction: kick off, walk away, no signal when it's done. A Stop hook in Claude Code is the wrong tool (fires per orchestrator chat turn, not per workflow); the right signal is run-state transitions inside forge.

**Scope (opt-in, off by default).** No notification fires unless `FORGE_NOTIFY=twilio` is set. Provider-specific creds (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`) come from env vars; never stored in `~/.forge/` or committed. Optional `FORGE_NOTIFY_ON=complete,failed,blocked_by_red` overrides the default trigger set.

**Trigger set (defaults).** Three terminal-ish transitions:
1. `runs.status` flips to `complete` — workflow shipped.
2. `runs.status` flips to `abandoned` — workflow died/killed.
3. Any task transitions to `blocked_by_red` — run parked, needs the human.

Excludes `awaiting_gate` by default (would ping during normal gate flow — noisy). Customizable via FORGE_NOTIFY_ON.

**Message format.** Single SMS segment, ~70 chars:
```
forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s
```
Includes: run id (so `forge show <id>` resolves), state, workflow name + title, duration.

**Verification surface.** New `forge notify test` subcommand — sends a fixed "forge: test message from <hostname>" SMS so users can confirm the path works without waiting for a real workflow.

**Out of scope for this ticket.**
- Other providers (Pushover, ntfy, Slack, etc.). If they're needed later, refactor to a provider abstraction at that time. Single provider today.
- Retry on SMS failure. Log + continue. SMS reliability isn't worth complicating the run path.
- Rate limiting on forge side. Twilio's limits are high; personal use won't hit them.
- Notification for non-forge work (long Claude sessions outside any forge run). Separate concern.

**Sizing.** Small. ~80 LoC for the notify module + the call-site wiring + the test command. Plus the doc.

**Docs.** New `docs/how-to-set-up-notifications.md` (top-level how-to) covering: which env vars to set, how to verify with `forge notify test`, what triggers a notification, how to opt out, troubleshooting. NOT how to set up Twilio itself — users figure that out from Twilio docs.

**Caught:** 2026-05-25 conversation about Claude Code Stop hooks vs. forge-side notification.