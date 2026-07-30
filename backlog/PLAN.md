# Forge Working Plan

**Last revised:** 2026-07-30

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Stabilize the newly-live evidence-led review lifecycle at its measured fix-cycle boundary, then ship
the dashboard agent-runtime view and return to the FG-496 operator-work-management program.

**Recently completed:**

- **FG-608** — the Forge repo is cut over to the DB-backed backlog (`086f3b4`); Markdown is a frozen
  snapshot and ticket verbs are DB-authoritative.
- **FG-345 / FG-621 / FG-628** — managed workflow isolation is default-on with private writable Git
  for mutators and fail-closed review-artifact handling.
- **FG-644 / FG-645 / FG-642 / FG-647** — the known zero-red program is closed: in-container CLI
  suites execute, the dashboard browser tier is mandatory, and the environment-dependent secondary
  Node arm and its CI provisioning are removed.
- **FG-638 → FG-639 → FG-640** — the evidence-led review ledger, staged coordinator,
  `review_disposition` gate, and feature-workflow migration shipped. Change 0 is retired,
  `forge review-loop` is deprecated, and FG-541 is superseded on its durable evidence mapping.
  The lifecycle settled its first production review on FG-647. This is not a claim that its known
  FG-649 fix-cycle defect is acceptable.

## Now

1. **FG-649 — evidence-led candidate re-anchoring.** A post-hoc fixer commit can leave recheck bound
   to the pre-fix SHA; the FG-639 pilot hit this twice and remains parked before shipping review.
   Treat this as immediate lifecycle stabilization, not optional hardening. Done means an ordinary
   fix cycle records the candidate containing the fixes automatically, recheck examines that exact
   candidate, and shipping review completes without a manual re-anchor. The same ticket owns
   persisted-workspace resolution and excluding already-resolved findings from later FixBatches.

## Next

1. **FG-648 — dashboard agent runtime over time:** overall and per-role averages, sample counts, and
   1d/7d/30d/90d/all windows. Dashboard owns the query, UI, and tests; no cross-package test coupling.
2. **FG-609 — FG-496 Slice D:** queue rank, membership, revision-bound readiness, blocker evidence,
   and event-history primitives.
3. **FG-610 — FG-496 Slice E:** atomic claims, leases, recovery, capacity accounting, and canonical
   claim-next.
4. **FG-591 — operator work queue:** Kanban/CLI/API surface and capacity-limited dispatch over the
   queue primitives.
5. Reconcile and close **FG-496** with its aggregate acceptance walk after the queue primitives and
   operator surface prove the DB-backed objective end to end.

`Next` is deliberately short. Ordering here expresses current intent; it does not override ticket
dependencies or authorize execution.

## Committed follow-on

- Continue **FG-593** after FG-591 and the FG-496 closeout according to its remaining
  operator-work-management scope.

## Interruption policy

An item may move ahead of `Next` only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss or wrong-ship risk;
- a defect blocking the current objective;
- **ANY persistently red test, or a required tier that silently does not execute, on any supported
  environment.** Red tests are never a tax. A skip is never evidence: restore execution rather than
  converting red to skip. An alternate lane only counts when it is mandatory, runs the same
  assertion at the same candidate SHA, and records that executed identity.

A newly discovered hardening opportunity is captured in the backlog but does not automatically become
`Now` or `Next`.

## Explicitly deferred

- **FG-650** — strict review schemas rejected honest reviewer payloads with extra legacy keys three
  times. Real, with retry/accepted-lens workarounds, but its ticket is title-only and must become
  implementation-ready before routing. Do not promote it ahead of demonstrated lifecycle
  correctness work.
- **FG-641** — behavior-oriented test organization. Its cleanup inventory now includes the
  ticket-prefixed files added by FG-642/FG-638/FG-639/FG-640/FG-647; sixteen of those were added
  after the new placement rule took effect. Do not file another cleanup ticket. New ticket-prefixed
  files require the documented cross-layer capstone exception and its recorded reason.
- **FG-646** — the one-time migration dry-run write defect is off-queue by operator decision. Forge
  is single-user and the relevant projects are being cut over; do not polish obsolete migration
  machinery.
- **FG-626** — `forge launch run` does not propagate the caller's environment, so every `FORGE_*` gate is
  inert under the launch pattern the orchestrator template mandates. Real and operator-facing, but it has
  a working escape (`forge launch run -- env VAR=… <cmd>`), so it is captured rather than promoted. Note
  the only reason it surfaced is that FG-612 independently refused the dispatch; a safety gate the
  operator believes is armed and is not is the worst shape this can take, so promote it if it recurs
  anywhere that guard does not cover.
- FG-597, FG-598, FG-599, FG-600, FG-601, FG-602, and FG-604 follow-up hardening, unless promoted by the
  interruption policy.
- FG-625 remains deferred unless it becomes a demonstrated blocker or required-CI failure.
- **FG-637** and further worktree/isolation hardening after FG-345, unless a deterministic reproduction
  exposes data loss, corruption, wrong-candidate behavior, or failure in a supported workflow.
- Broad provider-adapter and workflow-semantics programs.
- Declarative phase mutation contracts and the red/green workflow described in the 2026-07-21 Vjeko
  article.

## Working rules for the live checkout

- Agent work and branch setup happen in the disposable clone (`~/code/forge-fg356`), never in
  `~/code/forge`. Task workspaces are created under `~/.forge/worktrees/clones/` regardless of project
  dir, so the clone substrate is still exercised either way.
- No destructive git command (`reset --hard`, `checkout -f`, `clean`) runs against the live checkout as
  part of a compound chain. Check the working tree as its own step first. This rule exists because a
  `reset --hard` here destroyed five files of uncommitted operator work on 2026-07-27; it was recovered
  from a Codex session transcript, which is a real recovery surface worth checking before calling
  anything unrecoverable.

## Maintenance rules

- Keep `Next` to roughly five items.
- Link ticket IDs instead of copying their acceptance criteria here.
- Do not record progress percentages or duplicate live status.
- Prefer rewriting stale intent over preserving historical wording.
- Commit plan-only changes as small backlog commits.
- Retire this file when the DB-backed queue becomes the authoritative expression of operator intent.
