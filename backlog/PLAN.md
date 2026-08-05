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

Run the operator-sequenced series FG-676 → FG-679 → FG-610 (sequencing recorded
2026-08-05). Each item starts only after the preceding one is merged, closed
with acceptance evidence, and the live checkout is synchronized to current
`main`. **FG-680 and FG-676 have both shipped**; the series resumes at FG-679.

Both bounded safety prerequisites are now closed, so what remains is product
feature work. Everything in review-infrastructure stays non-preempting.

**FG-655 is now a measured tax, not a theoretical one.** Its docs stage stranded
correct, uncommitted work on BOTH shipped tickets this session — FG-680's
`how-to-testing` section and FG-676's ADR writer-name correction — and each
survived only because the tree was inspected by hand before verification. Each
also dirtied the tree, which blocked CI-evidence reuse and forced a local
verification. It is still non-preempting under the operator sequence, but it
should be reconsidered for promotion once FG-610 lands.

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
- **FG-648** (`c866b103`, PR #195) — shipped the dashboard agent-runtime trends;
  reopened the same day over AC5 (evidence covered how the chart's text looks,
  never that the chart can be read) and since CLOSED.
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
- **FG-671** — `reclaimReleasedTargets` no longer deletes bytes of an
  unknown-liveness target on age-out.
- **FG-676** (`6fbd1481`, PR #209) — publication reconcile no longer resurrects a
  gate-failed task, so a `request-changes` no longer leaves a phantom blocker
  that makes an otherwise-recoverable run unrecoverable. The fix this ticket
  ORIGINALLY prescribed does not work and the architect proved it: the reconcile
  path launders `failed` to `awaiting_recovery` immediately before
  `finalizePrimary`, so the compare-and-set writer's guard passes and the
  resurrection proceeds anyway. The authoritative fix is the reconcile SELECTION
  predicate — a terminal state a human CHOSE is not damage to repair — placed
  BEFORE the laundering write. `markTaskAwaitingGate` is deleted rather than
  bypassed, and `setTaskStatus` is compare-and-set too (it could launder a
  terminal row via `awaiting_red`). `forge ops check` / `forge ops repair` add an
  operator-invoked, dry-runnable repair for already-corrupted rows, since the
  corruption is forward-only and no future sweep revisits it. Clean 8/8 shipping
  review, no overrides. Two corrections recorded on the ticket: its cited
  phantom evidence is stale (the store now has ZERO `awaiting_gate` rows, so the
  reserved dogfood had nothing to demonstrate on), and BD-11 was withdrawn as
  disproven after being wrongly recorded as a must-fix.
- **FG-680** (`dc91e93f`, PR #207) — the test harness can no longer kill the
  operator's tmux server. `src/test-setup.ts` relocated `TMUX_TMPDIR` but never
  deleted `TMUX`, and a tmux client given neither `-L` nor `-S` resolves its
  socket from `$TMUX` FIRST — so inside a launch pane the exit hook's bare
  `kill-server` destroyed the shared server. Blast radius was wider than the
  exit hook (two FG-614 teardowns and `launch.ts`'s own exec all spread
  `process.env`); one deletion fixes them all. Shipped a clean 8/8 shipping
  review with NO overrides. Two vacuity traps were closed on the way: with
  `TMUX` set a bare client never creates the `TMUX_TMPDIR` socket dir, so the
  exit hook's `readdirSync` guard skips `kill-server` and a naive test passes
  against an unfixed harness (the tests use `-L default` instead); and the
  real-CLI test originally asserted only that the sentinel server SURVIVED,
  true in both arms — review finding RF-1 — now corrected to assert WHERE the
  session landed.
- **FG-678** (`39380bb1`, PR #206) — the writable-dispatch dependency contract.
  All three dispatch shapes now cross ONE shared resolver: a three-way
  discriminator (no declared dependencies → not applicable; declared + supported
  lockfile → resolve; declared WITHOUT one → refuse pre-container as
  `lockfile_absent`), the mount planner re-keyed off worktree-ness onto the
  resolved environment, an agent's self-declared `status: failed` honoured at the
  invoke ingestion seam under the new `agent_reported_failure` kind, and the
  dependency receipt recorded for every lane. The review found the DEFAULT
  pipeline lane still exempt; the operator ruled it in scope (BD-3 defines one
  rule by project STATE, not per lane) and one batch fix collapsed all three
  lanes. **Merged with `tip_equality` and `docs_closeout` recorded as explicit
  OVERRIDES, not passes** (BD-13, scoped to that candidate only) — six of eight
  shipping checks were genuinely green, including `acceptance_mapped` and
  `fix_now_resolved` on executed evidence. Do not read it as a clean 8/8. Its
  pipeline run is deliberately `abandoned`, not complete.
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

1. **FG-679 — dashboard: surface in-flight host verification and PR checks.**
   The next substantive FEATURE. Non-task work is invisible to the dashboard, so
   a run with verification running reads as idle. Demonstrated 2026-08-04:
   `/api/in-flight` returned only an FG-676 phantom `awaiting_gate` row while
   `test:worktree` was actively running under a launch — the card said "waiting
   on a plan gate" when the truth was "verification running, no gate
   outstanding". Both data sources already exist and are durable
   (`forge launch list/show` plus `host_verifications`; `probeCiGateStatus` for
   exact-SHA required checks), so this is a projection gap, not instrumentation.
   **Amended 2026-08-05 with explicit acceptance criteria and eleven binding
   decisions (BD-1…BD-11)** — one `Current activity` surface with distinct
   Agents / Host verification / Required CI sections; association from
   submission-time structured metadata only, never from launch names, argv or
   log text; the launch status vocabulary preserved exactly; CI observations
   bound to an exact candidate sha with old-sha evidence disappearing on
   candidate change; no GitHub/shell/git/CLI call from the dashboard's serving
   or polling path; `/status` and the dashboard must agree. Those are settled
   inputs — an implementer who disagrees stops and reports.
## Next

1. **FG-610 — FG-496 Slice E:** atomic claims, leases, recovery, capacity
   accounting, and canonical claim-next. Unblocked: it was held behind FG-678
   because its concurrency guarantees need host stress-loops on the writable
   dispatch path, which is now deterministic. Starts only after FG-676 and
   FG-679 ship cleanly; builds on the FG-609 primitives without inventing a
   second rank, readiness, blocker or lifecycle vocabulary; concurrency-critical
   throughout, so transaction-level tests PLUS a repeated host stress loop are
   required — a single green execution is not evidence.
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
- Required documentation is committed before review while FG-655 remains open.
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
- Update this file when operator sequencing changes; do not preserve stale
  priorities as if they were current.
- Link ticket IDs instead of copying full acceptance criteria.
- Do not duplicate live run state or record progress percentages here.
- Retire this file only when FG-496/FG-591 provide the authoritative priority
  queue and operator controls that replace it.
