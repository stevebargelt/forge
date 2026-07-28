# Forge Working Plan

**Last revised:** 2026-07-28

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Advance the FG-496 DB-backed backlog program (FG-608 is the next implementation item) while the
evidence-led review decomposition completes operator review. The isolation program and the interim
review policy are done and in force.

**Complete (recorded 2026-07-28):**

- **FG-345** — isolation default-on shipped and closed (`3ce0385` + `f50e383`); self-host guard keyed on
  actual per-dispatch isolation. The workspace contract stands: committed tracked content at the recorded
  base SHA plus explicitly supplied inputs; ambient checkout state intentionally not inherited;
  `FORGE_NO_WORKTREES=1` is the explicit escape. No generic carry-in system, no further isolation
  children without a deterministic supported-workflow failure.
- **FG-623** — the 1 ms lease-test knife-edge fixed (`612e481f`): renewal at TTL/2, ~150 s headroom,
  0/400 probe failures; closed on the acceptance walk.
- **Evidence-led review Change 0** — interim operating policy ACTIVE (`cc10232a`): both authoritative
  sources (`docs/autonomous-run-prompt.md`, now tracked, and the orchestrator seed/rendered block) carry
  the one-discovery/disposition/batch-fix/exact-recheck policy; the obsolete #302 phrase guard is
  removed; deterministic and authority gates unchanged. Review dispatches now run under this policy.

## Now

1. **Evidence-led review Changes 1–3 decomposition** — proposed to the operator for review
   (2026-07-28); tickets are NOT filed and no implementation is authorized until the operator approves
   the decomposition. Per the PRD, the split is the three Changes only — no further children until a
   boundary proves it cannot ship together.
2. **FG-608 — FG-496 Slice C:** make the DB backlog authoritative per project, migrate seam-bypassing
   readers, and provide containers the live read-only project-scoped backlog authority. Next
   implementation item unless the approved decomposition establishes a concrete dependency requiring
   otherwise.

## Next

1. **Evidence-led review program — reserved position:** after the operator approves the decomposition,
   replace this placeholder with the filed ticket IDs and their dependency order before dispatching any
   Changes 1–3 work.
2. **FG-609 — FG-496 Slice D:** queue rank, membership, revision-bound readiness, blocker evidence, and
   event-history primitives.
3. **FG-610 — FG-496 Slice E:** atomic claims, leases, recovery, capacity accounting, and canonical
   claim-next.
4. Reconcile and close **FG-496** with its aggregate acceptance walk.

`Next` is deliberately short. Ordering here expresses current intent; it does not override ticket
dependencies or authorize execution.

## Committed follow-on

- **FG-591** — build the Kanban/CLI/API operator surface and capacity-limited dispatcher after FG-496's
  source-of-truth and queue primitives are closed.
- Continue **FG-593** after FG-591 according to its remaining operator-work-management scope.

## Interruption policy

An item may move ahead of `Next` only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss or wrong-ship risk;
- a defect blocking the current objective.

A newly discovered hardening opportunity is captured in the backlog but does not automatically become
`Now` or `Next`.

## Explicitly deferred

- **FG-626** — `forge launch run` does not propagate the caller's environment, so every `FORGE_*` gate is
  inert under the launch pattern the orchestrator template mandates. Real and operator-facing, but it has
  a working escape (`forge launch run -- env VAR=… <cmd>`), so it is captured rather than promoted. Note
  the only reason it surfaced is that FG-612 independently refused the dispatch; a safety gate the
  operator believes is armed and is not is the worst shape this can take, so promote it if it recurs
  anywhere that guard does not cover.
- FG-597, FG-598, FG-599, FG-600, FG-601, FG-602, and FG-604 follow-up hardening, unless promoted by the
  interruption policy.
- FG-625 does not move ahead of the FG-345 closeout unless it becomes a demonstrated blocker or required-CI
  failure. FG-623 was promoted after it halted required review-loop verification.
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
