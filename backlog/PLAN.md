# Forge Working Plan

**Last revised:** 2026-07-24

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Land the FG-496 DB-backed backlog as the canonical same-host source of truth across worktrees. FG-496 is now
decomposed into five sequential, independently-shippable, additive-migration children (FG-606…FG-610). The
durable-continuation foundation (FG-561/FG-583 chain) is complete; this is the next big rock toward operator
work management (FG-593).

## Now

FG-496 slice chain — each additive-only to `~/.forge/forge.db`, cutover gated on migrating the two
seam-bypassing reader classes. Implementation of Slice A awaits operator go-ahead on the decomposition.

1. **FG-606 — Slice A:** DB ticket schema + idempotent Markdown import (non-authoritative shadow). The ready,
   safe first slice — zero authority change.
2. **FG-607 — Slice B:** DB-backed CRUD behind the `structured.ts` seam + per-project storage mode (default
   markdown). Delivers the FG-495 cross-worktree shape.
3. **FG-608 — Slice C:** migrate seam-bypassing readers (dashboard, campaign dir-guards) + the authoritative
   cutover flip.
4. **FG-609 — Slice D:** queue primitives (nullable stack rank, membership, revision-bound readiness, blocker
   evidence, events).
5. **FG-610 — Slice E:** atomic claims/leases/recovery + canonical claim-next query (consumed by FG-591).

## Next

1. **FG-591** — Kanban, CLI/API controls, and capacity-limited compatible-work dispatch; consumes FG-609/FG-610
   primitives, starts after they land.
2. Reconcile **FG-496** (parent) closed once FG-606…FG-610 close with an aggregate AC walk; then **FG-593**.
3. **FG-498** — GitHub Issue ingestion, if it remains valuable after the core queue is operating.

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
