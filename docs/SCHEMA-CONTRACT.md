# Schema contract — what the dashboard reads from forge

The `forge-dashboard` package (workspace at `dashboard/` inside this repo as of #140) reads forge's SQLite DB and run-directory filesystem directly. Forge writes; the dashboard reads. **This document is the API between them.**

As of the #140 workspace merge, dashboard's `src/queries.ts` imports `Run` and `Task` types from `@forge/types` (aliased to forge's `src/types/index.ts`). That gets us cleanup of duplicate type definitions, but full compile-time drift protection isn't there yet — the inline `as Array<{...}>` row casts in queries.ts still hardcode snake_case column names. Changing a column name on the forge side surfaces as a dashboard runtime failure, not a build error. **A future ticket should introduce a single source of truth for SQL schema (typed column-name constants or a schema-as-code library) so that any forge schema change forces a dashboard typecheck failure.** Until that lands, treat this doc as the canonical reference and update it in the same commit as any schema change.

## SQLite contract

Database file: `~/.forge/forge.db` (overridable via `FORGE_HOME`). Mode: WAL — concurrent readers don't block forge's writer.

### `runs` table

Columns the dashboard reads:
- `id` — string, primary key
- `workflow` — string, the YAML workflow name (e.g. `feature`, `invoke` sentinel for single-invoke runs)
- `title` — string, human-readable run title
- `status` — string, one of `active | complete | failed | abandoned` (unconstrained TEXT; `failed` added in FG-585 with no migration)
- `created_at` — ISO 8601 timestamp string
- `completed_at` — nullable ISO 8601 timestamp string
- `project_dir` — nullable string, the host path mounted at `/project` for this run's containers
- `metadata` — nullable JSON string. Dashboard does not currently parse fields beyond looking at the full blob

An expression index `idx_runs_dispatch_key` over `json_extract(metadata, '$.dispatchKey')` was added (FG-563) so the continuation consumer's check-before-spawn lookup (`runByDispatchKey`) resolves the one run created under a deterministic dispatch receipt with an indexed equality probe instead of a full-table scan + per-row JSON parse. Additive (index only — no column or data change, `IF NOT EXISTS` so re-open is idempotent); the dashboard does not read it.

### `tasks` table

- `id` — string, primary key
- `run_id` — string, foreign key to runs
- `parent_id` — nullable string, foreign key to tasks (red children and retry chains)
- `phase` — string, matches the workflow step id
- `agent_role` — string (e.g. `architecture-advisor`, `engineer`, `red-wide`)
- `status` — string, one of `pending | running | awaiting_gate | awaiting_red | complete | failed | blocked_by_red | awaiting_recovery`. `awaiting_recovery` (FG-425, FORGE-DEC-027) is NON-TERMINAL and additive — a task whose publication advanced the target ref and then lost the publication window, so its disposition is not yet settled. A reader that does not know it should render it as a parked/in-progress state, never as a failure, and must never offer a retry for it (the work may already be on the target). See [Publication visibility and recovery](concepts.md#publication-visibility-and-recovery).
- `result` — nullable JSON string. Dashboard parses + dispatches to per-agent renderer based on `agent_role`
- `created_at` / `started_at` / `completed_at` — nullable ISO 8601
- `error` — nullable string
- `worktree_path` — nullable string, the host filesystem path of the task's isolated workspace when worktree mode is enabled. Since FG-345 (2026-07-28) isolation is the **default** — on for a darwin host with neither switch set — so a non-null value is the ordinary case, and `null` means isolation was disabled for that dispatch (`FORGE_NO_WORKTREES=1`, an explicit non-`1` `FORGE_WORKTREES`, or a non-darwin host taking the platform **default**) and the run bind-mounted the shared project directory. The non-darwin case is a default, not a guarantee: an explicit `FORGE_WORKTREES=1` arms the resolver on any platform, so a win32 dispatch does create and record an isolated workspace. Only Linux is refused outright, and by the preflight gate rather than the resolver — the dispatch hard-fails there instead of recording a path. All of that is the WORKFLOW-dispatch path: an `invoke`-dispatched task (`forge invoke`, and `forge review-loop`'s reviewer and fixer) provisions no workspace at all, so its `worktree_path` is always `null` regardless of platform or switch. See [Workspace isolation](concepts.md#workspace-isolation-worktree-mode). Set durably before container dispatch so it survives process restart. Task branch identity is derived deterministically as `forge/<runId>/<taskId>` and is not stored separately. Added by FG-351; additive and nullable — pre-FG-351 rows and dashboard code that does not read this column degrade gracefully.

  Since FG-621 the column names one of **two substrates**, and the column itself does not say which — the substrate is read off the workspace's own `.git`. A mutating task gets a private `git clone --shared` at `~/.forge/worktrees/clones/<runId>/<taskId>` (a `.git` *directory*); the linked-worktree path at `~/.forge/worktrees/<runId>/<taskId>` (a `.git` *file*) is the non-mutating/red substrate FG-559 established. A reader that needs to tell them apart must probe the path, not the column.
- `base_sha` — nullable string, the commit a task's private clone was created **at**, recorded in the same write as `worktree_path` and before the container starts. `null` on the linked-worktree and shared-mount paths and for pre-FG-621 rows. The value is the run's last accepted publication receipt (`publication_attempts.published_sha`) when there is one, and the resolved `projectDir` `HEAD` otherwise — so a sequential task's base is the exact accepted predecessor candidate, and every sibling of one fan-out wave records the same base. Added by FG-621; additive and nullable.

  Since FG-356 the column is **RECORDED, not live**: reconcile's workspace reaper may dispose of a terminal task's worktree (only against proof the work reached `run.projectDir` — see [Reaping an orphaned workspace](concepts.md#reaping-an-orphaned-workspace)) without clearing this column, so a non-null path says a workspace was dispatched at that path, never that the directory exists now. A reader that needs the current disposition reads the task's `task.workspace_reaped` / `task.workspace_retained` events (below), not this column, and must not treat a stat failure on the path as data loss or corruption.

  Fan-out steps additionally create a step-scoped **integration branch** (`forge/<runId>/<parentTaskId>/integration`) checked out at `~/.forge/worktrees/<runId>/<parentTaskId>/integration`. Child branches are merged into this integration tree sequentially (in child index order, `--no-ff`) before fan-out reds review it. The integration branch and worktree are not tracked in the `tasks` table; they are retained on conflict or failure, for inspection. Two lifecycle events mark this path in `forge show`: `integration.worktree_created` and `integration.child_merged`. This behavior is active only under worktree mode (FG-353) — which since FG-345 is the default rather than an opt-in.

  A clean merge is not itself the last check, and (since FG-425) it does not land on the publish target. The **integration publisher** validates a candidate commit — built in its own per-attempt worktree under `~/.forge/worktrees/publications/` — and only then fast-forwards the target to that exact recorded commit. Gate failure records one of three `failureKind`s on the task (distinct from `merge_conflict`): `"integration_failed"` for a genuine test-suite failure, or `"integration_gate_timeout"`/`"integration_gate_crashed"` (FG-424) when the gate run itself timed out or was killed by signal; publication itself can fail with `"dirty_publish_target"`, `"publish_base_churn"`, `"publication_refused"`, or `"lane_taken_over"`. Earlier still, before any candidate exists, a private clone's work has to be CAPTURED into the parent's ref namespace — an unreadable `git status`, a failed safety commit, a rejected fetch, or a fetched ref that does not equal the clone's tip records `"capture_failed"` (FG-621; additive). It is deliberately **not** `merge_conflict`: nothing was merged, no candidate was built and the publish target was never involved — the agent's work is still in the retained clone. A reader that does not know the value should treat it like any other terminal failure kind. The candidate worktree/branch are retained in every failing case, not cleaned up, and the publish target is left untouched. A publication that lost its window *after* the ref advance landed records no failure kind at all — it is unsettled, not failed, and its task parks in `awaiting_recovery` (above). See [Integration publisher](concepts.md#integration-publisher).

  Publication emits `integration.published` (run-level; payload carries the recorded `{target, baseSha, candidateSha, publishedSha}` and an `outcome` field) plus the per-attempt `publication.*` events (`requested`, `merge_failed`, `validation_failed`, `base_moved`, `published`, `refused`, `parked`, `recovered`, and — FG-425 AC5 — `window_lost`, `recovery_pending`, `already_published`), with `task.awaiting_recovery` and `task.publication_reconciled` on the task side. **`integration.merged_to_head` is no longer emitted** — FG-425 replaced it with `integration.published`, because it recorded a merge that landed on the target *before* it was validated. Historical rows in existing DBs still carry it and must keep rendering. FG-425's own durable state (`publication_attempts`, `publication_lane`, `publication_locks`) is not part of the dashboard read contract; it is read via the `forge publish` command tree.

### `verdicts` table

- `id`, `task_id`, `red_task_id` — strings
- `red_role` — string
- `verdict` — string, one of `pass | fail | inconclusive`
- `confidence` — number, 0.0–1.0
- `authority` — string, one of `triage | specialist | authoritative`
- `findings` — JSON string (array of `{severity, summary, evidence, hypothesis}`)
- `created_at` — ISO 8601
- `gate_on_verdict` — nullable integer (`1` / `0`), the red's `gate_on_verdict` config captured at verdict-insert time. Additive and nullable with no default: rows written before the column existed read back `NULL`. A verdict blocks the gate when `verdict = fail` AND `authority = authoritative` AND `gate_on_verdict` is not `0` — so a legacy `NULL` blocks (fail closed), and only an explicit `0` opts a fail out of blocking. Persisting it is what lets red dispatch (in-hand config) and the later gate re-check (persisted rows) apply one blocking rule instead of two.

### `gates` table

- `id`, `task_id` — strings
- `decision` — string, one of `advance | reject | request-changes`
- `rationale` — nullable string (markdown-ish freeform)
- `decided_at` — ISO 8601
- `decided_by` — string

### `events` table

Columns the dashboard reads:
- `event_type` — string; dashboard reads all event types for the lifecycle timeline
- `payload` — nullable JSON string; event-specific structured data
- `task_id` — string, foreign key to tasks
- `run_id` — string, foreign key to runs (**nullable** — a campaign reconcile host-gate event, below, is frequently run-less)
- `created_at` — ISO 8601 timestamp string

#### FG-487: host-side verification events

Host verification (review-loop's CI-wait/local verification phases, campaign reconcile's real-exec gates) runs outside the task/container lifecycle — minutes of host-side activity with no task row while it's in flight. These `event_type`s make that activity durable so the dashboard can render it; see `dashboard/src/queries.ts`'s FG-487 section for the read side.

Every start/finish payload carries a per-invocation `attemptId` (uuid). **Pairing a start with its finish is always by `attemptId`** — never "the latest unmatched start for this round/ticket/sha" — because a crashed forge process restarting a round, or a CI-wait retry, can legitimately produce two starts at the same round/ticketId/sha identity.

- `review_loop.verification_started` — emitted by `forge review-loop` immediately before each round's `deps.verify()` call (including round 1, before any reviewer/fixer task row exists — this is the launch-to-first-round window the dashboard previously showed nothing for). Payload: `{ attemptId, round, ticketId, sha, mode? }`. `mode` (when present) is `"ci_wait"` or `"local"` (the producer, `src/cli/commands/review-loop.ts`'s `verifyWithEvents`, emits the underscore form; the dashboard tolerates both `"ci_wait"` and the hyphenated `"ci-wait"`) and is read by the dashboard to distinguish a `"verifying"` phase from a `"waiting-on-ci"` phase — a start emitted before that determination is made may omit `mode`, in which case the dashboard degrades to `"verifying"`.
- `review_loop.verification_finished` — emitted once `deps.verify()` resolves. Payload: `{ attemptId, round, ticketId, sha, mode, ok, reusedEvidence, ciOutcome, checkContexts, command, tier, steps }`. `ok` (boolean) is the actual pass/fail signal the dashboard's badge reads (`verificationOutcomeClass()` in `dashboard/client/verification-render.js`) — there is no `ciOutcome.kind === "passed"` value; `ciOutcome.kind` is one of `"reused_after_wait" | "ci_failed" | "local_fallback"` (or `null` on an immediate reuse) and is rendered as supplementary detail, not the pass/fail signal itself. `checkContexts` (string array, `ci_wait` only) is the required CI check contexts consulted for reuse/wait/failure; `null` when nothing CI-specific was resolved (e.g. an unavailable-CI local fallback). `command` / `tier` (`"fast" | "extended"`, `local` only) describe what actually ran, derived from the local run's step names; `null` on any path that didn't run locally. `steps` is `{ name, ok }[]` per discoverable check (`typecheck`/`test`/`test:extended`) and is read by the dashboard to list which steps failed. `reusedEvidence` (string, nullable) is a human-readable description of the reused evidence. The dashboard reads `attemptId` for pairing and every other field above for its detail line (`reviewLoopVerificationDetail()`).
- `campaign_item.host_gate_started` — emitted by `forge campaign reconcile`'s host-gate path immediately before a REAL `execFileSync` gate run (not emitted when evidence is reused instead of executed). `run_id` is the events-table column, set to the campaign item's `runId` (nullable — many campaign items have none). Payload: `{ attemptId, campaignId?, itemId, ticketId, command, testedSha }` (the dashboard also accepts a `gate` key as an alias for `command`).
- `campaign_item.host_gate_finished` — emitted immediately after that `execFileSync` call resolves. Payload: `{ attemptId, exitCode, ...outcome }`. The dashboard's badge reads `exitCode` (`0` → success) — this event never carries an `ok` field, unlike `review_loop.verification_finished`.

The dashboard derives "in progress" (`inProgressVerifications()` / `GET /api/verifications/in-progress`) as: a start event whose `attemptId` has no matching finish event, AND whose `created_at` is within a 24-hour lookback window (beyond that, the row is dropped so a long-dead process doesn't accumulate forever). Within the lookback, a start past its type's staleness cutoff — 20 minutes for `review_loop.verification_started` (mirrors `DEFAULT_CI_WAIT_TIMEOUT_SECONDS` in `src/cli/commands/review-loop.ts`) or 10 minutes for `campaign_item.host_gate_started` (mirrors `HOST_GATE_TIMEOUT_MS_DEFAULT` in `src/campaign/reconcile-collect.ts`) — is still returned, but flagged `stale: true` on the `InProgressVerification` row, rather than silently dropped; the dashboard renders this as a `"stale · <label>"` badge (`verificationRowBadge()`) instead of vanishing it, since a stale-and-unmatched start is exactly the crashed/hung-verification case an operator needs surfaced, not hidden. These cutoff constants are kept in sync **by hand** — they're upper-bound display heuristics, not the authoritative (env-overridable) timeouts.

Because these four event types are RUN-scoped (`task_id` is never set — the loop's verification happens between tasks; reconcile gates may have no task at all), the per-task Timeline (`taskDetail()`) folds the task's run's verification events into its event list alongside the strictly task-scoped rows; a strict `task_id` match alone would never surface them.

A review-loop run's current phase (`reviewLoopRunPhases()` / `GET /api/review-loop/phases`, one of `verifying | waiting-on-ci | reviewing | fixing`) is derived per run_id as whichever is more recent: a running task (`agent_role = 'engineer'` → `fixing`, else → `reviewing`), or the latest still-open `review_loop.verification_started` (→ `verifying`/`waiting-on-ci` per `mode`). A run is considered a "review-loop run" purely by having ever emitted a `review_loop.verification_started` event — there is no assumption about the `runs.workflow` column's value.

#### FG-513: reviewer model-error retry (audit-only)

The two host-verification events above are not the whole `review_loop.*` family. `review_loop.reviewer_model_error_retry` is emitted by `forge review-loop` when a round's reviewer dispatch fails with `failure_kind: "model_error"` (a provider/model infrastructure failure — invalid model, quota, provider 4xx, broken provider CLI) and the loop retries it once, same round, on the plan's retry profile (the policy's default review path — or the *same* profile, when it was operator-pinned with `--review-profile`). See [Review-loop reviewer](concepts.md#review-loop-reviewer) for the pinning and retry rules the event records.

Payload: `{ ticketId, round, failedProfile?, retryProfile?, cause }`. `failedProfile` is the profile the reviewer was pinned to for this loop run; `retryProfile` is the profile the retry ran on. **Both profile fields are absent under legacy (no `model-policy.yml`) resolution** — there are no profiles to name, and the retry is a bounded same-resolution retry — so a consumer must treat them as optional, not merely nullable. `cause` (string) is the failing dispatch's error text. The event is emitted **whether or not the retry then succeeded**: its presence means an infrastructure failure occurred, not that the round failed. The round's outcome is carried by the loop's own result (`reviewer_failed` only when the retry also failed), never inferred from this event.

Unlike the four FG-487 event types above, this one is **not run-scoped-only**: it sets both `run_id` and `task_id` (the failed reviewer task), so it surfaces on the per-task Timeline through a strict `task_id` match without needing the run-level fold. It carries no `attemptId` and has no paired start/finish — it is a single point-in-time record, not a spanning activity.

**No dashboard consumer reads this event.** It exists for post-hoc audit/forensics (why did this loop's reviewer change profile mid-round?), alongside the same fact rendered into the review-loop run note. Adding a dashboard read is a future change, not an existing contract — but the payload above is what a reader would get.

#### FG-540: stream-recovered structured result (audit-only)

- `task.result_recovered_from_stream` — emitted whenever a missing `result.json` was recovered as the exact structured JSON object the agent emitted into its stream (the terminal `agent_message` of a cleanly-completed codex JSONL stream). See [Recovering a result from stdout](concepts.md#recovering-a-result-from-stdout) for the extraction rule and its guards. Sets both `run_id` and `task_id`, so it surfaces on the per-task Timeline through a strict `task_id` match. Payload: `{ source, logFormat? }`.

`source` names the consumer that adopted the recovered result — one of `"invoke"` (dispatch via `invoke.ts`), `"workflow"` (dispatch via `runNext.ts`), `"recover --continue"`, `"reconcile"` (running-orphan adoption), `"reconcile_pipeline_unfinalized"` (the FG-479 fail-safe landing, where the recovered result is preserved on the failed row rather than completing the task), or `"reconcile_backfill"` (the Mode A empty-result pass). `logFormat` is the runtime's log format (or kind) the recovery ran against, `null` when the manifest records neither; it is **absent** on the `"recover --continue"` source. `forge recover --continue`'s machine output carries the same fact in its `adoptedFrom` field, whose value is `"stream_recovered"` on exactly the adoptions that emit this event.

The event's presence is the *only* durable signal separating structured recovery from FG-337 narrative synthesis (below) — both land a result the agent never wrote to disk, but synthesis never emits this event, and a structured recovery carries the role's ordinary result shape rather than the `contract: "inferred"` shape. No dashboard consumer reads it today; it exists for post-hoc audit (where did this task's result actually come from?).

#### FG-356: workspace reap/retain events (audit-only)

Reconcile's workspace reaper emits one of these per terminal task whose recorded `worktree_path` is still on disk. Both set `run_id` and `task_id`, so they surface on the per-task Timeline through a strict `task_id` match, and both render in `forge show`'s timeline. See [Reaping an orphaned workspace](concepts.md#reaping-an-orphaned-workspace) for the capture proof that decides between them.

- `task.workspace_reaped` — the workspace and its branch were disposed of after the work in them was proven captured in `run.projectDir`. Payload: `{ workspacePath, branch, substrate, branchRemoved, removal?, reason, taskStatus }`. `branchRemoved` (boolean) records whether the `forge/<runId>/<taskId>` ref actually went — the tree can be gone while `git branch -d` declined the ref, and that disagreement is recorded rather than forced. Two reasons: `"work_captured"` for the ordinary disposal, where `substrate` is `"linked_worktree"` or (since FG-621) `"private_clone"` — those are the two substrates forge creates, and nothing else is ever removed; and `"branch_deletion_retried"` for the later pass that completes a disposal whose branch deletion had failed, where the tree is already gone so `substrate` is `"absent"` and `branchRemoved` is always `true`. `removal` is present on `"work_captured"` only and is one of `"git_removed" | "path_vanished"`: `"git_removed"` means `git worktree remove` completed the removal itself, `"path_vanished"` means git declined it and the tree was gone regardless (a race, a partially-completed removal, or a tree something else deleted). A `"private_clone"` disposal always records `"git_removed"`: the directory *is* the repository, so there is no `git worktree remove` to succeed or decline — the path is either gone or the disposal is a `removal_failed` retain. The reap is real either way — the directory is gone — but only the first is a clean `git worktree remove`, and the second is the case whose stale `$GIT_DIR/worktrees` registration gets pruned. A reader must not treat `"path_vanished"` as a failure. A `"work_captured"` event carrying `branchRemoved: false` is therefore not necessarily the last word — read the task's later events for a retry that landed.
- `task.workspace_retained` — the same pass **refused** to dispose of one. This event is the durable record of where that work still lives. Payload: `{ workspacePath, branch, substrate, reason, details, taskStatus }`. `substrate` is one of `"linked_worktree" | "private_clone" | "unknown"` (an absent workspace produces no event at all); `reason` is one of `"uncommitted_work" | "unmerged_commits" | "retained_failure_kind" | "submodules_present" | "private_clone_substrate" | "unknown_substrate" | "workspace_not_owned" | "remote_target_uncaptured" | "removal_failed"`; `details` is a string array carrying the specifics — the dirty paths (untracked and git-ignored included), the uncaptured commit shas, the checked-out submodule paths, the failed ownership proof, or the retaining `failure_kind` — and is frequently empty.

  Two notes on that reason list, both from FG-621. `"remote_target_uncaptured"` is new: the task's recorded publication receipt names a `remote:<remote>#<branch>` target, which never advances `projectDir`'s `HEAD`, and nothing else proved the workspace's commits captured — an explicit, named retain rather than a `HEAD`-relative "unmerged" verdict about a branch that was never going to reach `HEAD`. `"private_clone_substrate"` is **no longer produced**: it recorded a private clone the reaper refused to touch because clone reaping was unimplemented, and clone reaping now has a real proof (a clone forge cannot prove it owns retains as `"workspace_not_owned"`). The value stays in the contract because historical rows still carry it and a reader must keep rendering it.

- `task.workspace_reap_deferred` — the same pass **postponed** the decision (FG-621). The parent repository is repacking (`gc.pid` in its common git dir) and a private clone's `objects/info/alternates` point into the very object store being rewritten, so disposal waits for the next pass rather than racing it. Payload: `{ workspacePath, branch, substrate, reason, details, taskStatus }`, with `reason` currently only `"parent_repacking"`. **NOT a disposition**: the workspace was neither reaped nor retained, and a later pass still has to settle it — a reader must not render it as either outcome, and must not treat it as the last word on the workspace. It is emitted because a deferral that never resolves would otherwise be invisible; the deferral itself is bounded (a `gc.pid` older than git's own 12-hour staleness bound, or one naming this host with a dead pid, is not a repack).

Emitted **once per (task, reason)**: reconcile runs on every lifecycle command, so a workspace retained (or deferred) for the same reason on a later pass logs nothing new. A workspace whose reason *changes* (uncommitted work committed, so the next pass retains it for unmerged commits instead) does log a second event, and the sequence is the audit trail of that workspace's disposition. No dashboard consumer reads either event today; they exist for `forge show` and post-hoc audit (where did this task's workspace go, and why?).

#### Campaign-item reconcile decision events

Emitted by `forge campaign reconcile`'s (or the drive-time equivalent's) write path the moment an item is shipped, carrying the re-derived evidence in `payload.evidence` for audit purposes. `run_id` is the events-table column, set to the item's `runId` (nullable). No schema/column change accompanies any of these — they differ only in `event_type` and are how the audit trail distinguishes *why* an item was recoverable.

- `campaign_item.evidence_reconciled` — a scope-blocked item (`blockerKind:'scope'`, `lifecycleStatus` `failed` or `blocked_by_red`) wedged on a stale historical authoritative red-fail. Payload: `{ campaignId, itemId, ticketId, evidence, decidedBy, decidedAt }`.
- `campaign_item.out_of_band_reconciled` — an `awaiting_gate`/no-`blockerKind` item delivered through a re-routed, non-pipeline lane rather than the feature run itself. Payload: same shape as above.
- `campaign_item.campaign_system_reconciled` — FG-502: a `blockerKind:'campaign_system'` item with `lifecycleStatus` `failed` or `blocked_by_red` — the recoverable shape is exactly that `blockerKind`/`lifecycleStatus` combination, not a specific producer list. `executor.ts` producers include (non-exhaustive) run-salvage, a done-audit gap after a passing verdict, an unresolved-outcome fallback, and infrastructure failures such as a workflow-YAML load error, all leaving `failed`; `driveWorkflowItem`'s inconclusive-verdict park leaves `blocked_by_red`. Reconcile proved the item was actually delivered out-of-band, via the identical evidence bar `campaign_item.out_of_band_reconciled` uses (ticket done + closed commit reachable + lane evidence + no unresolved authoritative objection on its own run). Payload: same shape as above. Kept distinct from `out_of_band_reconciled` so the audit trail can tell "delivered via a re-routed lane" apart from "recovered from a campaign-system-side failure that turned out to already be shipped."

#### Campaign-item retry decision event

- `campaign_item.campaign_system_retried` — FG-511: `forge campaign retry` reset a `blockerKind:'campaign_system'`, `lifecycleStatus:'failed'`, `outcome:'blocked'` item back to `pending` after proving two things from durable evidence — that the ticket was **not** already delivered, and that **every** failed primary task of the underlying run classified transient (`auth` or `infrastructure`) via `failureKindForTask`/`classifyFailureKind`. Payload: `{ campaignId, itemId, ticketId, runId, evidence: [{ taskId, failureKind, classified }], decidedAt }` — one `evidence` row per failed primary task, recording exactly which durable evidence licensed the retry. The events-table `run_id` column is set to the item's pre-reset `runId`, which is always present for this event. The probe refuses fail-closed, in this order, when the campaign has no stored project directory (so delivery cannot be re-derived at all), when the ticket is provably delivered (closed, closing commit reachable on the base branch, lane evidence satisfied, no unresolved authoritative objection on its own run — refusal names `forge campaign reconcile`), when there is no linked run, when the run is absent from the store, when the run reached `complete`, when no failed primary task was recorded, or when any failed primary classifies non-transient. Logged inside the same transaction as the CAS-guarded reset, so a concurrent unpause that no-ops the reset logs no event either — the same atomicity `campaign_item.campaign_system_reconciled` uses.

  Distinct from `campaign_item.campaign_system_reconciled`: that event **ships** an item whose work turned out to be already delivered out-of-band; this one **re-drives** an item whose run was abandoned by a transient blip and never finished. The two can never both apply to the same item, and not by convention: retry's probe tests ship eligibility through `evaluateCampaignSystemShipEligibility` — the same out-of-band composition reconcile ships shape 3 on, minus reconcile's host-verification capture — and refuses the moment it holds, so a delivered item is reconciled rather than re-dispatched. Retry on `auth`/`infrastructure` logs no event at all — that `blockerKind` already is the classification, so there is no derived evidence to record. There is no corresponding `*_retry_refused` event; retry refusals are returned to the CLI, not persisted.

#### Validation-contract events

FG-523. Two task-scoped events carry the outcome of the [validation contract](concepts.md#validation-contract) — the rule that an implementer primary may not return `status: "complete"` without either a positive `tests_run` or a `no_validation_reason` waiver. No schema/column change accompanies them; they are ordinary `events` rows.

- `task.awaiting_gate` — already emitted whenever a task parks at a gate, but a **validation hold** adds a payload: `{ kind: "validation_contract", reason }`, where `reason` names the role and what was observed (e.g. `tests_run=0`). An ordinary human/verdict gate emits the event with no payload reason. `forge show <task-id>` reads the latest such event to render its `gate hold:` line and the `diagnostic.gateHold` JSON field — a task can be re-held, so latest wins, and an absent/empty `reason` renders nothing.
- `task.decision` — payload `{ kind: "validation_waiver", reason }`, emitted when a complete-without-`tests_run` result **advanced** on its `no_validation_reason` waiver. The waived result is the one case where the contract lets an unvalidated completion through, so the waiver is recorded rather than left implicit.

### `campaigns` / `campaign_items` tables

The dashboard reads these only to resolve a campaign item's `ticket_id` and its campaign's `project_dir`, for scoping a `host_verifications` evidence lookup by campaign item (`hostVerificationsForCampaignItem()` — `host_verifications` itself has no `campaign_id`/`item_id` column, see below). Columns read: `campaign_items.id`, `campaign_items.ticket_id`, `campaign_items.campaign_id`; `campaigns.id`, `campaigns.project_dir`.

`campaign_items.attempt_generation` — integer, `NOT NULL DEFAULT 0`, added by FG-596 (in `schema.ts` for new DBs, via `applyMigrations` in `db.ts` for existing ones). The item's **logical attempt generation**: a monotonic per-item counter bumped only on a genuinely new attempt (e.g. initial dispatch or an explicit `forge campaign retry` / `escalate-lane`) and reused unchanged on restart/reattach/re-drive. `0` means "not yet allocated" — the item has **not yet been driven** (also the read-back value of every pre-FG-596 row, no backfill), and a real dispatched attempt is `>= 1`. Initial dispatch atomically allocates generation `1` inside the single pre-dispatch reservation transaction (`reserveCampaignDriveDispatch`), so a generation-`0` item is the normal pre-drive state, not a failure condition. What the drive-item path fails closed on is a legacy/in-flight row with incompatible linkage — a `pending` item whose `run_id` still resolves to a real run row — never a generation-`0` item as such. It feeds the deterministic drive-item dispatch key (stamped into item-run control-plane metadata, see `runs` above) so a later slice (FG-564) can adopt a dead drive-item by key instead of duplicating it. Additive + `NOT NULL` with a safe default is the only SQLite `ADD COLUMN` shape that keeps old binaries tolerant of the extra column (the additive-only open-path discipline, BD-15). **Not part of the dashboard read contract** — documented here only so this file's update-in-the-same-commit rule catches the schema change.

### backlog ticket tables (FG-608 dashboard read path)

Since FG-608 the dashboard resolves `/api/backlog` tickets from the store by SQL, not by importing `@forge/backlog` and reading a checkout's `backlog/*.md`. Ticket truth is host-wide, keyed by `project_key`, so every checkout of one repository answers with the same rows.

The `project_key` is **derived, never accepted**: `backlogTruthForProject()` takes the dashboard's own resolved project record and looks its repository evidence key up in `project_identity`. A request parameter cannot be turned into a store key, which is what keeps this a per-project board (cross-project aggregation is FG-591). A repository with no `project_identity` row has never been imported and reports `projectKey: null` — no ticket truth, distinct from an empty board.

Tables and columns read:

- `project_identity` — `project_key` selected by `repo_evidence_key`.
- `ticket_storage_mode` — `mode` (`db` | `markdown`) for that key. `markdown` means the rows are a non-authoritative import shadow and the board badges them as such.
- `tickets` — `ticket_id`, `type`, `status`, `title`, `body`, `created`, `closed`, `closed_commit`, `epic`, scoped by `project_key`.
- `ticket_relations` — `related_id` where `rel_type = 'related'`.
- `blocker_evidence` — presence only, to reconstruct `blocked`.

**`blocked` is reconstructed, not stored** — the DB status vocabulary is exactly `active | done | deferred`, and legacy `blocked` is an `active` row plus a `blocker_evidence` row whose `source` is the literal `import-legacy-blocked`. Forge reconstructs it in `src/backlog/structured.ts`; the dashboard reconstructs it identically in `dashboard/src/queries.ts` or the board renders an unblocked-looking ticket the CLI calls blocked. **That literal exists in two places with no shared import** (`dashboard/src/queries.ts` and `src/store/tickets.ts`) — this file's standing drift caveat applies with unusual force, because each side's own tests write the string they read, so a drift in either copy stays green on both suites.

The snapshot database mounted into agent containers is a *different*, derived artifact with its own reduced schema (`src/backlog/snapshot.ts`) — not this contract. It is never the dashboard's read path.

### `host_verifications` table (FG-487 dashboard read path)

The trust evidence FG-440/FG-483/FG-474 ship decisions rest on — a real host command execution (`source = 'host'`) or a green required CI check consulted in place of one (`source = 'ci'`). Previously only readable via `forge campaign report` / sqlite; the dashboard now renders it directly (`hostVerificationsForTicket()`, `hostVerificationsForCampaignItem()`, `recentHostVerifications()` — `GET /api/host-verifications` and `GET /api/host-verifications/recent`).

Columns the dashboard reads: `id`, `ticket_id`, `project_dir`, `commit_sha`, `gate_name`, `command`, `exit_code`, `run_id` (nullable), `recorded_at`, `source` (`host | ci`), `ci_url` (nullable, `ci`-sourced rows only). Read via direct SQL against the dashboard's own handle (this file's established drift-surface caveat applies here too), not by importing `src/store/host-verifications.ts` — that module's exported lookups are single-gate/single-sha reuse-check helpers, not "everything recorded for this ticket," which is what an evidence view needs.

### `continuations` table (FG-562 durable continuation-claim primitive)

The durable claim that makes workflow advancement exactly-once over at-least-once completion delivery (BD-5). A controller that observes a launch reaching a terminal disposition records the observed disposition here and claims the single `awaiting_completion|ready -> dispatching` transition through a phase-bound compare-and-set. **Like the FG-425 `publication_attempts`/`publication_lane`/`publication_locks` trio, this is not part of the dashboard read contract** — it is the primitive FG-563 (orchestrator) and FG-564 (campaign) consume; documented here so a schema change is caught by this file's update-in-the-same-commit rule.

Columns: `continuation_id` (PK), `consumer_kind`, `source_launch_id`, `current_phase`, `next_action`, `state`, `claim_owner` (nullable), `claim_expires_at` (nullable epoch ms), `dispatch_key` (nullable), `dispatched_run_id` (nullable), `dispatched_task_id` (nullable), `last_observed_status` (nullable), `created_at`, `updated_at`. Indexes: `idx_continuations_launch` on `source_launch_id`; a partial `UNIQUE(dispatch_key) WHERE dispatch_key IS NOT NULL`.

Enum values are **convention, not a DB constraint** (FG-585 precedent — an old/new binary must never fight an enum constraint the other doesn't share):
- `consumer_kind`: `orchestrator | campaign` — unconstrained TEXT, no CHECK.
- `state`: `awaiting_completion | ready | dispatching | advanced | blocked` — unconstrained TEXT, no CHECK.
- `last_observed_status`: the canonical `LaunchStatus.state` from `readLaunch`/`classifyExit` (`running | exited_ok | exited_error | signaled | terminated_unattributed | owner_gone | unknown`) — no second terminal vocabulary (BD-10). `owner_gone`/`unknown` have no exit record and are recorded/claimable without one (BD-3 — a reconciled disposition never fabricates an exit record).

`next_action` is a canonically-serialized (stable key order) structured `{kind, …}` object, never an opaque shell string, so the CAS `next_action = ?` compare and the derived `dispatch_key` are stable across processes/versions. `dispatch_key` is the deterministic idempotency receipt derived from `(continuation_id, source_launch_id, canonical next_action)`, written at claim time before dispatch so a recovery adopts the original dispatch rather than duplicating it (F17). The table is additive-only (`CREATE TABLE IF NOT EXISTS` on the ordinary open path); the `dispatch_key` UNIQUE index is safe because only new binaries ever insert here (BD-15).

The primitive exposes the adoption + restart-replay MECHANISM the consumers call: `adoptOrClaimDispatch(req)` derives the receipt and returns `disposition:'adopt'` on an existing dispatch (else grants a fresh `ready -> dispatching` claim), and `continuationsInDispatch({consumerKind?})` returns the durable set of crash-window (`dispatching`, un-advanced) slots to replay after a controller restart. The CONSUMER (orchestrator FG-563 / campaign FG-564) drives the replay loop and performs the physical check-before-spawn (keying run-creation on `dispatch_key`, looking up an already-created run before re-dispatching) — that dispatcher is explicitly out of FG-562 scope; this table + `src/store/continuations.ts` provide only the primitive it consumes.

**What observe guarantees — and what it does not (BD-3).** `observeLaunchStatus(continuationId, sourceLaunchId, status)` does NOT accept a caller-asserted terminality. It VALIDATES that `status` is a real `LaunchStatus.state` (rejecting arbitrary text) and DERIVES terminality through the one canonical `isTerminalStatus` classifier (BD-10). A promotion `awaiting_completion -> ready` can therefore happen only for a status that IS a terminal `LaunchStatus.state`; a non-terminal (`running`) or invalid status can never promote, no matter what the caller claims. A non-terminal observation still records `last_observed_status` without promoting. What the primitive does NOT do: it records the caller-supplied observation but does not establish that the disposition matches the REAL launch — it trusts the observation it is given. Establishing that authority (reading `readLaunch`/`classifyExit` immediately before observing/claiming and passing that exact observation in) is the production CONSUMER's job (orchestrator FG-563 / campaign FG-564), where end-to-end BD-3/F17 enforcement is OPEN — this primitive delivers the mechanism, NOT the end-to-end guarantee. The controller passes the state `readLaunch`/`classifyExit` returned — two sources of truth, never joined; the primitive never reads the fs launch record itself.

### `continuation_stale_observations` table (FG-562 Finding 2 — durable stale-observation audit)

A durable, append-only audit of STALE observations: a delayed launch-completion event whose `source_launch_id` no longer matches the slot's current launch (the phase already advanced past it). The launch-bound `observeLaunchStatus` matches 0 rows in `continuations`; rather than SILENTLY discarding that evidence, it appends a row here — observed-RECORDED-and-ignored. A stale observation NEVER advances any phase and never touches the `continuations` slot.

Columns: `id` (PK, autoincrement), `continuation_id`, `source_launch_id` (the superseded/stale launch), `current_phase` (the slot's phase at observation time), `status` (the canonical `LaunchStatus.state` observed), `observed_at`. Index: `idx_continuation_stale_obs_cont` on `continuation_id`. Read audit-only via `staleObservationsFor(continuationId)`; the claim path never reads this table.

Additive-only (`CREATE TABLE IF NOT EXISTS` on the ordinary open path), the same BD-15 contract as `continuations` — an old binary that predates it is never broken, and only new binaries ever write it.

### `continuation_lost_signal_recoveries` table (FG-563 — durable lost-signal watchdog audit)

The durable evidence that a **lost completion signal was recovered**: the low-frequency health watchdog (`ScheduleWakeup`, demoted to a fixed 30-minute health cadence — BD-9) found a launch that reached a terminal disposition but was never advanced (its normal completion wake was lost), and the watchdog itself recovered it. A row is written **only** on that watchdog recovery, committed *before* the advance is observable; never on the normal delivery path (which advances without a lost signal), never when the watchdog re-arms a still-running launch, and never when the slot was already advanced (F18 — no false lost-signal claim). **Like `continuations` / `continuation_stale_observations`, this is not part of the dashboard read contract** — it is the FG-563 orchestrator consumer's audit; documented here so a schema change is caught by this file's update-in-the-same-commit rule. Read by the `forge lost-signals` operator command (`listLostSignalRecoveries`, newest-first) and `lostSignalRecoveriesFor(continuationId)`.

Columns: `id` (PK, autoincrement), `continuation_id`, `source_launch_id`, `current_phase`, `consumer_kind`, `controller` (WHICH controller recovered it), `observed_status` (the canonical terminal `LaunchStatus.state` the watchdog re-derived from the authoritative record, BD-3), `recovery_trigger`, `dispatch_key` (nullable), `dispatched_run_id` (nullable), `dispatched_task_id` (nullable), `recovered_at` (the store's own clock, `storeNowMs`). Indexes: `idx_continuation_lost_signal_cont` on `continuation_id`; `idx_continuation_lost_signal_launch` on `source_launch_id`. Enum values are **convention, not a DB constraint** (FG-585): `consumer_kind` (`orchestrator | campaign`) and `recovery_trigger` (`watchdog` today — a future recovery source can be added additively) are unconstrained TEXT, no CHECK.

**Distinct from `continuation_stale_observations`** (above) and never to be conflated: that table records a completion event that arrived for a *superseded* launch (the slot already moved past it — observed-and-ignored); this one records a *lost* completion the watchdog recovered. Different questions, different tables.

Additive-only (`CREATE TABLE IF NOT EXISTS` on the ordinary open path), the same BD-15 contract as its siblings — only a new binary ever writes it, so an old binary that predates it is never broken.

## Filesystem contract

Per-task workspace at `~/.forge/runs/<runId>/<taskId>/`:

- `manifest.json` — dispatch-time metadata for the task (see below)
- `result.json` — same content as `tasks.result` in the DB
- `container.stdout.log` — raw agent container stdout (JSON-stream from `claude --output-format stream-json`)
- `container.stderr.log` — raw container stderr
- `package.md` — the task package handed to the agent (inputs, output contract)
- `CLAUDE.md` — the composed system prompt the agent saw

The dashboard reads `container.stdout.log` and `container.stderr.log` for the detail view; the rest are for the human's inspection via `forge show` or direct filesystem access.

### `manifest.json` structure

Top-level fields written at dispatch time:

- `taskId` / `runId` — string identifiers
- `files` — map of well-known filenames (`prompt`, `package`, `result`, `stdout`, `stderr`)
- `container` — `{ name, idleTimeoutMs? }` — effective idle timeout resolved at dispatch
- `auth` — `{ profileRequested: boolean, stateMounted: boolean }` — booleans only; no credential material (see [redaction.md](redaction.md))
- `runtime` — `{ name, kind, logFormat, promptStrategy, authStrategy }` — execution behavior resolved from the runtime YAML. `name` is the resolved concrete runtime (e.g. `claude-apikey`), never the requested sentinel (`claude`) — matches `controlPlane.runtime.name` below (FG-366; the two could diverge for sentinel-resolved runtimes between FG-350 and FG-366)
- `model` — *(optional)* model resolution record (policy mode only); omitted in legacy mode
- `controlPlane` — *(optional)* RECORDED dispatch-time control-plane provenance; omitted on pre-FG-350 manifests (legacy-compatible)

#### `controlPlane` block

Written on all dispatch paths (forge invoke, pipeline single-step, fan-out children, and red tasks). Records the configuration that was **active at dispatch**; this is distinct from the *effective* current configuration and is never recomputed after the task starts. Absent on manifests written before FG-350 — consumers must degrade gracefully when `controlPlane === undefined`.

```
controlPlane: {
  workflow: {
    name: string,
    source: "host" | "project" | "synthetic" | "unknown",
    path?: string          // omitted for synthetic (forge invoke) and unknown
  },
  runtime: {
    name: string,           // resolved concrete runtime name (e.g. claude-apikey), not the requested sentinel
    source: "host" | "project",
    path: string
  },
  modelPolicy: {
    source: "host" | "project" | "absent",
    path?: string          // omitted when source is "absent"
  },
  routing?: {              // present only when dispatched under a route key
    routeKey: string,
    source: "host" | "project",
    policyPath: string,
    responsible: string,
    pathType: string,
    requiredFollowups: string[]
  },
  docsSurfaces: {
    source: "project" | "built-in",  // "project" only when .forge/docs-surfaces.yml is present AND valid; "built-in" when absent or invalid (invalid also appends a warning to warnings[])
    path?: string          // omitted when source is "built-in"
  },
  constraints: {
    dir: string,           // host path to the constraints directory
    suggestCount: number,  // suggest-level constraints matched for this task slot
    forceCount: number     // force-level constraints matched for this task slot
  },
  projectDir: string,
  mountMode: "rw" | "ro", // "ro" for red/review tasks; "rw" for primary, blue, and fan-out children
  warnings?: string[]      // non-fatal issues building this receipt (e.g. route lookup failed)
}
```

`source` values: `host` = resolved from the forge host installation; `project` = overridden by the project's `.forge/` directory; `synthetic` = built in-memory (no YAML file, always the case for `forge invoke` workflows); `absent` = no file found, legacy resolution used; `built-in` = forge's built-in default (project `.forge/docs-surfaces.yml` absent or invalid).

The block stores **no secrets, token material, or auth file paths** — only config file paths and resolved counts.

## Agent-output shapes the dashboard renders

These aren't enforced by forge — they're conventions in agent seeds. The dashboard's per-agent renderer expects them. If a seed changes its output schema, the dashboard falls back to JSON pretty-print until the renderer is updated.

### `architecture-advisor`

```json
{
  "status": "complete",
  "risks": [{"severity": "high|medium|low", "likelihood": "...", "summary": "...", "evidence": "...", "mitigation": "..."}],
  "constraints": [{"summary": "...", "rationale": "..."}],
  "boundaries": [{"summary": "...", "decision": "...", "rationale": "..."}],
  "priorArt": [{"reference": "src/...", "relevance": "..."}],
  "openQuestions": ["..."],
  "notes": "..."
}
```

### `tech-lead`

```json
{
  "status": "complete",
  "steps": [{"id": "1", "summary": "...", "files": ["src/..."], "acceptance": "..."}]
}
```

### `engineer` / `frontend-specialist` / `backend-specialist` / `security-advisor` / `agentic-platform-builder`

```json
{
  "status": "complete",
  "steps_completed": ["1", "2"],
  "diff_summary": "...",
  "files_modified": ["src/..."],
  "discipline": "frontend|backend|infosec|platform",
  "tests_run": 12,
  "tests_passed": 12,
  "tests_failed": 0,
  "no_validation_reason": "...",
  "notes": "..."
}
```

These five roles are the implementer roles, and their results are the ones the **validation contract** is enforced against (see [Validation contract](concepts.md#validation-contract)). A `status: "complete"` result from one of them, running as a workflow primary, must carry a numeric `tests_run` greater than zero — or a non-empty `no_validation_reason` string, the explicit waiver for a complete result with no validation path. Neither one, and the runner parks the task at `awaiting_gate` with a named hold reason instead of advancing it; a waived result advances and records a `task.decision` event with `kind: "validation_waiver"`. `no_validation_reason` is otherwise omitted.

### `test-engineer`

```json
{
  "status": "complete",
  "test_files_written": ["tests/..."],
  "tests_written": 12,
  "tests_run": 12,
  "tests_passed": 12,
  "tests_failed": 0,
  "coverage_summary": "..."
}
```

### `red-*` (red-wide, red-narrow, red-frontend, red-backend, red-security)

```json
{
  "status": "complete",
  "verdict": "pass|fail|inconclusive",
  "confidence": 0.0,
  "findings": [{"severity": "high|medium|low", "summary": "...", "evidence": "...", "hypothesis": "..."}],
  "notes": "..."
}
```

### Inferred result (narrative roles on pi runtime)

When `research-specialist`, `prompt-author`, or `manual-qa` runs on the pi runtime
and completes cleanly without writing `result.json`, forge synthesizes a result
rather than failing the task (FG-337). This shape can appear in `tasks.result` and
`result.json` for those roles:

```json
{ "contract": "inferred", "summary": "<final assistant message text>", "status": "complete" }
```

The `contract: "inferred"` field distinguishes a synthesized result from one the
agent produced. Only fires on pi; only for the three narrative roles; only on a
clean completion (no truncation, no model error). It is **not** the FG-540
structured stream recovery (above), which takes precedence over it and yields the
role's ordinary result shape — the agent's own JSON object, recovered from the
stream — never this one. The dashboard falls back to
JSON pretty-print for this shape — there is no per-role renderer for it.

## HTTP API surface (read-only)

The dashboard server exposes read-only JSON endpoints. All `GET` — no writes. Default base URL: `http://127.0.0.1:8024` (port overridable via `PORT` env var or `--port <n>` — `forge dashboard start` from a promoted release, or `./bin/forge-dev dashboard start` from a source checkout; the dashboard is bundled into the release as of FG-580).

### Core endpoints

| Endpoint | Query params | Description |
|---|---|---|
| `GET /api/feed` | `since`, `limit` (1–500, default 100), `projectDir` | Recent agent outputs across all projects |
| `GET /api/in-flight` | `projectDir` | Currently-running / awaiting-gate tasks |
| `GET /api/projects` | — | Project registry: name, color, last activity, live sessions |
| `GET /api/task/:id` | — | Full task detail (result + stdout/stderr + verdicts + gates) |
| `GET /api/governance` | `projectDir` | RACI Workbench panel (`WorkbenchPanel`): source, derived, effective, recorded (see shape below) |
| `GET /api/ops` | `since` (default `30d`), `projectDir` | Ops metrics rollup |
| `GET /api/usage` | `groupBy` (`role\|workflow\|project\|model\|alias`), `since` (default `30d`), `projectDir`, `limit` (1–200, default 50) | Token usage rollup by dimension |
| `GET /api/usage/timeseries` | `since` (default `30d`), `projectDir` | Daily token usage time-series |
| `GET /api/usage/model-mix` | `groupBy` (same as `/api/usage`), `since` (default `30d`), `projectDir` | Model distribution by dimension |
| `GET /api/verifications/in-progress` | `projectDir` | Host-side verification currently running (review-loop rounds, campaign reconcile real-exec gates), from unmatched `attemptId` starts, with `stale` flag (FG-487). `projectDir` filters strictly: review-loop rows via `runs.project_dir`, gate rows via `campaigns.project_dir` |
| `GET /api/review-loop/phases` | `projectDir` | Active review-loop runs with phase `verifying \| waiting-on-ci \| reviewing \| fixing` (FG-487) |
| `GET /api/host-verifications` | `ticketId` + optional `projectDir`, or `itemId` | host_verifications evidence rows scoped to a ticket or campaign item (FG-487) |
| `GET /api/host-verifications/recent` | `limit` (1–500, default 50) | Most recent host_verifications rows across all tickets — after-the-fact discoverability of bare host gates (FG-487) |
| `GET /api/backlog` | `projectKey` or `projectDir` | One project's tickets from the host store plus its per-checkout session notes. Returns `{notes, notesByCheckout, tickets, ticketsProjectKey, ticketsStorageMode, ticketsError?}` — `ticketsProjectKey: null` means the repository has no ticket truth (never imported), and `ticketsError` means the read failed and the count is unknown, never zero (FG-608) |

### `GET /api/governance` response shape (`WorkbenchPanel`)

Read-only. Returns a `WorkbenchPanel` JSON object with four top-level sections. No mutations are exposed — propose/apply is a separate future item.

- `source` — `{ kind: "project" | "host", raciPath: string }` — which RACI file is in force and its absolute path.
- `derived` — `{ policyPath: string, health: WorkbenchHealth, findings?: Finding[], accountable?: string }` — the compiled routing-policy state. `health` is one of `"ok" | "stale-drift" | "compile-error" | "uncompiled-override" | "policy-not-found"`. `findings` is present when health is not `"ok"`. `accountable` is the policy-level accountable field (present only when `ok` or `stale-drift`).
- `effective` — `{ routes: RouteMap, diff?: OverrideDiff } | null` — routes currently in force plus an optional host→project diff. `null` when the policy is broken and no effective routes exist.
- `recorded` — `{ entries: RaciAuditEntry[] }` — tail of `~/.forge/raci-audit.log` (up to 8 entries, newest first). Empty when no RACI changes have been recorded yet.

### `GET /api/task/:id` response shape

Returns `404` if the task is not found. On success, returns a JSON object with the full task detail. Top-level fields:

- `task` — the `ActivityEntry` object (taskId, runId, runTitle, workflow, projectDir, projectLabel, projectColor, agentRole, agentModel, phase, status, completedAt, durationMs, parentId, result)
- `stdoutLog` — nullable string: last 64 KB of `container.stdout.log`; `null` if the file doesn't exist
- `stderrLog` — nullable string: last 64 KB of `container.stderr.log`; `null` if the file doesn't exist
- `stdoutBytes` / `stderrBytes` — numbers: true on-disk file size (not the truncated tail length)
- `verdicts` — array of verdict objects from the `verdicts` table
- `gates` — array of gate objects from the `gates` table
- `events` — array of `{ eventType, payload, createdAt }` from the `events` table, ordered ascending
- `failureKind` — nullable string: `failure_kind` field from the most-recent `task.failed` event; `null` if the task didn't fail
- `idle` — nullable idle-countdown object (non-null only for running tasks)
- `resultSizeBytes` — nullable number: UTF-8 byte length of the raw `tasks.result` JSON string; `null` if the task has no result

## CLI surface (for mutations)

The dashboard does NOT write to the DB or filesystem. All mutating actions shell out to the `forge` binary, which must be on `$PATH` on the host running the dashboard.

Mutating commands the dashboard might invoke:
- `forge gate <taskId> advance | reject | request-changes [--rationale <text>] [--force]`
- `forge next <runId>`
- `forge retry <taskId>` — note that on an ad-hoc (`forge invoke`-attached) task this re-dispatches the agent in-process and does not return until it finishes, the same as `forge invoke` (FG-507; see [Task retry](concepts.md#task-retry)). On a workflow-step task it still returns immediately, leaving the new row for `forge next`.
- `forge new <workflow> "<title>" [...flags]`

This boundary is FORGE-DEC-015 carried forward from v1: dashboards don't bypass the CLI; the CLI's auth/validation/event-emission logic stays the single entrypoint for state changes.

## Versioning

No formal version row yet. If we need one later, propose:
- Add `schema_version` row to a `meta` table (new)
- Dashboard checks compatibility on startup; refuses to load on mismatch

For now: honor system. If you change a column or a result.json shape, update this doc + the dashboard in the same chunk of work.
