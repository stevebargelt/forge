---
id: FG-476
type: story
status: active
title: on_reject recovery task targeting an already-complete phase is never dispatched (computeReadyQueue skips phases with a complete primary) — run hangs active forever after a reject; security-audit.yml audit->investigate is live-exposed
created: 2026-07-06
---

## Problem

An `on_reject` recovery task whose target step already has a COMPLETE primary is never dispatched. `computeReadyQueue` (src/v2/ready-queue.ts:45) skips any phase where `hasCompletePrimary(existing)` is true, and `hasCompletePrimary` (ready-queue.ts:72) counts only `parentId === undefined` primaries. The `on_reject` recovery task is inserted with `parentId = rejectedTaskId` and `phase = targetStep.id` (gate.ts). When `on_reject` points at an earlier, already-complete step, that phase has a complete primary → the phase is skipped → the pending recovery task is never added to the ready queue → never dispatched. `dispatchSingleStep`'s pending-row reuse lookup (runNext.ts:312-315) also only matches `parentId === undefined`, so it can't pick it up either.

## Why it surfaced now (relation to FG-475)

Pre-existing — the dispatch code (`computeReadyQueue`/`dispatchSingleStep`) is byte-for-byte unchanged by FG-475. Before FG-475 the reject branch never finalized the run, so it also sat `active` after such a reject; FG-475 makes the run CORRECTLY stay `active` (isRunSettled sees the live pending recovery task) instead of wrongly finalizing. So FG-475 did not cause this and correctly avoids a wrong-ship — but the run still has no automatic path forward.

## Live exposure (why this is not hypothetical)

`seeds/workflows/security-audit.yml` ships `audit` with `on_reject: investigate`, where `investigate` has already completed by the time `audit` runs. Any human reject of the `audit` gate on a real run/campaign will now leave the run hung at `run.status = active` forever, with an undispatchable pending recovery task in the `investigate` phase. Recovery today would require manual intervention.

## Fix direction (open — decide at plan time)

Make a live (pending) `on_reject` recovery task dispatchable even when its target phase already has an old complete primary. Candidate approaches: (a) in `computeReadyQueue`, do not `continue` on `hasCompletePrimary` when the phase also has a fresh pending recovery task (a redispatch that must run); (b) change how pending rows are matched for reuse/dispatch (runNext.ts:312-315) to recognize the lineage-tagged recovery row; (c) reconsider whether `on_reject` recovery tasks should carry `parentId` at all vs. an explicit `kind`/marker. This is materially riskier than FG-475's finalization change (it touches the core dispatch/ready-queue path) — needs its own architecture pass. Coordinate with the FG-475 discriminator fix, which keys recovery-task lineage off the `rejectedTaskId` input marker.

## Acceptance Criteria

- A gate reject with `on_reject` targeting an already-complete step results in the recovery task being DISPATCHED (the target step re-runs), not left pending forever.
- The run reaches a real terminal state (complete/abandoned) or continues per the recovered step's outcome — no indefinite `active` hang.
- A test covers the `security-audit.yml` `audit -> investigate` shape end-to-end: reject `audit`, assert the `investigate` recovery task actually dispatches and the run progresses.
- Preserves FG-475's guarantee: no premature/wrong finalization to `complete` while the recovery is outstanding.

## Source

Surfaced by the red-backend re-check on the FG-475 fix (run run-fg-475-campaign-resume-terminal-failed-reconcile-c0c3d8, task-red-backend-066ee9, residual_adjudication part 3). Separate scope from FG-475 (no-on_reject terminal-fail campaign wedge).
