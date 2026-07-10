---
id: FG-508
type: story
status: done
title: "review-loop reviewer on codex-subscription fails: codex CLI too old for gpt-5.6-terra (model_error) — loop stops reviewer_failed"
created: 2026-07-10
closed: 2026-07-10
closed_commit: b03a3f5
---

Hit live during FG-502 (run run-review-loop-fg-502-eeba99, task task-red-wide-ce6cab, 2026-07-09): a review-loop round-2 reviewer dispatched on the codex-subscription profile and failed with failure_kind=model_error: "codex run failed: 400 invalid_request_error: The gpt-5.6-terra model requires a newer version" (of the Codex CLI in the agent image). The loop correctly stopped reviewer_failed (structural), but the whole run was lost to an infra issue.

Fix (2026-07-09, PR #88, merge b03a3f5): Codex CLI pin bumped 0.135.0 -> 0.144.1 in docker/agent-dev-worker.Dockerfile; image rebuilt; codex-subscription smoke invoke verified before/after on run run-fg-508-codex-subscription-smoke-dedab5 (pre-bump: same model_error; post-rebuild: complete). Codex-profile reds/reviewers have run cleanly since.

Scope note (operator decision, 2026-07-10): this ticket covers the codex CLI version mismatch ONLY. The loop-resilience scope it originally bundled (why the reviewer profile rotated claude -> codex between rounds; surviving a reviewer model_error via per-loop pinning or same-round retry; regression test) was descoped to FG-513.

Acceptance:
- [x] codex-subscription smoke invoke passes with the configured model (PR #88, merge b03a3f5; smoke run run-fg-508-codex-subscription-smoke-dedab5)
