// forge-dashboard client. Preact + htm; no build step. Polls every 2s.

import { h, render } from "https://esm.sh/preact@10.24.0";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10.24.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { renderResultByAgent, md } from "./renderers.js";

const html = htm.bind(h);
const POLL_MS = 2000;

function App() {
  const [feed, setFeed] = useState([]);
  const [inFlight, setInFlight] = useState([]);
  const [error, setError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [now, setNow] = useState(Date.now());

  const poll = useCallback(async () => {
    try {
      const [feedRes, ifRes] = await Promise.all([
        fetch("/api/feed?limit=100"),
        fetch("/api/in-flight"),
      ]);
      if (feedRes.ok) setFeed(await feedRes.json());
      if (ifRes.ok) setInFlight(await ifRes.json());
      setError(null);
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  return html`
    <div class="app">
      <header class="topbar">
        <h1>
          <img src="/client/logo-mark.svg" width="32" height="32" class="brand-mark" alt="forge" />
          <span class="status-dot"></span>activity
        </h1>
        <div class="muted mono">${new Date(now).toLocaleTimeString()}</div>
      </header>

      ${error ? html`<div class="card" style="color: var(--err);">Error: ${error}</div>` : null}

      <section class="in-flight">
        <h2>In flight</h2>
        ${inFlight.length === 0
          ? html`<div class="empty">No live tasks. Polling every ${POLL_MS / 1000}s.</div>`
          : inFlight.map((t) => html`<${InFlightItem} key=${t.taskId} task=${t} onClick=${() => setSelectedTaskId(t.taskId)} />`)
        }
      </section>

      <section class="feed">
        <h2>Recent agent outputs</h2>
        ${feed.length === 0
          ? html`<div class="muted">No completed agent outputs yet.</div>`
          : feed.map((e) => html`<${FeedCard} key=${e.taskId} entry=${e} onClick=${() => setSelectedTaskId(e.taskId)} />`)
        }
      </section>

      ${selectedTaskId ? html`<${TaskDetail} taskId=${selectedTaskId} onClose=${() => setSelectedTaskId(null)} />` : null}
    </div>
  `;
}

function ProjectChip({ entry }) {
  if (!entry.projectLabel || !entry.projectColor) return null;
  return html`
    <span class="project-chip" style=${{ background: entry.projectColor }} title=${entry.projectDir ?? ""}>
      ${entry.projectLabel}
    </span>
  `;
}

function InFlightItem({ task, onClick }) {
  return html`
    <div class="item" onClick=${onClick}>
      <span class="badge status-${task.status}">${task.status.replace(/_/g, " ")}</span>
      <div>
        <div>
          <${ProjectChip} entry=${task} />
          <strong>${task.agentRole}</strong>
          ${task.agentModel ? html`<span class="model-badge">${task.agentModel}</span>` : null}
          <span class="faint"> ·</span> <span class="muted">${task.runTitle}</span>
        </div>
        <div class="faint mono" style="font-size: 11px;">${task.phase} · ${task.taskId}</div>
      </div>
      <div class="muted mono" style="font-size: 11px;">${formatRelativeTime(task.startedAt)}</div>
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

function TaskDetail({ taskId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/task/${encodeURIComponent(taskId)}`);
        if (!res.ok) { setErr("not found"); return; }
        const d = await res.json();
        if (!cancelled) setDetail(d);
      } catch (e) { if (!cancelled) setErr(String(e)); }
    })();
    return () => { cancelled = true; };
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
          ${detail.task.taskId} · ${detail.task.phase} · ${detail.task.status}
        </div>

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

        ${detail.stdoutLog ? html`
          <h3>Container stdout (${(detail.stdoutLog.length / 1024).toFixed(1)} KB)</h3>
          <pre class="log">${truncate(detail.stdoutLog, 8000)}</pre>
        ` : null}

        ${detail.stderrLog && detail.stderrLog.trim().length > 0 ? html`
          <h3>Container stderr</h3>
          <pre class="log">${detail.stderrLog}</pre>
        ` : null}
      </div>
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

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} more chars)`;
}

render(h(App), document.getElementById("app"));
