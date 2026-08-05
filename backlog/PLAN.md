# Forge Working Plan

**Last revised:** 2026-08-05

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

**FG-584 comes before FG-591.** FG-610 demonstrated FG-584 live: the runner
fanned both plan steps in parallel even though the plan declared step 2
sequenced after step 1, so the docs child correctly self-failed rather than
document a schema that was not committed yet. File-disjointness does not make
semantically dependent children executable: each starts from the same committed
base, so consumers cannot see a primitive another child creates and composition
tests cannot see the behavior they are meant to verify.

FG-584 is not a new scheduler design. It completes the Gas City-aligned
controller / durable-work / Refinery contract that FG-116 and FG-139 claimed:
plan-step dependencies are durable work dependencies; the controller dispatches
only ready work; mutating workers use private writable workspaces; completed
worker commits enter Forge's deterministic integration publisher; and dependent
work starts from the candidate containing its integrated prerequisites. Merge
conflicts are visible integration outcomes, not a reason to collapse every
dependent plan into one worker.

Until FG-584 lands, collapsing dependent implementation steps is the safe
workaround, explicitly not the target architecture. Everything in
review-infrastructure stays non-preempting.

## Recently completed

- **FG-610** (`6b01d3c5`, PR #215) — shipped the FG-496 Slice E claim,
  lease, recovery and capacity-accounting primitives.
- **FG-655** (`c93e13af`, PR #213; docs follow-up `389eb744`, PR #214) —
  documentation stages now commit their declared paths and advance the review
  candidate.

## Now

1. **FG-584 — semantic dependencies in feature build fanout:** complete the
   unfinished FG-116/FG-139 Gas City-aligned controller contract. Durable
   dependency edges control readiness; dependent workers start from the
   integrated prerequisite candidate; independent ready work remains parallel;
   and merge conflicts are typed integration outcomes.

## Next

1. **FG-591 — operator work queue:** Kanban, CLI/API controls, and
   capacity-limited dispatch over the queue primitives.
2. **FG-496 aggregate closeout:** reconcile the DB-backed backlog program
   against its acceptance criteria after FG-609, FG-610, and FG-591 ship.
3. **FG-576 — provider-neutral interactive orchestrator launcher:** resolve
   Claude or Codex from model policy after the operator queue program closes.

`Next` is deliberately short. Ordering here expresses current operator intent;
it does not override ticket dependencies or authorize scope expansion.

## Captured follow-ups that do not preempt `Now`

- **FG-652** — stage-record SHA in the crash-after-advance recovery window.
- ~~**FG-655** — documentation-stage commit authority.~~ SHIPPED 2026-08-05
  (`c93e13af`). The docs stage now commits its declared paths itself and advances
  the candidate to the sha it authored, so the workaround this entry carried —
  commit required durable docs before review — is no longer needed.
- **FG-682** — a documentation correction discovered AFTER the docs stage has
  completed has no supported amendment path. Adjacent to FG-655 but distinct:
  FG-655 is a stage that produced edits and could not commit them; this is a
  correction that arrives once no stage remains to carry it. Scoped as a bounded
  late-docs amendment (declared documentation paths only; code/tests/config and
  undeclared dirty files refused by name; the COORDINATOR commits and advances
  the candidate; SHA-bound verification invalidated and CI required at the new
  candidate; docs closeout plus a bounded delta check, never full re-discovery).
  FG-678's two overrides are its demonstrated impact.
- **FG-681** — five campaign integration tests (FG-475/FG-476/FG-485) fail
  reproducibly on the host and pass in CI at the same commit, so host
  integration runs produce false reds. Not caused by any current change:
  identical 5/7 on `main` and on the FG-678 branch via an equivalent runner.
  Carries a hypothesis worth checking BEFORE FG-676 is fixed — the failing
  assertion is `expected 'awaiting_gate', actual 'failed'`, the same state pair
  FG-676 resurrects, so these may be green in CI for the wrong reason.
- **FG-656** — fanout model resolution can drift from the held seed
  generation.
- **FG-657** — reconcile and close the DB ticket for the already-shipped PR
  #191 implementation.
- **FG-658** — test evidence annotated with a source filename is not matched.
- **FG-659** — guard the remaining `lens_outcomes_json` writer and correct a
  stale source comment.
- **FG-545** — add a docs/research-only CI fast path while preserving
  exact-head required checks.
- **FG-661** — FG-648 review residue: the WCAG contrast test asserts the peak
  label twice and never an axis label, and a read that fails after a successful
  load leaves a frozen chart with no staleness signal.
- **FG-663** — runs lose their repository identity when a checkout is deleted,
  orphaning 8.4% of task history as "Unknown repository". The durable project
  identity is the key and the tag; `.forge/config.yml`'s git-tracked
  `project_key` already survives cloning and is the preferred source.
- **FG-665** — the FG-662 attempt-scoping bound drops an unparseable audit
  timestamp, which on a sole administrative marker re-admits the artifact.
  Deliberately kept deferred (operator instruction, 2026-08-02).
- **FG-667** — FG-664 residue: the probe's platform filter prunes a multi-arch
  prebuilds directory, permanently refusing a correct cache; plus a stale
  review-wiring comment.
- **FG-672** — the review evidence validator scores a deliberate mutation
  failure as a candidate failure, so mutation-proven resolution evidence is
  refused. Third false-negative shape after FG-657 and FG-658, and the first to
  force an operator gate override on a merged ticket (FG-666). Deterministic
  repro on `task-review-rechecker-fc4801`.
- **FG-668** — the `fg664-recheck-replay` harness hardcodes the default review
  id in its `in_place` evidence block and pins `REPLAY_REFS` to RF-1/RF-3/RF-4,
  so `--candidate` does not generalize. FG-664's AC4 proof is reproducible only
  once this lands.

These remain real work. They move ahead only under the interruption policy
below, not because they are adjacent to recently completed review work.
FG-663, FG-665, FG-667 and FG-668 are explicitly non-preempting residue
(operator instruction, 2026-08-03) unless one becomes a deterministic blocker
under the policy below. FG-664 was promoted out of this set on 2026-08-02 and
has since shipped.

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
- The docs stage commits its own declared paths (FG-655, shipped `c93e13af`), so
  required documentation no longer has to be committed before review. It still
  must be DECLARED: the coordinator commits exactly the paths the agent lists in
  `docs_updated`, an undeclared path is a named refusal rather than a silent
  sweep, and a `docs_updated` that is missing, non-array, or carrying a
  non-string member is a contract violation, never a claim that nothing changed.
- The review coordinator owns candidate movement for ANY commit during a review,
  not only a fixer's output. While FG-682 remains open there is no supported way
  to amend a documentation correction found after the docs stage: committing it
  by hand pins the candidate behind the branch tip and fails both `tip_equality`
  and `docs_closeout`. Reconcile durable docs BEFORE the review where possible,
  and if a correction is found late, surface it as an explicit override decision
  rather than an ad-hoc commit.
- Merge only when required CI is green at the actual PR head.
- Close shipped tickets with acceptance-criteria evidence from the merged
  candidate.
- A dirty or untracked operator file in the live checkout is not part of an
  implementation candidate unless the operator explicitly places it in scope.

## Maintenance rules

- Keep `Now` to one product objective and `Next` to roughly five items.
- Keep `Recently completed` to the latest one or two shipped items; Git and the
  DB backlog are the durable history.
- Update this file when operator sequencing changes; do not preserve stale
  priorities as if they were current.
- Link ticket IDs instead of copying full acceptance criteria.
- Do not duplicate live run state or record progress percentages here.
- Retire this file only when FG-496/FG-591 provide the authoritative priority
  queue and operator controls that replace it.
