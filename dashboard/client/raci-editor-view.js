// FG-834 part 2: Setup › Routing with its Edit RACI mode.
//
// `#routing` is the read-only workbench (governance.js) with an Edit RACI button on the
// SOURCE row; `#routing?mode=edit` opens the editor on the effective source. Every change
// is dry-run through the real `POST /api/raci/propose`; Propose, then Apply with the typed
// project key and a rationale, go through `POST /api/raci/propose|apply` — the CLI's own
// gate. The candidate text travels only in the request body; nothing is stored in the
// browser, so a reload reopens the editor on the starting candidate.

import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { GovernanceView, RecordedAudit, SourceSection } from "./governance.js";
import { badgeClass, statusLabel } from "./status-tokens.js";
import { MONO_CLASS, shortSha } from "./format.js";
import {
  RACI_SECTIONS,
  appliedResult,
  applyBody,
  applyReadiness,
  beginApply,
  beginDryRun,
  beginPropose,
  createDryRunner,
  diffLines,
  editDraft,
  effectiveRows,
  failApply,
  failDryRun,
  failPropose,
  forceRuleCheck,
  isDirty,
  lineOfOffset,
  minutesLeft,
  offsetOfLine,
  openEditor,
  proposalExpired,
  proposalLive,
  proposeReadiness,
  raciEditorHash,
  raciEditorMode,
  replaceDraft,
  routeChangeCounts,
  sectionLine,
  setConfirmKey,
  setRationale,
  settleApply,
  settleDryRun,
  settlePropose,
  visibleRows,
} from "./raci-editor-state.js";

const html = htm.bind(h);

const LINE_HEIGHT = 20;
const PAD_TOP = 12;
const list = (arr) => (arr && arr.length ? arr.join(", ") : "—");

// Shared with the model-policy editor (models-editor-view.js): the request helper, the pill,
// the line-numbered <textarea>, its findings list and the typed-confirmation APPLY card.
export async function postJson(path, body, signal) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = { ok: false, error: `HTTP ${res.status}` };
  }
  return { status: res.status, body: parsed };
}

export function Pill({ state, detail = null, symbol = null }) {
  return html`<span class=${`${badgeClass("raci", state)} raci-pill`} data-raci-state=${state}>
    ${symbol ? `${symbol} ` : ""}${statusLabel("raci", state)}${detail ? ` · ${detail}` : ""}
  </span>`;
}

export function RoutingView({ governance, scope, params, onRefresh }) {
  const mode = raciEditorMode(params);
  const project = scope?.project && scope?.checkout ? { key: scope.project, checkoutDir: scope.checkout } : null;
  const projectKey = project?.key ?? null;
  const checkoutDir = project?.checkoutDir ?? null;
  const [read, setRead] = useState({ data: null, error: null });
  const [applied, setApplied] = useState(null);

  const reload = useCallback(async () => {
    if (!projectKey) return;
    try {
      const q = new URLSearchParams({ project: projectKey, projectDir: checkoutDir });
      const res = await fetch(`/api/raci?${q.toString()}`);
      const body = await res.json();
      setRead(res.ok ? { data: body, error: null } : { data: null, error: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setRead({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [projectKey, checkoutDir]);

  useEffect(() => {
    setRead({ data: null, error: null });
    setApplied(null);
    reload();
  }, [reload]);

  const go = (edit) => {
    if (edit) setApplied(null);
    window.location.hash = raciEditorHash(scope, edit);
  };

  if (mode === "edit" && project && read.data) {
    return html`<${RaciEditor}
      key=${`${projectKey}\n${checkoutDir}`}
      read=${read.data}
      governance=${governance}
      onView=${() => go(false)}
      onApplied=${(result) => {
        setApplied(result);
        onRefresh?.();
        reload();
        go(false);
      }}
    />`;
  }

  const editButton = html`<button type="button" class="raci-btn raci-btn-primary" data-raci="edit" disabled=${!project}
    title=${project ? "Open this checkout's RACI in the editor" : "Select a project checkout: the host default is forge-owned and changes only through forge upgrade"}
    onClick=${() => go(true)}>Edit RACI</button>`;
  const note = !project
    ? html`<span class="hint">select a project checkout to edit its RACI override</span>`
    : mode === "edit" && read.error
      ? html`<span class="raci-error">the RACI source could not be read: ${read.error}</span>`
      : mode === "edit"
        ? html`<span class="hint">loading the RACI source…</span>`
        : null;
  return html`<${GovernanceView}
    data=${governance}
    sourceActions=${html`${note}${editButton}`}
    afterSource=${applied ? html`<${AppliedCard} applied=${applied} />` : null}
  />`;
}

function AppliedCard({ applied }) {
  return html`
    <section class="workbench-section raci-applied" role="status" aria-label="RACI change applied">
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

function RaciEditor({ read, governance, onView, onApplied }) {
  const project = read.project;
  const [state, setState] = useState(() => openEditor(read));
  const [now, setNow] = useState(() => Date.now());
  const [activeSection, setActiveSection] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const textareaRef = useRef(null);
  const runnerRef = useRef(null);
  if (runnerRef.current === null) {
    runnerRef.current = createDryRunner({
      post: (text, signal) => postJson("/api/raci/propose", { projectKey: project.key, projectDir: project.checkoutDir, candidate: text }, signal),
      onStart: (seq) => setState((s) => beginDryRun(s, seq)),
      onSettle: (seq, text, response) => {
        setState((s) => settleDryRun(s, seq, text, response));
        // Every dashboard mutation shares four slots; a busy answer is retried, not shown as a verdict.
        if (response.status === 503) runnerRef.current.schedule(text);
      },
      onFail: (seq, _text, reason) => setState((s) => failDryRun(s, seq, reason)),
    });
  }

  useEffect(() => {
    runnerRef.current.now(state.draft);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(tick);
      runnerRef.current.cancel();
    };
  }, []);

  const onInput = (text) => {
    setState((s) => editDraft(s, text));
    runnerRef.current.schedule(text);
  };
  const startFrom = (text, origin) => {
    setState((s) => replaceDraft(s, text, origin));
    runnerRef.current.now(text);
  };
  const jump = (id) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const line = sectionLine(ta.value, id, lineOfOffset(ta.value, ta.selectionStart));
    setActiveSection(id);
    if (line === null) return;
    const offset = offsetOfLine(ta.value, line);
    ta.focus();
    ta.setSelectionRange(offset, offset);
    ta.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT);
    setScrollTop(ta.scrollTop);
  };
  const propose = async () => {
    runnerRef.current.cancel();
    const text = state.draft;
    setState(beginPropose);
    setNow(Date.now());
    try {
      const response = await postJson("/api/raci/propose", { projectKey: project.key, projectDir: project.checkoutDir, candidate: text });
      setState((s) => settlePropose(s, text, response));
      setNow(Date.now());
    } catch (e) {
      setState((s) => failPropose(s, e instanceof Error ? e.message : String(e)));
    }
  };
  const apply = async () => {
    const body = applyBody(state, project);
    setState(beginApply);
    try {
      const response = await postJson("/api/raci/apply", body);
      setState((s) => settleApply(s, response));
      if (response.status === 200 && response.body.ok === true) onApplied(appliedResult(response.body));
    } catch (e) {
      setState((s) => failApply(s, e instanceof Error ? e.message : String(e)));
    }
  };

  const hostText = read.host?.text ?? null;
  const ownText = read.source.kind === "project" ? read.source.text : null;
  const live = proposalLive(state);
  const sourcePill = live
    ? html`<${Pill} state="proposed" symbol="✓" detail=${`candidate ${shortSha(state.proposal.sha, 8)}`} />`
    : isDirty(state)
      ? html`<${Pill} state="edited" symbol="●" />`
      : html`<${Pill} state="unedited" symbol="●" />`;
  const starting = state.origin === "host"
    ? html`starting candidate: the host default${ownText !== null ? html` · <button type="button" class="raci-link" data-raci="start-source" onClick=${() => startFrom(ownText, "source")}>start from this project's override instead</button>` : null}`
    : html`starting candidate: this project's override${hostText !== null ? html` · <button type="button" class="raci-link" data-raci="start-host" onClick=${() => startFrom(hostText, "host")}>start from the host default instead</button>` : null}`;

  return html`
    <section class="gov-view raci-editing">
      <${SourceSection}
        source=${governance?.source ?? { kind: read.source.kind, raciPath: read.source.path }}
        accountable=${governance?.derived?.accountable ?? "human"}
        boxed=${true}
        note=${html`<span class="hint">${starting}</span>`}
        actions=${html`${sourcePill}
          <button type="button" class="raci-btn" data-raci="view" onClick=${onView}>View</button>
          <button type="button" class="raci-btn raci-btn-primary" data-raci="edit" aria-pressed="true" disabled
            title="Editing this checkout's RACI — View returns to the read-only workbench">Edit RACI</button>`}
      />
      <div class="raci-editor">
        <div class="raci-pane">
          <div class="raci-sections" role="group" aria-label="Jump to a RACI section">
            <span class="hint">sections</span>
            ${RACI_SECTIONS.map((s) => html`<button type="button" class=${`raci-btn raci-section${activeSection === s.id ? " raci-section-on" : ""}`}
              data-section=${s.id} aria-pressed=${activeSection === s.id ? "true" : "false"} onClick=${() => jump(s.id)}>${s.label}</button>`)}
          </div>
          <${CodeEditor} value=${state.draft} findings=${state.dryRun.text === state.draft ? state.dryRun.findings : []}
            onInput=${onInput} textareaRef=${textareaRef} scrollTop=${scrollTop} onScroll=${setScrollTop} />
          <${ErrorNote} state=${state} />
          <${ProposeBar} state=${state} hostText=${hostText} onPropose=${propose} onReset=${() => startFrom(hostText, "host")} onDiscard=${onView} />
          <div class="hint raci-reload-hint">Unsaved edits live only in this page: a reload reopens the editor on the starting candidate.</div>
        </div>
        <div class="raci-pane">
          <${DryRunPane} state=${state} current=${governance?.effective?.routes ?? null} />
        </div>
      </div>
      ${state.proposal || state.proposeError ? html`<${ProposalSection} state=${state} now=${now} read=${read} />` : null}
      ${state.proposal ? html`<${ApplySection} state=${state} now=${now} project=${project} setState=${setState} onApply=${apply} />` : null}
      <${RecordedAudit} audit=${read.audit} />
    </section>
  `;
}

export function CodeEditor({ value, findings, onInput, textareaRef, scrollTop, onScroll, label = "RACI candidate source" }) {
  const count = value.split("\n").length;
  const errorLines = new Set(findings.map((f) => f.line).filter((n) => n !== null));
  const numbers = [];
  for (let n = 1; n <= count; n += 1) numbers.push(n);
  return html`
    <div class="raci-code">
      <div class="raci-gutter" aria-hidden="true">
        <div style=${`transform: translateY(${PAD_TOP - scrollTop}px)`}>
          ${numbers.map((n) => html`<div class=${errorLines.has(n) ? "raci-ln raci-ln-err" : "raci-ln"}>${n}</div>`)}
        </div>
      </div>
      <div class="raci-marks" aria-hidden="true">
        ${[...errorLines].map((n) => html`<div class="raci-errline" data-line=${n} style=${`top: ${PAD_TOP + (n - 1) * LINE_HEIGHT - scrollTop}px`}></div>`)}
      </div>
      <textarea ref=${textareaRef} class="raci-textarea" spellcheck="false" wrap="off" autocomplete="off"
        aria-label=${label} aria-describedby="raci-errnote" aria-invalid=${errorLines.size > 0 || findings.length > 0 ? "true" : "false"}
        value=${value} onInput=${(e) => onInput(e.currentTarget.value)} onScroll=${(e) => onScroll(e.currentTarget.scrollTop)}></textarea>
    </div>
  `;
}

export function ErrorNote({ state }) {
  const findings = state.dryRun.text === state.draft ? state.dryRun.findings : [];
  return html`<ul id="raci-errnote" class="raci-errnote" aria-live="polite">
    ${findings.map((f) => html`<li data-line=${f.line ?? ""}>${f.line !== null ? `line ${f.line} · ` : ""}${f.route && f.line === null ? `${f.route} · ` : ""}${f.message}</li>`)}
    ${state.dryRun.error ? html`<li class="raci-warn">dry-run unavailable: ${state.dryRun.error}</li>` : null}
  </ul>`;
}

function ProposeBar({ state, hostText, onPropose, onReset, onDiscard }) {
  const ready = proposeReadiness(state);
  return html`
    <div class="raci-bar">
      <button type="button" class="raci-btn raci-btn-primary" data-raci="propose" disabled=${!ready.enabled} aria-describedby="raci-propose-hint" onClick=${onPropose}>Propose</button>
      <span id="raci-propose-hint" class="hint">${ready.reason}</span>
      <span class="raci-spacer"></span>
      <button type="button" class="raci-btn" data-raci="reset" disabled=${hostText === null}
        title="The host default as the candidate — proposed and applied like any other edit, never a file delete" onClick=${onReset}>Reset to host default</button>
      <button type="button" class="raci-btn raci-btn-danger" data-raci="discard" onClick=${onDiscard}>Discard edits</button>
    </div>
  `;
}

function DryRunPane({ state, current }) {
  const answered = state.dryRun.text === state.draft;
  const n = state.dryRun.findings.length;
  const pill = state.dryRun.error
    ? html`<${Pill} state="unavailable" symbol="⚠" />`
    : answered && state.dryRun.ok === false
      ? html`<span class=${`${badgeClass("raci", "invalid")} raci-pill`} data-raci-state="invalid">✗ ${n} error${n === 1 ? "" : "s"} · routes from last green dry-run</span>`
      : answered && state.dryRun.ok
        ? html`<${Pill} state="dry_run_ok" symbol="✓" />`
        : html`<${Pill} state="checking" symbol="…" />`;
  const [all, setAll] = useState(false);
  const rows = effectiveRows(current, state.lastGreen?.routes ?? null);
  const { shown, hidden } = all ? { shown: rows, hidden: 0 } : visibleRows(rows);
  return html`
    <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">EFFECTIVE (DRY-RUN)</h2>${pill}</div>
    <div class="card raci-table-card">
      <table class="raci-table raci-effective" aria-label="Routes from the last green dry-run">
        <thead><tr><th scope="col">Route</th><th scope="col">Path</th><th scope="col">Responsible</th><th scope="col">Followups</th></tr></thead>
        <tbody>
          ${shown.map((r) => html`<tr class=${r.tag ? `raci-row-${r.tag}` : ""} data-route=${r.key}>
            <td class=${`${MONO_CLASS} raci-route`}>${r.key}${r.tag ? html` <span class=${`raci-tag raci-tag-${r.tag}`}>${r.tag}</span>` : null}</td>
            <td><span class="raci-chip">${r.route.path}</span></td>
            <td class=${MONO_CLASS}>${r.route.responsible}${r.wasResponsible ? html` <span class="muted">(was ${r.wasResponsible})</span>` : null}</td>
            <td>${list(r.route.required_followups)}</td>
          </tr>`)}
          ${hidden > 0 ? html`<tr><td class="muted">…</td><td colspan="3" class="muted">${hidden} more route${hidden === 1 ? "" : "s"} unchanged ·
            <button type="button" class="raci-link" data-raci="show-all" onClick=${() => setAll(true)}>show all</button></td></tr>` : null}
          ${rows.length === 0 ? html`<tr><td colspan="4" class="muted">no routes yet — waiting for a green dry-run</td></tr>` : null}
        </tbody>
      </table>
    </div>
  `;
}

function ProposalSection({ state, now, read }) {
  if (!state.proposal) {
    const e = state.proposeError;
    return html`
      <section class="workbench-section raci-proposal" role="region" aria-label="PROPOSAL">
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
  const counts = routeChangeCounts(p.result?.routeChanges);
  const force = forceRuleCheck(p.result, p.result?.candidateRoutes);
  const pill = !live
    ? html`<${Pill} state="superseded" symbol="●" detail="propose again" />`
    : proposalExpired(p.expiresAt, now)
      ? html`<${Pill} state="expired" symbol="⚠" />`
      : html`<${Pill} state="gate_passed" symbol="✓" detail=${`candidate ${shortSha(p.sha, 8)}${left !== null ? ` · ${left < 1 ? "<1" : left} min left` : ""}`} />`;
  return html`
    <section class="workbench-section raci-proposal" role="region" aria-label="PROPOSAL">
      <div class="raci-label-row"><h2 class="workbench-section-label raci-inline-label">PROPOSAL</h2><span class="raci-spacer"></span>${pill}</div>
      <div class="raci-summary">
        <span><b class="raci-add">+${counts.added}</b> added</span>
        <span><b class="raci-changed">~${counts.changed}</b> changed</span>
        <span><b class="raci-del">−${counts.removed}</b> removed</span>
        <span class=${force.ok ? "muted" : "raci-del"}>${force.text}</span>
      </div>
      ${read.source.kind !== "project" ? html`<div class="hint raci-compare-hint">compared with this checkout's override — there is none yet, so every route reads as added</div>` : null}
      <pre class="card raci-diff" aria-label="Unified diff, current override to candidate">${diffLines(p.result?.raciDiff).map((l) => html`<span class=${`raci-diff-${l.kind}`}>${`${l.text}\n`}</span>`)}${p.result?.raciDiff ? null : html`<span class="raci-diff-ctx">(no change)</span>`}</pre>
    </section>
  `;
}

function ApplySection({ state, now, project, setState, onApply }) {
  return html`<${ApplyCard} state=${state} ready=${applyReadiness(state, project.key, now)} setState=${setState} onApply=${onApply}
    confirmLabel="Type the project key to confirm" confirmKey=${project.key}
    hint=${html`shells <code class=${MONO_CLASS}>${`forge raci apply <candidate> --project ${project.checkoutDir} --confirm --by dashboard --source dashboard --rationale <rationale> --json`}</code> · the CLI re-runs the gate before writing`} />`;
}

export function ApplyCard({ state, ready, setState, onApply, confirmLabel, confirmKey, hint }) {
  return html`
    <section class="workbench-section raci-apply" role="region" aria-label="APPLY">
      <h2 class="workbench-section-label">APPLY</h2>
      <div class="card">
        <div class="raci-apply-grid">
          <label class="raci-field">
            <span>${confirmLabel} · <span class=${MONO_CLASS}>${confirmKey}</span></span>
            <input type="text" class=${MONO_CLASS} data-raci="confirm-key" autocomplete="off" spellcheck="false"
              value=${state.confirmKey} onInput=${(e) => { const v = e.currentTarget.value; setState((s) => setConfirmKey(s, v)); }} />
          </label>
          <label class="raci-field">
            <span>Rationale (recorded in the audit log)</span>
            <textarea data-raci="rationale" rows="3" value=${state.rationale}
              onInput=${(e) => { const v = e.currentTarget.value; setState((s) => setRationale(s, v)); }}></textarea>
          </label>
        </div>
        <div class="raci-bar">
          <button type="button" class="raci-btn raci-btn-primary" data-raci="apply" disabled=${!ready.enabled} aria-describedby="raci-apply-hint" onClick=${onApply}>Apply</button>
          <span id="raci-apply-hint" class="hint">
            ${ready.reason ? html`<span class="raci-apply-reason">${ready.reason} · </span>` : null}${hint}
          </span>
        </div>
        ${state.applyError ? html`<div class="raci-result raci-result-fail" role="alert">
          <${Pill} state="apply_failed" symbol="✗" detail=${[state.applyError.exitCode !== null ? `exit ${state.applyError.exitCode}` : null, state.applyError.refusal].filter(Boolean).join(" · ") || null} />
          <pre class="raci-output">${state.applyError.message}</pre>
        </div>` : null}
      </div>
    </section>
  `;
}
