// FG-824: the recovery card on #task/<id>. Decisions live in recovery-card-render.js; the
// button runs the FG-822 flow — preview the verb, Confirm, render its result inline.

import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { recoveryCard } from "./recovery-card-render.js";
import { previewCommand, confirmRequest, actionResult } from "./task-actions-render.js";
import { readActions } from "./task-actions-view.js";
import { badgeClass, toneAccentClass } from "./status-tokens.js";
import { formatTimestamp } from "./format.js";

const html = htm.bind(h);

export function RecoveryCard({ detail, onChanged = null }) {
  const taskId = detail.task.taskId;
  const [load, setLoad] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    readActions(taskId).then((next) => { if (!cancelled) setLoad(next); });
    return () => { cancelled = true; };
  }, [taskId, detail.task.status]);

  const card = recoveryCard(detail, load);
  if (!card) return null;
  const next = card.next;

  const confirm = async () => {
    const request = confirmRequest(next.entry);
    setPending(true);
    let status = 0;
    let body = null;
    try {
      const res = await fetch(request.route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
      status = res.status;
      try { body = await res.json(); } catch { body = null; }
    } catch (e) {
      body = { error: String(e) };
    }
    const outcome = actionResult(status, body, next.entry.verb);
    setPending(false);
    setPreviewing(false);
    setResult(outcome);
    if (outcome.ok && onChanged) onChanged();
  };

  return html`
    <section class=${"card recovery-card " + toneAccentClass(card.status.tone)} aria-labelledby="recovery-card-heading">
      <h3 id="recovery-card-heading">Recovery</h3>
      <dl>
        <dt>status</dt>
        <dd><span class=${badgeClass("task", detail.task.status)}>${card.status.label}</span></dd>
        <dt>failure kind</dt>
        <dd><code class="recovery-kind">${card.kind}</code> <span class="faint">— ${card.kindDetail}</span></dd>
        <dt>last forge recover</dt>
        <dd class="recovery-last">${card.lastRecover
          ? html`<span>${card.lastRecover.text}</span>${card.lastRecover.at ? html` <span class="faint" title=${card.lastRecover.at}>at ${formatTimestamp(card.lastRecover.at)}</span>` : null}`
          : html`<span class="faint">none recorded</span>`}</dd>
      </dl>
      <div class="recovery-next">
        ${next.mode === "button"
          ? html`
            <div class="recovery-next-verb">Next:</div>
            <div class="action-buttons">
              <button
                type="button"
                class=${"recovery-action" + (previewing ? " recovery-action-selected" : "")}
                data-action=${next.entry.action}
                aria-expanded=${previewing ? "true" : "false"}
                disabled=${pending}
                onClick=${() => { setPreviewing(true); setResult(null); }}
              ><code>${next.entry.verb}</code></button>
            </div>
            ${previewing ? html`
              <div class="action-preview recovery-preview" role="group" aria-label="Confirm recovery action">
                <div class="action-preview-head">Will run: <code class="action-preview-verb">${previewCommand(next.entry)}</code></div>
                <div class="faint action-preview-reason">${next.entry.reason}</div>
                <div class="action-preview-controls">
                  <button type="button" class="action-confirm" disabled=${pending} onClick=${confirm}>${pending ? "Running…" : "Confirm"}</button>
                  <button type="button" class="action-cancel" disabled=${pending} onClick=${() => setPreviewing(false)}>Cancel</button>
                </div>
              </div>` : null}`
          : html`
            <div class="recovery-next-verb">Next: <code class="recovery-verb">${next.verb}</code></div>
            ${next.mode === "loading" ? html`<div class="faint">reading the action preview…</div>` : null}
            ${next.advice ? html`<div class="action-advice recovery-advice">${next.advice}</div>` : null}`}
        ${result ? html`
          <div class=${"action-result " + (result.ok ? "action-result-ok" : "action-result-fail")} role="status">
            <div class="action-result-line mono">${result.line}</div>
            ${result.detail ? html`<div class="action-result-detail">${result.detail}</div>` : null}
            ${result.output ? html`<pre class="action-result-output">${result.output}</pre>` : null}
          </div>` : null}
      </div>
    </section>
  `;
}
