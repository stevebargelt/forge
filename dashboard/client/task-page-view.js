// FG-821: the task page (#task/<taskId>) and its Explain tab (#task/<taskId>/explain).
// What the task-detail modal showed — the result through the role renderers, verdicts,
// gates, the timeline and the stdout/stderr tail — as an addressable page, plus a links
// row read from GET /api/task/:id's `links` (run, ticket, reviews, launches, host
// verifications). The breadcrumb trail and the screen line are built from this payload
// (and the run's attention items), never from how the operator got here.

import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { renderResultByAgent, md } from "./renderers.js";
import { eventBadgeClass, eventBadgeText, reviewLoopVerificationDetail, hostGateDetail } from "./verification-render.js";
import { readAttentionInbox } from "./attention-inbox-render.js";
import { breadcrumbTrail, parentHash, projectForDir } from "./breadcrumbs-render.js";
import { taskHeader } from "./screen-header-render.js";
import { hashFor } from "./view-routing.js";
import { ExplainContent } from "./run-explain-panel.js";
import { ObjectHead, ObjectTabs, useEscapeTo } from "./object-page-view.js";

const html = htm.bind(h);

/** The breadcrumb/parent payload a task detail carries. */
export function taskCrumbPayload(detail, taskId) {
  if (!detail || !detail.task) return { taskId };
  const t = detail.task;
  return {
    projectDir: t.projectDir,
    ticketId: detail.links?.ticketId ?? null,
    runId: t.runId,
    runTitle: t.runTitle,
    taskId: t.taskId,
    taskLabel: `${t.agentRole} · ${t.taskId}`,
  };
}

export function TaskPage({ taskId, tab, projects }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [inbox, setInbox] = useState(null);
  const explain = tab === "explain";

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    setDetail(null);
    setErr(null);
    const load = async () => {
      try {
        const res = await fetch(`/api/task/${encodeURIComponent(taskId)}`);
        if (!res.ok) { if (!cancelled) setErr(res.status === 404 ? `No task ${taskId}.` : `Task read failed (HTTP ${res.status}).`); return; }
        const d = await res.json();
        if (cancelled) return;
        if (!d || !d.task) { setErr(`Task read for ${taskId} returned no task.`); return; }
        setDetail(d);
        // WALK-5: poll while the task is running so the timeline + idle
        // countdown stay live; stop once it reaches a terminal state.
        if (d.task && d.task.status === "running") timer = setTimeout(load, 3000);
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [taskId]);

  // The run's attention items carry the server's reason and requested action (for a
  // failed task, the retry policy's advice) for the screen line.
  const runId = detail?.task?.runId ?? null;
  const status = detail?.task?.status ?? null;
  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;
    readAttentionInbox(`/api/attention-inbox?runId=${encodeURIComponent(runId)}`).then((load) => { if (!cancelled) setInbox(load); });
    return () => { cancelled = true; };
  }, [runId, status]);

  const page = explain ? "explain" : "task";
  const payload = taskCrumbPayload(detail, taskId);
  useEscapeTo(parentHash(page, payload));
  const crumbs = breadcrumbTrail(page, payload, projects);
  const title = explain ? "Explain" : detail ? detail.task.agentRole : "Task";
  const tabs = [
    { id: "detail", label: "Task", href: hashFor({ view: "task", id: taskId }), current: !explain },
    { id: "explain", label: "Explain", href: hashFor({ view: "task", id: taskId, tab: "explain" }), current: explain },
  ];

  return html`
    <section class=${"object-page task-page" + (explain ? " explain-page" : "")} data-task-id=${taskId}>
      <${ObjectHead} crumbs=${crumbs} title=${title} header=${taskHeader(detail, inbox, { explain })} />
      <${ObjectTabs} label="Task views" tabs=${tabs} />
      ${err ? html`<div class="card" style="color: var(--err);" role="alert">${err}</div>` : null}
      ${explain
        ? html`<${ExplainContent} taskId=${taskId} />`
        : detail
        ? html`<${TaskLinks} detail=${detail} projects=${projects} /><${TaskDetailBody} detail=${detail} />`
        : err ? null : html`<div class="muted">loading…</div>`}
    </section>
  `;
}

function LinkList({ items, empty = "none" }) {
  if (items.length === 0) return html`<span class="faint">${empty}</span>`;
  return items.map((item, i) => html`${i > 0 ? ", " : ""}${item}`);
}

/** The links row: every object this task's payload names, each a link to its page. */
function TaskLinks({ detail, projects }) {
  const links = detail.links ?? { runId: detail.task.runId, ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] };
  const project = projectForDir(detail.task.projectDir, projects);
  return html`
    <dl class="task-links" aria-label="Linked objects">
      <div><dt>run</dt><dd><a href=${hashFor({ view: "run", id: links.runId })} data-link="run">${detail.task.runTitle || links.runId}</a></dd></div>
      <div><dt>ticket</dt><dd>${links.ticketId
        ? html`<a href=${hashFor({ view: "backlog", id: links.ticketId, scope: project ? { project: project.key } : null })} data-link="ticket">${links.ticketId}</a>`
        : html`<span class="faint">none</span>`}</dd></div>
      <div><dt>reviews</dt><dd><${LinkList} items=${(links.reviewIds || []).map((id) => html`<a class="mono" href=${hashFor({ view: "reviews", id })} data-link="review">${id}</a>`)} /></dd></div>
      <div><dt>launches</dt><dd><${LinkList} items=${(links.launchIds || []).map((id) => html`<span><a class="mono" href=${`/api/launches/${encodeURIComponent(id)}`} target="_blank" rel="noopener" data-link="launch">${id}</a> (<a href=${`/api/launches/${encodeURIComponent(id)}/log`} target="_blank" rel="noopener">log</a>)</span>`)} /></dd></div>
      <div><dt>host verifications</dt><dd><${LinkList} items=${(links.hostVerificationIds || []).map((id) => html`<a class="mono" href=${hashFor({ view: "task", id: detail.task.taskId, tab: "explain" })} data-link="host-verification">#${id}</a>`)} /></dd></div>
    </dl>
  `;
}

function TaskDetailBody({ detail }) {
  const rendered = renderResultByAgent(detail.task.agentRole, detail.task.result);
  return html`
    <div class="task-page-body">
      <div class="faint mono" style="font-size: 11px; margin: 8px 0 16px;">
        <${ModelBadge} entry=${detail.task} />
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
          <div class="muted" style="font-size: 12px; margin-top: 6px;">
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
  `;
}

// Copies a value (e.g. a task id) to the clipboard. Falls back to a hidden
// textarea + execCommand for non-secure contexts; localhost is secure so the
// clipboard API path is the norm. stopPropagation so clicking it inside a
// clickable row/overlay doesn't also trigger the row.
export function CopyIdButton({ value }) {
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

// FG-560: the per-task model badge, with mapping-path provenance made VISIBLE.
// The mapping-path axis (exact vs default-fallback) is SEPARATE from the profile-
// selection provenance — an exact activity mapping and a map.default fallback must
// be distinguishable at a glance. BOTH carry a visible text marker ("exact" /
// "default") plus a tooltip: colour and hover are never the ONLY signal, so the
// state is perceivable by keyboard, touch and assistive-tech users, not just by a
// mouse hover (RF-1). A default fallback additionally gets a distinct class and a
// tooltip saying the activity was NOT mapped. A legacy task (no policy →
// mappingPath null) renders exactly as before: a plain badge, no marker, no
// provenance tooltip. Shared across every task surface so they agree.
export function ModelBadge({ entry }) {
  if (!entry.agentModel) return null;
  const mappingPath = entry.mappingPath;
  const explicit = entry.capabilitySource === "explicit";
  if (mappingPath === "default-fallback") {
    // A default fallback. When the activity was EXPLICIT this is the shape dispatch
    // refuses (activity_unmapped) — flag it more loudly; otherwise it is a benign
    // role-derived catch-all, still marked distinct from an exact hit.
    const title = explicit
      ? "map.default fallback — the EXPLICIT activity is NOT mapped in this profile (activity_unmapped)"
      : "map.default fallback — no activity-specific mapping for this task";
    return html`<span
      class=${"model-badge model-badge-default-fallback" + (explicit ? " model-badge-unmapped" : "")}
      title=${title}
    >${entry.agentModel}<span class="model-badge-tag">default</span></span>`;
  }
  if (mappingPath === "exact") {
    return html`<span class="model-badge model-badge-exact" title="exact activity mapping — the activity is mapped directly in this profile">${entry.agentModel}<span class="model-badge-tag">exact</span></span>`;
  }
  // Legacy / pre-policy task: no mapping-path provenance. Unchanged rendering.
  return html`<span class="model-badge">${entry.agentModel}</span>`;
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
