---
id: FG-507
type: story
status: done
title: "recover/retry lifecycle gaps: recover recommends a retry that refuses status=running; retried ad-hoc invoke tasks are undispatchable"
created: 2026-07-09
closed: 2026-07-10
closed_commit: "6120940"
---

Two operational gaps hit live during the FG-502 run (2026-07-09) while recovering a killed fixer invoke (task-engineer-68c1cd, container SIGTERM'd exit 143, empty result.json):

1. forge recover's recommendation contradicts retry's preflight. recover on a running task with a dead container printed 'next: forge retry task-engineer-68c1cd (... retryable without --force)', but forge retry (with and without --force) refuses: 'Task is in status running, not failed'. The undocumented missing step was forge cancel first.

2. A retried ad-hoc (invoke-attached) task is a dead end. After cancel, forge retry created a lineage-linked pending task and said 'Next: forge next <run-id>' — but the workflow ready-queue does not pick up ad-hoc run-attached tasks. The pending row just strands.

STATE 2026-07-10 (overnight queue, orchestrator): substantially implemented on branch fix/fg-507-recover-retry-adhoc-dispatch, PR #92 OPEN, NOT merged — the third review-loop pass (run-review-loop-fg-507-296aee) surfaced an unresolved lifecycle blocker and the queue stopped per operator instruction. Shipped on the branch (all pushed through a469dee, CI green through a06cfd0):
- recover recommends the verbatim-working cancel-then-retry sequence (container probed only for running tasks; conservative under docker outage); recover --json gains recommendationCommands
- retry re-dispatches ad-hoc tasks directly via the extracted shared dispatchInvokeTask; fail-closed pre-write refusals (RetryDispatchKindUnknownError: workflow_unloadable | legacy_ambiguous_phase); recorded-facts dispatch plan (auth profile from auth.profile_applied, runtime/mountMode from receipt+manifest, explicit --profile provenance replayed)
- taskPackage.dispatchSource: "invoke" provenance stamped at creation, marker-first classification (taskDispatchKind three-state); FG-512 filed for runner-side stamping that deletes the legacy ambiguity rule
- loop-3 round-1 fixer (a469dee): ready-queue no longer picks up dispatchSource:"invoke" rows in the post-lock/pre-dispatch window + docs claim corrected
- docs/concepts.md Task retry section + recover contract + SCHEMA-CONTRACT retry note reconciled through all rounds

OPEN — the two loop-3 round-2 findings (the unresolved blocker):
1. src/v2/ready-queue.ts:162 — a LIVE ad-hoc retry is excluded from isRunSettled, so a concurrent forge next or gate can finalize the run while the retry's direct invoke container is still running. isRunSettled is the FG-475 shared settledness helper consumed by gate.ts, runNext.ts, and reconcile — fixing it correctly is cross-cutting (FG-477 territory) and needs an operator-reviewed design, not an overnight fixer round.
2. Test fidelity: the e2e recovery test drives performInspect/performCancel/retry internals, not the human forge recover/retry CLI surfaces or recover --json — the command recommendation is not covered through production interfaces.

Acceptance:
- [ ] recover's recommended command sequence works verbatim on a running task with a confirmed-gone container
- [ ] a retried ad-hoc invoke task is dispatchable (or retry refuses with an accurate next action instead of pointing at forge next)
- [ ] integration test covers the dead-container running task recover->(cancel->)retry->dispatch path end to end (through the production CLI surfaces, per loop-3 finding 2)
- [ ] (added by loop-3) a live ad-hoc retry is visible to run-settledness: no concurrent forge next/gate can finalize the run while the re-dispatched container runs
