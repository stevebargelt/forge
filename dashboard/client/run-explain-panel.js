// FG-348 [H]: the "Why this task?" Explain panel. preact + htm. Consumes GET
// /api/task/:id/explain and renders every block (workflow source, model
// resolution, runtime/auth, mount mode, gate, reds, upstream inputs, artifacts).
// Degradation warnings render PROMINENTLY at the top. Read-only — no mutation
// controls. A "current config" contrast, if ever added, must be labeled current;
// this panel presents ONLY the task's RECORDED resolution.

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// The block status glyph is non-color (a11y): recorded/inferred/unknown each get
// a distinct symbol AND label.
const BLOCK_STATUS = {
  recorded: { symbol: "●", label: "recorded" },
  inferred: { symbol: "◐", label: "inferred" },
  unknown: { symbol: "○", label: "unknown" },
};

function StatusTag({ status }) {
  if (!status) return null;
  const meta = BLOCK_STATUS[status] ?? BLOCK_STATUS.unknown;
  return html`<span class=${"rx-status rx-status-" + status} aria-label=${"provenance: " + meta.label}>${meta.symbol} ${meta.label}</span>`;
}

function Field({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return html`<div class="rx-field"><span class="rx-field-label">${label}</span><span class="rx-field-value mono">${String(value)}</span></div>`;
}

function Block({ title, status, children }) {
  return html`
    <section class="rx-block" role="region" aria-label=${title}>
      <header class="rx-block-head">
        <h3 class="rx-block-title">${title}</h3>
        <${StatusTag} status=${status} />
      </header>
      <div class="rx-block-body">${children}</div>
    </section>
  `;
}

function WorkflowBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Workflow source" status=${block.status}>
    <${Field} label="name" value=${block.name} />
    <${Field} label="source" value=${block.source} />
    <${Field} label="path" value=${block.path} />
  </${Block}>`;
}

function ModelBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Model resolution" status=${block.status}>
    <${Field} label="alias" value=${block.alias} />
    <${Field} label="model" value=${block.model} />
    <${Field} label="profile" value=${block.profile} />
    <${Field} label="provider" value=${block.provider} />
    <${Field} label="auth" value=${block.auth} />
    <${Field} label="cost tier" value=${block.costTier} />
    <${Field} label="resolved by" value=${block.resolvedBy} />
    <${Field} label="capability source" value=${block.capabilitySource} />
    <${Field} label="mapping path" value=${block.mappingPath} />
  </${Block}>`;
}

function RuntimeBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Runtime / auth" status=${block.status}>
    <${Field} label="runtime" value=${block.name} />
    <${Field} label="kind" value=${block.kind} />
    <${Field} label="log format" value=${block.logFormat} />
    <${Field} label="prompt strategy" value=${block.promptStrategy} />
    <${Field} label="auth strategy" value=${block.authStrategy} />
  </${Block}>`;
}

function MountBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Mount mode" status=${block.status}>
    <${Field} label="mode" value=${block.mountMode ? (block.mountMode === "ro" ? "read-only (ro)" : "read-write (rw)") : undefined} />
    <${Field} label="project dir" value=${block.projectDir} />
    <${Field} label="invocation cwd" value=${block.invocationCwd} />
    ${block.resolvedFromSubdir ? html`<${Field} label="resolved from subdir" value="yes" />` : null}
    ${block.explicitSubproject ? html`<${Field} label="explicit subproject" value="yes" />` : null}
  </${Block}>`;
}

function GateBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Gate" status=${block.status}>
    <${Field} label="gate type" value=${block.gateType} />
    ${(block.decisions || []).length === 0
      ? html`<div class="muted">no gate decisions recorded</div>`
      : (block.decisions || []).map((d, i) => html`
          <div class="rx-decision" key=${i}>
            <span class="rx-decision-verb mono">${d.decision}</span>
            <span class="muted">by ${d.decidedBy} · ${d.decidedAt}</span>
            ${d.rationale ? html`<div class="rx-decision-rationale">${d.rationale}</div>` : null}
          </div>`)}
  </${Block}>`;
}

function RedsBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Reds" status=${block.status}>
    ${(block.reds || []).length === 0
      ? html`<div class="muted">no red reviews</div>`
      : (block.reds || []).map((r) => html`
          <div class="rx-red" key=${r.redTaskId}>
            <span class="rx-red-role mono">${r.redRole}</span>
            <span class=${"rx-verdict rx-verdict-" + r.verdict}>${r.verdict}</span>
            <span class="muted">conf ${r.confidence} · ${r.authority} · ${r.findingCount} finding(s)</span>
          </div>`)}
  </${Block}>`;
}

function UpstreamBlock({ block }) {
  if (!block) return null;
  return html`<${Block} title="Upstream inputs" status=${block.status}>
    ${(block.inputs || []).length === 0
      ? html`<div class="muted">no inputs</div>`
      : (block.inputs || []).map((i) => html`<${Field} key=${i.key} label=${i.key} value=${i.summary} />`)}
  </${Block}>`;
}

function ArtifactsBlock({ artifacts }) {
  if (!artifacts || artifacts.length === 0) return null;
  return html`<${Block} title="Artifacts">
    <div class="rx-artifacts">
      ${artifacts.map((a) => html`
        <span key=${a.kind} class=${"rx-artifact" + (a.available ? "" : " rx-artifact-absent")} aria-label=${`${a.name} ${a.available ? "available" : "absent"}`}>
          ${a.available ? "✓" : "○"} ${a.name}
        </span>`)}
    </div>
  </${Block}>`;
}

// FG-746 (C5/AC6): the candidate-bound host/CI verification evidence for this task's
// run, served as a sidecar alongside the (unmodified) TaskExplain. Degrades to nothing
// when the payload has no evidence (older tasks, out-of-scope, or none recorded),
// matching ArtifactsBlock's absent-data convention.
function VerificationEvidenceBlock({ evidence }) {
  if (!evidence || evidence.length === 0) return null;
  return html`<${Block} title="Verification evidence">
    <div class="rx-verif" data-testid="rx-verification-evidence">
      ${evidence.map((e) => html`
        <div class="rx-verif-row" data-testid="rx-verif-row" key=${e.id ?? `${e.commitSha}-${e.gateName}`}>
          <span class=${"badge " + (e.exitCode === 0 ? "status-complete" : "status-failed")}>${e.exitCode === 0 ? "pass" : `exit ${e.exitCode}`}</span>
          <span>${e.gateName}</span>
          <span class="rx-verif-source">${e.source}</span>
          ${e.command ? html`<code class="mono faint">${e.command}</code>` : null}
          ${e.ciUrl
            ? html`<a class="mono" href=${e.ciUrl} target="_blank" rel="noreferrer noopener">${e.commitSha ? e.commitSha.slice(0, 10) : "—"}</a>`
            : html`<span class="mono faint">${e.commitSha ? e.commitSha.slice(0, 10) : "—"}</span>`}
          <span class="muted mono rx-verif-time">${e.recordedAt ?? "—"}</span>
        </div>`)}
    </div>
  </${Block}>`;
}

export function RunExplainPanel({ taskId, scopeQuery = "", onClose }) {
  const [explain, setExplain] = useState(null);
  const [err, setErr] = useState(null);
  const overlayRef = useRef(null);

  // Dialog keyboard semantics (FG-348 RF-2): dismissable via Escape, focus moved into
  // the panel on open and restored to the invoking control (the run-map node) on close —
  // the backlog/campaign detail-overlay precedent.
  const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
  const onCloseKey = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClose(); } };

  useEffect(() => {
    const opener = document.activeElement;
    const node = overlayRef.current;
    if (node) (node.querySelector(".close") ?? node).focus();
    return () => { if (opener && typeof opener.focus === "function") opener.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setExplain(null);
    setErr(null);
    (async () => {
      try {
        const res = await fetch(`/api/task/${encodeURIComponent(taskId)}/explain${scopeQuery}`);
        if (cancelled) return;
        if (!res.ok) {
          setErr(`request failed (${res.status})`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setExplain(data);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, scopeQuery]);

  return html`
    <div class="detail-overlay" ref=${overlayRef} onClick=${onClose} onKeyDown=${onKeyDown}
      role="dialog" aria-modal="true" aria-label=${`Why task ${taskId}`}>
      <div class="detail rx-panel" onClick=${(e) => e.stopPropagation()}>
        <span class="close" onClick=${onClose} role="button" tabIndex="0" aria-label="Close explain panel" onKeyDown=${onCloseKey}>×</span>
        <h2 class="rx-heading">Why this task?</h2>
        ${err ? html`<div class="card" style="color: var(--err);">${err}</div>` : null}
        ${!explain && !err ? html`<div class="muted">loading explain…</div>` : null}
        ${explain
          ? html`
              <div class="rx-identity mono">
                <span>${explain.role}</span>
                <span class="muted">${explain.taskId}</span>
                <span class="muted">[${explain.status}]</span>
              </div>
              ${(explain.warnings || []).length
                ? html`<div class="rx-warnings" role="alert" aria-label="explain warnings">
                    ${explain.warnings.map((w, i) => html`<div class="rx-warning" key=${i}>⚠ ${w}</div>`)}
                  </div>`
                : null}
              <${WorkflowBlock} block=${explain.workflowSource} />
              <${ModelBlock} block=${explain.modelResolution} />
              <${RuntimeBlock} block=${explain.runtime} />
              <${MountBlock} block=${explain.mountMode} />
              <${GateBlock} block=${explain.gate} />
              <${RedsBlock} block=${explain.reds} />
              <${UpstreamBlock} block=${explain.upstream} />
              <${ArtifactsBlock} artifacts=${explain.artifacts} />
              <${VerificationEvidenceBlock} evidence=${explain.verificationEvidence} />
            `
          : null}
      </div>
    </div>
  `;
}
