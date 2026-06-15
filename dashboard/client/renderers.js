// Per-agent renderers. Plain JS (browser-side). Loaded by main.js after
// preact + htm + marked are imported there. Exposes renderResultByAgent
// + helpers on the module's exports.

import { h } from "https://esm.sh/preact@10.24.0";
import { useState } from "https://esm.sh/preact@10.24.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { marked } from "https://esm.sh/marked@14.1.4";

const html = htm.bind(h);

// ---- markdown ----
export function md(s) {
  if (typeof s !== "string") return "";
  try { return marked.parse(s, { breaks: true, gfm: true }); }
  catch { return s; }
}
export function mdInline(s) {
  if (typeof s !== "string") return "";
  try { return marked.parseInline(s, { breaks: false, gfm: true }); }
  catch { return s; }
}

// ---- badges ----
function sevBadge(sev) {
  const cls =
    sev === "high" ? "status-failed" :
    sev === "medium" ? "status-awaiting_gate" :
    sev === "low" ? "status-awaiting_red" :
    "status-pending";
  return html`<span class="badge ${cls}">${sev}</span>`;
}
function verdictBadge(v) {
  const cls =
    v === "pass" ? "status-complete" :
    v === "fail" ? "status-failed" :
    "status-pending";
  return html`<span class="badge ${cls}">${v}</span>`;
}

// Helper: render markdown into a div via dangerouslySetInnerHTML.
function MD({ source, inline }) {
  const r = inline ? mdInline(source) : md(source);
  return html`<span class="md" dangerouslySetInnerHTML=${{ __html: r }}></span>`;
}

// ---- architect ----
export function renderArchitect(r) {
  if (!r || typeof r !== "object") return null;
  const sections = [];
  if (Array.isArray(r.risks) && r.risks.length > 0) {
    sections.push(html`
      <h3>Risks (${r.risks.length})</h3>
      ${r.risks.map((risk, i) => html`
        <div class="subcard" key=${i}>
          <div class="row" style="margin-bottom: 6px;">
            ${sevBadge(risk.severity)}
            <span class="muted">likelihood: ${risk.likelihood ?? "—"}</span>
          </div>
          <${MD} source=${risk.summary} />
          ${risk.evidence ? html`<div class="muted faint" style="font-size: 12px; margin-top: 6px;"><strong>evidence:</strong> <${MD} source=${risk.evidence} inline /></div>` : null}
          ${risk.mitigation ? html`<div class="muted" style="font-size: 12px; margin-top: 6px;"><strong>mitigation:</strong> <${MD} source=${risk.mitigation} inline /></div>` : null}
        </div>
      `)}
    `);
  }
  if (Array.isArray(r.constraints) && r.constraints.length > 0) {
    sections.push(html`
      <h3>Constraints (${r.constraints.length})</h3>
      ${r.constraints.map((c, i) => html`
        <div class="subcard" key=${i}>
          <${MD} source=${c.summary} />
          ${c.rationale ? html`<div class="muted" style="font-size: 12px; margin-top: 6px;"><strong>why:</strong> <${MD} source=${c.rationale} inline /></div>` : null}
        </div>
      `)}
    `);
  }
  if (Array.isArray(r.boundaries) && r.boundaries.length > 0) {
    sections.push(html`
      <h3>Boundaries (${r.boundaries.length})</h3>
      ${r.boundaries.map((b, i) => html`
        <div class="subcard" key=${i}>
          <${MD} source=${b.summary} />
          ${b.decision ? html`<div style="font-size: 12px; margin-top: 6px;"><strong>decision:</strong> <${MD} source=${b.decision} inline /></div>` : null}
          ${b.rationale ? html`<div class="muted" style="font-size: 12px; margin-top: 4px;"><strong>why:</strong> <${MD} source=${b.rationale} inline /></div>` : null}
        </div>
      `)}
    `);
  }
  if (Array.isArray(r.priorArt) && r.priorArt.length > 0) {
    sections.push(html`
      <h3>Prior art</h3>
      ${r.priorArt.map((p, i) => html`
        <div class="subcard" key=${i}>
          <strong class="mono" style="font-size: 12px;">${p.reference}</strong>
          <div class="muted" style="font-size: 12px; margin-top: 4px;"><${MD} source=${p.relevance} /></div>
        </div>
      `)}
    `);
  }
  if (Array.isArray(r.openQuestions) && r.openQuestions.length > 0) {
    sections.push(html`
      <h3>Open questions</h3>
      <ul style="margin: 0; padding-left: 20px;">
        ${r.openQuestions.map((q, i) => html`<li key=${i}><${MD} source=${q} inline /></li>`)}
      </ul>
    `);
  }
  if (r.notes) {
    sections.push(html`
      <h3>Notes</h3>
      <div class="muted"><${MD} source=${r.notes} /></div>
    `);
  }
  return sections.length > 0 ? html`<div>${sections}</div>` : null;
}

// ---- tech-lead ----
export function renderTechLead(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.steps)) return null;
  return html`
    <h3>Plan (${r.steps.length} step${r.steps.length === 1 ? "" : "s"})</h3>
    ${r.steps.map((s) => html`
      <div class="subcard" key=${s.id}>
        <div style="margin-bottom: 6px;">
          <strong>Step ${s.id}</strong>
          ${Array.isArray(s.files) && s.files.length > 0 ? html`
            <span class="muted mono" style="font-size: 11px; margin-left: 8px;">${s.files.join(", ")}</span>
          ` : null}
        </div>
        <${MD} source=${s.summary} />
        ${s.acceptance ? html`
          <div class="muted" style="font-size: 12px; margin-top: 6px;">
            <strong>acceptance:</strong> <${MD} source=${s.acceptance} inline />
          </div>
        ` : null}
      </div>
    `)}
  `;
}

// ---- engineer / specialists ----
export function renderEngineer(r) {
  if (!r || typeof r !== "object") return null;
  return html`
    ${r.diff_summary ? html`
      <h3>Diff summary</h3>
      <${MD} source=${r.diff_summary} />
    ` : null}
    ${Array.isArray(r.files_modified) && r.files_modified.length > 0 ? html`
      <h3>Files modified (${r.files_modified.length})</h3>
      <ul class="mono" style="font-size: 12px; margin: 0; padding-left: 20px;">
        ${r.files_modified.map((f, i) => html`<li key=${i}>${f}</li>`)}
      </ul>
    ` : null}
    ${Array.isArray(r.steps_completed) && r.steps_completed.length > 0 ? html`
      <div class="muted" style="font-size: 12px; margin-top: 8px;">steps completed: ${r.steps_completed.join(", ")}</div>
    ` : null}
    ${r.notes ? html`
      <h3>Notes</h3>
      <div class="muted"><${MD} source=${r.notes} /></div>
    ` : null}
  `;
}

// ---- qa-engineer ----
export function renderQa(r) {
  if (!r || typeof r !== "object") return null;
  const counts = [];
  if (typeof r.tests_run === "number") counts.push(`${r.tests_run} run`);
  if (typeof r.tests_passed === "number") counts.push(`${r.tests_passed} passed`);
  if (typeof r.tests_failed === "number") counts.push(`${r.tests_failed} failed`);
  return html`
    ${counts.length > 0 ? html`<h3>Tests: ${counts.join(" · ")}</h3>` : null}
    ${r.evidence ? html`<${MD} source=${r.evidence} />` : null}
    ${r.notes ? html`
      <h3>Notes</h3>
      <div class="muted"><${MD} source=${r.notes} /></div>
    ` : null}
  `;
}

// ---- red ----
export function renderRed(r) {
  if (!r || typeof r !== "object") return null;
  return html`
    <div class="row" style="margin-bottom: 12px;">
      ${verdictBadge(r.verdict)}
      ${typeof r.confidence === "number" ? html`<span class="muted">confidence: ${r.confidence.toFixed(2)}</span>` : null}
    </div>
    ${Array.isArray(r.findings) && r.findings.length > 0 ? html`
      <h3>Findings (${r.findings.length})</h3>
      ${r.findings.map((f, i) => html`
        <div class="subcard" key=${i}>
          <div class="row" style="margin-bottom: 6px;">
            ${sevBadge(f.severity)}
          </div>
          <${MD} source=${f.summary} />
          ${f.evidence ? html`<div class="muted" style="font-size: 12px; margin-top: 6px;"><strong>evidence:</strong> <${MD} source=${f.evidence} inline /></div>` : null}
          ${f.hypothesis ? html`<div class="muted" style="font-size: 12px; margin-top: 4px;"><strong>hypothesis:</strong> <${MD} source=${f.hypothesis} inline /></div>` : null}
        </div>
      `)}
    ` : null}
    ${r.notes ? html`
      <h3>Notes</h3>
      <div class="muted"><${MD} source=${r.notes} /></div>
    ` : null}
  `;
}

// ---- compression (FG-323) ----

// Formats bytes as "120KB" or "1.2MB".
function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// Returns a badge element for a compression event, or a "below threshold" note.
// compressionEvent: CompressionEventData | null
// resultSizeBytes: number | null
export function renderCompressionBadge(compressionEvent, resultSizeBytes) {
  if (!compressionEvent) {
    if (resultSizeBytes != null) {
      return html`<span class="muted faint" style="font-size: 12px;">Result size: ${fmtBytes(resultSizeBytes)} (below compression threshold)</span>`;
    }
    return null;
  }

  const orig = fmtBytes(compressionEvent.originalSizeBytes);
  const comp = fmtBytes(compressionEvent.compressedSizeBytes);
  const pct = compressionEvent.compressionRatio != null
    ? `${Math.round(compressionEvent.compressionRatio * 100)}%`
    : null;

  if (compressionEvent.agentCompressed) {
    return html`<span class="badge compression-badge-agent">✓ Compressed: ${orig} → ${comp}${pct ? ` (${pct})` : ""}</span>`;
  }
  if (compressionEvent.orchestratorCompressed) {
    return html`<span class="badge compression-badge-orch">⚠ Orchestrator compressed: ${orig} → ${comp}${pct ? ` (${pct})` : ""}</span>`;
  }
  return null;
}

// Returns an expandable accordion with compression details.
export function renderCompressionDetail(compressionEvent) {
  if (!compressionEvent) return null;
  return html`<${CompressionDetail} ev=${compressionEvent} />`;
}

function CompressionDetail({ ev }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="subcard" style="margin-top: 8px;">
      <div class="row" style="cursor: pointer; user-select: none;" onClick=${() => setOpen((o) => !o)}>
        <span class="orch-chevron ${open ? "open" : ""}">▸</span>
        <span style="font-size: 12px; color: var(--fg-dim);">Compression detail</span>
      </div>
      ${open ? html`
        <div style="margin-top: 10px; font-size: 12px; display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px;">
          <span class="muted">Method</span><span>${ev.method ?? "none"}</span>
          ${ev.fieldsCompressed && ev.fieldsCompressed.length > 0 ? html`
            <span class="muted">Fields</span><span class="mono">[${ev.fieldsCompressed.join(", ")}]</span>
          ` : null}
          ${ev.originalSizeBytes != null ? html`<span class="muted">Original size</span><span>${fmtBytes(ev.originalSizeBytes)}</span>` : null}
          ${ev.compressedSizeBytes != null ? html`<span class="muted">Compressed size</span><span>${fmtBytes(ev.compressedSizeBytes)}</span>` : null}
          ${ev.compressionRatio != null ? html`<span class="muted">Compression ratio</span><span>${Math.round(ev.compressionRatio * 100)}%</span>` : null}
          ${ev.ccrId ? html`<span class="muted">CCR ID</span><span class="mono">${ev.ccrId}</span>` : null}
        </div>
      ` : null}
    </div>
  `;
}

// ---- dispatch ----
export function renderResultByAgent(agentRole, r) {
  if (agentRole === "architecture-advisor") return renderArchitect(r);
  if (agentRole === "tech-lead") return renderTechLead(r);
  if (agentRole === "qa-engineer") return renderQa(r);
  if (agentRole.startsWith("red-")) return renderRed(r);
  if (
    agentRole === "engineer" ||
    agentRole === "frontend-specialist" ||
    agentRole === "backend-specialist" ||
    agentRole === "security-advisor" ||
    agentRole === "agentic-platform-builder"
  ) return renderEngineer(r);
  return null;
}
