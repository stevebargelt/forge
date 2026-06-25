---
id: FG-412
type: story
status: active
title: "failure-kind: undefined conflates 'no terminal event' with 'task.failed missing failure_kind' — risks misclassifying an unrecorded infra failure as LOCAL"
created: 2026-06-25
---

## Problem

src/v2/failure-kind.ts failureKindFromEvents returns undefined both when there is no terminal event AND when a task.failed event lacks a failure_kind field. Consumers that classify undefined as a LOCAL/agent failure (e.g. FG-393's classifyFailureKind maps undefined → 'scope' = LOCAL) could therefore treat an infrastructure failure that simply did not record a failure_kind as a local item failure — the dangerous direction (continuing past a broken environment).

Surfaced by the FG-393 red-backend review (LOW / residual_risk). Not an FG-393 defect — FG-393 consumes the shared classifier; the conflation is a property of failure-kind.ts (shared runner-core, out of FG-393 scope).

## Acceptance Criteria

- failureKindFromEvents (or its callers) can distinguish 'no terminal event observed' from 'task.failed with no failure_kind recorded'.
- Ensure task.failed events reliably carry a failure_kind (or the classifier returns a conservative value for an unrecorded failure so consumers don't under-classify infra failures as local).
- A failed task with an infrastructure cause is not silently classified as a local/agent failure due to a missing field.

## Notes
Affects all failure-kind consumers, not just campaigns. Low likelihood (failed tasks generally record a failure_kind) but the misclassification direction is unsafe. Relates to FG-393.