// FG-643 — the ONE Markdown render boundary for the dashboard client.
//
// Every `dangerouslySetInnerHTML` in dashboard/client/** must be fed by `md` or
// `mdInline` from HERE (enforced by src/fg643-markdown-source-guard.test.ts).
// This is the single place `marked` is invoked, and its output is ALWAYS passed
// through `sanitizeHtml` before it can reach the DOM — so raw HTML / scriptable
// URLs in DB-sourced ticket text are made inert by construction (see
// sanitize-html.js for the allowlist and threat model). Sanitization is a pure
// output transform; the stored text is never altered.

import { marked, Marked } from "marked";
import { sanitizeHtml } from "./sanitize-html.js";

// FG-827: seed text is data. With `{ html: "text" }`, raw HTML in the source and links to a
// scriptable scheme are shown as the literal source text instead of being dropped by the
// sanitizer, so a reader sees exactly what the file says.
const literal = new Marked();
literal.use({
  renderer: {
    html(token) {
      if (!token.block) return escapeText(token.text);
      return `<p>${escapeText(token.text.replace(/\n+$/, "")).replace(/\n/g, "<br>")}</p>\n`;
    },
    link(token) {
      return /^[a-z][a-z0-9+.-]*:/i.test(token.href) && !/^(https?|mailto):/i.test(token.href) ? escapeText(token.raw) : false;
    },
  },
});

/** Render a block of Markdown to sanitized, inert HTML. `opts.html === "text"` shows raw
 *  HTML (and scriptable-scheme links) as visible literal text rather than stripping it. */
export function md(s, opts) {
  if (typeof s !== "string") return "";
  let raw;
  try { raw = (opts?.html === "text" ? literal : marked).parse(s, { breaks: true, gfm: true }); }
  catch { return sanitizeHtml(escapeFallback(s)); }
  return sanitizeHtml(raw);
}

/** Render inline Markdown (no block wrappers) to sanitized, inert HTML. */
export function mdInline(s) {
  if (typeof s !== "string") return "";
  let raw;
  try { raw = marked.parseInline(s, { breaks: false, gfm: true }); }
  catch { return sanitizeHtml(escapeFallback(s)); }
  return sanitizeHtml(raw);
}

// If `marked` throws, we still must not hand raw source to the DOM. Escape it to
// plain text and run it through the same sanitizer for a single exit path.
function escapeFallback(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(s) {
  return escapeFallback(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
