---
id: FG-75
type: story
status: done
title: "Dashboard: markdown rendering for prose result fields"
---

**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- New `looksLikeMarkdown(s)` heuristic in html.ts: triggers on at least one structural marker — heading line (`^#{1,6}\s`), triple-backtick fence (`^```), or two-or-more list-marker lines. Inline markers (bold, links) alone don't trigger; ordinary prose with one **bold** word stays plain.
- New `renderMarkdown(src)` walks lines and emits structured DOM: fenced code blocks (`<pre><code>`), headings (h3-h6 to avoid clashing with `.result-field-label` h3 above), ordered + unordered lists, paragraphs that gather consecutive non-structural lines.
- New `renderInline(s)` handles inline: HTML-escape input, then `**bold**`, `*em*`, `` `code` ``, `[text](url)` for http(s) + relative anchors. javascript: links explicitly rejected — anchor href regex requires `https?://` or `#` start. XSS-safe: input is escapeHtml'd before any markdown patterns are applied.
- Wired into `renderResultValue` — string values that pass the markdown heuristic go through `renderMarkdown`; everything else falls through to the existing paragraph treatment. Paths still get the `<code>` path treatment first (no regression).
- Backticks throughout (in regex source + comments) escaped via `\\u0060` because the entire CLIENT_JS lives inside a TS template literal where raw backticks would close the literal early.
- Pretty/raw toggle (#34) unchanged — raw mode keeps showing the source markdown.