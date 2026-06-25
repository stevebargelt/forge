---
id: FG-411
type: story
status: active
title: Campaign show/report (and start/resume) crash when a source ticket was deleted — resolvePlan throws uncaught
created: 2026-06-25
---

## Problem

campaignBlocker() (src/campaign/executor.ts) calls resolvePlan() for the stale-plan check. resolvePlan throws (e.g. 'Tickets not found: FG-xxx') when a campaign's source ticket has been deleted from the backlog since planning. Because show/report (src/campaign/report.ts computeNextShowAction/computeSafety/computeNextOperatorAction) and the start/resume CLI all call campaignBlocker, a deleted source ticket makes ALL of them exit 1 with an uncaught error instead of degrading gracefully.

show/report are meant to be ALWAYS-AVAILABLE diagnostics: they should render the persisted campaign + item state and advise recovery/re-plan even when the backlog has drifted. start/resume should refuse cleanly (a typed stop reason), not crash.

Surfaced as a residual concern after FG-394 (the consistency fix routed all surfaces through campaignBlocker, which exposed this).

## Acceptance Criteria

- campaignBlocker handles a resolvePlan failure WITHOUT throwing: catch it and return a blocker stop reason meaning 'plan can no longer be resolved' (reuse 'stale_plan', or add a dedicated reason like 'plan_unresolvable' if a distinct operator message is warranted — a deleted ticket is arguably distinct from a hash drift).
- forge campaign show and forge campaign report render the persisted campaign + item state for a campaign whose source ticket was deleted, and advise re-plan/recovery — they MUST NOT exit non-zero with an uncaught error.
- forge campaign start / resume on such a campaign refuse with the clean typed stop reason (non-zero exit, clear message), not an uncaught throw.
- Tests: delete a source ticket after planning, then assert show/report succeed (exit 0, render state, advise re-plan) and start/resume refuse cleanly.

## Notes
Single-point fix at campaignBlocker is preferred (benefits all four surfaces). Relates to FG-394; the diagnostics-always-available property is the key requirement.