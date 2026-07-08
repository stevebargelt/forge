---
id: FG-487
type: story
status: active
title: "Dashboard: host-side verification is invisible — review-loop verification phases, campaign reconcile gates, and host_verifications rows have no dashboard representation"
created: 2026-07-07
---

Operator feedback 2026-07-07 (during the overnight batch): "I don't like that the verification doesn't show in the dashboard."

## Problem

The verification activity that actually gates shipping runs host-side and is invisible on the dashboard:
- `forge review-loop` runs deterministic verification (typecheck + full test, ~8 min) BEFORE creating any run/task rows — during that window the dashboard shows nothing at all for the loop (observed repeatedly tonight; a watcher cannot distinguish "verifying" from "hung", and one loop was killed early partly for this reason).
- Each loop ROUND re-runs verification between reviewer/fixer tasks — also invisible (only the red-wide/engineer task rows show).
- `forge campaign reconcile` executes host verification gates (npm run test:all, minutes) with no run/task/dashboard trace while it decides ship eligibility.
- `host_verifications` rows (the trust evidence FG-440/FG-483 ship decisions rest on) are not rendered anywhere — an operator cannot see what verification evidence exists for a ticket/commit without sqlite.

## Goal

Verification activity and evidence are first-class on the dashboard: an operator watching a run/campaign/review-loop can see that host verification is in progress (what command, since when, for which ticket/commit), and can see the recorded host_verifications evidence per ticket/item (the same rows done-audit and campaign reconcile trust).

## Notes / shape candidates (not prescriptive)

- Minimal: emit start/finish events for host verification (review-loop rounds, reconcile gates, record-host-verification) into the events spine so existing dashboard surfaces can render them; a "verification in progress" indicator on the run/campaign card.
- Evidence view: host_verifications table per ticket/campaign item (gate, command, exit code, tested sha, recorded_at) — pairs naturally with FG-402 (attention inbox) and FG-400 (operator overview); campaign report already prints these rows in the CLI, the dashboard just has no equivalent.
- Related: F9/FG-456 notification gaps (silent unattended failures), F18 (dashboard re-derivations), FG-395 (campaign view).

## Acceptance criteria (draft — refine at pickup)

- [ ] A running review-loop is visible on the dashboard from launch (including its pre-run verification phase), with its current phase (verifying / reviewing / fixing) distinguishable.
- [ ] Campaign reconcile's host-gate execution is visible while it runs.
- [ ] host_verifications evidence is viewable per ticket/campaign item on the dashboard.
- [ ] No new lifecycle state table — render from events + existing tables (FG-477 constraint discipline).


## Evidence addendum (2026-07-07/08 autonomous session — operator escalation: "invisible work like this is bad. We need to fix it.")

The operator hit the gap three separate times in one session, each time asking what was running because the dashboard showed nothing:
1. FG-489 closing gate (`npm run test:all`, ~8 min host process) — nothing anywhere in the dashboard.
2. FG-490 pre-merge gate + review-loop chain (~25 min total; the loop's verification phase is silent even though the loop run row exists).
3. FG-490-reopen gate+loop (same shape, third ask).

Session totals that were all invisible: 10+ full `test:all` runs (~8 min each), 6 review-loop launches with quiet verification phases, plus `forge campaign reconcile` evidence passes. The orchestrator narrated each manually — the dashboard should make that narration unnecessary.

**Operator confirmation (2026-07-08): the gap matters and needs fixing ("invisible work like this is bad"), but it was explicitly NOT prioritized as the next work item — scheduling is an open operator call.** Minimum bar from tonight's pain: every long-running host-side activity forge itself initiates or knows about (review-loop phases incl. verification, campaign reconcile gates, host_verifications rows as they land) is visible with liveness (started-at / still-running). Orchestrator-run bare gates (npm test:all) need at least a breadcrumb — e.g. the orchestrator records a host-verification-in-progress marker, or the dashboard surfaces recent host_verifications rows so a completed gate is discoverable even if the in-flight window isn't.