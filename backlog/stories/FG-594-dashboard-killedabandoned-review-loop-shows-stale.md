---
id: FG-594
type: story
status: active
title: "Dashboard: killed/abandoned review-loop shows 'stale · waiting-on-ci' forever — verification-event badge ignores run terminal status"
created: 2026-07-19
---

## Problem

A killed / abandoned / crashed review-loop shows on the dashboard as **`stale · waiting-on-ci`** (or
`verifying` / `reviewing` / `fixing`) **indefinitely** — for the full `STALE_LOOKBACK_MS` (24h) — even after
its owning run is `abandoned`, `failed`, or `complete`. The badge is driven purely by verification EVENTS and
does not consult the run's terminal status.

## Root cause

`dashboard/src/queries.ts` — the in-progress/stale verification badge (the `inProgressVerifications` / stale
path, and the phase derived alongside `reviewLoopRunPhases`) is computed by pairing
`review_loop.verification_started` events against `review_loop.verification_finished` events **by
`attemptId`**. A `verification_started` with no matching `verification_finished` is rendered as in-progress,
and once past `REVIEW_LOOP_VERIFICATION_STALE_MS` it is INCLUDED with `stale: true` (FG-487 fix — a
past-cutoff unmatched start is deliberately flagged rather than dropped), bounded only by
`STALE_LOOKBACK_MS = 24h`.

**Neither the started/finished pairing NOR the stale path checks the owning run's status.** So when a
review-loop process dies (killed mid-CI-wait, crashed, host reboot) after emitting `verification_started`
but before `verification_finished`, the dangling start renders as live in-flight work for 24h — regardless of
the run being `abandoned`/`failed`/`complete`. (Note `reviewLoopRunPhases` DOES filter `runs.status='active'`,
but the *stale* verification query that produces the `stale · …` badge does not, so the two disagree.)

## Live reproduction (2026-07-19)

Review-loop run `run-review-loop-fg-552-eaf24c` (FG-552, round 1, sha `e2da08d`, mode `ci_wait`) was killed
mid-CI-wait during a CI-hang recovery. It emitted `review_loop.verification_started`
(attemptId `3f045d74-8f2c-4c61-8fbf-f62a95cf2a2a`) but never a matching `verification_finished`. FG-552 then
fully shipped (`2e95b0c`) and closed; the run was marked `abandoned` and its launch record removed. The
dashboard STILL rendered `stale · waiting-on-ci / FG-552 · review-loop / …eaf24c` (confirmed in a fresh
browser + after a full dashboard server restart — it is not a browser/server cache; the 2s poll re-derives it
from the open event each tick). Manually inserting the matching `verification_finished` event cleared it
immediately, confirming the event-pairing (not run status) is the sole driver.

## Fix

The in-progress/stale verification query MUST exclude (or down-rank to a distinct "reconcile/terminal"
state) any verification whose owning `run_id` is in a **terminal** run status (`abandoned`, `failed`,
`complete`) — a dangling `verification_started` under a terminal run is NOT live work. Options:

- Join the verification-start rows to `runs.status` and drop/rebadge those under terminal runs; OR
- Treat a run's terminal transition as an implicit verification-finish for its open attempts.

Keep the FG-487 behavior (a genuinely-crashed verification under an *active* run still surfaces as
`stale: true` for reconciliation) — this change only stops TERMINAL-run verifications from masquerading as
in-flight.

## Acceptance

- A `review_loop.verification_started` with no matching finish, whose run is `abandoned`/`failed`/`complete`,
  does NOT render as in-flight / `stale · waiting-on-ci` on the dashboard.
- An unmatched start under an `active` run still surfaces (FG-487 preserved), incl. the `stale: true` flag
  past the cutoff.
- Regression test at the query level (`dashboard/src/queries*.test.ts`) covering: terminal-run unmatched
  start → excluded; active-run unmatched start → included/stale.

## Notes
- Filed by the forge-on-forge orchestrator for hand-off to the dashboard orchestrator.
- Adjacent to (but distinct from) the closed FG-115 task-list smart-refresh gap — this is a run-terminal-status
  gap in the verification-event badge, not a client refresh gap.
