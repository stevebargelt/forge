// FG-847 — the Refine panel: a needs_refinement ticket fixed where it was refused. One
// component, rendered inside the Queue's inline refusal (FG-846) and on the Backlog ticket
// page (#backlog/<id>?mode=edit). Decisions live in refine-state.js.
//
// Save posts the whole body to POST /api/backlog/<id>/edit (`forge backlog edit <id>
// --body -`, the body on the child's stdin), which answers with the new revision and the
// re-run verdict; the caller turns that into its outcome. Escape closes the panel back to
// the outcome without saving.

import { h } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { refineChecklist, saveRefusal, sectionsForGaps, seedBody } from "./refine-state.js";

const html = htm.bind(h);

/** GET /api/backlog/<id>/readiness for the scope — `{ ok, readiness }` or `{ ok: false, error }`. */
export async function fetchReadiness(ticketId, { projectKey = null, projectDir = null } = {}) {
  const q = new URLSearchParams();
  if (projectKey) q.set("projectKey", projectKey);
  if (projectDir) q.set("projectDir", projectDir);
  try {
    const res = await fetch(`/api/backlog/${encodeURIComponent(ticketId)}/readiness?${q.toString()}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.outcome !== "string") return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return { ok: true, readiness: body };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function RefinePanel({ ticketId, readiness, projectKey, projectDir = null, onSaved, onCancel }) {
  const sections = sectionsForGaps(readiness.gaps);
  const [text, setText] = useState(() => seedBody(readiness.body ?? "", sections));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const area = useRef(null);
  const fieldId = `refine-body-${ticketId}`;

  // The caret lands on the first placeholder, selected, so typing replaces it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    const first = sections.map((section) => text.indexOf(section.placeholder)).filter((at) => at >= 0).sort((a, b) => a - b)[0];
    if (first !== undefined) {
      const section = sections.find((s) => text.indexOf(s.placeholder) === first);
      el.setSelectionRange(first, first + section.placeholder.length);
    }
  }, []);

  const save = async () => {
    const refusal = saveRefusal(text, sections);
    if (refusal) {
      setError(refusal);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/backlog/${encodeURIComponent(ticketId)}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey,
          ...(projectDir ? { projectDir } : {}),
          body: text,
          // The route requires it: the compare-and-set that refuses a retried or concurrent
          // save. A never-revised ticket is r0 to the CLI.
          baseRevision: typeof readiness.revision === "number" ? readiness.revision : 0,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && payload && payload.ok) {
        onSaved(payload);
        return;
      }
      setError(payload?.error ?? `the edit failed (HTTP ${res.status}).`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };

  const checklist = refineChecklist(text, sections);
  return html`
    <section class="refine-panel" aria-label=${`Refine ${ticketId}`} onKeyDown=${onKeyDown}>
      <h4 class="refine-title">
        Refine ${ticketId}${" "}
        ${typeof readiness.revision === "number" ? html`<span class="badge refine-revision">revision r${readiness.revision}</span>` : null}
        <span class="muted refine-via">${" · saved through "}<span class="mono">forge backlog edit ${ticketId} --body -</span>, then readiness re-runs</span>
      </h4>
      ${checklist.length > 0
        ? html`<ul class="refine-gaps" aria-label="Readiness checklist">
            ${checklist.map((row) => html`
              <li key=${row.key} class=${row.done ? "refine-gap-done" : "refine-gap-open"} data-section=${row.key}>
                <span class="mono">${row.label}</span>
                <span class="sr-only">${row.done ? " — present" : " — missing"}</span>
              </li>
            `)}
          </ul>`
        : null}
      ${readiness.refinementProposal ? html`<p class="muted refine-proposal">Proposal: ${readiness.refinementProposal}</p>` : null}
      <label class="sr-only" for=${fieldId}>${`Body of ${ticketId}`}</label>
      <textarea
        id=${fieldId}
        ref=${area}
        class="refine-body"
        spellcheck="false"
        value=${text}
        onInput=${(e) => { setText(e.target.value); setError(null); }}
      ></textarea>
      ${error ? html`<div class="refine-error" role="alert">${error}</div>` : null}
      <div class="refine-actions">
        <button type="button" class="action-confirm refine-save" disabled=${saving} onClick=${save}>${saving ? "Saving…" : "Save and re-check"}</button>
        <button type="button" class="action-cancel refine-cancel" onClick=${onCancel}>Cancel</button>
        <span class="muted refine-hint">Save is refused if a section is still missing — the checklist says which. Esc closes.</span>
      </div>
    </section>
  `;
}
