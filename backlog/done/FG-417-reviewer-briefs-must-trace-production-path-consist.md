---
id: FG-417
type: story
status: done
title: Reviewer briefs must trace production-path consistency for surfaced/reported/gated behavior
created: 2026-06-29
closed: 2026-06-29
closed_commit: 63d7b3e
---

## Problem

Recent reviews repeatedly caught local correctness but missed end-to-end consistency:

- evaluator or schema support exists, but the real collector/data path never populates it;
- JSON/report output has the data, but the human operator surface does not render it;
- a workflow mutates state during a loop, but later steps review or report a stale precomputed snapshot.

This pattern showed up across FG-413, FG-416, FG-383, and FG-415. It is broader than the Shipping Reviewer itself: it affects red-wide, review-loop, implementer self-review, and campaign/control-plane work.

## Goal

Harden reviewer/red briefs so any acceptance criterion involving "surface", "report", "distinguish", "gate", "block", "resume", "continue", "approve", or "review" is checked through the canonical production path, not only by inspecting the changed function or pure evaluator.

## Acceptance Criteria

- Update red-wide/review-loop reviewer brief guidance to require an explicit production-path trace for those AC types.
- The trace covers source of truth -> collector/gatherer -> evaluator/policy -> state transition/rerun behavior -> operator surface/JSON output -> tests.
- Add a stale-state-after-mutation check: if a workflow mutates state during a loop, later steps must observe the new state, not a cached snapshot.
- Require reviewers to call out when implementation only adds evaluator/schema support but leaves the real-data path null, inert, or fixture-only.
- Tests or golden prompt assertions cover the new rubric language.
- Keep this as review guidance only; do not implement Shipping Reviewer or new campaign mechanics here.

## Relations

- Related to FG-305, FG-384, and FG-415.
- Informed by misses on FG-413, FG-416, FG-383, and FG-415.
