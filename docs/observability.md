# Observability Roadmap

Forge already records useful evidence: run rows, task rows, event rows, verdicts,
container stdout/stderr logs, `result.json`, model usage, `forge status`,
`forge watch`, and the dashboard. The gap is that these pieces do not yet form a
coherent agent-ops view.

When a workflow stalls or fails, Forge should answer four questions quickly:

1. What happened?
2. Where is the run stuck?
3. What did the agent/container/tool do last?
4. What should the orchestrator or human do next?

This roadmap turns observability into crawl, walk, and run stages. The emphasis
is practical: build on Forge's existing SQLite store, event log, task directory,
and Docker executor before introducing heavier tracing infrastructure.

> **Status:** Crawl and Walk have shipped. The events table is readable
> (`eventsForTask`/`eventsForRun`), `forge show` is the diagnostic detail view,
> failure kinds are classified, `forge status`/`watch` and the dashboard surface
> live task activity, and agents can emit optional progress records. The
> "Current State" section below is the original pre-Crawl motivation, kept for
> context; the Run stage is the remaining work.

## Goals

- Make every run explainable after the fact.
- Make running tasks inspectable while they are still running.
- Separate failure classes so humans and orchestrators do not have to parse
  prose error strings.
- Preserve enough evidence to debug Forge itself without reading the whole
  project or every log file manually.
- Keep the orchestrator-driven model: observability should guide the
  orchestrator, not replace it with hidden automation.

## Current State

Forge has these useful primitives today:

- `runs` table: run identity, workflow, status, project, metadata.
- `tasks` table: task identity, phase, role, status, package, result, error.
- `events` table: lifecycle events are written here. (Pre-Crawl this table was
  write-only; the Crawl milestone added `eventsForTask`/`eventsForRun` and the
  `forge show` timeline, so the events are now read back across the CLI and
  dashboard.)
- `verdicts` table: red-agent findings and authority.
- Per-task files: `CLAUDE.md`, `package.md`, `result.json`,
  `container.stdout.log`, `container.stderr.log`.
- Docker idle watchdog and live log streaming.
- Commands: `forge status`, `forge show`, `forge watch`, `forge cancel`,
  `forge retry`, `forge advise`, dashboard views.

The weak point is twofold. First, the lifecycle event log is write-only: forge
faithfully records `task.created`, `task.started`, `gate.decided`, and the rest,
but nothing reads them back, so a human reconstructs what happened from logs and
`result.json` *despite* the events, not from them. Second, even what can be read
is scattered — there is no single timeline that presents status, failure kind,
last activity, artifacts, and next action together. Crawl fixes the first
(make the existing events readable) before adding more.

## Design Principles

- Prefer structured events over prose-only logs.
- Keep raw logs, but summarize and index them.
- Record status transitions in one consistent place.
- Treat failure kind as data, not just text.
- Make commands useful for both humans and orchestrators with `--json`.
- Do not require agents to emit perfect telemetry; infer what Forge can, and use
  optional agent progress events when available.
- Redact or avoid secrets in all persisted observability artifacts.

## Crawl

The crawl stage makes completed and failed work explainable. It should be
read-first: turn the existing events table into a usable timeline before adding
more event emissions or new commands.

### 1. Expose Existing Events

The first change should not add new event types or schema. It should make the
events Forge already writes visible and reusable.

Add read accessors:

- `eventsForTask(taskId)`
- `eventsForRun(runId)`

Then render those timelines in `forge show`.

For a task, include:

- task lifecycle events
- run-level events for the task's run, when useful
- verdict events tied to the task
- timestamps and structured payloads

For a run, include:

- run lifecycle events
- task events grouped by task or ordered as one timeline
- gate and verdict events

Acceptance criteria:

- `forge show <task-id>` displays an event timeline from existing data.
- `forge show <run-id>` displays a run timeline from existing data.
- No schema change.
- No new event emissions required for the first slice.
- This read path becomes the foundation for richer `forge show` diagnostics.

### 2. Normalize Lifecycle Events

After existing events are readable, backfill missing lifecycle emissions. Every
meaningful run or task transition should emit an event. No task should move
status silently.

Suggested event vocabulary:

- `run.created`
- `run.completed`
- `run.abandoned`
- `run.cancelled`
- `task.created`
- `task.started`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.awaiting_gate`
- `task.awaiting_red`
- `task.blocked_by_red`
- `container.started`
- `container.exited`
- `container.killed`
- `container.idle_timeout`
- `auth.profile_applied`
- `auth.profile_failed`
- `gate.decided`
- `verdict.received`

Acceptance criteria:

- `forge show <task-id>` can reconstruct a task timeline from events.
- `forge show <run-id>` can reconstruct a run timeline.
- `forge cancel`, idle timeout, gate decisions, auth failures, and red blocks are
  visible as events.

Container events should be emitted by the caller that has run/task context, not
from the Docker executor. `invoke.ts` and `runNext.ts` know `runId` and `taskId`;
`docker-exec.ts` only knows Docker args and log paths. Emit `container.started`
before calling the executor, then emit `container.exited`, `container.killed`, or
`container.idle_timeout` after it returns. Derive idle timeout from the existing
`IDLE_TIMEOUT_EXIT_CODE`.

### 3. Add a Failure Taxonomy

Task failures should carry a machine-readable `failure_kind` in addition to the
human-readable error message.

Initial failure kinds:

- `cancelled`
- `container_crash`
- `idle_timeout`
- `result_missing`
- `result_malformed`
- `auth_missing`
- `auth_expired`
- `auth_injection_failed`
- `model_error`
- `tool_error`
- `red_blocked`
- `gate_rejected`
- `unknown`

Implementation:

- Store `failure_kind` in the structured failure event payload.
- Keep `tasks.error` as the human-readable prose summary.
- Do not add a `tasks.failure_kind` column in the crawl stage.
- Do not hand-edit every `markTaskFailed` call site. Add a central failure
  wrapper/classifier that records the failure event and maps existing contexts
  to a kind.

The column is a later metrics-layer optimization, not the first source of truth.
Adding it changes the machine-wide SQLite schema under `~/.forge/forge.db`, while
the crawl milestone only needs task inspection, event replay, and orchestrator
branching. Promote `failure_kind` to a column deliberately when dashboard/history
queries need it, and tie that migration to the SQL single-source-of-truth work
so schema changes stay coordinated.

`failure_kind` is cross-cutting because task failure is written from dispatch,
invoke, gate, fanout, red review, auth, cancel, and container paths. Keep the
classification logic in one tested module rather than spreading string constants
across the runner.

Suggested mapping examples:

- `AuthProfileError` missing profile -> `auth_missing`
- `AuthProfileError` expired profile -> `auth_expired`
- `IDLE_TIMEOUT_EXIT_CODE` -> `idle_timeout`
- nonzero container exit with no result -> `container_crash`
- empty `result.json` -> `result_missing`
- malformed `result.json` -> `result_malformed`
- gate reject/request-changes failure path -> `gate_rejected`
- `forge cancel` path -> `cancelled`

Acceptance criteria:

- Every failure event carries a `failure_kind`.
- Existing `markTaskFailed` usage is routed through a central wrapper/classifier
  where practical; direct call-site edits are targeted exceptions, not the
  default approach.
- The classifier has unit tests for every initial failure kind.
- Dashboard/status can group failures by kind.
- Orchestrators can branch on failure kind without parsing strings.

### 4. Grow `forge show` Into the Detail View

`forge show <run-id|task-id>` should be the canonical detail and diagnostic
command. Avoid adding `forge inspect` in Crawl; Forge already has `status` for
overview and `show` for detail, and a third overlapping read command would add
user-facing sprawl before the read model is stable.

For a task, show:

- Identity: task id, run id, phase, role, model.
- Status and failure kind.
- Timeline of lifecycle events.
- Container name.
- Elapsed time.
- Last output timestamp.
- Idle timeout, if known.
- Last few stdout/stderr lines.
- Result file status: missing, empty, malformed, valid.
- Artifact manifest.
- Suggested next command.

Example:

```text
Task: task-engineer-abc123
Status: failed
Failure: idle_timeout
Container: forge-task-engineer-abc123
Last output: 11m ago
Timeout: 10m

Timeline:
  10:21:04 task.created
  10:21:05 task.started
  10:31:05 container.idle_timeout
  10:31:06 task.failed

Artifacts:
  stdout: container.stdout.log
  stderr: container.stderr.log
  result: empty

Next:
  forge retry task-engineer-abc123
```

For a run, show:

- Run identity, workflow, project, status.
- Critical current blockers.
- Failed tasks grouped by failure kind.
- Awaiting gates and blocked-by-red tasks.
- Running tasks with last output time.
- Next suggested command.

### 5. Write a Task Artifact Manifest

Each task directory should contain a small `manifest.json` that indexes known
artifacts.

Example:

```json
{
  "taskId": "task-engineer-abc123",
  "runId": "run-feature-abc123",
  "files": {
    "prompt": "CLAUDE.md",
    "package": "package.md",
    "result": "result.json",
    "stdout": "container.stdout.log",
    "stderr": "container.stderr.log"
  },
  "container": {
    "name": "forge-task-engineer-abc123"
  },
  "auth": {
    "profileRequested": true,
    "stateMounted": true
  }
}
```

The manifest should not contain secrets. It should describe whether sensitive
capabilities were mounted, not where bearer credentials live.

### Crawl Tickets

1. `events-read: add eventsForTask/eventsForRun and render timelines in forge show`
2. `events-backfill: emit missing lifecycle events for abandoned, gate, container, auth, timeout, crash, cancel`
3. `failure-kind: classify task failures in structured failure event payloads`
4. `show-detail: grow forge show <run|task> with timeline, diagnostics, and next action`
5. `manifest: write task manifest.json for logs/results/container metadata`

## Walk

The walk stage makes active runs observable while they are happening.

### 1. Live Task Activity

Running tasks should expose:

- Started at.
- Last stdout/stderr output time.
- Idle duration.
- Idle timeout threshold.
- Container name.
- Current status.
- Last lifecycle event.

This should appear in:

- `forge show <task-id>`
- `forge status`
- dashboard task detail
- `forge watch --json`

This directly builds on the idle watchdog and live log streaming already in the
Docker executor.

### 2. Structured Agent Progress Events

Agents should be allowed, but not required, to emit progress records.

> **As implemented (WALK-3):** agents append delimited JSON lines to
> `/task/progress.jsonl` rather than to stdout. The container runs
> `claude --output-format stream-json`, so the container's stdout is pure
> stream-json and an agent cannot inject a raw top-level line there; a file in
> the task dir (the same interface as `result.json`/`manifest.json`) is the
> runtime-agnostic channel. Forge ingests it after the container exits — on the
> idle-timeout and crash paths too, not just normal exit.

Example progress events:

```json
{"type":"progress","message":"installed dependencies","percent":25}
{"type":"progress","message":"running unit tests","percent":60}
{"type":"artifact","kind":"screenshot","path":"/task/homepage.png"}
{"type":"decision","summary":"using existing auth profile qa-admin"}
```

These records should become `task.progress`, `task.artifact`, or
`task.decision` events. If an agent never emits them, Forge should still work
from container lifecycle and logs.

### 3. Trace Shape

Forge does not need OpenTelemetry on day one, but it should adopt a trace/span
shape in its own data model.

Suggested hierarchy:

```text
run
  task
    docker
    model
    tool
    auth
    gate
    red-review
```

Each event should include:

- `runId`
- `taskId`, when applicable
- `spanKind`, when applicable
- timestamp
- event type
- structured payload

This keeps the door open for exporting to OpenTelemetry later without forcing a
large rewrite now.

### 4. Better Notifications

Notifications should carry the failure kind and the next action.

Examples:

```text
Forge: task engineer failed: result_malformed.
Run: feature login redesign
Next: forge show task-engineer-abc123
```

```text
Forge: task manual-qa idle for 8m; timeout at 10m.
Run: app redesign
Next: forge show task-manual-qa-def456
```

### Walk Tickets

1. `status: show running task last-output time and idle countdown`
2. `watch: emit structured task activity and failure-kind events`
3. `progress: parse agent JSON progress lines into events`
4. `notifications: include failure_kind and forge show command`
5. `dashboard: add task timeline and live activity panel`

## Run

The run stage makes Forge operable across many projects, long workflows, and
historical debugging.

### 1. Searchable Run History

Forge should answer operational questions:

- Which tasks hit `idle_timeout` this week?
- Which projects have the most auth failures?
- Which workflows have the highest red-block rate?
- Which model aliases are most expensive?
- Which steps usually take longest?
- Which runs were cancelled manually?

This can start as CLI queries over SQLite and later become dashboard views.

Example commands:

```bash
forge runs query --failure-kind idle_timeout --since 7d
forge runs query --project ~/code/app --status abandoned
forge usage --by role --since 30d
```

### 2. Baselines and Anomaly Detection

Once Forge has enough history, it can compare the current run to past runs.

Examples:

- This workflow usually completes in 18 minutes; current run is at 42 minutes.
- This step usually emits output every 90 seconds; current silence is 9 minutes.
- This project has had five auth failures today.

The first version can be simple medians and thresholds. It does not need model
prediction.

### 3. Metrics Dashboard

Track:

- Run success rate.
- Task failure kinds.
- Median task duration by workflow/phase/role.
- Idle kills.
- Cancel count.
- Retry count.
- Red block rate.
- Gate wait time.
- Model token/cost by role and workflow.
- Auth-profile failures.

These are management and reliability metrics, not just debugging details.

### 4. Debug Bundle

Add:

```bash
forge bundle <run-id>
```

It should produce a sanitized archive containing:

- run metadata
- tasks
- events
- verdicts
- task manifests
- result JSON files
- stdout/stderr logs
- prompts and packages, optionally
- usage records

The bundle should redact known secret paths and never include raw auth state.

This is useful for debugging Forge itself and for handing a failed workflow to a
separate reviewer without giving it the whole project.

### 5. Optional External Export

After Forge has a stable internal trace shape, add export options:

- JSONL event export.
- OpenTelemetry span export.
- Prometheus-style metrics endpoint or file.

Do this after the SQLite/event model is coherent. External observability should
be an export path, not the first source of truth.

### Run Tickets

1. `runs query: search historical runs by status, failure_kind, project, age`
2. `metrics: aggregate durations, failures, cancels, retries, red blocks`
3. `dashboard: add operations summary views`
4. `bundle: create sanitized debug bundle for a run`
5. `otel: optional trace export from Forge events`

## Suggested First Milestone

Start with a narrow crawl milestone:

```text
Make every run/task explain itself.
```

Scope:

- Add `eventsForTask` and `eventsForRun` read accessors.
- Render existing event timelines in `forge show`.
- Backfill the highest-value missing emissions after the read path exists:
  cancel, abandoned, gate, auth, container exit/kill, idle timeout, crash.
- Add `failure_kind` to structured failure event payloads.
- Grow `forge show <task-id>` after the read path and failure payloads are useful
  enough to consume.

This milestone does not require changing orchestration semantics. It improves
debugging for every other Forge initiative: cancel, auth, provider abstraction,
red reviews, retries, and workflow durability.

## Why This Starts Before Larger Refactors

Observability is a good first investment because it reduces uncertainty without
forcing a major architectural bet. Before Forge changes provider abstraction,
retry policy, auth strategy, or workflow execution semantics, it should be able
to explain current behavior precisely.

Better observability will make future changes safer because regressions become
visible as structured events, failure kinds, and timeline differences instead of
being discovered through ad hoc log reading.
