// FG-828: the Roles list's sort — the pure comparator over rolesIndexRows and the
// `#roles?sort=<column>&dir=asc|desc` hash round-trip. The browser suite
// (browser-tests/fg828-roles-sort.test.ts) clicks the headers that render these.

import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_SORT_COLUMNS, rolesIndexRows, rolesSortHash, rolesSortState, sortRoles, type RoleIndexEntry, type RolesIndexBody } from "../client/roles-index-render.js";
import { hashFor, parseHash } from "../client/view-routing.js";

function entry(role: string, over: Partial<RoleIndexEntry> = {}): RoleIndexEntry {
  return {
    role, description: "", defaultActivity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5",
    resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "blue", settings: true, protocolSha: null, lastTaskAt: null,
    ...over,
  };
}

const BODY: RolesIndexBody = {
  generation: null,
  roles: [
    entry("tech-lead", { defaultActivity: "reasoning", profile: "anthropic-api", lastTaskAt: "2026-09-28T10:00:00.000Z" }),
    entry("Architect", { defaultActivity: "Reasoning", profile: "Codex", mountMode: "ro", lastTaskAt: "2026-09-29T09:00:00.000Z" }),
    entry("engineer", { lastTaskAt: "2026-09-29T11:00:00.000Z" }),
    entry("red-wide", { defaultActivity: "review", mountMode: "ro", settings: false, profile: null, model: null }),
    entry("broken", { defaultActivity: "", resolutionError: "no mapping for activity x", mountMode: undefined as unknown as "rw" }),
    entry("scout", { defaultActivity: "review", mountMode: "ro", lastTaskAt: "2026-09-28T10:00:00.000Z" }),
  ],
};
const ROWS = rolesIndexRows(BODY);
const order = (column: string, dir: string) => sortRoles(ROWS, column, dir).map((r) => r.role);

test("sortRoles: role name case-insensitively, both directions", () => {
  assert.deepEqual(order("role", "asc"), ["Architect", "broken", "engineer", "red-wide", "scout", "tech-lead"]);
  assert.deepEqual(order("role", "desc"), ["tech-lead", "scout", "red-wide", "engineer", "broken", "Architect"]);
});

test("sortRoles: activity case-insensitively, missing last in both directions, ties by role ascending", () => {
  assert.deepEqual(order("activity", "asc"), ["engineer", "Architect", "tech-lead", "red-wide", "scout", "broken"]);
  assert.deepEqual(order("activity", "desc"), ["red-wide", "scout", "Architect", "tech-lead", "engineer", "broken"]);
});

test("sortRoles: resolved profile, a legacy or unresolvable profile sorts last in both directions", () => {
  assert.deepEqual(order("profile", "asc"), ["tech-lead", "engineer", "scout", "Architect", "broken", "red-wide"]);
  assert.deepEqual(order("profile", "desc"), ["Architect", "engineer", "scout", "tech-lead", "broken", "red-wide"]);
});

test("sortRoles: mount, a missing mode sorts last, ties by role ascending in both directions", () => {
  assert.deepEqual(order("mount", "asc"), ["Architect", "red-wide", "scout", "engineer", "tech-lead", "broken"]);
  assert.deepEqual(order("mount", "desc"), ["engineer", "tech-lead", "Architect", "red-wide", "scout", "broken"]);
});

test("sortRoles: last task on the ISO timestamp, never-ran last in both directions", () => {
  assert.deepEqual(order("lastTask", "desc"), ["engineer", "Architect", "scout", "tech-lead", "broken", "red-wide"]);
  assert.deepEqual(order("lastTask", "asc"), ["scout", "tech-lead", "Architect", "engineer", "broken", "red-wide"]);
});

test("sortRoles: compares instants, not strings — an offset timestamp sorts by when it happened", () => {
  const rows = rolesIndexRows({ generation: null, roles: [
    entry("a", { lastTaskAt: "2026-09-29T12:00:00+05:00" }),
    entry("b", { lastTaskAt: "2026-09-29T08:00:00.000Z" }),
  ] });
  assert.deepEqual(sortRoles(rows, "lastTask", "desc").map((r) => r.role), ["b", "a"]);
});

test("sortRoles: an unknown column sorts by role; the input is not mutated", () => {
  const before = ROWS.map((r) => r.role);
  assert.deepEqual(sortRoles(ROWS, "bogus", "asc").map((r) => r.role), order("role", "asc"));
  assert.deepEqual(ROWS.map((r) => r.role), before);
});

test("rolesSortState: default role ascending; unknown column or dir falls back silently", () => {
  assert.deepEqual(rolesSortState(null), { column: "role", dir: "asc" });
  assert.deepEqual(rolesSortState({ sort: "lastTask", dir: "desc" }), { column: "lastTask", dir: "desc" });
  assert.deepEqual(rolesSortState({ sort: "bogus", dir: "sideways" }), { column: "role", dir: "asc" });
  assert.deepEqual(rolesSortState({ sort: "mount" }), { column: "mount", dir: "asc" });
});

test("rolesSortHash: a new column sorts ascending, the active one flips", () => {
  assert.equal(rolesSortHash({ column: "role", dir: "asc" }, "mount"), "#roles?sort=mount&dir=asc");
  assert.equal(rolesSortHash({ column: "mount", dir: "asc" }, "mount"), "#roles?sort=mount&dir=desc");
  assert.equal(rolesSortHash({ column: "mount", dir: "desc" }, "mount"), "#roles?sort=mount&dir=asc");
  assert.equal(rolesSortHash({ column: "role", dir: "asc" }, "role"), "#roles?sort=role&dir=desc");
});

test("the sort hash round-trips through parseHash for every column and direction", () => {
  for (const sort of ROLE_SORT_COLUMNS) {
    for (const dir of ["asc", "desc"]) {
      const hash = hashFor({ view: "roles", params: { sort, dir } });
      assert.equal(hash, `#roles?sort=${sort}&dir=${dir}`);
      const parsed = parseHash(hash);
      assert.deepEqual([parsed.view, parsed.id, parsed.params, parsed.rewrite], ["roles", null, { sort, dir }, false]);
      assert.deepEqual(rolesSortState(parsed.params), { column: sort, dir });
    }
  }
});

test("an unknown sort or dir is dropped from the canonical hash; the nav link and role pages carry none", () => {
  const bogus = parseHash("#roles?sort=bogus&dir=desc");
  assert.deepEqual([bogus.params, bogus.canonical, bogus.rewrite], [{ dir: "desc" }, "#roles?dir=desc", true]);
  const both = parseHash("#roles?sort=profile&dir=up");
  assert.deepEqual([both.params, both.canonical], [{ sort: "profile" }, "#roles?sort=profile"]);
  assert.deepEqual(rolesSortState(parseHash("#roles?sort=bogus&dir=nope").params), { column: "role", dir: "asc" });
  assert.equal(hashFor({ view: "roles" }), "#roles");
  const page = parseHash("#roles/engineer?sort=mount&dir=desc");
  assert.deepEqual([page.id, page.params, page.canonical], ["engineer", {}, "#roles/engineer"]);
  assert.equal(hashFor({ view: "roles", id: "engineer", params: { sort: "mount", dir: "asc" } }), "#roles/engineer");
  assert.equal(parseHash("#runs?status=failed").canonical, "#runs?status=failed", "the run index's status= is unchanged");
});
