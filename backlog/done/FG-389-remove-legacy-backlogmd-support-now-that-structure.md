---
id: FG-389
type: story
status: done
title: Remove legacy BACKLOG.md support now that structured backlog is canonical
created: 2026-06-23
closed: 2026-06-24
---

## Problem

Forge has migrated to the structured `backlog/` directory format. Keeping legacy `BACKLOG.md` code paths increases operational complexity, makes new features accidentally test the wrong backlog model, and lets agents preserve dead compatibility that the project no longer wants.

This surfaced during FG-381: the Reviewer Context Packet initially passed tests by fabricating a legacy `BACKLOG.md` fixture even though Forge itself uses structured ticket files with frontmatter. That is exactly the kind of dead-path support that makes the system harder to reason about.

## Goal

Remove legacy `BACKLOG.md` support from Forge and make structured backlog files the only supported backlog storage model.

## Acceptance Criteria

- Remove legacy `BACKLOG.md` parser/serializer/I/O paths from production code, or quarantine them only as migration utilities if still needed for one-way import.
- `forge backlog` commands operate on structured `backlog/` files only.
- `forge init` and setup paths no longer create or recommend root `BACKLOG.md`.
- Dashboard backlog APIs and tests use structured backlog fixtures only.
- Reviewer Context Packet and Shipping Reviewer related code use structured ticket ids exactly, such as `FG-381`, with no numeric legacy fallback.
- Tests that fabricate `BACKLOG.md` for non-migration behavior are removed or converted to structured backlog fixtures.
- Documentation and seed instructions stop referring to `BACKLOG.md` as an active project state file.
- If a migration command remains, it is explicitly labeled one-way legacy import and is not used by normal runtime paths.
- Full host typecheck and test suite pass.

## Non-Goals

- Do not redesign the structured backlog schema.
- Do not move backlog state out of the repository in this story.
- Do not build a dashboard backlog editor here.

## Notes

This should be treated as a complexity-reduction cleanup. The desired end state is that new workflow, dashboard, reviewer, and orchestrator features cannot accidentally depend on the old root `BACKLOG.md` model.
