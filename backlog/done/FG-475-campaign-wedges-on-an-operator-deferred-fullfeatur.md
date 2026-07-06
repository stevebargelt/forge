---
id: FG-475
type: story
status: done
title: "Campaign wedges on an operator-deferred full_feature item: rejected/failed run leaves item awaiting_gate, resume hangs instead of advancing to independent items"
created: 2026-07-06
closed: 2026-07-06
closed_commit: 2928b10
---

## Problem

A sequential campaign WEDGES when a full_feature item's run is driven to a terminal FAILED state via a manual `forge gate` decision (the "manually-driven run" path) — specifically when the operator REJECTS a phase gate to defer the item.

Observed 2026-07-06 in `campaign-e89beee993ec` (autonomous batch). FG-425 (full_feature) was deferred by rejecting its architect gate (`forge gate task-architect-d73b92 reject`). That correctly failed the architect task and the run (`task.failed`). But:

1. The campaign ITEM `lifecycle_status` stayed `awaiting_gate`, desynced from the run's actual terminal (failed) state.
2. On `forge campaign resume`, the item was treated as ship-pending: resume printed one refusal line — `"FG-425 is awaiting_gate on a manually-driven run but evidence is incomplete — refusing to ship and re-parking (missing: ticket_status_not_done, ticket_closed_commit_missing, closed_commit_not_reachable_on_base_branch, lane_evidence_missing)"` — and then made **no further progress**. It never read the run's terminal `failed` state, never classified the item as a scoped blocker, and never advanced to the next INDEPENDENT item (FG-414 stayed `pending`).
3. The resume process stayed alive but idle after that single line; recovery required a manual process-tree kill (`kill -9` of the daemonized resume PID + its node/tsx children — a pgroup kill alone did not reap the children) plus `forge campaign pause`.

**Evidence vs inference:** the resume log contains exactly ONE "refusing to ship" line, then ~4 min of no output and no progress before the process was killed. So the observed symptom is a **hang / no-forward-progress**, NOT a tight retry loop (a loop would have produced repeated output). Whether the process was blocked on a wait, or in a slow/silent retry, was not determined — the durable fact is: one refusal, then stuck, until killed.

Contrast with the ADVANCE path: when a manually-driven full_feature run PROGRESSES (gate advanced, run eventually completes), the same item-state desync is cosmetic — `forge campaign reconcile` picks up the ship-success evidence and ships the item (observed working for FG-424 this same session). Only the FAILED/rejected (defer) path dead-ends.

## Root cause (probable — confirm during implementation)

`resume`/reconcile in `src/campaign/executor.ts` appears to have **no branch for a terminally-FAILED full_feature run** — it only handles the ship-success evidence path (ticket closed + closed_commit reachable + host-verification). So a full_feature item whose run failed has no code path to (a) classify the item as a scoped/blocked outcome from the run's terminal-failed state, or (b) advance the sequential campaign past it. Confirm the exact function/branch (the "manually-driven run / evidence incomplete" check and the item-lifecycle reconcile) before implementing.

## Impact

- Operator cannot cleanly DEFER (skip) a single full_feature campaign item; doing so wedges the whole sequential campaign on that item, starving all subsequent independent items.
- Recovery is a manual process-kill — not discoverable, not a documented CLI path.
- The campaign's own guidance ("reset the item to pending or mark it failed before continuing") names no CLI verb that does this.

## Goal

A campaign can advance past a full_feature item whose run reached a terminal FAILED state (including an operator gate-reject), classifying the item as a scoped/blocked outcome and continuing to independent pending items — without a manual process-kill.

## Fix direction — OPEN (decide at plan time)

Two viable shapes, not yet chosen; the plan/architecture step should pick one (or both):
- **(a) `resume` auto-handles it:** on resume, an item whose run is terminally `failed` is reconciled to a scoped/blocked outcome and the campaign advances to the next independent item.
- **(b) explicit operator verb:** a `forge campaign skip <campaign> <ticket>` (or `mark-failed`) that transitions the item to blocked/failed so a subsequent resume proceeds.
These differ in operator ergonomics and in how much "defer" is an explicit action vs automatic. Not a hard product fork, but a real design decision — do not assume one silently.

## Acceptance Criteria

- On `forge campaign resume`, an item whose run is terminally `failed` is reconciled to a scoped/blocked item outcome (not treated as ship-pending); resume does NOT hang and does NOT sit stuck on it.
- The sequential campaign then advances to the next INDEPENDENT pending item (dependents of the failed item stay held, per existing policy).
- The item `lifecycle_status` is kept in sync with the underlying run's terminal state (no `awaiting_gate` item left standing over a `failed` run).
- Per the chosen fix direction: either resume auto-handles the terminal-failed run, OR a documented `forge campaign skip`/`mark-failed` operator path exists (and is covered by `--help`).
- A test covers: a full_feature item whose run is failed/rejected → resume (or the skip verb) classifies it blocked and advances to the next independent item, with NO hang and no manual process-kill required.

## Notes

- Surfaced during the FG-425 defer decision (see notes/autonomous-session-2026-07-05d.md D11/D12). FG-425 was intentionally deferred (complex data-integrity concurrency); the wedge is a runner limitation, not an FG-425 issue.
- Related: FG-473 (invoke-lane out-of-band reconcile completion — the ADVANCE-path analog that DOES work), FG-410 (updateCampaignItem lost-update). Adjacent to the manually-driven-run reconcile semantics generally.
- Also worth fixing/confirming: the daemonized resume's child node/tsx processes survived a process-group kill (only an explicit `kill -9` of the child PIDs reaped them) — orthogonal to the runner logic, but part of why recovery was painful.
- Workaround used this session: kill the resume process tree, `forge campaign pause`, then run the remaining independent items via direct execution outside the campaign, then `forge campaign abandon`.
