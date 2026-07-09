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
- `status` — string, one of `active | complete | abandoned`
- `created_at` — ISO 8601 timestamp string
- `completed_at` — nullable ISO 8601 timestamp string
- `project_dir` — nullable string, the host path mounted at `/project` for this run's containers
- `metadata` — nullable JSON string. Dashboard does not currently parse fields beyond looking at the full blob

### `tasks` table

- `id` — string, primary key
- `run_id` — string, foreign key to runs
- `parent_id` — nullable string, foreign key to tasks (red children and retry chains)
- `phase` — string, matches the workflow step id
- `agent_role` — string (e.g. `architecture-advisor`, `engineer`, `red-wide`)
- `status` — string, one of `pending | running | awaiting_gate | awaiting_red | complete | failed | blocked_by_red`
- `result` — nullable JSON string. Dashboard parses + dispatches to per-agent renderer based on `agent_role`
- `created_at` / `started_at` / `completed_at` — nullable ISO 8601
- `error` — nullable string
- `worktree_path` — nullable string, the host filesystem path of the task's git worktree when worktree mode is enabled (`FORGE_WORKTREES=1`). `null` for default bind-mount runs. Set durably before container dispatch so it survives process restart. Task branch identity is derived deterministically as `forge/<runId>/<taskId>` and is not stored separately. Added by FG-351; additive and nullable — pre-FG-351 rows and dashboard code that does not read this column degrade gracefully.

  Fan-out steps additionally create a step-scoped **integration branch** (`forge/<runId>/<parentTaskId>/integration`) checked out at `~/.forge/worktrees/<runId>/<parentTaskId>/integration`. Child branches are merged into this integration tree sequentially (in child index order, `--no-ff`) before fan-out reds review it. The integration branch and worktree are not tracked in the `tasks` table; they are retained on conflict or failure (for inspection) and removed only after the integration branch successfully fast-forward-merges to HEAD. Three lifecycle events mark the integration path in `forge show`: `integration.worktree_created`, `integration.child_merged`, and `integration.merged_to_head`. This behavior is active only when `FORGE_WORKTREES=1` (FG-353).

  A successful fast-forward merge to HEAD (single-step or fan-out) is not itself the last check: forge then runs the **post-merge integration gate** (FG-357) against the merged tree on the host before the step is final. Gate failure records one of three `failureKind`s on the task (distinct from `merge_conflict`): `"integration_failed"` for a genuine test-suite failure, or `"integration_gate_timeout"`/`"integration_gate_crashed"` (FG-424) when the gate run itself timed out or was killed by signal — the merged worktree/branch are retained in all three cases, not cleaned up. See [Post-merge integration gate](concepts.md#post-merge-integration-gate).

### `verdicts` table

- `id`, `task_id`, `red_task_id` — strings
- `red_role` — string
- `verdict` — string, one of `pass | fail | inconclusive`
- `confidence` — number, 0.0–1.0
- `authority` — string, one of `triage | specialist | authoritative`
- `findings` — JSON string (array of `{severity, summary, evidence, hypothesis}`)
- `created_at` — ISO 8601

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

#### Campaign-item reconcile decision events

Emitted by `forge campaign reconcile`'s (or the drive-time equivalent's) write path the moment an item is shipped, carrying the re-derived evidence in `payload.evidence` for audit purposes. `run_id` is the events-table column, set to the item's `runId` (nullable). No schema/column change accompanies any of these — they differ only in `event_type` and are how the audit trail distinguishes *why* an item was recoverable.

- `campaign_item.evidence_reconciled` — a scope-blocked item (`blockerKind:'scope'`, `lifecycleStatus` `failed` or `blocked_by_red`) wedged on a stale historical authoritative red-fail. Payload: `{ campaignId, itemId, ticketId, evidence, decidedBy, decidedAt }`.
- `campaign_item.out_of_band_reconciled` — an `awaiting_gate`/no-`blockerKind` item delivered through a re-routed, non-pipeline lane rather than the feature run itself. Payload: same shape as above.
- `campaign_item.campaign_system_reconciled` — FG-502: a `blockerKind:'campaign_system'` item with `lifecycleStatus` `failed` or `blocked_by_red` (parked there by one of `executor.ts`'s own salvage/gap/fallback producers — a non-`complete` run status, a done-audit gap after a passing verdict, or an unresolved-outcome fallback, all leaving `failed` — or by `driveWorkflowItem`'s inconclusive-verdict park, a fourth producer leaving `blocked_by_red`) that reconcile proved was actually delivered out-of-band, via the identical evidence bar `campaign_item.out_of_band_reconciled` uses (ticket done + closed commit reachable + lane evidence + no unresolved authoritative objection on its own run). Payload: same shape as above. Kept distinct from `out_of_band_reconciled` so the audit trail can tell "delivered via a re-routed lane" apart from "recovered from a campaign-system-side failure that turned out to already be shipped."

### `campaigns` / `campaign_items` tables

The dashboard reads these (in addition to `@forge/backlog`) only to resolve a campaign item's `ticket_id` and its campaign's `project_dir`, for scoping a `host_verifications` evidence lookup by campaign item (`hostVerificationsForCampaignItem()` — `host_verifications` itself has no `campaign_id`/`item_id` column, see below). Columns read: `campaign_items.id`, `campaign_items.ticket_id`, `campaign_items.campaign_id`; `campaigns.id`, `campaigns.project_dir`.

### `host_verifications` table (FG-487 dashboard read path)

The trust evidence FG-440/FG-483/FG-474 ship decisions rest on — a real host command execution (`source = 'host'`) or a green required CI check consulted in place of one (`source = 'ci'`). Previously only readable via `forge campaign report` / sqlite; the dashboard now renders it directly (`hostVerificationsForTicket()`, `hostVerificationsForCampaignItem()`, `recentHostVerifications()` — `GET /api/host-verifications` and `GET /api/host-verifications/recent`).

Columns the dashboard reads: `id`, `ticket_id`, `project_dir`, `commit_sha`, `gate_name`, `command`, `exit_code`, `run_id` (nullable), `recorded_at`, `source` (`host | ci`), `ci_url` (nullable, `ci`-sourced rows only). Read via direct SQL against the dashboard's own handle (this file's established drift-surface caveat applies here too), not by importing `src/store/host-verifications.ts` — that module's exported lookups are single-gate/single-sha reuse-check helpers, not "everything recorded for this ticket," which is what an evidence view needs.

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
  "notes": "..."
}
```

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
clean completion (no truncation, no model error). The dashboard falls back to
JSON pretty-print for this shape — there is no per-role renderer for it.

## HTTP API surface (read-only)

The dashboard server exposes read-only JSON endpoints. All `GET` — no writes. Default base URL: `http://127.0.0.1:8024` (port overridable via `PORT` env var or `forge dashboard start --port <n>`).

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
- `forge retry <taskId>`
- `forge new <workflow> "<title>" [...flags]`

This boundary is FORGE-DEC-015 carried forward from v1: dashboards don't bypass the CLI; the CLI's auth/validation/event-emission logic stays the single entrypoint for state changes.

## Versioning

No formal version row yet. If we need one later, propose:
- Add `schema_version` row to a `meta` table (new)
- Dashboard checks compatibility on startup; refuses to load on mismatch

For now: honor system. If you change a column or a result.json shape, update this doc + the dashboard in the same chunk of work.
