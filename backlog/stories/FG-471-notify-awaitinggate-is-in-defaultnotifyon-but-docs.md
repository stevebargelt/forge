---
id: FG-471
type: story
status: active
title: "notify: awaiting_gate is in DEFAULT_NOTIFY_ON but docs say 'Excluded by default' — reconcile code vs doc (pre-existing)"
created: 2026-07-05
---

## Problem
Pre-existing discrepancy (predates FG-464, surfaced by its review): `src/notify/trigger.ts` DEFAULT_NOTIFY_ON includes `awaiting_gate`, and parseNotifyOn falls back to it, so gate notifications (notifyOnGateAwaiting) fire by DEFAULT. But `docs/how-to-set-up-notifications.md` states `awaiting_gate` is "Excluded by default (would fire during every normal gate; noisy)". Code and doc contradict.

## Decision needed
Which is intended?
- If gate pushes SHOULD be off by default (per the doc's stated rationale), remove `awaiting_gate` from DEFAULT_NOTIFY_ON (a behavior change — operators currently get gate pushes by default).
- If gate pushes SHOULD be on by default, correct the doc.
This is a behavior question, not just a doc fix — hence a ticket, not a doc-maintainer edit.

## Reference
src/notify/trigger.ts DEFAULT_NOTIFY_ON / parseNotifyOn; docs/how-to-set-up-notifications.md (~line 17). FG-464 review run-review-loop-fg-464-d8d10f finding 3.