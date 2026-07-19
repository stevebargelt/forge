---
id: FG-591
type: story
status: active
title: "Operator work queue and Kanban board: readiness-gated stack rank and capacity-limited dispatch"
created: 2026-07-19
---

## Problem

Forge has a backlog and ordered campaigns, but no persistent operator-curated “work this next” queue. An operator can capture a ticket or construct an explicit campaign list, but cannot stack-rank selected backlog items, mark a subset as queued, leave blocked work in place, and let Forge continuously select the next compatible item without reconstructing intent in handoff notes or a prompt.

FG-496 moves the active backlog into the DB and defines the queue primitives. This story owns the operator-facing behavior built on those primitives.

## Goal

Provide a Kanban-style backlog control surface and matching CLI/API through which the operator can rank open work, explicitly enqueue ready items, see live execution-derived state, and let a capacity-limited dispatcher claim and launch ordinary Forge runs in priority order.

The queue is not a campaign. It is a continuously evaluated scheduling policy. FG-370 remains the explicit workflow for a human-selected, planned, approved, and reported program of work.

## Board projection

- **Backlog:** every non-done ticket; ranked and unranked items are both valid. Deferred items remain visible but ineligible.
- **Queued:** the explicitly selected subset, ordered by the canonical nullable stack rank—not a 1–5 priority scale.
- **In progress:** derived from associated live Forge runs/campaigns; never manually toggled.
- **Blocked:** derived from readiness, dependency, campaign, or run evidence. A blocked queued ticket retains its queue rank.
- **Done:** derived from terminal ticket status and removed from the active queue while history remains visible.

These are projections over orthogonal durable fields, not five competing ticket statuses.

Within Queued, distinguish a genuine blocker from temporary scheduling incompatibility. A ready item that cannot safely overlap the current active set remains queued with an explanation such as “waiting for FG-123 to finish”; it is not mislabeled Blocked.

## Dispatch model

The dispatcher repeatedly fills available capacity up to configurable `max_active_runs`:

1. Read durable live-run state and the ordered queued set.
2. Scan candidates from highest to lowest canonical stack rank.
3. Revalidate readiness against the current ticket revision.
4. Select the first candidate compatible with every active run and already-selected candidate.
5. Atomically claim the ticket and launch it as an ordinary Forge run.
6. Continue scanning until capacity is full or no compatible candidate remains.

Bypassing an incompatible candidate does not reorder it. Its durable rank remains unchanged, and it is reconsidered whenever capacity or compatibility changes.

Parallel compatibility must be a deterministic, explainable scheduling result. At minimum it considers ticket dependencies and explicit ordering/exclusivity constraints, duplicate ticket execution, repository/worktree and execution-lane capacity, and durable resource/conflict locks. An agent may advise, but an unrecorded semantic guess is not sufficient to claim work.

## Acceptance Criteria

- Dashboard/API list the complete backlog and expose nullable stack rank, queue membership, readiness, live execution state, blocker evidence, and ticket lifecycle state.
- The operator can stack-rank open tickets, leave tickets unranked, enqueue/dequeue tickets, and drag/reorder queued work atomically.
- Queue order is the queued subset sorted by the single canonical backlog stack rank; there is no second hidden queue order.
- Enqueue is refused unless the current ticket revision is `ready`, or FG-382’s lightweight idea-work outcome for a ticket deliberately classified as non-implementation work, with a concrete refinement proposal when refused.
- A small bounded refinement action may propose missing problem/goal/AC/scope/dependency content; after any edit, readiness reruns against the new revision before enqueue.
- A queued ticket that becomes blocked moves to the derived Blocked view without losing rank. When unblocked it returns to its prior queue position.
- A ticket associated with a live run/campaign appears In progress automatically. Completion appears Done automatically and removes it from the active queue.
- CLI supports equivalents of queue list, enqueue, dequeue, and rank-before/rank-after operations.
- The operator can configure `max_active_runs`; the dispatcher never causes the number of queue-owned active runs to exceed it and accounts for other Forge work according to an explicit capacity policy.
- When capacity is available, the dispatcher scans in rank order and starts the first ready candidate that can safely run alongside the current active set. If the highest-ranked candidate is incompatible, it may temporarily select a lower-ranked compatible candidate without mutating either rank.
- Each selection records why higher-ranked candidates were blocked, ineligible, or temporarily incompatible, and why the claimed candidate was parallel-safe.
- Claims are atomic, leased/recoverable, and DB-backed so concurrent dispatchers cannot start the same ticket or overfill capacity. Process-name matching or “no visible terminal” is not sufficient evidence of availability.
- A claimed queue item launches through the ordinary single-ticket Forge run path. It does not implicitly create a campaign or campaign plan.
- The dispatcher wakes or re-evaluates on queue changes, run terminal transitions, blocker/readiness changes, capacity changes, and recovery/reconciliation events; polling may be a fallback, not the only correctness mechanism.
- A blocked top item retains its rank and may be bypassed for independent compatible work, with the durable reason visible. The same is true for a ready item temporarily waiting for compatibility, without calling that item blocked.
- Merely queueing an item is planning intent, not authorization to execute it. Conversation, CLI approval, or an explicitly enabled autonomous queue policy supplies execution authority.
- Disabling autonomous dispatch prevents new claims without terminating already-running work. Capacity reduction likewise does not kill work; it prevents new claims until usage falls below the limit.
- Tests cover sequential dispatch at capacity one, capacity greater than one, skipping an incompatible top item without reordering it, dependency/exclusivity conflicts, concurrent claim races, lease recovery, readiness drift, blocked versus compatibility-waiting presentation, and disable/capacity-change behavior.

## Dependencies / Relations

- FG-496 — DB-backed backlog and canonical rank/queue/readiness primitives.
- FG-382 — existing readiness vocabulary and mechanical preflight.
- FG-593 — parent Operator Work Management epic.
- FG-370 — related explicit Campaign Runner; campaigns are not the default queue dispatch mechanism.
- FG-456 — autonomous execution policy and hard-stop boundaries.
- FG-561 — durable continuation/wake/reconcile behavior for a long-lived dispatcher.
- FG-395 — existing campaign dashboard remains the execution-detail surface; this story owns backlog prioritization and queue control.

## Non-Goals

- Queue membership alone is not execution authorization; an enabled dispatcher policy is.
- Do not create separate mutable ticket, queue-item, and campaign-item status vocabularies for the same facts.
- Do not implicitly convert the queue to a campaign or silently add queue entries to an approved/running campaign.
- Do not add parallel Campaign Runner lanes as a prerequisite for queue dispatch; queue items are independent ordinary runs governed by dispatcher compatibility and capacity.
