---
id: FG-523
type: story
status: active
title: enforce the tests_run contract at ingestion; persist gate_on_verdict so dispatch and gate share one blocking rule
created: 2026-07-11
---

## Problem

Two trust-gate enforcement gaps (review findings F19 + F16). Both are cases where a rule exists in ONE place but the enforcing sibling site never got it — the drift shape FG-516's lesson names.

**(F19) The tests_run contract is informational, not enforced.** Implementer seeds require `tests_run` on a `status: complete` result, and the orchestrator's gate discipline treats a missing value as a hard reject — but the RUNNER silently advances such a result. The field flows to done-audit (src/done-audit/collect.ts:99-118) as informational only. A primary implementer result with `status: complete` and missing/zero `tests_run` (and no explicit no-validation-path reasoning) currently silent-completes. This is the one 07-06 review test gap that never closed.

**(F16) gate_on_verdict lives only in workflow config; the gate re-check can't see it.** `gate_on_verdict` is a red-config flag (src/v2/schema.ts:67, default true). Dispatch blocks on authoritative + gate_on_verdict + fail (src/v2/runNext.ts:936), but `aggregateVerdicts` (src/v2/gate.ts:47-61) re-derives blocking from verdict rows, which never recorded the flag — so a `gate_on_verdict: false` authoritative fail doesn't block at dispatch but DOES block the later gate re-check. Two sites, two rules.

## Fix

**(F19)** Enforce at ingestion: a primary implementer result with `status: complete` and missing/zero `tests_run`, with no explicit no-validation-path waiver, lands `awaiting_gate` with a NAMED reason (surfaced by `forge show`) — never silent-complete. Fail-safe direction: over-holding is recoverable via the existing gate verbs; silent advance is not.

**(F16)** Persist `gate_on_verdict` on verdict rows (additive nullable column) so `aggregateVerdicts` honors the same rule dispatch applies. NULL (legacy rows) preserves current blocking behavior (treated as true — fail closed).

## SCHEMA FLAG

F16 adds a column to a shared-DB table (`verdicts`): the migration fires machine-wide on the next writable forge command in any running process. Keep it additive/nullable. ~/.forge/forge.db backed up before this work (backup-pre-fg523-20260710-213303). The PR body must call this out.

## Acceptance Criteria

- (F19) Negative test: a primary implementer result with `status: complete` and no `tests_run` (or `tests_run: 0`) and no waiver → task lands `awaiting_gate`, NOT complete; the named hold reason is visible in `forge show <taskId>` human output; no downstream step dispatches past it until the gate is decided.
- (F19) A complete result WITH `tests_run > 0` advances exactly as today (behavior parity), and a result carrying an explicit no-validation-path waiver advances with the waiver recorded.
- (F19) Enforcement applies to primary implementer results only — red / test-engineer / docs / research / qa task ingestion is unchanged (test at least one non-implementer role advancing without tests_run).
- (F16) Verdict rows persist gate_on_verdict; aggregateVerdicts blocks an authoritative fail ONLY when the persisted flag is true or NULL (legacy fail-closed); a gate_on_verdict:false authoritative fail no longer blocks the gate re-check — dispatch and gate agree (one shared rule, tested through both paths).
- (F16) Migration is additive + nullable; existing rows read back with NULL and block as before (legacy regression test).
- Enforcement tested through the REAL ingestion path (dispatchReds/finalize — FG-418 precedent: use in-hand args, not DB re-reads), not just unit-level helpers.

## Notes

Filed 2026-07-10 as Item 3 of the operator-directed reliability queue (review findings F19 + F16). FG-516 lesson applies: enforce by construction (one owning site / shared rule), not per-site patches.
