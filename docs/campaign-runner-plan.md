# Campaign Runner Shipping Plan

This document tracks the deliverables required before Forge can truthfully claim Campaign Runner is shipped.

The goal is not just "run a list." A shipped Campaign Runner must be durable, inspectable, resumable, and honest about blocked work.

## Shipped Bar

Campaign Runner is shipped when an operator can give Forge an explicit ordered list or an epic, approve the generated plan, and trust Forge to work the campaign with durable state, conservative continuation rules, and a truthful campaign report.

Minimum shipped behavior:

- plan from explicit ticket lists and structured epic children;
- compute a stable `plan_hash` from canonical plan content;
- record approval of the exact `plan_hash` before execution;
- reject stale starts when the current resolved plan hash differs from the approved hash;
- execute sequentially by default;
- preserve durable campaign and campaign-item state across restart;
- reuse Forge run/task lifecycle vocabulary for item status where practical;
- store campaign-specific meaning as outcome, blocker kind, continue policy, reason, and requested human action;
- pause or hold when blockers may affect later work;
- continue only when later work is independent or explicitly allowed by campaign mode;
- require the normal per-item quality gates before any shipped claim;
- produce human and JSON campaign reports;
- expose enough dashboard state that a human can understand overnight work without running CLI commands.

## Delivery Phases

### Phase 0: Backlog Integrity Prerequisites — complete

These must be fixed before trusting campaign automation to mutate backlog state repeatedly.

- **FG-389**: remove legacy `BACKLOG.md` support.
- **FG-397**: make structured backlog close/move atomic.
- **FG-398**: make file-backed ticket id generation safe under concurrent writers.
- **FG-399**: record `forge backlog close --commit <sha>` in structured tickets.
- **FG-403**: `listTickets` scans all structured dirs and filters by frontmatter, surfacing partial-move state and ghost duplicates on every read path (reinforces the no-partial-state criterion on the read side).
- **FG-404**: `backlog file --type epic|idea` success message prints the actual destination dir instead of a hardcoded path.

Exit criteria:

- structured backlog is the only active backlog model;
- close/move operations cannot leave partial state;
- concurrent ticket creation cannot reuse an id;
- ticket close audit metadata is not silently dropped;
- tests cover the integrity failure modes.

### Phase 1: Plan-Only Campaigns — complete

Plan-only mode should be useful before execution exists.

- **FG-390**: durable campaign and campaign-item model.
- **FG-391**: campaign planner for explicit lists and epic expansion.

Exit criteria:

- `dry_run` campaign mode exists;
- explicit ordered lists resolve deterministically;
- epic children expand from structured metadata;
- planner preserves operator order unless it records a recommended reorder with a reason;
- canonical plan content and `plan_hash` are recorded;
- plan approval metadata can be recorded against an exact `plan_hash`, but execution is not required yet;
- missing, blocked, empty, or ambiguous inputs fail loudly.

### Phase 2: Sequential Execution MVP — complete

This is the first useful overnight slice, but it should remain conservative.

- **FG-392**: execute approved campaign items one at a time.
- **FG-393**: blocker and continue semantics.
- **FG-394**: CLI status, report, pause, resume, and abandon.

Exit criteria:

- campaigns cannot start without an approved `plan_hash`;
- campaign start confirms the current `plan_hash` matches the approved `plan_hash`;
- stale plans require re-plan/re-approval instead of silently executing drifted work;
- exactly one campaign item runs at a time;
- each item records run id, lifecycle status, outcome, blocker kind, continue policy, and requested human action;
- failed or blocked items do not erase evidence;
- later items continue only when the blocker is local or continuation was explicitly approved by mode;
- shared infrastructure, backlog, git, auth, dependency, test harness, campaign-system, and merge-state failures hold the campaign;
- a checkpoint or final Campaign Report is available in human and JSON form.

### Phase 3: Quality Gate Integration — complete

Campaigns should not make "done" claims that individual Forge runs could not defend.

Dependencies:

- **FG-382**: readiness preflight for backlog items.
- **FG-383**: done-audit mechanical closeout checks.
- **FG-384**: Shipping Reviewer workflow integration.
- **FG-388**: documentation/contract follow-up to FG-384; covers:
  - Reviewer Context Packet contract documentation
  - Shipping Reviewer rich verdict vocabulary
  - Shipping Reviewer fail-loud / missing-context precondition
  - `doneAudit` evidence in the packet
- **FG-423**: campaign items execute the configured workflow (default: `feature`) through the full run/gate machinery instead of a hardcoded single-agent invoke; execution mode is recorded per-item in `canonicalContent`/`plan_hash`; the campaign drives workflow runs via `runNext`, auto-advancing `gate:auto` and `gate:verdict` steps, parking at `gate:human` or failing/inconclusive verdicts (`awaiting_gate` / `blocked_by_red`); `outcome: shipped` is gated on both a passing authoritative reviewer verdict and a passing done-audit; the report links each item to its workflow run, tasks, and verdict summaries.
- **FG-418**: wire the Shipping Reviewer into the default `feature` workflow (advisory: `authority: specialist`, `gate_on_verdict: false`) and fix the Reviewer Context Packet so the reviewer receives real engineer evidence (changed files, commit, verification commands, deferred scope, engineer summary) at review time; for the fanout build phase, evidence is aggregated from fanout child tasks.
- **FG-419**: host-verification recorder for done-audit; records durable required-gate evidence, matches it by ticket, project, shipped commit, and gate, and keeps missing, stale, failed, or supporting-only host evidence conservative.
- **FG-420**: promote the Shipping Reviewer from advisory to authoritative in the default `feature` workflow once FG-418/FG-419/FG-367 evidence is real; `needs_fix` blocks, `needs_human` requires explicit human handling, valid named deferrals can pass, and failing/unknown done-audit blocks unless an accepted exception is recorded.
- **FG-367**: git-evidence surfacing for Forge-managed projects: `branch` and `worktreePath` recorded on campaign report items when a Forge-managed worktree is used (naming scheme `forge/{runId}/{taskId}`); `pushed` correctly resolves to unknown (not fail) when no remote is configured; no auto-push or auto-PR in v1. Policy documented in [Git discipline (v1)](concepts.md#git-discipline-v1).
- **FG-376**: agent worktree dependency parity for real test execution.
- **FG-357**: post-merge integration gate — after a worktree merge lands (single-step merge-to-HEAD, FG-352, or fan-out integration-branch merge-to-HEAD, FG-353), forge runs the project's own `test:unit` script against the merged tree on the host before the step is done; a project with no `test:unit` script is skipped rather than blocked. Failure is a new terminal `failure_kind` (distinct from `merge_conflict`, merged worktree/branch retained for inspection). Default 10-minute timeout, overridable via `FORGE_INTEGRATION_GATE_TIMEOUT_MS`. **FG-424** split that single `integration_failed` kind into three: `integration_failed` (a genuine test-suite failure, non-retryable, scoped to the item) vs. `integration_gate_timeout` (retryable) and `integration_gate_crashed` (non-retryable, needs toolchain/cache inspection) for a gate run that itself timed out or was killed by signal — both infra kinds pause the whole campaign as SHARED rather than scoping to one item. Documented in [Post-merge integration gate](concepts.md#post-merge-integration-gate).

Exit criteria:

- readiness is checked before starting each campaign item;
- done audit runs before item shipped claims;
- Shipping Reviewer has the original ask, backlog context, implementation summary, verification commands, review history, done-audit evidence, and authoritative blocking authority in the default `feature` workflow;
- Reviewer Context Packet shape, Shipping Reviewer verdict vocabulary, done-audit evidence, and fail-loud missing-context behavior are documented;
- host verification requirements are explicit, recorded as durable required-gate evidence, and visible in reports;
- missing, stale, failed, or supporting-only host evidence cannot satisfy shipped claims;
- git/branch/PR policy is visible in the report;
- unavailable gates force `pilot` mode, pause, or explicit operator override.

### Phase 4: Dashboard Visibility

The CLI can bootstrap the feature, but shipped Campaign Runner needs human-visible state.

- **FG-395**: dashboard campaign view.

Exit criteria:

- dashboard lists active and recent campaigns;
- campaign detail shows current item, blockers, outcomes, runs, tasks, tickets, branches, worktrees, PRs, and report checkpoints;
- dashboard uses the same JSON/report contract as CLI;
- dashboard does not require project-tracked file writes to show state.

Related follow-on: **FG-433** — campaign-created feature runs should populate `run.metadata.ticketId`/`campaignId`/`itemId` so the Shipping Reviewer can run ticket-aware acceptance preflight; useful groundwork for richer dashboard/report linkage.

### Phase 5: Parallel Campaigns

Parallel execution is explicitly later work.

- **FG-396**: parallel campaign lanes and merge/refinery behavior.

Exit criteria:

- parallelism is opt-in or evidence-driven, not default;
- each lane runs in isolated branch/worktree state;
- merge/refinery order is explicit;
- conflicts retain evidence and do not discard work;
- integrated output passes post-merge validation before campaign-level success;
- campaign reports explain what ran in parallel and how it was integrated.

Prerequisites already filed: **FG-410** (`updateCampaignItem`'s read-merge-write is lost-update-unsafe under concurrent writers and must land before parallel lanes go live) and **FG-424**/**FG-425**/**FG-426** sharpen the shared gate/lock surface that parallel lanes will contend on — **FG-424** (post-merge integration gate distinguishes real test failures from infra/platform failures) and **FG-426** (classify `integration_failed` as a scoped item blocker) have landed; **FG-425** (scope gate locking per `projectDir`) is still open.

### Phase 6: Campaign Completion & Reconciliation Honesty

Dogfooding a campaign end-to-end (campaign-922c83b7c577) surfaced a cluster of reconciliation and completion gaps this plan did not anticipate. That campaign is deliberately preserved in a paused state as the live evidence case (left unmutated even after FG-443 shipped, so the original gap remains inspectable): FG-357 only reconciled after recognizing a force-advanced gate and a later authoritative pass superseded a stale historical red-fail; FG-376 was only reconcilable after a MANUAL `forge record-host-verification` call because force-advanced/manually-driven items get no automatic post-merge host-verification; and FG-422 — correctly re-routed to a documentation-authoring lane and genuinely shipped — is stuck at `awaiting_gate` with no clean path to `complete` other than `abandon` in that specific (frozen) campaign, a gap that `forge campaign reconcile`'s out-of-band path (see [Reconcile](concepts.md#reconcile)) now closes for any campaign going forward.

- **FG-427** — delivered: campaign reconciliation now honors a recorded force-advance or later authoritative pass instead of aggregating stale historical red-fails forever. A single shared evaluator (`evaluateAuthoritativeOutcome` in `reconcile-evidence.ts`) resolves the effective-latest-state PER REVIEWING TASK — a later authoritative pass, or a qualifying force-advance (`decision: advance`, `force: true`, non-empty rationale), supersedes an earlier authoritative fail on that same task — and is used by both the drive path (`reconcileTerminalOutcome`) and `forge campaign reconcile`'s shape-1 evidence (Fact 5), so the two paths cannot drift. A force-advance never substitutes for authoritative review on a task with no verdict at all, and an unresolved fail on any task still blocks. Underpins FG-440/FG-441. Documented in [Reconcile](concepts.md#reconcile).
- **FG-440** — delivered: forge-observed merges (campaign-driven, or force-advanced then merged through forge) got no post-merge host-verification, so evidence-gated reconcile refused a legitimately merged-and-green item. `forge campaign reconcile` now runs the required host gate for real, in `projectDir` at its current HEAD, and records the actual result before evaluating shape-1 evidence — a skip (missing script, dirty tree, off-branch HEAD) never fabricates a pass, and `gate_name`/`command` are always the configured `requiredHostGate` string, never the executed argv, closing the FG-419 gate_name spoofing vector for this path. The `host_verification_missing_or_not_all_exit_zero` code is now split into `host_verification_not_recorded` and `host_verification_recorded_but_failed`, rendered distinctly on `reconcile`'s human output and via a new `host-verification-status:` line on `show`/`report`. Fully-external merges with zero forge involvement remain out of scope. Documented in [Reconcile](concepts.md#reconcile).
- **FG-441** — delivered: `forge campaign resume` no longer re-parks a manually-driven `awaiting_gate` item (no `blockerKind`, has a `runId`) forever. Before re-parking, resume now evidence-reconciles it against the same shape-1 evaluator `forge campaign reconcile` uses (`collectReconcileEvidence`/`evaluateReconcileEvidence` — the events-aware evaluator that reads the run's own verdict/gate history, not FG-443's events-blind out-of-band evaluator). Eligible → the item ships atomically with a `campaign_item.evidence_reconciled` audit event and held dependents are released; ineligible → resume refuses to ship and re-parks as before, recording the missing facts to stderr and as a durable `campaign_item.evidence_reconcile_refused` audit event. Documented in [Resume](concepts.md#resume).
- **FG-442** — delivered: the campaign planner now assigns each item an explicit execution lane (`full_feature`, `quick_implementation`, `docs_only`, `test_only`, `review_only`, `research_only`, `ticketing_only`, `manual`) instead of defaulting every item to `full_feature`. Classification happens once, at plan-authoring time (`forge campaign plan --routes`), never inside `resolvePlan` or the executor; the operator confirms or overrides the lane basis at the existing `forge campaign approve` gate — no new approval gate. `plan_hash` now covers each item's `lane`, `laneRationale`, and `materialLaneAssumptions`, so any post-approval lane change forces re-approval. An item that outgrows its assigned lane sets the SHARED blocker `lane_escalation`, pausing the whole campaign; a bare `forge campaign resume` is refused until `forge campaign escalate-lane` → `forge campaign approve` clears it. Documented in [Execution lanes](concepts.md#execution-lanes) and [Lane escalation](concepts.md#lane-escalation).

  **PR #11 review follow-up (three fixes, shipped after the initial FG-442 delivery above):** (1) an invoke-based lane item (`quick_implementation`, `docs_only`/`test_only`/`review_only`/`research_only`, and the legacy invoke escape hatch) whose agent(s) finished but whose ticket wasn't actually closed with a `closedCommit` used to be marked `lifecycleStatus: complete` anyway, letting the campaign finish `complete_with_issues` over unshipped work; it now parks `awaiting_gate` (no `blockerKind`) and pauses the campaign — the same out-of-band shape `forge campaign reconcile` already completes once the ticket is closed. Only `outcome: shipped` reaches `complete`. (2) `forge campaign approve` on a `paused` campaign now requires a genuine fresh plan: `plan_hash` must differ from `approved_plan_hash` (the shape an `escalate-lane` step mints), enforced in both the CLI and the store (`approveCampaign`) — a paused campaign whose plan hasn't changed (e.g. a preserved `awaiting_gate` evidence campaign) is refused rather than having its approval metadata rewritten. (3) `forge campaign plan` no longer falls back to `full_feature` when items have no `--routes` judgment — it refuses, naming the unjudged tickets, unless the operator passes `--default-lane <lane> --default-lane-rationale <text>` (blanket-safe lanes only: `full_feature`/`quick_implementation`/`ticketing_only`/`manual`; the agentRole lanes still require `--routes`). No plan-time classifier or LLM agent exists; lane judgment comes only from `--routes` or the explicit `--default-lane` opt-in. All three documented in [Execution lanes](concepts.md#execution-lanes), [Approval](concepts.md#approval), and [Outcome semantics](concepts.md#start-sequential-execution).

  **Migration note:** every campaign already sitting in `planned` or `paused` state before this shipped has a `plan_hash` computed without lane fields in `canonicalContent`. The first `resolvePlan()` call against such a campaign post-deploy (the `stale_plan` check on `start`/`resume`, or `show`/`report`'s current-hash comparison) now includes `lane`/`laneRationale`/`materialLaneAssumptions` per item, so it computes a **different** hash than the stored `approved_plan_hash` — every such campaign will show as stale and require a re-plan + re-approve before it can start or resume. This is desired safety behavior, not a bug: approval is meant to cover the lane basis, and a campaign approved before lanes existed was never approved against one. Legacy `executionMode: 'workflow'`/`'invoke'` per-item entries (no `lane` field) are still mapped to a lane by `getItemPlanEntry` — `'invoke'` folds to `review_only`, everything else to `full_feature` — so a re-planned/re-approved legacy campaign continues to dispatch exactly as it was originally approved to.
- **FG-443** — delivered: campaign cannot cleanly COMPLETE an item legitimately delivered outside its feature pipeline (re-routed lane / out-of-band); the item stalls at `awaiting_gate` and only abandon remains. `forge campaign reconcile` now also covers this `awaiting_gate`/no-`blockerKind` shape via the same evidence-gated model (ticket closed + `closedCommit` reachable on base + lane evidence), and `forge campaign show`/`report` name the completable path explicitly on the human-readable surface instead of the generic gate text. Documented in [Reconcile](concepts.md#reconcile).
- **FG-444** — delivered: `forge campaign show`/`report` now compute and surface out-of-band completion eligibility for EVERY parked item, not just the first one the top-level `Next action` line inspects. Each item row carries a machine-readable `outOfBandEligible` boolean, and the human-readable output renders a per-item `out-of-band-eligible:` line whenever it's true — reusing the exact same evaluator (`evaluateOutOfBandEvidence`/`collectOutOfBandEvidence`, including the FG-458 run-evidence agreement check) that both `forge campaign reconcile` and the single top-level Next action line use, so per-item display can never diverge from what reconcile would actually ship. The top-level Next action line itself is unchanged by design — sequential execution only ever proceeds on one blocker at a time, so it still names only the first parked item. Documented in [Show](concepts.md#show) and [Reconcile](concepts.md#reconcile).
- **FG-473** — delivered: a `quick_implementation` (invoke-chain) item delivering a genuine code change could never complete via `forge campaign reconcile`/`resume`. The out-of-band composition folds in the run's Fact-5 authoritative-outcome contribution for any item with a `runId` (`authoritativeOutcomeContribution` in `reconcile-outofband-evidence.ts`), but an invoke-chain run produces zero authoritative verdicts — there was nothing for a force-advance to supersede — so Fact 5 was structurally unsatisfiable for this lane no matter how legitimately the work shipped, wedging the whole sequential campaign at that step. Fixed by narrowing `AUTHORITATIVE_OUTCOME_MISSING_CODES` (`reconcile-evidence.ts`) to drop `no_authoritative_verdict_or_force_advance_event`: a run with no authoritative reviewer at all (the normal shape for invoke lanes — `quick_implementation`/`docs_only`/`test_only`/etc., no red step) is now no-objection, while an unresolved authoritative FAIL or INCONCLUSIVE (a reviewer that ran and objected) still blocks. Lane evidence (closed ticket + reachable commit + passing host-verification) is unchanged and still required either way. Shape-1 reconcile (the normal feature-pipeline path) is unaffected — it pushes the code directly rather than through this set, so a missing verdict still blocks there. Both out-of-band consumers (`reconcile-outofband-evidence.ts`'s composition and `report.ts`'s `hasUnresolvedAuthoritativeOutcome` display predicate) changed consistently, preserving the FG-444 no-divergence guarantee. Documented in [Reconcile](concepts.md#reconcile) and [Resume](concepts.md#resume).
- **FG-475** — delivered: a sequential campaign wedged permanently when a `full_feature` item's run was driven to a terminal state by a manual gate reject with no `on_reject` recovery step (e.g. an operator deferring an item by rejecting its architect gate) — `forge campaign resume` printed one "refusing to ship and re-parking" line, then spun forever inside `driveWorkflowItem` because the run itself never reached a terminal status, requiring a manual process-tree kill to recover. Root cause: `gate.ts`'s reject branch never finalized the run when no `on_reject` fired, and `runNext.ts`'s "is the run done" checks had no notion of a step being permanently unreachable (only "does every step have a task row"), so a run stuck behind a terminally-failed, unrecovered primary task never flipped to `complete`. Fixed with a shared reachability helper (`isRunSettled` in `ready-queue.ts`) that recursively classifies each step as complete/active/blocked — a step downstream of a terminally-failed dependency is `blocked` (unreachable), not `active` (still pending) — consumed identically by `gate.ts`'s `finalizeRunIfDone` (both the advance and reject branches) and both of `runNext.ts`'s terminal checks. With the run now correctly reaching `complete`, `reconcileTerminalOutcome`'s "no authoritative verdict" branch no longer defaults blindly to `blockerKind: campaign_system` (SHARED, pausing the whole campaign) — it classifies the run's most recent failed primary task via `classifyFailureKind` first, so a gate-rejected task resolves to `blockerKind: scope` (LOCAL, holding only that item) and independent pending items continue to dispatch in the same resume call; dependent items remain held per existing dependency policy. Documented in [Outcome semantics](concepts.md#start-sequential-execution).
- **FG-476** — delivered: the other half of FG-475's scenario — when the reject *does* have an `on_reject` recovery step but that step already has a complete primary task (e.g. `security-audit.yml`'s `audit` step rejects back to the earlier `investigate` step), the run correctly stayed `active` (FG-475's fix) but the recovery task itself was never dispatched: `computeReadyQueue` (`ready-queue.ts`) skips any phase with a complete primary, and `dispatchSingleStep`'s pending-row reuse (`runNext.ts`) only matched `parentId === undefined` rows, so the fresh `parentId`-tagged recovery task was invisible to both. The run hung `active` forever with no path to completion. Fixed by admitting a phase into the ready queue, and letting `dispatchSingleStep` reuse a pending row, when that phase's only pending task is a live on_reject recovery task — identified by the `taskPackage.inputs.rejectedTaskId` marker `gate.ts` already stamps (the same marker FG-475's `isRunSettled` reads), not by relaxing the `parentId` check generally. Fanout/red children (`parentId`-tagged, no `rejectedTaskId` marker) are still never admitted as primary work. Two rejects landing on the same still-open recovery phase now dedup into one pending row (latest rationale wins) instead of minting a second. `on_reject` targeting a `fanout` step is now rejected at schema load time (FG-478) rather than reproducing this class of hang — recovery-into-fanout has no defined re-expansion/child-identity semantics yet.
- **FG-483** — delivered: drive-time `quick_implementation` and invoke-lane (`docs_only`/`test_only`/`review_only`/`research_only`, and the legacy invoke escape hatch) finalize used to mark an item `shipped` on `freshTicket.status === 'done' && !!freshTicket.closedCommit` alone — hand-editable ticket frontmatter, with no commit-reachability check and no host-verification row required, the exact frontmatter-trust the reconcile/evidence layer exists to reject (review finding F4, HIGH). An engineer agent that closed its own ticket (or any pre-closed ticket) could make the campaign record `shipped` with zero host-side proof the merged tree even compiles. Both finalize sites now route through the SAME `composeOutOfBandEligibility` composition the FG-441 resume/reattach path and `forge campaign reconcile`'s shape-2 evidence already use — `evaluateOutOfBandEvidence`/`collectOutOfBandEvidence` (closed ticket, `closedCommit` reachable on base, and lane evidence: non-code out-of-band classification for docs-only lanes, or a covering passing host-verification row for code-touching commits) composed with the run's own authoritative-outcome fact (`authoritativeOutcomeContribution`/`collectReconcileEvidence`) — via one shared helper, so drive-time and resume-time can never diverge again. Eligible → the item ships atomically (CAS-guarded against a concurrent pause/abandon) with a `campaign_item.evidence_reconciled` audit event (`decidedBy: 'campaign_drive'`); ineligible → it parks `lifecycleStatus: awaiting_gate` (no `blockerKind`) naming the missing evidence, with a durable `campaign_item.evidence_reconcile_refused` audit event, exactly as the pre-existing parked shape already does. Drive-time finalize only evaluates existing evidence — it never runs host-verification itself (capture remains `forge campaign reconcile`-only), and no auto-merge is introduced. Documented in [Outcome semantics](concepts.md#start-sequential-execution) and [Delivered outside the feature pipeline](concepts.md#start-sequential-execution).
- **FG-485** (2026-07-07) — delivered: sibling fix to FG-475 — that one unwedged a `full_feature` run stuck behind a terminally-failed, unrecovered gate reject; this one fixes what happened when the run was still perfectly healthy. An `awaiting_gate` item with no `blockerKind` can also mean the operator decided the gate in-run (`forge gate <task> request-changes`/`advance`) and then called `resume` while the run itself is still `active` with real dispatchable work — a pending replacement primary after `request-changes`, or the next phase after `advance`. Resume's FG-441/FG-460 reattach branch previously evaluated out-of-band ship evidence FIRST regardless, which — for this shape — always came up short (the item hadn't shipped; it was still mid-run), producing a false `campaign_item.evidence_reconcile_refused` audit event and the misleading "refusing to ship and re-parking" message before ever driving the pending work. Fixed by checking liveness before evidence: for a pipeline run (`taskHasPipelineFinalize`) that's `active`, resume now runs `computeReadyQueue` over the loaded workflow first — if it finds dispatchable work, resume skips evidence entirely and falls straight through to `driveWorkflowItem`, re-entering the drive loop directly with no refusal event. A live run whose workflow fails to load returns `recovery_needed` directly (campaign paused) rather than falling into the evidence path. Invoke-family runs (`invoke`/`invoke_chain`, no loadable YAML workflow, no drive loop to re-enter) skip the liveness probe entirely and keep the FG-483 evidence-path behavior unchanged. Evidence evaluation is now reserved for runs that are absent, not `active`, or settled with nothing left to dispatch. Documented in [Resume](concepts.md#resume).
- **FG-488** (2026-07-07) — delivered: the class-level backstop for the FG-475/FG-476 "active but nothing dispatchable" incident class (F2b in the 2026-07-06 review) — FG-475/FG-476 fixed the two specific lifecycle bugs that produced that shape; this bounds `driveWorkflowItem` against the shape itself, however it arises. Two consecutive drive passes that call `runNext` and dispatch nothing (no steps dispatched, completed, gated, or failed) while the run stays `active` with an unchanged run/task-status snapshot now trip a no-progress bound instead of looping again — previously the loop spun at 100% CPU indefinitely on this shape, exactly as FG-475/FG-476 documented, requiring a manual process-tree kill to recover. On trip, the item parks `lifecycleStatus: awaiting_gate` (no `blockerKind`) with `requestedHumanAction: "drive loop made no progress on run <runId>: it is active but nothing is dispatchable. Inspect the run's tasks (forge show <runId>), resolve the blockage, then resume."`, the campaign transitions to `paused`, and `driveWorkflowItem` returns a new `recovery_needed` outcome (both call sites in `driveRemainingItems` propagate it to `stopReason: recovery_needed` for that call). Because the park lands in the same `awaiting_gate`/no-`blockerKind` shape as every other cooperative park, FG-485's liveness-first reattach re-examines the run's dispatchable work on the next `resume` — once the underlying blockage is resolved, resume re-drives directly, no manual DB reset required. Documented in [Start](concepts.md#start-sequential-execution) and [Resume](concepts.md#resume).
- **FG-489** (2026-07-07) — delivered: operators had no supported way to un-stick a transiently-failed campaign item short of hand-editing the database (F6 in the 2026-07-06 review) — the single most common overnight-interruption shape (expired auth, container/infra crash, idle timeout). `forge campaign retry <campaign-id> <ticket-id>` resets a `failed`/`blocked` item back to `pending` — clearing per-attempt state (`outcome`, `blockerKind`, `runId`, `branch`, `worktreePath`, `prUrl`, etc.) — for the next `forge campaign resume` to re-dispatch cleanly. Eligibility is restricted to the transient `blockerKind`s (`auth`/`infrastructure`, covering the auth and container/infra/idle-timeout/result/integration-gate failure kinds classified by `classifyFailureKind`); the campaign must be `paused` (CAS-guarded against a concurrent status change); a scope/verdict-blocked item is refused with guidance rather than silently retried over a red verdict; `blockerKind: lane_escalation` is refused naming `escalate-lane` instead. Recovery guidance (the `start`/`resume` stderr message, and `show`/`report`'s `Next action`/`nextOperatorAction` fields) no longer instructs a manual DB edit — it points at `forge show` to inspect, then names `forge campaign retry` once the item is confirmed transient; the paused-with-blocked-items message now splits retryable items (naming the verb per ticket) from other blockers (inspect / re-plan / abandon). Auto-reset on resume was deliberately not implemented (scope decision at filing) — retrying always requires an explicit operator call. Documented in [Retry](concepts.md#retry), [Start](concepts.md#start-sequential-execution), and [Resume](concepts.md#resume).

Exit criteria:

- a legitimately-delivered out-of-band item (re-routed lane, docs-only, etc.) can be marked COMPLETE without resorting to `abandon` — done (FG-443);
- forge-observed merges automatically capture post-merge host-verification instead of requiring a manual `forge record-host-verification` — done (FG-440);
- campaign resume reconciles manually-driven campaign item runs after merge/close instead of staying wedged on stale campaign-item state — done (FG-441);
- the campaign planner assigns an explicit execution lane per item instead of silently defaulting every item to full feature — done (FG-442);
- reconciliation stops penalizing an item for a historical red-fail that was legitimately superseded by a force-advance or a later authoritative pass — done (FG-427).

## Campaign State Model

Campaign status should describe lifecycle:

- `planned`
- `running`
- `paused`
- `complete`
- `failed`
- `abandoned`

Campaign item status should reuse or align with existing Forge run/task lifecycle vocabulary where practical. Campaign-specific interpretation belongs beside status:

- `outcome`: `shipped`, `blocked`, `skipped`, `held`, `needs_refinement`, `failed`;
- `blocker_kind`: `scope`, `readiness`, `tests`, `merge_conflict`, `auth`, `dependency`, `git_state`, `infrastructure`, `campaign_system`, `human_decision`, `lane_escalation`;
- `continue_policy`: `continue_allowed`, `hold_dependents`, `hold_campaign`;
- `reason`;
- `human_action_requested`.

This avoids two competing item-level status systems.

## Campaign Modes

- `dry_run`: plan and report only.
- `pilot`: conservative execution with visible warnings when gates are incomplete.
- `sequential`: production-worthy one-item-at-a-time execution.
- `parallel`: future mode after worktree, dependency, and merge/refinery gates are proven.

## Campaign Report Contract

A campaign report is the generic summary for a checkpointed, paused, failed, or completed campaign.

Minimum report fields:

- campaign id;
- source input;
- goal;
- mode;
- campaign status;
- whether Forge believes it is safe to continue;
- approved `plan_hash`, current `plan_hash` when known, and approval metadata;
- item rows with ticket id, title, lifecycle status, outcome, blocker kind, continue policy, run id, branch/worktree/PR/commit when known, verification state, done-audit state, reviewer result, reason, and requested human action;
- shipped, blocked, held, skipped, and failed groupings;
- dirty git state or uncommitted intended changes when known;
- deferred scope and linked follow-up tickets;
- next recommended operator action.

Reports must distinguish:

- all items shipped;
- campaign complete with blocked/skipped/held items truthfully reported;
- campaign paused awaiting human action;
- campaign failed due to infrastructure or campaign-system failure.

## Overnight Readiness Checklist

Before trusting unattended overnight work:

- backlog integrity prerequisites are complete;
- campaign state survives restart;
- sequential execution is proven;
- blocker semantics are conservative;
- campaign report is available without inspecting logs;
- readiness and done-audit gates are integrated or campaign runs in explicit `pilot` mode;
- Shipping Reviewer is available for final shipped claims;
- Reviewer Context Packet and Shipping Reviewer fail-loud semantics are documented for operators and future implementers;
- host test verification is required, recorded, matched to the shipped commit, and visible;
- git branch/commit/PR policy is enforced or explicitly unavailable;
- dashboard or CLI status can show active blocker and next action.

## Non-Goals For Initial Ship

- No parallel campaigns by default.
- No hidden reordering after approval.
- No automatic merge conflict resolution.
- No claim that every project has an upstream remote.
- No dashboard editor requirement for the first shipped version.
- No replacing individual Forge run/task records with campaign-only state.
