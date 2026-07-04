---
id: FG-441
type: story
status: done
title: Campaign resume should reconcile manually-driven campaign item runs after merge/close
created: 2026-07-02
closed: 2026-07-04
closed_commit: 54d4495
---

## Problem

A campaign item can be driven manually outside the campaign resume loop after the campaign has already created/attached its run. FG-376 surfaced this shape: the campaign item is stored as `awaiting_gate` at the plan step, but the underlying feature run was later driven manually through gates, fixers, red re-checks, host verification, PR merge, and backlog close.

After the item is merged, closed, and host-verified, `forge campaign resume <campaign-id>` should be able to reattach to the existing run and reconcile the campaign item from durable evidence. If it cannot, the campaign remains wedged even though the item shipped in durable reality.

This is adjacent to FG-428, but the starting shape is different: `awaiting_gate` / manually-driven run rather than terminal `failed` or `blocked_by_red` stale-red failure.

## Goal

Make campaign resume robust when an item's attached run was advanced manually outside the campaign driver. Resume should re-read the run and durable ticket/git/host-verification/verdict/gate evidence, then update the campaign item when the evidence proves it shipped.

## Acceptance Criteria

- Given a campaign item with `lifecycleStatus=awaiting_gate` and an attached run that has since completed outside the campaign driver, `forge campaign resume <campaign-id>` reattaches to the run and re-derives the item outcome instead of staying wedged on the stale campaign-item state.
- If the ticket is done, closedCommit is on the base branch, host verification for that commit passed, and the run has an effective passing/superseded authoritative-review state, the item is marked `complete` / `shipped` and downstream held items are reconsidered.
- If durable evidence is missing, resume refuses safely and reports the missing facts; it does not optimistically mark shipped.
- The implementation does not require manual DB edits or ad hoc state patching.
- Tests cover a manually-driven attached run whose campaign item is still `awaiting_gate`, including a positive shipped case and at least one missing-evidence refusal case.
- Existing FG-428 recovery behavior for `failed` / `blocked_by_red` stale-red items remains unchanged.

## Non-Goals

- Does not create a broad manual mark-shipped escape hatch.
- Does not weaken done-audit or host-verification requirements.
- Does not require the campaign driver to be the only way a run can progress.

## Relations

- Surfaced during FG-376, where the campaign item was manually driven outside the campaign resume loop before merge/close.
- Related to FG-428 evidence-gated reconcile recovery.
- Related to FG-427 automatic reconciliation of superseded red failures.