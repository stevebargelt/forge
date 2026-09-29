// FG-817: the Roles surface's pure client decisions — the list rows and notices, the
// role page's tabs, captions and instruction sections, its breadcrumb trail and Escape
// parent, and the #roles route. The browser suite (browser-tests/fg817-roles-pages.test.ts)
// renders these.

import assert from "node:assert/strict";
import test from "node:test";
import { profileLabel, rolesIndexNotices, rolesIndexRows, rolesIndexSource, type RolesIndexBody } from "../client/roles-index-render.js";
import { ROLE_TABS, instructionSections, relationLabel, roleHeader, roleTabLabel, roleTabs, tabCaption } from "../client/role-page-render.js";
import { parentHash, roleTrail } from "../client/breadcrumbs-render.js";
import { NAV_GROUPS, hashFor, navItemFor, parseHash } from "../client/view-routing.js";
import { screenLineText } from "../client/screen-header-render.js";

const BODY: RolesIndexBody = {
  agentsDir: "/h/agents",
  generation: { id: "gen-1", root: "/h/seed-generations/gen-1", sourceAssetRoot: "/rel" },
  seedInstall: { kind: "healthy", reason: null },
  modelPolicy: { source: "host", path: "/h/model-policy.yml", error: null },
  storeError: null,
  roles: [
    { role: "engineer", description: "Implements.", defaultActivity: "default", profile: "claude-subscription", model: "claude-sonnet-5", effort: null, resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "blue", settings: true, protocolSha: "a".repeat(64), lastTaskAt: "2026-09-01T00:00:00.000Z" },
    { role: "red-wide", description: "", defaultActivity: "review", profile: "claude-subscription", model: "claude-opus-5-5", effort: "low", resolvedBy: "defaults.activity.review", resolutionError: null, mountMode: "ro", mountModeSource: "red", settings: false, protocolSha: null, lastTaskAt: null },
  ],
};

test("rolesIndexRows: every seed with its link, activity, resolved profile/effort and mount", () => {
  assert.deepEqual(rolesIndexRows(BODY).map((r) => [r.role, r.href, r.activity, r.profile, r.mount, r.settingsMissing]), [
    ["engineer", "#roles/engineer", "default", "claude-subscription · claude-sonnet-5", "read-write", false],
    ["red-wide", "#roles/red-wide", "review", "claude-subscription · claude-opus-5-5 · effort low", "read-only", true],
  ]);
  assert.equal(rolesIndexRows(BODY)[1]!.description, "—");
  assert.deepEqual(rolesIndexRows(null), []);
});

test("profileLabel names a legacy host and an unresolvable one rather than inventing a profile", () => {
  assert.equal(profileLabel({ profile: null, model: null }), "legacy (no model policy)");
  assert.equal(profileLabel({ resolutionError: "bad policy" }), "unresolved: bad policy");
});

test("rolesIndexNotices: a missing generation, an unreadable policy or store, and no seeds are each stated", () => {
  assert.deepEqual(rolesIndexNotices(BODY), []);
  const bare = rolesIndexNotices({ ...BODY, generation: null, seedInstall: { kind: "no-generation", reason: null }, modelPolicy: { source: "invalid", path: null, error: "schema" }, storeError: "no db", roles: [] });
  assert.equal(bare.length, 4);
  assert.match(bare[0]!, /No seed generation is published \(no-generation\).*forge upgrade/);
  assert.match(rolesIndexSource(BODY), /^Source: \/h\/agents; seed generation gen-1; \/h\/model-policy.yml/);
});

test("the role route: #roles is the list, #roles/<role>/<tab> a deep-linkable page, an unknown tab falls back to overview", () => {
  assert.deepEqual(NAV_GROUPS.find((g) => g.id === "setup")!.items, ["roles", "routing", "config", "projects"]);
  const list = parseHash("#roles");
  assert.deepEqual([list.view, list.id, list.rewrite], ["roles", null, false]);
  const deep = parseHash("#roles/engineer/instructions");
  assert.deepEqual([deep.view, deep.group, deep.id, deep.tab, deep.rewrite], ["roles", "setup", "engineer", "instructions", false]);
  const unknown = parseHash("#roles/engineer/bogus");
  assert.deepEqual([unknown.tab, unknown.canonical, unknown.rewrite], ["overview", "#roles/engineer", true]);
  assert.equal(parseHash("#roles/engineer?project=forge").canonical, "#roles/engineer", "role pages carry no scope");
  assert.equal(hashFor({ view: "roles", id: "engineer", tab: "overview" }), "#roles/engineer");
  assert.equal(navItemFor("roles"), "roles");
});

test("roleTabs: the nine tabs in order, overview's href the bare role, the current one marked", () => {
  assert.deepEqual(ROLE_TABS.map((t) => t.id), ["overview", "instructions", "skills", "configuration", "secrets", "tools", "tasks", "receipts", "usage"]);
  const tabs = roleTabs("engineer", "tasks");
  assert.deepEqual(tabs.filter((t) => t.current).map((t) => t.id), ["tasks"]);
  assert.equal(tabs[0]!.href, "#roles/engineer");
  assert.equal(tabs[6]!.href, "#roles/engineer/tasks");
  assert.equal(roleTabLabel("bogus"), "Overview");
});

test("roleTrail is Roles › <role> › <tab>, and Escape goes to the Roles list", () => {
  assert.deepEqual(roleTrail("engineer", "Instructions"), [
    { kind: "roles", label: "Roles", href: "#roles" },
    { kind: "role", label: "engineer", href: "#roles/engineer" },
    { kind: "role-tab", label: "Instructions", href: null },
  ]);
  assert.equal(parentHash("role", null), "#roles");
});

test("tabCaption names each tab's source, and says so when the payload carries none", () => {
  assert.equal(tabCaption({ usage: { source: "model_calls" } }, "usage"), "Source: model_calls");
  assert.equal(tabCaption({}, "usage"), "Source: unavailable");
});

test("instructionSections cuts the prompt at the server's bounds without losing a byte", () => {
  const prompt = "PROTO\n\n---\n\n# engineer\n\n---\n\n# Constraints\n\n## Constraint: x\n\nbody";
  const sections = [
    { kind: "protocol", title: "P", start: 0, end: 5 },
    { kind: "base", title: "B", start: 5, end: 23 },
    { kind: "constraint", id: "x", title: "Constraint: x", start: 23, end: prompt.length },
  ];
  const cut = instructionSections({ ok: true, prompt, sections });
  assert.equal(cut.map((s) => s.text).join(""), prompt);
  assert.deepEqual(cut.map((s) => [s.kind, s.id]), [["protocol", null], ["base", null], ["constraint", "x"]]);
  assert.deepEqual(instructionSections({ ok: false }), []);
});

test("roleHeader: never needs you, names forge model resolve; relationLabel spells follow-up out", () => {
  const header = roleHeader("engineer", { overview: { recentTasks: [{ status: "complete" }] } });
  assert.equal(screenLineText(header), "engineer last ran (complete) · A seed changes only through forge upgrade · Read why it runs where it does: forge model resolve engineer");
  assert.equal(header.needsYou, false);
  assert.equal(relationLabel(["consulted", "followup"]), "consulted, required follow-up");
});
