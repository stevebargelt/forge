---
id: FG-602
type: story
status: active
title: startRun/invoke accept a route-bearing run when the host routing-policy is absent (warning receipt, not fail-closed)
created: 2026-07-22
---

Source: FG-581 architect red task-red-architect-f1d8ff (medium, confirmed), held as broader-than-ticket during FG-581.

`src/v2/startRun.ts:128-145` records a route-explanation failure as `metadata.routeReceipt.warnings` and constructs the run anyway, rather than rejecting or explicitly marking it unrouted. So when the host `routing-policy.yml` is absent (including after FG-581 quarantines a stale one), a route-bearing `startRun`/`invoke` call still creates a run as accepted-but-unresolved — not the fail-closed 'lane manual / policy_not_found' state the routing consumers (lane-classifier, route validate) enforce.

This is pre-existing and independent of FG-581: quarantining the stale policy does NOT regress it (a warning receipt with no stale authority is strictly better than silent stale routing), which is why it was not a blocker. But the governance surface is inconsistent — validation/planning consumers fail closed while the execution entry point (startRun/invoke) proceeds on a warning.

Decide the intended behavior for route-bearing startRun/invoke when the host policy is absent: reject, explicitly mark unrouted, or prove the route cannot be enforced from a missing policy — and test it. Distinguish validation/planning consumers from execution surfaces.

Parent: FG-572 · Epic: FG-561.