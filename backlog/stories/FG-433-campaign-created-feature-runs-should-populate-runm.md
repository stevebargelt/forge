---
id: FG-433
type: story
status: active
title: campaign-created feature runs should populate run.metadata.ticketId (and campaignId/itemId) so shipping-reviewer can run ticket-aware acceptance preflight
created: 2026-07-02
---

## Status update (FG-464)
The `run.metadata` **population** for campaign runs is being delivered via FG-464:
- `ticketId` + `campaignId` land on `run.metadata` in ALL lanes: the invoke-chain / single-invoke / abandoned-error lanes set them directly on `insertRun`; the full_feature happy path goes through `startRun`, whose `metadata = { ...inputs }` (startRun.ts:95) and whose inputs carry `ticketId`/`campaignId` (executor.ts).
- `itemId` was initially populated ONLY in the invoke-chain/single-invoke/abandoned lanes (missing from the full_feature `startRun` inputs). Corrected in PR #33 (branch fix/fg-464-gate-context-and-itemid), which adds `itemId` to the full_feature inputs so all lanes are uniform.

Note: the notification context renderer (format.ts contextSegment) reads only `ticketId` + `campaignId`, not `itemId` — so `itemId` is populated for future consumers (shipping-reviewer), not yet rendered anywhere.

## Remaining scope
- Verify/wire the **consumer**: shipping-reviewer's ticket-aware acceptance preflight actually reads `run.metadata.ticketId` (+ campaignId/itemId) and uses it, with a test that a campaign-created run's metadata drives ticket-aware preflight.
- Decide whether the non-campaign pipeline `feature` run (`forge new feature`) should also carry `ticketId` on `run.metadata` (not covered by FG-464).

## Reference
executor.ts insertRun/startRun metadata sites; src/v2/startRun.ts:95; src/notify/format.ts contextSegment. FG-464 (notification read side + campaign population).