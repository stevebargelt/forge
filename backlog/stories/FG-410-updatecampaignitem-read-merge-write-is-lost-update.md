---
id: FG-410
type: story
status: active
title: updateCampaignItem read-merge-write is lost-update-unsafe under parallel execution (FG-396 prerequisite)
created: 2026-06-25
---

## Problem

src/store/campaigns.ts updateCampaignItem does read-then-merge-then-write: getCampaignItem(id) → { ...existing, ...update } → full-row UPDATE. Two concurrent callers each read before either writes, so the second write silently clobbers the first's fields. Surfaced by the FG-392 red-backend review (low severity, residual risk).

## Why deferred, not fixed in FG-392

NOT reachable in the FG-392 sequential MVP — the executor processes items strictly one at a time, so there is no concurrent updateCampaignItem. It becomes a real lost-update hazard only when parallel campaign lanes (FG-396) run items concurrently.

## Acceptance Criteria

- Replace read-merge-write with a targeted UPDATE that sets only the columns present in the update object (no full-row read-then-write), OR add row-level guarding.
- Must land BEFORE / as part of FG-396 parallel execution — parallel lanes must not silently lose item-state writes.
- Test: two concurrent updates to disjoint fields of the same item both persist.

## Notes
Filed from FG-392 red-backend finding #5 (disposition: residual_risk). Relates to FG-396.