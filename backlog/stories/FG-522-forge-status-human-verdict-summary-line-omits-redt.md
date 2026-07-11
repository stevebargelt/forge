---
id: FG-522
type: story
status: active
title: forge status human verdict summary line omits redTaskId — same class as FG-521(b), --json already carries it
created: 2026-07-11
---

## Problem

src/cli/commands/status.ts:166 renders the human one-line verdict summary as `redRole: verdict (confidence)` with no redTaskId — the same omission FG-521(b) fixed in `forge show`'s Verdicts section. The status --json path (status.ts:121-125) already includes redTaskId, so only the human line is affected.

## Acceptance Criteria

- The `forge status` human verdict summary line carries the redTaskId (match FG-521(b)'s rendering convention in show.ts).
- Assertion on the human-rendered output, not just JSON.

## Notes

Filed 2026-07-10 from the FG-521 engineer's adjacent-scope report (run-fg-521-operator-read-surface-batch-561355). Deliberately not absorbed into FG-521 (scope guard).
