# Forge Working Plan

**Last revised:** 2026-07-27

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

The foundation is shipped: lifecycle and state (FG-351), merge/integration mechanics (FG-352/FG-353),
persistence and red semantics (FG-354/FG-355), the candidate integration gate and serialized publisher
(FG-357/FG-425), dependency parity (FG-376), read-only Git for non-mutators (FG-559), self-host refusal
(FG-612), fail-safe linked-worktree recovery (FG-356), **private writable Git for mutators (FG-621, #164)**
and **isolated-workspace dependency mountpoints (FG-627, #165)**. Do not reopen those decisions or create
replacement tickets without evidence of a reachable gap.

**What changed on 2026-07-27.** FG-621 landed and the first real end-to-end isolated dispatch was run. The
substrate itself works — a mutating task receives a private clone at a recorded base SHA, the parent repo
is provably unwritable from the container, and the agent's commit is captured by the host. What the
dogfood exposed is that the *verification paths around* isolation had never been exercised, and three
separate defects fell out of one run: FG-626, FG-627 (fixed same day), and the integration-gate half of
FG-566. The correction to carry forward is that isolation was never "nearly ready"; only its substrate was.

## Now

1. **FG-566** — the shared readiness contract for all Forge-owned host-side verification, with two
   consumers: the review-loop local fallback, and FG-357/FG-425 integration-gate verification against the
   exact publication candidate worktree. **Promoted under the interruption policy** as a defect blocking
   the current objective: it was expanded on evidence when the dogfood's integration gate failed
   `ERR_MODULE_NOT_FOUND` against a candidate worktree with no dependencies and recorded the result as
   `integration_failed` — an environment fault reported as a verdict on the reviewed code.
2. **FG-621 AC 11** — the only criterion still open; everything else shipped in #164, and AC 2's live
   container evidence is captured. It closes on a dogfood run, which is blocked on FG-566. FG-566 work and
   the dogfood run in the disposable clone, never the live checkout.
3. Walk FG-345's aggregate acceptance proof against the implementation that actually exists. Count
   FG-357/FG-425 as the integration/publication solution, FG-351 as the non-Git/dirty/carry-in contract,
   and FG-353/FG-355 as the red-timing decision. Do not file another child for a requirement already
   proven.
4. Decide the platform question before default-on: FG-621 inherits the Linux hard-fail, so its evidence is
   macOS-only. Either adopt a macOS-first default or lift the gate; each carries its own test burden, and
   FG-621 alone does not justify a universal flip.
5. Close FG-345 only after the default-on run proves mutators, non-mutators, candidate validation,
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

- **FG-626** — `forge launch run` does not propagate the caller's environment, so every `FORGE_*` gate is
  inert under the launch pattern the orchestrator template mandates. Real and operator-facing, but it has
  a working escape (`forge launch run -- env VAR=… <cmd>`), so it is captured rather than promoted. Note
  the only reason it surfaced is that FG-612 independently refused the dispatch; a safety gate the
  operator believes is armed and is not is the worst shape this can take, so promote it if it recurs
  anywhere that guard does not cover.
- FG-597, FG-598, FG-599, FG-600, FG-601, FG-602, and FG-604 follow-up hardening, unless promoted by the
  interruption policy.
- FG-623 and FG-625 do not move ahead of the FG-345 closeout unless one becomes a demonstrated blocker or
  required-CI failure. (FG-566 was in this set and has been promoted on evidence.)
- Further worktree/isolation hardening after FG-345, unless the aggregate proof exposes a reachable gap.
- Broad lifecycle-evaluator, provider-adapter, and workflow-semantics programs.
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
