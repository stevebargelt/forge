// FG-829: the role glyph tile as a Preact element — the same parts role-glyph.js
// serializes, so the page never parses markup to draw it.

import { h } from "preact";
import { TILE_SIZES, roleTileParts, roleTileSpec } from "./role-glyph.js";

export function RoleTile({ role, size = TILE_SIZES.row, standalone = false }) {
  const t = roleTileParts(roleTileSpec(role, size, { standalone }));
  return h("svg", t.svg,
    h("rect", t.frame),
    h("svg", t.glyph, ...t.shapes.map(([el, a], i) => h(el, { key: i, ...a }))));
}
