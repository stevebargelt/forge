---
id: FG-506
type: story
status: done
title: "review-loop/campaign polish: bespoke stop message for scope_guard_revert_failed + reconcile --help names only the scope-blocked shape"
created: 2026-07-09
closed: 2026-07-19
---

Batched fail-safe lows from the FG-502 run (PR #87). Neither can cause a wrong-ship or trust bypass.

1. red-wide re-check LOW: the new review-loop stop reason scope_guard_revert_failed gets only the generic fallback console message in registerReviewLoop (src/cli/commands/review-loop.ts:876-878), unlike closeout_guidance_only which has bespoke wording. Add operator-facing wording that names the failed paths + stage and the next action (inspect tree; the round did not commit).

2. SHIPPED EARLY (PR #87, loop-4 fixer commit c0aa07a): the reconcile --help text now names all three recoverable shapes. Nothing remains from this item. Original finding for reference: forge campaign reconcile's --help description ('re-derive outcomes for scope-blocked items ... and ship them if all facts hold', src/cli/commands/campaign.ts:719-721) names only the scope-blocked shape — stale since FG-443 added out-of-band (shape 2) and further stale now FG-502 added campaign_system (shape 3). Update the string to cover all three recoverable shapes.

Acceptance:
- [ ] scope_guard_revert_failed prints a bespoke message naming failedRevertPaths, the failing stage (fixError), and next action
- [x] reconcile --help text names all three recoverable shapes — shipped in PR #87 (c0aa07a)
- [ ] both surfaces covered by existing test patterns (CLI human-output assertions)

## Disposition — 2026-07-19

Closed as intentionally not pursued. The shipped reconcile-help correction remains; a bespoke message for the rare `scope_guard_revert_failed` path is not valuable enough to retain as standalone roadmap work.
