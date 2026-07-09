// forge-dashboard client. Preact + htm; no build step. Polls every 2s.

import { h, render } from "https://esm.sh/preact@10.24.0";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10.24.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { renderResultByAgent, md } from "./renderers.js";
import { UsageView } from "./usage.js";
import { GovernanceView } from "./governance.js";
import { BacklogView } from "./backlog.js";
import {
  eventBadgeClass, reviewLoopVerificationDetail, hostGateDetail,
  groupVerificationRows, verificationRowBadge, evidenceState,
} from "./verification-render.js";

const html = htm.bind(h);
const POLL_MS = 2000;
const USAGE_POLL_MS = 30000;

function App() {
  // #154: top-level view toggle. activity = recent runs/in-flight (the original
  // view); projects = registry cards.
  const [view, setView] = useState(() => initialView());
  // When set, both /api/feed and /api/in-flight are filtered to this project.
  // Clicking a project card sets this AND switches to activity view.
  const [projectFilter, setProjectFilter] = useState(null);
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
  const [usageGroupBy, setUsageGroupBy] = useState("project");
  const [usageSince, setUsageSince] = useState("30d");
  const [ops, setOps] = useState(null);
  const [opsSince, setOpsSince] = useState("30d");
  const [governance, setGovernance] = useState(null);
  const [backlog, setBacklog] = useState(null);
  // FG-487: review-loop verification / CI-wait windows and campaign reconcile
  // host-gate execs, in progress right now — polled alongside feed/in-flight
  // so a launched loop is visible before any task row exists for it.
  const [inProgressVerifications, setInProgressVerifications] = useState([]);
  const [reviewLoopPhases, setReviewLoopPhases] = useState([]);
  const [verifyTicketId, setVerifyTicketId] = useState("");
  const [verifyItemId, setVerifyItemId] = useState("");
  const [verifyEvidence, setVerifyEvidence] = useState(null);
  const [verifyRecent, setVerifyRecent] = useState([]);

  const poll = useCallback(async () => {
    try {
      const q = projectFilter ? `?projectDir=${encodeURIComponent(projectFilter.projectDir)}` : "";
      const reqs = [
        fetch(`/api/feed${q ? q + "&limit=100" : "?limit=100"}`),
        fetch(`/api/in-flight${q}`),
        fetch(`/api/verifications/in-progress${q}`),
        fetch(`/api/review-loop/phases${q}`),
      ];
      // Only poll /api/projects on the projects view (or first load) — saves a
      // filesystem scan every 2s on the activity view.
      if (view === "projects" || projects.length === 0) reqs.push(fetch("/api/projects"));
      const [feedRes, ifRes, ivRes, phasesRes, projRes] = await Promise.all(reqs);
      if (feedRes.ok) setFeed(await feedRes.json());
      if (ifRes.ok) setInFlight(await ifRes.json());
      if (ivRes && ivRes.ok) setInProgressVerifications(await ivRes.json());
      if (phasesRes && phasesRes.ok) setReviewLoopPhases(await phasesRes.json());
      if (projRes && projRes.ok) setProjects(await projRes.json());
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [view, projectFilter, projects.length]);

  const pollUsage = useCallback(async () => {
    try {
      const tsDays = parseInt(usageSince) * 2;
      const [rollupRes, tsRes, mixRes] = await Promise.all([
        fetch(`/api/usage?groupBy=${usageGroupBy}&since=${usageSince}`),
        fetch(`/api/usage/timeseries?since=${tsDays}d`),
        fetch(`/api/usage/model-mix?groupBy=${usageGroupBy}&since=${usageSince}`),
      ]);
      if (rollupRes.ok) setUsageRollup(await rollupRes.json());
      if (tsRes.ok) setUsageTimeSeries(await tsRes.json());
      if (mixRes.ok) setUsageModelMix(await mixRes.json());
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [usageGroupBy, usageSince]);

  useEffect(() => {
    if (view === "usage") return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll, view]);

  useEffect(() => {
    if (view !== "usage") return;
    pollUsage();
    const id = setInterval(pollUsage, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollUsage, view]);

  const pollOps = useCallback(async () => {
    try {
      const res = await fetch(`/api/ops?since=${opsSince}`);
      if (res.ok) setOps(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [opsSince]);

  useEffect(() => {
    if (view !== "ops") return;
    pollOps();
    const id = setInterval(pollOps, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollOps, view]);

  const pollGovernance = useCallback(async () => {
    try {
      const q = projectFilter ? `?projectDir=${encodeURIComponent(projectFilter.projectDir)}` : "";
      const res = await fetch(`/api/governance${q}`);
      if (res.ok) setGovernance(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "governance") return;
    pollGovernance();
    const id = setInterval(pollGovernance, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollGovernance, view]);

  const pollBacklog = useCallback(async () => {
    if (!projectFilter) { setBacklog(null); return; }
    try {
      const q = `?projectDir=${encodeURIComponent(projectFilter.projectDir)}`;
      const res = await fetch(`/api/backlog${q}`);
      if (res.ok) setBacklog(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, [projectFilter]);

  useEffect(() => {
    if (view !== "backlog") return;
    pollBacklog();
    const id = setInterval(pollBacklog, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [pollBacklog, view]);

  const pollVerifyRecent = useCallback(async () => {
    try {
      const res = await fetch(`/api/host-verifications/recent?limit=50`);
      if (res.ok) setVerifyRecent(await res.json());
      setNow(Date.now());
    } catch (e) { setError(String(e)); }
  }, []);

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
    if (!params.toString()) { setVerifyEvidence(null); return; }
    try {
      const res = await fetch(`/api/host-verifications?${params.toString()}`);
      setVerifyEvidence(res.ok ? await res.json() : []);
    } catch (e) { setError(String(e)); }
  }, [verifyTicketId, verifyItemId]);

  useEffect(() => {
    const onHash = () => setView(initialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const switchView = (next) => {
    setView(next);
    window.location.hash = next === "activity" ? "" : `#${next}`;
  };

  const filterByProject = (project) => {
    setProjectFilter(project);
    switchView("activity");
  };

  return html`
    <div class="app">
      <header class="topbar">
        <h1>
          <img src="/client/logo-mark.svg" width="32" height="32" class="brand-mark" alt="forge" />
          <nav class="view-tabs">
            <button class=${"tab " + (view === "activity" ? "tab-active" : "")} onClick=${() => switchView("activity")}>activity</button>
            <button class=${"tab " + (view === "projects" ? "tab-active" : "")} onClick=${() => switchView("projects")}>projects</button>
            <button class=${"tab " + (view === "verify" ? "tab-active" : "")} onClick=${() => switchView("verify")}>verification</button>
            <button class=${"tab " + (view === "usage" ? "tab-active" : "")} onClick=${() => switchView("usage")}>usage</button>
            <button class=${"tab " + (view === "ops" ? "tab-active" : "")} onClick=${() => switchView("ops")}>ops</button>
            <button class=${"tab " + (view === "governance" ? "tab-active" : "")} onClick=${() => switchView("governance")}>workbench</button>
            <button class=${"tab " + (view === "backlog" ? "tab-active" : "")} onClick=${() => switchView("backlog")}>backlog</button>
          </nav>
        </h1>
        <div class="muted mono">${new Date(now).toLocaleTimeString()}</div>
      </header>

      ${error ? html`<div class="card" style="color: var(--err);">Error: ${error}</div>` : null}

      ${view === "projects"
        ? html`<${ProjectsView} projects=${projects} onPick=${filterByProject} />`
        : view === "governance"
        ? html`<${GovernanceView} data=${governance} />`
        : view === "backlog"
        ? html`<${BacklogView} data=${backlog} projectFilter=${projectFilter} />`
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
        ? html`<${OpsView} data=${ops} since=${opsSince} onSinceChange=${setOpsSince} />`
        : view === "usage"
        ? html`<${UsageView}
            rollup=${usageRollup}
            timeSeries=${usageTimeSeries}
            modelMix=${usageModelMix}
            groupBy=${usageGroupBy}
            onGroupByChange=${setUsageGroupBy}
            since=${usageSince}
            onSinceChange=${setUsageSince}
          />`
        : html`
          ${projectFilter ? html`
            <div class="filter-banner">
              <span>Filtered to <strong>${projectFilter.label}</strong></span>
              <button class="clear-filter" onClick=${() => setProjectFilter(null)}>clear ×</button>
            </div>
          ` : null}
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

function initialView() {
  const h = (window.location.hash || "").replace(/^#/, "");
  if (h === "projects") return "projects";
  if (h === "usage") return "usage";
  if (h === "ops") return "ops";
  if (h === "governance") return "governance";
  if (h === "backlog") return "backlog";
  if (h === "verify") return "verify";
  return "activity";
}

// RUN-3: operations summary — success rate, failure-kind mix, median durations,
// operational counts. Reads /api/ops.
function OpsView({ data, since, onSinceChange }) {
  if (!data) return html`<div class="muted">loading metrics…</div>`;
  const pct = (data.runs.successRate * 100).toFixed(0);
  const maxKind = Math.max(1, ...data.failureKinds.map((k) => k.count));
  return html`
    <section class="ops-view">
      <div class="row" style="gap: 8px; margin-bottom: 16px;">
        <span class="muted">window:</span>
        ${["7d", "30d", "all"].map((w) => html`
          <button class=${"tab " + (since === w ? "tab-active" : "")} onClick=${() => onSinceChange(w)}>${w}</button>
        `)}
      </div>

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
function opsFmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
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
      ${projects.map((p) => html`<${ProjectCard} key=${p.projectDir} project=${p} onClick=${() => onPick(p)} />`)}
    </section>
  `;
}

function ProjectCard({ project, onClick }) {
  const ageState = projectAgeState(project);
  return html`
    <div class=${"project-card state-" + ageState} onClick=${onClick} title=${project.projectDir}>
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
      <div class="project-path mono faint" title=${project.projectDir}>${project.projectDir}</div>
    </div>
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

function ProjectChip({ entry }) {
  if (!entry.projectLabel || !entry.projectColor) return null;
  return html`
    <span class="project-chip" style=${{ background: entry.projectColor }} title=${entry.projectDir ?? ""}>
      ${entry.projectLabel}
    </span>
  `;
}

function InFlightSection({ inFlight, verifications, phases, now, orchCollapsed, onToggleOrch, onTaskClick }) {
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
    <section class="in-flight">
      <h2><span class="status-dot"></span>In flight</h2>
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
        <div class="faint mono" style="font-size: 11px;">${task.phase} · ${task.taskId}</div>
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
        ${entry.workflow} · ${entry.phase}
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
                <span class="badge ${eventBadgeClass(e)}">${e.eventType}</span>
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
