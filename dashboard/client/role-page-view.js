// FG-817: a role page (#roles/<role>[/<tab>]) — nine tabs, each captioned with the
// source it was read from: overview, instructions (the composed prompt a container
// receives, sections marked, with its content hash), skills, configuration, secrets,
// tools, tasks, receipts and usage. One read of GET /api/roles/:role per role. Read-only:
// a seed changes only through `forge upgrade`, so the page offers no edit.
//
// Breadcrumbs are Roles › <role> › <tab>; Escape returns to the Roles list.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { parentHash, roleTrail } from "./breadcrumbs-render.js";
import { hashFor } from "./view-routing.js";
import { ObjectHead, ObjectTabs, useEscapeTo } from "./object-page-view.js";
import { formatDuration } from "./duration.js";
import { mountLabel } from "./roles-index-render.js";
import {
  instructionSections, percent, relationLabel, roleHeader, roleTabLabel, roleTabs, shortSha, tabCaption, tokens,
} from "./role-page-render.js";

const html = htm.bind(h);

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function useRoleDetail(role, project) {
  const [state, setState] = useState({ key: null, detail: null, error: null });
  const key = `${role}\n${project ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/roles/${encodeURIComponent(role)}${project ? `?project=${encodeURIComponent(project)}` : ""}`)
      .then(async (res) => {
        if (res.ok) return { detail: await res.json(), error: null };
        if (res.status === 400) return { detail: null, error: (await res.json().catch(() => ({}))).error ?? `Role read refused (HTTP 400).` };
        return { detail: null, error: res.status === 404 ? `No role seed named ${role}.` : `Role read failed (HTTP ${res.status}).` };
      })
      .catch((e) => ({ detail: null, error: String(e) }))
      .then((next) => { if (!cancelled) setState({ key, ...next }); });
    return () => { cancelled = true; };
  }, [key]);
  return state.key === key ? state : { key, detail: null, error: null };
}

export function RolePage({ role, tab, project = null }) {
  const { detail, error } = useRoleDetail(role, project);
  const current = tab || "overview";
  useEscapeTo(parentHash("role", null));
  return html`
    <section class="object-page role-page" data-role=${role}>
      <${ObjectHead} crumbs=${roleTrail(role, roleTabLabel(current))} title=${role} header=${roleHeader(role, detail)} />
      <${ObjectTabs} id="role-views" label="Role views" tabs=${roleTabs(role, current)}>
        ${error ? html`<div class="card" style="color: var(--err);" role="alert">${error}</div>` : null}
        ${!detail && !error ? html`<div class="muted">loading ${role}…</div>` : null}
        ${detail ? html`
          <p class="role-caption muted" data-caption=${current}>${tabCaption(detail, current)}</p>
          ${detail.storeError ? html`<div class="card muted role-notice" role="status">Store unreadable: ${detail.storeError}</div>` : null}
          <${RoleTab} tab=${current} detail=${detail} />
        ` : null}
      <//>
    </section>
  `;
}

function RoleTab({ tab, detail }) {
  switch (tab) {
    case "instructions": return html`<${InstructionsTab} i=${detail.instructions} />`;
    case "skills": return html`<${SkillsTab} s=${detail.skills} />`;
    case "configuration": return html`<${ConfigurationTab} c=${detail.configuration} />`;
    case "secrets": return html`<p class="role-secrets" data-secrets>${detail.secrets.text}</p>`;
    case "tools": return html`<${ToolsTab} t=${detail.tools} />`;
    case "tasks": return html`<${TasksTab} rows=${detail.tasks.rows} />`;
    case "receipts": return html`<${ReceiptsTab} r=${detail.receipts} />`;
    case "usage": return html`<${UsageTab} u=${detail.usage} />`;
    default: return html`<${OverviewTab} detail=${detail} />`;
  }
}

function Facts({ rows }) {
  return html`
    <dl class="role-facts">
      ${rows.map(([label, value]) => html`<div key=${label}><dt>${label}</dt><dd>${value}</dd></div>`)}
    </dl>
  `;
}

function TaskLinks({ taskId }) {
  return html`<a class="mono" href=${hashFor({ view: "task", id: taskId })}>${taskId}</a> (<a href=${hashFor({ view: "task", id: taskId, tab: "explain" })}>explain</a>)`;
}

function OverviewTab({ detail }) {
  const o = detail.overview;
  const r = o.resolution;
  const profile = r.error ? html`<span style="color: var(--err);">unresolved: ${r.error}</span>`
    : r.profile ? `${r.profile} · ${r.model ?? "—"}${r.effort ? ` · effort ${r.effort}` : ""}` : `legacy (no model policy)${r.model ? ` · ${r.model}` : ""}`;
  return html`
    <div class="role-overview">
      <p class="role-description-full">${o.description || "(the seed has no description paragraph)"}</p>
      <${Facts} rows=${[
        ["Default activity", r.activity],
        ["Resolved profile", profile],
        ["Resolved by", r.resolvedBy ?? "—"],
        ["Mount", html`${mountLabel(o.mountMode.mode)} <span class="faint">(${o.mountMode.source})</span>`],
        ["Seed generation", detail.generation ? html`<span class="mono">${detail.generation.id}</span>` : "none published"],
        ["Protocol sha", o.protocolSha ? html`<span class="mono" title=${o.protocolSha}>${shortSha(o.protocolSha)}</span>` : "none (not a covered role)"],
        ["Success rate (30d)", o.ops ? `${percent(o.ops.successRate)} of ${o.ops.terminal} finished` : "—"],
        ["Median duration (30d)", o.ops && o.ops.medianMs !== null ? formatDuration(o.ops.medianMs) : "—"],
        ["Tokens (30d)", o.usage ? `${tokens(o.usage.inputTokens)} in · ${tokens(o.usage.outputTokens)} out · ${o.usage.requests} requests` : "—"],
      ]} />
      <h2 class="role-h2">Routes naming ${detail.role}</h2>
      ${!o.routingPolicy.available ? html`<div class="muted">No compiled routing policy in the seed generation.</div>`
        : o.routes.length === 0 ? html`<div class="muted">No route names this role.</div>`
        : html`<ul class="role-routes">${o.routes.map((rt) => html`<li key=${rt.route} data-route=${rt.route}><span class="mono">${rt.route}</span> <span class="faint">${rt.path}</span> — ${relationLabel(rt.relations)}</li>`)}</ul>`}
      <h2 class="role-h2">Recent tasks</h2>
      ${o.recentTasks.length === 0 ? html`<div class="muted">No task recorded for this role.</div>`
        : html`<ul class="role-list">${o.recentTasks.map((t) => html`<li key=${t.taskId}><${TaskLinks} taskId=${t.taskId} /> <span class="faint">${t.status} · ${when(t.createdAt)}</span></li>`)}</ul>`}
    </div>
  `;
}

function InstructionsTab({ i }) {
  if (!i.ok) {
    return html`
      <div class="role-instructions">
        <p class="muted">Composed as ${i.context}.</p>
        <div class="card" style="color: var(--err);" role="alert" data-refusal>Dispatch would refuse this role: ${i.refusal}</div>
      </div>
    `;
  }
  return html`
    <div class="role-instructions">
      <p class="muted">Composed as ${i.context}. Content hash <span class="mono" data-prompt-sha>${i.sha256}</span>.</p>
      ${i.constraintsSkipped.length > 0 ? html`<p class="muted">Constraints toggled off: ${i.constraintsSkipped.map((s) => `${s.id} (${s.reason})`).join(", ")}</p>` : null}
      ${instructionSections(i).map((s, n) => html`
        <section key=${n} class=${`role-prompt-section role-prompt-${s.kind}`} data-section=${s.kind} data-constraint=${s.id ?? undefined}>
          <div class="role-prompt-label">${s.title}</div>
          <pre class="role-prompt">${s.text}</pre>
        </section>
      `)}
    </div>
  `;
}

function SkillsTab({ s }) {
  return html`
    <div class="role-skills">
      <h2 class="role-h2">Container skills (mounted read-only)</h2>
      ${s.runtimeError ? html`<div class="card muted" role="status">Runtime unreadable: ${s.runtimeError}</div>` : null}
      ${s.container.length === 0 ? html`<div class="muted">The bound runtime mounts no skill.</div>`
        : html`<ul class="role-list">${s.container.map((m) => html`<li key=${m.container} data-skill=${m.name}><span class="mono">${m.name}</span> <span class="faint">${m.host} → ${m.container} (${m.mode}${m.optional ? ", optional" : ""})</span></li>`)}</ul>`}
      <h2 class="role-h2">Host skills (the orchestrator session's; no container receives them)</h2>
      ${s.host.length === 0 ? html`<div class="muted">No host skill ships with this release.</div>`
        : html`<ul class="role-list">${s.host.map((k) => html`<li key=${k.name}><span class="mono">${k.name}</span></li>`)}</ul>`}
    </div>
  `;
}

function ConfigurationTab({ c }) {
  const rt = c.runtime;
  return html`
    <div class="role-configuration">
      <h2 class="role-h2">settings.json</h2>
      ${!c.settings.present ? html`<div class="card muted" role="status" data-settings-missing>This seed has no settings.json at ${c.settings.path}: the generation forge upgraded from did not carry one.</div>`
        : html`<pre class="role-prompt">${c.settings.text}</pre>`}
      ${c.settings.error ? html`<div class="card" style="color: var(--err);" role="alert">${c.settings.error}</div>` : null}
      <h2 class="role-h2">Runtime bound by policy</h2>
      <${Facts} rows=${[
        ["Runtime", html`<span class="mono">${rt.name}</span>`],
        ["Bound by", c.runtimeBoundBy],
        ["Auth strategy", c.authStrategy ?? "—"],
        ["Image", rt.image ?? "—"],
      ]} />
      ${rt.error ? html`<div class="card" style="color: var(--err);" role="alert">${rt.error}</div>` : html`<pre class="role-prompt">${rt.text}</pre>`}
    </div>
  `;
}

function ToolsTab({ t }) {
  return html`
    <div class="role-tools">
      <p class="role-flag" data-tools-flag>${t.note}</p>
      ${!t.settingsPresent ? html`<div class="muted">No settings.json, so no tools are declared.</div>`
        : t.declared === null ? html`<div class="muted">settings.json declares no tools list.</div>`
        : html`<ul class="role-list">${t.declared.map((name) => html`<li key=${name} class="mono">${name}</li>`)}</ul>`}
      <p>MCP: ${t.mcp}</p>
    </div>
  `;
}

function TasksTab({ rows }) {
  if (rows.length === 0) return html`<div class="muted">No task recorded for this role.</div>`;
  return html`
    <div class="runs-table-wrap">
      <table class="runs-table role-tasks">
        <thead><tr><th>Task</th><th>Run</th><th>Status</th><th>Created</th><th>Duration</th></tr></thead>
        <tbody>
          ${rows.map((t) => html`
            <tr key=${t.taskId} data-task=${t.taskId}>
              <td><${TaskLinks} taskId=${t.taskId} /></td>
              <td><a href=${hashFor({ view: "run", id: t.runId })}>${t.runTitle || t.runId}</a></td>
              <td>${t.status}</td>
              <td>${when(t.createdAt)}</td>
              <td>${t.startedAt && t.completedAt ? formatDuration(new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime()) : "—"}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function ReceiptsTab({ r }) {
  return html`
    <div class="role-receipts">
      <h2 class="role-h2">Per-dispatch agentProtocol</h2>
      ${r.dispatches.length === 0 ? html`<div class="muted">No dispatch recorded for this role.</div>` : html`
        <ul class="role-list">
          ${r.dispatches.map((d) => html`
            <li key=${d.taskId} data-receipt=${d.taskId}>
              <${TaskLinks} taskId=${d.taskId} />
              ${!d.manifest ? html` <span class="faint">no manifest.json</span>`
                : d.protocol ? html` <span class="mono" title=${d.protocol.sha256}>${shortSha(d.protocol.sha256)}</span> <span class="faint">generation ${d.generation ?? "unknown"}</span>`
                : html` <span class="faint">no agentProtocol (not a covered role at dispatch)</span>`}
              ${d.mountMode ? html` <span class="faint">· /project ${d.mountMode}</span>` : null}
              ${d.dispatchRefused ? html` <span style="color: var(--err);">refused: ${d.dispatchRefused}</span>` : null}
            </li>
          `)}
        </ul>`}
      <h2 class="role-h2">Seed generations</h2>
      ${r.generations.length === 0 ? html`<div class="muted">No seed generation is published.</div>` : html`
        <ul class="role-list">
          ${r.generations.map((g) => html`<li key=${g.id} data-generation=${g.id}><span class="mono">${g.id}</span>${g.current ? html` <strong>current</strong>` : null} <span class="faint">${when(g.publishedAt)} · protocol ${g.protocolSha ? shortSha(g.protocolSha) : "none"}</span></li>`)}
        </ul>`}
      <h2 class="role-h2">Host-edit backups (FG-776)</h2>
      ${r.backups.length === 0 ? html`<div class="muted">No upgrade backed up an edit of this role's seed.</div>` : html`
        <ul class="role-list">${r.backups.map((b) => html`<li key=${b.dir}><span class="mono">${b.dir}</span> <span class="faint">${b.files.join(", ")}</span></li>`)}</ul>`}
    </div>
  `;
}

function UsageTab({ u }) {
  return html`
    <div class="role-usage">
      <div class="runs-table-wrap">
        <table class="runs-table">
          <thead><tr><th>Window</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Requests</th></tr></thead>
          <tbody>
            ${u.windows.map((w) => html`<tr key=${w.since} data-window=${w.since}><td>${w.since}</td><td>${tokens(w.inputTokens)}</td><td>${tokens(w.outputTokens)}</td><td>${tokens(w.cacheReadTokens)}</td><td>${tokens(w.cacheCreationTokens)}</td><td>${w.requests}</td></tr>`)}
          </tbody>
        </table>
      </div>
      ${u.byModel.length > 0 ? html`<h2 class="role-h2">By model</h2><ul class="role-list">${u.byModel.map((m) => html`<li key=${m.model}><span class="mono">${m.model}</span> <span class="faint">${tokens(m.inputTokens)} in · ${tokens(m.outputTokens)} out · ${m.requests} requests</span></li>`)}</ul>` : null}
      <p class="muted">Ceilings: ${u.ceilings}</p>
    </div>
  `;
}
