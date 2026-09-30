// FG-817: a role page (#roles/<role>[/<tab>]) — ten tabs (FG-827), each captioned with
// the source it was read from: overview, instructions (a Files panel over every
// composition source with Read / Raw / Composed views), harness (one `forge model
// resolve` row per activity, then the container), skills, capabilities, tools, secrets,
// tasks, receipts and usage. One read of GET /api/roles/:role per role. Read-only: a seed
// changes only through `forge upgrade`, so the page offers no edit — and a role is a
// seed, not an agent, so it carries no status of its own.
//
// Breadcrumbs are Roles › <role> › <tab>; Escape returns to the Roles list.
//
// FG-837: laid out after Paperclip's agent page — a 48px tile, the name, one meta line
// (runtime · model · family · mount) and the forge upgrade / forge model resolve hint;
// the Overview is a latest-task strip, four label/value cards and Recent tasks.

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { parentHash, roleTrail } from "./breadcrumbs-render.js";
import { hashFor } from "./view-routing.js";
import { Breadcrumbs, ObjectTabs, useEscapeTo } from "./object-page-view.js";
import { formatDuration, formatTimestamp } from "./format.js";
import { mountLabel } from "./roles-index-render.js";
import { RoleTile } from "./role-glyph-view.js";
import { TILE_SIZES, roleFamily } from "./role-glyph.js";
import {
  DEFAULT_USAGE_PERIOD, HARNESS_COLUMNS, USAGE_PERIODS, authLabel, harnessRows, latestTaskCard, overviewCards, percent, recentTaskRows,
  relationLabel, roleMeta, roleSubnav, roleTabLabel, roleTabs, shortSha, skillSourceLabel, tabCaption, tokens, usageWindow,
} from "./role-page-render.js";
import { InstructionsPanel } from "./instructions-panel-view.js";

const html = htm.bind(h);

function when(iso) {
  return formatTimestamp(iso);
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

// FG-837: at 900px and wider the tabs are a grouped left sub-nav (a plain nav of links,
// aria-current on the open one); under it they collapse to the FG-817 tablist. One or
// the other is rendered, never both, so there is one control per tab on screen.
const WIDE = "(min-width: 900px)";

function useWide() {
  const [wide, setWide] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

function SubnavIcon({ paths }) {
  return html`<svg class="role-subnav-icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths.map((d) => html`<path key=${d} d=${d} />`)}</svg>`;
}

function RoleSubnav({ role, current }) {
  return html`
    <nav class="role-subnav" aria-label="Role views">
      ${roleSubnav(role, current).map((g) => html`
        <div key=${g.id} class="role-subnav-group" data-group=${g.id}>
          <div class="role-subnav-label" id=${`role-subnav-${g.id}`}>${g.label}</div>
          <ul aria-labelledby=${`role-subnav-${g.id}`}>
            ${g.items.map((t) => html`
              <li key=${t.id}>
                <a class=${"role-subnav-item" + (t.current ? " role-subnav-current" : "")} href=${t.href} data-tab=${t.id} aria-current=${t.current ? "page" : undefined}>
                  <${SubnavIcon} paths=${t.icon} />${t.label}
                </a>
              </li>
            `)}
          </ul>
        </div>
      `)}
    </nav>
  `;
}

function RoleHead({ role, detail }) {
  const family = roleFamily(role);
  const meta = roleMeta(detail, family);
  return html`
    <div class="role-head">
      <${RoleTile} role=${role} size=${TILE_SIZES.page} />
      <div class="role-head-text">
        <h1 class="page-title">${role}</h1>
        ${detail ? html`<div class="role-meta" data-role-meta>${meta.runtime} · <span class="mono">${meta.model}</span> · ${meta.family} · ${meta.mount}</div>` : null}
      </div>
    </div>
    <p class="role-hint">A seed changes only through <code class="mono">forge upgrade</code>. Read why it runs where it does: <code class="mono">forge model resolve ${role}</code></p>
  `;
}

export function RolePage({ role, tab, project = null }) {
  const { detail, error } = useRoleDetail(role, project);
  const current = tab || "overview";
  const wide = useWide();
  useEscapeTo(parentHash("role", null));
  const body = html`
    <h2 class="role-panel-title" id="role-panel-title">${roleTabLabel(current)}</h2>
    ${error ? html`<div class="card" style="color: var(--err);" role="alert">${error}</div>` : null}
    ${!detail && !error ? html`<div class="muted">loading ${role}…</div>` : null}
    ${detail ? html`
      ${detail.storeError ? html`<div class="card muted role-notice" role="status">Store unreadable: ${detail.storeError}</div>` : null}
      <${RoleTab} tab=${current} detail=${detail} />
      <p class="role-caption role-footer" data-caption=${current}>${tabCaption(detail, current)}</p>
    ` : null}
  `;
  return html`
    <section class=${"object-page role-page" + (wide ? " role-page-wide" : "")} data-role=${role}>
      <div class="page-head object-head role-crumbs"><${Breadcrumbs} crumbs=${roleTrail(role, roleTabLabel(current))} /></div>
      <div class="role-layout">
        ${wide ? html`<${RoleSubnav} role=${role} current=${current} />` : null}
        <div class="role-main">
          <${RoleHead} role=${role} detail=${detail} />
          ${wide
            ? html`<div class="object-tabpanel role-panel" id="role-views-panel" role="region" aria-labelledby="role-panel-title">${body}</div>`
            : html`<${ObjectTabs} id="role-views" label="Role views" tabs=${roleTabs(role, current)}>${body}<//>`}
        </div>
      </div>
    </section>
  `;
}

function RoleTab({ tab, detail }) {
  switch (tab) {
    case "instructions": return html`<${InstructionsPanel} key=${detail.instructions.sha256 ?? "refused"} i=${detail.instructions} />`;
    case "harness": return html`<${HarnessTab} hn=${detail.harness} />`;
    case "skills": return html`<${SkillsTab} s=${detail.skills} />`;
    case "capabilities": return html`<${CapabilitiesTab} c=${detail.capabilities} role=${detail.role} />`;
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

function Card({ title, link, className = "", label = title, children }) {
  return html`
    <section class=${`role-card ${className}`} aria-label=${label}>
      <div class="role-card-head"><h3 class="role-card-title">${title}</h3>${link ? html`<a class="role-card-link" href=${link.href}>${link.label} →</a>` : null}</div>
      ${children}
    </section>
  `;
}

function Kv({ rows }) {
  return html`
    <dl class="role-kv">
      ${rows.map(([label, value, tone]) => html`<div key=${label}><dt>${label}</dt><dd class=${tone === "mono" ? "mono" : tone === "err" ? "role-err" : ""}>${value}</dd></div>`)}
    </dl>
  `;
}

function OverviewTab({ detail }) {
  const o = detail.overview;
  const latest = latestTaskCard(o);
  const cards = overviewCards(detail, roleFamily(detail.role));
  const recent = recentTaskRows(o);
  return html`
    <div class="role-overview">
      <section class="role-latest" aria-label="Latest task" data-latest-task=${latest?.taskId ?? ""}>
        ${latest ? html`
          <span class=${`badge ${latest.token.class}`} data-token=${latest.token.tone}>${latest.token.label}</span>
          <a class="mono role-latest-id" href=${latest.href}>${latest.taskId}</a>
          <a class="role-latest-title" href=${latest.runHref}>${latest.runLabel}</a>
          <span class="role-latest-when" title=${latest.title} data-relative>${latest.when}</span>
        ` : html`<span class="muted">No task recorded for this role.</span>`}
      </section>
      <div class="role-card-grid">
        <${Card} title="Identity" link=${cards.identity.link} className="role-card-identity"><${Kv} rows=${cards.identity.rows} /><//>
        <${Card} title="Harness / Runtime" link=${cards.harness.link} className="role-card-harness"><${Kv} rows=${cards.harness.rows} /><//>
        <${Card} title="Capabilities" link=${cards.capabilities.link} className="role-card-capabilities"><${Kv} rows=${cards.capabilities.rows} /><//>
        <${Card} title="Skills" link=${cards.skills.link} className="role-skill-chips">
          ${cards.skills.chips.length === 0 && cards.skills.hostOnly.length === 0 ? html`<div class="muted">No skill is mounted into this role's container.</div>` : null}
          <div class="role-chips">
            ${cards.skills.chips.map((c) => html`<a key=${c.name} class="role-chip" href=${c.href} data-chip=${c.name}>${c.name}</a>`)}
            ${cards.skills.hostOnly.length > 0 ? html`<span class="role-chip role-chip-host" data-host-only>host: ${cards.skills.hostOnly.join(" · ")}</span>` : null}
          </div>
        <//>
        <${Card} title="Last 30 days" className="role-card-wide role-card-ops"><${Kv} rows=${[
          ["Success rate", o.ops ? `${percent(o.ops.successRate)} of ${o.ops.terminal} finished` : "—"],
          ["Median duration", o.ops && o.ops.medianMs !== null ? formatDuration(o.ops.medianMs) : "—"],
          ["Tokens", o.usage ? `${tokens(o.usage.inputTokens)} in · ${tokens(o.usage.outputTokens)} out · ${o.usage.requests} requests` : "—"],
        ]} /><//>
      </div>
      <div class="role-section-head"><h3 class="role-card-title">Recent tasks</h3><a class="role-card-link" href=${hashFor({ view: "roles", id: detail.role, tab: "tasks" })}>See all →</a></div>
      ${recent.length === 0 ? html`<div class="muted">No task recorded for this role.</div>` : html`
        <ul class="role-task-rows">
          ${recent.map((t) => html`
            <li key=${t.taskId} class="role-task-row" data-recent-task=${t.taskId}>
              <span class="role-task-main"><a class="mono" href=${t.href}>${t.taskId}</a><span class="role-task-title">${t.title}</span></span>
              <span class="role-task-meta" title=${t.when}>${t.meta}</span>
            </li>
          `)}
        </ul>`}
    </div>
  `;
}

function Caption({ children }) {
  return html`<p class="role-source faint">${children}</p>`;
}

function HarnessTab({ hn }) {
  const rows = harnessRows(hn);
  const c = hn.container;
  return html`
    <div class="role-harness">
      <h2 class="role-h2">Resolution by activity</h2>
      <${Caption}>Each row is <code class="screen-verb">${"forge model resolve <role> --activity <a> --json"}</code>, resolved by the same call.</${Caption}>
      ${hn.policyError ? html`<div class="card" style="color: var(--err);" role="alert">Model policy unreadable: ${hn.policyError}</div>` : null}
      <div class="runs-table-wrap">
        <table class="runs-table role-harness-table">
          <thead><tr>${HARNESS_COLUMNS.map(([, label]) => html`<th key=${label}>${label}</th>`)}</tr></thead>
          <tbody>
            ${rows.map((row) => html`
              <tr key=${row.activity} data-activity=${row.activity}>
                <td class="mono">${row.activity}${row.isDefault ? html` <span class="faint">(default)</span>` : null}</td>
                ${row.error ? html`<td colspan=${HARNESS_COLUMNS.length - 1} style="color: var(--err);">${row.error}</td>`
                  : HARNESS_COLUMNS.slice(1).map(([key]) => html`<td key=${key} data-col=${key} title=${key === "mapping" ? row.mappingSummary ?? undefined : undefined}>${row.cells[key]}</td>`)}
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <h2 class="role-h2">Container</h2>
      <${Caption}>${c.source}</${Caption}>
      <div class="runs-table-wrap">
        <table class="runs-table role-mounts">
          <thead><tr><th>Mount</th><th>Mode</th><th>Host</th><th>Source</th></tr></thead>
          <tbody>
            ${c.mounts.map((m) => html`
              <tr key=${m.path} data-mount=${m.path}>
                <td class="mono">${m.path}</td>
                <td data-col="mode">${m.mode}${m.optional ? html` <span class="faint">optional</span>` : null}</td>
                <td class="mono faint">${m.source}</td>
                <td class="faint">${m.caption}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <${Facts} rows=${[
        ["Auth volume", html`<span data-auth-volume>${c.authVolume.volume ? html`<span class="mono">${c.authVolume.volume}</span> → ${c.authVolume.path} (${c.authVolume.mode})` : `none (auth.mode ${c.authVolume.authMode ?? "unknown"})`}</span> <div class="faint">${c.authVolume.source}</div>`],
        ["Skill mounts", html`${c.skillMounts.length === 0 ? "none" : c.skillMounts.map((m) => `${m.name} → ${m.container} (${m.mode}${m.optional ? ", optional" : ""})`).join("; ")} <div class="faint">the runtime's mounts under /.claude/skills/</div>`],
        ["Idle timeout", html`<span data-idle-timeout>${c.idleTimeout.seconds ?? "—"} s${c.idleTimeout.override ? ` (overridden: ${c.idleTimeout.override} ms)` : ""}</span> <div class="faint">${c.idleTimeout.source}</div>`],
        ["Network", html`${c.network.mode} <div class="faint">${c.network.source}</div>`],
        ["Runtime bound by", hn.runtimeBoundBy],
        ["Auth strategy", hn.authStrategy ?? "—"],
      ]} />
      <details class="role-raw" data-raw-files>
        <summary>Raw settings.json and runtime YAML — published by forge upgrade</summary>
        <p class="muted" data-edit-paths>Edit paths: ${hn.edit.settings}; ${hn.edit.runtime}; ${hn.edit.policy}.</p>
        <h3>settings.json</h3>
        ${!hn.settings.present ? html`<div class="card muted" role="status" data-settings-missing>This seed has no settings.json at ${hn.settings.path}: the generation forge upgraded from did not carry one.</div>`
          : html`<pre class="role-prompt">${hn.settings.text}</pre>`}
        ${hn.settings.error ? html`<div class="card" style="color: var(--err);" role="alert">${hn.settings.error}</div>` : null}
        <h3>Runtime ${hn.runtime.name}</h3>
        ${hn.runtime.error ? html`<div class="card" style="color: var(--err);" role="alert">${hn.runtime.error}</div>` : html`<pre class="role-prompt">${hn.runtime.text}</pre>`}
      </details>
    </div>
  `;
}

function SkillRow({ k, children }) {
  return html`
    <li class="role-skill" data-skill=${k.name}>
      <div class="role-skill-head">
        <span class="mono role-skill-name">${k.name}</span>
        ${children}
      </div>
      <div class="role-skill-desc" data-description>${k.description ?? html`<span class="faint">no SKILL.md description</span>`}</div>
    </li>
  `;
}

function SkillsTab({ s }) {
  return html`
    <div class="role-skills">
      <section class="role-skill-group" data-group="mounted">
        <div class="role-skill-group-head">Mounted into this role's container <span class="faint">${s.mounted.length}</span></div>
        ${s.runtimeError ? html`<div class="card muted" role="status">Runtime unreadable: ${s.runtimeError}</div>` : null}
        ${s.mounted.length === 0 ? html`<div class="muted role-skill-empty">The bound runtime mounts no skill.</div>` : html`
          <ul class="role-skill-list">
            ${s.mounted.map((k) => html`
              <${SkillRow} key=${k.container} k=${k}>
                <span class="role-badge" data-source=${k.source}>${skillSourceLabel(k.source)}</span>
                ${k.optional ? html`<span class="role-badge" data-optional>optional</span>` : null}
                <span class="role-badge" data-referenced=${k.referencedBySeed ? "yes" : "no"}>${k.referencedBySeed ? "referenced by seed" : "not referenced by seed"}</span>
                ${!k.present ? html`<span class="role-badge role-badge-warn" data-absent>host path absent — skipped at dispatch</span>` : null}
              <//>
              <li class="role-skill-mount faint" key=${`${k.container}-mount`}>${k.hostPath ?? k.host} → ${k.container} (${k.mode})</li>
            `)}
          </ul>`}
      </section>
      <section class="role-skill-group" data-group="available">
        <div class="role-skill-group-head">Available, not mounted <span class="faint">${s.available.length}</span></div>
        <div class="muted role-skill-empty" data-available-note>${s.availableNote}</div>
      </section>
      <section class="role-skill-group" data-group="host-only">
        <div class="role-skill-group-head">Host only — the orchestrator session's; no container receives them <span class="faint">${s.hostOnly.length}</span></div>
        ${s.hostOnly.length === 0 ? html`<div class="muted role-skill-empty">No host skill ships with this release.</div>` : html`
          <ul class="role-skill-list">
            ${s.hostOnly.map((k) => html`<${SkillRow} key=${k.name} k=${k}><span class="role-badge" data-source="forge-bundled">Forge bundled</span><//>`)}
          </ul>`}
      </section>
    </div>
  `;
}

function CapabilitiesTab({ c, role }) {
  return html`
    <div class="role-capabilities">
      <section class="role-card role-access-card" aria-label="Effective access">
        <div class="role-card-label">What ${role} may do — derived, not typed</div>
        <${Facts} rows=${[
          ["Mount", html`<span data-mount-mode>${mountLabel(c.mountMode.mode)}</span> <span class="faint">(${c.mountMode.source})</span>`],
          ["Activities", html`<span data-activities>${c.activities.map((a) => a.activity).join(", ")}</span> <span class="faint">(model policy; see Harness / Runtime)</span>`],
        ]} />
      </section>
      <h2 class="role-h2">Routes naming ${role}</h2>
      <${Caption}>The compiled routing policy ${c.routingPolicy.path ?? "(none)"}, as forge route explain reads it.</${Caption}>
      ${!c.routingPolicy.available ? html`<div class="muted">No compiled routing policy in the seed generation.</div>`
        : c.routes.length === 0 ? html`<div class="muted">No route names this role.</div>`
        : html`<ul class="role-routes">${c.routes.map((rt) => html`<li key=${rt.route} data-route=${rt.route}><span class="mono">${rt.route}</span> <span class="faint">${rt.path}</span> — ${relationLabel(rt.relations)}</li>`)}</ul>`}
      <h2 class="role-h2">Result contract</h2>
      <${Caption}>${c.resultContract.source ?? "the seed and protocol declare no output schema block"}</${Caption}>
      ${!c.resultContract.declared ? html`<div class="muted" data-contract-undeclared>not declared</div>`
        : html`<div class="role-chips" data-contract>${c.resultContract.fields.map((f) => html`<span key=${f.name} class="role-chip mono" title=${f.source} data-field=${f.name}>${f.name}</span>`)}</div>`}
      <h2 class="role-h2">Constraints it runs under</h2>
      <${Caption}>Host constraints and any project layer, as dispatch resolves them; force-level ones become each red's anti-prompt.</${Caption}>
      ${c.constraintsError ? html`<div class="card" style="color: var(--err);" role="alert">${c.constraintsError}</div>` : null}
      ${c.constraints.length === 0 ? html`<div class="muted">No constraint applies to this role.</div>` : html`
        <ul class="role-list">
          ${c.constraints.map((k) => html`
            <li key=${k.id} data-constraint=${k.id} data-level=${k.level}>
              <span class="role-badge">${k.level}</span> <span class="mono">${k.file ? k.file.split("/").pop() : k.id}</span>
              ${k.heading ? html` — ${k.heading}` : null}
              <span class="faint"> · ${k.scope}${k.active ? "" : ` · inactive: ${k.note}`}</span>
            </li>
          `)}
        </ul>`}
    </div>
  `;
}

function ToolsTab({ t }) {
  const e = t.effective;
  return html`
    <div class="role-tools">
      <div class="role-cards">
        <section class="role-card" aria-label="Declared tools">
          <div class="role-card-label">Declared (settings.json)</div>
          <p class="role-flag" data-tools-flag>${t.note}</p>
          ${!t.settingsPresent ? html`<div class="muted">No settings.json, so no tools are declared.</div>`
            : t.declared === null ? html`<div class="muted">settings.json declares no tools list.</div>`
            : html`<ul class="role-list">${t.declared.map((name) => html`<li key=${name} class="mono">${name}</li>`)}</ul>`}
        </section>
        <section class="role-card role-effective" aria-label="Effective access" data-effective>
          <div class="role-card-label">Effective access</div>
          <${Facts} rows=${[
            ["Mounts", html`<ul class="role-list">${e.mounts.map((m) => html`<li key=${m.path} data-effective-mount=${m.path}><span class="mono">${m.path}</span> ${m.mode}${m.optional ? " (optional)" : ""}</li>`)}</ul>`],
            ["Network", html`<span data-network>${e.network.mode}</span>`],
            ["MCP", html`<span data-mcp>${e.mcp}</span>`],
          ]} />
        </section>
      </div>
      <h2 class="role-h2">Image toolchain <span class="mono faint">${e.toolchain.image ?? ""}</span></h2>
      <${Caption}>${e.toolchain.source ? `${e.toolchain.source} — ${e.toolchain.note}` : e.toolchain.note}</${Caption}>
      ${e.toolchain.entries === null ? html`<div class="muted" data-toolchain-unknown>unknown</div>` : html`
        <div class="role-chips" data-toolchain>
          ${e.toolchain.entries.map((x) => html`<span key=${x.name} class="role-chip mono" title=${x.via} data-tool=${x.name}>${x.name}${x.version ? ` ${x.version}` : ""}</span>`)}
        </div>`}
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
  const [since, setSince] = useState(DEFAULT_USAGE_PERIOD);
  const w = usageWindow(u, since);
  return html`
    <div class="role-usage">
      <div class="instr-modes role-periods" role="group" aria-label="Period">
        ${USAGE_PERIODS.map((p) => html`<button key=${p} type="button" class=${"instr-mode" + (p === since ? " instr-mode-current" : "")} data-period=${p} aria-pressed=${p === since ? "true" : "false"} onClick=${() => setSince(p)}>${p}</button>`)}
      </div>
      ${!w ? html`<div class="muted">No usage window ${since}.</div>` : html`
        <div class="role-cards">
          <section class="role-card" data-window=${w.since}>
            <div class="role-card-label">Tokens (${w.since})</div>
            <div class="role-usage-total">${tokens(w.inputTokens)} in · ${tokens(w.outputTokens)} out · ${tokens(w.cacheReadTokens)} cache read · ${tokens(w.cacheCreationTokens)} cache write</div>
            <div class="faint">${w.requests} requests</div>
          </section>
        </div>
        <h2 class="role-h2">By provider</h2>
        <div class="runs-table-wrap">
          <table class="runs-table role-usage-provider">
            <thead><tr><th>Provider</th><th>Auth</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr></thead>
            <tbody>
              ${w.byProvider.length === 0 ? html`<tr><td colspan="8" class="muted">No model call in this window.</td></tr>` : w.byProvider.map((p) => html`
                <tr key=${`${p.provider}-${p.auth}`} data-provider=${p.provider ?? "unrecorded"}>
                  <td class="mono">${p.provider ?? "(not recorded)"}</td><td>${authLabel(p.auth)}</td><td>${p.requests}</td>
                  <td>${tokens(p.inputTokens)}</td><td>${tokens(p.outputTokens)}</td><td>${tokens(p.cacheReadTokens)}</td><td>${tokens(p.cacheCreationTokens)}</td>
                  <td data-cost>${p.cost === null ? p.costNote : p.cost}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        <h2 class="role-h2">By model</h2>
        <div class="runs-table-wrap">
          <table class="runs-table role-usage-model">
            <thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead>
            <tbody>
              ${w.byModel.length === 0 ? html`<tr><td colspan="6" class="muted">No model call in this window.</td></tr>` : w.byModel.map((m) => html`
                <tr key=${m.model} data-model=${m.model}>
                  <td class="mono">${m.model}</td><td>${m.requests}</td><td>${tokens(m.inputTokens)}</td><td>${tokens(m.outputTokens)}</td><td>${tokens(m.cacheReadTokens)}</td><td>${tokens(m.cacheCreationTokens)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>`}
      <p class="muted" data-pricing>Cost: ${u.pricing.note}.</p>
      <p class="muted">Ceilings: ${u.ceilings}</p>
    </div>
  `;
}
