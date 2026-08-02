# Forge Working Plan

**Last revised:** 2026-08-01

This is a mutable statement of current operator intent. It is not an approval
boundary, ticket specification, execution record, or source of lifecycle
truth.

The DB-backed backlog is authoritative for ticket scope, acceptance criteria,
dependencies, and lifecycle state. Forge runtime state is authoritative for
what is running, blocked, or done. `backlog/notes.md` is a session handoff and
may lag this plan.

**Expected replacement:** the DB-backed priority queue and operator controls in
FG-496 and FG-591.

## Current objective

Return to product feature work after the evidence-led review stabilization
program. Ship the dashboard runtime-trend feature, then resume the DB-backed
operator-work-management sequence.

Review-infrastructure follow-ups do not consume the feature slot unless a
deterministic failure directly blocks the current ticket, required CI, or
correct publication.

## Recently completed

- **FG-649, FG-650, and FG-653** — stabilized candidate re-anchoring and honest
  reviewer payload handling.
- **FG-654** — moved Forge-owned review protocols into atomic seed generation
  and made missing or stale protocol artifacts fail closed.
- **PR #191 / FG-657 implementation** — multi-test evidence claims now resolve
  every named test without substring or fuzzy matching. The still-active DB
  ticket needs administrative closeout reconciliation, not another
  implementation run.
- **FG-660** — restored the intended review cardinality: one discovery pass,
  at most one remediation batch, and one recheck.
- **PR #193** — added the documentation index and removed stale assessments.

## Now

1. **FG-648 — dashboard agent runtime over time.** Add overall and per-role
   average runtime trends for 1d, 7d, 30d, 90d, and all windows. Keep the
   implementation and coverage inside the dashboard workspace. Browser
   coverage must execute with zero skips.

   Treat this as the next product-feature slot. Do not substitute review
   hardening or queue infrastructure unless it demonstrably blocks FG-648.

## Next

1. **FG-609 — FG-496 Slice D:** queue rank, explicit membership,
   revision-bound readiness, blocker evidence, and event history.
2. **FG-610 — FG-496 Slice E:** atomic claims, leases, recovery, capacity
   accounting, and canonical claim-next.
3. **FG-591 — operator work queue:** Kanban, CLI/API controls, and
   capacity-limited dispatch over the queue primitives.
4. **FG-496 aggregate closeout:** reconcile the DB-backed backlog program
   against its acceptance criteria after FG-609, FG-610, and FG-591 ship.
5. **FG-576 — provider-neutral interactive orchestrator launcher:** resolve
   Claude or Codex from model policy after the operator queue program closes.

`Next` is deliberately short. Ordering here expresses current operator intent;
it does not override ticket dependencies or authorize scope expansion.

## Captured follow-ups that do not preempt `Now`

- **FG-652** — stage-record SHA in the crash-after-advance recovery window.
- **FG-655** — documentation-stage commit authority. Until fixed, required
  durable docs must be committed before review; do not rely on a post-review
  docs stage to rescue uncommitted edits.
- **FG-656** — fanout model resolution can drift from the held seed
  generation.
- **FG-657** — reconcile and close the DB ticket for the already-shipped PR
  #191 implementation.
- **FG-658** — test evidence annotated with a source filename is not matched.
- **FG-659** — guard the remaining `lens_outcomes_json` writer and correct a
  stale source comment.
- **FG-545** — add a docs/research-only CI fast path while preserving
  exact-head required checks.

These remain real work. They move ahead only under the interruption policy
below, not because they are adjacent to recently completed review work.

## Interruption policy

An item may move ahead of `Now` or `Next` only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss, security, or wrong-publication risk;
- a deterministic defect blocking the current objective;
- a required test tier that does not execute.

A newly discovered hardening opportunity is recorded in the DB backlog but does
not automatically become the next task. Do not open speculative follow-up
tickets for limitations that fail loudly, already belong to a parent ticket,
or have no demonstrated impact.

## Execution rules

- Start implementation from current `main` in an isolated disposable clone or
  task workspace, never by editing the live checkout.
- Evidence-led review runs once: one discovery pass, at most one remediation
  batch, and one recheck. Remaining work becomes an explicit disposition and
  follow-up, not another internal convergence cycle.
- Required documentation is committed before review while FG-655 remains open.
- Merge only when required CI is green at the actual PR head.
- Close shipped tickets with acceptance-criteria evidence from the merged
  candidate.
- A dirty or untracked operator file in the live checkout is not part of an
  implementation candidate unless the operator explicitly places it in scope.

## Maintenance rules

- Keep `Now` to one product objective and `Next` to roughly five items.
- Update this file when operator sequencing changes; do not preserve stale
  priorities as if they were current.
- Link ticket IDs instead of copying full acceptance criteria.
- Do not duplicate live run state or record progress percentages here.
- Retire this file only when FG-496/FG-591 provide the authoritative priority
  queue and operator controls that replace it.
