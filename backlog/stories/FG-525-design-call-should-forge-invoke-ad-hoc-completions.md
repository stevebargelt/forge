---
id: FG-525
type: story
status: active
title: "design call: should forge invoke ad-hoc completions be subject to the FG-523 validation contract? (invoke.ts markTaskComplete bypasses the tests_run gate)"
created: 2026-07-11
---

## Problem

FG-523 (F19) enforces the tests_run validation contract in runNext's finalizePrimary — workflow primaries only. `forge invoke` completes ad-hoc tasks via markTaskComplete directly (src/v2/invoke.ts:758) and never passes the evaluator, so an invoked implementer returning {status:"complete"} with no tests_run advances silently.

Surfaced by the FG-523 test-engineer (run-fg-523-trust-gate-enforcement-pair-a43882).

## Why a design call, not a bug

Ad-hoc invoke has a human/orchestrator present by construction — the orchestrator reads every invoke result and applies the gate discipline conversationally (reject-and-rerun on missing validation fields). Gating it in the runner would change the invoke UX (a held invoke has no watching pipeline; who advances it?). Options: (a) gate identically to primaries; (b) warn-only (stderr + event) so the orchestrator's check has a machine backstop; (c) leave ungated, documented.

## Acceptance Criteria

- A decision recorded (this ticket or an ADR if (a)): gate / warn / documented-ungated, with rationale.
- If gated or warned: implemented through the SAME evaluator (src/v2/validation-contract.ts), negative-path tested through the real invoke path.
- The validation-contract.ts header comment accurately names the invoke path's status (FG-523 ships a corrected comment; keep it true).

## Notes

Filed 2026-07-10 during FG-523. Related: FG-524 (fanout children, the other ungated finalize site).
