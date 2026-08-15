// FG-643 — the ONE Markdown render boundary for the dashboard client.
//
// Every `dangerouslySetInnerHTML` in dashboard/client/** must be fed by `md` or
// `mdInline` from HERE (enforced by src/fg643-markdown-source-guard.test.ts).
// This is the single place `marked` is invoked, and its output is ALWAYS passed
// through `sanitizeHtml` before it can reach the DOM — so raw HTML / scriptable
// URLs in DB-sourced ticket text are made inert by construction (see
// sanitize-html.js for the allowlist and threat model). Sanitization is a pure
// output transform; the stored text is never altered.

import { marked } from "marked";
import { sanitizeHtml } from "./sanitize-html.js";

/** Render a block of Markdown to sanitized, inert HTML. */
export function md(s) {
  if (typeof s !== "string") return "";
  let raw;
  try { raw = marked.parse(s, { breaks: true, gfm: true }); }
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
