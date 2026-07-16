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
- **workbench** — read-only RACI Workbench. Four sections: SOURCE (active RACI file and kind), DERIVED (compiled routing-policy path and health), EFFECTIVE (routes in force and host→project diff, or null if the policy is broken), RECORDED (recent RACI audit log entries). Tab label is "workbench"; URL hash stays `#governance` for compatibility. No mutations — propose/apply is FG-361.
- **backlog** — read-only view of the selected project's backlog: session-handoff notes and ticket list (grouped by type: epic / story / idea), filterable by type and status, searchable by title and body. Requires a project to be selected. Mutations (create, close, move tickets) remain on the `forge backlog` CLI.

Click any activity card to see the full result.json + container stdout + related verdicts/gates.

## HTTP API

The server exposes read-only JSON endpoints at `http://127.0.0.1:8024/api/…`. All `GET`. Notable surfaces:

- **`/api/feed`**, **`/api/in-flight`**, **`/api/projects`**, **`/api/task/:id`** — core activity data
- **`/api/usage`**, **`/api/usage/timeseries`**, **`/api/usage/model-mix`** — token usage metrics
- **`/api/backlog`** — returns `{ notes, tickets }` for `?projectDir=<dir>`; reads `<projectDir>/backlog/notes.md` and the structured ticket files. Returns `{ notes: "", tickets: [] }` when `projectDir` is absent or the backlog directory does not exist. Read-only.

All metrics endpoints accept `?since=30d&projectDir=/path` query params. Full parameter and response-shape reference: `docs/SCHEMA-CONTRACT.md`.

## Design

`design/dashboard.pen` is the source of truth. Edit in Pencil. PNGs under `design/designs/` are exports of canonical screens.

## Relationship to forge

This package reads forge's SQLite + filesystem layout but does not write to either. Mutating actions (gate decisions, run-next, retry) shell out to the `forge` CLI binary — it must be on `$PATH`. Install it the supported way: build a release, promote it, and install the shim once (`forge release build` / `promote` / `install-shim` — see the root README). Not `npm link`, which would put the live checkout on `$PATH` as `forge` and bypass the promoted release entirely.

Schema coupling is now enforced at the TypeScript level: `src/queries.ts` imports its row types from `@forge/types` (aliased to `../src/types/index.ts`). Any forge schema change that breaks the dashboard surfaces as a `npm --workspace=dashboard typecheck` failure.
