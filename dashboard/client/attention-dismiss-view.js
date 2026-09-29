// FG-823: the Dismiss / Snooze buttons on an Attention inbox row, and the "Dismissed"
// disclosure at the foot of the inbox with Undismiss. Every decision about WHAT is held is
// the server's (GET /api/attention-inbox excludes held items and lists them under
// `dismissed`); this renders the controls, previews the command before Confirm, and after
// the verb exits 0 asks the host to re-read. Nothing is stored in the browser.

import { h } from "preact";
import { useState, useLayoutEffect, useRef } from "preact/hooks";
import htm from "htm";
import { SNOOZE_PRESETS, attentionCommand, attentionRequest, attentionResult } from "./attention-dismiss-render.js";

const html = htm.bind(h);

async function send(request) {
  let status = 0;
  let body = null;
  try {
    const res = await fetch(request.route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
    status = res.status;
    try { body = await res.json(); } catch { body = null; }
  } catch (e) {
    body = { error: String(e) };
  }
  return { status, body };
}

function ResultLine({ result }) {
  if (!result) return null;
  return html`
    <div class=${"action-result " + (result.ok ? "action-result-ok" : "action-result-fail")} role=${result.ok ? "status" : "alert"}>
      <div class="action-result-line mono">${result.line}</div>
      ${result.detail ? html`<div class="action-result-detail">${result.detail}</div>` : null}
    </div>`;
}

/** Dismiss and Snooze for one open row. `onChanged` runs after the verb exits 0.
 *  `previewOpen` / `onPreviewChange` let the row close this preview when its task-action
 *  preview opens, so a row never shows two. Opening focuses the preview's first control;
 *  Escape closes it and returns focus to its button. */
export function AttentionRowControls({ itemId, onChanged = null, previewOpen = undefined, onPreviewChange = null }) {
  const [selected, setChoice] = useState(null);
  const choice = previewOpen === false ? null : selected;
  const previewRef = useRef(null);
  const buttonsRef = useRef(null);
  const focusPending = useRef(false);
  const [until, setUntil] = useState("");
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);

  useLayoutEffect(() => {
    if (!choice || !focusPending.current || !previewRef.current) return;
    focusPending.current = false;
    const first = previewRef.current.querySelector("button:not([disabled]), input");
    if (first) first.focus();
  }, [choice]);

  const choose = (action) => {
    const next = choice === action ? null : action;
    setChoice(next);
    setUntil("");
    setRationale("");
    setError(null);
    setResult(null);
    focusPending.current = next !== null;
    if (onPreviewChange) onPreviewChange(next !== null);
  };
  const onPreviewKey = (e) => {
    if (e.key !== "Escape" || pending) return;
    e.preventDefault();
    const opener = buttonsRef.current?.querySelector(".inbox-hold-btn-selected");
    choose(choice);
    if (opener) opener.focus();
  };
  const confirm = async () => {
    const request = attentionRequest(itemId, choice, { until, rationale });
    if (!request.ok) { setError(request.error); return; }
    setPending(true);
    setError(null);
    const command = attentionCommand(itemId, choice, until);
    const { status, body } = await send(request);
    const outcome = attentionResult(status, body, command);
    setPending(false);
    setResult(outcome);
    if (outcome.ok) {
      setChoice(null);
      if (onPreviewChange) onPreviewChange(false);
      if (onChanged) onChanged();
    }
  };

  return html`
    <div class="inbox-dismiss" aria-label="Dismiss or snooze">
      <div class="inbox-hold-buttons" ref=${buttonsRef}>
        <button type="button" class=${"inbox-hold-btn inbox-dismiss-btn" + (choice === "dismiss" ? " inbox-hold-btn-selected" : "")}
          aria-expanded=${choice === "dismiss" ? "true" : "false"} disabled=${pending} onClick=${() => choose("dismiss")}>Dismiss</button>
        <button type="button" class=${"inbox-hold-btn inbox-snooze-btn" + (choice === "snooze" ? " inbox-hold-btn-selected" : "")}
          aria-expanded=${choice === "snooze" ? "true" : "false"} disabled=${pending} onClick=${() => choose("snooze")}>Snooze</button>
      </div>
      ${choice ? html`
        <div class="action-preview hold-preview" role="group" aria-label=${choice === "snooze" ? "Confirm snooze" : "Confirm dismiss"}
          ref=${previewRef} onKeyDown=${onPreviewKey}>
          <div class="action-preview-head">Will run: <code class="action-preview-verb">${attentionCommand(itemId, choice, until)}</code></div>
          <div class="faint action-preview-reason">
            ${choice === "snooze"
              ? "Hidden until then, or until it shows new activity. Recorded with an audit event."
              : "Hidden until it shows new activity. Recorded with an audit event."}
          </div>
          ${choice === "snooze" ? html`
            <div class="inbox-snooze-presets" role="group" aria-label="Snooze for">
              ${SNOOZE_PRESETS.map((preset) => html`
                <button type="button" key=${preset} class=${"inbox-hold-btn inbox-snooze-preset" + (until === preset ? " inbox-hold-btn-selected" : "")}
                  aria-pressed=${until === preset ? "true" : "false"} onClick=${() => { setUntil(preset); setError(null); }}>${preset}</button>`)}
              <label class="inbox-snooze-custom-label">
                or until (ISO)
                <input type="text" class="inbox-snooze-custom" placeholder="2026-10-01T09:00:00Z"
                  value=${SNOOZE_PRESETS.includes(until) ? "" : until}
                  onInput=${(e) => { setUntil(e.currentTarget.value); setError(null); }} />
              </label>
            </div>` : null}
          <label class="action-rationale-label">
            Rationale (optional, recorded with it)
            <input type="text" class="action-rationale inbox-dismiss-rationale" value=${rationale}
              onInput=${(e) => setRationale(e.currentTarget.value)} />
          </label>
          ${error ? html`<div class="action-error" role="alert">${error}</div>` : null}
          <div class="action-preview-controls">
            <button type="button" class="action-confirm" disabled=${pending} onClick=${confirm}>${pending ? "Running…" : "Confirm"}</button>
            <button type="button" class="action-cancel" disabled=${pending} onClick=${() => choose(choice)}>Cancel</button>
          </div>
        </div>` : null}
      <${ResultLine} result=${result} />
    </div>
  `;
}

/** The held items, under a closed-by-default disclosure at the foot of the inbox. */
export function DismissedDisclosure({ entries, onChanged = null }) {
  const [pending, setPending] = useState(null);
  const [result, setResult] = useState(null);
  if (!entries || entries.length === 0) return null;

  const undismiss = async (itemId) => {
    const request = attentionRequest(itemId, "undismiss");
    setPending(itemId);
    const { status, body } = await send(request);
    const outcome = attentionResult(status, body, attentionCommand(itemId, "undismiss"));
    setPending(null);
    setResult(outcome);
    if (outcome.ok && onChanged) onChanged();
  };

  return html`
    <details class="inbox-dismissed">
      <summary>Dismissed (${entries.length})</summary>
      <ul class="inbox-dismissed-list">
        ${entries.map((entry) => html`
          <li key=${entry.id} class="inbox-dismissed-row" data-item-id=${entry.id} data-hold=${entry.holdState}>
            <span class="badge ${entry.badgeClass}">${entry.badgeLabel}</span>
            <div class="inbox-dismissed-body">
              <div class="inbox-reason">${entry.reason}</div>
              <div class="faint inbox-dismissed-hold">${entry.holdLabel}</div>
              ${entry.rationale ? html`<div class="faint inbox-dismissed-rationale">“${entry.rationale}”</div>` : null}
            </div>
            <button type="button" class="inbox-hold-btn inbox-undismiss-btn" disabled=${pending !== null}
              aria-label=${`Undismiss ${entry.id}`} onClick=${() => undismiss(entry.id)}>
              ${pending === entry.id ? "Running…" : "Undismiss"}
            </button>
          </li>`)}
      </ul>
      <${ResultLine} result=${result} />
    </details>
  `;
}
