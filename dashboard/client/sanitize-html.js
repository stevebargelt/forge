// FG-643 — output-boundary HTML sanitizer for rendered Markdown.
//
// WHY THIS EXISTS
// The dashboard renders ticket bodies / session notes / gate rationales as
// Markdown via `marked`, then injects the result with Preact
// `dangerouslySetInnerHTML`. `marked` passes raw HTML through VERBATIM
// (`<script>`, `<img onerror>`, `<iframe>`, `<svg>`…) and will happily emit a
// `javascript:` link. Since the FG-608 DB cutover those strings can originate
// from ANY host-side DB writer, not just reviewed repo Markdown — so a crafted
// ticket is attacker-controlled HTML executing in the dashboard origin.
//
// This module is the ONE security boundary: it takes the HTML string `marked`
// produced and returns an inert-by-construction HTML string, allowlisting a
// NARROW set of elements / attributes / URL schemes and dropping everything
// else (default-deny). It is a pure string -> string transform: it never
// touches storage (AC5) and needs no DOM, so it runs identically in the browser
// client and in the `node --test` unit harness.
//
// THREAT MODEL: the attacker can write arbitrary text into a ticket body/note
// that reaches this function as part of `marked`'s output. They want any of:
// script execution, event-handler attributes, scriptable/namespace-switching
// elements (svg/math/style), or a scriptable URL scheme. Default-deny on tags
// AND attributes, plus dropping the *content* of raw-text elements, removes
// those capabilities. This is proven by the negative unit tests INDEPENDENTLY
// of the CSP header (the CSP is defense-in-depth, not the boundary).

// ---- allowlists -----------------------------------------------------------

// Elements that survive sanitization. Everything `marked` emits for safe
// Markdown (headings, lists, tables, code, blockquotes, emphasis, links,
// images, GFM task-list checkboxes) plus a few common inline tags. Anything
// NOT here is dropped — including every namespace-switching / scriptable
// element (script, style, svg, math, iframe, object, embed, form, …).
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code",
  "em", "strong", "del", "ins", "sub", "sup", "kbd", "mark", "small",
  "b", "i", "u", "s", "abbr", "cite", "q",
  "a", "img",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "input", // GFM task-list checkbox ONLY — gated to type="checkbox" below
]);

// Void (self-closing) elements — serialized without a closing tag.
const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

// Elements whose text CONTENT is unescaped raw text in the HTML grammar (or
// which switch parsing context / namespace). None are allowlisted, but we must
// drop their CONTENT too — leaving `alert(1)` from inside a dropped <script>,
// or a `javascript:` xlink from inside a dropped <svg>, would be a leak / an
// mXSS foothold. Content up to the matching close tag (or EOF) is discarded.
const DROP_CONTENT_TAGS = new Set([
  "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript",
  "template", "title", "textarea", "svg", "math", "plaintext",
]);

// URL schemes permitted in href/src. Deliberately excludes javascript:, data:,
// vbscript:, file:, blob:, and every other scriptable/exfil scheme. A URL with
// NO scheme (relative path, `#anchor`, `//host`, `mailto`-less) is allowed.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "ftp"]);

// Per-tag attribute allowlists. Anything not listed (and every `on*` handler,
// `style`, `srcset`, `xlink:*`, `formaction`, `id`, …) is dropped.
const URL_ATTR = 1; // value must pass the scheme allowlist
const NUM_ATTR = 2; // value must be digits only
const ALIGN_ATTR = 3; // value must be a table-align keyword
const BOOL_ATTR = 4; // presence-only (value re-emitted empty)
const TEXT_ATTR = 5; // free text, escaped on output

const GLOBAL_ATTRS = { title: TEXT_ATTR };

const TAG_ATTRS = {
  a: { href: URL_ATTR, title: TEXT_ATTR, target: TEXT_ATTR, rel: TEXT_ATTR, name: TEXT_ATTR },
  img: { src: URL_ATTR, alt: TEXT_ATTR, title: TEXT_ATTR, width: NUM_ATTR, height: NUM_ATTR },
  input: { type: TEXT_ATTR, checked: BOOL_ATTR, disabled: BOOL_ATTR },
  ol: { start: NUM_ATTR, reversed: BOOL_ATTR },
  th: { align: ALIGN_ATTR, colspan: NUM_ATTR, rowspan: NUM_ATTR, scope: TEXT_ATTR },
  td: { align: ALIGN_ATTR, colspan: NUM_ATTR, rowspan: NUM_ATTR },
  abbr: { title: TEXT_ATTR },
};

// ---- primitives -----------------------------------------------------------

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Decode the HTML entities an attacker uses to hide a scheme
// (`java&#115;cript:`, `javascript&colon;…`, `&#106;avascript:`). Numeric refs
// first, then a curated set of named refs — a SINGLE pass, matching how a
// browser decodes an attribute value once (so `&amp;#106;` stays inert here
// exactly as it would in the DOM).
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  colon: ":", tab: "\t", newline: "\n", sol: "/", nbsp: " ",
};
function decodeEntities(s) {
  return String(s)
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (m, n) => {
      const v = NAMED_ENTITIES[n.toLowerCase()];
      return v === undefined ? m : v;
    });
}
function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try { return String.fromCodePoint(n); } catch { return ""; }
}

// Is this href/src value safe to keep? Decodes entities, strips ALL control /
// whitespace characters (defeats `java\tscript:`, `java\nscript:`, leading
// spaces, NULs), then checks the leading scheme against the allowlist. A value
// with no leading scheme (relative URL, fragment, protocol-relative //host) is
// treated as safe.
export function isSafeUrl(value) {
  if (typeof value !== "string") return false;
  const stripped = decodeEntities(value).replace(/[\x00-\x20\x7f-\xa0\u2028\u2029]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!m) return true; // no scheme => relative/fragment/host-relative
  return SAFE_SCHEMES.has(m[1].toLowerCase());
}

// ---- attribute handling ---------------------------------------------------

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw) {
  const out = [];
  if (!raw) return out;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    if (m.index === ATTR_RE.lastIndex) ATTR_RE.lastIndex++; // never spin on empty match
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out.push({ name, value });
  }
  return out;
}

// Filter a tag's attributes against its allowlist. Returns the serialized
// attribute string (leading space per attr) or `null` to signal "drop the whole
// element" (used for a non-checkbox <input>, which has no safe rendering here).
function filterAttrs(tag, attrs) {
  const spec = TAG_ATTRS[tag] || {};
  // A stray <input> that is not a task-list checkbox is dropped entirely — we
  // never want a live form control minted from ticket text.
  if (tag === "input") {
    const type = attrs.find((a) => a.name === "type");
    if (!type || decodeEntities(type.value).trim().toLowerCase() !== "checkbox") {
      return null;
    }
  }
  let out = "";
  let hasTargetBlank = false;
  let relValue = null;
  let hasDisabled = false;
  for (const { name, value } of attrs) {
    if (name.startsWith("on")) continue; // event handlers, always
    const kind = spec[name] ?? GLOBAL_ATTRS[name];
    if (kind === undefined) continue; // not allowlisted for this element
    switch (kind) {
      case URL_ATTR:
        if (!isSafeUrl(value)) continue;
        out += ` ${name}="${escapeAttr(value)}"`;
        break;
      case NUM_ATTR:
        if (!/^\d+$/.test(value)) continue;
        out += ` ${name}="${escapeAttr(value)}"`;
        break;
      case ALIGN_ATTR:
        if (!/^(left|right|center|justify)$/i.test(value)) continue;
        out += ` ${name}="${value.toLowerCase()}"`;
        break;
      case BOOL_ATTR:
        if (name === "disabled") hasDisabled = true;
        out += ` ${name}=""`;
        break;
      case TEXT_ATTR:
      default:
        if (name === "target") hasTargetBlank = value === "_blank";
        if (name === "rel") { relValue = value; continue; } // re-emitted below
        out += ` ${name}="${escapeAttr(value)}"`;
        break;
    }
  }
  // Preserve any author rel; if the link opens a new tab, guarantee the
  // reverse-tabnabbing guard even when the source omitted it.
  if (tag === "a" && (relValue !== null || hasTargetBlank)) {
    let rel = relValue || "";
    if (hasTargetBlank && !/\bnoopener\b/i.test(rel)) rel = (rel + " noopener").trim();
    if (hasTargetBlank && !/\bnoreferrer\b/i.test(rel)) rel = (rel + " noreferrer").trim();
    if (rel) out += ` rel="${escapeAttr(rel)}"`;
  }
  // GFM task-list checkboxes are display-only. Force `disabled` so attacker
  // raw Markdown can never leave a live, interactive control in rendered output.
  if (tag === "input" && !hasDisabled) out += ` disabled=""`;
  return out;
}

// ---- tokenizer + walk -----------------------------------------------------

// Matches an HTML comment / CDATA / bogus (`<!…>` `<?…>`) construct, or a start
// / end tag. Quoted attribute values may contain `>` — the alternation in the
// attribute portion keeps the match from ending inside a quoted value.
const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"'`]|"[^"]*"|'[^']*'|`[^`]*`)*)>/g;

/**
 * Sanitize a `marked`-produced HTML string into inert, allowlisted HTML.
 * Pure: no DOM, no I/O, never mutates its input or any stored text.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (typeof html !== "string" || html === "") return "";
  const out = [];
  let last = 0;
  let dropUntil = null; // when set, we are discarding a raw-text element's body
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html)) !== null) {
    const gap = html.slice(last, m.index); // text between the previous and this token
    last = TOKEN_RE.lastIndex;

    if (!dropUntil) emitText(out, gap);

    const full = m[0];
    const isEndSlash = m[1];
    const rawName = m[2];
    // Comments / CDATA / bogus declarations (m[2] undefined) are always dropped.
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();

    if (dropUntil) {
      // Inside a raw-text element: discard everything until its close tag.
      if (isEndSlash && name === dropUntil) dropUntil = null;
      continue;
    }

    if (DROP_CONTENT_TAGS.has(name)) {
      // Open a raw-text drop region (start tag only; a stray end tag is just
      // dropped). Its body is discarded until the matching close tag / EOF.
      if (!isEndSlash) dropUntil = name;
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) continue; // default-deny: drop tag, keep children

    if (isEndSlash) {
      if (!VOID_TAGS.has(name)) out.push(`</${name}>`);
      continue;
    }

    const attrs = filterAttrs(name, parseAttrs(m[3]));
    if (attrs === null) continue; // element rejected wholesale (e.g. non-checkbox input)
    out.push(`<${name}${attrs}>`);
  }
  if (!dropUntil) emitText(out, html.slice(last));
  return out.join("");
}

// Text between tags. `marked` escapes `<`/`>`/`&` in real text, so any bare `<`
// reaching here failed to form a token — escape it so it cannot combine with
// following markup in the browser parser.
function emitText(out, text) {
  if (!text) return;
  out.push(text.indexOf("<") === -1 ? text : escapeText(text));
}
