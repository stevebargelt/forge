---
id: FG-364
type: story
status: active
title: "forge pipeline: request-changes on a fan-out build phase deadlocks — follow-up engineer task never dispatches"
created: 2026-06-22
---

**Found:** 2026-06-22, during the FG-350 feature pipeline run `run-control-plane-receipts-fg-350-2f4971`.

**Symptom:** When a fan-out build phase parent is `blocked_by_red` and the orchestrator issues `forge gate <parent> request-changes --force`, a follow-up engineer task is created but the runner will NOT dispatch it. `forge next` returns "awaiting gate: build" without starting any container. Repeating request-changes accumulates ORPHANED pending engineer tasks that never start.

**Observed sequence:**
- Round 1: build parent `task-build-5737fc` fans out into 6 children + 5 reds; two authoritative reds fail → parent `blocked_by_red`.
- Round 2: `request-changes --force` on the parent created `task-build-7e7be4`. `forge next` ran a NEW set of fan-out children + reds — but attributed the new children to the OLD parent `task-build-5737fc` (not to `task-build-7e7be4`), the reds re-failed, and `task-build-7e7be4` stayed `pending`/unstarted.
- Round 3: `request-changes --force` again created `task-build-9673d0`. `forge next` returned "awaiting gate: build" and dispatched NOTHING — disk unchanged, no container ran. Now TWO engineer tasks (`task-build-7e7be4`, `task-build-9673d0`) sit `pending`/`started=false` while the original parent remains `blocked_by_red`. The run is wedged.

**Likely root cause:** the readiness/dispatch logic for a fan-out build phase does not correctly retarget to the request-changes follow-up task; the `blocked_by_red` original parent gums up `computeReadyQueue`, so the follow-up engineer never becomes dispatchable. The round-2 vs round-3 divergence (round 2 re-ran fan-out under the old parent; round 3 ran nothing) suggests non-deterministic/incorrect lineage handling for fan-out request-changes.

**Impact:** request-changes is unusable on a fan-out build phase — the orchestrator cannot iterate an engineer through red feedback on a fanned-out step. The only escape today is to abandon the run and finish via standalone `forge invoke` (which is what FG-350 had to do). High-value because request-changes-on-fan-out is a normal pipeline path.

**Repro:** any feature run whose build phase fans out (tech-lead emits multiple plan steps), where a red fails and the orchestrator issues request-changes on the parent.

**Surfaces:** `src/v2/runNext.ts` (computeReadyQueue / dispatchFanoutStep / request-changes follow-up creation), the gate request-changes path. Relates to FG-122 (dashboard request-changes auto-dispatch) and the request-changes single-step path (which DOES work — see the plan-phase request-changes in this same run, which dispatched correctly).
