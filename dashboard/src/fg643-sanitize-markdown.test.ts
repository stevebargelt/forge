// FG-643 — the sanitizer is the security boundary; these are its proof.
//
// Two layers are exercised:
//   1. sanitizeHtml(...) directly on hostile HTML strings (the raw-HTML vector
//      `marked` passes through verbatim, and mXSS-adjacent elements).
//   2. the full md()/mdInline() pipeline (marked.parse -> sanitizeHtml), which
//      is exactly what reaches dangerouslySetInnerHTML in the client.
//
// Every malicious case asserts the dangerous element / attribute / scheme is
// ABSENT from the output — proven here at the unit level, INDEPENDENTLY of the
// CSP header (AC: sanitization must stand on its own). The authoritative
// through-the-DB browser regression is the test-engineer's follow-up; the seam
// for it is md()/mdInline() being importable and pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, isSafeUrl } from "../client/sanitize-html.js";
import { md, mdInline } from "../client/markdown.js";

// A hostile substring must not survive. Case-insensitive; also fails if the
// literal handler/scheme text is present in any form.
function assertAbsent(out: string, needles: string[]) {
  const low = out.toLowerCase();
  for (const n of needles) {
    assert.ok(!low.includes(n.toLowerCase()), `expected ${JSON.stringify(n)} absent from ${JSON.stringify(out)}`);
  }
}

// ---- raw-HTML injection (the marked passthrough vector) -------------------

test("<script> element and its body are removed entirely", () => {
  const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
  assertAbsent(out, ["<script", "alert(1)"]);
  assert.ok(out.includes("<p>ok</p>"));
});

test("event-handler attributes are stripped, element kept inert", () => {
  const out = sanitizeHtml('<img src=x onerror=alert(1)>');
  assertAbsent(out, ["onerror", "alert(1)"]);
  assert.ok(out.includes("<img"));
  assert.ok(out.includes('src="x"'));
});

test("onclick / onload / onmouseover on allowed tags are dropped", () => {
  const out = sanitizeHtml('<a href="https://ex.com" onclick="steal()" onmouseover="x()">y</a>');
  assertAbsent(out, ["onclick", "onmouseover", "steal(", "x()"]);
  assert.ok(out.includes('href="https://ex.com"'));
});

test("<iframe>, <object>, <embed>, <form> are removed", () => {
  const out = sanitizeHtml(
    '<iframe src="//evil"></iframe><object data="x"></object><embed src="y"><form action="z"></form>'
  );
  assertAbsent(out, ["<iframe", "<object", "<embed", "<form", "evil"]);
});

test("scriptable/namespace-switching SVG + its inner style are dropped with content", () => {
  const out = sanitizeHtml("<svg><style>@keyframes x{}</style><a xlink:href='javascript:alert(1)'>z</a></svg>");
  assertAbsent(out, ["<svg", "<style", "xlink", "javascript", "@keyframes"]);
});

test("<style> block content cannot leak through", () => {
  const out = sanitizeHtml('<style>body{background:url(javascript:alert(1))}</style><p>hi</p>');
  assertAbsent(out, ["<style", "javascript", "background:"]);
  assert.ok(out.includes("<p>hi</p>"));
});

test("HTML comments (and conditional-comment shells) are dropped", () => {
  const out = sanitizeHtml("<!--[if IE]><script>alert(1)</script><![endif]--><p>x</p>");
  assertAbsent(out, ["<!--", "<script", "alert(1)", "[if ie]"]);
  assert.ok(out.includes("<p>x</p>"));
});

test("a non-checkbox <input> is dropped wholesale, task-list checkbox is kept", () => {
  const evil = sanitizeHtml('<input type="text" onfocus="alert(1)" autofocus>');
  assertAbsent(evil, ["<input", "onfocus", "alert(1)", "autofocus"]);
  const box = sanitizeHtml('<input checked="" disabled="" type="checkbox">');
  assert.ok(box.includes("<input"));
  assert.ok(box.includes('type="checkbox"'));
  assertAbsent(box, ["onfocus", "autofocus"]);
});

// RF-2: a permitted checkbox is display-only. Even when the raw Markdown omits
// (or actively drops) `disabled`, the sanitizer must force it — an enabled live
// control must never survive from attacker-controlled ticket text.
test("checkbox input is forced disabled even when the source omits it", () => {
  const bare = sanitizeHtml("<input type=checkbox>");
  assert.ok(bare.includes("<input"));
  assert.ok(bare.includes('type="checkbox"'));
  assert.ok(bare.includes('disabled=""'), `expected forced disabled in ${JSON.stringify(bare)}`);
});

test("checkbox input carrying only `checked` is still forced disabled", () => {
  const checked = sanitizeHtml('<input type="checkbox" checked>');
  assert.ok(checked.includes('checked=""'));
  assert.ok(checked.includes('disabled=""'), `expected forced disabled in ${JSON.stringify(checked)}`);
});

test("an author-supplied disabled is not duplicated", () => {
  const once = sanitizeHtml('<input type="checkbox" disabled>');
  assert.equal(once.match(/disabled=""/g)?.length, 1, `expected exactly one disabled in ${JSON.stringify(once)}`);
});

// ---- URL scheme handling: encoded + mixed-case + whitespace ---------------

const HOSTILE_URLS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "  javascript:alert(1)",
  "javascript:alert(1)",
  "java&#115;cript:alert(1)",       // decimal entity for 's'
  "&#106;avascript:alert(1)",        // decimal entity for 'j'
  "&#x6a;avascript:alert(1)",        // hex entity for 'j'
  "javascript&colon;alert(1)",       // named colon entity
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD4=",
];

for (const u of HOSTILE_URLS) {
  test(`isSafeUrl rejects hostile scheme: ${JSON.stringify(u)}`, () => {
    assert.equal(isSafeUrl(u), false);
  });
  test(`sanitizeHtml drops href with hostile scheme: ${JSON.stringify(u)}`, () => {
    const out = sanitizeHtml(`<a href="${u}">click</a>`);
    assertAbsent(out, ["javascript", "vbscript", "data:text/html", "alert(1)", "msgbox", "base64"]);
    assert.ok(out.includes("click"), "link text is preserved even when href is dropped");
  });
}

const SAFE_URLS = [
  "https://example.com/path?q=1",
  "http://example.com",
  "mailto:a@b.com",
  "tel:+15551234",
  "/relative/path",
  "#anchor",
  "//cdn.example.com/x",
  "ftp://files.example.com/x",
];
for (const u of SAFE_URLS) {
  test(`isSafeUrl accepts safe URL: ${JSON.stringify(u)}`, () => {
    assert.equal(isSafeUrl(u), true);
  });
}

// ---- malformed / mismatched nesting must not open an execution path -------

// Parse-level inertness: no live <script>, no start tag carrying an on* handler,
// and no href/src attribute whose value is a scriptable scheme. A dangerous
// STRING may survive as escaped text (e.g. an unclosed `<img …>` at EOF becomes
// `&lt;img …` — visible text, not a tag); that is inert and allowed.
function assertInert(out: string) {
  assert.ok(!/<script/i.test(out), `live <script> in ${JSON.stringify(out)}`);
  assert.ok(!/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(out), `live event handler in ${JSON.stringify(out)}`);
  assert.ok(
    !/\b(?:href|src)\s*=\s*["']?\s*(?:javascript|data|vbscript)\s*:/i.test(out),
    `live scriptable URL attribute in ${JSON.stringify(out)}`
  );
}

test("malformed / mismatched nesting stays inert", () => {
  const cases = [
    "<p><b>bold<script>alert(1)</p>",
    "<div><span onclick=x>><img src=q onerror=alert(1)",
    "</script><script>alert(1)",
    "<a href='javascript:alert(1)'<b>x",
    "<<script>script>alert(1)<</script>/script>",
    '<img src=x onerror="foo>bar" onclick=alert(1)>',
    "<a href=\"javascript:alert(1)\" >x</a>",
  ];
  for (const c of cases) assertInert(sanitizeHtml(c));
});

// ---- safe Markdown still renders (AC3) ------------------------------------

test("headings, emphasis, code render", () => {
  const out = md("# Title\n\nsome **bold** and `code` and _em_ and ~~del~~");
  assert.ok(out.includes("<h1>Title</h1>"));
  assert.ok(out.includes("<strong>bold</strong>"));
  assert.ok(out.includes("<code>code</code>"));
  assert.ok(out.includes("<em>em</em>"));
  assert.ok(out.includes("<del>del</del>"));
});

test("lists, ordered start, and task-list checkboxes render", () => {
  const ul = md("- a\n- b");
  assert.ok(ul.includes("<ul>") && ul.includes("<li>a</li>"));
  const ol = md("3. three\n4. four");
  assert.ok(ol.includes('<ol start="3">'));
  const task = md("- [ ] todo\n- [x] done");
  assert.ok(task.includes('type="checkbox"'));
  assert.ok(task.includes("checked"));
});

test("GFM tables with alignment render (align attribute preserved)", () => {
  const out = md("| a | b |\n|:--|--:|\n| 1 | 2 |");
  assert.ok(out.includes("<table>"));
  assert.ok(out.includes('align="left"'));
  assert.ok(out.includes('align="right"'));
});

test("code blocks and blockquotes render", () => {
  const out = md("> quote\n\n```\ncode block\n```");
  assert.ok(out.includes("<blockquote>"));
  assert.ok(out.includes("<pre>"));
  assert.ok(out.includes("code block"));
});

test("ordinary https links render and keep their href", () => {
  const out = md("[ex](https://example.com)");
  assert.ok(out.includes('href="https://example.com"'));
  assert.ok(out.includes(">ex</a>"));
});

test("a link opening a new tab gets a tabnabbing guard (safe target/rel)", () => {
  const out = sanitizeHtml('<a href="https://ex.com" target="_blank">x</a>');
  assert.ok(out.includes('target="_blank"'));
  assert.ok(/rel="[^"]*noopener[^"]*"/.test(out));
});

// ---- full pipeline: hostile Markdown source is inert on output ------------

test("md() pipeline: hostile markdown source produces inert HTML", () => {
  const out = md('[click](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');
  assertAbsent(out, ["javascript:", "onerror", "<script", "alert(1)", "alert(2)"]);
  assert.ok(out.includes("click"));
});

test("mdInline() pipeline sanitizes inline injection", () => {
  const out = mdInline("**b** [x](javascript:alert(1)) <img src=q onerror=e()>");
  assert.ok(out.includes("<strong>b</strong>"));
  assertAbsent(out, ["javascript:", "onerror", "e()"]);
});

// ---- AC5: sanitization is a pure output transform, never a write-back -----

test("sanitizeHtml does not mutate its input and is deterministic", () => {
  const input = '<p>ok</p><script>alert(1)</script>';
  const copy = String(input);
  const a = sanitizeHtml(input);
  const b = sanitizeHtml(input);
  assert.equal(input, copy, "input string is not mutated");
  assert.equal(a, b, "output is deterministic");
});

test("non-string / empty inputs are handled without throwing", () => {
  assert.equal(md(undefined as unknown as string), "");
  assert.equal(md(null as unknown as string), "");
  assert.equal(sanitizeHtml("" as string), "");
  assert.equal(sanitizeHtml(undefined as unknown as string), "");
});
