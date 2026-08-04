# Forge Working Plan

**Last revised:** 2026-08-04

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

- **FG-609, FG-673, FG-674** — FG-496 Slice D queue primitives shipped
  (`de6c6d62`); the dashboard agent-runtime fixture is deterministic
  (`119043a4`); and a review's comparison base now resolves by the first rule
  that applies and names which one (`bdd94753`). FG-674 was reviewed against an
  explicitly supplied base, because the defect it fixes was live in the forge
  performing that review.

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
- **FG-648** (`c866b103`, PR #195) — shipped the dashboard agent-runtime trends,
  then REOPENED the same day: AC5 was recorded met on evidence that covered how
  the chart's text looks but never that the chart can be read. See `Now`.
- **FG-662** (`9f257828`, PR #196) — agent runtime now derives from the agent's
  own exit rather than a terminal timestamp a sweep rewrote. Closed with an
  explicit operator override recorded, NOT a mechanically settled ledger; the
  override's cause is FG-664 below.
- **FG-664** (`994f8cac`, PR #197; docs `dcc2f630`) — read-only reviewers now
  resolve their dependency environment host-side through one shared resolver,
  mount the cache read-only, and never install; a lane that cannot load the real
  driver is refused pre-container as `blocked_environment`. The rechecker runs
  the shipping database engine. This clears the gate that FG-609 and FG-610 were
  held behind.
- **FG-666** (`3d00e459`, PR #198) — a clone-dispatched pipeline task now resolves
  backlog authority from the project directory recorded on the RUN, not from the
  disposable per-task clone mounted at `/project`. Agents can read their own
  ticket again: a clone-dispatched architect on merged `main` resolves
  `mode: db` with the correct `project_key` and `forge backlog show` exits 0.
  The ticket was widened during implementation and NARROWED BACK by operator
  scope correction — the pre-container refusal, failure-kind retry taxonomy and
  snapshot compensation/reclamation lifecycle were removed rather than deferred,
  taking the diff from 2485 insertions to 759.

## Now

1. **FG-648 — reopened for AC5.** Two legibility failures the operator found on
   live data: the chart has no y-axis, scale or unit (its SVG carries only a
   peak annotation and the date labels), and bare date labels on a UTC grid are
   misread in a non-UTC timezone. New AC8-11. The UTC-aligned grid itself stays.
   Moved ahead of FG-609 by operator decision (2026-08-03).

## Next

1. **FG-678 — writable-invoke dependency contract.** Operator-placed AHEAD of
   feature work that relies on writable validator dispatches (2026-08-04). A
   writable `forge invoke` gets an empty anonymous `node_modules` shadow that
   also masks the host's, so a required `test-engineer` followup may silently
   not execute — measured twice, with identical dispatches producing opposite
   outcomes. Until it lands, any feature whose acceptance rests on writable
   validation is resting on an environment that is not guaranteed to exist.
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
