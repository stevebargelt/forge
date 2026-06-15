---
id: FG-216
type: story
status: done
title: "AWN-3 retry-policy: define retry semantics per failure_kind + preserve lineage without leaking secrets"
---

**Closed:** 2026-05-30. Commit `c0d6233`.

docs/agentic-workflow-next-steps.md §3. Predictable retry after every major failure kind. Builds on the Crawl failure taxonomy (failure_kind) and the existing forge retry command.

Scope:
- Retry policy per failure_kind: idle_timeout, container_crash, auth_*, result_missing, result_malformed, gate_rejected, red_blocked, cancelled, unknown.
- Define inherited context: upstream results, task package, auth profile, artifacts, previous-failure summary, logs.
- Retry creates a NEW task identity preserving lineage to the failed task.
- Prevent reuse of staged credential files / partial result files (ties to AWN-8).

Acceptance:
- forge retry shows why a task is retryable or not.
- Retried tasks carry previous-failure context, no secret leakage.
- forge show renders retry lineage clearly.
- Tests: retry after idle_timeout, auth failure, cancelled, malformed result, gate rejection.

Third of the lifecycle-foundation trio.