// FG-820 regression contracts that are deliberately independent of the component tests:
// the closed routing table cannot silently lose a group, and the browser badge cannot
// grow a second (client-computed) source of truth.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GROUPS, ROUTES } from "../client/view-routing.js";

test("FG-820: every closed-table route belongs to exactly one non-empty navigation group", () => {
  const groupIds = new Set(GROUPS.map((group) => group.id));
  const membership = new Map(GROUPS.map((group) => [group.id, 0]));

  for (const [view, route] of Object.entries(ROUTES)) {
    assert.equal(groupIds.has(route.group), true, `${view} belongs to a declared group`);
    membership.set(route.group, (membership.get(route.group) ?? 0) + 1);
  }

  for (const group of GROUPS) {
    assert.ok((membership.get(group.id) ?? 0) > 0, `${group.label} contains at least one route`);
  }
});

test("FG-820: the badge-owning client modules never derive attention from items.length", () => {
  const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
  for (const file of ["nav-render.js", "nav-view.js"]) {
    const source = readFileSync(join(clientDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /(?:items\s*\.\s*length|\.items\s*\.\s*length)/, `${file} must use server counts, not item cardinality`);
  }
});
