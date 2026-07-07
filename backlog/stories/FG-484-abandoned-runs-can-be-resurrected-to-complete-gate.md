---
id: FG-484
type: story
status: active
title: "abandoned runs can be resurrected to complete: gate-path finalization lacks the abandoned guard and updateRunStatus is an unconditional write (review F5)"
created: 2026-07-07
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md, finding F5 — HIGH). Review of main @ fbb070c.

## Problem

gate.ts:317-322 (finalizeRunIfDone) calls updateRunStatus(runId, "complete") with no status re-read; gate() never checks run.status (only !run, gate.ts:96-97). updateRunStatus (runs.ts:123-144) is an unconditional UPDATE — no terminal-state CAS — and fires the completion notification. The runner's equivalent paths DO guard (runNext.ts:155-164, :229-247, the FG-475 AWN-2 re-read). cancel steals the run lock (cancel.ts:196), so cancel-vs-gate interleaving is a supported scenario, and the campaign auto-drives gates, widening the window.

An abandoned run flipping to complete re-enters reconcileTerminalOutcome as a real completion — wrong-ship adjacent — and emits a false "complete" push. The abandoned-not-overwritten invariant is tested only via the cancel command surface, not at the store; finalizeRunIfDone is a live caller that bypasses it.

## Fix direction (from the review)

Extract ONE shared finalizeRunIfSettled with the abandoned re-read used by all three finalize sites (two in runNext.ts, one in gate.ts); additionally make updateRunStatus (or a completeRun wrapper) a store-layer CAS that refuses abandoned -> complete so no future caller can bypass it.

## Goal

An `abandoned` run can never become `complete`: the store refuses the transition (CAS/guarded write, no completion notification), and every run-finalize site shares one settled-finalization helper carrying the abandoned re-read.

## Acceptance criteria

- [ ] Store-layer protection: the abandoned -> complete transition is refused at the store (CAS/guarded UPDATE); unit test proves it (write refused, status stays abandoned, no completion notification fired).
- [ ] All run-finalize sites share one settled-finalization helper carrying the abandoned re-read — both runNext.ts checks, gate.ts finalizeRunIfDone, AND reconcile.ts's invoke-run active->complete write (same stale-run TOCTOU shape; architect openQuestion 1 answered: fold in, it is a mechanical helper swap). No site-local copies left. invoke.ts's closeRunIfIdle either migrates onto the same helper OR ships with an explicit test proving the store CAS refuses its abandoned->complete write on a stale read (red round-2 finding; the store guard is the universal backstop either way).
- [ ] Race test: gate-path finalize interleaved with cancel abandoning the run — the run stays abandoned, no run.completed event, no completion notification. Must include the CAMPAIGN shape: executor.ts driveWorkflowItem auto-advancing a gate (gate() with no operator present) while cancel abandons — the unattended caller that widens this window (red-architect finding).
- [ ] Store guard scope is NARROW (abandoned -> complete refused), not a blanket once-terminal-refuse-all rule — invoke.ts's intentional abandoned/complete -> active reactivation (#201) keeps working, with a test pinning it (architect openQuestion 2 answered).
- [ ] Legitimate active -> complete finalization unchanged (existing tests stay green).
