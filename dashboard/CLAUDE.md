# dashboard

The forge dashboard workspace. Read-only view of `~/.forge/forge.db` plus an HTTP server that serves agent results as markdown cards. Shells out to `forge` for mutations (gate decisions, retries) — never writes the DB directly.

## Layout

- `src/server.ts` — HTTP server (~100 LoC). Routes the API + serves the shell.
- `src/queries.ts` — `better-sqlite3` reads against `~/.forge/forge.db`. Row types imported from `@forge/types` (forge's `src/types/index.ts`); schema drift surfaces as a TypeScript error here.
- `src/shell.ts` — the HTML shell + CSS (template literals).
- `client/main.js`, `client/renderers.js` — browser JS, served as static files (no build, no bundling).
- `design/` — Pencil design corpus (`dashboard.pen` + PNG exports).

## Run

From the forge repo root:

```bash
forge dashboard start              # boots tsx src/server.ts in this dir on port 8024
npm --workspace=dashboard typecheck
```

## Conventions specific to the dashboard

- **No build step.** `tsx` runs the server directly. Browser JS is plain ES modules, no bundler.
- **Read-only DB open.** `queries.ts` opens with `{ readonly: true }`. WAL mode means we don't block forge writers.
- **Mutations shell out.** `shell.ts` (server-side) routes any POST to `forge gate` / `forge next` / `forge retry` as a child process. This keeps forge's CLI as the single entry point for state changes — same contract as before the merge.
- **Cross-project by design.** The dashboard intentionally shows runs across every project on the host (the cross-project survey surface). It does NOT apply `forge status`'s workspace filter.
