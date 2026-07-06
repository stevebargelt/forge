---
id: FG-475
type: story
status: active
title: "Campaign wedges on an operator-deferred full_feature item: rejected/failed run leaves item awaiting_gate, resume re-park-loops instead of advancing to independent items"
created: 2026-07-06
---

## Problem

A sequential campaign WEDGES when a full_feature item's run is driven to a terminal state via manual `forge gate` decisions (the "manually-driven run" path) — specifically when the operator REJECTS a phase gate to defer the item.

Observed 2026-07-06 in `campaign-e89beee993ec` (autonomous batch). FG-425 (full_feature) was deferred by rejecting its architect gate (`forge gate task-architect-d73b92 reject`). That correctly failed the architect task and the run (`task.failed`). But:

1. The campaign ITEM `lifecycle_status` stayed `awaiting_gate`, desynced from the run's actual terminal (failed) state.
2. On `forge campaign resume`, the item was treated as ship-pending: resume tried to reconcile ship evidence, found none ("refusing to ship and re-parking (missing: ticket_status_not_done, ...lane_evidence_missing)"), and **re-parked in a loop** — it never read the run's terminal `failed` state, never classified the item as a scoped blocker, and never advanced to the next INDEPENDENT item (FG-414 stayed `pending`).
3. The resume process stayed alive spinning; recovery required a manual process-tree kill (`kill -9` of the daemonized resume + its node/tsx children) plus `forge campaign pause`.

This is the same item-state/run-state desync seen (more benignly) when advancing full_feature gates: the campaign item stays `awaiting_gate` while `forge gate` drives the underlying run. When the run PROGRESSES (advance path) the desync is cosmetic and reconcile eventually ships the item. When the run FAILS/is-rejected (defer path), the desync is terminal — the campaign cannot advance past the item.

## Impact

- Operator cannot cleanly DEFER (skip) a single full_feature campaign item; doing so wedges the whole sequential campaign on that item, starving all subsequent independent items.
- Recovery is a manual process-kill — not discoverable, not a documented CLI path.
- The campaign's own guidance ("reset the item to pending or mark it failed before continuing") names no CLI verb that does this.

## Goal

A campaign can advance past a full_feature item whose run reached a terminal FAILED state (including an operator gate-reject), classifying the item as a scoped/blocked outcome and continuing to independent pending items — without a manual process-kill.

## Acceptance Criteria

- On `campaign resume`, an item whose run is terminally `failed` is reconciled to a scoped/blocked item outcome (not treated as ship-pending); resume does NOT re-park-loop on it.
- The sequential campaign then advances to the next INDEPENDENT pending item (dependents of the failed item stay held, per existing policy).
- A documented operator path exists to DEFER/skip a full_feature item (mark it blocked/failed) so the campaign proceeds — e.g. a `forge campaign skip <id> <ticket>` verb or resume auto-handling the terminal-failed run.
- The item `lifecycle_status` is kept in sync with the underlying run's terminal state (no `awaiting_gate` item over a `failed` run).
- A test covers: a full_feature item whose run is failed/rejected → resume classifies it blocked and advances to the next independent item (no infinite re-park).

## Notes

- Surfaced during the FG-425 defer decision (see notes/autonomous-session-2026-07-05d.md D11/D12). FG-425 was intentionally deferred (complex data-integrity concurrency); the wedge is a runner limitation, not an FG-425 issue.
- Related: FG-473 (invoke-lane out-of-band reconcile completion — the ADVANCE-path analog), FG-410 (updateCampaignItem lost-update). Adjacent to the manually-driven-run reconcile semantics generally.
- Workaround used this session: kill the resume process tree, `forge campaign pause`, then run the remaining independent items via direct execution outside the campaign.
