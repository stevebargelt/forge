---
id: FG-598
type: story
status: active
title: "FG-564 test refinement: mixed-lane recovery parity test should drive natural loop continuation, not re-arm between dispatches"
created: 2026-07-20
---

## Origin

Surfaced by the final red-wide review of the FG-564 (Slice 5b) build. Test-fidelity refinement only — **not** a code invariant failure; FG-564's lane-parity acceptance is met independently.

## Finding

`src/campaign/fg564-lane-parity.integration.test.ts` now correctly drives EACH item through the real recovery/continuation dispatch composition (`consumeCampaignContinuation` → `prepareCampaignItemDispatch` → `reserveCampaignDriveDispatch` → per-lane real driver) for a `full_feature` and a `docs_only` item in one campaign — the earlier manual-run-arming bypass is fixed. The residual: the test **re-arms the campaign between the two recovery dispatches** rather than letting the recovery loop continue organically from item N to item N+1 across the two lanes.

## Why this is not an FG-564 blocker

Each lane's recover-driven item is proven to materialize+drive through the SAME real physical path as the normal drive for that lane (the lane-parity AC). The natural N→N+1 loop continuation is independently proven by the AC9 five-level worktree capstone (`fg564-capstone.worktree.test.ts`) and the C1–C8 crash matrix. The re-arm is a test-construction convenience between two otherwise-real dispatches, not a hole in the lane-parity evidence.

## Scope

- Strengthen the mixed-lane parity test so a single recovery run continues the item loop across BOTH lanes without a manual re-arm between dispatches, proving organic N→N+1 continuation over a mixed-lane campaign end to end.

## Acceptance criteria

- The mixed-lane recovery parity test drives item N and item N+1 (different lanes) through ONE continuous recovery loop with no manual campaign re-arm between them.
- Both items' five-level convergence is read back from durable rows.
