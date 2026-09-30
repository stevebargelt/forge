// FG-829: the role glyph tile — colour by family, glyph by role. One rounded square per
// role, drawn inline from the tables below: no image request, no server route, no storage.
// A new seed is one line in ROLE_FAMILY_OF and one in ROLE_GLYPHS;
// dashboard/src/fg829-role-glyph.test.ts fails for a seed under seeds/agents/ missing
// either. A role neither table knows (an uninstalled or future seed, the orchestrator)
// renders the neutral family and the layers glyph, never an error.

export const ROLE_FAMILIES = Object.freeze({
  red: "#e0574f",
  build: "#3b6cff",
  test: "#39b86f",
  review: "#e59a2b",
  research: "#8e5cff",
  plan: "#26bfb1",
  author: "#f5b400",
  // The FG-824 neutral token's colour (--fg-dim, the neutral badges in shell.ts).
  neutral: "#9a9aa3",
});

export const ROLE_FAMILY_OF = Object.freeze({
  "red-wide": "red",
  "red-narrow": "red",
  "red-frontend": "red",
  "red-backend": "red",
  "red-security": "red",
  engineer: "build",
  "agentic-platform-builder": "build",
  "backend-specialist": "build",
  "frontend-specialist": "build",
  "security-advisor": "build",
  "test-engineer": "test",
  "manual-qa": "test",
  "shipping-reviewer": "review",
  "review-rechecker": "review",
  "research-framer": "research",
  "research-primary": "research",
  "research-skeptic": "research",
  "research-specialist": "research",
  synthesizer: "research",
  "architecture-advisor": "plan",
  "tech-lead": "plan",
  "documentation-maintainer": "author",
  "prompt-author": "author",
});

// Line icons on a 24-unit box, each a list of [element, attributes] so the string form
// and the Preact form (role-glyph-view.js) draw the same shapes.
const p = (d) => ["path", { d }];
export const GLYPHS = Object.freeze({
  wrench: [p("M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-2.6z")],
  blueprint: [["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }], p("M4 10h16M10 10v10")],
  server: [["rect", { x: 4, y: 4, width: 16, height: 6, rx: 1.5 }], ["rect", { x: 4, y: 14, width: 16, height: 6, rx: 1.5 }], p("M8 7h.01M8 17h.01")],
  book: [p("M5 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H5z"), p("M19 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z")],
  layout: [["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }], p("M4 10h16M9 10v10")],
  cursor: [p("M5 4l14 7-6 2-2 6z")],
  pen: [p("M4 20l4-1L19 8l-3-3L5 16z"), p("M14 7l3 3")],
  shield: [p("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z")],
  eye: [p("M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"), ["circle", { cx: 12, cy: 12, r: 2.5 }]],
  lens: [["circle", { cx: 11, cy: 11, r: 6 }], p("M20 20l-4.5-4.5")],
  "check-cycle": [p("M20 12a8 8 0 1 1-2.3-5.7"), p("M20 4v5h-5"), p("M9 12l2 2 4-4")],
  ship: [p("M4 15h16l-2 4H6z"), p("M6 15V7h6l2 3h6v5")],
  funnel: [p("M4 5h16l-6 7v6l-4 2v-8z")],
  map: [p("M9 4l6 2 5-2v14l-5 2-6-2-5 2V6z"), p("M9 4v14M15 6v14")],
  flask: [p("M10 3h4M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3")],
  layers: [p("M12 4l8 4-8 4-8-4z"), p("M4 12l8 4 8-4M4 16l8 4 8-4")],
});

export const ROLE_GLYPHS = Object.freeze({
  engineer: "wrench",
  "agentic-platform-builder": "wrench",
  "architecture-advisor": "blueprint",
  "backend-specialist": "server",
  "red-backend": "server",
  "frontend-specialist": "layout",
  "red-frontend": "layout",
  "documentation-maintainer": "book",
  "manual-qa": "cursor",
  "prompt-author": "pen",
  "security-advisor": "shield",
  "red-security": "shield",
  "red-wide": "eye",
  "red-narrow": "lens",
  "research-framer": "lens",
  "research-primary": "lens",
  "research-skeptic": "lens",
  "research-specialist": "lens",
  "review-rechecker": "check-cycle",
  "shipping-reviewer": "ship",
  synthesizer: "funnel",
  "tech-lead": "map",
  "test-engineer": "flask",
});

export const UNKNOWN_FAMILY = "neutral";
export const UNKNOWN_GLYPH = "layers";
// FG-837: `list` is the Roles list row tile, `page` the role page header's.
export const TILE_SIZES = Object.freeze({ row: 20, header: 36, list: 36, page: 48 });

const own = (table, key) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);

export function roleFamily(role) {
  return own(ROLE_FAMILY_OF, role) ?? UNKNOWN_FAMILY;
}

export function roleGlyph(role) {
  return own(ROLE_GLYPHS, role) ?? UNKNOWN_GLYPH;
}

/** Everything a tile draws, as data. `label` is set only when the tile stands alone —
 *  beside a visible role name it is decorative and hidden from assistive tech. */
export function roleTileSpec(role, size = TILE_SIZES.row, { standalone = false } = {}) {
  const family = roleFamily(role);
  const colour = ROLE_FAMILIES[family];
  const large = size >= 32;
  const glyphSize = large ? Math.round((size * 5) / 9) : Math.round(size * 0.6);
  return {
    role: String(role ?? ""),
    family,
    glyph: roleGlyph(role),
    colour,
    size,
    radius: size / 4,
    glyphSize,
    glyphOffset: (size - glyphSize) / 2,
    strokeWidth: large ? 1.9 : 2.2,
    label: standalone ? String(role ?? "") : null,
  };
}

const escapeAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) => Object.entries(o).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");

/** The tile's SVG element and its two children's attributes, shared by both renderers. */
export function roleTileParts(spec) {
  return {
    svg: {
      class: "role-tile",
      width: spec.size,
      height: spec.size,
      viewBox: `0 0 ${spec.size} ${spec.size}`,
      focusable: "false",
      "data-role": spec.role,
      "data-family": spec.family,
      "data-glyph": spec.glyph,
      ...(spec.label === null ? { "aria-hidden": "true" } : { role: "img", "aria-label": spec.label }),
    },
    frame: {
      x: 0.5, y: 0.5, width: spec.size - 1, height: spec.size - 1, rx: spec.radius - 0.5,
      fill: spec.colour, "fill-opacity": 0.13, stroke: spec.colour, "stroke-opacity": 0.33, "stroke-width": 1,
    },
    glyph: {
      x: spec.glyphOffset, y: spec.glyphOffset, width: spec.glyphSize, height: spec.glyphSize, viewBox: "0 0 24 24",
      fill: "none", stroke: spec.colour, "stroke-width": spec.strokeWidth, "stroke-linecap": "round", "stroke-linejoin": "round",
    },
    shapes: GLYPHS[spec.glyph],
  };
}

/** The tile as an inline SVG string: 20px in lists and task rows, 36px on a role page. */
export function roleTile(role, size = TILE_SIZES.row, options) {
  const t = roleTileParts(roleTileSpec(role, size, options));
  const shapes = t.shapes.map(([el, a]) => `<${el}${attrs(a)}/>`).join("");
  return `<svg${attrs(t.svg)}><rect${attrs(t.frame)}/><svg${attrs(t.glyph)}>${shapes}</svg></svg>`;
}
