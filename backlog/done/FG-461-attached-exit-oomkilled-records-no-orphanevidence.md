---
id: FG-461
type: story
status: done
title: attached-exit oom_killed records no OrphanEvidence — surface recovery evidence for recovery-relevant kinds at the invoke/runNext attached-exit path
created: 2026-07-05
closed: 2026-07-05
closed_commit: 7b4e102
---

## Problem

Surfaced by the FG-455 attached-exit-137 review-loop (run-review-loop-fg-455-5171c3, red-wide finding 1). FG-455 now classifies a direct attached exit-137 missing-result as `oom_killed` (invoke.ts / runNext.ts). But that path fails the task via `failTask(taskId, { runId, kind, error })` and records NO `OrphanEvidence`, so `getOrphanEvidenceFromEvents` returns undefined and `forge show`/`status`/`ops check` cannot surface the container-name / liveness / exit-code / changed-file recovery evidence they render for a reconcile-time `oom_killed`.

## Why this is a SEPARATE ticket from FG-455's reopen (scope note)

- The FG-455 reopen was explicitly scoped to CLASSIFICATION consistency ('detectable exit-137 missing-result paths produce oom_killed consistently') — met and tested.
- `OrphanEvidence` is a RECONCILE-TIME construct: it is recorded only by reconcile.ts when it discovers an orphaned container. NO attached-exit failure kind (container_crash, model_error, idle_timeout, oom_killed) records it today — so attached-exit oom_killed lacking it is consistent with every other attached-exit kind, not an oom_killed-specific regression.
- Fail-safe: nothing breaks; show/status/ops-check simply render no recovery line for an attached-exit failure (as they already do for attached container_crash etc.).
- FG-455's orphan-evidence AC ('record container name / liveness / exit evidence / changed files before classifying'; 'show/status surfaces a specific message when orphaned with worktree changes') is met for the ORPHAN (reconcile) scenario it targets.

## Product question (decide at implementation)

Should the attached-exit path record structured recovery evidence, and for which kinds? oom_killed is a good first candidate BECAUSE it has special recovery semantics (retryable:false → needs --force; continuable via forge recover) — so surfacing its evidence is more valuable than for a plain container_crash. But a killed container's partial worktree work is relevant regardless of kind. Options: (a) record OrphanEvidence for attached-exit oom_killed only; (b) record it for all recovery-relevant attached-exit kinds; (c) leave attached-exit as report-only and keep evidence a reconcile-time concept.

## Acceptance criteria (once the option is chosen)

- For the chosen kind(s), an attached-exit failure records the available evidence (container name, exit code, result-missing, changed-file evidence from the worktree/shared project dir with the shared-dir hedge, source) on the task.failed payload, so getOrphanEvidenceFromEvents surfaces it and forge show/status/ops-check render a recovery line.
- Consistent with the shared-project-dir caveat FG-455 already documents (evidence to inspect, not proof of task work).
- Tests through the real invoke/runNext attached-exit path.

## Pointers
- src/v2/invoke.ts ~517 and src/v2/runNext.ts ~2232 (attached-exit failTask branches).
- src/v2/reconcile.ts (OrphanEvidence gathering — the reconcile-time reference).
- src/v2/failure-kind.ts (OrphanEvidence shape, getOrphanEvidenceFromEvents).
- FG-455 (classification, done).