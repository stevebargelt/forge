// FG-822: the task-action buttons — on the task page's screen line and on Home inbox rows.
// Every decision comes from the server's preview (GET /api/task/:id/actions) and
// task-actions-render.js; this renders it. A button is labeled with its verb; clicking it
// shows the command that will run (and, for a gate, asks for the rationale) before
// Confirm; the verb's exit status and output render inline. Never badge-bearing.

import { h } from "preact";
import { useState, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import htm from "htm";
import {
  ACTIONS_UNAVAILABLE, actionsFromResponse, actionButtons, actionKey, previewCommand, confirmRequest, actionResult,
} from "./task-actions-render.js";

const html = htm.bind(h);

export async function readActions(taskId) {
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(taskId)}/actions`);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return actionsFromResponse(res.status, body);
  } catch (e) {
    return { phase: "unavailable", detail: String(e) };
  }
}

/** `compact` (an inbox row) shows only the buttons, and `fallback` when there are none.
 *  `onChanged` runs after a verb exits 0, so the host can re-read what it shows.
 *  `previewOpen` / `onPreviewChange` let a host that shows other previews (an inbox row's
 *  Dismiss/Snooze) keep one open at a time; when given, opening focuses the preview's first
 *  control and Escape closes it. */
export function TaskActions({ taskId, compact = false, fallback = null, onChanged = null, previewOpen = undefined, onPreviewChange = null }) {
  const [load, setLoad] = useState(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const previewRef = useRef(null);
  const focusPending = useRef(false);
  const controlled = previewOpen !== undefined;

  useEffect(() => {
    let cancelled = false;
    readActions(taskId).then((next) => { if (!cancelled) setLoad(next); });
    return () => { cancelled = true; };
  }, [taskId, tick]);

  const buttons = actionButtons(load);
  const shown = controlled && !previewOpen ? null : selected;
  const chosen = shown && load && load.phase === "ready" ? load.eligible.find((e) => actionKey(e) === shown) ?? null : null;

  useLayoutEffect(() => {
    if (!chosen || !focusPending.current || !previewRef.current) return;
    focusPending.current = false;
    const first = previewRef.current.querySelector("textarea, input, button:not([disabled])");
    if (first) first.focus();
  }, [chosen]);

  const choose = (key) => {
    setSelected(key); setRationale(""); setError(null); setResult(null);
    if (controlled) { focusPending.current = true; if (onPreviewChange) onPreviewChange(true); }
  };
  const cancel = () => {
    setSelected(null); setError(null);
    if (controlled && onPreviewChange) onPreviewChange(false);
  };
  const onPreviewKey = (e) => {
    if (!controlled || e.key !== "Escape" || pending) return;
    e.preventDefault();
    const opener = previewRef.current?.parentElement?.querySelector(".action-btn-selected");
    cancel();
    if (opener) opener.focus();
  };
  const confirm = async () => {
    const request = confirmRequest(chosen, rationale);
    if (!request.ok) { setError(request.error); return; }
    setPending(true);
    setError(null);
    let status = 0;
    let body = null;
    try {
      const res = await fetch(request.route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
      status = res.status;
      try { body = await res.json(); } catch { body = null; }
    } catch (e) {
      body = { error: String(e) };
    }
    const outcome = actionResult(status, body, chosen.verb);
    setPending(false);
    setResult(outcome);
    setSelected(null);
    if (controlled && onPreviewChange) onPreviewChange(false);
    setTick((n) => n + 1);
    if (outcome.ok && onChanged) onChanged();
  };

  const resultBlock = result ? html`
    <div class=${"action-result " + (result.ok ? "action-result-ok" : "action-result-fail")} role="status">
      <div class="action-result-line mono">${result.line}</div>
      ${result.detail ? html`<div class="action-result-detail">${result.detail}</div>` : null}
      ${result.output ? html`<pre class="action-result-output">${result.output}</pre>` : null}
    </div>` : null;

  if (buttons.length === 0) {
    if (compact) return html`${fallback}${resultBlock}`;
    return html`
      <div class="task-actions" aria-label="Task actions">
        ${load && load.phase === "unavailable" ? html`<div class="faint action-note">${ACTIONS_UNAVAILABLE}: ${load.detail}</div>` : null}
        ${load && load.phase === "ready" && !load.available && load.unavailableReason ? html`<div class="faint action-note">${load.unavailableReason}</div>` : null}
        ${resultBlock}
        ${!compact ? html`<${RefusedList} load=${load} />` : null}
      </div>`;
  }

  return html`
    <div class=${"task-actions" + (compact ? " task-actions-compact" : "")} aria-label="Task actions">
      <div class="action-buttons">
        ${buttons.map((b) => html`
          <button
            type="button"
            key=${b.key}
            class=${"action-btn" + (shown === b.key ? " action-btn-selected" : "")}
            data-action=${b.action}
            data-decision=${b.decision ?? ""}
            aria-expanded=${shown === b.key ? "true" : "false"}
            disabled=${pending}
            onClick=${() => choose(b.key)}
          ><code>${b.label}</code></button>
        `)}
      </div>
      ${chosen ? html`
        <div class="action-preview task-action-preview" role="group" aria-label="Confirm action" ref=${previewRef} onKeyDown=${onPreviewKey}>
          <div class="action-preview-head">Will run: <code class="action-preview-verb">${previewCommand(chosen, rationale)}</code></div>
          <div class="faint action-preview-reason">${chosen.reason}</div>
          ${chosen.requiresRationale ? html`
            <label class="action-rationale-label">
              Rationale (recorded with the decision)
              <textarea
                class="action-rationale"
                rows="3"
                value=${rationale}
                onInput=${(e) => { setRationale(e.currentTarget.value); setError(null); }}
              ></textarea>
            </label>` : null}
          ${error ? html`<div class="action-error" role="alert">${error}</div>` : null}
          <div class="action-preview-controls">
            <button type="button" class="action-confirm" disabled=${pending} onClick=${confirm}>${pending ? "Running…" : "Confirm"}</button>
            <button type="button" class="action-cancel" disabled=${pending} onClick=${cancel}>Cancel</button>
          </div>
        </div>` : null}
      ${resultBlock}
      ${!compact ? html`<${RefusedList} load=${load} />` : null}
    </div>
  `;
}

// A refused action is never a button. One the policy has advice for shows that advice (the
// human precondition); the rest fold away, since "not failed, so no retry" is noise.
function RefusedList({ load }) {
  if (!load || load.phase !== "ready" || load.refused.length === 0) return null;
  const advised = load.refused.filter((r) => r.advice);
  const quiet = load.refused.filter((r) => !r.advice);
  const item = (r) => html`
    <li key=${r.action} data-action=${r.action}>
      <code>${r.verb}</code> — ${r.reason}${r.advice ? html`<div class="action-advice">${r.advice}</div>` : null}
    </li>`;
  return html`
    ${advised.length > 0 ? html`<ul class="action-refused action-refused-advised">${advised.map(item)}</ul>` : null}
    ${quiet.length > 0 ? html`
      <details class="action-refused">
        <summary class="faint">Not available for this task (${quiet.length})</summary>
        <ul>${quiet.map(item)}</ul>
      </details>` : null}
  `;
}
