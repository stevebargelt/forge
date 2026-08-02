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
- `review_mode` — string, `NOT NULL DEFAULT 'legacy_verdict'`, added by FG-638. Which review authority model settles this run: `legacy_verdict | legacy_review_loop | evidence_led`. Unconstrained TEXT on `runs` (no CHECK — FG-585 precedent), and additive with a default rather than backfilled, so every pre-FG-638 row reads back `legacy_verdict` instead of `NULL`. **The run row is the single source of this fact for the ledger**; a review's own `review_mode` is a copy of it (see below). Since FG-640 the value is written by `startRun` from the **workflow's** declared `review_mode`, and the gate reads that same workflow declaration rather than this column — the run row is the durable per-run record and the reconciliation anchor, and the two disagreeing is itself a refusal (`review_mode_drift`, see [`review_disposition` gate](concepts.md#review_disposition-gate)). The dashboard reads it only via the `reviews` join, not on the run itself

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

### `reviews` / `review_findings` tables (FG-638 dashboard read path)

The durable [review ledger](concepts.md#review-ledger) — what forge *decided* about a candidate's findings, as opposed to the `verdicts` table's record of what reviewers *reported*. Both tables are brand-new as of FG-638 and arrive whole via `CREATE TABLE IF NOT EXISTS` on the additive-only open path; `user_version` is not bumped, and the `verdicts` table is untouched (a ledger finding points *back* at the verdicts that produced it through `sources_json` rather than rewriting them). Read by `reviewLedger()` — `GET /api/reviews` — as direct SQL against the dashboard's own handle, **not** by importing forge's `src/store/reviews.ts`. So the summary projection exists twice (`summarizeReview()` behind `forge review show`, `reviewLedger()` behind the dashboard) with no shared import, and this file's standing drift caveat applies with the usual force: each side's tests write the shape they read. The two are expected to agree on state, counts, and disposition per finding; only the CLI pair (human render vs `--json`) is machine-held to that.

`reviews` columns: `id` (PK, `review-<suffix>`), `run_id` (nullable), `subject_task_id` (nullable), `ticket_id` (nullable), `base_sha`, `contract_confirmed_sha`, `candidate_sha`, `trusted_remote_sha`, `contract_json` (nullable; the dashboard parses only `risk_lenses` out of it), `lens_outcomes_json` (nullable; **not** read by the dashboard — since FG-640 it holds more than one record shape in one array: the reviewer-authored per-lens outcomes, and operator lens acceptances tagged `kind: "lens_acceptance"`, which are filtered out of every "did discovery happen" read so an acceptance can never be counted as an outcome; since FG-650 a reviewer-authored outcome may additionally carry `toleratedRootKeys`, the sorted names of unknown ROOT keys stripped from that lens's output, present only on an outcome that carried some; since FG-654 it holds a **third** shape — `kind: "agent_protocol"` `{role, sha256, taskId, stage, at}`, one appended record per non-lens agent the review coordinator dispatches (`stage` is `fix_batch`, `docs`, or `recheck`; the `shipping-reviewer` is dispatched by the runner instead, so its stamp lands on its task manifest and nowhere here), filtered out of the outcome reads alongside acceptances — and a lens outcome of either shape may carry `protocol` `{role, sha256, taskId?}`, the same fact for a lens dispatch, where the lens name is already the key. Both are an INDEX of the dispatch's task manifest, which stays authoritative; records are appended and never edited, so a review spanning a `forge upgrade` records the mix), `stage_evidence_json` (nullable; added by FG-639; **not** read by the dashboard), `workspace_dir` (nullable; added by FG-649; **not** read by the dashboard), `review_mode`, `state`, `created_at`, `updated_at`, `settled_at` (nullable). The four SHAs are four different questions and none substitutes for another: `base_sha` is the implementation comparison base, `contract_confirmed_sha` the frozen anchor discovery reviewed, `candidate_sha` the mutable current candidate as remediation lands, `trusted_remote_sha` the fetched remote identity for final tip equality.

`stage_evidence_json` is the FG-639 coordinator's durable memory, and it answers a different question from `state`: `state` says where a review **is**, this says what it has already **done** and at which sha. Shape: a partial map from stage key — `verified_entry`, `contract_confirmed`, `discovery`, `fix`, `docs`, `verified_final`, `recheck`, `shipping` — to `{sha, at, detail?, meta?}`. For most stages **completion is per sha, never in the abstract**, which is what makes `forge review continue` after a crash a read rather than a guess: a stage recorded at the current candidate is never repeated merely because the process died, and a stage recorded at a superseded sha is correctly not complete for the candidate that exists now. Two stages are deliberate exceptions — `verified_entry` is checked on **existence alone** (it is the entry gate and runs once per review), and `fix` records the *pre*-fix candidate; before it completes, coverage is decided per finding rather than by comparing shas, and after it completes its existence is the review-wide one-remediation-batch boundary. If no `fix` record was needed, the existence of a completed `recheck` record closes the same remediation window. `recheck` also adds a second term to its sha rule: it is complete for its sha **and** for `meta.fixCycleKey`, the ingested or superseded fix-batch revisions present when the one remediation cycle completed (`<batch-id>@<revision>` joined by commas, `""` when no batch has been ingested). The key supports crash recovery, pre-completion replacement revisions, and legacy rows; it does not authorize another completed fix/recheck cycle. `meta` carries stage-specific durable detail (the batch id a fix stage consumed, the ids a recheck left unresolved, whether a stage was a legitimate no-op, and — on `contract_confirmed` — the recorded `no_drift` evaluation a confirmation rested on, as `{evaluation: "no_drift", noDrift: {diffSummary, statement}}`, which is where "evaluated, nothing to widen" stops being indistinguishable from silence). Since FG-650 `meta` is also where the validators' root-key tolerance is made visible: `discovery` carries `toleratedRootKeys` as a per-lens `{lens, keys}` list naming only the lenses whose output carried unknown ROOT keys, and `recheck` carries the rechecker's own flat name list (`[]` when its output carried none) — stripped keys are recorded rather than silently swallowed (see [Review coordinator](concepts.md#review-coordinator)). Additive and nullable, so every pre-FG-639 row reads back as "no stage completed".

`workspace_dir` (FG-649) is **which checkout this review's stages act on** — the answer to a question `forge review continue` previously re-derived from `process.cwd()` on every invocation. It is recorded by the same insert that records `base_sha`, re-recorded whenever an operator overrides it with `--project`, and it is what the coordinator's dispatch, diff and (since FG-649 moved the fix-cycle commit onto the coordinator) `git commit` all run against. The resolution order is: explicit `--project` (verified, then **recorded**) > the persisted `workspace_dir` > for a legacy row with none, the owning run's `project_dir` (adopted and **recorded**, so the next invocation is bound) > refuse. A `--dry-run` invocation runs the identical resolution and the identical refusals but writes nothing — the column is a durable statement about where later stages will commit, so a preview may read it but never rebind it. There is deliberately **no cwd fallback**: the store-first-with-cwd-fallback pattern is right for a read verb, and its fallback half fails in the least visible case — a deleted path, or a repository re-cloned elsewhere — by silently acting somewhere else. An unresolvable workspace is a named refusal with nothing written (`review_workspace_unbound`, `review_workspace_unusable`), and a path that resolves to a *different repository* than the review's run belongs to refuses `review_workspace_identity_mismatch` rather than being written into (identity via the converging `project_identity` evidence key, not string equality). Note this is **not** `runs.project_dir`: the store deliberately distinguishes the orchestrator's workspace from the target repo's project dir, and a review may name no run at all. Additive and nullable, so every pre-FG-649 row reads back as "unbound" — the shape the adopt-or-refuse arm exists for.

Unlike its siblings above, this pair **does** carry CHECK constraints. The FG-585 hazard those siblings avoid — an old and a new binary fighting over an enum the other does not share — cannot arise for a table that never existed before, since only new binaries ever write these; the same reasoning that makes `continuations`' `dispatch_key` UNIQUE index safe (BD-15):
- `reviews.review_mode` — `NOT NULL DEFAULT 'evidence_led'`, `CHECK IN ('legacy_verdict', 'legacy_review_loop', 'evidence_led')`. A **copy** of the owning run's `review_mode`, denormalized so a read surface need not join to answer "which authority model settles this review". The run row is authoritative: a run still carrying the column's `legacy_verdict` default and owning no review adopts its first review's mode atomically at insert; a run already marked (explicitly, or implicitly by owning a review) refuses a conflicting mode rather than letting run and ledger disagree.
- `reviews.state` — `NOT NULL DEFAULT 'confirming_contract'`, `CHECK` over the 11 lifecycle states: `confirming_contract`, `discovering`, `awaiting_disposition`, `fixing`, `documenting`, `verifying`, `rechecking`, `shipping_review`, `settled`, `blocked_environment`, `failed`. FG-638 only *persisted* these and emitted an event per transition; FG-639 shipped the stage machine that drives them (see [Review coordinator](concepts.md#review-coordinator)). Note `blocked_environment` is a **stop, not a terminal state** — the coordinator's next transition out of it re-enters whichever deterministic verification stage blocked (entry or final), so the row keeps reading `blocked_environment` until the environment clears and the same review resumes.

`review_findings` columns: `id` (PK, the globally unique `<review-id>/RF-n`), `review_id` (`REFERENCES reviews(id) ON DELETE CASCADE`), `ordinal` (`UNIQUE (review_id, ordinal)`), `finding_ref` (the `RF-n` an operator types), `fingerprint`, `summary` (`NOT NULL DEFAULT ''`), `severity`, `risk_lens`, `finding_type`, `evidence`, `hypothesis`, `reachability`, `file`, `line`, `quoted_text`, `acceptance_ref`, `invariant_ref`, `sources_json`, `disposition`, `disposition_rationale`, `disposition_evidence`, `decided_by`, `decided_at`, `decided_candidate_sha`, `duplicate_of`, `followup_ticket_id`, `resolution`, `resolution_evidence_kind`, `resolution_evidence`, `discovered_sha`, `resolved_sha`, `created_at`, `updated_at`. Index: `idx_review_findings_review` on `review_id`.

The dashboard reads every one of those except `fingerprint`, `finding_type`, `evidence`, `hypothesis`, `ordinal` (used for ordering only), `disposition_evidence`, `decided_at`, `decided_candidate_sha`, `discovered_sha`, `resolved_sha`, and the timestamps.

- `disposition` — `NOT NULL DEFAULT 'untriaged'`, `CHECK IN ('untriaged', 'fix_now', 'accepted_risk', 'deferred', 'rejected_premise', 'duplicate', 'architecture_question')`. **`disposition` and `resolution` are separate columns on purpose**: disposition answers what forge decided to *do*, resolution answers whether an accepted fix is *proven complete*. Collapsing them is how "we decided to fix it" silently reads as "it is fixed" — so both surfaces report counts by disposition **and** by resolution, and a `fix_now` whose `resolution` is not `resolved` counts as unsettled. `resolution` itself is unconstrained TEXT; a `NULL` renders as `unresolved` in the counts.
- `sources_json` — `NOT NULL DEFAULT '[]'`; a JSON array of every reviewer/verdict that produced the observation, each `{verdictId?, redTaskId?, redRole?, authority?, modelFindingId?, note?}`. A deduplicated finding keeps them all, and a `duplicate` disposition merges the duplicate's sources into the canonical row — the count is **provenance, never an "independent review count"**. `modelFindingId` is the id the reviewing model invented for itself: retained here as provenance and never honored as the row's identity.
- `decided_by` — unconstrained TEXT, `operator | orchestrator`. Under the single-user trust model this is an explicit confirmation (the `--operator` flag on the CLI invocation *is* the operator act, exactly as a `forge gate` human decision is), **not** authenticated identity — the FG-597 caveat carried forward.

**Populated by the FG-639 coordinator.** FG-638 shipped the tables, the store module, the events, and the read/disposition surfaces; FG-639 shipped the writer — `forge review start` opens a review and ingests findings, `forge review continue` advances it. Those two verbs are still the only writer, but since FG-640 the rows are no longer incidental: the `feature` workflow declares `review_mode: evidence_led`, so its build gate is settled from this ledger and a run of it cannot advance without one (`review_absent`). On an unmigrated workflow these tables stay empty until an operator runs `forge review start`. A dashboard pointed at a store whose last **writable** open predates FG-638 will not have them at all (a read-only open never migrates — see `GET /api/reviews` below).

#### FG-638: review-ledger lifecycle events

The append-only half of the ledger: the rows above carry current state, these carry how it got there. Ordinary `events` rows, no schema change.

- `review.created` — payload `{ reviewId, reviewMode, state, ticketId, candidateSha, runReviewModeAdopted }`. `runReviewModeAdopted: true` is the audit record that this insert moved a never-marked run's `review_mode` in the same transaction.
- `review.state_changed` — payload `{ reviewId, from, to, reason, at }`, emitted on **every** transition including a no-op re-entry (so a coordinator that re-enters a stage after a crash is visible rather than silent). A row alone cannot say when a review entered `awaiting_disposition`.
- `review.finding_ingested` — payload `{ reviewId, findingId, findingRef, summary, sourceCount, modelSuppliedId }`. Naming both the forge-assigned id and the model-supplied one (or `null`) keeps "the reviewer called it CVE-1, forge calls it RF-3" auditable.
- `review.finding_dispositioned` — payload `{ reviewId, findingId, findingRef, disposition, decidedBy, decidedAt, candidateSha, rationale, evidence, duplicateOf, followupTicketId }` — the durable record behind the authority rules.

#### FG-639: coordinator and FixBatch events

The coordinator's own audit half. Ordinary `events` rows, no schema change.

- `review.stage_completed` — payload `{ reviewId, stage, sha, at, detail, meta }`. Names the stage **and** the sha it completed against; this is the durable answer to "what has this review already done", which is what makes resuming after a crash a read rather than a guess.
- `review.finding_resolution_recorded` — payload `{ reviewId, findingId, findingRef, resolution, evidenceKind, resolvedSha }`. What a recheck **established** for one finding id (`resolved` | `still_present` | `inconclusive`). A resolution is candidate-bound, so the event says which candidate it was proven at.
- `review.resolutions_invalidated` — payload `{ reviewId, fromSha, toSha, findingIds, why }`. The candidate moved, so resolutions proven at the old sha stopped being evidence about the new one; the payload names every finding whose resolution was cleared.
- `review.fix_batch_created` — payload `{ reviewId, fixBatchId, revision, candidateSha, supersedes, payloadSha256, findingIds }`. `supersedes` is the previous batch id or `null`.
- `review.fix_batch_dispatched` — payload `{ reviewId, fixBatchId, revision, payloadSha256 }`, pairing the batch with the task that consumed it.
- `review.fix_batch_ingested` — payload `{ reviewId, fixBatchId, revision, payloadSha256, results: [{findingId, result}], repeat }`. Delivery is at-least-once and application is idempotent, so `repeat: true` records that this ingest was a redelivery rather than pretending it was the first.

#### FG-640: gate and lens-selection events

- `review.lenses_selected` — payload `{ step, selected: [<agent>], skipped: [<agent>], reason }`, on the run and the step's primary task. Emitted by `dispatchReds` **only when the plan-gate-approved contract narrowed the panel** (`skipped` non-empty) — a narrower panel is a decision, and an operator reading a run with three reds where the workflow declares six needs to see that it was selection rather than three reds failing to start. Never emitted under a legacy `review_mode`, where `reds` still means all of them.
- `review.lens_accepted` — payload `{ reviewId, lens, missingEvidence, rationale, candidateSha, acceptedBy, acceptedAt }`. The third route by which an absent lens clears (`forge review accept-lens`, operator authority). The payload NAMES the missing evidence and the candidate it was accepted against: an acceptance is a decision about one candidate's missing review, never a standing waiver.
- `gate.decided` gains `gateKind: "review_disposition"` — **only** on the steps the new gate actually decides (an `evidence_led` workflow's `gate: verdict` step). A legacy run's payload is byte-identical to what it has always been, so the key's presence is itself the discriminator.

### `fix_batches` / `fix_batch_results` tables (FG-639 FixBatch delivery)

The durable FixBatch of PRD Appendix A — the unit of work Stage 5 of the [review coordinator](concepts.md#review-coordinator) hands to **one** fixer for the whole `fix_now` set. Two more brand-new tables arriving whole via `CREATE TABLE IF NOT EXISTS` on the additive-only open path; `user_version` untouched. **Like `continuations`, this is not part of the dashboard read contract** — documented here so a schema change is caught by this file's update-in-the-same-commit rule. They carry CHECK constraints for the same reason the review pair does: only new binaries ever write a table that never existed before, so the FG-585 old-vs-new enum hazard cannot arise.

`fix_batches` columns: `id` (PK, `fix-batch-<suffix>`), `review_id` (`REFERENCES reviews(id) ON DELETE CASCADE`), `revision`, `candidate_sha`, `supersedes_batch_id` (nullable), `payload_json`, `payload_sha256`, `state`, `dispatch_task_id` (nullable), `created_at`. `UNIQUE (review_id, revision)`.

- **A batch is immutable at a revision.** Nothing updates `payload_json` or `payload_sha256` after insert: before Stage 5 completes, a changed disposition set or candidate may create the **next** revision and supersede this one, so a fixer already running stays bound to the scope it was dispatched with. Once Stage 5 records completion, the review cannot create another batch revision; later `fix_now` decisions stop at disposition for follow-up. `state` and `dispatch_task_id` are the only mutable columns and neither is part of the payload the fixer sees.
- `fix_batches.state` — `NOT NULL DEFAULT 'open'`, `CHECK IN ('open', 'dispatched', 'ingested', 'superseded')`.
- `payload_sha256` is what makes the delivery snapshot verifiable. Forge materializes the payload to `$FORGE_HOME/reviews/<review-id>/<fix-batch-id>/payload.json` (alongside an `envelope.json`), reads the bytes back, and **re-hashes them against the persisted value before the container starts** — a mismatch is a refusal, because a fixer working from an unverified snapshot is one whose scope nobody can reconstruct later. SQLite stays authoritative; the files are a snapshot of it. That host directory is keyed on the **batch**, not on a task, because delivery is at-least-once and a retry must read back the same bytes that hashed to the persisted value.
- **The bundle is delivered INSIDE the container, and the prompt names only in-container paths.** The host directory above is on no mount, so naming it in the fixer's task package named a path the fixer could not open (found by the live pilot: the fixer honestly reported the handoff undelivered and ingestion refused its empty result). The verified bytes now ride the `/task` bind that already carries `CLAUDE.md` / `package.md` / `result.json`, as `/task/fix-batch/payload.json` and `/task/fix-batch/envelope.json` — the mechanism is `InvokeArgs.taskFiles`, extra input files materialized into the task dir before the container starts, whose keys are confined at the invoke layer (an empty key, an absolute path, a traversal, a directory key, and the task dir's own reserved artifact names each refuse before anything is written). The prompt names those two paths and the payload's sha256 as delivered, and claims no tamper-evidence for them: it says outright that `/task` is writable, that nothing downstream reads those copies back, and that a result is validated against the **host's** expected finding set for that batch and revision regardless of what the delivered files say.
- **Both halves are verified against the store, neither trusted from disk** — and the bytes verified are the bytes delivered. The payload is re-hashed against `payload_sha256`; the envelope is compared byte-for-byte against a rendering re-derived from the batch row (re-read from the store, not taken from the caller), because the envelope carries the batch identity the fixer reports back under. A refusal here is **pre-container**, so it leaves the batch `open` at this revision: the same revision and payload hash are re-entered on retry rather than being recorded as a delivery that never happened.

`fix_batch_results` columns: `batch_id` (`REFERENCES fix_batches(id) ON DELETE CASCADE`), `task_id`, `finding_id`, `result`, `summary` (nullable), `files_changed_json` (`NOT NULL DEFAULT '[]'`), `evidence` (nullable), `interaction` (nullable), `evidence_path` (nullable), `evidence_sha256` (nullable), `ingested_at`. `PRIMARY KEY (batch_id, task_id, finding_id)`.

- `fix_batch_results.result` — `NOT NULL`, `CHECK IN ('fixed', 'scope_change', 'not_fixed')`.
- **The composite primary key *is* the idempotence key.** Delivery is at-least-once, so re-ingesting the same fixer result must not apply it twice: an INSERT conflicting on this key is a no-op rather than a second application.
- **Agents never write here.** The host ingests from the task's output area, and ingestion validates schema plus batch identity and requires **exactly one** result per expected finding id — an unknown, duplicated, or omitted id is a named refusal, not a partial apply.

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
- `agentProtocol` — *(optional)* `{ role, sha256, source }` — which generation of the Forge-owned agent protocol this agent ran under (FG-654). A **sibling** of `controlPlane`, not a field inside it, but written under the same discipline: fixed at dispatch, never recomputed. `sha256` digests the WHOLE protocol file's bytes as read out of the published seed generation, and `source` is that file's path INSIDE the generation (`<generation>/agent-protocols/<role>.md`) — never the operator's own `~/.forge/agents/<role>/CLAUDE.md`, which forge does not write and whose edits therefore cannot move this hash. Present only for a role the review lifecycle dispatches (the five `red-*` lenses plus `engineer`, `documentation-maintainer`, `review-rechecker`, `shipping-reviewer`) — an uncovered role has no protocol to record. Omitted on pre-FG-654 manifests. It is resolved by the same compose that produced the prompt, not re-derived at manifest-write time, so the prompt and its receipt cannot describe different generations; a retry re-resolves and re-stamps rather than replaying the original. This manifest is AUTHORITATIVE for the fact — the review ledger's copy in `lens_outcomes_json` is an index of it

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

Running as an evidence-led **discovery lens** is a different contract, stated in the coordinator's own dispatch prompt: the root is `outcome` (`pass | fail | inconclusive`), `findings`, and `inconclusive_reason` (required when the outcome is `inconclusive`), and each finding carries the discovery fields (`risk_lens`, `reachability`, `challenges_contract`, `remediation_advice`, plus the anchor). The verdict-shape root keys above that come along anyway — `status`, `verdict`, `confidence`, `notes` — are tolerated since FG-650: stripped, with their names recorded on the lens outcome. A finding is still validated closed, so a verdict-path enrichment on a *finding* refuses the whole lens (see [Review coordinator](concepts.md#review-coordinator)).

### `review-rechecker` (FG-639 Stage 8)

Not a `red-*` verdict shape. The rechecker answers per finding id, and the host refuses the whole result rather than reading an omitted id as a resolution.

```json
{
  "review_id": "review-xxxx",
  "candidate_sha": "abc1234",
  "rechecked": [{
    "finding_id": "review-xxxx/RF-1",
    "result": "resolved|still_present|inconclusive",
    "evidence_kind": "regression_test|replayed_reproduction|anchored_verification|bounded_inspection",
    "evidence": {"kind": "regression_test", "test_name": "...", "test_file": "...", "runner_output": "..."},
    "note": "..."
  }],
  "new_findings": [{
    "summary": "...", "evidence": "...", "severity": "...",
    "risk_lens": "wide|narrow|frontend|backend|security",
    "reachability": "demonstrated|supported|speculative",
    "challenges_contract": false, "remediation_advice": "..."
  }]
}
```

`review_id` and `candidate_sha` must match the task package's, and `rechecked` must carry **exactly one** entry per expected finding id — an unknown, duplicated, or omitted id is a named refusal. `evidence` is validated structurally against the finding's original `reachability` and the skip-evidence rule (`src/v2/review-evidence.ts`); see [A skipped test is never evidence](concepts.md#a-skipped-test-is-never-evidence). `new_findings` carry the same required shape as a discovery finding and enter the ledger `untriaged`.

Unknown keys at the **root** of that result — `status` above all, which the harness output contract requires in every `result.json` — are tolerated, but since FG-650 they are also **named**: the root strips them from the validated value and records their names in the `recheck` stage record's `meta.toleratedRootKeys`, where before they rode along unnamed. `review_id` and `candidate_sha` stay required, every root field keeps its type, and the entries inside `rechecked` and `new_findings` stay closed: an unknown key **there** still refuses the whole result.

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
| `GET /api/reviews` | `limit` (1–200, default 25), `projectKey` or `projectDir` | The [review ledger](concepts.md#review-ledger), read-only: reviews most-recently-touched first, each with its findings **embedded** (not a second round trip — a summary whose counts disagree with the rows below it is the failure that avoids). Returns `{reviews: ReviewLedgerEntry[], error?}`. Scoped through the owning run's `project_dir`; a review with no run is unscoped and always listed. `error` is set — with `reviews: []` and still HTTP `200` — when the read failed, notably a store whose last writable open predates FG-638 and therefore has no `reviews` table (`no such table: reviews`); a read-only open never migrates one into existence, so that is a legitimate state to report, not a server fault (FG-638) |
| `GET /api/backlog` | `projectKey` or `projectDir` | One project's tickets from the host store plus its per-checkout session notes. Returns `{notes, notesByCheckout, tickets, ticketsProjectKey, ticketsStorageMode, ticketsError?}` — `ticketsProjectKey: null` means the repository has no ticket truth (never imported), and `ticketsError` means the read failed and the count is unknown, never zero (FG-608) |

### `GET /api/governance` response shape (`WorkbenchPanel`)

Read-only. Returns a `WorkbenchPanel` JSON object with four top-level sections. No mutations are exposed — propose/apply is a separate future item.

- `source` — `{ kind: "project" | "host", raciPath: string }` — which RACI file is in force and its absolute path.
- `derived` — `{ policyPath: string, health: WorkbenchHealth, findings?: Finding[], accountable?: string }` — the compiled routing-policy state. `health` is one of `"ok" | "stale-drift" | "compile-error" | "uncompiled-override" | "policy-not-found"`. `findings` is present when health is not `"ok"`. `accountable` is the policy-level accountable field (present only when `ok` or `stale-drift`).
- `effective` — `{ routes: RouteMap, diff?: OverrideDiff } | null` — routes currently in force plus an optional host→project diff. `null` when the policy is broken and no effective routes exist.
- `recorded` — `{ entries: RaciAuditEntry[] }` — tail of `~/.forge/raci-audit.log` (up to 8 entries, newest first). Empty when no RACI changes have been recorded yet.

### `GET /api/reviews` response shape (`ReviewLedgerEntry`)

Read-only (FG-638). Each entry is the `reviews` row camelCased — `id`, `runId`, `subjectTaskId`, `ticketId`, `baseSha`, `contractConfirmedSha`, `candidateSha`, `trustedRemoteSha`, `reviewMode`, `state`, `createdAt`, `updatedAt`, `settledAt` — plus four fields that are **derived, not stored**:

- `projectDir` — joined from the owning run, `null` for a review with no run.
- `riskLenses` — `contract_json`'s `risk_lenses` array, `[]` when there is no contract or no such key.
- `countsByDisposition` / `countsByResolution` — `Record<string, number>` over this review's own findings; an absent `resolution` is counted under the literal `unresolved`.
- `findings` — `ReviewLedgerFinding[]`, ordered by `ordinal`, each carrying `sources` parsed from `sources_json`.

Disposition controls are deliberately **not** exposed: the ledger's write surface is `forge review disposition` on the CLI, and the dashboard stays read-only until that surface is proven.

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
