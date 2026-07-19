---
id: FG-595
type: story
status: active
title: "Dashboard Projects: hide deleted inactive scratchpad checkouts instead of showing unknown branches"
created: 2026-07-19
---

## Problem

The Dashboard Projects view renders deleted historical checkout paths as if they were current checkouts. For Forge, this currently produces multiple rows like:

`/private/tmp/claude-501/.../scratchpad/fg569-work` — `unknown branch`

These paths come from durable historical `runs.project_dir` rows. `listProjects()` correctly retains them for history and repository aggregation, and `recoverScratchpadRepository()` correctly associates recognizable Claude scratchpads with the Forge repository. The presentation layer then exposes each missing, inactive path in `project.checkouts`, where the client substitutes `unknown branch` for the absent Git branch.

Branch cleanup cannot remove these entries, and deleting run history is not an acceptable fix.

## Goal

Make Dashboard project and checkout selectors show current or operationally actionable checkouts, while preserving historical run data, repository aggregation, activity timestamps, and project-scoped history.

## Acceptance Criteria

- A checkout with `exists === false`, `inFlightCount === 0`, and `liveSessions === 0` is not rendered in the Dashboard Projects card or checkout selectors.
- An existing checkout remains visible even when it has no current activity.
- A missing checkout with an in-flight run or live session remains visible as an operational problem and is labeled truthfully as missing/unavailable rather than `unknown branch`.
- Historical runs from suppressed checkout paths still contribute to the canonical repository's aggregate run count and last-activity timestamp.
- Canonical project scope retains the historical `projectDirs` needed to query prior feed, usage, and run records; hiding a checkout must not discard or rewrite history.
- A project whose checkouts are all missing and inactive is omitted from the Dashboard Projects registry instead of appearing as an `Unknown repository` card for an obsolete temp directory.
- API/client behavior is consistent: stale paths do not reappear in the Projects card, global checkout filter, backlog checkout filter, or other selectors consuming the project registry.
- Add regression coverage for:
  - an existing Forge checkout plus several deleted Claude scratchpad paths grouped into Forge;
  - a deleted inactive standalone temp project;
  - a missing checkout that still has active work;
  - preservation of historical aggregate counts and project scope.

## Reproduction

The live Forge DB currently contains 11 deleted `/private/tmp/claude-501/.../scratchpad/*` project directories grouped under Forge. Each has zero active runs, but the Projects view renders all 11 as `unknown branch` checkouts.

## Non-Goals

- Do not delete or rewrite historical run rows.
- Do not remove filesystem directories.
- Do not treat this as Git branch cleanup.
- Do not change canonical repository identity or scratchpad recovery unless required to implement the presentation rule safely.
