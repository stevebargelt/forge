// forge-dashboard client. Preact + htm; no build step. Polls every 2s.

import { h, render } from "preact";
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import { renderResultByAgent, md } from "./renderers.js";
import { UsageView } from "./usage.js";
import { UsageLimits } from "./usage-limits.js";
import { GovernanceView } from "./governance.js";
import { BacklogView } from "./backlog.js";
import { ReviewsView } from "./reviews.js";
import { initialView, hashForView } from "./view-routing.js";
import {
  eventBadgeClass, eventBadgeText, reviewLoopVerificationDetail, hostGateDetail,
  groupVerificationRows, verificationRowBadge, evidenceState,
} from "./verification-render.js";
import {
  launchBadge, launchAssociationLabel, launchIdentityLine,
  ciSectionLabel, ciBadgeClass, ciBadgeText, ciContextRows, activityIsEmpty,
} from "./current-activity-render.js";

const html = htm.bind(h);
const POLL_MS = 2000;
const USAGE_POLL_MS = 30000;
// Sentinel for the runtime chart's default "All agents" series. Not a role, so
// it can never collide with a real agent_role coming back from the API.
const RUNTIME_ALL_ROLES = "__all__";

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
  // Top-level view toggle. Home is the default landing view; Activity retains
  // the full recent-output feed and its project filtering behavior.
  const [view, setView] = useState(() => initialView(window.location.hash));
  // When set, both /api/feed and /api/in-flight are filtered to this project.
  // Clicking a project card sets this AND switches to activity view.
  const [projectFilter, setProjectFilter] = useState(null);
  const [checkoutFilter, setCheckoutFilter] = useState(null);
  const [feed, setFeed] = useState([]);
  const [inFlight, setInFlight] = useState([]);
  const [projects, setProjects] = useState([]);
  const [orchCollapsed, setOrchCollapsed] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
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
  const [ops, setOps] = useState(null);
  const [opsSince, setOpsSince] = useState("30d");
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [runtimeWindow, setRuntimeWindow] = useState("7d");
  const [runtimeRole, setRuntimeRole] = useState(RUNTIME_ALL_ROLES);
  // Sequence token for the runtime read. The server cost varies sharply by
  // window, so a slower earlier request can resolve after a faster later one;
  // only the newest request may write the series it belongs to.
  const runtimeSeq = useRef(0);
  const [governance, setGovernance] = useState(null);
  const [backlog, setBacklog] = useState(null);
  const [reviews, setReviews] = useState(null);
  // FG-487: review-loop verification / CI-wait windows and campaign reconcile
  // host-gate execs, in progress right now — polled alongside feed/in-flight
  // so a launched loop is visible before any task row exists for it.
  const [inProgressVerifications, setInProgressVerifications] = useState([]);
  const [reviewLoopPhases, setReviewLoopPhases] = useState([]);
  const [verifyTicketId, setVerifyTicketId] = useState("");
  const [verifyItemId, setVerifyItemId] = useState("");
  const [verifyEvidence, setVerifyEvidence] = useState(null);
  const [verifyRecent, setVerifyRecent] = useState([]);
  // FG-679: the three-section Current activity projection. Read-only, and read from
  // PERSISTED state only — the server makes no outbound call to answer it.
  const [activity, setActivity] = useState(null);

  const poll = useCallback(async () => {
    try {
      const q = projectScopeQuery(projectFilter, checkoutFilter);
      const reqs = [
        view === "activity" ? fetch(`/api/feed${q ? q + "&limit=100" : "?limit=100"}`) : Promise.resolve(null),
        fetch(`/api/in-flight${q}`),
        fetch(`/api/verifications/in-progress${q}`),
        fetch(`/api/review-loop/phases${q}`),
        fetch(`/api/current-activity${q}`),
      ];
      // Only poll /api/projects on the projects view (or first load) — saves a
      // filesystem scan every 2s once the registry is populated.
      if (view === "projects" || projects.length === 0) reqs.push(fetch("/api/projects"));
      const [feedRes, ifRes, ivRes, phasesRes, activityRes, projRes] = await Promise.all(reqs);
      if (feedRes?.ok) setFeed(await feedRes.json());
      if (ifRes.ok) setInFlight(await ifRes.json());
      if (ivRes && ivRes.ok) setInProgressVerifications(await ivRes.json());
      if (phasesRes && phasesRes.ok) setReviewLoopPhases(await phasesRes.json());
      if (activityRes && activityRes.ok) setActivity(await activityRes.json());
      if (projRes && projRes.ok) setProjects(await projRes.json());
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [view, projectFilter, checkoutFilter, projects.length]);

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
        fetch(appendScope(`/api/usage?groupBy=${usageGroupBy}&since=${usageSince}`, projectFilter, checkoutFilter)),
        fetch(appendScope(`/api/usage/timeseries?since=${tsDays}d`, projectFilter, checkoutFilter)),
        fetch(appendScope(`/api/usage/model-mix?groupBy=${usageGroupBy}&since=${usageSince}`, projectFilter, checkoutFilter)),
      ]);
      if (rollupRes.ok) setUsageRollup(await rollupRes.json());
      if (tsRes.ok) setUsageTimeSeries(await tsRes.json());
      if (mixRes.ok) setUsageModelMix(await mixRes.json());
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [usageGroupBy, usageSince, projectFilter, checkoutFilter]);

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

  useEffect(() => {
    const revealActiveTab = () => {
      document.querySelector(".view-tabs .tab-active")?.scrollIntoView({ block: "nearest", inline: "center" });
    };
    revealActiveTab();
    window.addEventListener("resize", revealActiveTab);
    return () => window.removeEventListener("resize", revealActiveTab);
  }, [view]);

  const pollOps = useCallback(async () => {
    try {
      const res = await fetch(appendScope(`/api/ops?since=${opsSince}`, projectFilter, checkoutFilter));
      if (res.ok) setOps(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [opsSince, projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "home" && view !== "ops") return;
    pollOps();
    const id = setInterval(pollOps, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollOps, view]);

  const pollRuntime = useCallback(async () => {
    const seq = (runtimeSeq.current += 1);
    try {
      const res = await fetch(appendScope(`/api/agent-runtime?window=${runtimeWindow}`, projectFilter, checkoutFilter));
      if (seq !== runtimeSeq.current) return;
      if (!res.ok) {
        setRuntimeError(`agent runtime unavailable — HTTP ${res.status}`);
      } else {
        setRuntime(await res.json());
        setRuntimeError(null);
      }
      setNow(Date.now());
    } catch (e) {
      if (seq !== runtimeSeq.current) return;
      setRuntimeError(String(e));
      setError(String(e));
    }
  }, [runtimeWindow, projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "ops") return;
    pollRuntime();
    const id = setInterval(pollRuntime, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollRuntime, view]);

  // Drop the stale series on a window change so the chart shows its loading
  // state rather than a grid that silently belongs to the previous window. The
  // seq bump retires whatever is still in flight for the window being left.
  const changeRuntimeWindow = (next) => {
    runtimeSeq.current += 1;
    setRuntime(null);
    setRuntimeError(null);
    setRuntimeWindow(next);
  };

  const pollGovernance = useCallback(async () => {
    if (projectFilter && !checkoutFilter) { setGovernance(null); return; }
    try {
      const q = projectScopeQuery(projectFilter, checkoutFilter);
      const res = await fetch(`/api/governance${q}`);
      if (res.ok) setGovernance(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "governance") return;
    pollGovernance();
    const id = setInterval(pollGovernance, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollGovernance, view]);

  const pollReviews = useCallback(async () => {
    try {
      const res = await fetch(appendScope(`/api/reviews?limit=25`, projectFilter, checkoutFilter));
      if (res.ok) setReviews(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "reviews") return;
    pollReviews();
    const id = setInterval(pollReviews, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollReviews, view]);

  const pollBacklog = useCallback(async () => {
    if (!projectFilter) { setBacklog(null); return; }
    try {
      const q = projectScopeQuery(projectFilter, checkoutFilter);
      const res = await fetch(`/api/backlog${q}`);
      if (res.ok) setBacklog(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "backlog") return;
    pollBacklog();
    const id = setInterval(pollBacklog, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollBacklog, view]);

  const pollVerifyRecent = useCallback(async () => {
    try {
      const res = await fetch(appendScope(`/api/host-verifications/recent?limit=50`, projectFilter, checkoutFilter));
      if (res.ok) setVerifyRecent(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter, checkoutFilter]);

  useEffect(() => {
    if (view !== "verify") return;
    pollVerifyRecent();
    const id = setInterval(pollVerifyRecent, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollVerifyRecent, view]);

  // Evidence lookup is user-driven (ticket/campaign-item id), not polled —
  // triggered by the "look up" button in VerificationsView.
  const lookupEvidence = useCallback(async () => {
    const params = new URLSearchParams();
    if (verifyTicketId.trim()) params.set("ticketId", verifyTicketId.trim());
    if (verifyItemId.trim()) params.set("itemId", verifyItemId.trim());
    if (projectFilter) {
      if (checkoutFilter) params.set("projectDir", checkoutFilter);
      else params.set("projectKey", projectFilter.key);
    }
    if (!params.toString()) { setVerifyEvidence(null); return; }
    try {
      const res = await fetch(`/api/host-verifications?${params.toString()}`);
      setVerifyEvidence(res.ok ? await res.json() : []);
    } catch (e) { setError(String(e)); }
  }, [verifyTicketId, verifyItemId, projectFilter, checkoutFilter]);

  useEffect(() => {
    const onHash = () => setView(initialView(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const switchView = (next) => {
    setView(next);
    window.location.hash = hashForView(next);
  };

  const filterByProject = (project, checkoutDir = null) => {
    setProjectFilter(project);
    setCheckoutFilter(checkoutDir);
    switchView("activity");
  };

  const clearProjectFilter = () => {
    setProjectFilter(null);
    setCheckoutFilter(null);
  };

  return html`
    <div class="app">
      <header class="topbar">
        <h1>
          <img src="/client/logo-mark.svg" width="32" height="32" class="brand-mark" alt="forge" />
          <nav class="view-tabs">
            <button class=${"tab " + (view === "home" ? "tab-active" : "")} onClick=${() => switchView("home")}>home</button>
            <button class=${"tab " + (view === "activity" ? "tab-active" : "")} onClick=${() => switchView("activity")}>activity</button>
            <button class=${"tab " + (view === "projects" ? "tab-active" : "")} onClick=${() => switchView("projects")}>projects</button>
            <button class=${"tab " + (view === "verify" ? "tab-active" : "")} onClick=${() => switchView("verify")}>verification</button>
            <button class=${"tab " + (view === "usage" ? "tab-active" : "")} onClick=${() => switchView("usage")}>usage</button>
            <button class=${"tab " + (view === "ops" ? "tab-active" : "")} onClick=${() => switchView("ops")}>ops</button>
            <button class=${"tab " + (view === "governance" ? "tab-active" : "")} onClick=${() => switchView("governance")}>workbench</button>
            <button class=${"tab " + (view === "backlog" ? "tab-active" : "")} onClick=${() => switchView("backlog")}>backlog</button>
            <button class=${"tab " + (view === "reviews" ? "tab-active" : "")} onClick=${() => switchView("reviews")}>reviews</button>
          </nav>
        </h1>
        <div class="muted mono">${new Date(now).toLocaleTimeString()}</div>
      </header>

      ${error ? html`<div class="card" style="color: var(--err);">Error: ${error}</div>` : null}

      ${projectFilter && view !== "projects" ? html`
        <div class="filter-banner project-scope-banner">
          <span>Filtered to <strong>${projectFilter.label}</strong></span>
          <div class="project-scope-options" aria-label="Project checkout scope">
            <button
              class=${"checkout-scope-btn" + (!checkoutFilter ? " checkout-scope-btn-active" : "")}
              onClick=${() => setCheckoutFilter(null)}
              aria-pressed=${!checkoutFilter}
            >all checkouts</button>
            ${(projectFilter.checkouts || []).map((checkout) => html`
              <button
                key=${checkout.projectDir}
                class=${"checkout-scope-btn" + (checkoutFilter === checkout.projectDir ? " checkout-scope-btn-active" : "")}
                onClick=${() => setCheckoutFilter(checkout.projectDir)}
                aria-pressed=${checkoutFilter === checkout.projectDir}
                title=${checkout.projectDir}
              >${checkoutScopeLabel(checkout)}</button>
            `)}
          </div>
          <button class="clear-filter" onClick=${clearProjectFilter}>clear ×</button>
        </div>
      ` : null}

      ${view === "home"
        ? html`<${HomeView}
            planUsage=${planUsage}
            planUsageLoading=${planUsageLoading}
            planUsageRefreshing=${planUsageRefreshing}
            planUsageRefreshError=${planUsageRefreshError}
            onRefreshPlanUsage=${refreshPlanUsage}
            inFlight=${inFlight}
            verifications=${inProgressVerifications}
            phases=${reviewLoopPhases}
            activity=${activity}
            now=${now}
            orchCollapsed=${orchCollapsed}
            onToggleOrch=${() => setOrchCollapsed((c) => !c)}
            onTaskClick=${(id) => setSelectedTaskId(id)}
            ops=${ops}
            opsSince=${opsSince}
          />`
        : view === "projects"
        ? html`<${ProjectsView} projects=${projects} onPick=${filterByProject} />`
        : view === "governance"
        ? projectFilter && !checkoutFilter
          ? html`<div class="card muted" style="margin-top: 20px;">Routing governance is checkout-specific. Select a checkout above; Forge will not substitute an arbitrary clone.</div>`
          : html`<${GovernanceView} data=${governance} />`
        : view === "backlog"
        ? html`<${BacklogView} data=${backlog} projectFilter=${projectFilter} />`
        : view === "reviews"
        ? html`<${ReviewsView} data=${reviews} />`
        : view === "verify"
        ? html`<${VerificationsView}
            inProgress=${inProgressVerifications}
            recent=${verifyRecent}
            ticketId=${verifyTicketId}
            itemId=${verifyItemId}
            onTicketIdChange=${setVerifyTicketId}
            onItemIdChange=${setVerifyItemId}
            onLookup=${lookupEvidence}
            evidence=${verifyEvidence}
            now=${now}
          />`
        : view === "ops"
        ? html`<${OpsView}
            data=${ops}
            since=${opsSince}
            onSinceChange=${setOpsSince}
            runtime=${runtime}
            runtimeError=${runtimeError}
            runtimeWindow=${runtimeWindow}
            onRuntimeWindowChange=${changeRuntimeWindow}
            runtimeRole=${runtimeRole}
            onRuntimeRoleChange=${setRuntimeRole}
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
          <${CurrentActivitySection} activity=${activity} now=${now} onTaskClick=${(id) => setSelectedTaskId(id)} />

          <${InFlightSection}
            inFlight=${inFlight}
            verifications=${inProgressVerifications}
            phases=${reviewLoopPhases}
            now=${now}
            orchCollapsed=${orchCollapsed}
            onToggleOrch=${() => setOrchCollapsed((c) => !c)}
            onTaskClick=${(id) => setSelectedTaskId(id)}
          />

          <section class="feed">
            <h2>Recent agent outputs</h2>
            ${feed.length === 0
              ? html`<div class="muted">No completed agent outputs yet.</div>`
              : feed.map((e) => html`<${FeedCard} key=${e.taskId} entry=${e} onClick=${() => setSelectedTaskId(e.taskId)} />`)
            }
          </section>
        `
      }

      ${selectedTaskId ? html`<${TaskDetail} taskId=${selectedTaskId} onClose=${() => setSelectedTaskId(null)} />` : null}
    </div>
  `;
}

function HomeView({ planUsage, planUsageLoading, planUsageRefreshing, planUsageRefreshError, onRefreshPlanUsage, inFlight, verifications, phases, activity, now, orchCollapsed, onToggleOrch, onTaskClick, ops, opsSince }) {
  return html`
    <section class="home-view" aria-label="Dashboard home">
      <${UsageLimits}
        data=${planUsage}
        loading=${planUsageLoading}
        refreshing=${planUsageRefreshing}
        refreshError=${planUsageRefreshError}
        onRefresh=${onRefreshPlanUsage}
      />
      <${CurrentActivitySection} activity=${activity} now=${now} onTaskClick=${onTaskClick} />
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
        <${OpsSummary} data=${ops} />
      </section>
    </section>
  `;
}

function OpsSummary({ data }) {
  if (!data) return html`<div class="muted">loading metrics…</div>`;
  const pct = (data.runs.successRate * 100).toFixed(0);
  return html`
    <div class="row" style="gap: 16px; flex-wrap: wrap; margin-bottom: 20px;">
      <div class="card stat"><div class="stat-num">${pct}%</div><div class="muted">success rate (of ${data.runs.terminal} terminal)</div></div>
      <div class="card stat"><div class="stat-num">${data.runs.total}</div><div class="muted">runs (${data.runs.clean} clean · ${data.runs.withFailures} w/ failures${data.runs.active ? ` · ${data.runs.active} active` : ""})</div></div>
      <div class="card stat"><div class="stat-num">${data.taskCount}</div><div class="muted">tasks</div></div>
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
function OpsView({ data, since, onSinceChange, runtime, runtimeError, runtimeWindow, onRuntimeWindowChange, runtimeRole, onRuntimeRoleChange }) {
  const trends = html`<${AgentRuntimeTrends}
    data=${runtime}
    error=${runtimeError}
    window=${runtimeWindow}
    onWindowChange=${onRuntimeWindowChange}
    role=${runtimeRole}
    onRoleChange=${onRuntimeRoleChange}
  />`;
  if (!data) return html`<section class="ops-view"><div class="muted">loading metrics…</div>${trends}</section>`;
  const maxKind = Math.max(1, ...data.failureKinds.map((k) => k.count));
  return html`
    <section class="ops-view">
      <div class="row" style="gap: 8px; margin-bottom: 16px;">
        <span class="muted">window:</span>
        ${["7d", "30d", "all"].map((w) => html`
          <button
            key=${w}
            type="button"
            class=${"usage-dim-btn " + (since === w ? "usage-dim-btn-active" : "")}
            aria-pressed=${since === w}
            onClick=${() => onSinceChange(w)}
          >${w}</button>
        `)}
      </div>

      <${OpsSummary} data=${data} />

      ${trends}

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
const RUNTIME_WINDOWS = ["1d", "7d", "30d", "90d", "all"];
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

function AgentRuntimeTrends({ data, error, window, onWindowChange, role, onRoleChange }) {
  const [tzMode, setTzMode] = useState("local");
  const zone = runtimeZoneFor(tzMode);
  const roles = data ? data.roleSummary.map((r) => r.role) : [];
  const roleObserved = role === RUNTIME_ALL_ROLES || roles.includes(role);
  // The fallback to "All agents" is written back, not just displayed. Left in
  // state, the unobserved role would silently re-chart itself on the next window
  // change — and re-picking "All agents" in the select fires no change event,
  // because the select already shows it.
  useEffect(() => {
    if (data && !roleObserved) onRoleChange(RUNTIME_ALL_ROLES);
  }, [data, roleObserved, onRoleChange]);

  const controls = html`
    <div class="runtime-controls">
      <span class="muted" id="runtime-window-label">runtime window:</span>
      <div class="runtime-window-btns" role="group" aria-labelledby="runtime-window-label">
        ${RUNTIME_WINDOWS.map((w) => html`
          <button
            key=${w}
            type="button"
            class=${"usage-dim-btn " + (window === w ? "usage-dim-btn-active" : "")}
            aria-pressed=${window === w}
            onClick=${() => onWindowChange(w)}
          >${w}</button>
        `)}
      </div>
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
  // be stale, beside the chart still showing them.
  const staleNotice = data && error ? html`
    <div class="card runtime-stale" role="alert">
      ${error}. Showing the last successful read — these numbers are stale. Retrying every 30s.
    </div>
  ` : null;

  const frame = (body) => html`
    <section class="runtime-view" aria-labelledby="runtime-heading">
      <h2 id="runtime-heading">Average agent runtime over time</h2>
      ${controls}
      ${staleNotice}
      ${body}
    </section>
  `;

  if (!data) {
    return frame(error
      ? html`<div class="card runtime-error" role="alert">${error}. Retrying every 30s.</div>`
      : html`<div class="card muted runtime-loading" role="status">loading agent runtime…</div>`);
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
      <span class="muted runtime-sample-note">${samples} ${samples === 1 ? "run" : "runs"} in ${window}</span>
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
      window=${window}
      bucketMs=${data.bucketMs}
      zone=${zone}
      mode=${tzMode}
    />
    <${RuntimeRoleTable} summary=${data.roleSummary} activeRole=${activeRole} onRoleChange=${onRoleChange} window=${window} />
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

function ProjectsView({ projects, onPick }) {
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
      ${projects.map((p) => html`<${ProjectCard} key=${p.key} project=${p} onPick=${onPick} />`)}
    </section>
  `;
}

function ProjectCard({ project, onPick }) {
  const ageState = projectAgeState(project);
  const onClick = () => onPick(project, null);
  const onKey = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };
  return html`
    <div class=${"project-card state-" + ageState} onClick=${onClick} onKeyDown=${onKey} role="button" tabIndex="0" aria-label=${`Open all ${project.label} checkouts`}>
      <div class="project-card-head">
        <span class="project-chip" style=${{ background: project.color }}>${project.label}</span>
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
      ${project.description ? html`<div class="project-desc">${project.description}</div>` : null}
      ${!project.description && project.readmeFirstLine ? html`<div class="project-desc faint">${project.readmeFirstLine}</div>` : null}
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
      <div class="project-checkouts" aria-label=${`${project.label} checkouts`}>
        ${(project.checkouts || []).map((checkout) => html`
          <button
            key=${checkout.projectDir}
            class="project-checkout-row"
            onClick=${(event) => { event.stopPropagation(); onPick(project, checkout.projectDir); }}
            title=${checkout.projectDir}
            aria-label=${`Open ${project.label} checkout ${checkoutLabel(checkout)}`}
          >
            <span class=${"checkout-branch" + (checkout.exists === false ? " checkout-missing" : "")}>${checkoutLabel(checkout)}</span>
            <span class="project-path mono faint">${checkout.projectDir}</span>
          </button>
        `)}
      </div>
    </div>
  `;
}

// FG-595: a checkout that survived suppression because it still has active work
// or a live session but is gone from disk (exists===false) must read truthfully,
// not as an "unknown branch". Present checkouts keep their branch (or the honest
// "unknown branch" when git reported none).
function checkoutLabel(checkout) {
  if (checkout.exists === false) {
    return checkout.branch ? `${checkout.branch} (missing)` : "missing / unavailable";
  }
  return checkout.branch || "unknown branch";
}

function checkoutScopeLabel(checkout) {
  if (checkout.exists === false) {
    return (checkout.branch || checkout.projectDir.split("/").pop()) + " (missing)";
  }
  return checkout.branch || checkout.projectDir.split("/").pop();
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

function ProjectChip({ entry }) {
  if (!entry.projectLabel || !entry.projectColor) return null;
  return html`
    <span class="project-identity" title=${entry.projectDir ?? ""}>
      <span class="project-chip" style=${{ background: entry.projectColor }}>${entry.projectLabel}</span>
      ${entry.checkoutBranch || entry.checkoutName ? html`<span class="checkout-chip">${entry.checkoutBranch || entry.checkoutName}</span>` : null}
    </span>
  `;
}

// FG-679 (BD-1): ONE `Current activity` surface with three DISTINCT sections.
//
// Host verification is NEVER represented as an agent task, and a pending required
// check is never represented as either — the sections are disjoint by construction
// because the server derives them disjointly. The surface answers the operator's
// actual question at a glance ("is something happening, or is this stuck?"), which
// a task-only projection structurally cannot: a run whose only work in flight is a
// `forge launch run` verification has no task row at all.
//
// READ-ONLY. There is no start, stop, or retry affordance here for a launch or for
// CI, and no host filesystem path is rendered or linked: a launch is addressed by
// its identity.
function CurrentActivitySection({ activity, now, onTaskClick }) {
  const agents = (activity && activity.agents) || [];
  const launches = (activity && activity.hostVerification) || [];
  const unassociated = (activity && activity.unassociated) || [];
  const ci = (activity && activity.requiredCi) || { state: "not_observed", observations: [] };
  const ciEmpty = ciSectionLabel(ci);

  return html`
    <section class="current-activity" aria-labelledby="current-activity-heading">
      <div class="home-section-heading">
        <div>
          <div class="home-section-kicker">Right now</div>
          <h2 id="current-activity-heading">Current activity</h2>
        </div>
        ${activity === null ? html`<span class="muted mono">loading…</span>` : activityIsEmpty(activity) ? html`<span class="muted mono">nothing observed</span>` : null}
      </div>

      <section class="ca-section" aria-labelledby="ca-agents-heading">
        <h3 id="ca-agents-heading" class="ca-heading">Agents</h3>
        ${agents.length === 0
          ? html`<div class="ca-empty">No agent task in flight.</div>`
          : agents.map((a) => html`
            <div class="item ca-row" key=${a.taskId} onClick=${() => onTaskClick && onTaskClick(a.taskId)}>
              <span class="badge status-${a.status}">${a.status.replace(/_/g, " ")}</span>
              <div>
                <div><strong>${a.agentRole}</strong> <span class="faint"> ·</span> <span class="muted">${a.runTitle}</span></div>
                <div class="faint mono" style="font-size: 11px;">${a.phase} · ${a.taskId}${a.projectLabel ? ` · ${a.projectLabel}` : ""}</div>
              </div>
              <div class="muted mono" style="font-size: 11px;">${caElapsed(a.startedAt, now)}</div>
            </div>
          `)}
      </section>

      <section class="ca-section" aria-labelledby="ca-host-heading">
        <h3 id="ca-host-heading" class="ca-heading">Host verification</h3>
        ${launches.length === 0
          ? html`<div class="ca-empty">No host launch observed in flight.</div>`
          : launches.map((l) => html`<${LaunchRow} key=${l.launchId} entry=${l} now=${now} />`)}
      </section>

      <section class="ca-section" aria-labelledby="ca-ci-heading">
        <h3 id="ca-ci-heading" class="ca-heading">Required CI</h3>
        ${ciEmpty
          ? html`<div class="ca-empty ca-ci-empty">${ciEmpty}</div>`
          : ci.observations.map((o) => html`<${RequiredCiRow} key=${o.candidateSha + o.attemptId} observation=${o} />`)}
      </section>

      ${unassociated.length > 0 ? html`
        <section class="ca-section" aria-labelledby="ca-unassoc-heading">
          <h3 id="ca-unassoc-heading" class="ca-heading">Unassociated activity</h3>
          <div class="faint" style="font-size: 11px; padding: 0 14px 6px;">
            Running under no registered project home. Forge will not guess an owner from a launch name, its argv, or its log.
          </div>
          ${unassociated.map((l) => html`<${LaunchRow} key=${l.launchId} entry=${l} now=${now} />`)}
        </section>
      ` : null}
    </section>
  `;
}

// The badge text is the server-rendered `statusLabel` — src/v2/launch.ts's
// `statusLine`, byte for byte. SIGTERM-terminated, a bare signal-range `exited 143`,
// owner-gone and unknown are FOUR DIFFERENT FACTS and none of them is a generic
// `failed` (BD-4); a stale observation reads `unobserved since <t>` and is never
// dressed up as `running` or as terminal (BD-12).
// Elapsed, or an explicit dash. A start time we cannot read — or one that is AHEAD
// of the reader's clock (host/browser skew) — is not an elapsed duration, and
// rendering a negative one would be a small lie in a surface whose whole job is not
// to tell them.
function caElapsed(startedAt, now) {
  if (!startedAt) return "—";
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return html`⏱ ${formatDuration(ms)}`;
}

function LaunchRow({ entry, now }) {
  const badge = launchBadge(entry);
  const assoc = launchAssociationLabel(entry);
  return html`
    <div class="item ca-row ca-launch-row">
      <span class="badge ${badge.class}" title=${`observed ${entry.observedAt}`}>${badge.text}</span>
      <div>
        <div>
          <strong class="mono">${entry.name || entry.launchId}</strong>
          ${assoc ? html`<span class="ca-assoc-badge">${assoc}</span>` : null}
        </div>
        <div class="faint mono" style="font-size: 11px;">${entry.commandLine}</div>
        <div class="faint mono" style="font-size: 11px;">${launchIdentityLine(entry)}</div>
      </div>
      <div class="muted mono" style="font-size: 11px;" title="time since the launch started">
        ${caElapsed(entry.startedAt, now)}
      </div>
    </div>
  `;
}

// BD-5: the EXACT candidate sha, and EVERY required context with its own state, URL
// and observation time. A summary verdict does not satisfy this, so there is no
// summary-only rendering here. BD-6: only the newest observation is ever served, so
// evidence bound to a superseded candidate is simply absent — never carried forward
// and never relabeled.
function RequiredCiRow({ observation }) {
  const rows = ciContextRows(observation);
  return html`
    <div class="item ca-row ca-ci-row">
      <span class="badge ${ciBadgeClass(observation)}">${ciBadgeText(observation)}</span>
      <div>
        <div>
          <span class="muted">candidate</span> <strong class="mono ca-sha">${observation.candidateSha}</strong>
          ${observation.ticketId ? html`<span class="faint"> · ${observation.ticketId}</span>` : null}
        </div>
        ${rows.length === 0
          ? html`<div class="faint mono" style="font-size: 11px;">No required context enumerated at this sha.</div>`
          : html`<div class="ca-ci-contexts">
              ${rows.map((c) => html`
                <div class="ca-ci-context" key=${c.context}>
                  <span class="ca-ctx-name mono">${c.context}</span>
                  <span class="ca-ctx-state ${c.class}">${c.state}</span>
                  ${c.url ? html`<a class="ca-ctx-url" href=${c.url} target="_blank" rel="noreferrer noopener">check</a>` : html`<span class="faint">(no url)</span>`}
                  <span class="faint mono ca-ctx-observed">observed ${c.observedAt}</span>
                </div>
              `)}
            </div>`}
        ${observation.unavailableReason ? html`<div class="faint mono" style="font-size: 11px;">unavailable: ${observation.unavailableReason}</div>` : null}
      </div>
      <div class="muted mono" style="font-size: 11px;">${observation.observedAt}</div>
    </div>
  `;
}

function InFlightSection({ inFlight, verifications, phases, now, orchCollapsed, onToggleOrch, onTaskClick, showHeading = true, labelledBy = null }) {
  const orchestrators = inFlight.filter((t) => t.agentRole === "orchestrator");
  const work = inFlight.filter((t) => t.agentRole !== "orchestrator");

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
  const knownRunIds = new Set(inFlight.map((t) => t.runId));
  const standalone = (verifications || []).filter((v) => !v.runId || !knownRunIds.has(v.runId));

  const nothingLive = work.length === 0 && orchestrators.length === 0 && standalone.length === 0;

  return html`
    <section class="in-flight" aria-labelledby=${labelledBy || undefined}>
      ${showHeading ? html`<h2>In flight</h2>` : null}
      ${orchestrators.length > 0 ? html`
        <div class="orch-group">
          <div class="orch-header" onClick=${onToggleOrch}>
            <span class="orch-chevron ${orchCollapsed ? "" : "open"}">▸</span>
            <span class="orch-summary">${orchestrators.length} orchestrator${orchestrators.length === 1 ? "" : "s"} active</span>
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
        <div class="faint mono" style="font-size: 11px;">${v.sha ? v.sha.slice(0, 12) : ""}${v.runId ? ` · run ${v.runId}` : ""}${v.command ? ` · ${v.command}` : ""}</div>
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
      ${task.reconcile
        ? html`<span class="badge status-reconcile_candidate" title=${reconcileTitle}>reconcile candidate</span>`
        : reviewLoopPhase
        ? html`<span class="badge status-${task.status}" title=${"review-loop phase: " + reviewLoopPhase}>${reviewLoopPhase}</span>`
        : html`<span class="badge status-${task.status}">${task.status.replace(/_/g, " ")}</span>`}
      <div>
        <div>
          <${ProjectChip} entry=${task} />
          <strong>${task.agentRole}</strong>
          ${task.agentModel ? html`<span class="model-badge">${task.agentModel}</span>` : null}
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
          <span class="agent">${entry.agentRole}</span>
          ${entry.agentModel ? html`<span class="model-badge">${entry.agentModel}</span>` : null}
          <span class="faint"> · </span>
          <span class="context">${entry.runTitle}</span>
        </div>
        <div class="row">
          <span class="badge status-${entry.status}">${entry.status.replace(/_/g, " ")}</span>
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

// Copies a value (e.g. a task id) to the clipboard. Falls back to a hidden
// textarea + execCommand for non-secure contexts; localhost is secure so the
// clipboard API path is the norm. stopPropagation so clicking it inside a
// clickable row/overlay doesn't also trigger the row.
function CopyIdButton({ value }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* best effort */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [value]);
  return html`<button
    class="copy-id ${copied ? "copied" : ""}"
    title="Copy task id"
    aria-label=${`Copy task id ${value}`}
    onClick=${onCopy}
  >${copied ? "copied!" : "copy id"}</button>`;
}

function TaskDetail({ taskId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/task/${encodeURIComponent(taskId)}`);
        if (!res.ok) { if (!cancelled) setErr("not found"); return; }
        const d = await res.json();
        if (cancelled) return;
        setDetail(d);
        // WALK-5: poll while the task is running so the timeline + idle
        // countdown stay live; stop once it reaches a terminal state.
        if (d.task && d.task.status === "running") timer = setTimeout(load, 3000);
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [taskId]);

  if (!detail) {
    return html`
      <div class="detail-overlay" onClick=${onClose}>
        <div class="detail" onClick=${(e) => e.stopPropagation()}>
          <span class="close" onClick=${onClose}>×</span>
          <div class="muted">${err ?? "loading..."}</div>
        </div>
      </div>
    `;
  }

  const rendered = renderResultByAgent(detail.task.agentRole, detail.task.result);

  return html`
    <div class="detail-overlay" onClick=${onClose}>
      <div class="detail" onClick=${(e) => e.stopPropagation()}>
        <span class="close" onClick=${onClose}>×</span>
        <h1>
          ${detail.task.agentRole}
          ${detail.task.agentModel ? html`<span class="model-badge">${detail.task.agentModel}</span>` : null}
          <span class="muted"> ·</span> <span class="muted">${detail.task.runTitle}</span>
        </h1>
        <div class="faint mono" style="font-size: 11px; margin: 8px 0 16px;">
          ${detail.task.taskId}
          <${CopyIdButton} value=${detail.task.taskId} />
          · ${detail.task.phase} · ${detail.task.status}
          ${detail.failureKind ? html`<span class="badge status-failed" style="margin-left: 6px;">${detail.failureKind}</span>` : null}
        </div>

        ${detail.idle ? html`
          <div class="subcard" style="margin-bottom: 16px;">
            <div class="row" style="gap: 14px; align-items: center;">
              <span><span class="status-dot"></span><strong>live</strong></span>
              <span class="muted mono" style="font-size: 11px;">forge-${detail.task.taskId}</span>
            </div>
            <div class="muted ${detail.idle.expired ? "" : ""}" style="font-size: 12px; margin-top: 6px;">
              ${idleLine(detail.idle)}
            </div>
          </div>
        ` : null}

        <h3>Result</h3>
        ${rendered ?? html`<pre>${JSON.stringify(detail.task.result, null, 2)}</pre>`}

        ${detail.verdicts.length > 0 ? html`
          <h3>Verdicts (${detail.verdicts.length})</h3>
          ${detail.verdicts.map((v) => html`
            <div class="subcard">
              <strong>${v.redRole}</strong>
              <span class="badge status-${v.verdict === "pass" ? "complete" : v.verdict === "fail" ? "failed" : "pending"}">${v.verdict}</span>
              <span class="muted">authority: ${v.authority}</span>
              <span class="muted">confidence: ${v.confidence.toFixed(2)}</span>
              ${v.findings && v.findings.length > 0 ? html`
                <pre style="margin-top: 8px;">${JSON.stringify(v.findings, null, 2)}</pre>
              ` : null}
            </div>
          `)}
        ` : null}

        ${detail.gates.length > 0 ? html`
          <h3>Gates (${detail.gates.length})</h3>
          ${detail.gates.map((g) => html`
            <div class="subcard">
              <strong>${g.decision}</strong> by ${g.decidedBy} at ${g.decidedAt}
              ${g.rationale ? html`<div class="md" style="margin-top: 6px;" dangerouslySetInnerHTML=${{ __html: md(g.rationale) }}></div>` : null}
            </div>
          `)}
        ` : null}

        ${detail.events && detail.events.length > 0 ? html`
          <h3>Timeline (${detail.events.length})</h3>
          <div class="timeline">
            ${detail.events.map((e, i) => html`
              <div class="row" key=${i} style="gap: 8px; padding: 2px 0; align-items: baseline;">
                <span class="muted mono" style="font-size: 11px; min-width: 76px;">${formatClock(e.createdAt)}</span>
                <span class="badge ${eventBadgeClass(e)}">${eventBadgeText(e)}</span>
                ${eventDetail(e) ? html`<span class="muted" style="font-size: 12px;">${eventDetail(e)}</span>` : null}
              </div>
            `)}
          </div>
        ` : null}

        ${detail.stdoutLog ? html`
          <h3>Container stdout (${logSizeLabel(detail.stdoutBytes, detail.stdoutLog)})</h3>
          <pre class="log">${tailChars(detail.stdoutLog, 8000)}</pre>
        ` : null}

        ${detail.stderrLog && detail.stderrLog.trim().length > 0 ? html`
          <h3>Container stderr (${logSizeLabel(detail.stderrBytes, detail.stderrLog)})</h3>
          <pre class="log">${tailChars(detail.stderrLog, 8000)}</pre>
        ` : null}
      </div>
    </div>
  `;
}

// FG-487: dedicated tab for host-side verification liveness + host_verifications
// evidence. Kept as its own view rather than folded into a ticket/campaign
// detail page because the dashboard client has no such page today and this
// step's file scope is main.js only — the evidence lookup below is
// self-service (enter a ticket/item id) rather than embedded in a ticket card.
function VerificationsView({ inProgress, recent, ticketId, itemId, onTicketIdChange, onItemIdChange, onLookup, evidence, now }) {
  const { loop: loopVerifications, gate: gateVerifications } = groupVerificationRows(inProgress);
  const onSubmit = (e) => { e.preventDefault(); onLookup(); };
  const evidenceLookupState = evidenceState(evidence);
  const recentState = evidenceState(recent || []);

  return html`
    <section class="verify-view">
      <h2>Host verification — in progress</h2>
      ${(inProgress || []).length === 0
        ? html`<div class="muted">No review-loop verification, CI-wait, or campaign reconcile gate activity in progress.</div>`
        : html`
          ${loopVerifications.length > 0 ? html`
            <h3 style="font-size: 13px; margin: 8px 0 4px;">Review-loop verification / CI-wait</h3>
            ${loopVerifications.map((v) => html`<${VerificationRow} key=${v.attemptId} v=${v} now=${now} />`)}
          ` : null}
          ${gateVerifications.length > 0 ? html`
            <h3 style="font-size: 13px; margin: 12px 0 4px;">Campaign reconcile gates</h3>
            ${gateVerifications.map((v) => html`<${VerificationRow} key=${v.attemptId} v=${v} now=${now} />`)}
          ` : null}
        `
      }

      <h2 style="margin-top: 24px;">Evidence lookup</h2>
      <form class="row" style="gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center;" onSubmit=${onSubmit}>
        <label for="verify-ticket-id" class="muted" style="font-size: 12px;">ticket id</label>
        <input
          id="verify-ticket-id"
          type="text"
          value=${ticketId}
          onInput=${(e) => onTicketIdChange(e.target.value)}
          placeholder="e.g. FG-487"
          style="max-width: 160px;"
        />
        <label for="verify-item-id" class="muted" style="font-size: 12px;">campaign item id</label>
        <input
          id="verify-item-id"
          type="text"
          value=${itemId}
          onInput=${(e) => onItemIdChange(e.target.value)}
          placeholder="e.g. citem-..."
          style="max-width: 220px;"
        />
        <button type="submit" class="tab" aria-label="Look up host verification evidence">look up</button>
      </form>
      ${ticketId.trim() && itemId.trim()
        ? html`<div class="muted" style="font-size: 11px; margin: -6px 0 8px;">Both fields are filled in — campaign item id takes precedence and ticket id is ignored.</div>`
        : null}
      ${evidenceLookupState === "prompt"
        ? html`<div class="muted">Enter a ticket id or campaign item id above to view its recorded verification evidence.</div>`
        : evidenceLookupState === "empty"
        ? html`<div class="muted">No host_verifications rows found for that ticket/item.</div>`
        : html`<${EvidenceTable} rows=${evidence} />`
      }

      <h2 style="margin-top: 24px;">Recent host verifications</h2>
      <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
        Discoverable evidence for orchestrator-run bare gates even when their in-flight window was missed.
      </div>
      ${recentState === "empty"
        ? html`<div class="muted">No recorded host_verifications rows yet.</div>`
        : html`<${EvidenceTable} rows=${recent} showTicket=${true} />`
      }
    </section>
  `;
}

// Rows follow src/store/host-verifications.ts's HostVerificationRow shape:
// ticketId, gateName, command, exitCode, commitSha, source (host|ci), recordedAt.
function EvidenceTable({ rows, showTicket }) {
  return html`
    <div class="card" style="overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr class="muted" style="text-align: left;">
            ${showTicket ? html`<th style="padding: 4px 8px;">ticket</th>` : null}
            <th style="padding: 4px 8px;">gate</th>
            <th style="padding: 4px 8px;">command</th>
            <th style="padding: 4px 8px;">exit</th>
            <th style="padding: 4px 8px;">tested sha</th>
            <th style="padding: 4px 8px;">source</th>
            <th style="padding: 4px 8px;">recorded</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => html`
            <tr key=${r.id ?? i} style="border-top: 1px solid var(--border);">
              ${showTicket ? html`<td style="padding: 4px 8px;" class="mono">${r.ticketId ?? "—"}</td>` : null}
              <td style="padding: 4px 8px;">${r.gateName ?? "—"}</td>
              <td style="padding: 4px 8px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" class="mono faint" title=${r.command ?? ""}>${r.command ?? "—"}</td>
              <td style="padding: 4px 8px;"><span class="badge ${r.exitCode === 0 ? "status-complete" : "status-failed"}">${r.exitCode}</span></td>
              <td style="padding: 4px 8px;" class="mono faint" title=${r.commitSha ?? ""}>${r.commitSha ? r.commitSha.slice(0, 10) : "—"}</td>
              <td style="padding: 4px 8px;"><span class="badge ${r.source === "ci" ? "status-awaiting_red" : "status-pending"}">${r.source ?? "host"}</span></td>
              <td class="muted mono" style="padding: 4px 8px; font-size: 11px;">${formatRelativeTime(r.recordedAt)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function formatRelativeTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Wall-clock run-time of a finished task. Sub-minute shows seconds; longer keeps
// seconds for at-a-glance precision (matches `forge show`'s duration intent).
function formatDuration(ms) {
  if (ms == null) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} more chars)`;
}

// Server now sends a bounded tail (last 64KB), not the whole log. Show the most
// recent slice and label with the true on-disk size.
function tailChars(s, max) {
  if (s.length <= max) return s;
  return `... (earlier output omitted)\n` + s.slice(s.length - max);
}
function logSizeLabel(bytes, received) {
  const kb = (bytes / 1024).toFixed(1);
  // received is a tail; if the file is bigger than what we got, say so.
  if (typeof bytes === "number" && bytes > received.length) return `last ${(received.length / 1024).toFixed(0)} KB of ${kb} KB`;
  return `${kb} KB`;
}

// WALK-5 helpers for the task timeline + live activity panel.
function formatDurMs(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
function formatClock(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}
// FG-487: review_loop.verification_* / campaign_item.host_gate_* are the new
// host-side verification phase-boundary events (events.ts) — eventBadgeClass/
// reviewLoopVerificationDetail/hostGateDetail live in verification-render.js
// so their decision logic is unit-testable.
function eventDetail(e) {
  const p = e.payload;
  if (!p || typeof p !== "object") return "";
  if (/verification_started|verification_finished/.test(e.eventType)) return reviewLoopVerificationDetail(p);
  if (/host_gate_started|host_gate_finished/.test(e.eventType)) return hostGateDetail(p);
  if (typeof p.failure_kind === "string") return p.failure_kind;
  if (typeof p.message === "string") return p.message;
  if (typeof p.exitCode === "number") return `exit ${p.exitCode}`;
  if (typeof p.from === "string" && typeof p.to === "string") return `${p.from} → ${p.to}`;
  if (typeof p.containerName === "string") return p.containerName;
  return "";
}
function idleLine(idle) {
  if (idle.measured === false) return `awaiting start · timeout ${formatDurMs(idle.idleTimeoutMs)}`;
  const note = idle.hasOutput ? "" : ", no output yet";
  const tail = idle.expired ? "(idle budget exhausted)" : `(${formatDurMs(idle.remainingMs)} left)`;
  return `idle ${formatDurMs(idle.idleMs)}${note} · timeout ${formatDurMs(idle.idleTimeoutMs)} ${tail}`;
}

render(h(App), document.getElementById("app"));
