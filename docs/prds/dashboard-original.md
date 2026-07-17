# PRD: forge dashboard

> ⚠️ **STATUS (2026-07-16): the `forge dashboard` invocations below are SUPERSEDED by FG-571.**
> This original PRD predates both the workspace re-merge (#140) and the FG-571 stable/dev split. The dashboard
> is a separate workspace with its own dependency tree, not bundled into a release, so stable `forge`
> **refuses** `dashboard` in release mode; run it as `./bin/forge-dev dashboard start` from a source checkout.
> **Whether a stable release should ship the dashboard at all is an OPEN product decision reserved to the
> operator under FG-572; nothing here decides it.** This PRD's dashboard design intent is otherwise unaffected.


## What this is

A read-only web dashboard for inspecting forge runs. Replaces the current pattern of running `forge status <run-id>` repeatedly and `jq -r '.report'` to read agent output.

## Why

Forge is hard to use today as a human. The CLI commands are precise but tedious; reading 7 lens findings as terminal output is awkward; the reporter's markdown output requires shell incantations to read. SQLite is already the blackboard. A web view over it removes the friction without changing the design — the CLI stays authoritative, the dashboard is purely a reader.

## Done = all of the following

1. New CLI command: `forge dashboard [--port <n>]`. Default port 3737. Spawns a local HTTP server, prints the URL, and runs in the foreground until Ctrl-C. No daemon, no PID file, no auto-launch of a browser — the user clicks the printed URL.

2. Dashboard reads the same SQLite database the CLI uses (`~/.forge/forge.db`). Read-only — no writes, no gating from the dashboard in v1.

3. Three views, all on a single page:
   - **Runs list** (sidebar): every run, most recent first, with id, title, workflow, status, created_at. Clickable.
   - **Run detail** (middle pane, when a run is selected): the run's task graph grouped by phase. Each task shows its id, agent role, status (with a clear icon — pending/running/awaiting_gate/complete/failed/blocked_by_red), and any verdict summary (red role, verdict, confidence). Clickable.
   - **Task detail** (right pane, when a task is selected): full task — inputs (collapsible JSON), result (with markdown rendering for `result.report`, `result.recommendation`, `result.summary` fields when present), verdicts table with findings.

4. Auto-refresh: while ANY task in the selected run is in `running` status, the page polls every 2 seconds and updates without a full reload. Otherwise no polling. (Polling is fine; no need for SSE or websockets.)

5. Markdown rendering: agent results frequently contain markdown in a `.report` or `.recommendation` field, or markdown findings. These render as HTML, not raw JSON. JSON-only fields render as syntax-highlighted JSON.

6. Findings tables: every verdict's `findings` array renders as a small table with columns `severity, summary, evidence, hypothesis`. Severities are color-coded (high = red, medium = yellow, low = gray).

7. Single HTML file, no build step, no SPA framework. Use the htmx + Tailwind via CDN approach OR plain HTML + small inline JS. The dashboard MUST work without `npm run build`, just like the CLI does.

## Not in scope

- Gating from the dashboard (advance/reject/request-changes) — stays in CLI in v1
- Cross-run search ("all runs that touched the auth module")
- Cost rollups (model_calls table aggregation) — separate work item
- Live event stream / SSE / websockets — polling is sufficient for one user on one machine
- Authentication — the server binds to 127.0.0.1 only; localhost trust is sufficient
- Mobile layout — desktop-only is fine

## Constraints

- **No new build step.** The CLI today has no compile step (tsx + bin/forge shim). The dashboard must inherit this. No webpack, no vite, no React build pipeline.
- **Minimum dependency budget.** Forge currently has 3 runtime dependencies (better-sqlite3, commander, gray-matter). Adding 1-2 more for an HTTP framework is acceptable. Adding 30+ for a frontend framework is not.
- **Does not require a daemon.** The dashboard runs only when you launch it. SQLite stays the resume state.
- **Does not modify forge.db.** Read-only. If a query needs derived data, compute in memory.
- **Existing 57 tests must still pass** after changes.

## Acceptance test (hand-runnable)

1. Run `forge dashboard --port 3737` from `~/code/forge`. Server prints `http://127.0.0.1:3737` and stays in the foreground.
2. Open the URL in a browser. The runs list shows `run-forge-itself-b13596` (and any other runs in the DB).
3. Click `run-forge-itself-b13596`. The middle pane shows three phases (scope, assess, report) with all tasks. Each assess task shows its red verdict.
4. Click `task-report-54c679` (the reporter's final task). The right pane shows the inputs, the result with the markdown report rendered as HTML (headings, lists, etc).
5. Click any assess task that has a red-fail (e.g. `task-assess-798180` — maintainability). The right pane shows the findings table with severity-colored rows.
6. Ctrl-C in the terminal exits the server cleanly.

## Data sources (already exist)

- `runs` table: id, workflow, title, status, created_at, completed_at, metadata
- `tasks` table: id, run_id, parent_id, phase, agent_role, status, task_package, result, started_at, completed_at, error
- `verdicts` table: id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at
- `gates` table: decision audit trail (display in task detail when present)

The TypeScript types in `src/types/index.ts` are authoritative.

## Out of scope but document for the next iteration

- Gate buttons in task detail (would need POST endpoint + CSRF or origin check)
- "Live" timeline view across all runs
- Cost telemetry per run (depends on model_calls being populated, which requires LiteLLM)
- Filtering / search across runs
