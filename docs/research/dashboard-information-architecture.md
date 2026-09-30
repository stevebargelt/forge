# Dashboard Information Architecture

Date: 2026-09-28. Ticket: FG-818. Source commits: Forge `4e172228` (main), Paperclip `0f14d2612`. Inputs: the FG-814 lane reports on Paperclip's web UI (lane E) and Forge's dashboard (lane F), and recommendations 11-15 and 24-26 of [Recommendations For Forge From Paperclip](competitive/paperclip-forge-recommendations.md).

This is research. It proposes the navigation structure for the layout ticket (FG-820) and the cockpit ticket (FG-821). It does not authorize implementation and changes no dashboard code.

## Summary

The 13-button tab strip becomes a left column: a scope control at the top, then five ordered groups.

- **Now**: Home, Activity
- **Plan**: Backlog, Queue, Campaigns
- **Evidence**: Runs (new), Reviews, Shipping
- **Setup**: Roles (new), Routing, Config, Projects
- **Health**: Usage, Ops

Run, task and Explain are object pages reached from lists, not nav items. Of the 13 current tabs, two are kept in place, ten move under a group, one merges and none is retired.

The three decisions that matter most:

1. **Scope and object identity both live in the hash.** Scope is a filter (`?project=`, `?checkout=`) on list views. Object pages (`#run/<id>`, `#task/<id>`, `#task/<id>/explain`, `#roles/<role>/<tab>`) are addressed by global id, ignore scope, and build breadcrumbs from their payload.
2. **Exactly two badges, both server-derived and CLI-reproducible.** Home carries the open-attention count; Runs carries the active-run count. The browser counts nothing and stores nothing.
3. **The group is derived from the view, not stored in the URL.** A closed route table maps each view to its group, so regrouping later cannot break a link (this is the answer to "where the group lives in the hash": in the view segment, by derivation).

## Method and sources

I read lane E (`/design/lanes/lane-e.md`) and lane F (`/design/lanes/lane-f.md`) in full; recommendations 11-15, 24-26 and suggested first tickets 9-14 (`docs/research/competitive/paperclip-forge-recommendations.md:745-1076,1662-1784,1863-1885`); invariants 10 and 21 (`docs/invariants.md:25,40`); and the Current activity, Attention inbox and queue-authority sections of `docs/concepts.md` (`:204-212,280-437`).

The package names `backlog/releases/v0.2.0.md` and its "Committed dashboard tranche". **The file is untracked on the operator host and was not present in this clone** (`git log --all -- 'backlog/releases/*'` is empty). I placed the four tranche surfaces the task names — run index, task page, Explain, Roles — using the recommendations' first tickets 12 and 13 for their scope. Anything else the release file adds is unplaced.

Verified in Forge source:

- The 13 buttons in order (`dashboard/client/main.js:662-674`); the closed set of 12 views plus `home`, with `run-map` the only parameterized view (`dashboard/client/view-routing.js:1,15-29`). `hashForView` emits only the view and a run id, so scope never reaches the hash.
- Scope is `useState` only (`main.js:61-62`), sent as `?projectKey=`/`?projectDir=` (`main.js:40-53`); the `hashchange` handler restores only view and run (`main.js:624-632`). Task detail, Explain (`main.js:68,107,824-829`) and campaign detail (`main.js:119`) are component state, so none is linkable.
- Run Map and Explain return 409 on a `projectKey` without a `projectDir` and work unscoped (`dashboard/src/server.ts:730-735,752-757`); `/api/task/:id` takes no scope (`server.ts:780-789`).
- Inbox readiness rows link to `#backlog`, not the ticket; run blockers link to `#run-map/<id>` (`dashboard/client/attention-inbox-render.js:66-80`).
- **The attention derivation is dashboard-only.** `composeInbox` (`dashboard/src/attention-inbox.ts:210`) has one caller, `dashboard/src/queries.ts:4495`; nothing under `src/cli/commands/` reads it and there is no `forge attention` verb. Current activity, by contrast, is shared: `src/cli/commands/status.ts:17` imports `deriveCurrentActivity` from `src/v2/current-activity.ts`.
- `forge runs query` calls `queryRuns` (`src/v2/runs-query.ts:59`), which walks every run and its top-level tasks per call. `runs` has no ticket column (`src/store/schema.ts:87-110`).
- `shell.ts` media queries sit at 520, 600, 640 and 720px (`dashboard/src/shell.ts:934,1139,1143,1165,1275`). No client file touches `localStorage`.

Verified in Paperclip source: the sidebar's top block (New Task, Search, Dashboard with `liveCount`, Inbox with a danger-toned badge when failed runs exist) followed by collapsible Work and Org sections (`ui/src/components/Sidebar.tsx:145-247`); the client-side inbox badge formula (`ui/src/lib/inbox.ts:1310-1311`) differing from the server's (`server/src/routes/sidebar-badges.ts:86-90`); `MOBILE_BREAKPOINT = 768` (`ui/src/context/SidebarContext.tsx:37`); the five-slot bottom bar with a 99+ cap (`ui/src/components/MobileBottomNav.tsx:45-113`); and agent-detail tab groups with alias parsing that falls back to `overview` (`ui/src/pages/agent-detail-navigation.ts:18-67`). I ran neither UI.

## Current state

Navigation is one horizontal strip of 13 buttons with no grouping, counters or breadcrumbs, scrolling sideways on narrow screens (lane F §1). The rows follow lane F §1's screen table; "who uses it" is my reading.

| Tab | What it shows | Who uses it, when |
|---|---|---|
| home | Plan limits, Attention inbox, In flight, operations tiles | Every operator, every visit: triage |
| activity | Recent agent-output feed, orchestrators, Current-activity Diagnostics | Checking what finished; diagnosing a stuck-looking run |
| projects | Project/checkout registry and classification; a card click sets scope | Setting scope; classifying a workspace (POST) |
| usage | Weighted tokens, time series, model mix, plan-limit windows | Checking spend pace, occasionally |
| ops | Success rate, failure kinds, durations, runtime charts | Health trends, regression hunting |
| workbench | Routing governance for one checkout | "Why does this role route here?" Read-only |
| control plane | Effective config graph for one checkout | Config-precedence debugging. Read-only |
| backlog | Tickets (DB truth) | Reading ticket state. Read-only |
| queue | Five queue projections, dispatcher panel, capacity | Planning: the one surface with rank/enqueue/dequeue/reorder |
| reviews | Last 25 reviews with findings | Reading review outcomes. Read-only |
| shipping | Per-ticket readiness, shipping review, mechanical checks for one project | Deciding whether a ticket ships |
| campaigns | Campaign list and detail, host verifications | Following a campaign |
| run map | One run's DAG; a node click opens Explain | Drilling in from a feed card or inbox row; the bare tab is an empty prompt |

Lane F §9 names ten admitted gaps: DEC-015's interactive ambition against two writable surfaces (1); invariant 10's letter against its spirit across the local and remote boards (2); authority to run kept CLI-only (3); no local authentication (4); unredacted raw logs (5); the scope limits of the no-outbound promise (6); a read-only inbox resolved by pasting a CLI string (7); no cockpit, no run index, and task detail and Explain unlinked (8); Remote Board freshness (9); and schema coupling by convention (10). Items 7 and 8, plus lane F §1's "scope not in the hash" and "task detail and Explain not deep-linkable", are the ones this IA must close.

## Proposed navigation

**Constraints.** The design honours six:

- **Projection only.** The dashboard is a projection; authority stays in the CLI and store (invariant 10).
- **Closed mutation registry.** Mutations go only through a closed registry that shells named CLI verbs: today `QUEUE_MUTATION_ROUTES` and classify, later recommendation 11's action registry. No nav item is itself an action.
- **Server-derived counts.** Badges and counters come from one attention derivation shared with the CLI; there are no client-computed counts and no `localStorage` read state.
- **No org scope.** Forge is host-wide with an optional project filter.
- **Keyboard.** Keyboard-only navigation works (FG-692).
- **Deep links.** Every view is deep-linkable.

The column has a scope control at the top ("All projects", a project, or project › checkout — a filter, never a switcher), the five groups under plain non-collapsible headings, and the last-poll clock at the foot. The "What it answers" column uses lane E's screen contract ("Patterns worth borrowing" 1): **H** what is happening, **N** does it need me, **D** what do I do.

| Group | Item | Route (#hash shape) | What it answers | Badge source | Source of the projection |
|---|---|---|---|---|---|
| Now | Home | `#home[?scope]` (or empty) | N then H: Needs you, In flight | Open-attention count, a server field on `GET /api/attention-inbox` | `composeInbox`; In flight via `/api/in-flight` and `deriveCurrentActivity` (shared with `forge status`) |
| Now | Activity | `#activity[?scope]` | H: what finished; Diagnostics | none | `/api/feed`, `/api/current-activity`, `/api/orchestrators` |
| Plan | Backlog | `#backlog[/<ticketId>][?scope]` | D: what is filed, in what state | none | `/api/backlog` |
| Plan | Notes | `#notes[/<checkout>][?scope]` | H: what each checkout's last session left off | none | `/api/backlog` (`notesByCheckout`) |
| Plan | Queue | `#queue?scope` (project required) | D: what runs next; planning verbs | none | `/api/queue`; writes via `QUEUE_MUTATION_ROUTES` → `forge queue` |
| Plan | Campaigns | `#campaigns[/<id>][?scope]` | H/D: campaign progress, pauses | none (pauses count on Home) | `/api/campaigns`, `/api/campaign/:id` |
| Evidence | Runs (new) | `#runs[?scope&status=]`; object `#run/<runId>[/<tab>]` | H: what ran and is running; entry to the object graph | Active-run count, a server field on `GET /api/runs` | new `GET /api/runs` over `queryRuns` (shared with `forge runs query`); run page over `/api/run/:id/map` |
| Evidence | Task page (object, new) | `#task/<taskId>` | H: result, verdicts, gates, timeline, log tail | n/a | `/api/task/:id` |
| Evidence | Explain (object, new route) | `#task/<taskId>/explain` | H: why it ran this way, from recorded provenance | n/a | `/api/task/:id/explain` (same contract as `forge explain`) |
| Evidence | Reviews | `#reviews[/<reviewId>][?scope]` | H/N: outcomes, open findings | none (open `fix_now` counts on Home) | `/api/reviews` |
| Evidence | Shipping | `#shipping?scope` (project required) | D: can this ticket ship | none | `/api/shipping-audit` |
| Setup | Roles (new) | `#roles`; object `#roles/<role>/<tab>` | H: what each role is, runs on, and why | none | new read-only `GET /api/roles`, `/api/roles/:role` over the seed generation and store (recommendation 14) |
| Setup | Routing (was workbench) | `#routing?scope` (checkout required) | H: effective routing policy | none | `/api/governance` |
| Setup | Config (was control plane) | `#config?scope` (checkout required) | H: effective config and precedence | none | `/api/config-graph` |
| Setup | Projects | `#projects` | D: registry, checkouts, classify | none | `/api/projects`; `POST /api/projects/classify` → `forge projects classify` |
| Health | Usage | `#usage[?scope]` | H: spend, model mix, plan pace | none | `/api/usage*`, `/api/usage/limits` |
| Health | Ops | `#ops[?scope]` | H: success rate, failure mix, durations | none | `/api/ops`, `/api/agent-runtime`, `/api/completed-runs` |

**Note, 2026-09-30 (FG-830): Notes moved out of Backlog.** The Backlog view used to render a "Notes / Session handoff" section above its tickets, one entry per registered checkout. For Forge on 2026-09-29 that made the page about 108,000 px tall and pushed the tickets below the fold. The notes are now their own Plan item after Backlog: `#notes[/<checkout>][?scope]` (project-optional). It lists one row per checkout that has a note, newest session first, and the note itself opens on a page with the FG-821 trail. Its source is `/api/backlog`'s `notesByCheckout`, and it has no badge. The Backlog item keeps the same route and source but renders tickets only. This adds a fifteenth item to the column.

**Order.** The groups descend through the screen contract:

- **Now** answers "needs me" and "happening", so every visit starts there.
- **Plan** is where the operator acts; Queue holds today's only planning verbs.
- **Evidence** holds the drill-through targets that Now and Plan link into, and is the cockpit's home (recommendation 13).
- **Setup** answers "why did it run this way", usually asked from inside a run or task.
- **Health** is 30-second trend data, and it is where the one outbound call on today's Home belongs.

**Why not Paperclip's Work/Org split.** Org works for Paperclip because it has persistent agents; Forge has roles, not employees (recommendations, Explicitly Decline), so Org would be a group of one. Setup puts Roles beside Routing and Config, the two surfaces that explain how a role resolves — the operator's actual question (recommendation 14).

Runs sits in Evidence rather than Now for two reasons. Live work already has one visible owner, In flight on Home (`docs/concepts.md:286-297`), and the index is mostly history.

Object pages highlight their parent item: run, task and Explain highlight Runs; a role page highlights Roles. That keeps the column at 15 items, short enough to need no collapsing.

## Disposition of every current tab

| Current tab | Disposition | Reason | Risk |
|---|---|---|---|
| home | keep (Now); plan-limits card moves to Usage | Already orders "needs me" before "happening" (`main.js:835-878`). The plan-limits card is Home's only outbound path: keychain read, `api.anthropic.com`, `codex app-server`, every 30s (lane F §5) | Operators lose a glance at plan pace; see FG-821 question 6 |
| activity | keep (Now) | The Diagnostics drill-down concepts.md names (`docs/concepts.md:288`) | Low |
| projects | move under Setup | Scope picking moves to the column's scope control; registry and classify are setup | Medium: card-click scoping is habitual. Keep "pick" on cards, writing the same hash scope |
| usage | move under Health | Trend surface, 30s poll | Low |
| ops | move under Health | Trend surface, 30s poll | Low |
| workbench | move under Setup, relabel Routing, `#routing` (alias `#governance`) | The label names neither object nor question | Low; alias preserves links |
| control plane | move under Setup, relabel Config, `#config` (alias `#control-plane`) | Lane F's glossary: this tab "is not the product's control plane"; the label invites the claim recommendation 11 guards against | Low; alias preserves links |
| backlog | move under Plan; add `#backlog/<ticketId>` | Inbox rows promise "Open FG-x" and land on the whole list (`attention-inbox-render.js:70`) | Low |
| queue | move under Plan | The only planning-mutation surface | Low |
| reviews | move under Evidence; add `#reviews/<reviewId>` | Reviews should be reachable from run and task (lane F §1) | Medium: the ledger reads 25 rows, so older links need a by-id read |
| shipping | move under Evidence | Per-ticket readiness evidence | Low |
| campaigns | move under Plan; add `#campaigns/<id>` | Planned multi-ticket intent; detail is component state today | Low |
| run map | merge into Runs as the run page's default tab, `#run/<id>` (aliases `#run-map/<id>`; bare `#run-map` → `#runs`) | The bare tab's only content is "open a run from the activity feed" (`main.js:738`) | Medium: saved and emitted `#run-map/<id>` links must resolve forever; keep the alias permanently |

Tally over the 13 tabs: 2 kept, 10 moved, 1 merged, 0 retired. The strip itself is retired in the layout change, with no flag keeping it alive (recommendation 15; lane E Patterns to avoid 5).

## URL scheme

**Shape.** Every hash is `#<path>[?<params>]`. A closed `ROUTES` table in `view-routing.js` replaces the `VIEWS` set. Each row names:

- the view and its group;
- its path pattern;
- its scope requirement (`none | optional | project | checkout`);
- its legacy aliases.

Unknown parameter keys are dropped. **The active group is not a hash segment**: `#queue` resolves to Plan through the table. A view can change group without breaking a link, and no URL state can disagree with the view.

**Where the group lives.** The active group is represented in the URL by the view segment alone, never by its own segment or parameter. The closed `ROUTES` table (`dashboard/client/view-routing.js`) maps every view to exactly one group, so the hash fully determines the group and every view stays deep-linkable — that is the answer to where the group lives. Carrying a separate group segment or parameter alongside the view would create a second source of truth that could disagree with it. Canonicalization: if a hash ever arrives with a `group=` parameter or a group-shaped leading segment — a future or hand-typed link might carry one — the view wins, the extraneous group is dropped, and the URL is rewritten to its canonical form with `history.replaceState`. This does not change reload semantics: view, object, tab and scope are still the fields restored from the hash (see Reload, below), and the group is recomputed from the view rather than read back off the URL, the same way the existing `hashchange` handler (`main.js:624-632`) already restores view and run without ever reading a group.

**Project scope.** Scope is `?project=<projectKey>[&checkout=<URI-encoded projectDir>]` on list views, mapping one-to-one onto the server's existing `?projectKey=`/`?projectDir=` (`main.js:40-53`).

- Changing scope rewrites the hash with `history.replaceState`. Scope is never kept in `localStorage` (contrast `CompanyContext.tsx:184,197`).
- Moving between list views keeps the scope.
- Views that require a project or checkout render their existing refusal copy (`main.js:728-735`) instead of guessing.
- The checkout parameter puts a host path in the URL. The loopback dashboard already sends `projectDir` to the client, so this is acceptable there, but the Remote Board must never adopt this scheme (lane F §6).

**Object deep links.** Object pages carry no scope. Their ids are global, and Run Map and Explain already work unscoped (`server.ts:730-735,752-757`). A scope arriving on an object hash is dropped; the object's own project becomes the first breadcrumb.

| Object | Hash | Default tab | Reserved tabs (FG-821 decides) |
|---|---|---|---|
| Run | `#run/<runId>[/<tab>]` | `map` | `tasks`, `evidence` |
| Task | `#task/<taskId>` | detail | `log` |
| Explain | `#task/<taskId>/explain` | — | — |
| Role | `#roles/<role>/<tab>` | `overview` | recommendation 14's nine tabs |
| Ticket, campaign, review | `#backlog/<id>`, `#campaigns/<id>`, `#reviews/<id>` | — | — |

Tab handling and links between pages:

- Unknown tabs fall back to the default, and old tab names map through aliases, as in Paperclip's `parseAgentDetailView`.
- A Run Map node click goes to `#task/<id>/explain`; today it opens an overlay (`main.js:737-739`).
- The task page and Explain link to each other, closing lane F §9 item 8.
- Escape on an object page navigates to its parent.

**Breadcrumbs.** Breadcrumbs appear on object pages only; list views show group and title. Three rules govern them:

1. Crumbs are built from the payload, never from history, so an inbox click and a pasted link give the same trail.
2. The chain is Project › Run › Task › Explain, with a ticket crumb before Run when the run payload carries one. `runs` has no ticket column, so the ticket source is an FG-821 question.
3. Every crumb but the last is a link. Project resolves to `#runs?project=<key>`; role pages read Roles › `<role>` › `<tab>`.

**Reload** restores everything in the hash: view, object, tab and scope. It does not restore scroll, open disclosures (Activity → Diagnostics), or chart toggles (usage `since`/`groupBy`, ops window). Those stay component state until FG-820 promotes specific toggles into the closed parameter table, and never into `localStorage`. An unrecognised hash lands on Home with a one-line "No view named …" notice; today the fallback is silent (`view-routing.js:12`).

## Badge and counter policy

Two nav items carry numbers:

- **Home** shows open attention items, danger-toned when any is `severity: "high"`. This is Paperclip's failed-run rule (`Sidebar.tsx:169-176`) keyed to Forge's severity field.
- **Runs** shows active runs. It is an informational live count, like Paperclip's Dashboard `liveCount` (`Sidebar.tsx:168`).

Nothing else is badged. Paused campaigns, readiness gaps, open `fix_now` findings and merge conflicts are already attention kinds, so they count once, on Home. Counting them again on Campaigns, Backlog or Reviews would rebuild Paperclip's three divergent counters (lane E Patterns to avoid 1).

**The single derivation.** Current activity already has the required shape: one derivation under `src/v2/`, read by both `forge status` and the dashboard (`docs/concepts.md:282`). The attention inbox does not; it is derived only inside `dashboard/src/`. The Home badge should not ship until three things are true:

1. The source mappers and `composeInbox` move to a shared module under `src/v2/`.
2. A CLI surface prints the same envelope (`forge attention --json`, or a section of `forge status`).
3. `composeInbox` adds a server-computed `counts: {open, high}` field after dedup.

When recommendation 12's `attention_dismissals` lands, the server excludes dismissed and snoozed items from `counts`, and the client does not change. The Runs count is `queryRuns({status: "active"}).length`, returned by `GET /api/runs` — the same function `forge runs query --status active` calls.

**Honesty rules**, extending the inbox's own (`docs/concepts.md:429-433`):

- A degraded envelope shows its count with a partial marker and an accessible label ("3 open, some sources unreadable").
- An unavailable read shows "?", never 0 and never the last number.
- Only `empty: true` removes the badge.
- Counts above 99 render "99+".

**Explicitly not computed in the client:**

- list lengths, including the envelope's `items.length`;
- per-kind or per-view tallies;
- counts made by filtering a server list in the browser;
- "new since last visit" and read/unread state;
- anything in `localStorage` or `sessionStorage`;
- toast-driven counters.

None of these exists today. The policy keeps it that way.

## Mobile

**Breakpoint: 720px.** `shell.ts` already uses 720 twice (`:1139,1275`); Paperclip's 768 (`SidebarContext.tsx:37`) would add a fifth width for the same job. The 520/600/640 rules stay as content breakpoints.

**Bottom bar plus drawer.** Below 720px a fixed, safe-area-padded bottom bar replaces the column, as in Paperclip (`MobileBottomNav.tsx:45-113`). Its fifth slot, More, opens a drawer holding the full column: scope control, all groups, and the poll clock. Nothing becomes unreachable. The drawer is a modal dialog: it traps focus, closes on Escape, and returns focus to More.

**The five slots:**

1. **Home**, with the attention badge. Both of its questions matter most on a small screen.
2. **Runs**, with the active count. It is the entry to run, task and Explain.
3. **Queue**. It holds the only planning verbs, the likeliest action away from the desk.
4. **Backlog**. It is what the queue acts on and what readiness items link into.
5. **More**.

Paperclip's centre slot is New Task. Forge has no dashboard create action, because dispatch and arming are CLI-only (FG-591 D2; `server.ts:24-29`).

**Hidden from the bar, reachable in the drawer:** Activity, Campaigns, Reviews, Shipping, Roles, Routing, Config, Projects, Usage, Ops.

The local dashboard binds loopback, so "mobile" here mostly means a narrow window or split screen. Phone access is the Remote Board's job: a separate listener that is not a nav item and does not share this URL scheme (lane F §6). The inbox's 360px overflow test (`browser-tests/fg402-attention-inbox-overflow.test.ts`) must keep passing with the bar's height removed from the viewport.

**Keyboard (FG-692), both layouts:**

- Nav items are `<a href="#…">` links, so Tab, Enter and open-in-new-tab work natively.
- The current item carries `aria-current="page"`.
- Group headings are plain headings, not controls.
- A "Skip to content" link comes first.
- Object-page tabs follow the tablist pattern with arrow keys.

## Patterns adopted from Paperclip and patterns declined

**Adopted:**

1. **A short top block, then labelled groups** (lane E §1; `Sidebar.tsx:145-247`). Forge's top block is the scope control plus Now.
2. **A live count on the "happening" item** (lane E §1; `Sidebar.tsx:168`). Forge puts it on Runs, from `queryRuns`.
3. **A danger-toned attention badge when something is severe** (lane E §1; `Sidebar.tsx:169-176`).
4. **A five-slot bottom bar below one breakpoint**, safe-area aware, capped at 99+ (lane E §7; `MobileBottomNav.tsx:45-113`).
5. **Grouped object tabs in the URL**, with alias parsing and an `overview` fallback (lane E §1; `agent-detail-navigation.ts:18-67`). Used for the role, run and task pages.
6. **Filtering history out of the actor page** instead of duplicating it (lane E §1, the Audit hub; `agent-detail-navigation.ts:66-79`). A role's Tasks tab links to `#runs?role=<role>`.
7. **Everything URL-addressable**, so the chain can be walked and shared (lane E §1).
8. **The screen contract as the test for every nav item** (lane E Patterns worth borrowing 1).

   **Note, 2026-09-30 (FG-838): live facts in the header, contract in the tip.** FG-821 printed the three-question line under every title. On list views that line never changed with state, so it was documentation repeated on every visit, and the operator read it as noise. A list view's header is now its title plus any live count (Runs' "N runs are active"). The three answers and the CLI verb moved into an info tip beside the title: a "?" button whose popover can be opened by keyboard. Object pages keep a header line only for facts read from the payload. The contract is still the test for every nav item, but it now lives in the tip rather than on screen.
9. **Order pinning on the 2-second lists beneath the Home badge** (lane E Patterns worth borrowing 3; `useInboxSortAttention.ts:3-22`).

**Declined:**

1. **A route-prefix org scope and a switcher persisted in `localStorage`** (lane E §1; `App.tsx:832`, `CompanyContext.tsx:184,197`). Forge scope is a filter in the hash.
2. **Two "needs me" surfaces with divergent counters** (lane E Patterns to avoid 1).
3. **Client-computed badges and `localStorage` read state** (lane E Patterns to avoid 2; `lib/inbox.ts:21-22`).
4. **Flag-hidden nav entries over mounted routes, and flagged legacy twins** (lane E Patterns to avoid 5; `App.tsx:419`).
5. **A New Task create action in the nav and bottom bar** (lane E §1, §7). Forge has no dashboard dispatch verb.
6. **A Recent Tasks list with live dots** (lane E §1; `Sidebar.tsx:252`). It would be a second live-work owner beside In flight (`docs/concepts.md:286`).
7. **Plugin sidebar slots** (lane E §1; `Sidebar.tsx:222-235`). Forge's view set is closed.
8. **Collapsible sections** (lane E §1). Fifteen items do not need them, and collapse state would be client state to persist or lose.
9. **Run detail buried inside the actor page** (lane E Patterns to avoid 9; `AgentDetail.tsx:3197`).
10. **Search in the nav** (lane E §1). There is no cross-object search endpoint to back it.

## Open questions for the layout ticket (FG-820) and the cockpit ticket (FG-821)

**FG-820 (layout)**

1. Does the Home badge wait for the attention derivation to move under `src/v2/` with a CLI surface, or does the layout ship first with no Home badge? A badge the CLI cannot reproduce breaks the policy on day one.
2. Is there an icon rail between full column and bottom bar, as in Paperclip's `rail`? The dashboard has no icon set.
3. Which chart toggles, if any, join the closed hash parameter table?
4. Should checkout scope in the hash use the raw `projectDir` or an opaque token from `/api/projects`, keeping host paths out of copied links?
5. Are keyboard shortcuts beyond Tab navigation (a `?` cheatsheet, jump keys) in scope, or deferred?
6. Do the relabels (Routing, Config) come with a sweep of `docs/concepts.md` and the stale `dashboard/CLAUDE.md` lane F §2 flags?

**FG-821 (cockpit)**

1. `queryRuns` walks all runs and their tasks per call. Should `GET /api/runs` page, cap by `since`, or poll at 30s rather than 2s?
2. Is the run page's `map` tab plus a task list enough, or do `tasks` and `evidence` (reviews, host verifications, launches) need tabs?
3. What is the ticket crumb's source: run metadata, or a store-level run-to-ticket link?
4. Is a by-id `GET /api/review/:id` in scope, for review links older than the 25-row ledger window?
5. Where do recommendation 11's buttons (gate, retry, recover) sit: task page, inbox row, or both? This document assumes their presence is never badge-bearing.
6. Should a cached, non-polling plan-pace line stay on Home once the plan-limits card moves to Usage?
7. **Resolved.** The release file `backlog/releases/v0.2.0.md` is an untracked operator file on the host, which is why it was not visible in this clone. Its committed dashboard tranche (FG-817 to FG-824) adds behaviors — inbox completeness, dismissal/snooze, an action registry, status tokens, freshness cards — but no navigation surface beyond the four already placed here: run index, task page, Explain, Roles.
