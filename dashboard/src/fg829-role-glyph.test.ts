// FG-829: the role glyph tile's pure decisions — every role's family and glyph per the
// approved table, the neutral fallback, the SVG's shape (inline, no script, no external
// reference), and a census of seeds/agents/* so a new seed without an entry fails here,
// not on the page. The browser suite (browser-tests/fg829-role-glyphs.test.ts) renders it.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GLYPHS, ROLE_FAMILIES, ROLE_FAMILY_OF, ROLE_GLYPHS, TILE_SIZES, roleFamily, roleGlyph, roleTile, roleTileSpec,
} from "../client/role-glyph.js";

const SEEDS = fileURLToPath(new URL("../../seeds/agents", import.meta.url));

const FAMILIES: Record<string, [string, string[]]> = {
  red: ["#e0574f", ["red-wide", "red-narrow", "red-frontend", "red-backend", "red-security"]],
  build: ["#3b6cff", ["engineer", "agentic-platform-builder", "backend-specialist", "frontend-specialist", "security-advisor"]],
  test: ["#39b86f", ["test-engineer", "manual-qa"]],
  review: ["#e59a2b", ["shipping-reviewer", "review-rechecker"]],
  research: ["#8e5cff", ["research-framer", "research-primary", "research-skeptic", "research-specialist", "synthesizer"]],
  plan: ["#26bfb1", ["architecture-advisor", "tech-lead"]],
  author: ["#f5b400", ["documentation-maintainer", "prompt-author"]],
};

const GLYPH_OF: Record<string, string> = {
  engineer: "wrench", "agentic-platform-builder": "wrench", "architecture-advisor": "blueprint",
  "backend-specialist": "server", "red-backend": "server", "frontend-specialist": "layout", "red-frontend": "layout",
  "documentation-maintainer": "book", "manual-qa": "cursor", "prompt-author": "pen",
  "security-advisor": "shield", "red-security": "shield", "red-wide": "eye", "red-narrow": "lens",
  "research-framer": "lens", "research-primary": "lens", "research-skeptic": "lens", "research-specialist": "lens",
  "review-rechecker": "check-cycle", "shipping-reviewer": "ship", synthesizer: "funnel", "tech-lead": "map",
  "test-engineer": "flask",
};

function seedRoles(): string[] {
  return readdirSync(SEEDS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SEEDS, e.name, "CLAUDE.md")))
    .map((e) => e.name)
    .sort();
}

test("FG-829: every role in the approved table resolves to its family and colour", () => {
  for (const [family, [colour, roles]] of Object.entries(FAMILIES)) {
    assert.equal(ROLE_FAMILIES[family as keyof typeof ROLE_FAMILIES], colour, `${family} colour`);
    for (const role of roles) assert.equal(roleFamily(role), family, role);
  }
  const tabled = Object.values(FAMILIES).flatMap(([, roles]) => roles).sort();
  assert.deepEqual(Object.keys(ROLE_FAMILY_OF).sort(), tabled, "the family table names exactly the approved roles");
});

test("FG-829: reds are red and nothing else is", () => {
  for (const role of Object.keys(ROLE_FAMILY_OF)) {
    const tile = roleTileSpec(role);
    assert.equal(tile.colour === ROLE_FAMILIES.red, role.startsWith("red-"), `${role} is ${tile.colour}`);
  }
  const colours = Object.values(ROLE_FAMILIES);
  assert.equal(new Set(colours).size, colours.length, "one colour per family");
});

test("FG-829: every role resolves to its glyph, and every glyph is drawn", () => {
  assert.deepEqual({ ...ROLE_GLYPHS }, GLYPH_OF);
  for (const [role, glyph] of Object.entries(GLYPH_OF)) {
    assert.equal(roleGlyph(role), glyph, role);
    assert.ok((GLYPHS[glyph]?.length ?? 0) > 0, `${glyph} has shapes`);
  }
  assert.ok((GLYPHS.layers?.length ?? 0) > 0);
});

test("FG-829: an unknown role is the neutral family with the layers glyph, never an error", () => {
  for (const role of ["orchestrator", "", "constructor", "__proto__", "toString", undefined, null, 42]) {
    assert.equal(roleFamily(role), "neutral", String(role));
    assert.equal(roleGlyph(role), "layers", String(role));
    assert.doesNotThrow(() => roleTile(role));
  }
  assert.equal(ROLE_FAMILIES.neutral, "#9a9aa3");
  const shell = readFileSync(fileURLToPath(new URL("./shell.ts", import.meta.url)), "utf8");
  assert.match(shell, /--fg-dim: #9a9aa3;/, "neutral is the FG-824 neutral token colour");
  assert.match(roleTile("orchestrator"), /data-family="neutral"[^>]*data-glyph="layers"/);
});

test("FG-829: every seed under seeds/agents has a family AND a glyph", () => {
  const seeds = seedRoles();
  assert.ok(seeds.length >= 23, `found ${seeds.length} seeds`);
  const missing = seeds.filter((r) => !Object.hasOwn(ROLE_FAMILY_OF, r) || !Object.hasOwn(ROLE_GLYPHS, r));
  assert.deepEqual(missing, [], "add a line to ROLE_FAMILY_OF and ROLE_GLYPHS in dashboard/client/role-glyph.js");
});

test("FG-829: roleFamily and roleTile are pure and deterministic", () => {
  for (const role of [...seedRoles(), "orchestrator"]) {
    assert.equal(roleFamily(role), roleFamily(role));
    assert.equal(roleTile(role, 36), roleTile(role, 36));
  }
});

test("FG-829: family exclusivity and tile bytes hold across every seed and both display sizes", () => {
  const roles = [...seedRoles(), ...Object.keys(ROLE_FAMILY_OF), "uninstalled-future-role"];
  for (const role of new Set(roles)) {
    const row = roleTile(role, TILE_SIZES.row);
    const header = roleTile(role, TILE_SIZES.header);
    assert.equal(roleFamily(role) === "red", role.startsWith("red-"), `${role}: only red-* resolves red`);
    assert.equal(roleTile(role, TILE_SIZES.row), row, `${role}: row bytes repeat exactly`);
    assert.equal(roleTile(role, TILE_SIZES.header), header, `${role}: header bytes repeat exactly`);
    // The two renderings share every semantic byte. Only geometry that deliberately
    // scales with the tile (including its compensating glyph stroke) may differ.
    const withoutSizeGeometry = (svg: string) => svg.replace(
      /\s(?:width|height|viewBox|x|y|rx|stroke-width)="[^"]*"/g,
      ""
    );
    assert.equal(withoutSizeGeometry(row), withoutSizeGeometry(header), `${role}: size is the only variation`);
  }
  assert.equal(roleFamily("engineer"), roleFamily("security-advisor"), "builders share one family colour");
  assert.equal(roleFamily("test-engineer"), roleFamily("manual-qa"), "testers share one family colour");
});

test("FG-829: the tile is a rounded square at 13% fill, a 1px 33% border and a stroked glyph", () => {
  const row = roleTile("engineer");
  assert.match(row, /^<svg class="role-tile" width="20" height="20" viewBox="0 0 20 20"/);
  assert.match(row, /<rect x="0.5" y="0.5" width="19" height="19" rx="4.5" fill="#3b6cff" fill-opacity="0.13" stroke="#3b6cff" stroke-opacity="0.33" stroke-width="1"\/>/);
  assert.match(row, /<svg x="4" y="4" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b6cff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">/);
  const header = roleTile("red-wide", TILE_SIZES.header);
  assert.match(header, /^<svg class="role-tile" width="36" height="36"/);
  assert.match(header, /rx="8.5" fill="#e0574f"/);
  assert.match(header, /<svg x="8" y="8" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e0574f" stroke-width="1.9"/);
  assert.equal(TILE_SIZES.row, 20);
  assert.equal(TILE_SIZES.header, 36);
});

test("FG-829: aria — hidden beside a visible name, role=img with a label when alone", () => {
  const beside = roleTile("tech-lead");
  assert.match(beside, /aria-hidden="true"/);
  assert.doesNotMatch(beside, /role="img"|aria-label/);
  const alone = roleTile("tech-lead", 20, { standalone: true });
  assert.match(alone, /role="img" aria-label="tech-lead"/);
  assert.doesNotMatch(alone, /aria-hidden/);
});

test("FG-829: the SVG carries no script, no event handler and no external reference", () => {
  const hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
  for (const role of [...seedRoles(), "orchestrator", hostile]) {
    for (const svg of [roleTile(role), roleTile(role, 36, { standalone: true })]) {
      const names = [...svg.matchAll(/\s([a-zA-Z:-]+)="[^"<>]*"/g)].map((m) => m[1] ?? "");
      assert.deepEqual(names.filter((n) => /^on/i.test(n) || /href|src|style/i.test(n)), [], `${role}: no handler, link or style attribute`);
      const skeleton = svg.replace(/\s[a-zA-Z:-]+="[^"<>]*"/g, "");
      assert.match(skeleton, /^<svg><rect\/><svg>(<(path|rect|circle)\/>)+<\/svg><\/svg>$/, `${role}: only svg, rect, path and circle`);
      assert.doesNotMatch(svg, /<script\b|<use\b|\s(?:href|xlink:href)\s*=|url\(|https?:|javascript:|data:/i, role);
    }
  }
});
