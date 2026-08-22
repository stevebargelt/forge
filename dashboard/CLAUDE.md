# dashboard

The forge dashboard workspace. Read-only view of `~/.forge/forge.db` plus an HTTP server that serves agent results as markdown cards. Shells out to `forge` for mutations (gate decisions, retries) — never writes the DB directly.

## Layout

- `src/server.ts` — HTTP server (~200 LoC). Routes the API + serves the shell.
- `src/queries.ts` — `better-sqlite3` reads against `~/.forge/forge.db`. Row types imported from `@forge/types` (forge's `src/types/index.ts`); schema drift surfaces as a TypeScript error here.
- `src/shell.ts` — the HTML shell + CSS (template literals).
- `client/main.js`, `client/renderers.js` — browser JS, served as static files (no build, no bundling).
- `client/backlog.js` — read-only backlog view (tab: "backlog"); mirrors `/api/backlog`. No writes.
- `design/` — Pencil design corpus (`dashboard.pen` + PNG exports).

## Run

From the forge repo root:

```bash
./bin/forge-dev dashboard start    # boots tsx src/server.ts in this dir on port 8024
npm --workspace=dashboard typecheck
```

`./bin/forge-dev dashboard start` is the source-checkout entry. But the dashboard is now bundled into the promoted release as a mandatory asset (FG-580), so `forge dashboard` also runs from a promoted release — resolution is release-owned (it flows from `assetRoot()`, the executing release or the dev checkout, never the invocation cwd), and the FG-569 release-mode refusal is retired. The bundled UI boots offline: its client libs are vendored in-closure and served under a `script-src 'self'` CSP, so no CDN-executed JS is fetched (provider/data APIs may still need network). A torn/incomplete release — a missing dashboard file, vendored client lib, or dashboard-relevant dep — still fails named and nonzero (`assertDashboardClosure`) rather than falling back to a source checkout.

## Conventions specific to the dashboard

- **No build step.** `tsx` runs the server directly. Browser JS is plain ES modules, no bundler.
- **Read-only DB open.** `queries.ts` opens with `{ readonly: true }`. WAL mode means we don't block forge writers.
- **Mutations shell out.** `shell.ts` (server-side) routes any POST to `forge gate` / `forge next` / `forge retry` as a child process. This keeps forge's CLI as the single entry point for state changes — same contract as before the merge.
- **Cross-project by design.** The dashboard intentionally shows runs across every project on the host (the cross-project survey surface). It does NOT apply `forge status`'s workspace filter.
- **The server is single-threaded — a synchronous serving path starves EVERY route (FG-742).** All routes share one Node event loop. A route that blocks it synchronously (the standing example: `/api/in-flight`'s FG-290 reconcile annotation `execFileSync`s `docker inspect` per running container — BD-13's recorded exception) blocks a *concurrently polled sibling* too, no matter how cheap that sibling's own query is. FG-742 was exactly this: `/api/current-activity` reads persisted state in milliseconds and shells out to nothing, yet it aborted at its 8s client deadline because it queued behind a slow/hung `docker inspect` fan-out. The contract for any serving path that shells out or does unbounded synchronous work: **bound how long it can hold the loop.** The docker probe is bounded by a per-inspect timeout (`RECONCILE_PROBE_TIMEOUT_MS`) and a per-request fan-out budget (`RECONCILE_FANOUT_BUDGET_MS`, wired via `budgetedLivenessProbe` at the `/api/in-flight` route), which caps the worst-case shared-thread stall to ~4.5s regardless of container count or daemon health — comfortably inside the current-activity deadline. Adding a new route that shells out without such a bound reintroduces this whole failure class. Regression: `src/fg742-current-activity-availability.integration.test.ts`.
