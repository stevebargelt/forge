---
id: FG-398
type: story
status: active
title: "backlog file: ticket-id generation is read-then-write without locking — two concurrent invocations can allocate the same id"
created: 2026-06-24
---

## Problem

`forge backlog file` allocates the next ticket id by listing existing structured tickets, computing max id + 1, and then writing the new ticket. Two concurrent invocations can observe the same max id and both choose the same next id.

In a human-only CLI this is rare. Under Forge automation, campaigns, or multiple orchestrator sessions, it becomes a realistic integrity bug.

## Goal

Make structured backlog ticket id allocation safe for concurrent file-backed writers.

## Acceptance Criteria

- `forge backlog file` allocates ticket ids under a project-scoped lock or another equivalent atomic mechanism.
- Concurrent invocations cannot create two tickets with the same id.
- The lock covers the complete read-next-id/write-ticket critical section.
- A stale lock or interrupted process has a clear recovery path and does not permanently block backlog filing.
- The implementation works for project-specific prefixes from backlog config, not only `FG`.
- The implementation does not require a git remote or database.
- Tests cover concurrent filing attempts and prove unique ids are produced.
- Tests cover lock cleanup or stale-lock behavior.
- Existing single-writer behavior and output remain compatible.

## Non-Goals

- Do not redesign the structured backlog storage format.
- Do not implement close/move atomicity; FG-397 owns that.
- Do not implement Campaign Runner here.
- Do not validate or reserve ids across unrelated projects.
