// forge-dashboard client. Preact + htm; no build step. Polls every 2s.

import { createContext, h, render } from "preact";
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext } from "preact/hooks";
import htm from "htm";
import { UsageView } from "./usage.js";
import { UsageLimits } from "./usage-limits.js";
import { RoutingView } from "./raci-editor-view.js";
import { ModelsView } from "./models-editor-view.js";
import { BacklogView } from "./backlog.js";
import { QueueBoardView } from "./queue-board.js";
import { ReviewsView } from "./reviews.js";
import { ShippingAuditView } from "./shipping-audit.js";
import { CampaignsView } from "./campaigns.js";
import { ControlPlaneView } from "./control-plane.js";
import { RunPage } from "./run-page-view.js";
import { TaskPage, ModelBadge, CopyIdButton } from "./task-page-view.js";
import { TicketPage } from "./ticket-page-view.js";
import { NotesView, NotePage } from "./notes-view.js";
import { ReviewPage } from "./reviews.js";
import { RunsIndexView } from "./runs-index-view.js";
import { RolesIndexView } from "./roles-index-view.js";
import { RolePage } from "./role-page-view.js";
import { RUNS_LOADING, RUNS_POLL_MS, readRuns, runsUrl } from "./runs-index-render.js";
import { listScreenLine } from "./screen-header-render.js";
import { InfoTip } from "./info-tip.js";
import { ScreenLine } from "./object-page-view.js";
import { ROUTES, GROUPS, parseHash, hashFor, carriesScope, carriesCheckout, navItemFor } from "./view-routing.js";
import { NavColumn, BottomBar, NavDrawer } from "./nav-view.js";
import { scopeSummary, scopedHref } from "./nav-render.js";
import { MISSING_LABEL, PRUNE_VERB, checkoutLabel, checkoutLabelForDir, dedupeCheckouts, knownCheckout, viewCheckout } from "./checkout-label.js";
import { CheckoutChooser } from "./checkout-chooser-view.js";
import { verificationRowBadge } from "./verification-render.js";
import { ACTIVITY_LOADING, createActivityReader, homeInFlightActivity } from "./current-activity-render.js";
import { CurrentActivitySection, InFlightActivityWaits } from "./current-activity-view.js";
import { INBOX_LOADING, readAttentionInbox } from "./attention-inbox-render.js";
import { PinnedAttentionInboxSection } from "./attention-inbox-view.js";
import { TaskActions } from "./task-actions-view.js";
import { RoleTile } from "./role-glyph-view.js";
import { PinRefreshButton, usePinnedOrder } from "./order-pin-view.js";
import { formatDuration, formatRelativeTime, shortSha } from "./format.js";
import { badgeClass, statusClass, statusLabel, toneAccentClass } from "./status-tokens.js";
import { EMPTY_WINDOW_LOAD, OPS_SINCES, RUNTIME_WINDOWS, createWindowedReader, opsSinceHash, opsSinceState, runtimeWindowHash, runtimeWindowState, windowLoadView } from "./ops-window-state.js";

const html = htm.bind(h);
const POLL_MS = 2000;
// Home's Operations summary is not hash state; it keeps the 30d it has always read.
const HOME_OPS_SINCE = "30d";
const USAGE_POLL_MS = 30000;
// Sentinel for the runtime chart's default "All agents" series. Not a role, so
// it can never collide with a real agent_role coming back from the API.
const RUNTIME_ALL_ROLES = "__all__";
// FG-683: the two metrics the runtime panel can chart. Duration is the default
// and is unchanged; completed runs is a COUNT OF RUNS off its own endpoint.
const RUNTIME_METRIC_DURATION = "duration";
const RUNTIME_METRIC_COMPLETED_RUNS = "completed-runs";

function projectScopeQuery(project, checkoutDir = null) {
  if (!project) return "";
  const params = new URLSearchParams();
  if (checkoutDir) params.set("projectDir", checkoutDir);
  else params.set("projectKey", project.key);
  return `?${params.toString()}`;
}

function appendScope(url, project, checkoutDir = null) {
  const q = projectScopeQuery(project, checkoutDir);
  if (!q) return url;
  return `${url}${url.includes("?") ? "&" + q.slice(1) : q}`;
}


function App() {
  // FG-820: the hash is the source of truth for view, object id and — on list views —
  // scope (view-routing.js). Scope-less views and object pages leave the scope in hand
  // untouched, so moving between list views keeps it. Never persisted anywhere else.
  const [initialRoute] = useState(() => parseHash(window.location.hash));
  const [route, setRoute] = useState(() => ({ view: initialRoute.view, id: initialRoute.id, tab: initialRoute.tab, params: initialRoute.params }));
  const [scope, setScope] = useState(() => initialRoute.scope);
  const [routeNotice, setRouteNotice] = useState(() => initialRoute.notice);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const moreRef = useRef(null);
  const mainRef = useRef(null);
  const view = route.view;
  // The server scope: `projectFilter` is keyed on the project key alone so its identity
  // only changes when the scope does, which is what every scope-invalidation effect keys on.
  const projectFilter = useMemo(() => (scope.project ? { key: scope.project } : null), [scope.project]);
  const [feed, setFeed] = useState([]);
  const [inFlight, setInFlight] = useState([]);
  const [projects, setProjects] = useState([]);
  const scopedProject = scope.project ? projects.find((p) => p.key === scope.project) ?? null : null;
  // FG-843: only Routing and Config read one checkout's files, so only they send one: the
  // hash's `checkout=` (a header-chooser pick or a deep link, run checkouts included), else
  // the project's primary checkout — selecting a project selects it silently. Every other
  // view reads the whole project, every checkout, so it sends the project key alone. A
  // `checkout=` the loaded project does not know is unknown, not a run checkout: the
  // primary is read, and the effect below drops it from the hash.
  // FG-843 RF-2: this checkout scopes that view's OWN read (governance, config graph) and
  // nothing else — the shared project reads (activity, in-flight, inbox, badges) stay on the
  // project key, so a pick on Routing never hides the project's other checkouts' work.
  const staleCheckout = Boolean(scopedProject && scope.checkout && !knownCheckout(scope.checkout, scopedProject));
  const viewCheckoutDir = viewCheckout(view, scope.project, scopedProject, scope.checkout);
  const [orchCollapsed, setOrchCollapsed] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [usageRollup, setUsageRollup] = useState([]);
  const [usageTimeSeries, setUsageTimeSeries] = useState([]);
  const [usageModelMix, setUsageModelMix] = useState([]);
  const [planUsage, setPlanUsage] = useState(null);
  const [planUsageLoading, setPlanUsageLoading] = useState(false);
  const [planUsageRefreshing, setPlanUsageRefreshing] = useState(false);
  const [planUsageRefreshError, setPlanUsageRefreshError] = useState(null);
  const [usageGroupBy, setUsageGroupBy] = useState("project");
  const [usageSince, setUsageSince] = useState("30d");
  // FG-836: on #ops the summary window is hash state (`#ops?since=<w>`), read through its
  // own windowed reader so a change keeps the previous summary, labelled, until it lands.
  const opsSince = view === "ops" ? opsSinceState(route.params) : HOME_OPS_SINCE;
  const [opsLoad, setOpsLoad] = useState(EMPTY_WINDOW_LOAD);
  const opsReader = useMemo(() => createWindowedReader({ label: "ops summary", onUpdate: setOpsLoad }), []);
  // FG-836: the runtime window is hash state (`#ops?window=<w>`), so a reload restores it.
  const runtimeWindow = runtimeWindowState(view === "ops" ? route.params : null);
  const [runtimeRole, setRuntimeRole] = useState(RUNTIME_ALL_ROLES);
  // FG-683: which metric the runtime panel charts. Duration is the default and
  // the only thing that reads /api/agent-runtime.
  const [runtimeMetric, setRuntimeMetric] = useState(RUNTIME_METRIC_DURATION);
  // FG-836: one reader per metric. A newer read aborts the older one (the server cost
  // varies by window, so a slower earlier request could otherwise land last), a read
  // past the client budget is aborted and reported, and each load remembers the window
  // its data came from so the panel can never label a stale series as the new window.
  const [runtimeLoad, setRuntimeLoad] = useState(EMPTY_WINDOW_LOAD);
  const [completedRunsLoad, setCompletedRunsLoad] = useState(EMPTY_WINDOW_LOAD);
  const runtimeReader = useMemo(() => createWindowedReader({ label: "agent runtime", onUpdate: setRuntimeLoad }), []);
  const completedRunsReader = useMemo(() => createWindowedReader({ label: "completed runs", onUpdate: setCompletedRunsLoad }), []);
  const [governance, setGovernance] = useState(null);
  const [controlPlane, setControlPlane] = useState(null);
  // Scope token for the control-plane read — see pollControlPlane. A response
  // for the old scope must never overwrite the graph just switched to.
  const controlPlaneSeq = useRef(0);
  // FG-821: the Runs badge's load — GET /api/runs's server-computed activeCount, read on
  // every view (like the inbox) so the badge is live everywhere. The run index hands up
  // its own first-page reads too, so on #runs the badge is the list's own response.
  const [runsLoad, setRunsLoad] = useState(RUNS_LOADING);
  const [backlog, setBacklog] = useState(null);
  const [queue, setQueue] = useState(null);
  // Sequence token for the queue read — see pollQueue.
  const queueSeq = useRef(0);
  const [reviews, setReviews] = useState(null);
  // FG-386: the shipping-audit projection, scoped to ONE project like the queue.
  const [shippingAudit, setShippingAudit] = useState(null);
  const shippingSeq = useRef(0);
  // FG-395: the campaign list projection + the currently-opened campaign's detail.
  // Works unscoped (all campaigns) as well as project-scoped, unlike shipping-audit.
  const [campaigns, setCampaigns] = useState(null);
  const selectedCampaignId = view === "campaigns" ? route.id : null;
  const campaignsSeq = useRef(0);
  // FG-487: review-loop verification / CI-wait windows and campaign reconcile
  // host-gate execs, in progress right now — polled alongside feed/in-flight
  // so a launched loop is visible before any task row exists for it.
  const [inProgressVerifications, setInProgressVerifications] = useState([]);
  const [reviewLoopPhases, setReviewLoopPhases] = useState([]);
  // FG-679: the three-section Current activity projection. Read-only, and read from
  // PERSISTED state only — the server makes no outbound call to answer it.
  // FG-694: the LOAD STATE, not the payload. `loading`, `ready` and `unavailable` are
  // three different things to say, and collapsing them into "payload or null" is what
  // made a failed read render as an observed absence.
  const [activityLoad, setActivityLoad] = useState(ACTIVITY_LOADING);
  // FG-694/RF-4: the read timeout is FOUR polls long, so a poll that started a fresh
  // read every tick superseded every slow read before its own timeout could land and
  // the surface stayed in `loading` forever. The reader owns that reconciliation — one
  // read per URL in flight — rather than a sequence token here that only ever decided
  // which answer wins a race the poll should not have started.
  const activityReader = useRef(null);
  if (activityReader.current === null) activityReader.current = createActivityReader(setActivityLoad);
  // FG-402: the Human Attention Inbox load state, read through the SAME reader contract
  // as Current activity (one read per URL in flight; failure IS the return value) so a
  // slow/failed inbox read resolves to unavailable+Retry rather than lingering.
  const [inboxLoad, setInboxLoad] = useState(INBOX_LOADING);
  const inboxReader = useRef(null);
  if (inboxReader.current === null) inboxReader.current = createActivityReader(setInboxLoad, readAttentionInbox);
  // FG-576: the project-scoped orchestrator read. Null until a project is selected —
  // /api/orchestrators has no cross-project form, because it is the one route that
  // can carry a live remote-control credential.
  const [orchestrators, setOrchestrators] = useState(null);

  const poll = useCallback(async () => {
    const q = projectScopeQuery(projectFilter);
    // Deliberately OUTSIDE the Promise.all below. A rejection from any sibling fetch
    // used to abandon the whole batch, which left the Current-activity surface
    // showing its last payload as though it were still current; this read owns its
    // own outcome — including its own failure — and always lands.
    activityReader.current.poll(`/api/current-activity${q}`);
    try {
      const reqs = [
        view === "activity" ? fetch(`/api/feed${q ? q + "&limit=100" : "?limit=100"}`) : Promise.resolve(null),
        fetch(`/api/in-flight${q}`),
        fetch(`/api/verifications/in-progress${q}`),
        fetch(`/api/review-loop/phases${q}`),
        // Only asked for with a project in hand: the route refuses an unscoped
        // request, and asking anyway would be building the cross-project habit the
        // credential rule exists to prevent.
        projectFilter ? fetch(`/api/orchestrators${q}`) : Promise.resolve(null),
      ];
      // Only poll /api/projects on the projects view (or first load) — saves a
      // filesystem scan every 2s once the registry is populated.
      if (view === "projects" || projects.length === 0) reqs.push(fetch("/api/projects"));
      const [feedRes, ifRes, ivRes, phasesRes, orchRes, projRes] = await Promise.all(reqs);
      if (feedRes?.ok) setFeed(await feedRes.json());
      if (ifRes.ok) setInFlight(await ifRes.json());
      if (ivRes && ivRes.ok) setInProgressVerifications(await ivRes.json());
      if (phasesRes && phasesRes.ok) setReviewLoopPhases(await phasesRes.json());
      setOrchestrators(orchRes && orchRes.ok ? await orchRes.json() : null);
      if (projRes && projRes.ok) setProjects(await projRes.json());
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [view, projectFilter, projects.length]);

  // The retry affordance behind AC7. It supersedes whatever is in flight and goes back
  // to `loading` first, so the operator sees the click do something and the stale
  // failure copy does not linger over a read that is already running.
  const retryCurrentActivity = useCallback(() => {
    activityReader.current.retry(`/api/current-activity${projectScopeQuery(projectFilter)}`);
  }, [projectFilter]);

  const retryInbox = useCallback(() => {
    return inboxReader.current.retry(`/api/attention-inbox${projectScopeQuery(projectFilter)}`);
  }, [projectFilter]);

  // FG-823: after a dismiss/snooze/undismiss, re-read in place — the server has already
  // moved the item between `items` and `dismissed`, and the Home badge follows its counts.
  const refreshInbox = useCallback(() => {
    return inboxReader.current.refresh(`/api/attention-inbox${projectScopeQuery(projectFilter)}`);
  }, [projectFilter]);

  const pollPlanUsage = useCallback(async () => {
    setPlanUsageLoading(true);
    try {
      const response = await fetch("/api/usage/limits").catch(() => null);
      if (response?.ok) {
        try {
          setPlanUsage(await response.json());
          setPlanUsageRefreshError(null);
        } catch {
          setPlanUsageRefreshError("Plan-limit sync returned an unreadable response. Showing the last successful sync, if available.");
        }
      } else {
        const status = response ? ` (${response.status})` : "";
        setPlanUsageRefreshError(`Plan-limit sync failed${status}. Showing the last successful sync, if available.`);
      }
      setNow(Date.now());
    } finally {
      setPlanUsageLoading(false);
    }
  }, []);

  const pollUsage = useCallback(async () => {
    try {
      const tsDays = parseInt(usageSince) * 2;
      const [rollupRes, tsRes, mixRes] = await Promise.all([
        fetch(appendScope(`/api/usage?groupBy=${usageGroupBy}&since=${usageSince}`, projectFilter)),
        fetch(appendScope(`/api/usage/timeseries?since=${tsDays}d`, projectFilter)),
        fetch(appendScope(`/api/usage/model-mix?groupBy=${usageGroupBy}&since=${usageSince}`, projectFilter)),
      ]);
      if (rollupRes.ok) setUsageRollup(await rollupRes.json());
      if (tsRes.ok) setUsageTimeSeries(await tsRes.json());
      if (mixRes.ok) setUsageModelMix(await mixRes.json());
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [usageGroupBy, usageSince, projectFilter]);

  const refreshPlanUsage = useCallback(async () => {
    setPlanUsageRefreshing(true);
    try {
      const res = await fetch("/api/usage/limits?refresh=1");
      if (res.ok) {
        setPlanUsage(await res.json());
        setPlanUsageRefreshError(null);
      } else {
        setPlanUsageRefreshError(`Plan-limit refresh failed (${res.status}). Showing the last successful sync, if available.`);
      }
    } catch {
      setPlanUsageRefreshError("Plan-limit refresh failed. Showing the last successful sync, if available.");
    } finally {
      setPlanUsageRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (view === "usage") return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll, view]);

  // FG-402: the inbox read owns its own outcome like the current-activity read. FG-820:
  // it runs on every view, not just the ones the main poll serves, because the Home
  // badge in the nav reads it everywhere.
  useEffect(() => {
    const url = `/api/attention-inbox${projectScopeQuery(projectFilter)}`;
    const read = () => inboxReader.current.poll(url);
    read();
    const id = setInterval(read, POLL_MS);
    return () => clearInterval(id);
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "home" && view !== "usage") return;
    pollPlanUsage();
    const id = setInterval(pollPlanUsage, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollPlanUsage, view]);

  useEffect(() => {
    if (view !== "usage") return;
    pollUsage();
    const id = setInterval(pollUsage, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollUsage, view]);

  const pollOps = useCallback(() => {
    opsReader.read(appendScope(`/api/ops?since=${opsSince}`, projectFilter), opsSince);
  }, [opsReader, opsSince, projectFilter]);

  useEffect(() => {
    if (view !== "home" && view !== "ops") return;
    pollOps();
    const id = setInterval(pollOps, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollOps, view]);

  const pollRuntime = useCallback(() => {
    runtimeReader.read(appendScope(`/api/agent-runtime?window=${runtimeWindow}`, projectFilter), runtimeWindow);
  }, [runtimeReader, runtimeWindow, projectFilter]);

  // FG-683: the throughput read, on its own endpoint and its own reader. Only the
  // selected metric is polled — an operator reading counts does not pay for the
  // duration query, which is by far the more expensive of the two.
  const pollCompletedRuns = useCallback(() => {
    completedRunsReader.read(appendScope(`/api/completed-runs?window=${runtimeWindow}`, projectFilter), runtimeWindow);
  }, [completedRunsReader, runtimeWindow, projectFilter]);

  useEffect(() => {
    if (view !== "ops") return;
    const read = runtimeMetric === RUNTIME_METRIC_COMPLETED_RUNS ? pollCompletedRuns : pollRuntime;
    read();
    const id = setInterval(read, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollRuntime, pollCompletedRuns, runtimeMetric, view]);

  // A scope change drops both metrics' series, so the chart shows its loading state
  // rather than a grid that silently belongs to the previous scope. The reset aborts
  // whatever is still in flight for the scope being left — a late response never
  // writes. Errors clear alongside the data so a previous scope's failure is not
  // attributed to the new one. A window change does NOT drop the series (FG-836): the
  // previous window stays on screen, labelled as what it is, until the new read lands.
  const invalidateRuntimePanels = () => {
    runtimeReader.reset();
    completedRunsReader.reset();
  };

  const changeRuntimeWindow = (next) => {
    window.location.hash = runtimeWindowHash(scopeRef.current, next, opsSince);
  };

  const changeOpsSince = (next) => {
    window.location.hash = opsSinceHash(scopeRef.current, next, runtimeWindow);
  };

  // FG-699: scope changes must invalidate the runtime panels too. Invalidate
  // BEFORE changing the filter: this retires the leaving scope's in-flight read and shows the
  // loading state immediately, instead of rendering the previous scope's
  // numbers (or error) under the new scope's label for one round trip.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const routeRef = useRef(route);
  routeRef.current = route;

  const adoptScope = (next) => {
    const prev = scopeRef.current;
    if (prev.project === next.project && prev.checkout === next.checkout) return;
    invalidateRuntimePanels();
    scopeRef.current = next;
    setScope(next);
  };

  // The scope control. On a list view the hash is rewritten in place (replaceState — a
  // scope change is not a navigation); an open campaign detail closes, as it always has.
  const changeScope = (next) => {
    adoptScope(next);
    const current = routeRef.current;
    if (!carriesScope(current.view, current.id)) return;
    const id = current.view === "campaigns" ? null : current.id;
    if (id !== current.id) setRoute({ ...current, id });
    replaceHash(hashFor({ ...current, id, scope: next }));
  };

  const pollGovernance = useCallback(async () => {
    if (projectFilter && !viewCheckoutDir) { setGovernance(null); return; }
    try {
      const q = projectScopeQuery(projectFilter, viewCheckoutDir);
      const res = await fetch(`/api/governance${q}`);
      if (res.ok) setGovernance(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter, viewCheckoutDir]);

  useEffect(() => {
    if (view !== "routing") return;
    pollGovernance();
    const id = setInterval(pollGovernance, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollGovernance, view]);

  const pollControlPlane = useCallback(async () => {
    // Scope token like pollShippingAudit: a read for the previous scope
    // (project/checkout) must never overwrite the graph just switched to.
    const seq = (controlPlaneSeq.current += 1);
    // Checkout-specific: a project without an exact checkout has no single graph.
    if (projectFilter && !viewCheckoutDir) { setControlPlane(null); return; }
    try {
      const q = projectScopeQuery(projectFilter, viewCheckoutDir);
      const res = await fetch(`/api/config-graph${q}`);
      if (seq !== controlPlaneSeq.current) return;
      if (res.ok) {
        // Decode the body BEFORE the scope re-check: a scope change during the
        // await res.json() body decode must not render the retired checkout's graph.
        const graph = await res.json();
        if (seq !== controlPlaneSeq.current) return;
        setControlPlane(graph);
      }
      setNow(Date.now());
    } catch (e) {
      if (seq !== controlPlaneSeq.current) return;
      setError(String(e));
    }
  }, [projectFilter, viewCheckoutDir]);

  // Clear the graph the instant the scope changes so a previous checkout's config
  // graph is never rendered under the new scope while its request is in flight. The
  // seq bump retires whatever read is still outstanding for the old scope.
  useEffect(() => {
    controlPlaneSeq.current += 1;
    setControlPlane(null);
  }, [projectFilter, viewCheckoutDir]);

  useEffect(() => {
    if (view !== "config") return;
    pollControlPlane();
    const id = setInterval(pollControlPlane, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollControlPlane, view]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const load = await readRuns(runsUrl({ scope: { project: scope.project, checkout: null }, limit: 1 }));
      if (!cancelled) setRunsLoad(load);
    };
    read();
    const id = setInterval(read, RUNS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [scope.project]);

  const pollReviews = useCallback(async () => {
    try {
      const res = await fetch(appendScope(`/api/reviews?limit=25`, projectFilter));
      if (res.ok) setReviews(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "reviews") return;
    pollReviews();
    const id = setInterval(pollReviews, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollReviews, view]);

  const pollShippingAudit = useCallback(async () => {
    // Scope-token like pollQueue: a read for the previous project must never
    // overwrite the one just switched to.
    const seq = (shippingSeq.current += 1);
    // An unselected project is an EMPTY/unselected projection, not perpetual loading:
    // render the "select a project" state (projectKey === null) rather than null data.
    if (!projectFilter) { setShippingAudit({ projectKey: null, rows: [], degraded: [] }); return; }
    try {
      const q = projectScopeQuery(projectFilter);
      const res = await fetch(`/api/shipping-audit${q}`);
      if (seq !== shippingSeq.current) return;
      // Only the new scope's response may populate the panel. A failed fetch must NOT
      // leave the prior scope's rows on screen labelled as the new project — drop to
      // the loading state instead (RF-3).
      if (res.ok) setShippingAudit(await res.json());
      else setShippingAudit(null);
      setNow(Date.now());
    } catch (e) {
      if (seq !== shippingSeq.current) return;
      setShippingAudit(null);
      setError(String(e));
    }
  }, [projectFilter]);

  // Clear the panel the instant the scope changes so the previous project's evidence is
  // never rendered under the new scope while its request is in flight (RF-3, the FG-699
  // guard). The seq bump retires whatever read is still outstanding for the old scope;
  // the null drops the view to its loading state until the new response arrives. Runs
  // before the poll effect below, which then fires the scoped fetch.
  useEffect(() => {
    shippingSeq.current += 1;
    setShippingAudit(null);
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "shipping") return;
    pollShippingAudit();
    const id = setInterval(pollShippingAudit, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollShippingAudit, view]);

  // FG-395: the campaigns list. Scope-token like pollShippingAudit so a read for the
  // previous project can never overwrite the one just switched to. Polled at the slow
  // cadence — the detail overlay owns its own faster re-read while a campaign runs.
  const pollCampaigns = useCallback(async () => {
    const seq = (campaignsSeq.current += 1);
    try {
      const q = projectScopeQuery(projectFilter);
      const res = await fetch(`/api/campaigns${q}`);
      if (seq !== campaignsSeq.current) return;
      // 503 is the degraded-store read: its body carries the same { campaigns, error }
      // shape, so keep it to render the "Campaigns unreadable" state rather than a blank
      // perpetual-loading pane.
      if (res.ok || res.status === 503) setCampaigns(await res.json());
      else setCampaigns(null);
      setNow(Date.now());
    } catch (e) {
      if (seq !== campaignsSeq.current) return;
      setCampaigns(null);
      setError(String(e));
    }
  }, [projectFilter]);

  // Drop the list + any open detail the instant the scope changes, so the previous
  // project's campaigns are never shown under the new scope while the read is in flight.
  useEffect(() => {
    campaignsSeq.current += 1;
    setCampaigns(null);
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "campaigns") return;
    pollCampaigns();
    const id = setInterval(pollCampaigns, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollCampaigns, view]);

  const pollBacklog = useCallback(async () => {
    if (!projectFilter) { setBacklog(null); return; }
    try {
      const q = projectScopeQuery(projectFilter);
      const res = await fetch(`/api/backlog${q}`);
      if (res.ok) setBacklog(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "backlog" && view !== "notes") return;
    pollBacklog();
    const id = setInterval(pollBacklog, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollBacklog, view]);

  // FG-591: the operator work queue board. Polled like every other view, and
  // re-read explicitly after a mutation the CLI accepted — a refusal never triggers
  // a reload, because re-fetching over a refused move hides the reason it was refused.
  const pollQueue = useCallback(async () => {
    // Scope-token, runtimeSeq's rule applied to the board the operator MUTATES from:
    // an in-flight read for the previous project may resolve after the read for the
    // one just switched to, and committing it would show project A's queue while
    // every enqueue/reorder control on it submits against project B.
    const seq = (queueSeq.current += 1);
    if (!projectFilter) { setQueue(null); return; }
    try {
      const q = projectScopeQuery(projectFilter);
      const res = await fetch(`/api/queue${q}`);
      if (seq !== queueSeq.current) return;
      if (res.ok) setQueue(await res.json());
      setNow(Date.now());
    } catch (e) {
      if (seq !== queueSeq.current) return;
      setError(String(e));
    }
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "queue") return;
    pollQueue();
    const id = setInterval(pollQueue, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollQueue, view]);

  // FG-746: the standalone Verification tab was retired. Its live liveness now rides
  // Current Activity / In-flight (fed by the shared /api/verifications/in-progress
  // poll below), its stale/actionable rows go to Human Attention, and its historical
  // evidence is contextual (run/task Explain, campaign detail, shipping audit). The
  // tab-only recent-feed poll and manual ticket/item lookup are gone with it.

  // Alias, group-shaped, unknown-key and bare-object hashes are rewritten to their
  // canonical form without adding a history entry.
  useEffect(() => {
    if (initialRoute.rewrite) replaceHash(initialRoute.canonical);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseHash(window.location.hash);
      if (parsed.rewrite) replaceHash(parsed.canonical);
      if (carriesScope(parsed.view, parsed.id)) adoptScope(parsed.scope);
      // FG-348: the selected run follows the hash, so a deep link (#run/<runId>)
      // and the back button both land on the right run.
      setRoute({ view: parsed.view, id: parsed.id, tab: parsed.tab, params: parsed.params });
      setRouteNotice(parsed.notice);
      setDrawerOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The drawer only exists below the 720px nav breakpoint; widening past it closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    const wide = window.matchMedia("(min-width: 720px)");
    const onChange = () => { if (wide.matches) setDrawerOpen(false); };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [drawerOpen]);

  const navigate = (location) => {
    window.location.hash = hashFor({ ...location, scope: location.scope ?? scopeRef.current });
  };

  // FG-821: every task entry point (feed card, in-flight row, orchestrator row, current
  // activity) opens the task PAGE — a hash change, so it is linkable and Back returns.
  const openTask = (taskId) => navigate({ view: "task", id: taskId });

  // A project card (or one of its checkout rows) scopes the dashboard to the project and
  // opens Activity, which reads every checkout of it (FG-843: no checkout scope there).
  const filterByProject = (project) => {
    navigate({ view: "activity", scope: { project: project.key, checkout: null } });
  };

  // FG-843: the header chooser. On Routing and Config a pick rewrites `?checkout=` in place
  // and the view re-reads; on Notes it opens that checkout's note.
  const chooseCheckout = (dir) => {
    if (view === "notes") navigate({ view: "notes", id: dir, scope: { project: scope.project, checkout: null } });
    else changeScope({ project: scope.project, checkout: dir });
  };

  useEffect(() => {
    if (staleCheckout && ROUTES[view]?.checkout === true) changeScope({ project: scope.project, checkout: null });
  }, [staleCheckout, view]);

  const skipToContent = (e) => {
    e.preventDefault();
    mainRef.current?.focus();
  };

  const currentRoute = ROUTES[view];
  // Object pages (run, task, ticket, review) render their own head: a breadcrumb trail
  // from their payload in place of the group kicker (FG-821).
  const objectPage = currentRoute.object === "required" || (currentRoute.object === "optional" && route.id && view !== "campaigns");
  const currentGroup = GROUPS.find((g) => g.id === currentRoute.group);
  const navColumn = (idPrefix) => html`<${NavColumn}
    view=${view}
    scope=${scope}
    projects=${projects}
    onScopeChange=${changeScope}
    now=${now}
    inboxLoad=${inboxLoad}
    runsLoad=${runsLoad}
    idPrefix=${idPrefix}
  />`;

  return html`
    <${ProjectsContext.Provider} value=${projects}>
    <div class="app-shell">
      <a class="skip-link" href=${hashFor({ ...route, scope })} onClick=${skipToContent}>Skip to content</a>
      <div class="nav-column">${navColumn("nav")}</div>
      <header class="mobile-head">
        <img src="/client/logo-mark.svg" width="24" height="24" class="brand-mark" alt="forge" />
        <span class="mobile-head-scope muted">${scopeSummary(scope, scopedProject)}</span>
      </header>
      <main id="main-content" class="app" tabindex="-1" ref=${mainRef}>
      ${objectPage ? null : html`
        <div class="page-head">
          <span class="page-kicker">${currentGroup?.label}</span>
          <h1 class="page-title">${currentRoute.label}</h1>
          <${InfoTip} view=${view} title=${currentRoute.label} />
          ${scopedProject && carriesCheckout(view) ? html`
            <span class="page-head-spacer"></span>
            <${CheckoutChooser} project=${scopedProject} selected=${scope.checkout} onChoose=${chooseCheckout} />
          ` : null}
        </div>
        <${ScreenLine} header=${listScreenLine(view, runsLoad)} />
      `}

      ${routeNotice ? html`<div class="card route-notice muted" role="status">${routeNotice}</div>` : null}

      ${error ? html`<div class="card" style="color: var(--err);">Error: ${error}</div>` : null}

      ${view === "home"
        ? html`<${HomeView}
            hrefFor=${(hash) => scopedHref(hash, scope)}
            planUsage=${planUsage}
            planUsageLoading=${planUsageLoading}
            planUsageRefreshing=${planUsageRefreshing}
            planUsageRefreshError=${planUsageRefreshError}
            onRefreshPlanUsage=${refreshPlanUsage}
            inFlight=${inFlight}
            verifications=${inProgressVerifications}
            phases=${reviewLoopPhases}
            activityLoad=${activityLoad}
            onRetryActivity=${retryCurrentActivity}
            inboxLoad=${inboxLoad}
            onRetryInbox=${retryInbox}
            onRefreshInbox=${refreshInbox}
            onRefreshInFlight=${poll}
            now=${now}
            orchCollapsed=${orchCollapsed}
            onToggleOrch=${() => setOrchCollapsed((c) => !c)}
            onTaskClick=${openTask}
            ops=${opsLoad.data}
            opsSince=${opsLoad.window ?? opsSince}
          />`
        : view === "projects"
        ? html`<${ProjectsView} projects=${projects} onPick=${filterByProject} onReload=${poll} />`
        : view === "routing"
        ? projectFilter && !viewCheckoutDir
          ? html`<div class="card muted" style="margin-top: 20px;">${projects.length === 0 ? "loading the project's checkouts…" : `No registered project has the key ${scope.project}, so there is no checkout to read.`}</div>`
          : html`<${RoutingView} governance=${governance} scope=${{ project: scope.project, checkout: viewCheckoutDir }} params=${route.params} onRefresh=${pollGovernance} />`
        : view === "config"
        ? projectFilter && !viewCheckoutDir
          ? html`<div class="card muted" style="margin-top: 20px;">${projects.length === 0 ? "loading the project's checkouts…" : `No registered project has the key ${scope.project}, so there is no checkout to read.`}</div>`
          : html`<${ControlPlaneView} data=${controlPlane} modelsHref=${hashFor({ view: "models", scope })} />`
        : view === "models"
        ? html`<${ModelsView} key=${`${scope.project ?? ""}\n${scope.checkout ?? ""}`} scope=${scope} params=${route.params} />`
        : view === "run"
        ? html`<${RunPage} key=${route.id} runId=${route.id} tab=${route.tab} projects=${projects} />`
        : view === "task"
        ? html`<${TaskPage} key=${route.id} taskId=${route.id} tab=${route.tab} projects=${projects} />`
        : view === "runs"
        ? html`<${RunsIndexView} scope=${scope} status=${route.params?.status ?? null} projects=${projects} onLoad=${setRunsLoad} />`
        : view === "roles"
        ? route.id
          ? html`<${RolePage} key=${route.id} role=${route.id} tab=${route.tab} scope=${scope} />`
          : html`<${RolesIndexView} params=${route.params} scope=${scope} />`
        : view === "backlog"
        ? route.id
          ? html`<${TicketPage} key=${route.id} ticketId=${route.id} data=${backlog} scope=${scope} projects=${projects} />`
          : html`<${BacklogView} data=${backlog} projectFilter=${projectFilter} scope=${scope} projects=${projects} params=${route.params} />`
        : view === "notes"
        ? route.id
          ? html`<${NotePage} key=${route.id} checkoutDir=${route.id} data=${backlog} scope=${scope} projects=${projects} />`
          : html`<${NotesView} data=${backlog} projectFilter=${projectFilter} scope=${scope} projects=${projects} />`
        : view === "queue"
        ? html`<${QueueBoardView}
            data=${queue}
            projectFilter=${projectFilter}
            onReload=${pollQueue}
            lane=${route.params?.lane ?? null}
            scope=${scope}
          />`
        : view === "reviews"
        ? route.id
          ? html`<${ReviewPage} key=${route.id} reviewId=${route.id} projects=${projects} scope=${scope} />`
          : html`<${ReviewsView} data=${reviews} />`
        : view === "shipping"
        ? html`<${ShippingAuditView} data=${shippingAudit} />`
        : view === "campaigns"
        ? html`<${CampaignsView}
            data=${campaigns}
            selectedId=${selectedCampaignId}
            onSelect=${(id) => navigate({ view: "campaigns", id })}
            onCloseDetail=${() => navigate({ view: "campaigns" })}
          />`
        : view === "ops"
        ? html`<${OpsView}
            opsLoad=${opsLoad}
            since=${opsSince}
            onSinceChange=${changeOpsSince}
            runtimeLoad=${runtimeLoad}
            runtimeWindow=${runtimeWindow}
            onRuntimeWindowChange=${changeRuntimeWindow}
            runtimeRole=${runtimeRole}
            onRuntimeRoleChange=${setRuntimeRole}
            runtimeMetric=${runtimeMetric}
            onRuntimeMetricChange=${setRuntimeMetric}
            completedRunsLoad=${completedRunsLoad}
          />`
        : view === "usage"
        ? html`<${UsageView}
            rollup=${usageRollup}
            timeSeries=${usageTimeSeries}
            modelMix=${usageModelMix}
            groupBy=${usageGroupBy}
            onGroupByChange=${setUsageGroupBy}
            since=${usageSince}
            onSinceChange=${setUsageSince}
            planUsage=${planUsage}
            planUsageLoading=${planUsageLoading}
            planUsageRefreshing=${planUsageRefreshing}
            planUsageRefreshError=${planUsageRefreshError}
            onRefreshPlanUsage=${refreshPlanUsage}
          />`
        : html`
          <${InFlightSection}
            inFlight=${inFlight}
            verifications=${inProgressVerifications}
            phases=${reviewLoopPhases}
            now=${now}
            orchCollapsed=${orchCollapsed}
            onToggleOrch=${() => setOrchCollapsed((c) => !c)}
            onTaskClick=${openTask}
            activityLoad=${activityLoad}
            onRetryActivity=${retryCurrentActivity}
            onRefresh=${poll}
          />

          <details class="activity-diagnostics">
            <summary>Diagnostics</summary>
            <${OrchestratorSection} data=${orchestrators} onTaskClick=${openTask} />
            <${CurrentActivitySection}
              load=${activityLoad}
              now=${now}
              onTaskClick=${openTask}
              onRetry=${retryCurrentActivity}
            />
          </details>

          <section class="feed">
            <h2>Recent agent outputs</h2>
            ${feed.length === 0
              ? html`<div class="muted">No completed agent outputs yet.</div>`
              : feed.map((e) => html`<${FeedCard} key=${e.taskId} entry=${e} onClick=${() => openTask(e.taskId)} />`)
            }
          </section>
        `
      }

      </main>
      <${BottomBar}
        view=${view}
        current=${navItemFor(view)}
        scope=${scope}
        inboxLoad=${inboxLoad}
        runsLoad=${runsLoad}
        drawerOpen=${drawerOpen}
        onOpenDrawer=${() => setDrawerOpen(true)}
        moreRef=${moreRef}
      />
      ${drawerOpen ? html`<${NavDrawer} onClose=${() => setDrawerOpen(false)} returnFocusRef=${moreRef}>${navColumn("drawer")}</${NavDrawer}>` : null}
    </div>
    </${ProjectsContext.Provider}>
  `;
}

function replaceHash(hash) {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
}

function HomeView({ hrefFor, planUsage, planUsageLoading, planUsageRefreshing, planUsageRefreshError, onRefreshPlanUsage, inFlight, verifications, phases, activityLoad, onRetryActivity, inboxLoad, onRetryInbox, onRefreshInbox, onRefreshInFlight, now, orchCollapsed, onToggleOrch, onTaskClick, ops, opsSince }) {
  return html`
    <section class="home-view" aria-label="Dashboard home">
      <${UsageLimits}
        data=${planUsage}
        loading=${planUsageLoading}
        refreshing=${planUsageRefreshing}
        refreshError=${planUsageRefreshError}
        onRefresh=${onRefreshPlanUsage}
      />
      <${PinnedAttentionInboxSection}
        load=${inboxLoad}
        now=${now}
        onRetry=${onRetryInbox}
        hrefFor=${hrefFor}
        rowActions=${(summary, fallback, preview) => html`<${TaskActions} key=${summary.taskId} taskId=${summary.taskId} compact=${true} fallback=${fallback} onChanged=${onRetryInbox} ...${preview} />`}
        onDismissChanged=${onRefreshInbox}
      />
      <div class="home-in-flight-group">
        <div class="home-section-heading">
          <div>
            <div class="home-section-kicker">Tasks</div>
            <h2 id="home-in-flight-heading">In flight</h2>
          </div>
        </div>
        <${InFlightSection}
          inFlight=${inFlight}
          verifications=${verifications}
          phases=${phases}
          now=${now}
          orchCollapsed=${orchCollapsed}
          onToggleOrch=${onToggleOrch}
          onTaskClick=${onTaskClick}
          showHeading=${false}
          labelledBy="home-in-flight-heading"
          activityLoad=${activityLoad}
          onRetryActivity=${onRetryActivity}
          onRefresh=${onRefreshInFlight}
        />
      </div>
      <section class="home-ops-summary" aria-labelledby="home-ops-heading">
        <div class="home-section-heading">
          <div>
            <div class="home-section-kicker">Forge activity</div>
            <h2 id="home-ops-heading">Operations</h2>
          </div>
          <span class="muted mono">${opsSince}</span>
        </div>
        <${OpsSummary} data=${ops} window=${opsSince} />
      </section>
    </section>
  `;
}

// `window` is the window the data came from, so each count names its own bounds.
function OpsSummary({ data, window }) {
  if (!data) return html`<div class="muted">loading metrics…</div>`;
  const pct = (data.runs.successRate * 100).toFixed(0);
  return html`
    <div class="row" style="gap: 16px; flex-wrap: wrap; margin-bottom: 20px;">
      <div class="card stat"><div class="stat-num">${pct}%</div><div class="muted">success rate (of ${data.runs.terminal} terminal in ${window})</div></div>
      <div class="card stat"><div class="stat-num">${data.runs.total}</div><div class="muted">runs in ${window} (${data.runs.clean} clean · ${data.runs.withFailures} w/ failures${data.runs.active ? ` · ${data.runs.active} active` : ""})</div></div>
      <div class="card stat"><div class="stat-num">${data.taskCount}</div><div class="muted">tasks in ${window}</div></div>
    </div>

    <div class="row" style="gap: 16px; flex-wrap: wrap; margin-bottom: 20px;">
      <div class="card stat"><div class="stat-num">${data.counts.idleKills}</div><div class="muted">idle kills</div></div>
      <div class="card stat"><div class="stat-num">${data.counts.cancels}</div><div class="muted">cancels</div></div>
      <div class="card stat"><div class="stat-num">${data.counts.retries}</div><div class="muted">retries</div></div>
      <div class="card stat"><div class="stat-num">${data.counts.redBlocks}</div><div class="muted">red blocks</div></div>
    </div>
  `;
}

// RUN-3: operations summary — success rate, failure-kind mix, median durations,
// operational counts. Reads /api/ops.
function OpsView({
  opsLoad, since, onSinceChange, runtimeLoad, runtimeWindow, onRuntimeWindowChange, runtimeRole, onRuntimeRoleChange,
  runtimeMetric, onRuntimeMetricChange, completedRunsLoad,
}) {
  const trends = html`<${AgentRuntimeTrends}
    runtimeLoad=${runtimeLoad}
    requestedWindow=${runtimeWindow}
    onWindowChange=${onRuntimeWindowChange}
    role=${runtimeRole}
    onRoleChange=${onRuntimeRoleChange}
    metric=${runtimeMetric}
    onMetricChange=${onRuntimeMetricChange}
    completedRunsLoad=${completedRunsLoad}
  />`;
  // FG-836: the same honesty as the runtime panel — every label reads the window the
  // summary on screen came from, and a read for another window dims it under a
  // "loading <w>…" line rather than silently swapping (or not swapping) the numbers.
  const data = opsLoad.data;
  const loadView = windowLoadView(opsLoad, since);
  const shown = loadView.showing;
  const error = opsLoad.error;
  const controls = html`
    <div class="row ops-since-controls" style="gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap;">
      <span class="muted" id="ops-since-label">window:</span>
      <div class="row ops-since-btns" style="gap: 8px;" role="group" aria-labelledby="ops-since-label" aria-busy=${loadView.loading ? "true" : "false"}>
        ${OPS_SINCES.map((w) => html`
          <button
            key=${w}
            type="button"
            class=${"usage-dim-btn " + (loadView.pressed === w ? "usage-dim-btn-active" : "") + (loadView.loadingWindow === w ? " ops-since-pending" : "")}
            aria-pressed=${loadView.pressed === w}
            disabled=${loadView.loading}
            onClick=${() => onSinceChange(w)}
          >${w}</button>
        `)}
      </div>
      ${shown ? html`<span class="muted ops-since-showing">showing ${shown}</span>` : null}
    </div>
  `;
  if (!data) {
    return html`<section class="ops-view">
      ${controls}
      ${error
        ? html`<div class=${"card ops-error " + toneAccentClass("err")} role="alert">${error.reason}. Retrying every 30s.</div>`
        : html`<div class=${"card muted ops-loading " + toneAccentClass("info")} role="status">loading ops summary for ${loadView.loadingWindow ?? since}…</div>`}
      ${trends}
    </section>`;
  }
  const staleNotice = error ? html`
    <div class=${"card ops-stale " + toneAccentClass(error.window === shown ? "warn" : "err")} role="alert">
      ${error.window === shown
        ? `${error.reason}. Showing the last successful read — these numbers are stale. Retrying every 30s.`
        : `${error.reason}. Still showing ${shown} — these numbers are for ${shown}, not ${error.window}. Retrying every 30s.`}
    </div>
  ` : null;
  const loadingLine = loadView.loading ? html`
    <div class=${"card muted ops-loading " + toneAccentClass("info")} role="status">
      loading ${loadView.loadingWindow}… showing ${shown} until it answers
    </div>
  ` : null;
  const bodyClass = "ops-summary-body" + (loadingLine ? " ops-summary-body-loading" : "");
  const busy = loadingLine ? "true" : "false";
  const maxKind = Math.max(1, ...data.failureKinds.map((k) => k.count));
  return html`
    <section class="ops-view">
      ${controls}
      ${staleNotice}
      ${loadingLine}

      <div class=${bodyClass} aria-busy=${busy}><${OpsSummary} data=${data} window=${shown} /></div>

      ${trends}

      <div class=${bodyClass} aria-busy=${busy}>

      ${data.failureKinds.length > 0 ? html`
        <h2>Failure kinds</h2>
        <div class="card">
          ${data.failureKinds.map((k) => html`
            <div class="row" style="gap: 10px; align-items: center; padding: 3px 0;">
              <span class="mono" style="min-width: 140px;">${k.kind}</span>
              <div style="flex: 1; background: var(--bg2, #1a1a1a); height: 14px; border-radius: 3px; overflow: hidden;">
                <div style="width: ${(k.count / maxKind * 100).toFixed(0)}%; height: 100%; background: var(--err, #c0392b);"></div>
              </div>
              <span class="muted" style="min-width: 36px; text-align: right;">${k.count}</span>
            </div>
          `)}
        </div>
      ` : null}

      ${data.durations.length > 0 ? html`
        <h2 style="margin-top: 20px;">Median task duration by phase</h2>
        <div class="card">
          ${data.durations.map((d) => html`
            <div class="row" style="gap: 10px; padding: 3px 0;">
              <span class="mono" style="min-width: 140px;">${d.dimension}</span>
              <span style="min-width: 80px;">${opsFmtMs(d.medianMs)}</span>
              <span class="muted">n=${d.count}</span>
            </div>
          `)}
        </div>
      ` : null}
      </div>
    </section>
  `;
}
// The one duration formatter for the ops view. A null/absent duration is an
// empty bucket (FG-648), not a zero — it renders as an em dash, never "0s".
function opsFmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  // The same reservation the chart's compact form makes, so the tooltip, the role
  // table and the screen-reader table cannot read `0s` for a mean the plot draws
  // as `400ms`: `0s` is the zero, not a sub-second observation rounded away.
  if (s === 0 && ms > 0) return `${Math.max(1, Math.round(ms))}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// FG-648: average agent runtime over time. Reads /api/agent-runtime.
// One series at a time — "All agents" by default, or a single observed role.
// Rendering every role at once produces an unreadable multi-line chart, so the
// role breakdown table below carries the cross-role comparison instead.
const RUNTIME_RESOLUTION_WORD = { hour: "hour", day: "day", week: "week" };

// FG-648 (reopened): the y-axis steps, in the units an operator reads durations
// in. The axis top is the next multiple of one of these AT OR ABOVE the peak, so
// rounding only ever adds headroom — no bar is ever clamped, truncated or
// log-compressed, and a 64h outlier still draws at full height (that outlier is
// FG-662's to classify, not this chart's to hide).
const RUNTIME_TICK_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000,
  86_400_000, 172_800_000, 604_800_000,
];
const RUNTIME_TICK_TARGET = 4;

// The bottom label row is anchored to the viewBox EDGE and offset in em, so the
// gutter is a multiple of whatever font-size ends up applied rather than a
// user-unit pad measured against one browser. 0.6em clears any UI font's descent —
// Chrome builds disagree by ~0.05em, and a baseline pinned at a fixed y left less
// than 0.94em of headroom under the host font's metrics while fitting the
// container's.
const RUNTIME_AXIS_LABEL_DY = "-0.6em";

// The chart's viewBox is scaled to the width of its column, and scales its label
// text with it. Sizing the labels in user units off the MEASURED width holds them
// at this many CSS px whatever that width is — a viewport breakpoint can only be
// right at the widths it samples, and is a cliff either side of them.
const RUNTIME_AXIS_TARGET_PX = 11;
// The plot area's own rendered height, held constant the same way.
const RUNTIME_PLOT_TARGET_PX = 165;
// Conservative average glyph advance for the UI sans stack, plus the clear space
// kept between two neighbouring labels. Over-estimating either thins one label too
// many; under-estimating collides. Both are in em, so the reserved width tracks
// the label size at every width instead of being tuned to one of them.
const RUNTIME_GLYPH_EM = 0.62;
const RUNTIME_LABEL_MARGIN_EM = 1.25;

// The y-axis gutter. The tick is end-anchored RUNTIME_TICK_INSET_EM inside it, so
// everything left of that has to hold the label itself. The minimum is the layout
// the plot is drawn against at every scale an operator sees today; a taller peak
// widens it rather than printing `1728h` outside the viewBox.
// 0.66em/glyph, not RUNTIME_GLYPH_EM: the thinning estimate can under-measure and
// still be absorbed by RUNTIME_LABEL_MARGIN_EM, and a gutter has no such margin —
// a digit measures 0.636em in the default UI sans, so 0.62 clips and 0.66 does not.
const RUNTIME_AXIS_GUTTER_MIN_EM = 3.3;
const RUNTIME_TICK_INSET_EM = 0.45;
const RUNTIME_TICK_GLYPH_EM = 0.66;

// Sized from the widest tick label ACTUALLY DRAWN. `runtimeCompactMs` has no unit
// above hours on purpose — `65h` is the reading FG-648 exists to deliver, and `2.7d`
// would undo it — so a multi-week peak legitimately prints four-digit hours, and the
// gutter is what has to accommodate them.
function runtimeAxisGutterEm(tickLabels) {
  const widest = tickLabels.reduce((longest, label) => Math.max(longest, label.length), 0);
  return Math.max(RUNTIME_AXIS_GUTTER_MIN_EM, RUNTIME_TICK_INSET_EM + widest * RUNTIME_TICK_GLYPH_EM);
}

// FG-661: the two period presentations the chart's toggle switches between. The
// grid stays UTC-aligned underneath both of them — a local grid would put the same
// run in different buckets for different readers — but Local is the default,
// because the reader's own clock is what they are trying to read the chart against.
const RUNTIME_TZ_MODES = [
  { mode: "local", label: "Local" },
  { mode: "utc", label: "UTC" },
];

// The IANA zone a mode renders in. `Intl` is the source of truth for both the clock
// values and the abbreviation. Nothing here computes an offset and nothing formats
// from a stored one: the offset the chart used to state was wrong across a DST
// transition twice, from two different derivations, because a single offset cannot
// describe a window that contains a clock change however carefully it is derived.
function runtimeZoneFor(mode) {
  return mode === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function runtimeZoneParts(ms, zone, options) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).formatToParts(new Date(ms));
  const named = {};
  for (const part of parts) named[part.type] = part.value;
  return named;
}

const RUNTIME_COMPACT_OPTS = {
  month: "numeric", day: "numeric", year: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  timeZoneName: "short",
};
const RUNTIME_RANGE_OPTS = {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  timeZoneName: "short",
};

// The axis form: as narrow as a 25-bucket window needs, and never bare about the
// zone it means. A bare `7/25` reads as whichever clock the reader is holding, and
// the toggle sitting above the plot is not carried by a cropped screenshot of it —
// so the abbreviation rides on the label itself in BOTH modes. It also does real
// work on a fall-back DST day, where it is the only thing separating the two 01:00
// buckets from each other.
function runtimeBucketLabel(iso, resolution, zone, qualified) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const at = runtimeZoneParts(ms, zone, RUNTIME_COMPACT_OPTS);
  const monthDay = `${at.month}/${at.day}`;
  const clock = `${at.hour}:${at.minute}`;
  if (resolution === "hour") {
    return `${qualified ? `${monthDay} ${clock}` : clock} ${at.timeZoneName}`;
  }
  const dated = qualified ? `${monthDay}/${at.year}` : monthDay;
  return `${resolution === "week" ? `wk ${dated}` : dated} ${at.timeZoneName}`;
}

// The labels have to be unique WITHIN the window, or a value cannot be attributed
// back to its bucket: a 1d window is 25 hourly buckets and therefore always spans
// two dates, so a bare `14:00` names two of them, and an `all` window longer than a
// year repeats `wk 6/8`. The compact form is kept while it is unambiguous, and the
// whole row escalates together when it is not — a row mixing the two forms leaves
// the bare labels attributable only by their neighbours, which is exactly what the
// thinned plot and the wrapped fallback list cannot guarantee a reader.
function runtimeAxisLabels(buckets, resolution, zone) {
  const compact = buckets.map((b) => runtimeBucketLabel(b.bucketStart, resolution, zone, false));
  return new Set(compact).size === compact.length
    ? compact
    : buckets.map((b) => runtimeBucketLabel(b.bucketStart, resolution, zone, true));
}

// The bucket's REAL endpoints, wherever there is room for both of them — the bar's
// tooltip, the per-bucket list and the screen-reader table. This is what tells the
// reader which of their own hours a bar covers, instead of handing them an offset
// to apply to a UTC label. Each end is formatted independently, so a bucket
// containing a clock change carries a different abbreviation at each end
// (`Mar 7 16:00 PST – Mar 8 17:00 PDT`) — the case no single stated offset could
// express. On a UTC-aligned grid a local day legitimately opens at an odd local
// hour; saying which one is the point, not an artifact.
function runtimeBucketRange(iso, bucketMs, zone) {
  const startMs = Date.parse(iso);
  if (!Number.isFinite(startMs) || !Number.isFinite(bucketMs)) return String(iso);
  const from = runtimeZoneParts(startMs, zone, RUNTIME_RANGE_OPTS);
  const to = runtimeZoneParts(startMs + bucketMs, zone, RUNTIME_RANGE_OPTS);
  const at = (part) => `${part.month} ${part.day} ${part.hour}:${part.minute}`;
  return from.timeZoneName === to.timeZoneName
    ? `${at(from)} – ${at(to)} ${from.timeZoneName}`
    : `${at(from)} ${from.timeZoneName} – ${at(to)} ${to.timeZoneName}`;
}

// The on-chart duration: one unit, at most one decimal, so it fits above a bar at
// 30 buckets wide. opsFmtMs stays the exact form for the table and the tooltip.
function runtimeCompactMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = ms / 1000;
  // Zero is the axis origin and the only thing that may read `0s`. Rounded to
  // whole seconds a real sub-500ms observation reads `0s` too, which is the one
  // string this chart reserves for "no duration at all" — so under a second the
  // label switches unit rather than rounding the observation away.
  if (s < 60) {
    const whole = Math.round(s);
    if (whole > 0 || ms === 0) return `${whole}s`;
    return `${Math.max(1, Math.round(ms))}ms`;
  }
  const m = s / 60;
  if (m < 60) return `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)}m`;
  const h = m / 60;
  return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)}h`;
}

function runtimeAxisScale(peakMs) {
  const step = RUNTIME_TICK_STEPS_MS.find((candidate) => peakMs <= candidate * RUNTIME_TICK_TARGET)
    ?? Math.ceil(peakMs / RUNTIME_TICK_TARGET / 86_400_000) * 86_400_000;
  const max = Math.max(step, Math.ceil(peakMs / step) * step);
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

// FG-683: the panel's two metrics. The labels are the operator-facing names, and
// they are what the headings and the empty states are written from — a count
// chart that could be mistaken for the duration chart is the defect this ticket
// exists to avoid.
const RUNTIME_METRICS = [
  { metric: RUNTIME_METRIC_DURATION, label: "Average agent runtime", heading: "Average agent runtime over time" },
  { metric: RUNTIME_METRIC_COMPLETED_RUNS, label: "Completed runs", heading: "Completed runs over time" },
];

function AgentRuntimeTrends({ runtimeLoad, completedRunsLoad, requestedWindow, onWindowChange, role, onRoleChange, metric, onMetricChange }) {
  const [tzMode, setTzMode] = useState("local");
  const zone = runtimeZoneFor(tzMode);
  const showRuns = metric === RUNTIME_METRIC_COMPLETED_RUNS;
  const data = runtimeLoad.data;
  const completedRuns = completedRunsLoad.data;
  const roles = data ? data.roleSummary.map((r) => r.role) : [];
  const roleObserved = role === RUNTIME_ALL_ROLES || roles.includes(role);
  // The fallback to "All agents" is written back, not just displayed. Left in
  // state, the unobserved role would silently re-chart itself on the next window
  // change — and re-picking "All agents" in the select fires no change event,
  // because the select already shows it.
  useEffect(() => {
    if (data && !roleObserved) onRoleChange(RUNTIME_ALL_ROLES);
  }, [data, roleObserved, onRoleChange]);

  // FG-836: the selected metric's own load. Every label below reads the window its
  // data came from (`shownWindow`), never the one asked for, so a view still waiting
  // on — or failed at — a new window cannot claim to be it.
  const load = showRuns ? completedRunsLoad : runtimeLoad;
  const loadView = windowLoadView(load, requestedWindow);
  const shownWindow = loadView.showing;
  const shownData = load.data;
  const shownError = load.error;
  const noun = showRuns ? "completed runs" : "agent runtime";

  const controls = html`
    <div class="runtime-controls">
      <span class="muted" id="runtime-metric-label">metric:</span>
      <div class="runtime-metric-btns" role="group" aria-labelledby="runtime-metric-label">
        ${RUNTIME_METRICS.map(({ metric: option, label }) => html`
          <button
            key=${option}
            type="button"
            class=${"usage-dim-btn " + (metric === option ? "usage-dim-btn-active" : "")}
            aria-pressed=${metric === option}
            onClick=${() => onMetricChange(option)}
          >${label}</button>
        `)}
      </div>
      <span class="muted" id="runtime-window-label">runtime window:</span>
      <div class="runtime-window-btns" role="group" aria-labelledby="runtime-window-label" aria-busy=${loadView.loading ? "true" : "false"}>
        ${RUNTIME_WINDOWS.map((w) => html`
          <button
            key=${w}
            type="button"
            class=${"usage-dim-btn " + (loadView.pressed === w ? "usage-dim-btn-active" : "") + (loadView.loadingWindow === w ? " runtime-window-pending" : "")}
            aria-pressed=${loadView.pressed === w}
            disabled=${loadView.loading}
            onClick=${() => onWindowChange(w)}
          >${w}</button>
        `)}
      </div>
      ${shownWindow ? html`<span class="muted runtime-showing">showing ${shownWindow}</span>` : null}
      <span class="muted" id="runtime-tz-label">times:</span>
      <div class="runtime-tz-btns" role="group" aria-labelledby="runtime-tz-label">
        ${RUNTIME_TZ_MODES.map(({ mode, label }) => html`
          <button
            key=${mode}
            type="button"
            class=${"usage-dim-btn " + (tzMode === mode ? "usage-dim-btn-active" : "")}
            aria-pressed=${tzMode === mode}
            onClick=${() => setTzMode(mode)}
          >${label}</button>
        `)}
      </div>
    </div>
  `;

  // FG-661/RF-15: a read that starts failing AFTER a load leaves the last series
  // on screen, so the error card below (which only renders when there is nothing
  // to show) is unreachable and the operator watches frozen numbers believing they
  // are current. The series is kept — stale numbers beat no numbers — and said to
  // be stale, beside the chart still showing them. FG-836: when the failed read was
  // for a different window, the notice names both, so the kept series is never
  // mistaken for the window that failed.
  const staleNotice = shownData && shownError ? html`
    <div class=${"card runtime-stale " + toneAccentClass(shownError.window === shownWindow ? "warn" : "err")} role="alert">
      ${shownError.window === shownWindow
        ? `${shownError.reason}. Showing the last successful read — these numbers are stale. Retrying every 30s.`
        : `${shownError.reason}. Still showing ${shownWindow} — these numbers are for ${shownWindow}, not ${shownError.window}. Retrying every 30s.`}
    </div>
  ` : null;

  const loadingLine = shownData && loadView.loading ? html`
    <div class=${"card muted runtime-loading " + toneAccentClass("info")} role="status">
      loading ${loadView.loadingWindow}… showing ${shownWindow} until it answers
    </div>
  ` : null;

  const frame = (body) => html`
    <section class="runtime-view" aria-labelledby="runtime-heading">
      <h2 id="runtime-heading">${RUNTIME_METRICS.find((m) => m.metric === metric)?.heading ?? RUNTIME_METRICS[0].heading}</h2>
      ${controls}
      ${staleNotice}
      ${loadingLine}
      <div class=${"runtime-body" + (loadingLine ? " runtime-body-loading" : "")} aria-busy=${loadingLine ? "true" : "false"}>${body}</div>
    </section>
  `;

  if (!shownData) {
    return frame(shownError
      ? html`<div class=${"card runtime-error " + toneAccentClass("err")} role="alert">${shownError.reason}. Retrying every 30s.</div>`
      : html`<div class=${"card muted runtime-loading " + toneAccentClass("info")} role="status">loading ${noun} for ${loadView.loadingWindow ?? requestedWindow}…</div>`);
  }

  if (showRuns) {
    const total = completedRuns.totalCompletedRuns;
    return frame(html`
      <div class="runs-total">
        <span class="runs-total-num">${total}</span>
        <span class="muted runs-total-note">completed ${total === 1 ? "run" : "runs"} in ${shownWindow}</span>
      </div>
      ${completedRuns.buckets.length === 0
        ? html`<div class="card runtime-empty runs-empty">
            No completed runs in this window. Widen the window, or wait for a run to finish.
          </div>`
        : html`<${CompletedRunsChart}
            buckets=${completedRuns.buckets}
            total=${total}
            resolution=${completedRuns.resolution}
            window=${shownWindow}
            bucketMs=${completedRuns.bucketMs}
            zone=${zone}
            mode=${tzMode}
          />`}
    `);
  }

  const activeRole = roleObserved ? role : RUNTIME_ALL_ROLES;
  const isAll = activeRole === RUNTIME_ALL_ROLES;
  const seriesLabel = isAll ? "All agents" : activeRole;
  const buckets = isAll ? data.overall : (data.byRole.find((s) => s.role === activeRole)?.buckets ?? []);
  const observed = buckets.filter((b) => b.sampleCount > 0);
  const samples = observed.reduce((total, b) => total + b.sampleCount, 0);

  const selector = html`
    <div class="runtime-selector">
      <label for="runtime-role">series</label>
      <select
        id="runtime-role"
        class="runtime-role-select"
        value=${activeRole}
        onChange=${(e) => onRoleChange(e.currentTarget.value)}
      >
        <option value=${RUNTIME_ALL_ROLES}>All agents</option>
        ${roles.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
      </select>
      <span class="muted runtime-sample-note">${samples} ${samples === 1 ? "run" : "runs"} in ${shownWindow}</span>
    </div>
  `;

  if (samples === 0) {
    return frame(html`
      ${selector}
      <div class="card runtime-empty">
        No completed agent runs for ${seriesLabel} in this window. Widen the window, or wait for a run to finish.
      </div>
    `);
  }

  return frame(html`
    ${selector}
    <${RuntimeChart}
      buckets=${buckets}
      label=${seriesLabel}
      resolution=${data.resolution}
      window=${shownWindow}
      bucketMs=${data.bucketMs}
      zone=${zone}
      mode=${tzMode}
    />
    <${RuntimeRoleTable} summary=${data.roleSummary} activeRole=${activeRole} onRoleChange=${onRoleChange} window=${shownWindow} />
  `);
}

/** The element's rendered width in CSS px, tracked across layout changes. */
function useRenderedWidthPx(ref) {
  const [widthPx, setWidthPx] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidthPx(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidthPx(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return widthPx;
}

function RuntimeChart({ buckets, label, resolution, window, bucketMs, zone, mode }) {
  const VW = 1000;
  const svgRef = useRef(null);
  const widthPx = useRenderedWidthPx(svgRef);
  const fontUnits = widthPx > 0 ? (RUNTIME_AXIS_TARGET_PX * VW) / widthPx : RUNTIME_AXIS_TARGET_PX;
  // PAD_* insets the plot from the y-axis gutter on the left and the two label
  // rows (UTC period, run count) below. They follow the label size rather than a
  // fixed largest-font assumption, so the bands stay clear at every width — and
  // PAD_LEFT follows the widest tick the axis is about to draw, so it stays clear
  // at every PEAK too. Containment is the labels' own em offsets, not these.
  const peak = Math.max(...buckets.map((b) => b.averageMs ?? 0), 1);
  const scale = runtimeAxisScale(peak);
  const tickTexts = scale.ticks.map(runtimeCompactMs);
  const PAD_LEFT = fontUnits * runtimeAxisGutterEm(tickTexts);
  const PAD_RIGHT = fontUnits * 0.8;
  const PAD_TOP = fontUnits * 1.7;
  const PAD_BOTTOM = fontUnits * 3.3;
  // The viewBox HEIGHT is em-relative too. A fixed one scales with the column,
  // so at a phone width the gutters ate the plot and four y-ticks piled onto each
  // other. Deriving it from the label size instead holds the plot at
  // RUNTIME_PLOT_TARGET_PX rendered pixels at every width, gutters included.
  const chartH = fontUnits * (RUNTIME_PLOT_TARGET_PX / RUNTIME_AXIS_TARGET_PX);
  const VH = PAD_TOP + chartH + PAD_BOTTOM;
  const plotW = VW - PAD_LEFT - PAD_RIGHT;
  const baseY = VH - PAD_BOTTOM;
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.68, 56);
  const partialIdx = buckets.findIndex((b) => b.partial && b.sampleCount > 0);
  const unit = RUNTIME_RESOLUTION_WORD[resolution] ?? resolution;
  // The compact form goes on the plot, where a tick is 40 user units wide; the full
  // range goes everywhere there is room for it. Both switch with the toggle, so no
  // surface is ever left reading the mode the operator just moved away from.
  const periodTexts = runtimeAxisLabels(buckets, resolution, zone);
  const rangeTexts = buckets.map((b) => runtimeBucketRange(b.bucketStart, bucketMs, zone));
  // A floor in em, not user units: a bar three orders of magnitude under the peak
  // still has to be visible at a phone width, where a user unit is a third of a pixel.
  const barH = (b) => Math.max(fontUnits * 0.25, Math.round((b.averageMs / scale.max) * chartH));
  const xAt = (i) => PAD_LEFT + slot * i + slot / 2;

  const bars = buckets.map((b, i) => {
    const x = xAt(i) - barW / 2;
    // An empty bucket draws NO bar. A baseline tick keeps the gap visible as a
    // gap rather than reading as a missing period.
    if (b.sampleCount === 0) {
      return html`<rect key=${b.bucketStart} x=${x} y=${baseY - 1} width=${barW} height="1" fill="var(--fg-faint)" opacity="0.35" />`;
    }
    const h = barH(b);
    return html`<rect
      key=${b.bucketStart}
      class=${"runtime-bar" + (b.partial ? " runtime-bar-partial" : "")}
      x=${x} y=${baseY - h} width=${barW} height=${h}
      fill=${b.partial ? "url(#runtime-partial-hatch)" : "var(--accent)"}
      stroke=${b.partial ? "var(--accent)" : "none"}
      stroke-dasharray=${b.partial ? "4 3" : null}
    ><title>${rangeTexts[i]}: ${opsFmtMs(b.averageMs)} over ${b.sampleCount} ${b.sampleCount === 1 ? "run" : "runs"}${b.partial ? " (partial)" : ""}</title></rect>`;
  });

  // Thin a label row by LABEL WIDTH, not by bucket count: 25 hourly buckets over a
  // 1000-unit viewBox leave 40 units each, and an "03:00 UTC" label needs far more.
  // The width is derived from the longest label actually being drawn and the font
  // size actually applied — a weekly "wk 6/10 UTC" is half again as wide as a daily
  // "6/10 UTC", and both grow as the column narrows. Keep the trailing bucket
  // unconditionally — it is the current period — and drop what would collide.
  // Anchoring stops the first and last labels running off the viewBox at a width
  // where half a label is wider than half a slot. The span it produces is what the
  // thinning measures against: an end-anchored trailing label sits a half-label
  // LEFT of its bar, so a rule written in bar-centre distances lets it collide.
  const placeLabel = (i, text) => {
    const glyphs = fontUnits * RUNTIME_GLYPH_EM * text.length;
    const pad = (fontUnits * RUNTIME_LABEL_MARGIN_EM) / 2;
    const x = xAt(i);
    const anchor = x - glyphs / 2 < 0 ? "start" : x + glyphs / 2 > VW ? "end" : "middle";
    const left = anchor === "start" ? x : anchor === "end" ? x - glyphs : x - glyphs / 2;
    return { anchor, left: left - pad, right: left + glyphs + pad };
  };

  const thin = (texts) => {
    const spans = texts.map((text, i) => placeLabel(i, text));
    const kept = [];
    for (let i = 0; i < n - 1; i += 1) {
      if (kept.length === 0 || spans[i].left >= spans[kept[kept.length - 1]].right) kept.push(i);
    }
    while (kept.length > 0 && spans[n - 1].left < spans[kept[kept.length - 1]].right) kept.pop();
    kept.push(n - 1);
    return kept;
  };

  const valueTexts = buckets.map((b) => (b.sampleCount === 0 ? "" : runtimeCompactMs(b.averageMs)));
  const countTexts = buckets.map((b) => String(b.sampleCount));
  const periodIdxs = thin(periodTexts);

  // The thinning above keeps labels off each OTHER; this keeps them off the BARS.
  // A value label is drawn above its own bar and bounded horizontally only by the
  // viewBox, so above a short bar standing beside a tall one it lands on the
  // neighbour's fill, where --fg on --accent is 2:1 and the number is gone. A
  // duration label carries no descender, so its lowest ink is its baseline: it
  // clears a bar whose top is at or below that. What this drops, the per-bucket
  // list beneath the plot carries — the same path a thinned label takes.
  const valueClearsBars = (i) => {
    const span = placeLabel(i, valueTexts[i]);
    const baseline = baseY - barH(buckets[i]) - fontUnits * 0.45;
    return buckets.every((b, j) => {
      if (j === i || b.sampleCount === 0) return true;
      const barLeft = xAt(j) - barW / 2;
      if (span.right <= barLeft || span.left >= barLeft + barW) return true;
      return baseY - barH(b) >= baseline;
    });
  };

  // A bar carries its mean and its run count together or not at all — a lone
  // number under a bar with no value above it is worse than no label.
  const valueIdxs = thin(buckets.map((b, i) => (valueTexts[i].length >= countTexts[i].length ? valueTexts[i] : countTexts[i])))
    .filter((i) => buckets[i].sampleCount === 0 || valueClearsBars(i));
  // Both rows, not just the values. The period row is far wider (`wk 6/8 UTC` vs
  // `3`), so it thins FIRST and independently: gated on the value row alone, the
  // list vanished exactly when every bar carried a number and only some carried a
  // date. A value the operator can read but cannot attribute to a period is the
  // misattribution this ticket was reopened for, wearing a different hat.
  const labelledEveryBucket = periodIdxs.length === n && valueIdxs.length === n;

  const summaryText = `Average agent runtime for ${label}, by ${unit}, over ${window}. `
    + buckets
      .map((b, i) => (b.sampleCount === 0 ? null
        : `${periodTexts[i]} ${opsFmtMs(b.averageMs)} over ${b.sampleCount} ${b.sampleCount === 1 ? "run" : "runs"}${b.partial ? " (partial)" : ""}`))
      .filter(Boolean)
      .join(", ")
    + `. Peak ${opsFmtMs(peak)}.`;
  const zoneLabel = mode === "utc" ? "UTC" : `your local time (${zone})`;

  return html`
    <figure class="runtime-chart">
      <svg ref=${svgRef} viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label=${summaryText}>
        <defs>
          <pattern id="runtime-partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--bg-elev-2)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="3" />
          </pattern>
        </defs>
        ${scale.ticks.map((value, tick) => {
          const y = baseY - (value / scale.max) * chartH;
          return html`<g key=${value}>
            <line class="runtime-gridline" x1=${PAD_LEFT} y1=${y} x2=${VW - PAD_RIGHT} y2=${y} stroke="var(--border)" stroke-width="1" opacity=${value === 0 ? 1 : 0.6} />
            <text class="runtime-y-tick" x=${PAD_LEFT - fontUnits * RUNTIME_TICK_INSET_EM} y=${y} dy="0.32em" text-anchor="end" font-size=${fontUnits} fill="var(--fg-dim)">${tickTexts[tick]}</text>
          </g>`;
        })}
        ${bars}
        ${valueIdxs.filter((i) => buckets[i].sampleCount > 0).map((i) => html`
          <text class="runtime-value" key=${buckets[i].bucketStart} x=${xAt(i)} y=${baseY - barH(buckets[i])} dy="-0.45em"
            text-anchor=${placeLabel(i, valueTexts[i]).anchor} font-size=${fontUnits} fill="var(--fg)">${valueTexts[i]}</text>
        `)}
        ${periodIdxs.map((i) => html`
          <text class="runtime-x-tick" key=${buckets[i].bucketStart} x=${xAt(i)} y=${VH} dy="-1.85em"
            text-anchor=${placeLabel(i, periodTexts[i]).anchor} font-size=${fontUnits} fill="var(--fg-dim)">${periodTexts[i]}</text>
        `)}
        <text class="runtime-count-head" x="0" y=${VH} dy=${RUNTIME_AXIS_LABEL_DY} text-anchor="start" font-size=${fontUnits} fill="var(--fg-dim)">RUNS</text>
        ${valueIdxs.map((i) => html`
          <text class="runtime-count" key=${buckets[i].bucketStart} x=${xAt(i)} y=${VH} dy=${RUNTIME_AXIS_LABEL_DY}
            text-anchor=${placeLabel(i, countTexts[i]).anchor} font-size=${fontUnits} fill="var(--fg-dim)">${countTexts[i]}</text>
        `)}
      </svg>
      ${labelledEveryBucket ? null : html`
        <ul class="runtime-bucket-values" aria-hidden="true">
          ${buckets.map((b, i) => html`
            <li key=${b.bucketStart}>
              <span class="mono">${rangeTexts[i]}</span>
              ${b.sampleCount === 0 ? " no runs" : ` ${valueTexts[i]} · ${b.sampleCount} ${b.sampleCount === 1 ? "run" : "runs"}`}
            </li>
          `)}
        </ul>
      `}
      <figcaption class="runtime-caption">
        Mean duration of completed agent tasks per ${unit}, bucketed by completion time. Successful and failed runs both count.
        ${html` <span class="runtime-zone-note">The bucket grid is UTC-aligned; periods are shown in ${zoneLabel}.</span>`}
        ${partialIdx >= 0
          ? html` <span class="runtime-partial-note">The last ${unit} (${periodTexts[partialIdx]}) is hatched — it is still in progress and its average can still move.</span>`
          : null}
      </figcaption>
      <div class="sr-only">
        <table class="runtime-text-equivalent">
          <caption>${`Average agent runtime for ${label} by ${unit}`}</caption>
          <thead><tr><th scope="col">${unit}</th><th scope="col">average</th><th scope="col">runs</th></tr></thead>
          <tbody>
            ${buckets.map((b, i) => html`
              <tr key=${b.bucketStart}>
                <th scope="row">${rangeTexts[i]}${b.partial ? " (partial)" : ""}</th>
                <td>${b.sampleCount === 0 ? "no runs" : opsFmtMs(b.averageMs)}</td>
                <td>${b.sampleCount}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </figure>
  `;
}

// FG-683: the throughput chart. A COUNT of completed forge runs per bucket, on
// the same UTC-aligned grid the duration chart uses and sharing its period
// labelling — and nothing else. It carries no duration unit, no mean, no role
// series and no agent-task sample note, because none of those are what it counts.
// An integer axis, drawn against whole runs. `1.5` runs is not a reading, so the
// axis steps are whole numbers at every scale and the top is the next one at or
// above the peak.
function runsAxisScale(peak) {
  const rough = Math.max(1, peak) / RUNTIME_TICK_TARGET;
  const magnitude = Math.max(1, 10 ** Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10;
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

function CompletedRunsChart({ buckets, total, resolution, window, bucketMs, zone, mode }) {
  const VW = 1000;
  const svgRef = useRef(null);
  const widthPx = useRenderedWidthPx(svgRef);
  const fontUnits = widthPx > 0 ? (RUNTIME_AXIS_TARGET_PX * VW) / widthPx : RUNTIME_AXIS_TARGET_PX;
  const peak = Math.max(...buckets.map((b) => b.completedRuns), 1);
  const scale = runsAxisScale(peak);
  const tickTexts = scale.ticks.map(String);
  const PAD_LEFT = fontUnits * runtimeAxisGutterEm(tickTexts);
  const PAD_RIGHT = fontUnits * 0.8;
  // FG-683: the `runs` axis unit gets a band RESERVED FOR IT at the top of the
  // viewBox, drawn on a baseline inside that band — not hung above the plot by a
  // negative dy off the y=PAD_TOP edge. Hanging it off an edge made containment a
  // function of the font's ascent (and, at x=0, of its left side bearing), so the
  // same markup fitted on one machine's resolved font and escaped on another's.
  // Inside the band it is contained by the geometry: the baseline sits
  // UNIT_BASELINE_EM below the top of the viewBox, so the glyph box escapes only
  // if the font's ascent exceeds 1.8x the font size, and it starts UNIT_INSET_EM
  // in from the left edge, so it escapes sideways only on a side bearing more
  // negative than half an em. Neither is reachable for a text font — real UI sans
  // ascents top out near 1.07em (Noto Sans) and side bearings on `r` are positive.
  // UNIT_BAND_EM leaves 0.8em under the baseline for the descent before the band
  // ends, and the plot's own 1.7em top gutter after that.
  const UNIT_BASELINE_EM = 1.8;
  const UNIT_BAND_EM = 2.6;
  const UNIT_INSET_EM = 0.5;
  const PAD_TOP = fontUnits * (UNIT_BAND_EM + 1.7);
  const PAD_BOTTOM = fontUnits * 2.2;
  const chartH = fontUnits * (RUNTIME_PLOT_TARGET_PX / RUNTIME_AXIS_TARGET_PX);
  const VH = PAD_TOP + chartH + PAD_BOTTOM;
  const plotW = VW - PAD_LEFT - PAD_RIGHT;
  const baseY = VH - PAD_BOTTOM;
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.68, 56);
  const partialIdx = buckets.findIndex((b) => b.partial);
  const unit = RUNTIME_RESOLUTION_WORD[resolution] ?? resolution;
  const periodTexts = runtimeAxisLabels(buckets, resolution, zone);
  const rangeTexts = buckets.map((b) => runtimeBucketRange(b.bucketStart, bucketMs, zone));
  const barH = (b) => (b.completedRuns === 0 ? 0 : Math.max(fontUnits * 0.25, Math.round((b.completedRuns / scale.max) * chartH)));
  const xAt = (i) => PAD_LEFT + slot * i + slot / 2;

  // A zero bucket still draws — as a bar of zero height sitting ON the baseline,
  // labelled `0`. Zero completions is something the store observed, not a period
  // it has nothing to say about, and the duration chart's missing-sample gap
  // would say the wrong thing about it.
  const bars = buckets.map((b, i) => {
    const h = barH(b);
    const x = xAt(i) - barW / 2;
    return html`<rect
      key=${b.bucketStart}
      class=${"runs-bar" + (b.completedRuns === 0 ? " runs-bar-zero" : "") + (b.partial ? " runs-bar-partial" : "")}
      x=${x} y=${baseY - h} width=${barW} height=${Math.max(h, 1)}
      fill=${b.partial ? "url(#runs-partial-hatch)" : "var(--accent)"}
      stroke=${b.partial ? "var(--accent)" : "none"}
      stroke-dasharray=${b.partial ? "4 3" : null}
    ><title>${rangeTexts[i]}: ${b.completedRuns} completed ${b.completedRuns === 1 ? "run" : "runs"}${b.partial ? " (partial)" : ""}</title></rect>`;
  });

  const placeLabel = (i, text) => {
    const glyphs = fontUnits * RUNTIME_GLYPH_EM * text.length;
    const pad = (fontUnits * RUNTIME_LABEL_MARGIN_EM) / 2;
    const x = xAt(i);
    const anchor = x - glyphs / 2 < 0 ? "start" : x + glyphs / 2 > VW ? "end" : "middle";
    const left = anchor === "start" ? x : anchor === "end" ? x - glyphs : x - glyphs / 2;
    return { anchor, left: left - pad, right: left + glyphs + pad };
  };

  const thin = (texts) => {
    const spans = texts.map((text, i) => placeLabel(i, text));
    const kept = [];
    for (let i = 0; i < n - 1; i += 1) {
      if (kept.length === 0 || spans[i].left >= spans[kept[kept.length - 1]].right) kept.push(i);
    }
    while (kept.length > 0 && spans[n - 1].left < spans[kept[kept.length - 1]].right) kept.pop();
    kept.push(n - 1);
    return kept;
  };

  const valueTexts = buckets.map((b) => String(b.completedRuns));
  const periodIdxs = thin(periodTexts);
  // A count label sits above its own bar and is bounded only by the viewBox, so
  // beside a much taller neighbour it would land on that neighbour's fill.
  const valueClearsBars = (i) => {
    const span = placeLabel(i, valueTexts[i]);
    const baseline = baseY - barH(buckets[i]) - fontUnits * 0.45;
    return buckets.every((b, j) => {
      if (j === i) return true;
      const barLeft = xAt(j) - barW / 2;
      if (span.right <= barLeft || span.left >= barLeft + barW) return true;
      return baseY - barH(b) >= baseline;
    });
  };
  const valueIdxs = thin(valueTexts).filter(valueClearsBars);
  const labelledEveryBucket = periodIdxs.length === n && valueIdxs.length === n;

  const summaryText = `Completed runs by ${unit}, over ${window}. `
    + buckets.map((b, i) => `${periodTexts[i]} ${b.completedRuns}${b.partial ? " (partial)" : ""}`).join(", ")
    + `. Total ${total} completed ${total === 1 ? "run" : "runs"}.`;
  const zoneLabel = mode === "utc" ? "UTC" : `your local time (${zone})`;

  return html`
    <figure class="runtime-chart runs-chart">
      <svg ref=${svgRef} viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label=${summaryText}>
        <defs>
          <pattern id="runs-partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--bg-elev-2)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="3" />
          </pattern>
        </defs>
        ${scale.ticks.map((value, tick) => {
          const y = baseY - (value / scale.max) * chartH;
          return html`<g key=${value}>
            <line class="runtime-gridline" x1=${PAD_LEFT} y1=${y} x2=${VW - PAD_RIGHT} y2=${y} stroke="var(--border)" stroke-width="1" opacity=${value === 0 ? 1 : 0.6} />
            <text class="runs-y-tick" x=${PAD_LEFT - fontUnits * RUNTIME_TICK_INSET_EM} y=${y} dy="0.32em" text-anchor="end" font-size=${fontUnits} fill="var(--fg-dim)">${tickTexts[tick]}</text>
          </g>`;
        })}
        <text class="runs-axis-unit" x=${fontUnits * UNIT_INSET_EM} y=${fontUnits * UNIT_BASELINE_EM} text-anchor="start" font-size=${fontUnits} fill="var(--fg-dim)">runs</text>
        ${bars}
        ${valueIdxs.map((i) => html`
          <text class="runs-value" key=${buckets[i].bucketStart} x=${xAt(i)} y=${baseY - barH(buckets[i])} dy="-0.45em"
            text-anchor=${placeLabel(i, valueTexts[i]).anchor} font-size=${fontUnits} fill="var(--fg)">${valueTexts[i]}</text>
        `)}
        ${periodIdxs.map((i) => html`
          <text class="runs-x-tick" key=${buckets[i].bucketStart} x=${xAt(i)} y=${VH} dy=${RUNTIME_AXIS_LABEL_DY}
            text-anchor=${placeLabel(i, periodTexts[i]).anchor} font-size=${fontUnits} fill="var(--fg-dim)">${periodTexts[i]}</text>
        `)}
      </svg>
      ${labelledEveryBucket ? null : html`
        <ul class="runtime-bucket-values runs-bucket-values" aria-hidden="true">
          ${buckets.map((b, i) => html`
            <li key=${b.bucketStart}>
              <span class="mono">${rangeTexts[i]}</span>
              ${` ${b.completedRuns} ${b.completedRuns === 1 ? "run" : "runs"}`}
            </li>
          `)}
        </ul>
      `}
      <figcaption class="runtime-caption runs-caption">
        Completed forge runs per ${unit}, counted once each and bucketed by run completion time. Interactive orchestrator
        sessions are excluded; a run that started earlier still counts in the ${unit} it finished in.
        ${html` <span class="runtime-zone-note">The bucket grid is UTC-aligned; periods are shown in ${zoneLabel}.</span>`}
        ${partialIdx >= 0
          ? html` <span class="runtime-partial-note">The last ${unit} (${periodTexts[partialIdx]}) is hatched — it is still in progress and its count can still rise.</span>`
          : null}
      </figcaption>
      <div class="sr-only">
        <table class="runs-text-equivalent">
          <caption>${`Completed runs by ${unit} over ${window} — ${total} in total`}</caption>
          <thead><tr><th scope="col">${unit}</th><th scope="col">completed runs</th></tr></thead>
          <tbody>
            ${buckets.map((b, i) => html`
              <tr key=${b.bucketStart}>
                <th scope="row">${rangeTexts[i]}${b.partial ? " (partial)" : ""}</th>
                <td>${b.completedRuns}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </figure>
  `;
}

function RuntimeRoleTable({ summary, activeRole, onRoleChange, window }) {
  const rows = [{ role: RUNTIME_ALL_ROLES, label: "All agents" }, ...summary.map((r) => ({ ...r, label: r.role }))];
  const total = summary.reduce((acc, r) => ({
    samples: acc.samples + r.sampleCount,
    weighted: acc.weighted + r.averageMs * r.sampleCount,
  }), { samples: 0, weighted: 0 });

  return html`
    <table class="runtime-table">
      <caption>Average runtime by agent role (${window}) — select a row to chart it</caption>
      <thead>
        <tr><th scope="col">role</th><th scope="col">average</th><th scope="col">runs</th></tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const isAll = row.role === RUNTIME_ALL_ROLES;
          const averageMs = isAll ? (total.samples > 0 ? total.weighted / total.samples : null) : row.averageMs;
          const sampleCount = isAll ? total.samples : row.sampleCount;
          const selected = activeRole === row.role;
          return html`
            <tr key=${row.role} class=${selected ? "runtime-row-active" : ""}>
              <th scope="row">
                <button
                  type="button"
                  class=${"runtime-role-btn" + (selected ? " runtime-role-btn-active" : "")}
                  aria-pressed=${selected}
                  onClick=${() => onRoleChange(row.role)}
                >${row.label}</button>
              </th>
              <td class="mono">${opsFmtMs(averageMs)}</td>
              <td class="mono">${sampleCount}</td>
            </tr>
          `;
        })}
      </tbody>
    </table>
  `;
}

function ProjectsView({ projects, onPick, onReload }) {
  if (projects.length === 0) {
    return html`
      <section class="projects-grid">
        <div class="muted" style="grid-column: 1 / -1;">
          No forge projects detected yet. Run <span class="mono">forge init</span> in a project to register it.
        </div>
      </section>
    `;
  }
  return html`
    <section class="projects-grid">
      ${projects.map((p) => html`<${ProjectCard} key=${p.key} project=${p} onPick=${onPick} onReload=${onReload} />`)}
    </section>
  `;
}

function ProjectCard({ project, onPick, onReload }) {
  const ageState = projectAgeState(project);
  // FG-745: visibility is decided server-side (GET /api/projects already omits
  // recorded artifacts). The client NEVER re-filters — it renders whatever the API
  // returns and only flags an `unclassified` record and offers the repair path.
  const unclassified = project.classification === "unclassified";
  // The classify form is disclosed on demand: an always-open form on every
  // unclassified card is noisy AND would grow the card body, so a compact toggle in
  // the head reveals it. The badge alone (no body growth) keeps the card's default
  // shape stable — the card's primary click target stays the project body.
  const [showClassify, setShowClassify] = useState(false);
  // FG-759 (#1): the per-checkout list is a SECONDARY, on-demand detail — collapsed
  // behind a low-emphasis toggle and shown only when a logical project genuinely spans
  // more than one working directory. It never leads the card.
  const [showDirs, setShowDirs] = useState(false);
  // FG-759 (#2): a one-click operator claim. It is an EXPLICIT operator action (never
  // an automatic classify — that would regress FG-745's fail-safe); it just reuses the
  // existing operator classify path so a real project can shed the quiet flag in one tap.
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState(null);
  // RF-2: a successful claim must be perceivable NOW. The Projects list is served from a
  // short-lived server-side cache, so the card only re-projects as classified on the next
  // uncached read (see postClassify / ClassifyControl) — until then it would look unchanged
  // and the operator can't tell the one-click claim worked. Hold a local success state and
  // announce it, exactly as the full ClassifyControl form does.
  const [claimed, setClaimed] = useState(false);
  const claimedRef = useRef(null);
  useEffect(() => {
    if (claimed && claimedRef.current) claimedRef.current.focus();
  }, [claimed]);
  const claimAsProject = async (event) => {
    event.stopPropagation();
    setClaiming(true);
    setClaimError(null);
    try {
      const result = await postClassify(project.primaryCheckout || project.projectDir, "operator");
      if (result.ok) {
        setClaimed(true);
        if (onReload) onReload();
      } else {
        setClaimError(result.error);
      }
    } catch (err) {
      setClaimError(String(err));
    } finally {
      setClaiming(false);
    }
  };
  const { all: allCheckouts, rows: checkouts, missingCount } = cardCheckouts(project);
  const openProject = (event) => {
    if (event) event.stopPropagation();
    onPick(project, null);
  };
  // RF-2: the card is NOT an ARIA button — it hosts its own interactive controls
  // (the "Open" chip, claim, classify toggle, working-dirs toggle, GitHub link), and
  // interactive content inside a role=button is invalid ARIA. The card is a plain
  // container; the focusable primary "open" control is the label chip below. The
  // whole-card click stays as a mouse convenience: a click that originates inside any
  // interactive descendant reaches only that control, never opening the card twice.
  const onClick = (event) => {
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    onPick(project, null);
  };
  return html`
    <div class=${"project-card state-" + ageState + (unclassified ? " project-unclassified-card" : "")} onClick=${onClick}>
      <div class="project-card-head">
        <button
          type="button"
          class="project-chip project-open"
          style=${{ background: project.color }}
          aria-label=${`Open all ${project.label} checkouts`}
          onClick=${openProject}
        >${project.label}</button>
        ${unclassified
          ? html`<span
              class="badge project-unclassified-badge"
              title="This workspace has no recorded purpose yet. Tell forge it's your project, or classify it as a Forge artifact."
            >unclassified</span>`
          : null}
        ${unclassified && claimed
          ? html`<span
              class="project-claim-done"
              role="status"
              tabindex="-1"
              ref=${claimedRef}
            >✓ Recorded as your project</span>`
          : null}
        ${unclassified && !claimed
          ? html`<button
              type="button"
              class="project-claim"
              disabled=${claiming}
              title="Record this as your operator project"
              onClick=${claimAsProject}
            >${claiming ? "Saving…" : "This is my project"}</button>`
          : null}
        ${unclassified && !claimed
          ? html`<button
              type="button"
              class="project-classify-toggle"
              aria-expanded=${showClassify}
              title="Classify this workspace as an operator project or a Forge artifact"
              onClick=${(event) => { event.stopPropagation(); setShowClassify((v) => !v); }}
            >${showClassify ? "Cancel" : "Classify…"}</button>`
          : null}
        ${project.liveSessions > 0
          ? html`<span class="live-indicator" title=${`${project.liveSessions} live orchestrator session(s)`}>● LIVE</span>`
          : null}
        ${project.githubUrl
          ? html`<a
              class="project-github"
              href=${project.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              title=${"Open " + project.githubUrl}
              onClick=${(e) => e.stopPropagation()}
            >GitHub ↗</a>`
          : null}
      </div>
      ${claimError ? html`<div class="project-classify-error" role="alert">${claimError}</div>` : null}
      ${project.description ? html`<div class="project-desc">${project.description}</div>` : null}
      ${!project.description && project.readmeFirstLine ? html`<div class="project-desc faint">${project.readmeFirstLine}</div>` : null}
      ${projectOwnerLine(project)}
      <div class="project-stats">
        <div>
          <div class="project-stat-label">last activity</div>
          <div class="project-stat-val">${project.lastRunAt ? formatRelativeTime(project.lastRunAt) : "—"}</div>
        </div>
        <div>
          <div class="project-stat-label">runs</div>
          <div class="project-stat-val">${project.runCount}</div>
        </div>
        <div>
          <div class="project-stat-label">in-flight</div>
          <div class="project-stat-val ${project.inFlightCount > 0 ? "stat-warn" : ""}">${project.inFlightCount}</div>
        </div>
      </div>
      ${checkouts.length > 1
        ? html`
            <div class="project-working-dirs">
              <button
                type="button"
                class="project-dirs-toggle faint"
                aria-expanded=${showDirs}
                title="Working directories this project spans"
                onClick=${(event) => { event.stopPropagation(); setShowDirs((v) => !v); }}
              >${checkouts.length} working dirs ${showDirs ? "▾" : "▸"}</button>
              ${showDirs
                ? html`<div class="project-checkouts" aria-label=${`${project.label} working directories`}>
                    ${checkouts.map((checkout) => checkoutRow(project, checkout, allCheckouts, onPick))}
                  </div>`
                : null}
            </div>`
        : html`<div class="project-checkouts" aria-label=${`${project.label} working directory`}>
            ${checkouts.map((checkout) => checkoutRow(project, checkout, allCheckouts, onPick))}
          </div>`}
      ${missingCount > 0
        ? html`<div class="project-missing-count faint" title="Registrations whose directory no longer exists. Nothing is deleted automatically.">
            ${missingCount} ${MISSING_LABEL} · prune with <code>${PRUNE_VERB}</code>
          </div>`
        : null}
      ${unclassified && showClassify ? html`<${ClassifyControl} project=${project} onReload=${onReload} />` : null}
    </div>
  `;
}

// FG-745 (AC1/AC2/AC6): when the API carries a durable owner or retention reason on a
// record, describe that relationship in-place so a Forge artifact is reachable/described
// from its owning project. The owner is STRUCTURED data from /api/projects (never
// inferred client-side); an operator project with no owner renders nothing here.
function projectOwnerLine(project) {
  const owner = project.owner;
  const ownerRef = owner && (owner.projectIdentity || owner.runId || owner.taskId);
  if (!ownerRef && !project.retentionReason) return null;
  const parts = [];
  if (ownerRef) parts.push(`owned by ${owner.projectIdentity || owner.runId || owner.taskId}`);
  if (owner && owner.runId && owner.projectIdentity) parts.push(`run ${owner.runId}`);
  if (project.retentionReason) parts.push(`retained: ${project.retentionReason}`);
  return html`<div class="project-owner faint" title="Recorded workspace ownership / retention (from /api/projects)">${parts.join(" · ")}</div>`;
}

// FG-745 (AC8): the operator classify/repair affordance for an `unclassified` record.
// It POSTs to /api/projects/classify — the bounded, atomic, REFUSE-on-conflict claim
// (it only records a purpose row; it never deletes a workspace or rewrites a run).
// Choosing an artifact kind suppresses the card on the next reload; choosing "operator"
// keeps it as a first-class project and clears the unclassified flag. A conflict (409)
// or any other refusal is surfaced verbatim, never swallowed into a silent reload.
const CLASSIFY_OPTIONS = [
  { value: "operator", label: "Operator project" },
  { value: "disposable_clone", label: "Disposable clone (artifact)" },
  { value: "worktree", label: "Worktree (artifact)" },
  { value: "evidence_fixture", label: "Evidence fixture (artifact)" },
];

// The single classify write path. Both the full ClassifyControl form and the card's
// one-click "This is my project" operator claim (FG-759 #2) POST through here — the
// server-side semantics (bounded, atomic, REFUSE-on-conflict) are unchanged; this is
// only the presentation-side entry point they share.
async function postClassify(dir, purpose) {
  const res = await fetch("/api/projects/classify", {
    method: "POST",
    // The non-simple content type is load-bearing server-side: it is what makes
    // this same-origin mutation legal at all (matches the queue-board fetch).
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir, purpose }),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok && payload && payload.ok) return { ok: true };
  return { ok: false, error: (payload && payload.error) || `Classify failed (${res.status}).` };
}

function ClassifyControl({ project, onReload }) {
  const [purpose, setPurpose] = useState("operator");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  // A successful classify is confirmed IMMEDIATELY here: the Projects list is served
  // from a short-lived server-side cache, so the card itself only re-projects on the
  // next uncached read. The confirmation makes the write's success perceivable now,
  // without the client second-guessing membership (which stays server-derived).
  const [done, setDone] = useState(null);
  // RF-1: a successful classify removes the whole form — including the focused submit
  // button — and renders the status div in its place. Without moving focus, a keyboard
  // operator is stranded on a detached element (focus falls back to <body>). Land focus
  // on the confirmation itself, which is programmatically focusable (tabindex=-1) and
  // carries role="status" so it is announced.
  const doneRef = useRef(null);
  useEffect(() => {
    if (done && doneRef.current) doneRef.current.focus();
  }, [done]);
  const dir = project.primaryCheckout || project.projectDir;
  const stop = (event) => event.stopPropagation();
  const submit = useCallback(
    async (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPending(true);
      setError(null);
      try {
        const result = await postClassify(dir, purpose);
        if (result.ok) {
          setDone(purpose);
          if (onReload) onReload();
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setPending(false);
      }
    },
    [dir, purpose, onReload],
  );

  if (done) {
    const label = (CLASSIFY_OPTIONS.find((opt) => opt.value === done) || { label: done }).label;
    return html`
      <div
        class="project-classify project-classify-done"
        role="status"
        tabindex="-1"
        ref=${doneRef}
        onClick=${stop}
      >
        Reclassified as ${label}. The Projects list refreshes shortly.
      </div>
    `;
  }

  const selectId = `classify-purpose-${project.key}`;
  return html`
    <form class="project-classify" onSubmit=${submit} onClick=${stop}>
      <label class="project-classify-label" for=${selectId}>Classify this workspace</label>
      <div class="project-classify-controls">
        <select
          id=${selectId}
          class="project-classify-select"
          value=${purpose}
          disabled=${pending}
          onChange=${(event) => setPurpose(event.target.value)}
          onClick=${stop}
        >
          ${CLASSIFY_OPTIONS.map((opt) => html`<option key=${opt.value} value=${opt.value}>${opt.label}</option>`)}
        </select>
        <button type="submit" class="project-classify-submit" disabled=${pending}>
          ${pending ? "Classifying…" : "Classify"}
        </button>
      </div>
      ${error ? html`<div class="project-classify-error" role="alert">${error}</div>` : null}
    </form>
  `;
}

// FG-595/FG-831: a card lists its on-disk checkouts, plus any missing one that still
// carries active work or a live session (read `missing on disk` by the shared label
// rule, never "unknown branch"). Every other missing checkout is only COUNTED, next to
// the verb that prunes it — the card never deletes anything itself.
function cardCheckouts(project) {
  const all = dedupeCheckouts(project.checkouts);
  const rows = all.filter((c) => c.exists !== false || c.inFlightCount > 0 || c.liveSessions > 0);
  return { all, rows, missingCount: all.filter((c) => c.exists === false).length };
}

// FG-759 (#1): one working-directory row, shared by the single-dir card and the
// expanded multi-dir disclosure. onPick scopes the activity view to that exact dir.
function checkoutRow(project, checkout, all, onPick) {
  const label = checkoutLabel(checkout, all);
  return html`
    <button
      key=${checkout.projectDir}
      class="project-checkout-row"
      onClick=${(event) => { event.stopPropagation(); onPick(project, checkout.projectDir); }}
      title=${checkout.projectDir}
      aria-label=${`Open ${project.label} checkout ${label}`}
    >
      <span class=${"checkout-branch" + (checkout.exists === false ? " checkout-missing" : "")}>${label}</span>
      <span class="project-path mono faint">${checkout.projectDir}</span>
    </button>
  `;
}

// Visual state for the card. Drives a CSS class for dimming/highlighting.
function projectAgeState(p) {
  if (p.liveSessions > 0) return "live";
  if (!p.lastRunAt) return "idle";
  const ageMs = Date.now() - new Date(p.lastRunAt).getTime();
  const day = 1000 * 60 * 60 * 24;
  if (ageMs < 7 * day) return "active";
  if (ageMs < 30 * day) return "recent";
  if (ageMs < 180 * day) return "idle";
  return "stale";
}

// FG-831: the registry the shared checkout label rule resolves a row's directory against,
// so an Activity row names its checkout exactly as the scope bar does.
const ProjectsContext = createContext([]);

function ProjectChip({ entry }) {
  const projects = useContext(ProjectsContext);
  if (!entry.projectLabel || !entry.projectColor) return null;
  const checkout = entry.projectDir
    ? checkoutLabelForDir(entry.projectDir, projects, entry.checkoutBranch)
    : entry.checkoutBranch || entry.checkoutName;
  return html`
    <span class="project-identity" title=${entry.projectDir ?? ""}>
      <span class="project-chip" style=${{ background: entry.projectColor }}>${entry.projectLabel}</span>
      ${checkout ? html`<span class="checkout-chip">${checkout}</span>` : null}
    </span>
  `;
}

// FG-576 (AC7/AC11) — the project-scoped interactive orchestrator panel.
//
// Each row is a receipt JOINED to the launcher-owned liveness record, so it says
// what policy selected AND whether that session is actually alive. The
// remote-control link is rendered ONLY from `remoteControlUrl` on this scoped
// payload. When the field is absent — off a loopback bind (D13), no URL captured
// yet, or a session this host cannot prove is live — nothing is rendered. Not an
// error, not a placeholder, not a masked value: masking is not a control, and the
// value genuinely is not in the payload to unmask.
function OrchestratorSection({ data, onTaskClick }) {
  const rows = Array.isArray(data?.orchestrators) ? data.orchestrators : [];
  if (rows.length === 0) return null;
  const active = rows.filter((r) => r.running).length;
  return html`
    <section class="in-flight" aria-labelledby="orchestrator-sessions-heading">
      <h2 id="orchestrator-sessions-heading">
        Interactive orchestrators
        <span class="muted mono" style="font-size: 12px; font-weight: 400;">
          ${" "}${active} live${rows.length > active ? ` · ${rows.length - active} not live` : ""}
        </span>
      </h2>
      ${rows.map((r) => html`<${OrchestratorRow} key=${r.receiptId} entry=${r} onTaskClick=${onTaskClick} />`)}
    </section>
  `;
}

const ORCH_BADGE_TITLE = {
  running: "the launcher is provably alive by process identity",
  orphaned: "the launcher is provably gone — this asserts launcher loss only, not that the session exited",
  unverified: "liveness could not be proven from this host, so it is not reported as running",
  pending: "recorded before spawn; no session was ever confirmed under it",
  exited: "the child exited",
  spawn_failed: "the child never started",
  unrecognized: "recorded by a newer forge; reported verbatim rather than reinterpreted",
};

function OrchestratorRow({ entry, onTaskClick }) {
  const orchBadgeClass = statusClass("receipt", entry.presentation);
  // The row opens the task's explain surface when it carries a taskId. Because the row
  // can ALSO contain an independently interactive remote-control link, the open action
  // is a real <button> stretched over the row (orch-row-open) rather than a role=button
  // ON the row: an interactive control nested inside a button is invalid ARIA and makes
  // the link presentational to assistive tech (FG-692 RF-1). The button and the link are
  // DOM siblings; the link paints above the stretched button (orch-remote-control's
  // z-index) so both stay separately focusable, announced, and operable. A row with no
  // taskId stays an inert container (FG-576 RF-2).
  const onClick = entry.taskId ? () => onTaskClick(entry.taskId) : undefined;
  return html`
    <div class=${"item" + (entry.running ? "" : " item-muted") + (onClick ? " orch-row" : "")}>
      ${onClick
        ? html`<button
            type="button"
            class="orch-row-open"
            aria-label=${`Open orchestrator task ${entry.taskId}`}
            onClick=${onClick}
          ></button>`
        : null}
      <span class=${"badge " + orchBadgeClass} title=${ORCH_BADGE_TITLE[entry.presentation] || ""}>${statusLabel("receipt", entry.presentation)}</span>
      <div>
        <div>
          <${ProjectChip} entry=${entry} />
          <strong>${entry.provider}</strong>
          <span class="model-badge">${entry.model || "—"}</span>
          ${entry.remoteControlUrl
            // Borrowing .project-github's external-link pill so this reads like every
            // other outbound link on the surface. The explicit margin is here rather
            // than in the stylesheet because the pill's own margin-left:auto is a
            // flex-container rule and this row is not one.
            ? html`<a
                class="orch-remote-control project-github"
                style="margin-left: 8px;"
                href=${entry.remoteControlUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Open this session's remote control. Anyone with this link can drive the session."
              >remote control ↗</a>`
            : null}
        </div>
        <div class="faint mono" style="font-size: 11px;">
          ${entry.resolvedProfile || "—"} · ${entry.runtime} · ${entry.adapter}
          ${entry.resolvedBy ? ` · via ${entry.resolvedBy}` : ""}
          ${entry.authMode ? ` · auth ${entry.authMode}` : ""}
          ${" · "}${entry.sessionOperation}${entry.sessionTarget ? ` ${entry.sessionTarget}` : ""}
          ${" · identity "}${entry.identityStrength}
          ${" · interaction "}${entry.interaction}
        </div>
        ${(entry.limitations || []).map((l) => html`
          <div key=${l.capability} class="faint mono" style="font-size: 11px;">
            no ${l.capability}: ${l.note}
          </div>
        `)}
      </div>
      <div class="muted mono" style="font-size: 11px;" title=${entry.receiptId}>
        ${entry.startedAt ? formatRelativeTime(entry.startedAt) : "—"}
      </div>
    </div>
  `;
}

// Both Home and Activity have one visible owner for live work: In flight. The compact
// host-verification and CI-check waits are rows here as well. Activity keeps the full
// persisted evidence under an explicit Diagnostics disclosure; it is never a second
// visible activity summary and it never owns agent rows.
function InFlightSection({ inFlight, verifications, phases, now, orchCollapsed, onToggleOrch, onTaskClick, showHeading = true, labelledBy = null, activityLoad = null, onRetryActivity = null, onRefresh = null }) {
  const orchestrators = inFlight.filter((t) => t.agentRole === "orchestrator");
  // FG-819: task rows hold the order first shown until an idle / tab-visibility / Refresh
  // boundary, so the 2s poll cannot reorder them under the operator.
  const pin = usePinnedOrder(inFlight.filter((t) => t.agentRole !== "orchestrator"), (t) => t.taskId);
  const work = pin.items;
  const refresh = () => pin.refresh(onRefresh);
  // FG-576 (AC7): "N orchestrators active" counts LIVENESS, not a DB row. A task
  // row whose receipt says the launcher is gone stops being counted — that row is
  // the phantom this ticket closes, and it is never reconciled away by the docker
  // probe because an interactive orchestrator has no container to probe.
  //
  // A row with NO receipt (`task.orchestrator === null`) is a pre-FG-576 launch and
  // still counts: absence of a receipt is not evidence the session died.
  const activeOrchestrators = orchestrators.filter((t) => !t.orchestrator || t.orchestrator.running);
  const notLiveOrchestrators = orchestrators.length - activeOrchestrators.length;

  // FG-487: /api/review-loop/phases' "reviewing"/"fixing" phase vocabulary,
  // keyed by runId, so a review-loop task row can show it explicitly instead
  // of only agentRole + status.
  const phaseByRunId = new Map((phases || []).map((p) => [p.runId, p.phase]));

  // FG-487: a review-loop's verification / CI-wait window (and a campaign
  // reconcile host-gate exec) can be running with NO task row yet — the loop
  // creates its run row eagerly but the first reviewer/fixer task doesn't
  // land until verification finishes. Render those as their own liveness
  // rows so the run isn't invisible during that window. Skip an entry once a
  // task row for its run has shown up, so it doesn't duplicate.
  //
  // FG-746 (C2): Current Activity shows only genuinely LIVE verification. The
  // server already drops terminal (FG-667) starts via terminal authority; a
  // surviving-but-STALE start is actionable human-attention work, not ordinary
  // in-progress work, so it surfaces in Human Attention instead of here. Keep
  // only the `live` (non-stale) subset — the same split classifyVerification makes.
  const knownRunIds = new Set(inFlight.map((t) => t.runId));
  const standalone = (verifications || [])
    .filter((v) => !v.stale)
    .filter((v) => !v.runId || !knownRunIds.has(v.runId));

  // The waits are live rows too, so `No live tasks.` may not be printed over them.
  const waits = activityLoad ? homeInFlightActivity(activityLoad) : null;
  // FG-731: a registered CI wait is live work too — its mere presence makes the workspace
  // WAITING, never IDLE, so `No live tasks.` may not print over it.
  // FG-734: a live operator wait is a pending human decision — Forge has intentionally
  // stopped, which is WAITING, never IDLE. It counts toward non-idle exactly as a CI wait
  // does, so `No live tasks.` may not print over it (AC7).
  const anyWaits = waits !== null
    && (waits.hostVerification.length > 0 || waits.ci.length > 0 || waits.ciWaits.length > 0
      || waits.operatorWaits.length > 0 || waits.message !== null);

  const nothingLive = work.length === 0 && activeOrchestrators.length === 0 && standalone.length === 0 && !anyWaits;

  return html`
    <section class="in-flight" aria-labelledby=${labelledBy || undefined} ...${pin.activityProps}>
      ${showHeading ? html`<h2>In flight</h2>` : null}
      ${work.length > 1
        ? html`<div class="pin-toolbar"><${PinRefreshButton} label="Refresh and re-sort in-flight tasks" onClick=${refresh} /></div>`
        : null}
      ${orchestrators.length > 0 ? html`
        <div class="orch-group">
          <div class="orch-header" onClick=${onToggleOrch}>
            <span class="orch-chevron ${orchCollapsed ? "" : "open"}">▸</span>
            <span class="orch-summary">${activeOrchestrators.length} orchestrator${activeOrchestrators.length === 1 ? "" : "s"} active</span>
            ${notLiveOrchestrators > 0
              ? html`<span class="muted mono" style="font-size: 11px;" title="the launcher for these sessions is provably gone; the row is retained as evidence, not counted as active">
                  ${" · "}${notLiveOrchestrators} not live
                </span>`
              : null}
          </div>
          ${!orchCollapsed ? orchestrators.map((t) => html`
            <${InFlightItem} key=${t.taskId} task=${t} muted onClick=${() => onTaskClick(t.taskId)} />
          `) : null}
        </div>
      ` : null}
      ${standalone.map((v) => html`<${VerificationRow} key=${v.attemptId} v=${v} now=${now} />`)}
      ${nothingLive
        ? html`<div class="empty">No live tasks. Polling every ${POLL_MS / 1000}s.</div>`
        : work.length === 0
        ? (standalone.length > 0 ? null : html`<div class="empty">No agent work in flight.</div>`)
        : work.map((t) => html`<${InFlightItem} key=${t.taskId} task=${t} reviewLoopPhase=${phaseByRunId.get(t.runId)} onClick=${() => onTaskClick(t.taskId)} />`)
      }
      ${activityLoad
        ? html`<${InFlightActivityWaits} load=${activityLoad} now=${now} onRetry=${onRetryActivity} />`
        : null}
    </section>
  `;
}

// FG-487: liveness row for a review-loop verification/CI-wait window or a
// campaign reconcile host-gate exec — sourced from GET /api/verifications/in-progress
// (events-derived, attemptId-paired; `stale` means the start's timeout cutoff
// passed with no matching finish, so it's flagged rather than shown as a
// perpetual "in progress"). Shaped to look like an InFlightItem row so it
// reads as part of the same list, not a separate visual language.
function VerificationRow({ v, now }) {
  const startedMs = v.startedAt ? new Date(v.startedAt).getTime() : null;
  const elapsed = startedMs != null ? now - startedMs : null;
  const isGate = v.kind === "campaign_reconcile_gate";
  const badge = verificationRowBadge(v);
  return html`
    <div class="item">
      <span class="badge ${badge.class}" title=${v.stale ? "no finish event observed past the expected timeout — may be stuck or crashed" : "host verification in progress"}>${badge.text}</span>
      <div>
        <div>
          <strong>${v.ticketId ?? "—"}</strong>
          ${v.itemId ? html`<span class="faint"> · ${v.itemId}</span>` : null}
          <span class="faint"> ·</span> <span class="muted">${isGate ? (v.gate ?? v.command ?? "reconcile gate") : "review-loop"}</span>
        </div>
        <div class="faint mono" style="font-size: 11px;">${v.sha ? shortSha(v.sha) : ""}${v.runId ? ` · run ${v.runId}` : ""}${v.command ? ` · ${v.command}` : ""}</div>
      </div>
      <div class="muted mono" style="font-size: 11px;" title="time since verification started">${elapsed != null ? html`⏱ ${formatDuration(elapsed)}` : formatRelativeTime(v.startedAt)}</div>
    </div>
  `;
}

function InFlightItem({ task, reviewLoopPhase, onClick, muted }) {
  // #290: a running task whose container is gone is a reconcile candidate, not
  // ordinary live work — badge it distinctly so the dashboard stops showing
  // stale `running`. The title carries the reason + the read-only nature.
  const reconcileTitle = task.reconcile
    ? (task.reconcile.reason === "container_gone_result_present"
        ? "container gone, valid result exists — finished but unreconciled. Run forge show/status/next to finalize."
        : "container gone, no result — orphaned. Run forge show/status/next to finalize.")
    : null;
  // FG-487: once a review-loop round's reviewer/fixer task starts, label its
  // badge with the same "reviewing"/"fixing" phase vocabulary AC1 requires,
  // sourced from GET /api/review-loop/phases — rather than leaving it to the
  // generic status text ("running").
  return html`
    <div class=${"item" + (muted ? " item-muted" : "")} onClick=${onClick}>
      ${task.orchestrator && !task.orchestrator.running
        // FG-576 (AC7): the task row still says `running`, but the launcher-owned
        // liveness record says otherwise, and the record is what decides. Badge the
        // joined answer rather than the stale status.
        ? html`<span
            class=${badgeClass("receipt", task.orchestrator.presentation)}
            title=${ORCH_BADGE_TITLE[task.orchestrator.presentation] || ""}
          >${statusLabel("receipt", task.orchestrator.presentation)}</span>`
        : task.reconcile
        ? html`<span class=${badgeClass("marker", "reconcile_candidate")} title=${reconcileTitle}>${statusLabel("marker", "reconcile_candidate")}</span>`
        : reviewLoopPhase
        ? html`<span class=${badgeClass("task", task.status)} title=${"review-loop phase: " + reviewLoopPhase}>${reviewLoopPhase}</span>`
        : html`<span class=${badgeClass("task", task.status)}>${statusLabel("task", task.status)}</span>`}
      <div>
        <div>
          <${ProjectChip} entry=${task} />
          <a class="task-link role-name" href=${hashFor({ view: "task", id: task.taskId })} onClick=${(e) => e.stopPropagation()}><${RoleTile} role=${task.agentRole} /><strong>${task.agentRole}</strong></a>
          <${ModelBadge} entry=${task} />
          <span class="faint"> ·</span> <span class="muted">${task.runTitle}</span>
        </div>
        <div class="faint mono" style="font-size: 11px;">
          ${task.phase} · ${task.taskId}
          <${CopyIdButton} value=${task.taskId} />
        </div>
      </div>
      <div class="muted mono" style="font-size: 11px;" title="run-time so far">${task.startedAt ? html`⏱ ${formatDuration(Date.now() - new Date(task.startedAt).getTime())}` : formatRelativeTime(task.startedAt)}</div>
    </div>
  `;
}

function FeedCard({ entry, onClick }) {
  return html`
    <div class="card" onClick=${onClick}>
      <div class="head">
        <div>
          <${ProjectChip} entry=${entry} />
          <a class="agent task-link role-name" href=${hashFor({ view: "task", id: entry.taskId })} onClick=${(e) => e.stopPropagation()}><${RoleTile} role=${entry.agentRole} />${entry.agentRole}</a>
          <${ModelBadge} entry=${entry} />
          <span class="faint"> · </span>
          <span class="context">${entry.runTitle}</span>
        </div>
        <div class="row">
          <a
            class="rm-open-btn"
            title="open the run"
            href=${hashFor({ view: "run", id: entry.runId })}
            onClick=${(e) => e.stopPropagation()}
          >run</a>
          <span class=${badgeClass("task", entry.status)}>${statusLabel("task", entry.status)}</span>
          ${entry.durationMs != null ? html`<span class="muted mono" style="font-size: 11px;" title="run-time (started → completed)">⏱ ${formatDuration(entry.durationMs)}</span>` : null}
          <span class="muted mono" style="font-size: 11px;">${formatRelativeTime(entry.completedAt)}</span>
        </div>
      </div>
      <div class="context faint mono" style="font-size: 11px; margin-bottom: 8px;">
        ${entry.workflow} · ${entry.phase} · ${entry.taskId}
        <${CopyIdButton} value=${entry.taskId} />
      </div>
      ${renderPreview(entry)}
    </div>
  `;
}

function renderPreview(entry) {
  const r = entry.result;
  if (!r || typeof r !== "object") {
    return html`<div class="preview muted">(no result)</div>`;
  }
  let text;
  if (entry.agentRole === "architecture-advisor") {
    const counts = [];
    if (Array.isArray(r.risks)) counts.push(`${r.risks.length} risk${r.risks.length === 1 ? "" : "s"}`);
    if (Array.isArray(r.constraints)) counts.push(`${r.constraints.length} constraint${r.constraints.length === 1 ? "" : "s"}`);
    if (Array.isArray(r.boundaries)) counts.push(`${r.boundaries.length} boundar${r.boundaries.length === 1 ? "y" : "ies"}`);
    if (Array.isArray(r.openQuestions) && r.openQuestions.length > 0) counts.push(`${r.openQuestions.length} open question${r.openQuestions.length === 1 ? "" : "s"}`);
    text = counts.length > 0 ? counts.join(" · ") : (r.notes ?? "");
  } else if (entry.agentRole === "tech-lead" && Array.isArray(r.steps)) {
    text = `${r.steps.length} plan step${r.steps.length === 1 ? "" : "s"}${r.steps[0] ? `: ${(r.steps[0].summary ?? "").slice(0, 200)}` : ""}`;
  } else if (entry.agentRole === "qa-engineer") {
    const tp = r.tests_passed ?? 0;
    const tf = r.tests_failed ?? 0;
    text = `${tp + tf} test${tp + tf === 1 ? "" : "s"} run · ${tp} passed · ${tf} failed${r.evidence ? ` — ${(r.evidence ?? "").slice(0, 200)}` : ""}`;
  } else if (entry.agentRole.startsWith("red-")) {
    const findings = Array.isArray(r.findings) ? r.findings.length : 0;
    text = `verdict: ${r.verdict ?? "?"} (confidence ${typeof r.confidence === "number" ? r.confidence.toFixed(2) : "?"})${findings > 0 ? ` · ${findings} finding${findings === 1 ? "" : "s"}` : ""}`;
  } else {
    text = r.diff_summary ?? r.summary ?? r.notes ?? JSON.stringify(r).slice(0, 400);
  }
  return html`<div class="preview">${text.toString().slice(0, 400)}</div>`;
}

render(h(App), document.getElementById("app"));
