// FG-830: the Notes view as data — one row per checkout that has a session-handoff
// note (`backlog/notes.md`, `forge backlog notes`), read off GET /api/backlog's
// `notesByCheckout`. Pure, so the render tests and the browser suite pin one answer.
//
// A row's session date is the note's own "Last session ended YYYY-MM-DD" marker line; failing
// that, the file's mtime as the server reported it; failing both, "unknown" — never a
// guessed date. Rows sort newest session first, unknown last.

import { checkoutLabelForDir } from "./checkout-label.js";
import { formatRelativeTime, formatTimestamp } from "./format.js";
import { hashFor } from "./view-routing.js";

export const NO_PROJECT_MESSAGE = "Select a project to read its checkouts' session handoff notes.";
export const NO_NOTES_MESSAGE = "No checkout of this project has session handoff notes.";

// The whole line must be the marker `forge backlog notes` writes — `**Last session ended
// YYYY-MM-DD.**`, bold optional — so a date quoted in prose is never read as the session.
const SESSION_LINE = /^[ \t]*(\*\*|__)?Last session ended[ \t]+(\d{4}-\d{2}-\d{2})\.?\1\.?[ \t]*$/im;
const PREVIEW_MAX = 160;

function pathKey(dir) {
  return String(dir).replace(/\/+$/, "") || "/";
}

function validTime(iso) {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The date on the note's "Last session ended …" line, or null. */
export function lastSessionDate(notes) {
  const match = typeof notes === "string" ? notes.match(SESSION_LINE) : null;
  return match && validTime(match[2]) !== null ? match[2] : null;
}

/** Where a row's session date came from: the note, the file's mtime, or nowhere. */
export function sessionOf(entry) {
  const fromNote = lastSessionDate(entry?.notes);
  if (fromNote) return { iso: fromNote, source: "note" };
  if (validTime(entry?.modifiedAt) !== null) return { iso: entry.modifiedAt, source: "modified" };
  return { iso: null, source: "unknown" };
}

/** The session date as it renders: text, and an absolute title saying where it came from. */
export function sessionDisplay(session, now = Date.now()) {
  if (session.source === "note") {
    return { text: `session ended ${session.iso} · ${formatRelativeTime(session.iso, now)}`, title: `From the note's "Last session ended ${session.iso}" line` };
  }
  if (session.source === "modified") {
    return { text: `file modified ${formatRelativeTime(session.iso, now)}`, title: `No session line in the note; notes.md last modified ${formatTimestamp(session.iso)}` };
  }
  return { text: "session date unknown", title: "The note has no session line and the server reported no modification time" };
}

/** The note's first line of prose, markup stripped, on one line — the session line skipped
 *  because the row already shows its date. */
export function notePreview(notes, max = PREVIEW_MAX) {
  if (typeof notes !== "string") return "";
  for (const line of notes.split("\n")) {
    if (SESSION_LINE.test(line)) continue;
    const text = line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
    if (text === "") continue;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return "";
}

/** The registered project a scope names, or null. */
export function scopedProject(scope, projects) {
  const key = scope && typeof scope.project === "string" ? scope.project : null;
  return key && Array.isArray(projects) ? projects.find((p) => p.key === key) ?? null : null;
}

/**
 * One row per checkout with a non-empty note, newest session first (unknown last, then by
 * label). `label` is FG-831's checkout label; `primary` marks the project's primary checkout.
 */
export function noteRows(data, scope, projects) {
  const entries = data && Array.isArray(data.notesByCheckout) ? data.notesByCheckout : [];
  const project = scopedProject(scope, projects);
  const primaryKey = project?.primaryCheckout ? pathKey(project.primaryCheckout) : null;
  const rows = entries
    .filter((entry) => entry && typeof entry.checkoutDir === "string" && typeof entry.notes === "string" && entry.notes.trim() !== "")
    .map((entry) => {
      const session = sessionOf(entry);
      return {
        checkoutDir: entry.checkoutDir,
        label: checkoutLabelForDir(entry.checkoutDir, projects, entry.checkoutBranch ?? null),
        branch: entry.checkoutBranch ?? null,
        primary: primaryKey !== null && pathKey(entry.checkoutDir) === primaryKey,
        notes: entry.notes,
        session,
        sessionMs: validTime(session.iso),
        preview: notePreview(entry.notes),
        href: hashFor({ view: "notes", id: entry.checkoutDir, scope }),
      };
    });
  return rows.sort((a, b) => {
    if (a.sessionMs !== b.sessionMs) {
      if (a.sessionMs === null) return 1;
      if (b.sessionMs === null) return -1;
      return b.sessionMs - a.sessionMs;
    }
    return a.label.localeCompare(b.label);
  });
}

/** The row for one checkout directory, or null. */
export function noteRowFor(rows, checkoutDir) {
  if (typeof checkoutDir !== "string" || checkoutDir === "") return null;
  const key = pathKey(checkoutDir);
  return rows.find((row) => pathKey(row.checkoutDir) === key) ?? null;
}
