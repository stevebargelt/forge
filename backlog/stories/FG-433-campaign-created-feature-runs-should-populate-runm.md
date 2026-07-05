---
id: FG-433
type: story
status: active
title: campaign-created feature runs should populate run.metadata.ticketId (and campaignId/itemId) so shipping-reviewer can run ticket-aware acceptance preflight
created: 2026-07-02
---

## Status update (FG-464)
The `run.metadata` **population** half of this ticket is DONE as of FG-464: campaign-created runs now record `ticketId`, `campaignId`, and `itemId` on `run.metadata` at every `insertRun` site in `src/campaign/executor.ts` (all lanes — full-feature, quick-invoke chain, single-invoke, and the abandoned-on-error branches). This was needed to make FG-464's campaign-context notification non-inert, so it landed there.

## Remaining scope
- Verify/wire the **consumer**: shipping-reviewer's ticket-aware acceptance preflight actually reads `run.metadata.ticketId` (+ campaignId/itemId) and uses it. The population is now available; confirm the preflight path consumes it (and add a test that a campaign-created run's metadata drives ticket-aware preflight).
- If the pipeline `feature` workflow (non-campaign `forge new feature`) should also carry `ticketId` on `run.metadata`, that path is NOT covered by FG-464 (it populated the campaign lanes only) — decide and implement if in scope.

## Reference
executor.ts insertRun metadata sites (campaignId/ticketId/itemId); FG-464 (notification action-model, which added + consumes the campaign context on the read side).