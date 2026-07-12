---
id: FG-513
type: story
status: done
title: "review-loop reviewer profile rotation: mid-loop model_error kills the run — pin per-loop or same-round retry on default profile"
created: 2026-07-10
closed: 2026-07-12
closed_commit: 56c0d07
---

Split out of FG-508 (operator descope decision, 2026-07-10): FG-508 covered the codex CLI version mismatch only; the loop-resilience scope it originally bundled lives here.

Observed during FG-502 (run run-review-loop-fg-502-eeba99, task task-red-wide-ce6cab, 2026-07-09): a review-loop's round-1 reviewer ran on claude-subscription (policy default for red-wide), but round 2 resolved to codex-subscription, which was provider-broken at the time (model_error). The loop correctly stopped `reviewer_failed` (structural), but the whole otherwise-passing run was lost to an infra issue.

Two questions:
1. Why does the reviewer profile rotate/fall back between rounds of one loop run? Find the mechanism (loop, model policy, or profile fallback) and decide the intended behavior.
2. Resilience: a provider/model_error on the reviewer should not structurally kill the run. Either pin the reviewer profile for all rounds of one loop run, or on model_error retry the SAME round on the default profile before declaring reviewer_failed.

Acceptance:
- [ ] the round-to-round reviewer profile resolution is understood and documented (why claude → codex between rounds)
- [ ] a review-loop whose reviewer hits a provider/model_error does not lose the run: same-round retry on the default profile, or documented single-profile pinning
- [ ] regression test for the reviewer model_error path
