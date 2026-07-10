---
id: FG-508
type: story
status: active
title: "review-loop reviewer on codex-subscription fails: codex CLI too old for gpt-5.6-terra (model_error) — loop stops reviewer_failed"
created: 2026-07-10
---

Hit live during FG-502 (run run-review-loop-fg-502-eeba99, task task-red-wide-ce6cab, 2026-07-09): a review-loop round-2 reviewer dispatched on the codex-subscription profile and failed with failure_kind=model_error: "codex run failed: 400 invalid_request_error: The gpt-5.6-terra model requires a newer version" (of the Codex CLI in the agent image). The loop correctly stopped reviewer_failed (structural), but the whole run was lost to an infra issue.

Two parts:
1. DONE (2026-07-09, PR #88, merge b03a3f5): Codex CLI pin bumped 0.135.0 -> 0.144.1 in docker/agent-dev-worker.Dockerfile; image rebuilt; codex-subscription smoke invoke verified before/after on run run-fg-508-codex-subscription-smoke-dedab5 (pre-bump: same model_error; post-rebuild: complete).
2. REMAINING: why did round 2 reviewer resolve to codex when round 1 ran on claude-subscription (policy default for red-wide)? If the loop or model policy rotates/falls back reviewer profiles between rounds, a provider-broken profile can structurally kill an otherwise-passing loop. Either pin the reviewer profile for all rounds of one loop run, or on model_error retry the SAME round on the default profile before declaring reviewer_failed.

Acceptance:
- [x] codex-subscription smoke invoke passes with the configured model (PR #88, merge b03a3f5; smoke run run-fg-508-codex-subscription-smoke-dedab5)
- [ ] a review-loop whose reviewer hits a provider/model_error does not lose the run: same-round retry on the default profile, or documented single-profile pinning
- [ ] regression test for the reviewer model_error path