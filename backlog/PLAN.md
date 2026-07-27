# Forge Working Plan

**Last revised:** 2026-07-26

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Finish FG-345's isolated-workspace program and make isolation the ordinary/default path. This objective
interrupted the FG-496 slice chain under the plan's existing interruption policy after forge-on-forge work
demonstrated live-checkout damage and the worktree path exposed incomplete Git and cleanup boundaries.

The foundation is already shipped: lifecycle and state (FG-351), merge/integration mechanics
(FG-352/FG-353), persistence and red semantics (FG-354/FG-355), the candidate integration gate and
serialized publisher (FG-357/FG-425), dependency parity (FG-376), read-only Git for non-mutators (FG-559),
self-host refusal (FG-612), and fail-safe linked-worktree recovery (FG-356). Do not reopen those decisions
or create replacement tickets without evidence of a reachable gap.

## Now

1. **FG-621** — give mutating agents private writable Git while Forge retains publication authority.
   Includes the private-clone lifecycle and fail-safe reaping for the substrate it introduces. This is the
   remaining substantive implementation child of FG-345.
2. When FG-621 lands, walk FG-345's aggregate acceptance proof against the implementation that actually
   exists. Count FG-357/FG-425 as the integration/publication solution, FG-351 as the non-Git/dirty/carry-in
   contract, and FG-353/FG-355 as the red-timing decision. Do not file another child for a requirement that
   is already proven.
3. Dogfood the complete path forge-on-forge, then flip isolation default-on while retaining the explicit
   `FORGE_NO_WORKTREES=1` escape hatch. If the aggregate walk demonstrates a concrete blocker, fix that
   bounded blocker first; possibility alone does not expand the program.
4. Close FG-345 only after the default-on run proves mutators, non-mutators, candidate validation,
   publication, and recovery compose end to end.

## Next

Resume the interrupted operator-work-management program at the first unfinished slice. FG-606 and FG-607
are already shipped.

1. **FG-608 — FG-496 Slice C:** migrate seam-bypassing readers and make the DB backlog authoritative.
2. **FG-609 — Slice D:** queue primitives.
3. **FG-610 — Slice E:** atomic claims, leases, recovery, capacity accounting, and claim-next.
4. **FG-591:** Kanban, CLI/API controls, and capacity-limited compatible-work dispatch.
5. Reconcile **FG-496** with an aggregate acceptance walk, then continue **FG-593**.

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
- FG-566, FG-623, and FG-625 do not move ahead of FG-621 or the FG-345 closeout unless one becomes a
  demonstrated blocker or required-CI failure.
- Further worktree/isolation hardening after FG-345, unless the aggregate proof exposes a reachable gap.
- Broad lifecycle-evaluator, provider-adapter, and workflow-semantics programs.
- Declarative phase mutation contracts and the red/green workflow described in the 2026-07-21 Vjeko
  article.

## Maintenance rules

- Keep `Next` to roughly five items.
- Link ticket IDs instead of copying their acceptance criteria here.
- Do not record progress percentages or duplicate live status.
- Prefer rewriting stale intent over preserving historical wording.
- Commit plan-only changes as small backlog commits.
- Retire this file when the DB-backed queue becomes the authoritative expression of operator intent.
