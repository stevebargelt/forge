---
id: FG-364
type: story
status: done
title: "forge pipeline: request-changes on a fan-out build phase deadlocks — follow-up engineer task never dispatches"
created: 2026-06-22
closed: 2026-06-22
---

**Found:** 2026-06-22, during the FG-350 feature pipeline run `run-control-plane-receipts-fg-350-2f4971`.

**Symptom:** When a fan-out build phase parent is `blocked_by_red` and the orchestrator issues `forge gate <parent> request-changes --force`, a follow-up engineer task is created but the runner will NOT dispatch it. `forge next` returns "awaiting gate: build" without starting any container. Repeating request-changes accumulates ORPHANED pending engineer tasks that never start.

**Observed sequence:**
- Round 1: build parent `task-build-5737fc` fans out into 6 children + 5 reds; two authoritative reds fail → parent `blocked_by_red`.
- Round 2: `request-changes --force` on the parent created `task-build-7e7be4`. `forge next` ran a NEW set of fan-out children + reds — but attributed the new children to the OLD parent `task-build-5737fc` (not to `task-build-7e7be4`), the reds re-failed, and `task-build-7e7be4` stayed `pending`/unstarted.
- Round 3: `request-changes --force` again created `task-build-9673d0`. `forge next` returned "awaiting gate: build" and dispatched NOTHING — disk unchanged, no container ran. Now TWO engineer tasks (`task-build-7e7be4`, `task-build-9673d0`) sit `pending`/`started=false` while the original parent remains `blocked_by_red`. The run is wedged.

**Root cause (named precisely):** the bug is a LINEAGE rule, not only `computeReadyQueue`. `dispatchFanoutStep` selects "a primary row for this phase" and can reuse the OLD blocked/failed fan-out parent instead of the NEW request-changes pending parent. So children/reds reattach to the dead parent (round 2), or nothing dispatches because the old blocked parent gums up readiness (round 3). The fix must make the replacement pending primary the authoritative fan-out parent and exclude the old blocked/failed parent from selection.

**Impact:** request-changes is unusable on a fan-out build phase — the orchestrator cannot iterate an engineer through red feedback on a fanned-out step. The only escape today is to abandon the run and finish via standalone `forge invoke` (which is what FG-350 had to do). High-value because request-changes-on-fan-out is a normal pipeline path.

**Repro:** any feature run whose build phase fans out (tech-lead emits multiple plan steps), where a red fails and the orchestrator issues request-changes on the parent.

## Expected Behavior

For a fan-out phase with an old primary parent blocked/failed by reds, `forge gate <old-parent> request-changes --force` creates a new pending primary for the same phase. The next `forge next` must treat that new pending primary as the active fan-out parent.

- Fan-out children created for the retry must have `parentId = <new pending primary>`.
- No new children or reds may attach to the old blocked/failed parent.
- The new pending parent must transition through running → awaiting_red / blocked_by_red / awaiting_gate / complete normally.
- The old parent remains an audit record and does not block dispatch of the replacement.
- Repeating `forge next` must not create duplicate child waves for the same pending parent.

## Acceptance Criteria

- Add an integration regression test with a workflow shaped like: plan → build fanout → reds.
- First build fan-out completes children, reds fail, parent becomes `blocked_by_red`.
- `gate(parent, "request-changes", ..., { force: true })` creates one new pending primary for `build`.
- Next `runNext` dispatches children under the new parent id, not the old parent id.
- The old parent receives no new child/red tasks after request-changes.
- If retry reds pass, the replacement parent can complete/await gate and the workflow can advance.
- Test that the request-changes rationale is visible to the replacement fan-out work, either on the parent manifest/package or propagated into child inputs.

**Surfaces:** `src/v2/runNext.ts` (`dispatchFanoutStep` primary-row selection / lineage, `computeReadyQueue`, request-changes follow-up creation), the gate request-changes path. Relates to FG-122 (dashboard request-changes auto-dispatch) and the request-changes single-step path (which DOES work — see the plan-phase request-changes in this same run, which dispatched correctly).
