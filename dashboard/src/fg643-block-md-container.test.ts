// FG-643 / RF-1 — the MD renderer must place BLOCK Markdown output (headings,
// paragraphs, lists, tables) in a block container, not inside an inline <span>.
// `md("# H\n\npara")` emits <h1>/<p>; wrapping that in a <span> is invalid
// semantic HTML. mdInline stays in a <span> (its output is phrasing content).
//
// This inspects the preact vnode the renderers produce — no DOM needed — by
// locating the internal <MD> component in a rendered result tree and invoking
// it with its props to see the element it emits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEngineer, renderArchitect } from "../client/renderers.js";

type VNode = { type: unknown; props?: { children?: unknown; [k: string]: unknown } };

function isVNode(x: unknown): x is VNode {
  return typeof x === "object" && x !== null && "type" in (x as object);
}

// Depth-first search for the first component vnode (function `type`) whose props
// match `pred` — that is the internal MD component with a `source` prop.
function findComponent(node: unknown, pred: (props: Record<string, unknown>) => boolean): VNode | null {
  if (Array.isArray(node)) {
    for (const c of node) {
      const found = findComponent(c, pred);
      if (found) return found;
    }
    return null;
  }
  if (!isVNode(node)) return null;
  if (typeof node.type === "function" && node.props && pred(node.props)) return node;
  return node.props ? findComponent(node.props.children, pred) : null;
}

// Render the MD component the tree references and return the element it emits.
function renderMd(tree: unknown, wantInline: boolean): VNode {
  const md = findComponent(tree, (p) => "source" in p && Boolean(p.inline) === wantInline);
  assert.ok(md, `expected an MD component with inline=${wantInline}`);
  const el = (md.type as (props: unknown) => unknown)(md.props);
  assert.ok(isVNode(el), "MD component returned a vnode");
  return el;
}

test("block MD output is wrapped in a <div>, not an inline <span>", () => {
  const tree = renderEngineer({ diff_summary: "# Heading\n\nA paragraph." });
  const el = renderMd(tree, false);
  assert.equal(el.type, "div", `block Markdown must render in a block container, got <${String(el.type)}>`);
  assert.equal(el.props?.class, "md");
});

test("inline MD output stays in a <span>", () => {
  const tree = renderArchitect({ risks: [{ severity: "low", summary: "s", evidence: "**bold** evidence" }] });
  const el = renderMd(tree, true);
  assert.equal(el.type, "span", `inline Markdown must stay inline, got <${String(el.type)}>`);
  assert.equal(el.props?.class, "md");
});
