---
id: FG-470
type: story
status: active
title: "test: end-to-end collector test that a campaign-created run persists ticketId/campaignId/itemId on run.metadata (FG-464 population regression guard)"
created: 2026-07-05
---

## Problem
FG-464 populates run.metadata.ticketId/campaignId/itemId at every insertRun site in src/campaign/executor.ts, and the notification reader (contextSegment in format.ts) is unit-tested with synthetic metadata. But no test exercises the REAL collector: drive a campaign item through driveRemainingItems (single-invoke or invoke-chain lane), read the created run back via getRun, and assert run.metadata carries campaignId/ticketId/itemId. Field-name correctness is verifiable by inspection today (executor sets ticketId/campaignId/itemId; contextSegment reads ticketId/campaignId; insertRun→getRun round-trips metadata, tested elsewhere), so this is a regression guard, not a known bug.

## Severity
Low / test-coverage. Fail-safe: the population + reader are correct today; this guards against a silent regression that would make campaign-context notifications inert.

## Acceptance
- A test drives a campaign item to a real insertRun (all lanes: full-feature, quick-invoke chain, single-invoke) and asserts getRun(runId).metadata.{campaignId,ticketId,itemId} are set, for a real campaign run — closing the evaluator-only coverage gap the FG-464 review flagged.

## Reference
src/campaign/executor.ts insertRun metadata sites; src/notify/format.ts contextSegment; src/campaign/executor.test.ts (harness). FG-464 review run-review-loop-fg-464-d8d10f finding 1.