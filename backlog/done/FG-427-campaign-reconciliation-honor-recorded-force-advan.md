---
id: FG-427
type: story
status: done
title: "Campaign reconciliation: honor recorded force-advance / later authoritative pass instead of aggregating stale historical red-fails forever"
created: 2026-07-01
closed: 2026-07-03
closed_commit: d4e5562
---

## Problem

A campaign item's outcome reconciliation aggregates ALL historical authoritative reviewer verdicts for the item's run and treats any recorded `fail/authoritative` as a permanent `blocker=scope`, even when:

- the finding was subsequently resolved,
- a later authoritative re-review recorded a `pass`, and
- the human orchestrator recorded a `force-advance` (with rationale) at the gate.

Observed on campaign-922c83b7c577 / FG-357: the build-phase `red-backend` recorded `fail/authoritative (3 findings)`. The finding (missing fan-out seam test coverage) was fixed, a manual `red-wide` re-check recorded `pass/authoritative`, the gate was force-advanced with a documenting rationale, and the work was merged (b12b764), host-verified, and closed. Yet the item stays `outcome=blocked, blocker=scope` ("workflow completed but authoritative reviewer verdict failed") because reconciliation still sees the stale historical fail. This wedges the whole sequential campaign: FG-376 and FG-422 remain held behind an item that is, in reality, shipped. There is no mechanism to tell the campaign the historical fail was legitimately superseded.

## Goal

Make campaign outcome reconciliation respect a legitimate supersession of a historical authoritative red-fail — a recorded force-advance/human override at the gate, or a later authoritative pass on the same task — instead of treating the earliest recorded fail as a permanent blocker.

## Acceptance Criteria

- Reconciliation determines an item's authoritative-verdict outcome from the EFFECTIVE latest state per task (latest authoritative verdict and/or a recorded gate override), not a blanket "any historical fail => blocked" aggregation.
- A recorded force-advance (with rationale) over a `blocked_by_red`/verdict-fail is honored by reconciliation as an explicit human override, and is auditable (who/when/why) — it does not silently erase the history, it supersedes it.
- A later `pass/authoritative` re-review on the same task supersedes an earlier `fail/authoritative` for outcome purposes.
- Guard against abuse: the override/supersession path is explicit and recorded; it does not let an item reach `shipped` with NO passing authoritative signal at all (an unresolved, un-overridden fail still blocks).
- Test: an item whose run has fail/authoritative -> (force-advance OR later pass/authoritative) reconciles to shipped when the done-audit also passes; an item with an unresolved, un-overridden fail/authoritative still blocks.
- Regression: items with genuinely failing, un-superseded authoritative verdicts continue to block.

## Relations

- Surfaced by campaign-922c83b7c577 wedging on FG-357 after a legitimate force-advance + re-review + merge + close.
- Related to FG-423 (workflow-backed campaign execution: shipped requires passing authoritative verdict AND done-audit) and FG-370 (Campaign Runner).
- Depends conceptually on the gate force-advance already recording rationale/override (used as the override signal here).
