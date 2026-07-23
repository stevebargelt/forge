# Forge Working Plan

**Last revised:** 2026-07-22

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Finish the existing durable-continuation foundation at FG-583, close its parent chain, and shift Forge
development toward operator work management. The foundation is sufficient after that closeout; additional
hardening is not automatically prerequisite work.

## Now

1. **FG-583** — complete atomic host-seed publication.
2. After FG-583 closes, reconcile and close **FG-572**, **FG-553**, and **FG-561** when their recorded
   closure criteria are met.

## Next

1. **FG-496** — DB-backed backlog, canonical stack rank, revision-bound readiness, queue membership, and
   recoverable claims.
2. **FG-591** — Kanban, CLI/API controls, and capacity-limited compatible-work dispatch.
3. Reconcile **FG-593** as those children land.
4. **FG-498** — GitHub Issue ingestion, if it remains valuable after the core queue is operating.

`Next` is deliberately short. Ordering here expresses current intent; it does not override ticket
dependencies or authorize execution.

## Interruption policy

An item may move ahead of `Next` only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss or wrong-ship risk;
- a defect blocking the current objective.

A newly discovered hardening opportunity is captured in the backlog but does not automatically become
`Now` or `Next`.

## Explicitly deferred

- FG-597, FG-598, FG-599, FG-600, FG-601, FG-602, and FG-604 follow-up hardening, unless promoted by the
  interruption policy.
- Broad worktree/isolation, lifecycle-evaluator, provider-adapter, and workflow-semantics programs.
- Declarative phase mutation contracts and the red/green workflow described in the 2026-07-21 Vjeko
  article.

## Maintenance rules

- Keep `Next` to roughly five items.
- Link ticket IDs instead of copying their acceptance criteria here.
- Do not record progress percentages or duplicate live status.
- Prefer rewriting stale intent over preserving historical wording.
- Commit plan-only changes as small backlog commits.
- Retire this file when the DB-backed queue becomes the authoritative expression of operator intent.
