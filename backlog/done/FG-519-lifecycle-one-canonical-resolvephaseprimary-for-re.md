---
id: FG-519
type: story
status: done
title: "lifecycle: one canonical resolvePhasePrimary for ready-queue, deriveUpstream, and fanout upstream — deriveUpstream currently hands downstream a failed orphan's undefined result"
created: 2026-07-10
closed: 2026-07-10
closed_commit: 241cacf
---

Review findings F14/F15 (queued 2026-07-10, item 4 of 4 in the sequential reliability queue); first consumer of FG-512's total dispatch provenance.

Three rules disagree about which task row is the phase-authoritative primary (all verified in code 2026-07-10):

1. ready-queue (src/v2/ready-queue.ts ~:85, hasCompletePrimary): ANY complete primary in the phase closes it (modulo the FG-475 live-recovery re-admission).
2. deriveUpstream (src/v2/inputs.ts:37-40): latest primary by createdAt REGARDLESS OF STATUS — filter(phase, no parent).sort(createdAt).pop().
3. fanout upstream (src/v2/runNext.ts ~:1401): latest COMPLETE primary.

Failure shape: after a duplicate-primary heal leaving [complete older, failed newer] in one phase, ready-queue advances (rule 1 sees the complete row), but deriveUpstream (rule 2) picks the failed newer row, whose result.json doesn't exist — the downstream step dispatches with result: undefined. The three rules can each pick a DIFFERENT row for the same phase.

Fix: ONE canonical helper decides the phase-authoritative primary — latest COMPLETE primary — and all three sites consume it.

Acceptance:
- [ ] a single helper (e.g. resolvePhasePrimary(tasks, phase)) returns the latest COMPLETE parent-less task row for a phase; all three sites (ready-queue, deriveUpstream, fanout upstream) consume it
- [ ] behavior-parity tests per site: for inputs each site previously handled correctly, the helper-backed code picks the same row
- [ ] mixed-shape regressions — not just happy shapes: [complete older + failed newer] (the healed-duplicate shape: downstream must receive the COMPLETE row's result, never undefined), [complete + pending], single-complete, single-failed, empty phase
- [ ] FG-477's body updated to record this as a shipped slice (the ticket stays open; this narrows it)

Scope guard: do NOT absorb broader FG-477 evaluator work; isRunSettled is already correct post-FG-507 — leave it untouched.
