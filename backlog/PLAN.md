# Forge Working Plan

**Last revised:** 2026-07-28

This is a mutable statement of current operator intent. It is not an approval boundary, ticket
specification, execution record, or source of lifecycle truth.

Backlog tickets remain authoritative for problem, scope, acceptance criteria, and dependencies. Forge
runtime state remains authoritative for what is running, blocked, or done. `backlog/notes.md` remains the
session handoff. This file may be rewritten whenever priorities change; Git is sufficient history.

**Expected replacement:** the DB-backed priority queue and operator controls in FG-496 and FG-591.

## Current objective

Finish FG-345 by making isolated workspaces the ordinary/default path. The structural program is proven:
workspace lifecycle, mutator and non-mutator Git access, merge/publication, verification, self-host refusal,
recovery, and fail-closed review behavior have shipped and passed the aggregate/live evidence walks. FG-621,
FG-628, and FG-636 are closed; the supported host is macOS under DEC-004.

The workspace contract is committed tracked content at the recorded base SHA plus inputs explicitly supplied
through Forge. Ambient uncommitted, untracked, or ignored checkout state is intentionally not inherited and is
not a default-on blocker. `FORGE_NO_WORKTREES=1` remains the explicit legacy escape hatch. Do not create a
generic carry-in system or another isolation child without a deterministic failure in a supported workflow.

After FG-345 closes, fix FG-623's measured 1 ms lease-test flake, then activate Change 0 from the confirmed
evidence-led review PRD so the interim operating policy governs the remaining build period.

## Now

1. **FG-345** — implement the default-on flip, verify the supported committed-tree workflow, record the final
   aggregate evidence, and close. FG-637 and registry-dependent probe availability are recorded follow-ups,
   not blockers absent a deterministic supported-workflow failure.
2. **FG-623** — remove the measured 1 ms live-clock knife-edge from the lease-renewal test after FG-345
   closes. This is a bounded test-reliability fix promoted under the required-CI interruption rule; do not
   fold it into FG-345 or expand it into a production clock redesign.
3. **Evidence-led review Change 0** — commit the confirmed
   `docs/prds/evidence-led-review-lifecycle.md`, decompose it into stable backlog work, then align the
   autonomous-run prompt and orchestrator seed with the interim one-discovery/batch-fix/recheck policy before
   ledger implementation begins.

## Next

1. **FG-608 — FG-496 Slice C:** make the DB backlog authoritative per project, migrate seam-bypassing
   readers, and provide containers the live read-only project-scoped backlog authority.
2. **Evidence-led review program — reserved position, decomposition pending:** the confirmed PRD is ready to
   be broken into implementation tickets; it is not itself an executable implementation brief. After
   decomposition, replace this placeholder with the stable ready ticket IDs and their dependency order before
   dispatching any Changes 1–3 work.
3. **FG-609 — FG-496 Slice D:** queue rank, membership, revision-bound readiness, blocker evidence, and
   event-history primitives.
4. **FG-610 — FG-496 Slice E:** atomic claims, leases, recovery, capacity accounting, and canonical
   claim-next.
5. Reconcile and close **FG-496** with its aggregate acceptance walk.

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
