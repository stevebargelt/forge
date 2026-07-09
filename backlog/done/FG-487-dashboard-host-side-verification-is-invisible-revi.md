---
id: FG-487
type: story
status: done
title: "Dashboard: host-side verification is invisible — review-loop verification phases, campaign reconcile gates, and host_verifications rows have no dashboard representation"
created: 2026-07-07
closed: 2026-07-09
closed_commit: 949eff0
---

Operator feedback 2026-07-07 (during the overnight batch): "I don't like that the verification doesn't show in the dashboard."

## Problem

The verification activity that actually gates shipping runs host-side and is invisible on the dashboard:
- `forge review-loop` runs its verification phase BEFORE creating any run/task rows — during that window the dashboard shows nothing at all for the loop (observed repeatedly; a watcher cannot distinguish "verifying" from "hung", and one loop was killed early partly for this reason). Since FG-501 that phase is usually a CI wait (reviewed sha, required checks, polling) rather than a local suite run — still invisible on the dashboard either way.
- Each loop ROUND re-runs verification between reviewer/fixer tasks — also invisible (only the red-wide/engineer task rows show).
- `forge campaign reconcile` executes host verification gates (minutes) with no run/task/dashboard trace while it decides ship eligibility (when it real-execs rather than reusing covering evidence).
- `host_verifications` rows (the trust evidence FG-440/FG-483 ship decisions rest on, now including `source: ci` rows) are not rendered anywhere — an operator cannot see what verification evidence exists for a ticket/commit without sqlite.

## Goal

Verification activity and evidence are first-class on the dashboard: an operator watching a run/campaign/review-loop can see that host verification is in progress (what command or CI wait, since when, for which ticket/commit), and can see the recorded host_verifications evidence per ticket/item (the same rows done-audit and campaign reconcile trust).

## Notes / shape candidates (not prescriptive)

- Minimal: emit start/finish events for host verification (review-loop rounds, reconcile gates, record-host-verification) into the events spine so existing dashboard surfaces can render them; a "verification in progress" indicator on the run/campaign card.
- Evidence view: host_verifications table per ticket/campaign item (gate, command, exit code, tested sha, source, recorded_at) — pairs naturally with FG-402 (attention inbox) and FG-400 (operator overview); campaign report already prints these rows in the CLI, the dashboard just has no equivalent.
- Related: F9/FG-456 notification gaps (silent unattended failures), F18 (dashboard re-derivations), FG-395 (campaign view).

## Acceptance Criteria

- [ ] A launched `forge review-loop` is visible on the dashboard from launch: a run row exists at/before verification start, with the loop's current phase distinguishable (verifying / waiting-on-CI / reviewing / fixing) and liveness (phase started-at, still-running).
- [ ] Review-loop verification activity emits durable start/finish events into the events spine per round — covering the FG-501 CI-wait (reviewed sha, required check contexts) and the local fallback (command, tier) — and the dashboard renders them.
- [ ] Campaign reconcile's host-gate executions (real execs, not evidence reuse) emit the same start/finish events and are visible while running (command, ticket/item, tested sha, started-at).
- [ ] host_verifications evidence is viewable on the dashboard per ticket/campaign item: gate name, command, exit code, tested sha, source (host|ci), recorded_at.
- [ ] Orchestrator-run bare host gates are discoverable after the fact: the dashboard surfaces recent host_verifications rows, so a completed gate is visible even if its in-flight window wasn't.
- [ ] No new lifecycle state table — render from events + existing tables (FG-477 constraint discipline).
- [ ] Tests cover: event emission at each review-loop phase boundary (CI-wait and local fallback), reconcile gate-exec events, and the dashboard's evidence rendering.

## Evidence addendum (2026-07-07/08 autonomous session — operator escalation: "invisible work like this is bad. We need to fix it.")

The operator hit the gap three separate times in one session, each time asking what was running because the dashboard showed nothing:
1. FG-489 closing gate (`npm run test:all`, ~8 min host process) — nothing anywhere in the dashboard.
2. FG-490 pre-merge gate + review-loop chain (~25 min total; the loop's verification phase is silent even though the loop run row exists).
3. FG-490-reopen gate+loop (same shape, third ask).

Session totals that were all invisible: 10+ full `test:all` runs (~8 min each), 6 review-loop launches with quiet verification phases, plus `forge campaign reconcile` evidence passes. The orchestrator narrated each manually — the dashboard should make that narration unnecessary.

**Operator confirmation (2026-07-08): the gap matters and needs fixing ("invisible work like this is bad"). Minimum bar: every long-running host-side activity forge itself initiates or knows about (review-loop phases incl. verification/CI-wait, campaign reconcile gates, host_verifications rows as they land) is visible with liveness (started-at / still-running). Orchestrator-run bare gates (npm test:all) need at least a breadcrumb — e.g. the dashboard surfaces recent host_verifications rows so a completed gate is discoverable even if the in-flight window isn't.**

2026-07-09 refinement note: FG-501 (merged) moved most review-loop verification to a CI wait and made evidence reusable; the invisible-work gap remains for the loop's phases (including the CI wait itself), reconcile's real execs, and the evidence rows. AC above restructured from the earlier draft during campaign readiness refinement — scope unchanged.
