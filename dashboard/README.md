# forge-dashboard

Activity feed + agent-output inbox for forge runs across all projects on the host. Lives as a workspace package inside the forge monorepo.

The dashboard is **bundled into the promoted release** (FG-580): its runtime source, static client assets, vendored client libs (offline boot — no CDN-executed JS), and dashboard-relevant deps all ship in-closure, so `forge dashboard start` runs from the stable `forge`. A torn or incomplete release fails named and nonzero rather than pretending to run.

```bash
forge dashboard start                        # boots http://127.0.0.1:8024 from the release
forge dashboard start --port 8025            # custom port

# during development, run it from a source checkout instead:
cd ~/code/forge
./bin/forge-dev dashboard start
```

Reads `~/.forge/forge.db` directly (read-only) and shells out to `forge` for mutating actions.

## What this is

Under the v2 / RACI-driven model, forge sessions are mostly agent-driven — the orchestrator (Claude Code in your terminal) calls `forge invoke` repeatedly, occasionally `forge new feature` for implementation work. The dashboard is not where you take action; it's where you **read what the agents wrote** and watch live runs land.

Navigation tabs:

- **home** — the default landing view, combining live host plan-limit windows with work currently in flight.
- **activity** — chronological agent outputs across every project on the host, rendered as markdown cards (not raw JSON). In-flight runs remain visible at the top via live poll.
- **projects** — one summary per canonical repository. Standalone clones and linked worktrees are nested as checkout/branch context; click the project for all-checkout activity or a checkout row for an exact-path operational filter. The registry surfaces only checkouts that still exist on disk or are operationally actionable: a missing checkout stays visible only while it has in-flight work or a live session, and is labeled missing/unavailable. A missing, idle checkout with no live session is suppressed, and a project whose checkouts are all suppressed drops off the view entirely — but its aggregate counts, last activity, and full historical `projectDirs` scope are preserved untouched for historical queries.
- **usage** — host Claude/Codex plan-limit windows plus token usage rollup and time-series, grouped by role / workflow / project / model. Claude OAuth limits come from an observed Anthropic usage integration; it is not treated as a stable public API contract. Current Codex limits come from the documented local Codex App Server `account/rateLimits/read` method, not a public provider HTTPS endpoint. A bounded scan of recent local rollout files is retained only as a compatibility fallback, and fallback data is labeled stale with its observation time. Coexisting Claude, Anthropic API, Bedrock, Codex subscription, and OpenAI API channels render independently when configuration or an observation proves they exist. Bedrock and API-key channels use explicit non-subscription states rather than invented quota numbers.
- **ops** — operational metrics rollup, plus **average agent runtime over time**: a bar chart of the mean duration of completed agent tasks over a `1d` / `7d` / `30d` / `90d` / `all` window (hourly buckets on `1d`, daily on `7d`/`30d`, weekly on `90d`/`all`), charting "All agents" by default or a single observed role, with a role breakdown table (average + run count) whose rows re-chart the series. Buckets are keyed by completion time in UTC, and successful and failed agent runs both count — active work and interactive orchestrator sessions do not. A bucket with no runs renders as a gap, never as a zero, and the bucket still in progress is hatched and captioned as one whose average can still move. The chart carries a screen-reader table as its text equivalent.
- **workbench** — read-only RACI Workbench. Four sections: SOURCE (active RACI file and kind), DERIVED (compiled routing-policy path and health), EFFECTIVE (routes in force and host→project diff, or null if the policy is broken), RECORDED (recent RACI audit log entries). Tab label is "workbench"; URL hash stays `#governance` for compatibility. No mutations — propose/apply is FG-361.
- **backlog** — read-only view of the selected project's backlog. Tickets are **host-wide truth keyed by `project_key`**, not branch-local files: every checkout of one repository — canonical, feature branch, linked worktree, clone — renders the same rows, so selecting a feature checkout never exposes its branch-local ticket files. A repository that has never been imported into the forge store has no ticket truth at all, and the board says so (with the `forge backlog import` repair) rather than rendering an empty board; a failed ticket read renders as an error, never as zero tickets. A project still in markdown mode shows its rows badged as a non-authoritative import shadow. Session handoff notes stay distinct operational context, retained per checkout. It is filterable by type and status and searchable by title and body, with a live count of matching results recalculated as those filters change. An exact checkout can still be selected. Mutations (create, close, move tickets) remain on the `forge backlog` CLI.

Click any activity card to see the full result.json + container stdout + related verdicts/gates.

## HTTP API

The server exposes read-only JSON endpoints at `http://127.0.0.1:8024/api/…`. All `GET`. Notable surfaces:

- **`/api/feed`**, **`/api/in-flight`**, **`/api/projects`**, **`/api/task/:id`** — core activity data. Project records use a canonical repository `key`, aggregate counts, and retain `primaryCheckout`, exact `projectDirs`, and per-checkout path/branch/count records. The `/api/projects` per-checkout list is presentation-filtered to existing or operationally actionable checkouts (missing checkouts appear only with in-flight work or a live session); the aggregate counts, `lastRunAt`, and full historical `projectDirs` are never trimmed, so canonical `projectKey` scope still resolves every historical feed/usage/run record.
- **`/api/usage`**, **`/api/usage/timeseries`**, **`/api/usage/model-mix`** — token usage metrics
- **`/api/usage/limits`** — normalized host provider channels and plan windows; add `?refresh=1` to bypass the 30-second provider cache. Credentials and raw provider/App Server records remain server-side.
- **`/api/agent-runtime`** — average agent runtime over time, overall and per role, for the ops view's trend panel. `?window=1d|7d|30d|90d|all` (default `7d`); an unrecognized window is a `400`, never a silent fallback. Empty buckets report `sampleCount: 0` with a null average rather than a zero duration.
- **`/api/backlog`** — accepts canonical `?projectKey=<key>` or exact `?projectDir=<dir>`. Tickets come from the host store, scoped by the `project_key` the server derives from its **own** registry resolution of that request (the request's `projectKey` parameter is never used as a store key — trusting it would turn a per-project board into a cross-project one). Both request shapes therefore answer identically for one repository, and no branch-local ticket file is read. The response carries `ticketsProjectKey` (null when the repository has no ticket truth), `ticketsStorageMode` (`db` | `markdown` | null) and an optional `ticketsError` alongside `tickets`. Session handoff notes stay per-selection and per-checkout: a canonical response exposes every checkout's notes via `notesByCheckout`, and an exact single-checkout response also fills the legacy `notes` field. Read-only.

Project-aware read endpoints accept either `?projectKey=<canonical-key>` to include every observed member path or `?projectDir=/exact/path` for an exact operational checkout. If both are present, the exact path wins. Unknown canonical keys match nothing. Metrics endpoints also accept `?since=30d` — except `/api/agent-runtime`, which takes a fixed `?window=` instead. Full parameter and response-shape reference: `docs/SCHEMA-CONTRACT.md` (which needs a follow-up update for this expanded read model).

## Validation

```bash
npm --workspace=dashboard run typecheck
npm --workspace=dashboard test
npm --workspace=dashboard run test:integration
npm --workspace=dashboard run test:browser
```

The browser suite uses `playwright-core` with an installed Chrome/Chromium executable. It runs against isolated provider fixtures and never reads host credentials or raw provider records.

## Design

`design/dashboard.pen` is the source of truth. Edit in Pencil. PNGs under `design/designs/` are exports of canonical screens.

## Relationship to forge

This package reads forge's SQLite + filesystem layout but does not write to either. Mutating actions (gate decisions, run-next, retry) shell out to the `forge` CLI binary — it must be on `$PATH`. Install it the supported way: build a release, promote it, and install the shim once (`forge release build` / `promote` / `install-shim` — see the root README). Not `npm link`, which would put the live checkout on `$PATH` as `forge` and bypass the promoted release entirely.

Schema coupling is now enforced at the TypeScript level: `src/queries.ts` imports its row types from `@forge/types` (aliased to `../src/types/index.ts`). Any forge schema change that breaks the dashboard surfaces as a `npm --workspace=dashboard typecheck` failure.
