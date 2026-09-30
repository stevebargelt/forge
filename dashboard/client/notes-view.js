// FG-830: the Notes view under Plan — the session-handoff notes that used to sit above
// the Backlog's tickets. `#notes` lists one row per checkout with a note; `#notes/<dir>`
// is that checkout's note page, rendered through the sanitized Markdown boundary.
// Read-only: the data is GET /api/backlog's `notesByCheckout`, and nothing here writes.

import { h } from "preact";
import htm from "htm";
import { md } from "./markdown.js";
import { noteTrail, parentHash } from "./breadcrumbs-render.js";
import { noteHeader } from "./screen-header-render.js";
import { ObjectHead, useEscapeTo } from "./object-page-view.js";
import { NO_NOTES_MESSAGE, NO_PROJECT_MESSAGE, noteRowFor, noteRows, sessionDisplay } from "./notes-render.js";

const html = htm.bind(h);

function SessionDate({ session }) {
  const shown = sessionDisplay(session);
  return html`<span class=${"notes-session mono" + (session.source === "unknown" ? " faint" : " muted")} title=${shown.title} data-session-source=${session.source}>${shown.text}</span>`;
}

function PrimaryMark({ primary }) {
  return primary ? html`<span class="badge notes-primary" title="The project's primary checkout">primary</span>` : null;
}

export function NotesView({ data, projectFilter, scope, projects }) {
  if (!projectFilter) return html`<div class="card muted notes-no-project" role="note">${NO_PROJECT_MESSAGE}</div>`;
  if (!data) return html`<div class="muted">loading notes…</div>`;
  const rows = noteRows(data, scope, projects);
  if (rows.length === 0) return html`<div class="muted notes-empty">${NO_NOTES_MESSAGE}</div>`;
  return html`
    <ul class="notes-list" aria-label="Session handoff notes by checkout">
      ${rows.map((row) => html`
        <li key=${row.checkoutDir}>
          <a class="card notes-row" href=${row.href} data-checkout=${row.checkoutDir} aria-label=${`Open the session handoff for ${row.label}`}>
            <div class="notes-row-head">
              <${PrimaryMark} primary=${row.primary} />
              <strong class="notes-label" title=${row.checkoutDir}>${row.label}</strong>
              <${SessionDate} session=${row.session} />
            </div>
            ${row.preview ? html`<div class="notes-preview muted">${row.preview}</div>` : null}
          </a>
        </li>
      `)}
    </ul>
  `;
}

export function NotePage({ checkoutDir, data, scope, projects }) {
  const row = data ? noteRowFor(noteRows(data, scope, projects), checkoutDir) : null;
  const label = row ? row.label : checkoutDir;
  useEscapeTo(parentHash("note", null, scope));
  return html`
    <section class="object-page note-page" data-checkout=${checkoutDir}>
      <${ObjectHead} crumbs=${noteTrail(label, scope, projects)} title=${label} header=${noteHeader(row)} />
      ${!scope || !scope.project
        ? html`<div class="card muted notes-no-project" role="note">${NO_PROJECT_MESSAGE}</div>`
        : !data
        ? html`<div class="muted">loading note…</div>`
        : !row
        ? html`<div class="card muted" role="note">No session handoff note for ${checkoutDir} in this project.</div>`
        : html`
          <div class="row notes-meta">
            <${PrimaryMark} primary=${row.primary} />
            ${row.branch ? html`<span class="checkout-chip">${row.branch}</span>` : null}
            <${SessionDate} session=${row.session} />
          </div>
          <div class="subcard notes-path mono faint">${row.checkoutDir}</div>
          <div class="md note-body" dangerouslySetInnerHTML=${{ __html: md(row.notes, { html: "text" }) }}></div>
        `}
    </section>
  `;
}
