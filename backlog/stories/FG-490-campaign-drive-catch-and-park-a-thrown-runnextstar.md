---
id: FG-490
type: story
status: active
title: "campaign drive catch-and-park: a thrown runNext/startRun transitions running->paused with a recoverable item instead of stranding the campaign (review F7)"
created: 2026-07-07
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md), finding F7 / backlog rec #9.

## Problem

The campaign drive path awaits `runNextFn` / `startRun` uncaught (`src/campaign/executor.ts` ~639, ~1016, ~1063) after the campaign has already transitioned to `running` (~1463). Any dispatch-time throw — e.g. `runNext` missing projectDir (`src/v2/runNext.ts` ~184-185), docker spawn errors — propagates out with the campaign left in `running`:

- `resume` refuses (`not_paused`, executor.ts ~141);
- `start` refuses too;
- the only way back is manual DB surgery.

Same dead end as F6, reached through exceptions instead of item failure.

## Goal

A thrown drive-path error transitions the campaign `running → paused` (item to a recoverable `recovery_needed`-class state) BEFORE the error propagates, so the operator sees the error AND `forge campaign resume` works afterwards. Errors are recorded, never swallowed.

## Acceptance criteria

- [ ] With an injected throwing `runNextFn` (and separately `startRun`), the campaign lands `paused`, the in-flight item is in a recoverable non-terminal state, and the thrown error still surfaces to the caller/CLI with next-action guidance.
- [ ] The failure is durably recorded (campaign/item state or event row) — not swallowed, not silently retried.
- [ ] `forge campaign resume` succeeds after the parked state (test may stub the subsequent drive).
- [ ] If the park-transition itself fails (e.g. DB error), the original error still propagates — the wrapper must never mask the root cause.