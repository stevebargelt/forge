---
id: FG-540
type: story
status: done
title: Codex structured-role result recovery from a completed terminal agent message
created: 2026-07-12
closed: 2026-07-12
closed_commit: 0a2ce3e
---

## Problem

FG-536 review-loop run `run-review-loop-fg-536-eaa5be` lost an otherwise valid second-round review:

- task `task-red-wide-0dc174` ran on `codex-subscription` / `gpt-5.6-terra`;
- the container exited 0 and Codex emitted `turn.completed`;
- the final completed Codex `agent_message` contained a valid JSON reviewer result with `verdict: "pass"` and no findings;
- `/task/result.json` remained empty, so Forge recorded `failure_kind: result_missing`, `error: no_result_json` and review-loop stopped `reviewer_failed`;
- the first reviewer in the same run did write `result.json`, proving this is intermittent model/adapter contract behavior rather than a systematic launch failure.

This is distinct from FG-513. FG-513 deliberately retries only provider/model infrastructure failures classified `model_error`; this task completed cleanly and was classified `result_missing`. A blanket retry would spend another full reviewer invocation even though a schema-valid result is already durably present in the runtime stream.

Evidence is preserved under `~/.forge/runs/run-review-loop-fg-536-eaa5be/task-red-wide-0dc174/`. As of investigation on 2026-07-12, this is the only `codex-subscription` task in the Forge DB with `error=no_result_json`.

Relevant code: `src/v2/provider-failure.ts`, `src/v2/inferred-result.ts`, `src/v2/role-capabilities.ts`, and the missing-result branches in `src/v2/invoke.ts`, `src/v2/runNext.ts`, and `src/v2/reconcile.ts`.

## Goal

Recover an exact structured JSON result from a successfully completed Codex JSONL stream when the agent omitted `result.json`, while preserving every downstream role/schema, persistence, and trust check. This is provider-adapter recovery, not a generic inferred narrative result and not a relaxation of reviewer closeability.

## Acceptance Criteria

- [ ] For `codex-jsonl`, a clean exit with `turn.completed` and a final completed `agent_message` whose text is a JSON object can supply the missing structured result.
- [ ] The recovered object is persisted to `result.json` and then follows the same normal task completion, role validation, persistence validation, event, and retention paths as a file-written result.
- [ ] A real regression fixture derived from `task-red-wide-0dc174` recovers the pass object and allows `parseReviewerVerdict` to validate it normally.
- [ ] An existing non-empty `result.json` remains authoritative; stdout recovery never overwrites it.
- [ ] Recovery fails closed for malformed JSON, JSON primitives/arrays, narrative prose, missing `turn.completed`, `turn.failed`, top-level provider errors, non-zero exit, or an ambiguous/incomplete stream.
- [ ] A recovered JSON object that violates the consumer's reviewer/result schema still fails as invalid; it is never converted to a pass or inferred summary.
- [ ] Selection is deterministic when multiple agent messages exist: progress/intermediate messages cannot outrank the terminal completed result.
- [ ] Dispatch-time and reconcile-time missing-result paths consume one shared extraction rule so watcher loss cannot change the result contract.
- [ ] FG-513's bounded `model_error` retry behavior remains unchanged and is not broadened to every `reviewer_failed` or `result_missing` event.

## Non-Goals

- Do not accept arbitrary stdout text for structured roles.
- Do not infer a reviewer verdict from prose.
- Do not retry all structural reviewer failures.
- Do not weaken `result.json` as the preferred explicit agent contract.
