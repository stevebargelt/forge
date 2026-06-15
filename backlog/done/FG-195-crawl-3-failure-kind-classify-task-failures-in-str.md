---
id: FG-195
type: story
status: done
title: "Crawl 3 — failure-kind: classify task failures in structured event payloads (no schema column)"
---

**Closed:** 2026-05-30.

Crawl milestone, step 3 of 5 (docs/observability.md, Crawl §3).

**Do NOT add a tasks.failure_kind column in this stage.** That's a schema change to ~/.forge/forge.db with machine-wide blast radius (every running forge re-migrates on next DB open), and its only advantage — aggregate queries — isn't realized until the Run-stage metrics layer. Store failure_kind in the structured FAILURE EVENT PAYLOAD; keep tasks.error as the prose summary. Promote to a column deliberately later, tied to #141 (SQL single-source-of-truth).

**Central classifier, not 24 hand-edits.** markTaskFailed has 24 call sites (invoke.ts ×8, runNext.ts ×12, gate.ts ×2, cancel.ts ×2), several in the dispatch core. Route them through one tested classifier module that records the failure event with a kind, rather than spreading string constants across the runner.

Initial kinds + mapping: AuthProfileError(missing)→auth_missing; AuthProfileError(expired)→auth_expired; IDLE_TIMEOUT_EXIT_CODE→idle_timeout; nonzero container exit + no result→container_crash; empty result.json→result_missing; malformed result.json→result_malformed; gate reject/request-changes→gate_rejected; forge cancel path→cancelled; auth injection failure→auth_injection_failed; plus model_error, tool_error, red_blocked, unknown.

**Acceptance:** every failure event carries a failure_kind; classification logic centralized + unit-tested for every kind; orchestrators can branch on failure_kind without parsing strings. (Dashboard grouping waits for the column/metrics layer — out of scope here.)