// FG-694: ONE source of truth for the dashboard browser tier's census.
//
// Two guards need to know how big the tier is, and each carried its own hand-kept copy
// of the number:
//
//   - src/util/fg642-browser-tier-consistency.test.ts — the source-level census (exact
//     suite set, exact per-suite test counts);
//   - dashboard/src/fg642-browser-tier-fail-first.integration.test.ts — the behavior
//     proof that a Chrome-less run fails EVERY test in the tier instead of skipping to
//     green, which needs the tier's size to say "every".
//
// FG-694 took the tier from 64 to 66 real-browser tests, updated the first copy and not
// the second — nobody knew the second existed — and `dashboard_integration` went red on
// a stale literal rather than on a defect. Both guards now resolve the count from here:
// the fail-first proof counts the tier itself, so it carries no number at all.
//
// The per-suite map below stays a hand-maintained DECLARATION on purpose: it is the
// tripwire. A total alone cannot see three tests deleted from one suite and three added
// to another, and coverage vanishing quietly is the exact failure FG-642 closed. Growing
// or pruning the tier is fine — update this map in the same commit, on purpose, and
// every guard moves with it.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_TIER_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dashboard",
  "browser-tests"
);

// The tier as FG-642 restored it (5 suites, 18 tests), plus the two FG-648 runtime
// suites — `agent-runtime` grown by the FG-648 review fixes to cover the weekly
// resolution, the width band a viewport breakpoint left illegible, contrast, reduced
// motion, the error state, out-of-order responses and the role write-back;
// `agent-runtime-legibility` added by the reopened ticket's verify phase to attack
// AC8-AC10 (axis truthfulness at the scale edges, mean-and-count pairing swept across
// twelve widths, UTC disclosure on the plot rather than only the caption).
// FG-661 then added one test to `agent-runtime` for the stale-read affordance (RF-15)
// and re-pointed the timezone tests in both suites at the Local/UTC toggle.
// FG-591 then added `fg591-queue-board` (6 tests): the operator work-queue board as an
// operator drives it — a real browser drag-reorder that reaches the durable rank through
// the CLI, the same move by keyboard, a stale-version refusal surfaced rather than
// swallowed, a not-ready enqueue's concrete refinement proposal on screen, blocked vs.
// waiting-to-overlap kept visibly distinct, and the CLI-only dispatcher panel.
// FG-699 adds `fg699-scope-invalidation` (6 tests): scope changes on the ops runtime
// panel invalidate the displayed payload for BOTH metrics. Checkout-banner, Projects
// card (`filterByProject`), and clear-filter (`clearProjectFilter`) paths drop their
// prior scope's chart/numbers to loading while the new read is pending, a prior
// scope's error cannot be carried into the newly selected scope, and a slow
// leaving-scope failure landing after the switch cannot repaint the abandoned scope.
// FG-679 added `fg679-current-activity` (9 tests): the rendered Current activity
// surface — three distinct sections, the four BD-4 launch statuses as four distinct
// strings, `unobserved since <t>`, per-context required CI, old-sha evidence
// disappearing, and the no-host-path/read-only guarantees.
// FG-694 grew that suite to 12: the compact hierarchy under the reported historical
// noise, and one test per malformed-payload depth AC7 has to survive in a real browser —
// a null AGENT entry (RF-3) and a null CI CONTEXT inside a valid-looking observation
// (RF-5). Both used to throw mid-render, which leaves the operator a blank surface
// rather than the unavailable state and its Retry. FG-700 adds the mixed live-launch
// shape: one declared verification and every associated invoke/review/campaign launch
// remain separately visible in Activity.
// The FG-694 POST-SHIP CORRECTION then added `fg694-home-in-flight` (9 tests): Home's
// own shape, which the suite above no longer asserts because the `Current activity`
// panel moved off Home onto the Activity view. One activity surface, no agent rendered
// twice, compact host/CI waits with no sha/URL/timestamp/argv, no CI from a closed
// ticket's unfinished review, the In-flight surface inside the 862px viewport the
// reported 810.5px panel overflowed, and the failed-read line that keeps the section
// from implying it looked at launches and checks. The ninth is the correction's own
// correction: a running launch nobody associated with current work — the dashboard
// server, placed by its cwd — is host activity to read on the Activity view, not a wait
// to watch on Home.
// FG-683 added `completed-runs` (8 tests): the runtime panel's metric selector and
// the count chart behind it — both metrics offered with the duration one still the
// default, an integer runs axis that cannot be read as the duration chart, zero
// buckets drawn as observed zeros, a dense window's label thinning and fallback
// list, the Local/UTC toggle proven to move labels and nothing a count is read off,
// the duration chart restored untouched on the way back, the count read's own
// error, and containment at 390px.
// FG-683 verification also adds `completed-runs-real-store` (2 tests): it takes
// the selector through the real dashboard server and production schema, including
// canonical checkout scope, dedupe against related records and a phone-to-desktop
// count-chart legibility sweep.
// FG-663 adds `fg663-deleted-checkout` (1 test): a run written from a disposable
// checkout remains visibly attributed to its project after that checkout is gone.
// FG-643 adds `fg643-sanitize-markdown` (1 test): a hostile ticket body stored
// through the real backlog path renders inert in a real browser — no
// script/handler/navigation executes, stored bytes unchanged, a benign control
// still renders.
// FG-386 adds `fg386-shipping-audit` (9 tests): the read-only shipping-audit panel
// in a real browser — every audit state as its own labelled badge with absence
// rendered not_observed (never green), mechanical checks and model reviewer findings
// in visually distinct blocks, a failed mechanical check surfacing an actionable
// failure message (gate + exit code + reproduce), a superseded row marked stale rather
// than a live pass, an open architecture question reading as needs-human on the review
// axis, an unselected project rendering the empty/unselected state rather than a
// perpetual spinner, the details toggle exposing aria-expanded/aria-controls (RF-4), an
// accepted-deferral follow-up ticket rendered as a link (RF-7), and a scope switch
// clearing the panel so a failed new-scope response never retains the prior project's
// rows (RF-3).
// FG-731 grows `fg679-current-activity` to 15 (the registered CI-wait rows in the
// Activity view's Current activity panel: kind/state with no_runs/unavailable/
// completed-awaiting-advance as distinct rendered facts, and the #1-risk case — a wait
// stale past its freshness cutoff STILL renders, its label degraded to unavailable
// rather than dropped or shown running) and `fg694-home-in-flight` to 10 (a registered
// CI wait keeps Home WAITING, never IDLE, folded into In flight with nothing else live).
// FG-745 adds `fg745-projects-classification` (6 tests): the Projects grid derives
// visibility SOLELY from the /api/projects payload against the real server, store and
// co-located classify CLI — a recorded disposable artifact is suppressed, an unrecorded
// independent/legacy project renders `unclassified` with a working classify affordance,
// classifying a legacy directory away removes its card, classifying an independent project
// keeps it in operator membership, RF-3 keyboard-activating the classify toggle opens
// its form without also activating the card, and (review RF-1) after a keyboard-driven
// classify focus lands on the status confirmation rather than being stranded on <body>.
export const TIER_TESTS: Readonly<Record<string, number>> = {
  "agent-runtime-legibility.test.ts": 12,
  // FG-746 adds a shipping-audit check-timestamp assertion (9 -> 10) and a campaign-detail
  // reconcile-gate evidence assertion (2 -> 3) as the historical verification evidence is
  // relocated contextually, plus three new suites for the retired Verification tab: the
  // tab/route retirement, the Current Activity live placement, and the Explain evidence block.
  "fg386-shipping-audit.test.ts": 10,
  // FG-692 (FG-727) adds a focus-containment test to the campaign detail dialog (3 -> 4).
  "fg395-campaigns.test.ts": 4,
  "fg746-verification-tab-retired.test.ts": 2,
  "fg746-current-activity-verification.test.ts": 2,
  "fg746-explain-evidence.test.ts": 2,
  "agent-runtime.test.ts": 18,
  "backlog-count.test.ts": 2,
  "completed-runs.test.ts": 8,
  "completed-runs-real-store.test.ts": 2,
  "fg591-queue-board.test.ts": 6,
  "fg643-sanitize-markdown.test.ts": 1,
  "fg663-deleted-checkout.test.ts": 1,
  "fg679-current-activity.test.ts": 16,
  "fg694-home-in-flight.test.ts": 10,
  "fg699-scope-invalidation.test.ts": 6,
  "fg745-projects-classification.test.ts": 6,
  // FG-781 adds `fg781-remote-board` (9 tests): the focused Remote Board client renders the
  // five projection states honestly in a real browser — the live board, a stale board marked
  // explicitly NOT live (including the RF-3 overlapping-refresh stale-never-live case),
  // and the three refusal states (host-unavailable/unauthorized/unsupported) each carrying no
  // project card. Plus screen-reader landmarks/heading-hierarchy/status region, a
  // keyboard-reachable Refresh that re-reads on Enter, single-column no-overflow on a phone
  // and a multi-column grid on a desktop, and a full render with no active agent session (AC5).
  "fg781-remote-board.test.ts": 9,
  // FG-783 adds `fg783-remote-board-plan` (12 tests): the bounded planning UI on the remote board
  // in a real browser — the four planning categories (five wire actions) reachable as accessible
  // triggers; on a recorded APPLIED outcome the client re-reads /api/board rather than optimistically
  // painting success; a stale-precondition refusal surfaces the redacted safe summary and a retry
  // path while applying nothing; the submitted envelope carries the LOADED queue version and no
  // server-authoritative key; keyboard open/close with focus return and a keyboard submit; the
  // dialog's screen-reader semantics (labelled modal, status + alert live regions, labelled fields);
  // and idempotency across a transport failure (the retry reuses the request id). The remediation
  // review adds four: RF-2 gates affordances on the 'plan' capability (a read-only board shows none)
  // and carries the loaded ticket revision as the annotation precondition; RF-3 announces the applied
  // outcome in a PERSISTENT live region that survives the dialog close; RF-4 fails planning closed
  // (an 'unsupported' note, no controls) when the browser has no Web Crypto random source.
  "fg783-remote-board-plan.test.ts": 12,
  // FG-692 adds `fg402-attention-inbox-overflow` (2 tests): the Attention Inbox row
  // grid does not force a horizontal scroll on a 360px viewport, and its responsive
  // override collapses the row to a single column there (FG-402 RF-3).
  "fg402-attention-inbox-overflow.test.ts": 2,
  // FG-819 adds `fg819-order-pinning` (5 tests): every store vocabulary kind travels through
  // the Home inbox route into a distinct real-browser badge (with an unknown future kind
  // retained under its neutral fallback), and the inbox and In-flight rows hold their order
  // across re-ranked polls until the idle or tab-visibility boundary; manual Refresh re-sorts
  // and adopts the freshly fetched order rather than the order already held.
  // FG-692 (FG-819 RF-1) adds keyboard focus tabbing into the inbox as reader activity (5 -> 6).
  "fg819-order-pinning.test.ts": 6,
  // FG-820 adds `fg820-left-column-nav` (7 tests): the left column that replaced the tab
  // strip — the five groups and their link items with Skip to content first; aria-current on
  // the current item and on an object page's parent; a reloaded deep link restoring view and
  // scope (sent to the server as ?projectKey/?projectDir, rewritten in place on change);
  // alias/group-shaped/unknown hashes canonicalized; the Home badge read from the server's
  // `counts` (danger, "?", partial, hidden-when-empty, 99+); and the 400px bottom bar with a
  // focus-trapped drawer that Escape closes. Its fixture server listens on port 18824.
  // FG-840 extends Routing coverage with scoped-project and unscoped-host audit-source captions.
  "fg820-left-column-nav.test.ts": 8,
  // FG-821 adds `fg821-cockpit-pages` (12 tests): the run index (rows, the hash-carried status
  // filter, Load more over the server cursor); the Runs badge from GET /api/runs's activeCount
  // (never danger, "?" when unreadable, hidden at 0, on the bottom bar too); the run page's map
  // and evidence tabs and the permanent #run-map alias; the task page deep link across reload
  // with its links row and its Explain page; the failed-task header's verb and advice; the same
  // payload-built breadcrumb trail for an inbox click and a pasted link; Escape to the parent;
  // the scoped ticket page; and a review by id. The verify regression walks ticket → run → task
  // → Explain → review and proves each payload breadcrumb trail matches a cold deep link.
  // FG-821 also rewrote fg820's run-map/placeholder
  // cases and fg348's overlay cases for the pages (counts unchanged). Fixture port 18825.
  "fg821-cockpit-pages.test.ts": 12,
  // FG-822 adds `fg822-task-actions` (5 tests): the task page's action buttons on its screen
  // line, labeled with their verb, with a refused action's advice instead of a button (and
  // no buttons when the bind refuses mutations); the gate's preview-before-confirm and its
  // required rationale; the verb's exit status and output inline, success and CLI refusal;
  // and an inbox row whose verb button replaces the requestedAction and acts in place;
  // FG-692 keyboard focus and Enter reach both task-header and inbox-row actions.
  // Fixture port 18826.
  "fg822-task-actions.test.ts": 5,
  // FG-846/847 adds the refusal-at-the-point-of-action loop: real Chrome verifies the
  // focused inline refusal, Escape, in-place refinement through the CLI and re-enqueue,
  // plus the ready outcome, ticket-page edit hash, keyboard controls and 400px layout.
  // Fixture port 18860.
  "fg846-queue-refusal.test.ts": 2,
  // FG-823 adds `fg823-attention-dismiss` (8 tests): the Home inbox's Dismiss and Snooze
  // against the real core `composeInbox` — Dismiss hides the row and the Home badge drops on
  // the next read; new activity resurfaces it; a preset snooze holds, then returns once it
  // passes; Undismiss from the foot's "Dismissed" disclosure; every control operable by
  // keyboard; a row shows one preview at a time (hold or task action), opening one focuses
  // its first control and Escape closes it; an inbox holding only dismissed or snoozed items
  // names the held count instead of calm empty copy; and localStorage/sessionStorage stay empty
  // throughout. Fixture port 18828.
  "fg823-attention-dismiss.test.ts": 8,
  // FG-817 adds `fg817-roles-pages` (8 tests): the Roles list under Setup (every seed with
  // its default activity, resolved profile/effort, mount and last task; the FG-820
  // placeholder gone); a deep link to #roles/engineer/instructions restored across reload
  // with the composed prompt's sections marked and rendered byte for byte; every one of the
  // ten tabs (FG-827) rendering with its source caption; the FG-692 tablist keyboard (arrow keys,
  // wrapping, roving tabindex); the Roles › <role> › <tab> trail; Escape to the list; a seed
  // missing settings.json saying so, an unknown tab landing on overview, an unknown role
  // named; and the 400px role page fitting the viewport. Fixture port 18830.
  "fg817-roles-pages.test.ts": 8,
  // FG-824 adds `fg824-status-tokens` (6 tests): every attention-inbox kind and every task
  // status paints through the status token map (class, label, tone accent and computed colour),
  // an unknown kind or status paints the neutral fallback labeled "(unrecognized)"; a launch row
  // reads "unobserved for N min" at the 15-min suspicious and 60-min critical thresholds,
  // measured by the payload's generatedAt (the injected clock) and never on a terminal outcome;
  // the task page's recovery card names the failure kind, the last forge recover and the next
  // verb — a button through the FG-822 preview for an eligible re-drive, the policy's advice
  // otherwise; and FG-692 Tab/Enter reach the recovery button, its preview and Confirm.
  // The sixth test pins the 14m59s/15m/59m59s/60m injected-clock boundaries. Fixture port 18832.
  "fg824-status-tokens.test.ts": 6,
  // FG-827 adds `fg827-roles-second-pass` (9 tests), rendering the REAL roles.ts roleDetail
  // over a scratch FORGE_HOME: the Instructions Files panel in composition order with the
  // seed CLAUDE.md marked ENTRY, Read rendering Markdown and Raw the exact file bytes; the
  // Composed view byte for byte with its sha256 and the selected file's section marked; the
  // Harness / Runtime table (one row per activity) with captioned container facts and raw
  // files behind a closed disclosure; Skills rows with description, source badge, optional
  // and seed-reference flags beside the empty "available, not mounted" and host-only groups;
  // the Capabilities card, routes, result-contract fields and constraints; Tools' effective
  // access and image toolchain; Usage's 1d/7d/30d/all periods by provider and model; and the
  // Overview's Latest task card and Skills chips with no status pill on any role tab or the
  // Roles list. The ninth covers tab reload/alias canonicalization, Files keyboard and copy,
  // hostile Markdown as text rather than DOM, and the 400px panel/viewer layout.
  // fg817-roles-pages keeps its 8 tests, rewritten for the ten tabs and the
  // configuration → harness alias. Fixture port 18831.
  "fg827-roles-second-pass.test.ts": 9,
  // FG-828 adds `fg828-roles-sort` (6 tests): the Roles list's header buttons sort the one
  // fetched payload (no refetch), ascending then flipped, with aria-sort and a direction
  // glyph on the active column and missing values last; the #roles?sort=&dir= hash
  // restored across a reload and a pasted link; Tab/Enter/Space operating a header
  // (FG-692); and an unknown sort or dir dropped to role ascending. The verification
  // additions prove every column's mixed missing-value/tie behavior, hash scope retention,
  // and Last task keyboard sorting at 400px. Fixture port 18833.
  "fg828-roles-sort.test.ts": 6,
  // FG-829 adds `fg829-role-glyphs` (5 tests): every Roles list row carries a 20px role
  // glyph tile painted (computed style) in its family colour — every red-* red and nothing
  // else red, an unknown role neutral with the layers glyph — with no image request; a role
  // page's title carries the 36px tile; Home's In flight rows and Activity's Recent agent
  // outputs carry the 20px tile inside the role-name link; every tile beside a visible
  // name is aria-hidden while the link's accessible name stays the role; and an actual
  // Preact-rendered standalone tile exposes its labelled image semantics. Fixture port 18834.
  "fg829-role-glyphs.test.ts": 5,
  // FG-831 adds `fg831-checkout-labels` (4 tests), against the REAL server over a scratch
  // registry: the scope bar labels every checkout by path context plus branch (two
  // disposable clones both called `forge` on `main` read apart), primary first and marked;
  // a missing checkout withheld behind "show 1 missing", labeled `missing on disk` when
  // shown, and selectable with its runs rendering; and the Projects card's missing count
  // naming `forge projects prune --missing`; and at 400px, the drawer's unique options
  // carry its selected label unchanged into the Runs row. `inactive-checkouts` keeps its 3 tests,
  // re-pointed at the missing affordance. Fixture port 18835.
  "fg831-checkout-labels.test.ts": 4,
  // FG-832 adds `fg832-backlog-filter` (5 tests): a fresh #backlog?project= shows only
  // active tickets with type All and status Active pressed and "N of M tickets"; choosing
  // Done shows the done tickets, writes `&status=done`, and a reload restores type and
  // status; a pasted link restores its filter, unknown values fall back silently to the
  // bare hash, and a #backlog/<id> deep link drops the filter params; Tab/Enter/Space
  // operate the grouped controls (FG-692). `backlog-count` and `fg608-backlog-cutover`
  // keep their counts, choosing "all" statuses where they need every ticket. Fixture
  // port 18836. Verification also adds a complete type × status fixture proving the
  // active default covers every type, scoped clicks preserve FG-820's project and do
  // not re-fetch the already-loaded payload, and the header's "N of M tickets" count
  // agrees with the active filter. The left column has no Backlog badge.
  "fg832-backlog-filter.test.ts": 5,
  // FG-830 adds `fg830-notes-view` (8 tests): the Backlog starts at its tickets with no
  // notes section or per-checkout note list; `#notes` under Plan (after Backlog) lists one
  // row per checkout with a note — unique FG-831 labels, newest session first (note line,
  // else file mtime, else "unknown"), a one-line preview, the primary marked — and with no
  // project asks for one; a row opens `#notes/<checkout>` with the note through the
  // sanitized renderer and the Project › Notes › checkout trail; the deep link survives
  // reload; Escape returns to the scoped list; and both fit at 400px. `usage-limits` keeps
  // its 8, its handoff case re-pointed from the Backlog cards to the Notes rows; `fg820`
  // keeps its 7 with Notes in the Plan group and tab order. Verification additionally
  // proves every Notes row's FG-831 label exactly matches its scope-bar checkout label,
  // mixed note/mtime/unknown dates and the primary mark, plus FG-692 Enter activation
  // with hostile script, event-handler, and javascript-link markup inert. Fixture port 18837.
  "fg830-notes-view.test.ts": 8,
  // FG-838 adds `fg838-info-tip` (7 tests): Home renders its title with no static
  // three-answer line and a 20px "?" beside it whose hover tooltip names what the page
  // shows; Enter opens the popover as an announced dialog with focus moved in, holding the
  // three answers and the verb, Escape closes it with focus back on the "?", Space and a
  // click toggle it and a click outside closes it; Tab reaches Copy, which copies the verb;
  // Backlog, Roles and Ops carry no line under the title and each its own tip, Runs only
  // "N runs are active", and the Roles Source caption sits in a footer under the table;
  // and at 400px the "?" stays on the title's line with the popover inside the viewport.
  // Verification adds a route-table-driven sweep of every FG-820 list route: exactly one
  // tip per rendered header, every view's contract and verb in its popover, and no static
  // three-answer line; plus a mixed fixture through failed/gated tasks, an active run, and
  // an open review proving their object headers retain live facts without static filler.
  // `fg821-cockpit-pages` keeps its count, its run-index line assertion re-pointed at the
  // live count alone. Fixture port 18839.
  "fg838-info-tip.test.ts": 7,
  // FG-836 adds `fg836-ops-window` (7 tests): changing the Ops runtime window shows the
  // loading state — every window button disabled, the chart dimmed under a "loading 30d…"
  // line in the FG-824 info tone — over the kept 7d series labelled "showing 7d", then
  // "showing 30d" once its data lands; `#ops?window=90d` survives a reload and is the first
  // window read; a failed read names its reason inline and the window it kept; a read past
  // the 10s client budget is cancelled and reported; a window change mid-read aborts the
  // in-flight request; an unknown window falls back to 7d silently; and a control writes
  // one navigable hash entry without background polling churning history. `agent-runtime`,
  // `agent-runtime-legibility` and `completed-runs` keep their counts, re-pointed at the
  // kept-series semantics (a window click settles on "showing <w>"). Fixture port 18840.
  // The second pass (7 -> 13) gives the summary's own `#ops?since=` control the same
  // honesty: a since change dims the kept summary under "loading 30d… showing 7d until
  // it answers", then settles on "showing 30d" with each count's "in 30d"; a reload
  // restores since and window together; an unknown since falls back to 7d silently.
  // Its follow-up cases paste `since` and `window` in either order through reloads, prove
  // the two independent readers cannot overwrite each other's captions while one is slow,
  // and retain `since` across a project-scope change while the newer scoped read wins.
  "fg836-ops-window.test.ts": 13,
  // FG-834 part 2 adds `fg834-raci-editor` (5 tests), against the REAL server (GET /api/raci,
  // POST /api/raci/propose|apply) over a scratch FORGE_HOME whose checkout carries an override,
  // with a recording `forge` shim that execs the real CLI: Edit RACI opens by keyboard on the
  // override; editing review_backend shows the dry-run's "changed (was red-backend)" row;
  // Propose renders the diff, the ~1 changed summary and the gate pill; Apply stays disabled
  // (and the server refuses confirm_key_mismatch) without the typed key, then applies with it,
  // shells the exact argv, re-reads the routes and the RECORDED tail; a validation error is
  // shown by line with Propose disabled; a reload keeps edit mode but not the draft, with no
  // browser storage, and the section chips work by keyboard; Reset to host default proposes
  // and applies the host text (the override rewritten, never deleted); and a CLI gate refusal
  // on apply (a weakened host force rule) is shown, with any later edit superseding the
  // proposal. The refusal case continues through the complete authoring route with keyboard
  // only at 400px and verifies that neither browser storage area is used after Apply. Fixture port 18841.
  "fg834-raci-editor.test.ts": 5,
  // FG-837 adds `fg837-roles-parity` (8 tests): the Roles list after Paperclip — each row's
  // 36px tile, name over a one-line subtitle, mono model over profile, family · activity,
  // relative time and mount pill, no row past two text lines at 1200px and 900px, and the whole row a link; the
  // family tabs filtering client-side in `#roles?family=` composed with FG-828's sort, across a
  // reload, with empty families hidden; keyboard reach of family tabs and sort headers; the role
  // page's grouped left sub-nav, header, Overview strip, cards and Recent tasks at 1200px; the
  // sub-nav by Tab/Enter with the configuration alias, breadcrumbs and Escape intact; the
  // collapse to the FG-817 tablist under 900px; and computed AA contrast on every new text
  // element. Fixture port 18842.
  "fg837-roles-parity.test.ts": 8,
  // FG-835 part 2b adds `fg835-models-editor` (6 tests) for Setup › Models, against the REAL
  // server (GET /api/model-policy, POST /api/model-policy/propose|apply) over a scratch
  // FORGE_HOME carrying every seed role and the seed runtimes as a published generation, with
  // a recording `forge` shim that execs the real CLI: a quick edit of one profile's model
  // rewrites exactly that YAML line, the dry-run tags the changed row "was …", Propose renders
  // the before → after resolution diff, Apply stays disabled (and the server refuses
  // confirm_key_mismatch) without the typed target and applies with it — the table, the
  // RECORDED tail, the backups and the role's Harness tab re-read; a runtime error shown by
  // line with Propose disabled; an undispatchable override refused as the CLI words it, the
  // proposal superseded and Apply disabled, never --allow-undispatchable; Restore… proposing a
  // backup and applying it through the gate; a reload keeping edit mode but not the draft, no
  // browser storage, and Config's link here; and a keyboard-only project-override apply at
  // 400px. `fg820-left-column-nav` keeps its count with Models in the Setup group. Fixture port 18843.
  // Its review fix batch adds two: a backup over the candidate limit shows Restore… disabled
  // with its size and the limit (the server refusing its bytes), and a resolution row's role
  // link opening the Harness tab under the scope the row was resolved at (project override
  // scoped, host file unscoped).
  "fg835-models-editor.test.ts": 8,
  // FG-845 adds three real-browser cases for Config's git-attribution row and its
  // closed-registry controls: host inheritance across two projects, a project override
  // followed by inherit/fail-closed handling, and FG-692 keyboard + 400px layout. Fixture 18855.
  "fg845-attribution-setting.test.ts": 4,
  // FG-844 adds `fg844-queue-board` (6 tests) against a fixture queue with a 200-card Queued
  // lane, a 20-card Blocked lane and a 21-card Done lane: at 1400, 1200 and 1000px every lane header on one line with
  // the document bounded by the viewport plus the controls above the board; the long lane
  // scrolling inside itself while every other header and the page stay put; compact cards past
  // 20 expanding on focus, hover and an aria-expanded toggle; the under-900px lane strip with
  // `#queue?lane=` surviving a reload and an unknown lane falling back to the first with
  // cards; and Tab through the focusable sideways scroller reaching every lane in board order
  // with no stop in a header. `fg591-queue-board` keeps its 6. Fixture port 18851.
  "fg844-queue-board.test.ts": 6,
  // FG-843 adds `fg843-checkout-scope` (9 tests), against the REAL server over a scratch
  // registry (a registered primary, a second checkout registered with `forge projects
  // classify --purpose operator`, three run-only directories one of them deleted, and a
  // one-checkout project): after selecting a project the scope column holds the select
  // alone; Routing's header chooser lists the two live operator checkouts, primary first and
  // marked, with the run-checkout count in its footer, and a pick rewrites `?checkout=` and
  // re-reads (Config keeping it); a Routing pick scopes the governance read alone while the
  // shared project reads and nav badges keep the project scope (RF-2); the one-checkout project shows the plain label on Routing,
  // Config and Notes; Home/Activity/Runs/Backlog/Roles/Models/Ops/Usage/Queue/Reviews show no
  // chooser and drop `checkout=`; a run-checkout deep link opens labelled `run checkout` and
  // offers the operator checkouts; the FG-692 keyboard path (Enter, arrows, Enter, Escape
  // returning focus); Runs' per-row labels across every checkout; and the 400px layout.
  // FG-831, FG-830, FG-820, FG-828, FG-699, FG-349 and inactive-checkouts keep their counts,
  // re-pointed from the retired scope-bar checkout list to the header chooser, the Runs rows
  // or the project select. Fixture port 18845.
  "fg843-checkout-scope.test.ts": 9,
  // FG-747 RF-3 adds `fg747-client-model-mix` (1 test): two independent durable
  // identities that share ONE display label keep SEPARATE client model-mix drill-downs
  // and independent expand state — the client joins the mix map by durable identity key,
  // never by the (non-unique) label, so it never re-collapses what RF-1 fixed on the
  // backend.
  // FG-692 (FG-747 RF-1) adds a keyboard-activation test for the drill-down row (1 -> 2).
  "fg747-client-model-mix.test.ts": 2,
  // FG-590 adds `fg590-retention-disposition` (2 tests): the terminal-launch retention
  // disposition (retained-for-investigation vs expired/eligible vs leaked) rendered into
  // the page via the shared rule, and the running-launch/legacy no-claim case.
  "fg590-retention-disposition.test.ts": 2,
  // FG-349 RF-2 adds `fg349-control-plane-scope` (3 tests): the Control Plane
  // config-graph read is scope-guarded like every other project-scoped panel —
  // switching checkout scope drops the graph to loading rather than showing the
  // previous checkout's graph under the new scope's label; a slow leaving-scope
  // response landing after the switch cannot repaint the abandoned checkout (seq
  // guard); and a scope change during the response BODY decode (`await res.json()`)
  // cannot render the retired checkout's graph either (the post-decode seq check).
  "fg349-control-plane-scope.test.ts": 3,
  // FG-743 adds `fg743-campaign-wait-lifecycle` (1 test): terminal historical campaign
  // waits are not rendered as live in-flight work.
  "fg743-campaign-wait-lifecycle.test.ts": 1,
  // FG-821 turned the Explain overlay into the #task/<id>/explain page: the RF-2/RF-3 panel
  // cases now pin Escape-to-parent and the absence of a modal, and the scope-invalidation case
  // a run-to-run navigation guard (object pages read unscoped). Still 6.
  // FG-348 adds `fg348-run-map` (4 tests): the Run Map + task Explain browser view —
  // a run deep-linked via #run-map/<id> renders its graph and a node click opens the
  // "Why this task?" Explain panel, a checkout-scope change invalidates the map and a
  // late leaving-scope response cannot repaint it (runMapSeq guard), a degraded/legacy
  // run renders inferred labels with its warning and no page error, and the view boots
  // offline under a script-src 'self' CSP with no external/CDN fetch.
  // FG-692 (FG-348 RF-2) adds a keyboard-dismissal/focus test for the Explain panel (4 -> 5),
  // and (FG-348 RF-3) an aria-modal focus-containment test for the Explain panel (5 -> 6).
  "fg348-run-map.test.ts": 6,
  // FG-692 adds `fg692-orchestrator-keyboard` (1 test): orchestrator-row keyboard
  // activation a11y — interactive orchestrator rows announce button semantics and open
  // their task detail view on both Enter and Space. The FG-692 fix batch then added
  // RF-2 (Enter/Space on a nested remote-control link does not steal its activation) (1 -> 2).
  "fg692-orchestrator-keyboard.test.ts": 2,
  "fg608-backlog-cutover.test.ts": 3,
  "inactive-checkouts.test.ts": 3,
  "offline-boot.test.ts": 2,
  "usage-limits.test.ts": 8,
};

/** The suite set the map declares, in the order `tierSuites()` reports. */
export const DECLARED_TIER_SUITES: readonly string[] = Object.keys(TIER_TESTS).sort();

/** The tier's size as DECLARED. Compare against `tierTestTotal()`, never restate it. */
export const DECLARED_TIER_TOTAL = Object.values(TIER_TESTS).reduce((sum, n) => sum + n, 0);

export const tierSuites = (): string[] =>
  readdirSync(BROWSER_TIER_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

export const tierSource = (file: string): string => readFileSync(join(BROWSER_TIER_DIR, file), "utf8");

/** Top-level `test(` declarations per suite, counted from the tier as it stands on disk. */
export function countTierTests(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of tierSuites()) counts[file] = (tierSource(file).match(/^test\(/gm) ?? []).length;
  return counts;
}

/** The tier's size as it actually is — derived, so a guard using it needs no literal. */
export const tierTestTotal = (): number => Object.values(countTierTests()).reduce((sum, n) => sum + n, 0);
