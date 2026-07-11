---
id: FG-524
type: story
status: active
title: "F19 gap: fanout implementer children bypass the tests_run ingestion gate (children finalize via markTaskComplete, not finalizePrimary)"
created: 2026-07-11
---

## Problem

FG-523 (F19) enforces the tests_run validation contract in runNext's finalizePrimary — the single finalize site for workflow PRIMARIES. A fanout parent's result is a synthetic aggregate ({status, children}) and is exempt (enforceValidationContract=false), but the real implementer work in a fanout lives on the CHILDREN, which finalize via markTaskComplete and never pass through the evaluator. A fanout implementer child returning status complete with no tests_run and no waiver silent-completes — exactly the gap FG-523 closed for primaries.

## Acceptance Criteria

- Fanout implementer children are subject to the same validation-contract evaluator (src/v2/validation-contract.ts) at their finalize site, with the same awaiting_gate + named reason hold and waiver semantics.
- Negative test through the real fanout dispatch path: child complete-without-tests_run → held; parent aggregation handles a held child without wedging (parent state + operator verb defined).
- Non-implementer fanout children unchanged.

## Notes

Filed 2026-07-10 from the FG-523 engineer's new-scope report (run-fg-523-trust-gate-enforcement-pair-a43882). Interacts with FG-478 (on_reject over fanout) and the fanout parent aggregation rules — the "held child vs parent state" semantics need a deliberate design decision, which is why this was not absorbed into FG-523.
