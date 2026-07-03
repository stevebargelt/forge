---
id: FG-443
type: story
status: done
title: Campaign cannot cleanly COMPLETE an item legitimately delivered outside its feature pipeline (re-routed lane / out-of-band); item stalls at awaiting_gate and only abandon remains
created: 2026-07-02
closed: 2026-07-03
closed_commit: 4bdd875
---

## Problem

A campaign item whose real work is delivered OUTSIDE the feature pipeline — e.g. re-routed to a documentation/orchestrator-policy authoring lane rather than engineer+test-engineer — has no way to reach a completed state in the campaign. Its feature run parks at a human gate (e.g. architect/plan) and never runs build/verify, so the campaign item stays `awaiting_gate` indefinitely even after the underlying ticket is fully shipped and closed.

Observed with FG-422 in campaign-922c83b7c577: FG-422 (authoring four `.claude/skills/*.md` workflow skills) was correctly re-routed to the documentation-maintainer lane (skills are durable docs, not code). Its feature run was paused after the architect gate on purpose; the actual deliverable shipped via PR #6 (merge 53784a4) and FG-422 was closed. But the campaign item still shows `awaiting_gate` at the architect step, and the campaign cannot complete:
- `forge campaign reconcile` does not apply — it only ships items in a `failed`/`blocked_by_red` scope-blocked shape, not `awaiting_gate`.
- Driving the item through the remaining feature phases (plan → engineer → test-engineer) is exactly the wrong lane for a docs deliverable.
- Hand-patching the item's lifecycle_status is not allowed.
So the only terminal option is `abandon`, which mislabels a fully-successful campaign (all items shipped) as "abandoned".

## Goal

A campaign can COMPLETE (not just abandon) when every item is legitimately delivered, including items handled in a non-pipeline lane. There should be an evidence-gated, non-hand-patch way to mark a campaign item done from external delivery (ticket closed + shipped), and/or a first-class "docs/authoring lane" a campaign item can take instead of the full feature pipeline.

## Acceptance Criteria

- A campaign item whose ticket is closed/shipped but whose run was intentionally handled outside the feature pipeline can be marked complete via an evidence-gated path (ticket done + closedCommit reachable on base + the appropriate durable evidence for its lane), NOT by hand-editing state — analogous to `forge campaign reconcile` but covering the `awaiting_gate` / non-pipeline shape.
- With all items delivered, the campaign reaches a `complete` terminal state, not merely `paused` forever or `abandoned`.
- Optionally: a campaign item can be planned/routed into a docs/authoring lane (documentation-maintainer) so re-routing is a first-class plan choice rather than a manual pause + out-of-band handling.
- Operator surface (`forge campaign show`/`report`) distinguishes "delivered out-of-band, completable" from a genuine unfinished gate.

## Refs

- src/campaign/executor.ts (driveRemainingItems, item lifecycle), src/campaign/reconcile*.ts (evidence-gated recovery — currently scope-blocked shape only)
- Surfaced completing FG-422 in campaign-922c83b7c577; adjacent to FG-440 (post-merge host-verification capture) and the FG-427/FG-428 reconciliation lineage.
