---
id: FG-523
type: story
status: done
title: enforce the tests_run contract at ingestion; persist gate_on_verdict so dispatch and gate share one blocking rule
created: 2026-07-11
closed: 2026-07-11
closed_commit: 283d7c0
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


## Close evidence (2026-07-10, PR #101, merge 283d7c0)

AC walk:
- **F19 negative**: complete-without-tests_run (and zero/string/negative tests_run, empty/whitespace waiver) → held awaiting_gate with named reason, proven to GATE the run over a second dispatch wave + empty ready queue (fg523-validation-contract / fg523-enforcement-negative-space integration tests); reason rendered in forge show human output (`gate hold:`) + diagnostic.gateHold (assert both, human first).
- **F19 parity**: tests_run>0 advances unchanged; non-empty no_validation_reason waiver advances + records a validation_waiver decision event (same suites).
- **F19 non-implementer parity**: test-engineer and a red complete without tests_run, unheld.
- **F16**: gate_on_verdict persisted at verdict insert; shared verdictBlocksGate predicate is the single rule for dispatch AND aggregateVerdicts; both-directions parity on a mixed three-verdict set differing in one bit (fg523-gate-recheck-parity); a false-flag authoritative fail no longer blocks the gate re-check.
- **F16 legacy/migration**: real pre-change DB built on disk, opened through production getDb — column lands, zero data loss, legacy rows read NULL and BLOCK (fail closed), idempotent (fg523-verdicts-migration). Live host DB verified post-merge: PRAGMA shows the column.
- **Real ingestion path**: all enforcement tests drive runNext/dispatchReds; review round 1 caught enforcement ordering (ran after red dispatch → could land blocked_by_red instead of the validation hold) — fixed (9a2e8c4) with a real-path regression for the missing-tests_run + authoritative-fail interleave.

Gates: review-loop closeable (run-review-loop-fg-523-eaca2b; tip a280f8e = remote head); CI green at tip (test + test-extended), evidence reused. Stress rule n/a (not a concurrency fix; the hold write is CAS'd and tested). Docs impact: **updated** — docs/concepts.md (new Validation contract section + verdict rule), SCHEMA-CONTRACT.md (column + events + implementer contract), how-to-new-agent/how-to-new-workflow/how-to-new-feature (incl. fixing pre-existing gateOnVerdict/redConfig field-name drift the review flagged), all 5 implementer seeds (no_validation_reason waiver documented).

Schema flag honored: additive/nullable/no-default column; ~/.forge/forge.db backed up pre-work (backup-pre-fg523-20260710-213303); PR body carries the callout.

Follow-ups filed (new scope, not this ticket's AC): FG-524 (fanout children bypass), FG-525 (invoke gating design call), FG-526 (model:/activity: docs drift).
