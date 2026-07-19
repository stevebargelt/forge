---
id: FG-593
type: epic
status: active
title: "[EPIC] Operator Work Management: durable backlog, priority queue, and dispatch"
created: 2026-07-19
---

## Problem

Forge can store backlog tickets and execute individual runs or explicit campaigns, but the operator lacks one durable place to capture, stack-rank, queue, and continuously dispatch ordinary work. Priority currently lives in prompts and handoff notes, while live execution state is spread across runs and campaigns.

This makes small but important work easy to lose and forces the operator to act as a manual scheduler. It also conflates two different products: a mutable “work on these next” queue and an explicitly planned/approved Campaign Runner program.

## Goal

Provide a durable operator work-management system in which the operator can capture and refine backlog items, assign a nullable canonical stack rank, enqueue ready work, and allow an explicitly enabled capacity-limited dispatcher to launch the next compatible ordinary Forge runs.

The system presents a Kanban-style projection of Backlog, Queued, In progress, Blocked, and Done without creating competing mutable status vocabularies.

## Product Contract

- Priority is a stack rank, not a 1–5 or P0–P4 scale; unranked backlog items remain valid.
- Queue membership is explicit and orthogonal to ticket lifecycle and rank.
- Enqueue requires revision-bound readiness, with bounded refinement assistance and deterministic revalidation.
- `in_progress`, `blocked`, and `done` are derived from canonical ticket, blocker, claim, run, and campaign state.
- The dispatcher fills configurable `max_active_runs` capacity by scanning queued work in rank order and atomically claiming the first ready item compatible with the active set.
- A higher-ranked item may be temporarily bypassed when it cannot safely overlap current work, but its rank never changes as a side effect.
- “Blocked” is distinct from “ready but waiting for compatibility/capacity,” and both explanations are visible.
- Queueing records planning intent. Execution requires an explicitly enabled operator or autonomous policy.
- Claimed queue items use the normal single-ticket Forge execution path. The queue is not implicitly converted into a campaign.
- FG-370 remains the separate explicit workflow for frozen, planned, approved, coordinated programs of work.

## Acceptance Criteria

- FG-496 provides one DB-backed source of truth for ticket lifecycle, nullable canonical rank, explicit queue membership, revision-bound readiness, blocker evidence, queue events, and recoverable atomic claims across worktrees.
- FG-591 provides dashboard, CLI, and API controls for backlog capture/refinement, enqueue/dequeue, stack ranking, dispatcher enablement, and `max_active_runs` configuration.
- With capacity available, the dispatcher scans queued tickets in rank order, revalidates readiness, and atomically launches the first candidate deterministically compatible with the full active/selected run set.
- Tests prove that an incompatible or blocked higher-ranked ticket can be bypassed without rank mutation, and is reconsidered after the relevant run or blocker changes.
- UI/API distinguish Backlog, Queued, In progress, Blocked, Done, and ready-but-waiting-for-capacity/compatibility using canonical derived evidence.
- Execution authority is explicit, disabling dispatch prevents new claims, and concurrent/restarted dispatchers neither duplicate a ticket nor exceed configured capacity.
- Ordinary queue claims launch single-ticket Forge runs without creating campaigns. FG-370 campaigns remain separately planned, approved, executed, and reported.

## Children / Scope

- FG-496 — DB-backed backlog, rank, queue, readiness, event, and atomic claim primitives.
- FG-498 — external issue ingestion into the durable backlog.
- FG-591 — operator Kanban/CLI/API plus capacity-limited compatible-work dispatcher.

## Related Systems

- FG-382 — deterministic readiness vocabulary and gate.
- FG-370 — explicit Campaign Runner; related consumer/execution surface, not the queue scheduler.
- FG-456 — autonomous authority, decision journal, and hard-stop policy.
- FG-561 — durable continuation, wake-up, reconciliation, and recovery.
- FG-395 — campaign visibility; Operator Work Management owns queue controls and cross-run board projection.

## Non-Goals

- Do not require campaign creation for ordinary queued work.
- Do not silently reorder the operator's canonical priority because a lower item was temporarily parallel-compatible.
- Do not infer safe parallelism solely from an agent opinion or absence of a visible process.
- Do not make parallel Campaign Runner lanes a prerequisite for independent queue-run concurrency.
