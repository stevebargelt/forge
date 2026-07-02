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
- **FG-357**: post-merge integration gate — after a worktree merge lands (single-step merge-to-HEAD, FG-352, or fan-out integration-branch merge-to-HEAD, FG-353), forge runs the project's own `test:unit` script against the merged tree on the host before the step is done; a project with no `test:unit` script is skipped rather than blocked. Failure is a new terminal `failure_kind: integration_failed` (distinct from `merge_conflict`, non-retryable, merged worktree/branch retained for inspection). Default 10-minute timeout, overridable via `FORGE_INTEGRATION_GATE_TIMEOUT_MS`. Documented in [Post-merge integration gate](concepts.md#post-merge-integration-gate).

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

Prerequisites already filed: **FG-410** (`updateCampaignItem`'s read-merge-write is lost-update-unsafe under concurrent writers and must land before parallel lanes go live) and **FG-424**/**FG-425**/**FG-426** (post-merge integration gate needs to distinguish real test failures from infra/platform failures, scope gate locking per `projectDir`, and classify `integration_failed` as a scoped item blocker — all sharpen the shared gate/lock surface that parallel lanes will contend on).

### Phase 6: Campaign Completion & Reconciliation Honesty

Dogfooding a campaign end-to-end (campaign-922c83b7c577) surfaced a cluster of reconciliation and completion gaps this plan did not anticipate. That campaign is deliberately preserved in a paused state as the live evidence case: FG-357 only reconciled after recognizing a force-advanced gate and a later authoritative pass superseded a stale historical red-fail; FG-376 was only reconcilable after a MANUAL `forge record-host-verification` call because force-advanced/manually-driven items get no automatic post-merge host-verification; and FG-422 — correctly re-routed to a documentation-authoring lane and genuinely shipped — is stuck at `awaiting_gate` with no clean path to `complete` other than `abandon`, which would mislabel a fully-successful campaign.

- **FG-427**: campaign reconciliation honors a recorded force-advance or later authoritative pass instead of aggregating stale historical red-fails forever (underpins FG-440/FG-441).
- **FG-440**: force-advanced/manually-driven campaign items get no post-merge host-verification, so evidence-gated reconcile refuses a legitimately merged-and-green item.
- **FG-441**: campaign resume should reconcile manually-driven campaign item runs after merge/close.
- **FG-442**: campaign planner should route each item into an execution lane instead of defaulting to full feature.
- **FG-443**: campaign cannot cleanly COMPLETE an item legitimately delivered outside its feature pipeline (re-routed lane / out-of-band); the item stalls at `awaiting_gate` and only abandon remains.

Exit criteria:

- a legitimately-delivered out-of-band item (re-routed lane, docs-only, etc.) can be marked COMPLETE without resorting to `abandon`;
- force-advanced or manually-driven items automatically capture post-merge host-verification instead of requiring a manual `forge record-host-verification`;
- campaign resume reconciles manually-driven campaign item runs after merge/close instead of staying wedged on stale campaign-item state;
- the campaign planner assigns an explicit execution lane per item instead of silently defaulting every item to full feature;
- reconciliation stops penalizing an item for a historical red-fail that was legitimately superseded by a force-advance or a later authoritative pass.

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
- `blocker_kind`: `scope`, `readiness`, `tests`, `merge_conflict`, `auth`, `dependency`, `git_state`, `infrastructure`, `campaign_system`, `human_decision`;
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
