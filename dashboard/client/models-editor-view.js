// FG-835 part 2b: Setup › Models — the model policy, read and edited through the CLI gate.
//
// `#models` shows the policy in force (host file, or the scoped project's override), every
// role × activity it resolves to (the Harness rows), its backups and its audit tail.
// `#models?mode=edit` opens the editor on it: quick edit rewrites one line of the YAML, the
// YAML is dry-run through the real `POST /api/model-policy/propose` as it changes, and
// Propose then Apply (typed target + rationale) go through `POST /api/model-policy/propose|
// apply` — `forge model policy propose|apply`'s own gate. `?target=host|project` picks the
// file an apply replaces. Nothing is stored in the browser: a reload reopens the editor on
// the policy in force. The machine, the dry-run runner, the code editor and the APPLY card
// are FG-834's (raci-editor-state.js / raci-editor-view.js).

import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ApplyCard, CodeEditor, ErrorNote, Pill, postJson } from "./raci-editor-view.js";
import { AttributionClaimCaption } from "./governance.js";
import { badgeClass } from "./status-tokens.js";
import { MONO_CLASS, formatUtcMinute, shortSha } from "./format.js";
import {
  applyReadiness,
  beginApply,
  beginDryRun,
  beginPropose,
  claimedAttribution,
  createDryRunner,
  failApply,
  failDryRun,
  failPropose,
  isDirty,
  minutesLeft,
  proposalExpired,
  proposalLive,
  proposeReadiness,
  replaceDraft,
  setConfirmKey,
  setRationale,
  settleDryRun,
  settlePropose,
  visibleRows,
} from "./raci-editor-state.js";
import {
  MODEL_POLICY_GATE,
  addableRoles,
  applyBody,
  applyVerb,
  backupReadUrl,
  backupRows,
  modelChoices,
  modelPolicyReadUrl,
  modelsEditorHash,
  modelsEditorMode,
  openModelsEditor,
  policyAuditRows,
  policyFacts,
  policyOutline,
  proposalDiffRows,
  proposalSummary,
  proposeBody,
  quickEdit,
  requestedTarget,
  resolutionRows,
  roleHarnessHash,
  setProfileModel,
  setRoleOverride,
  settleModelsApply,
} from "./models-editor-state.js";

const html = htm.bind(h);

const INHERIT = "";

async function readPolicy(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function ModelsView({ scope, params }) {
  const mode = modelsEditorMode(params);
  const asked = requestedTarget(params, scope);
  const [read, setRead] = useState({ data: null, error: null });
  const [applied, setApplied] = useState(null);
  const [start, setStart] = useState(null);
  const [restoreError, setRestoreError] = useState(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      let data;
      if (asked === "host" || !scope?.project) data = await readPolicy(modelPolicyReadUrl("host", scope));
      else {
        data = await readPolicy(modelPolicyReadUrl("project", scope));
        // No explicit target: the project's override when it has one, else the host file.
        if (asked === null && data.source.kind !== "project") data = await readPolicy(modelPolicyReadUrl("host", scope));
      }
      if (mine === seq.current) setRead({ data, error: null });
    } catch (e) {
      if (mine === seq.current) setRead({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [asked, scope?.project, scope?.checkout]);

  useEffect(() => {
    setRead({ data: null, error: null });
    setApplied(null);
    setRestoreError(null);
    reload();
  }, [reload]);

  const go = (edit, target = asked) => {
    window.location.hash = modelsEditorHash(scope, { edit, target });
  };
  // A backup's bytes are read only now, one backup at a time — the list carries none.
  const restore = async (backup) => {
    setApplied(null);
    setRestoreError(null);
    try {
      const { text } = await readPolicy(backupReadUrl(read.data.target, backup.name));
      setStart({ text, origin: `backup:${backup.name}`, propose: true });
      go(true);
    } catch (e) {
      setRestoreError(`${backup.name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const data = read.data;
  if (read.error) return html`<div class="card raci-error mp-read-error">the model policy could not be read: ${read.error}</div>`;
  if (!data) return html`<div class="muted mp-loading">loading the model policy…</div>`;

  if (mode === "edit") {
    return html`<${ModelsEditor}
      key=${data.target.path}
      read=${data}
      scope=${scope}
      start=${start}
      onView=${() => { setStart(null); go(false); }}
      onApplied=${(result) => {
        setStart(null);
        setApplied(result);
        reload();
        go(false);
      }}
    />`;
  }
  return html`
    <section class="mp-view">
      <${PolicySource} read=${data} scope=${scope}
        actions=${html`<button type="button" class="raci-btn raci-btn-primary" data-mp="edit" onClick=${() => { setApplied(null); go(true); }}>Edit policy</button>`} />
      ${applied ? html`<${AppliedCard} applied=${applied} />` : null}
      <section class="workbench-section" role="region" aria-label="RESOLUTION — every role × activity in force">
        <div class="raci-label-row mp-label-row"><h2 class="workbench-section-label raci-inline-label">RESOLUTION</h2><span class="raci-spacer"></span>
          <span class="hint">in force · ${data.resolution.rows.length} role × activity rows</span></div>
        <${ResolutionTable} rows=${resolutionRows(data.resolution.rows, null)} target=${data.target} />
        <${HarnessHint} />
        ${data.resolution.policyError ? html`<div class="raci-error">the policy in force fails to load: ${data.resolution.policyError}</div>` : null}
      </section>
      <${BackupsTable} read=${data} onRestore=${restore} error=${restoreError} />
      <${RecordedTable} read=${data} />
    </section>
  `;
}

function PolicySource({ read, scope, actions }) {
  const facts = policyFacts(read);
  const target = read.target;
  const src = read.source;
  const chip = (kind) => html`<span class=${`badge ${kind === "project" ? "gov-src-project" : "gov-src-host"} mp-chip`} data-kind=${kind}>${kind}</span>`;
  const switchLink = target.kind === "host"
    ? scope?.project
      ? html` · <a class="mp-link" data-mp="target-project" href=${modelsEditorHash(scope, { edit: false, target: "project" })}>write a project override for ${projectName(scope, target)} instead</a>`
      : null
    : html` · <a class="mp-link" data-mp="target-host" href=${modelsEditorHash(scope, { edit: false, target: "host" })}>edit the host file instead</a>`;
  return html`
    <section class="workbench-section" role="region" aria-label="MODEL POLICY — source and apply target">
      <div class="raci-label-row mp-label-row mp-policy-label"><h2 class="workbench-section-label raci-inline-label">MODEL POLICY</h2><span class="raci-spacer"></span>${actions}</div>
      <div class="card mp-source">
        ${src.kind === "absent" ? chip("host") : chip(src.kind)}
        <span class=${`${MONO_CLASS} mp-path`} title=${src.path ?? ""}>${src.path ?? "no model-policy.yml — legacy resolution (runtime.models)"}</span>
        <span class="muted">${[facts.schemaVersion !== null ? `schema_version ${facts.schemaVersion}` : null, `${facts.profiles} profile${facts.profiles === 1 ? "" : "s"}`, `${facts.roles} role${facts.roles === 1 ? "" : "s"} resolved`].filter(Boolean).join(" · ")}</span>
        <span class="raci-spacer"></span>
        <span class="hint mp-target" data-target=${target.kind}>target of an apply from here: ${chip(target.kind)}${target.kind === "project" ? html` <span class=${MONO_CLASS} title=${target.path}>${target.project?.key}</span>` : null}${switchLink}</span>
        ${src.error ? html`<div class="raci-error mp-source-error">the policy in force fails to load: ${src.error.split("\n")[0]}</div>` : null}
      </div>
    </section>
  `;
}

function projectName(scope, target) {
  return target.project?.label ?? scope?.project ?? "this project";
}

function HarnessHint() {
  return html`<div class="hint mp-harness-hint">the same rows as each role's Harness / Runtime tab — a role opens its own</div>`;
}

function AppliedCard({ applied }) {
  return html`
    <section class="workbench-section raci-applied mp-applied" role="status" aria-label="Model policy change applied">
      <div class="card raci-result raci-result-ok">
        <div class="row" style="gap: 10px; align-items: baseline; flex-wrap: wrap;">
          <${Pill} state="applied" symbol="✓" detail=${`exit ${applied.exitCode}`} />
          ${applied.sha ? html`<span class=${`${MONO_CLASS} faint`} title=${applied.sha}>candidate ${shortSha(applied.sha, 8)}</span>` : null}
        </div>
        <pre class="raci-output">${applied.output}</pre>
        ${applied.verb ? html`<div class="hint">shelled <code class=${MONO_CLASS}>${applied.verb}</code></div>` : null}
      </div>
    </section>
  `;
}

function stateCells(s) {
  return {
    profile: s.profile ?? "legacy",
    model: s.model ?? "—",
    authRuntime: `${s.auth ?? "—"} · ${s.runtime ?? "—"}`,
    costTier: s.costTier ?? "—",
  };
}

function ResolutionTable({ rows, target, collapse = false }) {
  const [all, setAll] = useState(false);
  const { shown, hidden } = collapse && !all ? visibleRows(rows) : { shown: rows, hidden: 0 };
  return html`
    <div class="card raci-table-card">
      <table class="raci-table mp-resolution" aria-label="Every role × activity resolution">
        <thead><tr><th scope="col">Role</th><th scope="col">Activity</th><th scope="col">Profile</th><th scope="col">Model</th><th scope="col">Auth · runtime · tier</th></tr></thead>
        <tbody>
          ${shown.map((r) => {
            const c = stateCells(r.state);
            return html`<tr class=${r.tags.includes("changed") ? "raci-row-changed" : ""} data-role=${r.role} data-activity=${r.activity}>
              <td class=${`${MONO_CLASS} mp-role`}><a class="mp-role-link" href=${roleHarnessHash(r.role, target)}>${r.role}</a>${r.tags.map((t) => html` <span class=${`raci-tag mp-tag-${t}`}>${t}</span>`)}</td>
              <td title=${r.isDefault ? "the role's default activity" : ""}>${r.activity}</td>
              <td class=${MONO_CLASS}>${c.profile}</td>
              <td class=${MONO_CLASS}>${c.model}${r.was !== null ? html`<div class="mp-was">was ${r.was}</div>` : null}</td>
              <td class=${r.state.error ? "mp-cell-err" : "muted"}>${r.state.error ? r.state.error.split("\n")[0] : html`${c.authRuntime}<div class="mp-tier">tier ${c.costTier}</div>${r.tags.includes("undispatchable") ? html`<div class="mp-cell-err">${r.state.outcome === "activity_unmapped" ? "activity_unmapped" : `not dispatchable${r.state.outcome ? ` (${r.state.outcome})` : ""}`}</div>` : null}`}</td>
            </tr>`;
          })}
          ${hidden > 0 ? html`<tr><td class="muted">…</td><td colspan="4" class="muted">${hidden} more row${hidden === 1 ? "" : "s"} unchanged ·
            <button type="button" class="raci-link" data-mp="show-all" onClick=${() => setAll(true)}>show all</button></td></tr>` : null}
          ${rows.length === 0 ? html`<tr><td colspan="5" class="muted">no installed role resolves yet</td></tr>` : null}
        </tbody>
      </table>
    </div>
  `;
}

function BackupsTable({ read, onRestore, error }) {
  const rows = backupRows(read.backups.entries, read.maxCandidateBytes);
  return html`
    <section class="workbench-section mp-backups" role="region" aria-label="BACKUPS — earlier versions of the target">
      <h2 class="workbench-section-label">BACKUPS</h2>
      ${rows.length === 0
        ? html`<div class="muted">No backups beside ${read.target.path} yet — an apply keeps the file it replaces here.</div>`
        : html`<div class="card raci-table-card">
            <table class="raci-table" aria-label="Backups of the target, newest first">
              <thead><tr><th scope="col">When</th><th scope="col">File</th><th scope="col">sha256</th><th scope="col">Size</th><th scope="col" aria-label="Restore"></th></tr></thead>
              <tbody>
                ${rows.map((b, i) => html`<tr data-backup=${b.name}>
                  <td class=${MONO_CLASS} title=${b.timestamp}>${formatUtcMinute(b.timestamp, b.timestamp)}</td>
                  <td class=${`${MONO_CLASS} mp-file`} title=${b.name}>${b.name}</td>
                  <td class=${`${MONO_CLASS} muted`} title=${b.sha ?? ""}>${shortSha(b.sha, 8)}</td>
                  <td class="muted">${b.size}</td>
                  <td class="mp-restore-cell">
                    <button type="button" class="raci-btn" data-mp="restore" disabled=${b.blocked !== null}
                      title=${b.blocked ?? `Load ${b.name} into the editor and propose it`}
                      onClick=${() => onRestore(b)}>Restore…</button>
                    ${b.blocked !== null
                      ? html` <span class="hint mp-restore-blocked">${b.blocked}</span>`
                      : i === 0 ? html` <span class="hint">proposes this backup as the candidate</span>` : null}
                  </td>
                </tr>`)}
              </tbody>
            </table>
          </div>`}
      ${error ? html`<div class="raci-error mp-restore-error" role="alert">${error}</div>` : null}
    </section>
  `;
}

function RecordedTable({ read }) {
  const rows = policyAuditRows(read.audit.entries);
  return html`
    <section class="workbench-section raci-recorded mp-recorded" role="region" aria-label="RECORDED — model-policy audit log">
      <h2 class="workbench-section-label">RECORDED</h2>
      ${rows.length === 0
        ? html`<div class="muted">No model-policy changes recorded for this target yet.</div>`
        : html`<div class="card raci-table-card">
            <table class="raci-table raci-audit" aria-label="Model-policy audit log, newest first">
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Change</th><th scope="col">Rationale</th><th scope="col">Candidate</th></tr></thead>
              <tbody>
                ${rows.map((r) => html`<tr>
                  <td class=${MONO_CLASS} title=${r.timestamp ?? ""}>${formatUtcMinute(r.timestamp)}</td>
                  <td class="gov-audit-actor">${claimedAttribution(r.actor ?? r.who, r.who)}</td>
                  <td>${r.change}</td>
                  <td class="raci-rationale" title=${r.rationale ?? ""}>${r.rationale ?? html`<span class="muted">—</span>`}</td>
                  <td class=${`${MONO_CLASS} muted`} title=${r.sha ?? ""}>${shortSha(r.sha, 8)}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>`}
      ${read.audit.skippedLines > 0 ? html`<div class="hint">${read.audit.skippedLines} unreadable audit line(s) skipped</div>` : null}
      ${rows.length ? html`<${AttributionClaimCaption} />` : null}
    </section>
  `;
}

function ModelsEditor({ read, scope, start, onView, onApplied }) {
  const target = read.target;
  const [state, setState] = useState(() => openModelsEditor(read, start));
  const [now, setNow] = useState(() => Date.now());
  const [scrollTop, setScrollTop] = useState(0);
  const textareaRef = useRef(null);
  const runnerRef = useRef(null);
  if (runnerRef.current === null) {
    runnerRef.current = createDryRunner({
      post: (text, signal) => postJson("/api/model-policy/propose", proposeBody(target, text), signal),
      onStart: (seq) => setState((s) => beginDryRun(s, seq)),
      onSettle: (seq, text, response) => {
        setState((s) => settleDryRun(s, seq, text, response, MODEL_POLICY_GATE));
        // Every dashboard mutation shares four slots; a busy answer is retried, not shown as a verdict.
        if (response.status === 503) runnerRef.current.schedule(text);
      },
      onFail: (seq, _text, reason) => setState((s) => failDryRun(s, seq, reason)),
    });
  }

  const propose = async (text) => {
    runnerRef.current.cancel();
    setState(beginPropose);
    setNow(Date.now());
    try {
      const response = await postJson("/api/model-policy/propose", proposeBody(target, text));
      setState((s) => settlePropose(s, text, response, MODEL_POLICY_GATE));
      setNow(Date.now());
    } catch (e) {
      setState((s) => failPropose(s, e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => {
    if (start?.propose) propose(start.text);
    else runnerRef.current.now(state.draft);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(tick);
      runnerRef.current.cancel();
    };
  }, []);

  const onInput = (text) => {
    setState((s) => quickEdit(s, text));
    runnerRef.current.schedule(text);
  };
  const onQuick = (text) => {
    if (text === null || text === state.draft) return;
    onInput(text);
  };
  const restore = (backup) => {
    setState((s) => replaceDraft(s, backup.text, `backup:${backup.name}`));
    propose(backup.text);
  };
  const apply = async () => {
    const body = applyBody(state, target);
    setState(beginApply);
    try {
      const response = await postJson("/api/model-policy/apply", body);
      const next = settleModelsApply(state, response);
      setState((s) => settleModelsApply(s, response));
      if (next.mode === "applied") onApplied(next.applied);
    } catch (e) {
      setState((s) => failApply(s, e instanceof Error ? e.message : String(e)));
    }
  };

  const live = proposalLive(state);
  const sourcePill = live
    ? html`<${Pill} state="proposed" symbol="✓" detail=${`candidate ${shortSha(state.proposal.sha, 8)}`} />`
    : isDirty(state)
      ? html`<${Pill} state="edited" symbol="●" />`
      : html`<${Pill} state="unedited" symbol="●" />`;
  const origin = state.origin.startsWith("backup:") ? `backup ${state.origin.slice(7)}` : "the policy in force";

  return html`
    <section class="mp-view mp-editing">
      <${PolicySource} read=${read} scope=${scope} actions=${html`${sourcePill}
        <button type="button" class="raci-btn" data-mp="view" onClick=${onView}>View</button>`} />
      <${QuickEdit} state=${state} read=${read} onEdit=${onQuick} />
      <div class="raci-editor">
        <div class="raci-pane">
          <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">EDITOR</h2><span class="raci-spacer"></span><${EditorPill} state=${state} /></div>
          <${CodeEditor} value=${state.draft} findings=${state.dryRun.text === state.draft ? state.dryRun.findings : []} label="Model policy candidate YAML"
            onInput=${onInput} textareaRef=${textareaRef} scrollTop=${scrollTop} onScroll=${setScrollTop} />
          <${ErrorNote} state=${state} />
          <${ProposeBar} state=${state} onPropose=${() => propose(state.draft)} onDiscard=${onView} />
          <div class="hint raci-reload-hint">starting candidate: ${origin} · Unsaved edits live only in this page: a reload reopens the editor on the starting candidate.</div>
        </div>
        <div class="raci-pane">
          <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">RESOLUTION (DRY-RUN)</h2><span class="raci-spacer"></span><${ResolutionPill} state=${state} /></div>
          <${ResolutionTable} rows=${resolutionRows(read.resolution.rows, state.lastGreen)} target=${target} collapse=${true} />
          <${HarnessHint} />
        </div>
      </div>
      ${state.proposal || state.proposeError ? html`<${ProposalSection} state=${state} now=${now} />` : null}
      ${state.proposal ? html`<${ApplyCard} state=${state} ready=${applyReadiness(state, target.confirmKey, now, "the target")} setState=${setState} onApply=${apply}
        confirmLabel="Type the target to confirm" confirmKey=${target.confirmKey}
        hint=${html`shells <code class=${MONO_CLASS}>${applyVerb(target)}</code> · re-runs the gate before writing · never <code class=${MONO_CLASS}>--allow-undispatchable</code>`} />` : null}
      <${BackupsTable} read=${read} onRestore=${restore} />
      <${RecordedTable} read=${read} />
    </section>
  `;
}

function EditorPill({ state }) {
  const answered = state.dryRun.text === state.draft;
  const n = state.dryRun.findings.length;
  if (state.dryRun.error) return html`<${Pill} state="unavailable" symbol="⚠" />`;
  if (answered && state.dryRun.ok === false) {
    return html`<span class=${`${badgeClass("raci", "invalid")} raci-pill`} data-raci-state="invalid">✗ ${n} error${n === 1 ? "" : "s"}</span>`;
  }
  if (answered && state.dryRun.ok) return html`<${Pill} state="dry_run_ok" symbol="✓" />`;
  return html`<${Pill} state="checking" symbol="…" />`;
}

function ResolutionPill({ state }) {
  if (state.lastGreen) {
    return html`<span class=${`${badgeClass("raci", "dry_run_ok")} raci-pill`} data-raci-state="last_green">✓ from the last green dry-run</span>`;
  }
  if (state.dryRun.error) return html`<${Pill} state="unavailable" symbol="⚠" />`;
  return html`<span class=${`${badgeClass("raci", "checking")} raci-pill`} data-raci-state="in_force">… in force · waiting for a green dry-run</span>`;
}

function ProposeBar({ state, onPropose, onDiscard }) {
  const ready = proposeReadiness(state);
  return html`
    <div class="raci-bar">
      <button type="button" class="raci-btn raci-btn-primary" data-mp="propose" disabled=${!ready.enabled} aria-describedby="mp-propose-hint" onClick=${onPropose}>Propose</button>
      <span id="mp-propose-hint" class="hint">${ready.reason}</span>
      <span class="raci-spacer"></span>
      <button type="button" class="raci-btn raci-btn-danger" data-mp="discard" onClick=${onDiscard}>Discard edits</button>
    </div>
  `;
}

function QuickEdit({ state, read, onEdit }) {
  const outline = policyOutline(state.draft);
  const base = policyOutline(state.baseText);
  const baseModel = (profile, alias) => base.profiles.find((p) => p.name === profile)?.entries.find((e) => e.alias === alias)?.model ?? null;
  const baseOverride = (role) => base.overrides.entries.find((e) => e.role === role)?.profile ?? null;
  const profiles = outline.profiles.map((p) => p.name);
  const roles = addableRoles(outline, read.resolution.rows);
  const changedTag = html` <span class="raci-tag raci-tag-changed">changed</span>`;
  const offered = useRef(new Set()).current;
  const choices = (current) => {
    const list = modelChoices(outline, current, read.knownModels, base, offered);
    for (const m of list) offered.add(m);
    return list;
  };
  return html`
    <section class="workbench-section mp-quick-section" role="region" aria-label="QUICK EDIT — generates the YAML in the editor">
      <div class="raci-label-row mp-label-row"><h2 class="workbench-section-label raci-inline-label">QUICK EDIT</h2>
        <span class="hint">generates the YAML below; the editor stays the source of truth</span></div>
      ${!outline.ok
        ? html`<div class="card muted mp-quick-off">quick edit is unavailable: ${outline.reason} — edit the YAML in the editor</div>`
        : html`<div class="mp-quick">
            <div class="card mp-quick-card" role="group" aria-label="Profile → model">
              <h3>Profile → model</h3>
              ${outline.profiles.map((p) => p.entries.map((e, i) => html`<div class="mp-quick-row" data-profile=${p.name} data-alias=${e.alias}>
                <span class=${`${MONO_CLASS} mp-quick-name`}>${i === 0 ? p.name : ""}</span>
                <span class=${`${MONO_CLASS} mp-alias faint`}>${e.alias}</span>
                <select class=${MONO_CLASS} data-mp="model" aria-label=${`${p.name} · ${e.alias} model`} disabled=${e.at === null} value=${e.model ?? ""}
                  onChange=${(ev) => onEdit(setProfileModel(state.draft, p.name, e.alias, ev.currentTarget.value))}>
                  ${choices(e.model).map((m) => html`<option value=${m} selected=${m === e.model}>${m}</option>`)}
                </select>
                ${baseModel(p.name, e.alias) !== e.model ? changedTag : null}
              </div>`))}
              ${outline.profiles.length === 0 ? html`<div class="muted">no profiles in the draft</div>` : null}
            </div>
            <div class="card mp-quick-card" role="group" aria-label="Role override → profile">
              <h3>Role override → profile</h3>
              ${!outline.overrides.editable
                ? html`<div class="muted">${outline.overrides.reason}</div>`
                : html`
                  ${outline.overrides.entries.map((o) => html`<div class="mp-quick-row" data-role=${o.role}>
                    <span class=${`${MONO_CLASS} mp-quick-name`}>${o.role}</span>
                    <select class=${MONO_CLASS} data-mp="override" aria-label=${`${o.role} profile override`} value=${o.profile ?? INHERIT}
                      onChange=${(ev) => onEdit(setRoleOverride(state.draft, o.role, ev.currentTarget.value === INHERIT ? null : ev.currentTarget.value))}>
                      <option value=${INHERIT}>(inherit default)</option>
                      ${[...new Set([...(o.profile && !profiles.includes(o.profile) ? [o.profile] : []), ...profiles])].map((name) => html`<option value=${name} selected=${name === o.profile}>${name}</option>`)}
                    </select>
                    ${baseOverride(o.role) !== o.profile ? changedTag : null}
                  </div>`)}
                  <div class="mp-quick-row">
                    <select class="mp-add" data-mp="add-override" aria-label="Add a role override" disabled=${roles.length === 0 || profiles.length === 0}
                      onChange=${(ev) => {
                        const role = ev.currentTarget.value;
                        ev.currentTarget.value = "";
                        if (role) onEdit(setRoleOverride(state.draft, role, outline.defaultProfile && profiles.includes(outline.defaultProfile) ? outline.defaultProfile : profiles[0]));
                      }}>
                      <option value="">+ add a role override</option>
                      ${roles.map((r) => html`<option value=${r}>${r}</option>`)}
                    </select>
                  </div>`}
            </div>
          </div>`}
    </section>
  `;
}

function ProposalSection({ state, now }) {
  if (!state.proposal) {
    const e = state.proposeError;
    return html`
      <section class="workbench-section raci-proposal mp-proposal" role="region" aria-label="PROPOSAL">
        <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">PROPOSAL</h2><span class="raci-spacer"></span>
          <${Pill} state="gate_failed" symbol="✗" detail=${e.refusal ?? null} /></div>
        <div class="card raci-result raci-result-fail" role="alert">
          <pre class="raci-output">${e.message}</pre>
        </div>
      </section>
    `;
  }
  const p = state.proposal;
  const live = proposalLive(state);
  const left = minutesLeft(p.expiresAt, now);
  const summary = proposalSummary(p.result);
  const rows = proposalDiffRows(p.result);
  const pill = !live
    ? html`<${Pill} state="superseded" symbol="●" detail="propose again" />`
    : proposalExpired(p.expiresAt, now)
      ? html`<${Pill} state="expired" symbol="⚠" />`
      : html`<${Pill} state="gate_passed" symbol="✓" detail=${`candidate ${shortSha(p.sha, 8)}${left !== null ? ` · ${left < 1 ? "<1" : left} min left` : ""}`} />`;
  return html`
    <section class="workbench-section raci-proposal mp-proposal" role="region" aria-label="PROPOSAL">
      <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">PROPOSAL</h2><span class="raci-spacer"></span>${pill}</div>
      <div class="raci-summary mp-summary">
        <span><b class="raci-changed">~${summary.changed}</b> resolution${summary.changed === 1 ? "" : "s"} changed</span>
        ${summary.newlyUndispatchable ? html`<span><b class="raci-del">${summary.newlyUndispatchable}</b> newly undispatchable</span>` : null}
        ${summary.preExisting ? html`<span><b class="raci-del">${summary.preExisting}</b> undispatchable (pre-existing)</span>` : null}
        <span class="muted">${summary.runtimeText} · ${summary.authText}</span>
      </div>
      <div class="card raci-table-card">
        <table class="raci-table mp-diff" aria-label="Resolution diff, in force to candidate">
          <thead><tr><th scope="col">Role · activity</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
          <tbody>
            ${rows.map((r) => html`<tr data-row=${r.label}>
              <td class=${MONO_CLASS}>${r.label}${r.becomesUndispatchable ? html` <span class="raci-tag mp-tag-undispatchable">undispatchable</span>` : null}</td>
              <td class=${`${MONO_CLASS} muted`}>${r.before}</td>
              <td class=${MONO_CLASS}>${r.after}</td>
            </tr>`)}
            ${rows.length === 0 ? html`<tr><td colspan="3" class="muted">(no resolution change)</td></tr>` : null}
          </tbody>
        </table>
      </div>
    </section>
  `;
}
