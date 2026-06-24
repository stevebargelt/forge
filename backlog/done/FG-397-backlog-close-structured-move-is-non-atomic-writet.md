---
id: FG-397
type: story
status: done
title: "backlog close: structured move is non-atomic (writeTicket to done/ then unlinkSync story) — a crash between leaves a ghost active copy that shadows the done file"
created: 2026-06-24
closed: 2026-06-24
---

## Problem

Structured backlog close/move writes the destination ticket file and then deletes the source file. A crash, throw, or process kill between those operations can leave two copies of the same ticket id: one in `done/` and one in the active type directory.

Because structured lookup scans active directories before `done/`, the ghost active copy can shadow the closed copy. The operator sees a ticket as active even though close already wrote the done record.

This is a backlog integrity problem, and Campaign Runner would make it easier to hit because it will perform more automated close/move operations.

## Goal

Make structured backlog move/close operations atomic enough that Forge never leaves duplicate visible copies of the same ticket id after a partial failure.

## Acceptance Criteria

- Add a shared structured backlog operation for moving a ticket between directories/statuses without duplicating visible ids.
- `forge backlog close <id>` uses the shared operation instead of write-destination-then-delete-source loops.
- `forge backlog move <id> <type>` uses the same safe operation or remains proven safe after the shared fix.
- If an operation fails before completion, subsequent `readTicket`, `listTickets`, and `show` do not let an active ghost silently shadow the intended done/moved ticket.
- Duplicate ticket ids across structured backlog directories are detected and reported loudly rather than silently picking the first scanned copy.
- Tests cover close success, move success, simulated failure between destination write and source removal, and duplicate-id detection.
- Tests cover stories, epics, ideas, and done directory interactions.

## Non-Goals

- Do not implement file-backed id allocation locking; FG-398 owns ticket id generation races.
- Do not add close commit metadata; FG-399 owns `--commit <sha>` persistence.
- Do not reintroduce legacy `BACKLOG.md` behavior.
- Do not require a database-backed backlog in this story.
