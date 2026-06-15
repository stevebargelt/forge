# forge-dashboard

Activity feed + agent-output inbox for forge runs across all projects on the host. Lives as a workspace package inside the forge monorepo.

```bash
forge dashboard start              # boots http://127.0.0.1:8024
```

Reads `~/.forge/forge.db` directly (read-only) and shells out to `forge` for mutating actions.

## What this is

Under the v2 / RACI-driven model, forge sessions are mostly agent-driven — the orchestrator (Claude Code in your terminal) calls `forge invoke` repeatedly, occasionally `forge new feature` for implementation work. The dashboard is not where you take action; it's where you **read what the agents wrote** and watch live runs land.

Navigation tabs:

- **activity** — chronological agent outputs across every project on the host, rendered as markdown cards (not raw JSON). In-flight runs appear at the top via live poll.
- **projects** — per-project summary; click a project to filter the activity feed to that project.
- **usage** — token usage rollup and time-series, grouped by role / workflow / project / model.
- **ops** — operational metrics rollup.
- **governance** — effective routing policy, host-vs-project diff, recent audit.
- **compression** — compression stats derived from `compression.verification` events. Shows a time-window filter (7d / 30d / 90d / all), plus health summary, daily time-series, per-role breakdown, and method distribution when data is present. Displays "No compression data yet. Agents will report compression stats as they run." when no events exist.

Click any activity card to see the full result.json + container stdout + related verdicts/gates.

## HTTP API

The server exposes read-only JSON endpoints at `http://127.0.0.1:8024/api/…`. All `GET`. Notable surfaces:

- **`/api/feed`**, **`/api/in-flight`**, **`/api/projects`**, **`/api/task/:id`** — core activity data
- **`/api/usage`**, **`/api/usage/timeseries`**, **`/api/usage/model-mix`** — token usage metrics
- **`/api/compression/summary`**, **`/api/compression/timeseries`**, **`/api/compression/by-role`**, **`/api/compression/methods`** — compression metrics derived from `compression.verification` events

All metrics endpoints accept `?since=30d&projectDir=/path` query params. Full parameter and response-shape reference: `docs/SCHEMA-CONTRACT.md`.

## Design

`design/dashboard.pen` is the source of truth. Edit in Pencil. PNGs under `design/designs/` are exports of canonical screens.

## Relationship to forge

This package reads forge's SQLite + filesystem layout but does not write to either. Mutating actions (gate decisions, run-next, retry) shell out to the `forge` CLI binary — it must be on `$PATH` (`npm link` from the root sets this up).

Schema coupling is now enforced at the TypeScript level: `src/queries.ts` imports its row types from `@forge/types` (aliased to `../src/types/index.ts`). Any forge schema change that breaks the dashboard surfaces as a `npm --workspace=dashboard typecheck` failure.
