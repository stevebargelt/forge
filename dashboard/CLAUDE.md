# dashboard

The forge dashboard workspace. Read-only view of `~/.forge/forge.db` plus an HTTP server that serves agent results as markdown cards. Shells out to `forge` for its closed set of mutations (the four `forge queue` verbs and `forge projects classify`) — never writes the DB directly. Gate decisions, next and retries stay CLI-only.

## Layout

- `src/server.ts` — HTTP server (~1,000 LoC). Routes the read API, the closed set of mutating POSTs, and serves the shell.
- `src/queries.ts` — `better-sqlite3` reads against `~/.forge/forge.db`. Row types imported from `@forge/types` (forge's `src/types/index.ts`); schema drift surfaces as a TypeScript error here.
- `src/shell.ts` — the HTML shell + CSS (template literals).
- `client/main.js`, `client/renderers.js` — browser JS, served as static files (no build, no bundling).
- `client/backlog.js` — read-only backlog view (`#backlog[/<ticketId>]`); mirrors `/api/backlog`. No writes.
- `client/view-routing.js` — the closed `ROUTES` table and the only hash parser/writer (FG-820).
- `client/nav-render.js`, `client/nav-view.js` — the left-column navigation, the narrow-screen bottom bar and drawer (FG-820).
- The cockpit object pages (FG-821), each a pure `*-render.js` (unit-tested, no DOM) beside its `*-view.js`:
  - `client/runs-index-render.js`, `client/runs-index-view.js` — the run index (`#runs[?scope&status=]`) and the Runs badge.
  - `client/run-page-view.js` — the run page (`#run/<runId>[/map|/evidence]`); `client/run-map.js` draws its map tab.
  - `client/task-page-view.js` — the task page (`#task/<taskId>`) and its Explain page (`#task/<taskId>/explain`, body from `client/run-explain-panel.js`'s `ExplainContent`).
  - `client/ticket-page-view.js` — the ticket page (`#backlog/<ticketId>`); `ReviewPage` in `client/reviews.js` is a review by id (`#reviews/<reviewId>`).
  - `client/breadcrumbs-render.js` — trails and Escape-to-parent; `client/screen-header-render.js` — the one-line screen contract; `client/object-page-view.js` — the shared head, tabs and Escape handling.
- `design/` — Pencil design corpus (`dashboard.pen` + PNG exports).

## Run

From the forge repo root:

```bash
./bin/forge-dev dashboard start    # boots tsx src/server.ts in this dir on port 8024
npm --workspace=dashboard typecheck
```

`./bin/forge-dev dashboard start` is the source-checkout entry. But the dashboard is now bundled into the promoted release as a mandatory asset (FG-580), so `forge dashboard` also runs from a promoted release — resolution is release-owned (it flows from `assetRoot()`, the executing release or the dev checkout, never the invocation cwd), and the FG-569 release-mode refusal is retired. The bundled UI boots offline: its client libs are vendored in-closure and served under a `script-src 'self'` CSP, so no CDN-executed JS is fetched (provider/data APIs may still need network). A torn/incomplete release — a missing dashboard file, vendored client lib, or dashboard-relevant dep — still fails named and nonzero (`assertDashboardClosure`) rather than falling back to a source checkout.

## Navigation (FG-820)

The plan is `docs/research/dashboard-information-architecture.md`. The 13-button tab strip is gone; there is no flag or twin keeping it alive.

- **Left column.** A scope control at the top ("All projects", a project, or project › checkout — a filter, never a switcher), then five groups under plain, non-collapsible headings, then the last-poll clock. Now: Home, Activity. Plan: Backlog, Queue, Campaigns. Evidence: Runs, Reviews, Shipping. Setup: Roles, Routing, Config, Projects. Health: Usage, Ops. Runs is the run index (FG-821); Roles is a placeholder until its pages land.
- **Keyboard (FG-692).** Every item is an `<a href="#…">`; group headings are not controls; `aria-current="page"` marks the current item; a "Skip to content" link comes first and the tab order is column → content. An object page highlights its parent (a run page highlights Runs).
- **Below 720px** (the nav breakpoint; 520/600/640 stay content breakpoints) the column is replaced by a fixed, safe-area-padded bottom bar — Home, Runs, Queue, Backlog, More. More opens a drawer holding the full column: a modal dialog that traps focus, closes on Escape, and returns focus to More.
- **`ROUTES` (`client/view-routing.js`).** A closed table: each view names its group (`now | plan | evidence | setup | health`), path pattern, scope requirement (`none | optional | project | checkout`) and legacy aliases. `parseHash` returns view, object id, tab and scope; unknown parameter keys are dropped; an unknown view lands on Home with a one-line "No view named …" notice. **The group is derived from the view, never read from the hash** — a `group=` parameter or a group-shaped leading segment (`#plan/queue`) is dropped and the URL rewritten with `history.replaceState`.
- **Aliases.** `#governance` → `#routing`, `#control-plane` → `#config`, `#run-map/<id>` → `#run/<id>` (the run page's default `map` tab; FG-821 — keep this alias permanently, saved and emitted `#run-map/<id>` links must resolve forever). A bare object hash (`#run-map`, `#run`, `#task`) lands on the run index with an "open a run from the run index" prompt. Every alias is rewritten to its canonical hash in place.
- **Object tabs.** Object routes name their tabs in `ROUTES` (`run`: `map`, `evidence`; `task`: `detail`, `explain`). The first is the default and is omitted from the canonical hash; an unknown tab falls back to it. A route may also own extra hash parameters (`params`: the run index's `status=`); every other key is still dropped.
- **Scope lives in the hash.** List views carry `?project=<projectKey>[&checkout=<URI-encoded projectDir>]`, mapped one-to-one onto the server's `?projectKey=`/`?projectDir=`. A scope change rewrites the hash with `replaceState`; moving between list views keeps it; scope-less views (`#projects`, `#roles`) and object hashes (`#run-map/<id>`) carry none and leave the scope in hand untouched. Never `localStorage`/`sessionStorage`. The Remote Board must not adopt this scheme — the checkout parameter puts a host path in the URL.
- **No client-computed counts.** There are two nav badges. Home's is the attention envelope's server-computed `counts` (`src/v2/attention-inbox.ts`, the same derivation `forge attention list` prints): `counts.open`, danger-toned when `counts.high > 0`, a partial marker when `degraded` is non-empty, "?" when the read failed or carries no valid `counts`, hidden only when `empty: true`, capped at "99+". Never `items.length`, a per-view tally, a filtered-list count, read/unread state, or anything stored. The inbox is read on every view so the badge is live everywhere. Runs' is `GET /api/runs`'s server-computed `activeCount` (the derivation `forge runs query --status active` prints; `runs-index-render.js`'s `runsBadge`): an informational live count, never danger-toned, "?" when the read failed or carries no integer `activeCount`, hidden at 0, capped at "99+". It is read at 30s on every view, and the run index hands up its own first-page response so on `#runs` the badge is the list's own answer. Never `runs.length` or a count of a filtered or paged list.

## Object pages (FG-821)

- **No modal overlays for task detail or Explain.** Every entry point — feed cards, inbox rows, in-flight and orchestrator rows, current-activity rows, run map nodes — is (or navigates to) a link: a task row opens `#task/<taskId>`, a run-map node opens `#task/<taskId>/explain`, an inbox run row opens `#run/<runId>`. The task page and its Explain page link to each other as tabs.
- **Object pages read by global id, unscoped.** The run, task, Explain and review pages ignore the scope in hand, so an inbox click and a pasted link read the same object. The ticket page is the exception: ticket ids are per project, so `GET /api/backlog/:id/runs` and the ticket's fields are read with the list scope.
- **Breadcrumbs on object pages only, built from the payload, never from history:** Project › [Ticket ›] Run › Task › Explain. Every crumb but the last is a link; Project resolves to `#runs?project=<key>` (matched from the payload's `projectDir` against `/api/projects`, or the backlog's `ticketsProjectKey`). The ticket crumb comes from a `links.ticketId`: `GET /api/task/:id`'s for the task page, `GET /api/run/:id/evidence`'s for the run page. List views show group and title instead.
- **Screen line.** Every list view and object page states what is happening, whether it needs you, and what to do in one line, naming the next CLI verb where one applies. Object-page copy is read from the payload — the task's status and failure kind, and `GET /api/attention-inbox?runId=`'s `reason`/`requestedAction` (for a failed task that is the retry policy's advice). A task at `awaiting_gate` names `forge gate <id>`; a failed one `forge show <id>`.
- **Escape on an object page navigates to its parent:** Explain → task → run → `#runs`; ticket → `#backlog`; review → `#reviews`. A key typed into a field, or an open modal (the nav drawer, a backlog handoff), is left alone.
- **Run evidence** (the `evidence` tab) is one `GET /api/run/:id/evidence` read per run visit — the server's own union of the run's reviews, launches and host verifications by run id (`queries.ts`'s `runEvidence`), not a client-side fold over each task's `links`. Reviews link to `#reviews/<id>`, launches to `/api/launches/<id>` and its `/log`, host verifications to the run's first task's Explain page (which shows the evidence).

## Conventions specific to the dashboard

- **No build step.** `tsx` runs the server directly. Browser JS is plain ES modules, no bundler.
- **Read-only DB open.** `queries.ts` opens with `{ readonly: true }`. WAL mode means we don't block forge writers.
- **Mutations shell out.** `server.ts` owns a closed set of five mutating routes: the four queue-planning POSTs (`/api/queue/enqueue|dequeue|rank|reorder`, each shelling one `forge queue` verb via `queue-mutation.ts`) and `POST /api/projects/classify` (shelling `forge projects classify`). Every other method is refused. There are no gate/next/retry routes; those stay CLI-only. This keeps forge's CLI as the single entry point for state changes (FORGE-DEC-015). The opt-in Remote Board (`src/remote/server.ts`) is a separate loopback listener with its own single `POST /api/plan` route, which delegates to an in-process store authority rather than shelling out.
- **Cross-project by design.** The dashboard intentionally shows runs across every project on the host (the cross-project survey surface). It does NOT apply `forge status`'s workspace filter.
- **The server is single-threaded — a synchronous serving path starves EVERY route (FG-742).** All routes share one Node event loop. A route that blocks it synchronously (the standing example: `/api/in-flight`'s FG-290 reconcile annotation `execFileSync`s `docker inspect` per running container — BD-13's recorded exception) blocks a *concurrently polled sibling* too, no matter how cheap that sibling's own query is. FG-742 was exactly this: `/api/current-activity` reads persisted state in milliseconds and shells out to nothing, yet it aborted at its 8s client deadline because it queued behind a slow/hung `docker inspect` fan-out. The contract for any serving path that shells out or does unbounded synchronous work: **bound how long it can hold the loop.** The docker probe is bounded by a per-inspect timeout (`RECONCILE_PROBE_TIMEOUT_MS`) and a per-request fan-out budget (`RECONCILE_FANOUT_BUDGET_MS`, wired via `budgetedLivenessProbe` at the `/api/in-flight` route), which caps the worst-case shared-thread stall to ~4.5s regardless of container count or daemon health — comfortably inside the current-activity deadline. Adding a new route that shells out without such a bound reintroduces this whole failure class. Regression: `src/fg742-current-activity-availability.integration.test.ts`.
