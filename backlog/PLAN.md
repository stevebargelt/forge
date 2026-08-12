# Forge Working Plan

**Last revised:** 2026-08-10

This is a mutable statement of current operator intent. It is not an approval
boundary, ticket specification, execution record, or source of lifecycle
truth.

The DB-backed backlog is authoritative for ticket scope, acceptance criteria,
dependencies, and lifecycle state. Forge runtime state is authoritative for
what is running, blocked, or done. `backlog/notes.md` is a session handoff and
may lag this plan.

## Current objective: a stable v0.1.0 snapshot release

Forge's current product objective is to reach its first **stable, tagged, and
promoted snapshot release**. This is not a 1.0 claim and does not require every
open feature or follow-up to land. It is a coherent daily-driver checkpoint at
which:

- no major shipped product arc remains half-implemented;
- normal execution cannot silently report false completion or bypass its own
  validation and safety contracts;
- the dashboard surfaces the current state truthfully enough to operate Forge;
- the supported host verification path is trustworthy on Darwin as well as CI;
- the authoritative database has a tested backup and restore path;
- fresh setup, model routing, and operator-visible security boundaries are
  internally consistent; and
- one exact commit is verified, tagged `v0.1.0`, built as an immutable release,
  promoted, smoke-tested, and proven rollback-capable.

`package.json` already reports `0.1.0`, but there is no Git release tag and no
promoted stable release. The release train below defines the commit that earns
that existing version number.

## Recently completed

- **FG-681** (`66da74be` PR #237, `e7b011bd` PR #238) — the Darwin host
  integration tier agrees with CI: 86 distinct failures to 0, across six
  mechanisms, none of them a production defect. Host integration runs are
  trustworthy evidence again.
- **FG-693** (`7e05180f`, PR #236) — one canonical filesystem-identity contract
  across path boundaries; six private realpath-or-resolve copies removed.
- **FG-700** (`7b96b96a`, PR #235) — launch observations carry a declared
  purpose; only a launch explicitly marked `host_verification` renders as one.
- **FG-698** (`6ed18386`, PR #234) — release-fixture scratch use is bounded;
  peak temporary space fell from 4996 MiB to 1000 MiB without weakening the
  production thaw contract.
- **FG-690** (`1807ba1f`, PR #233) — agent runtime requires durable start
  evidence; failed pre-start container attempts no longer create false
  multi-hour executions in the runtime chart.

## Now

1. **FG-703 — durable orphan-incident adjudication.** Add the
   operator-authorized, audit-preserving way to retire an exact
   `orphaned_work_may_persist` incident as `no_unique_work`. Use it to resolve
   the four inspected historical incidents without retrying work or rewriting
   failed run history. Its FG-700 prerequisite has shipped, so this is the head
   of the queue.
2. **FG-663 — durable project identity for run history.** Persist the project
   when each run is created so normal disposable-clone cleanup cannot turn
   activity, usage, or runtime history into `Unknown repository`. Preserve
   checkout paths only as operational detail, never as the task's identity or
   display tag.

## Stable-release train

The ordering below is deliberate. It stabilizes the machinery used to prove the
rest of the release before closing the larger product arcs.

### 1. Make release evidence trustworthy

FG-693 → FG-681 completed this section's first item: filesystem identity has one
canonical contract, and the Darwin-host/CI integration divergence is closed and
remeasured against it. Host integration runs are usable release evidence again.

1. **FG-626** — stop `forge launch run` from silently dropping caller `FORGE_*`
   safety and behavior controls.
2. **FG-635** — a run cannot complete while a required workflow phase was never
   dispatched.
3. **FG-524** — finish validation-contract parity across workflow primaries,
   fanout implementers, and `forge invoke` completion seams.
4. **FG-630** — `request-changes` must carry the rejected artifact and its
   identity, so a revision does not silently reconstruct and shrink prior work.

### 2. Close release-facing safety and setup gaps

1. **FG-643** — sanitize every stored-Markdown rendering boundary before it
   reaches `dangerouslySetInnerHTML`.
2. **FG-634** — decide and enforce the durable credential/redaction boundary for
   readiness commands, stderr, and setup-child HOME access.
3. **FG-546** — fresh initialization must not install schema-invalid
   `docs-surfaces.yml`, and known generated-invalid copies must have a safe
   repair path.
4. **FG-560** — version and migrate model policy; an explicit workflow activity
   must never silently fall through to the wrong/default model.

### 3. Finish the partially landed core programs

1. **Close FG-593 now** after its required aggregate evidence walk. FG-496 and
   FG-591 have shipped; external ingestion is explicitly not a closure blocker.
2. **FG-527 → FG-477** — finish the lifecycle evaluator migration and remove the
   live duplicate lineage/settlement decisions. This is the clearest major
   subsystem currently left mid-migration.
3. **FG-385 + FG-386 → close FG-372** — complete deterministic risk-targeted
   review selection and the read-only operator surface for readiness and done
   evidence, then walk the Shipping Reviewer epic as one system.
4. **FG-395 → close FG-370** — land the read-only campaign dashboard and perform
   the aggregate sequential Campaign Runner walk. FG-396 parallel lanes remain
   a future extension and are not a closure blocker.
5. **FG-669 → FG-670** — ship and prove database backup/verify/restore, then
   remove Forge's frozen non-authoritative Markdown ticket corpus while retaining
   this plan and the session notes surface.

## v0.1.0 release gate

The snapshot is cut only when all of the following are true on one exact commit:

- FG-370, FG-372, FG-477, and FG-593 are closed on their aggregate evidence;
- every stable-release-train story above is closed with candidate-bound
  acceptance evidence;
- `forge ops check` reports no unresolved high-severity incidents for Forge;
- required CI is green at the exact release commit;
- the unit, worktree, extended, and Darwin integration evidence required by the
  affected contracts is green and contains no unexplained host/CI split;
- a representative `forge backup create → verify → restore` round trip succeeds;
- an immutable release builds and promotes, `forge doctor` is healthy, and
  rollback to the previous selection is proven;
- one bounded Claude orchestrator smoke and one bounded Codex orchestrator smoke
  run through the promoted release without mutating credentials or billing a
  production-sized task;
- dashboard smoke verifies current activity, campaign visibility, and reviewer
  evidence against durable state; and
- the verified commit is tagged `v0.1.0` and recorded as the promoted snapshot.

The four currently reported high-severity `orphaned_work_may_persist` incidents
have been inspected and contain no unique work. FG-703 owns their durable,
auditable adjudication. They must be resolved through that supported lifecycle,
not hidden or rewritten, before the release gate passes.

## Explicitly after v0.1.0

The following work remains legitimate but does not block this snapshot unless it
becomes a deterministic blocker under the interruption policy.

### New product capability

- **FG-346, FG-348, FG-349, FG-396, FG-402, FG-446, FG-447, FG-456** — model
  setup UX, richer dashboard/control-plane views, parallel campaigns, attention
  inbox, prefix UX, and unattended autonomous queue control.

### Automated cleanup

- **FG-590, FG-677** — terminal tmux/container retirement and automatic
  terminal-run workspace/branch cleanup. Manual conservative cleanup remains
  acceptable for the snapshot; automation must not be rushed into the release
  train.

### Review, recovery, and assurance residue

- **FG-478, FG-599, FG-600, FG-602, FG-625, FG-629, FG-652, FG-656, FG-658,
  FG-667, FG-682, FG-687, FG-696, FG-697** — future fanout recovery, continuation
  evidence/arming, routing-policy absence, diagnostics and retry gaps, review
  bookkeeping, generation consistency, validator refinements, bounded late-docs
  amendment, assurance overrides, and the explicitly bounded local TOCTOU
  question.

### Optimization, organization, and bounded polish

- **FG-380, FG-543, FG-545, FG-547, FG-550, FG-588, FG-641, FG-692, FG-699** —
  host-local handoff state, release-check/CI efficiency, handoff and orientation
  cost, test organization, queue/UI polish, and the one-round-trip runtime-panel
  stale-display correction.
- **FG-701, FG-702, FG-704, FG-705** — measurement-script correctness, a
  group-signalling hang bound, the CI shard headroom policy, and the dashboard
  cold-path bound proof. FG-704 carries FG-681's fresh measurement:
  `integration_1` at 6m46s against a 10-minute ceiling, roughly 32% headroom
  and comfortably wider than the ~35s of observed run-to-run variance. It is
  not blocking CI or release correctness, so it does not preempt the train.

Deferral here is a release decision, not a claim that the tickets are invalid.
If one demonstrates data loss, credential exposure, false publication, fake
verification, or a deterministic blocker to the release train, it is promoted
under the policy below.

## Interruption policy

An item may move ahead of `Now` or the stable-release train only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss, security, credential, or wrong-publication risk;
- a deterministic defect blocking the current release item;
- a required test tier that does not execute or cannot produce trustworthy
  evidence.

A newly discovered hardening opportunity is recorded in the DB backlog but does
not automatically become the next task. Do not open speculative follow-up
tickets for limitations that fail loudly, already belong to a parent ticket, or
have no demonstrated impact.

## Execution rules

- Start implementation from current `main` in an isolated disposable clone or
  Forge-owned task workspace, never by editing the live checkout.
- Keep implementation scope bound to the selected ticket. Findings outside its
  acceptance contract are dispositioned and tracked; they do not silently widen
  the current change.
- Use the dependency-aware ordered build plan where steps consume sibling
  outputs. File disjointness alone is not independence.
- Evidence-led review runs once: one discovery pass, at most one remediation
  batch, and one recheck. An unmet ticket acceptance criterion remains work on
  that ticket; unrelated new scope becomes an explicit disposition/follow-up.
- The review coordinator owns candidate movement during a review. While FG-682
  remains open, reconcile known documentation before starting review and surface
  a genuinely late correction as an explicit operator decision rather than an
  unrecorded commit.
- Merge only when required CI is green at the actual PR head.
- Close shipped tickets with acceptance evidence from the merged candidate.
- A dirty or untracked operator file in the live checkout is not part of an
  implementation candidate unless the operator explicitly places it in scope.

## Plan maintenance and retirement

- Keep `Now` to one product objective and keep the release train dependency
  ordered; runtime progress belongs in Forge, not this file.
- Keep `Recently completed` to the latest one or two shipped items. Git and the
  DB backlog are the durable history.
- Update this file when operator sequencing or the release boundary changes. Do
  not preserve shipped work as current intent.
- Link ticket IDs instead of copying their acceptance criteria.
- Keep this plan through the `v0.1.0` release because it records the release
  rationale, interruption policy, and execution rules that the queue itself does
  not express.
- After the snapshot is tagged and promoted, explicitly decide whether this
  prose moves to a durable operator-policy surface or remains as the small
  sequencing layer above the DB queue. Do not retire it merely because FG-591
  shipped.
