---
id: FG-506
type: story
status: active
title: "review-loop/campaign polish: bespoke stop message for scope_guard_revert_failed + reconcile --help names only the scope-blocked shape"
created: 2026-07-09
---

Batched fail-safe lows from the FG-502 run (PR #87). Neither can cause a wrong-ship or trust bypass.

1. red-wide re-check LOW: the new review-loop stop reason scope_guard_revert_failed gets only the generic fallback console message in registerReviewLoop (src/cli/commands/review-loop.ts:876-878), unlike closeout_guidance_only which has bespoke wording. Add operator-facing wording that names the failed paths + stage and the next action (inspect tree; the round did not commit).

2. documentation-maintainer stale-docs finding: forge campaign reconcile's --help description ('re-derive outcomes for scope-blocked items ... and ship them if all facts hold', src/cli/commands/campaign.ts:719-721) names only the scope-blocked shape — stale since FG-443 added out-of-band (shape 2) and further stale now FG-502 added campaign_system (shape 3). Update the string to cover all three recoverable shapes.

Acceptance:
- [ ] scope_guard_revert_failed prints a bespoke message naming failedRevertPaths, the failing stage (fixError), and next action
- [ ] reconcile --help text names all three recoverable shapes (scope / out-of-band / campaign_system)
- [ ] both surfaces covered by existing test patterns (CLI human-output assertions)