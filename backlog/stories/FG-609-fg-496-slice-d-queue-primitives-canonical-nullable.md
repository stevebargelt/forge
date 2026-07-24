---
id: FG-609
type: story
status: active
title: "FG-496 Slice D: queue primitives — canonical nullable stack rank, explicit queue membership, revision-bound readiness, blocker evidence, event history"
created: 2026-07-24
---

## Slice D of FG-496 — queue primitives (rank / membership / readiness / blocker / events)

Add the durable operator-queue primitives from the FG-496 binding Operator Queue Contract. These are the
orthogonal fields FG-591 projects into Backlog/Queued/In-progress/Blocked/Done — they are NOT a second
mutable status vocabulary. Derived `in_progress` / `blocked` are computed, never stored.

## Scope

- **Canonical nullable `priority_rank`** on tickets — a stack rank across open tickets, NOT a 1–5 / P0–P4
  score. Unranked tickets remain valid backlog items. One canonical rank; no separate backlog priority and
  queue position that can drift.
- **Explicit queue membership** — an operator-selected subset, orthogonal to rank and lifecycle. The
  executable queue is queued tickets sorted by `priority_rank`.
- **Revision-bound readiness** — reuse FG-382 `evaluateReadiness` (do NOT invent a new vocabulary). Store the
  outcome against the ticket revision/body-hash; editing the ticket invalidates the assessment until rechecked.
  Enqueue requires `ready` (or `exploratory` for explicitly exploratory work).
- **Durable blocker evidence** — legacy `blocked`-status tickets convert to active + a blocker_evidence row
  (migration); the blocked projection is derived and does not make a ticket queue-eligible.
- **Append-only event history** — enqueue / dequeue / reorder / readiness transitions each append an event.

## Files (grounded)

- `src/store/schema.ts` — new `queue_membership` / `readiness_assessments` / `blocker_evidence` /
  `queue_events` tables; guarded `ALTER tickets ADD priority_rank`.
- `src/store/db.ts` `applyMigrations` — `PRAGMA table_info`-guarded ALTER (mirror the tasks/runs ALTER pattern).
- `src/readiness/readiness.ts` — `evaluateReadiness(StructuredTicket)` already exists; bind its result to the
  ticket body-hash.
- `src/cli/commands/backlog.ts` — `rank` / `enqueue` / `dequeue` / `reorder` subcommands.

## Acceptance Criteria

- Rank / unrank; enqueue refused unless the current revision is `ready` (or exploratory) with a concrete reason.
- Editing a ticket invalidates its stored readiness (body-hash mismatch) until rechecked.
- Reorder is atomic.
- A blocked queued ticket retains its rank; resolving the blocker returns it to the same position.
- A done ticket leaves the active queue while its queue history remains auditable.
- Every enqueue / dequeue / reorder / readiness transition appends an event.
- Migration preserves current active/done/deferred state and converts legacy `blocked` to active + blocker
  evidence without silently making it executable.
- Additive schema only; no `user_version` bump; a per-slice migration test proves forward-open safety.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606), Slice B (FG-607). (Cutover — Slice C/FG-608 — is not strictly required for the
  primitives to exist, but the queue is only operationally meaningful post-cutover; sequence D after C.)
- Consumed by: FG-591 (Kanban + dispatcher).

## Non-Goals

- No atomic claims / claim-next (Slice E). No dispatcher, no UI (FG-591). Derived in_progress/blocked are NOT
  stored as mutable status.
