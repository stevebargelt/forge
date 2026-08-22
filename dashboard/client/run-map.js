// FG-348 [G]: the Run Map canvas. preact + htm, no build step, no vendored graph
// library — a hand-rolled DAG layout for the top-level phase row (preserves the
// offline/CSP closure). Consumes GET /api/run/:id/map. Lays phases left-to-right
// by dependency; fanout phases render as a grouped, expandable node; red tasks
// attach to the primary they reviewed. Fanout vs reds are distinguished by
// SHAPE/BORDER + a text label, never color alone (a11y precedent: control-plane.js).
// Clicking any node raises onSelect(taskId).

import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// Non-color status symbols — every task status gets a DISTINCT glyph so a node is
// legible without color (FG-123 a11y precedent).
const STATUS_META = {
  complete: { symbol: "✓", label: "complete" },
  failed: { symbol: "✗", label: "failed" },
  running: { symbol: "⟳", label: "running" },
  pending: { symbol: "◌", label: "pending" },
  awaiting_gate: { symbol: "⏸", label: "awaiting gate" },
  awaiting_red: { symbol: "⏳", label: "awaiting red" },
  blocked_by_red: { symbol: "⛔", label: "blocked by red" },
  awaiting_recovery: { symbol: "↻", label: "awaiting recovery" },
};

function statusMeta(status) {
  return STATUS_META[status] ?? { symbol: "•", label: status || "unknown" };
}

function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return html`<span class=${"rm-status rm-status-" + (status || "unknown")} aria-label=${"status: " + meta.label}>${meta.symbol} ${meta.label}</span>`;
}

function ModelBadge({ model }) {
  if (!model) return null;
  const label = model.alias ?? model.profile ?? model.model;
  if (!label) return null;
  const title = [model.alias, model.model, model.profile].filter(Boolean).join(" · ");
  return html`<span class=${"rm-model" + (model.inferred ? " rm-model-inferred" : "")} title=${title}>${label}${model.inferred ? " ~" : ""}</span>`;
}

// Longest-path layering so a phase always sits to the RIGHT of every phase it
// depends on. Degraded graphs carry no edges → one layer (execution order).
function layerPhases(phases, edges) {
  const ids = new Set(phases.map((p) => p.id));
  const deps = new Map(phases.map((p) => [p.id, (p.dependsOn || []).filter((d) => ids.has(d))]));
  const depth = new Map();
  const compute = (id, seen) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // cycle guard — schema forbids cycles, defensive only
    seen.add(id);
    const ds = deps.get(id) ?? [];
    const val = ds.length ? 1 + Math.max(...ds.map((d) => compute(d, seen))) : 0;
    depth.set(id, val);
    return val;
  };
  for (const p of phases) compute(p.id, new Set());
  const layers = [];
  for (const p of phases) {
    const d = depth.get(p.id) ?? 0;
    (layers[d] ??= []).push(p);
  }
  return layers.filter(Boolean);
}

function RedChip({ attachment, node, onSelect }) {
  const status = node?.status ?? "unknown";
  const meta = statusMeta(status);
  // Reds are shape-distinguished from fanout: a solid left accent + the ◆ glyph +
  // an explicit "red" label. Never color-only.
  return html`
    <button
      class="rm-red"
      onClick=${() => onSelect(attachment.redTaskId)}
      title=${`red review via ${attachment.via}`}
      aria-label=${`red ${attachment.redRole}, ${meta.label}`}
    >
      <span class="rm-red-mark" aria-hidden="true">◆</span>
      <span class="rm-red-role">red · ${attachment.redRole}</span>
      <${StatusBadge} status=${status} />
      <span class="rm-red-via">${attachment.via}</span>
    </button>
  `;
}

function TaskNode({ node, reds, onSelect }) {
  return html`
    <div class="rm-node-group">
      <button
        class=${"rm-node" + (node.inferred ? " rm-node-inferred" : "")}
        onClick=${() => onSelect(node.taskId)}
        aria-label=${`task ${node.role}, ${statusMeta(node.status).label}`}
      >
        <div class="rm-node-head">
          <span class="rm-role">${node.role}</span>
          <${StatusBadge} status=${node.status} />
        </div>
        <div class="rm-node-meta">
          <span class="rm-gate" title="gate">gate: ${node.gate ?? "?"}</span>
          <${ModelBadge} model=${node.model} />
          ${node.lineage && node.lineage !== "primary"
            ? html`<span class="rm-lineage">${node.lineage.replace(/_/g, " ")}</span>`
            : null}
        </div>
      </button>
      ${reds.length
        ? html`<div class="rm-reds" role="group" aria-label="red reviews">
            ${reds.map((r) => html`<${RedChip} key=${r.attachment.redTaskId} attachment=${r.attachment} node=${r.node} onSelect=${onSelect} />`)}
          </div>`
        : null}
    </div>
  `;
}

function FanoutGroup({ group, nodes, onSelect }) {
  const [open, setOpen] = useState(false);
  // Fanout is shape-distinguished from reds: a DASHED border + the ⑃ glyph + an
  // explicit "fanout" count label. Expandable so ~21 children never explode inline.
  return html`
    <div class="rm-fanout">
      <button
        class="rm-fanout-head"
        onClick=${() => setOpen((o) => !o)}
        aria-expanded=${open}
        aria-label=${`fanout group, ${group.count} children`}
      >
        <span class="rm-fanout-mark" aria-hidden="true">⑃</span>
        <span>${open ? "▾" : "▸"} fanout · ${group.count} ${group.count === 1 ? "child" : "children"}</span>
      </button>
      ${open
        ? html`<div class="rm-fanout-children">
            ${group.childTaskIds.map((id) => {
              const node = nodes.get(id);
              if (!node) return null;
              return html`<${TaskNode} key=${id} node=${node} reds=${[]} onSelect=${onSelect} />`;
            })}
          </div>`
        : null}
    </div>
  `;
}

function PhaseColumn({ phase, nodes, redsByPrimary, fanoutGroup, nodeById, onSelect }) {
  // Primary/attempt nodes for this phase (everything that isn't a fanout child).
  const primaries = nodes.filter((n) => n.lineage !== "fanout_child");
  return html`
    <div class="rm-column">
      <div class=${"rm-phase" + (phase.inferred ? " rm-phase-inferred" : "") + (phase.fanout ? " rm-phase-fanout" : "")}>
        <div class="rm-phase-name">${phase.label}${phase.inferred ? " ~" : ""}</div>
        <div class="rm-phase-meta">
          ${phase.role ? html`<span class="rm-phase-role">${phase.role}</span>` : null}
          <span class="rm-phase-gate">gate: ${phase.gate ?? "?"}</span>
          ${phase.fanout ? html`<span class="rm-phase-flag" aria-label="fanout phase">⑃ fanout</span>` : null}
          ${phase.manual ? html`<span class="rm-phase-flag">manual</span>` : null}
        </div>
        ${phase.dependsOn && phase.dependsOn.length
          ? html`<div class="rm-phase-deps">← ${phase.dependsOn.join(", ")}</div>`
          : null}
      </div>
      <div class="rm-nodes">
        ${primaries.length === 0 && !fanoutGroup
          ? html`<div class="rm-empty muted">no tasks yet</div>`
          : null}
        ${primaries.map((n) => {
          const reds = (redsByPrimary.get(n.taskId) || []).map((a) => ({ attachment: a, node: nodeById.get(a.redTaskId) }));
          return html`<${TaskNode} key=${n.taskId} node=${n} reds=${reds} onSelect=${onSelect} />`;
        })}
        ${fanoutGroup ? html`<${FanoutGroup} group=${fanoutGroup} nodes=${nodeById} onSelect=${onSelect} />` : null}
      </div>
    </div>
  `;
}

export function RunMap({ graph, onSelect }) {
  if (!graph) return html`<div class="muted">loading run map…</div>`;

  const nodeById = new Map(graph.nodes.map((n) => [n.taskId, n]));
  const nodesByPhase = new Map();
  for (const n of graph.nodes) {
    const arr = nodesByPhase.get(n.phase) ?? [];
    arr.push(n);
    nodesByPhase.set(n.phase, arr);
  }
  const redsByPrimary = new Map();
  for (const a of graph.redAttachments) {
    const arr = redsByPrimary.get(a.primaryTaskId) ?? [];
    arr.push(a);
    redsByPrimary.set(a.primaryTaskId, arr);
  }
  const fanoutByPhase = new Map(graph.fanoutGroups.map((g) => [g.phase, g]));

  // A red task must not ALSO appear as a standalone node in its phase column — it
  // is rendered attached to its primary. Filter the attached red task ids out.
  const attachedRedIds = new Set(graph.redAttachments.map((a) => a.redTaskId));
  const columnNodes = (phaseId) => (nodesByPhase.get(phaseId) || []).filter((n) => !attachedRedIds.has(n.taskId));

  const layers = layerPhases(graph.phases, graph.edges);

  return html`
    <section class="rm-view" aria-label="Run map">
      <header class="rm-header">
        <div class="row" style="gap: 12px; align-items: baseline; flex-wrap: wrap;">
          <h2 class="workbench-section-label">RUN MAP</h2>
          <span class="mono">${graph.run.title}</span>
          <${StatusBadge} status=${graph.run.status} />
          <span class="muted mono">${graph.run.workflow}</span>
          ${!graph.workflowResolved ? html`<span class="rm-degraded" aria-label="degraded">inferred labels</span>` : null}
        </div>
      </header>
      ${graph.warnings && graph.warnings.length
        ? html`<div class="rm-warnings" role="note" aria-label="run map warnings">
            ${graph.warnings.map((w, i) => html`<div class="rm-warning" key=${i}>⚠ ${w}</div>`)}
          </div>`
        : null}
      <div class="rm-canvas" role="list">
        ${layers.map((layer, li) => html`
          <div class="rm-layer" role="listitem" key=${li}>
            ${layer.map((phase) => html`<${PhaseColumn}
              key=${phase.id}
              phase=${phase}
              nodes=${columnNodes(phase.id)}
              redsByPrimary=${redsByPrimary}
              fanoutGroup=${fanoutByPhase.get(phase.id)}
              nodeById=${nodeById}
              onSelect=${onSelect}
            />`)}
          </div>
          ${li < layers.length - 1 ? html`<div class="rm-arrow" aria-hidden="true">→</div>` : null}
        `)}
      </div>
    </section>
  `;
}
