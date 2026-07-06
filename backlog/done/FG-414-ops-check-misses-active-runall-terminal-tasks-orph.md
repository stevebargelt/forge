---
id: FG-414
type: story
status: done
title: ops check misses active-run/all-terminal-tasks orphans; projects-show in-flight count disagrees with dashboard
created: 2026-06-26
closed: 2026-07-06
closed_commit: ef30eb7bf83ad55d8eaa7bb5c4aff347edb6dabe
---

Two related operational-visibility gaps, surfaced 2026-06-26 while reconciling a stale run.

## What happened

`forge projects show forge` reported `In-flight: 2`, but the dashboard and `forge status` task view showed no live work. Investigation found the 2 "in-flight" rows were:

1. `run-orchestrator-9c6513` — the long-lived orchestrator session row (legitimately `active`, but not work).
2. `run-fg-381-reviewer-context-packet-893cbc` — a **feature** pipeline run stuck in `status='active'` since 2026-06-24 01:59. Its build phase had a `failed` engineer task; the run was abandoned (FG-381 was later completed via separate invoke runs) but **the run row never transitioned to a terminal state**. Every one of its tasks is terminal (complete/failed); only the run row is stale. No container was running.

It was reconciled manually with `forge cancel run-fg-381-...-893cbc` (tasksKilled: []).

## The two gaps

### Gap 1 — `forge ops check` doesn't detect this orphan class
`forge ops check --json` returned `[]` for this project despite the stale run. The orphan-detection logic keys off non-terminal *tasks* (retry_orphan = pending task under a terminal run). It has no rule for the inverse: a run still `active` while **all** its tasks are terminal — a run that can never make progress and will sit `active` forever. This is exactly a "needs attention" incident and should be detected (and likely `forge ops repair`-able, transitioning the run to `failed`).

### Gap 2 — `projects show` in-flight count disagrees with the dashboard
`forge projects show` derives `inFlightCount` from `src/store/runs.ts:101` (`SUM(CASE WHEN status IN ('active') ...)`), counting every `active` run row — including orchestrator session rows and un-reconciled orphans. The dashboard's live view keys off non-terminal task activity and excludes orchestrator rows, so the two surfaces report different numbers for the same state. Pick one definition of "in-flight" and make both surfaces use it (likely: runs with at least one non-terminal task, excluding orchestrator session rows — or surface orchestrator sessions separately from pipeline/invoke work).

## Acceptance criteria

- [ ] `forge ops check` detects a run that is `status='active'` while all its tasks are terminal, as a distinct incident kind (e.g. `stuck_run` / `unreconciled_run`), scoped to the project like other ops incidents.
- [ ] A repair path exists (extend `forge ops repair`, or document that `forge cancel <run-id>` is the remediation) that transitions such a run to a terminal state; refuses runs that are NOT genuine orphans (e.g. have a live container or a non-terminal task).
- [ ] `forge projects show` in-flight count and the dashboard's in-flight/live view agree on the same definition of "in-flight" — orchestrator session rows are not silently conflated with pipeline/invoke work.
- [ ] Tests cover: (a) ops check flags an active-run/all-terminal-tasks orphan; (b) ops check does NOT flag a healthy in-progress run; (c) the in-flight count matches the chosen definition (orchestrator rows handled per the decision above).

## Notes

- Severity: low/cosmetic operationally, but it's the kind of drift that erodes trust in the operator surfaces (orient flagged a phantom "2 in-flight" that didn't exist as work).
- Related: `forge cancel` (the manual remediation used here), `forge ops repair` (retry_orphan precedent), FG-377 (persistence-check false-positive — adjacent "stale state on macOS" territory).
