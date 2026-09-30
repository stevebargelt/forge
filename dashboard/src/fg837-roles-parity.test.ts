// FG-837: the Roles list and role page after Paperclip, as data — the one-line subtitle
// derived from a seed description, the family filter's state and its hash composing with
// FG-828's sort, and the role page's grouped sub-nav. The browser suite
// (browser-tests/fg837-roles-parity.test.ts) renders these.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ROLE_FAMILY_ALL, ROLE_ROW_CONTROLS, filterRolesByFamily, profileLine, roleSubtitle, rolesCountLabel, rolesFamilyHash, rolesFamilyState, rolesFamilyTabs,
  roleRowClickHref, rolesIndexRows, rolesSortHash, rolesSortLabel, type RoleIndexEntry,
} from "../client/roles-index-render.js";
import { ROLE_TABS, ROLE_TAB_GROUPS, overviewCards, recentTaskRows, roleMeta, roleSubnav } from "../client/role-page-render.js";
import { parseHash } from "../client/view-routing.js";

function entry(role: string, over: Partial<RoleIndexEntry> = {}): RoleIndexEntry {
  return {
    role, description: `The ${role} role.`, defaultActivity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5",
    resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "blue", settings: true, protocolSha: null, lastTaskAt: null,
    ...over,
  };
}

test("roleSubtitle: the first sentence only", () => {
  assert.equal(roleSubtitle("You implement the plan, one step at a time, in the mounted /project directory. Use --dangerously-skip-permissions"),
    "You implement the plan, one step at a time, in the mounted /project directory.");
  assert.equal(roleSubtitle("Stop! Then go."), "Stop!");
  assert.equal(roleSubtitle("Is it done? Maybe."), "Is it done?");
  assert.equal(roleSubtitle("Reads forge.db and v2.3 files. Then more."), "Reads forge.db and v2.3 files.", "a dot inside a word is not a sentence end");
  assert.equal(roleSubtitle("No sentence end at all"), "No sentence end at all");
});

test("roleSubtitle: Markdown is stripped — emphasis, code, links, headings — but snake_case survives", () => {
  assert.equal(roleSubtitle("You are a **systems architect**. Your job is to surface risk."), "You are a systems architect.");
  assert.equal(roleSubtitle("You write a `PROMPT.md` file."), "You write a PROMPT.md file.");
  assert.equal(roleSubtitle("You keep docs *true* and __current__."), "You keep docs true and current.");
  assert.equal(roleSubtitle("See [the guide](https://example.com/x) first. Then act."), "See the guide first.");
  assert.equal(roleSubtitle("# Heading\n\nYou read agent_role from tasks."), "Heading You read agent_role from tasks.");
  assert.equal(roleSubtitle("You are the **acceptance reviewer** — product-owner lens + tech-lead lens."), "You are the acceptance reviewer — product-owner lens + tech-lead lens.");
});

test("roleSubtitle: past the cap it is cut at a word boundary with one ellipsis; nothing is not an error", () => {
  const long = `You ${"coordinate many moving parts ".repeat(10)}today.`;
  const out = roleSubtitle(long);
  assert.ok(out.length <= 120, `${out.length} characters`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.endsWith(" …"));
  assert.ok(long.startsWith(out.slice(0, -1)), "the cut is a prefix of the sentence");
  assert.equal(roleSubtitle("abcdefghij klmno.", 10), "abcdefghi…", "no space in reach: cut hard");
  assert.equal(roleSubtitle("A short one.", 10), "A short…");
  assert.equal(roleSubtitle(undefined), "");
  assert.equal(roleSubtitle(""), "");
});

test("rolesIndexRows: family, subtitle, model and profile line per row", () => {
  const rows = rolesIndexRows({
    generation: null,
    roles: [
      entry("red-wide", { description: "You are a **wide-aperture** red auditor. More.", effort: "low", mountMode: "ro" }),
      entry("scout", { profile: null, model: null }),
      entry("tech-lead", { resolutionError: "no mapping" }),
    ],
  });
  assert.deepEqual(rows.map((r) => [r.role, r.family, r.subtitle, r.model, r.profileLine, r.mountMode]), [
    ["red-wide", "red", "You are a wide-aperture red auditor.", "claude-sonnet-5", "claude-subscription · effort low", "ro"],
    ["scout", "neutral", "The scout role.", "—", "legacy (no model policy)", "rw"],
    ["tech-lead", "plan", "The tech-lead role.", "unresolved", "unresolved: no mapping", "rw"],
  ]);
  assert.equal(profileLine({ profile: "p" }), "p");
});

const ROWS = rolesIndexRows({
  generation: null,
  roles: [entry("engineer"), entry("frontend-specialist"), entry("red-wide"), entry("red-narrow"), entry("tech-lead"), entry("scout")],
});

test("family filter state: a known FG-829 family or All; the tabs hide empty families but keep a selected one", () => {
  assert.equal(rolesFamilyState(null), ROLE_FAMILY_ALL);
  assert.equal(rolesFamilyState({ family: "red" }), "red");
  assert.equal(rolesFamilyState({ family: "neutral" }), ROLE_FAMILY_ALL, "neutral has no tab");
  assert.equal(rolesFamilyState({ family: "wizards" }), ROLE_FAMILY_ALL);
  assert.deepEqual(filterRolesByFamily(ROWS, "red").map((r) => r.role), ["red-wide", "red-narrow"]);
  assert.equal(filterRolesByFamily(ROWS, ROLE_FAMILY_ALL).length, 6, "All includes a neutral role");
  assert.deepEqual(rolesFamilyTabs(ROWS, ROLE_FAMILY_ALL).map((t) => [t.label, t.count, t.current]), [
    ["All", 6, true], ["Builders", 2, false], ["Reds", 2, false], ["Planners", 1, false],
  ]);
  assert.deepEqual(rolesFamilyTabs(ROWS, "author").map((t) => [t.label, t.count, t.current]).at(-1), ["Authors", 0, true]);
  assert.equal(rolesCountLabel(1), "1 role");
  assert.equal(rolesCountLabel(23), "23 roles");
});

test("family hash: rides beside sort/dir, composes both ways, and round-trips through parseHash", () => {
  assert.equal(rolesFamilyHash({}, "red"), "#roles?family=red");
  assert.equal(rolesFamilyHash({ sort: "lastTask", dir: "desc" }, "red"), "#roles?family=red&sort=lastTask&dir=desc");
  assert.equal(rolesFamilyHash({ family: "red", sort: "mount", dir: "asc" }, ROLE_FAMILY_ALL), "#roles?sort=mount&dir=asc");
  assert.equal(rolesSortHash({ column: "role", dir: "asc" }, "profile", "test"), "#roles?family=test&sort=profile&dir=asc");
  assert.equal(rolesSortHash({ column: "role", dir: "asc" }, "role"), "#roles?sort=role&dir=desc", "no family, as FG-828 wrote it");
  for (const hash of ["#roles?family=review", "#roles?family=plan&sort=lastTask&dir=desc"]) {
    const parsed = parseHash(hash);
    assert.equal(parsed.rewrite, false, hash);
    assert.equal(rolesFamilyHash(parsed.params, rolesFamilyState(parsed.params)), hash);
  }
  const reordered = parseHash("#roles?dir=desc&sort=lastTask&family=plan");
  assert.equal(reordered.canonical, "#roles?family=plan&sort=lastTask&dir=desc");
  assert.equal(parseHash("#roles?family=wizards&sort=mount").canonical, "#roles?sort=mount", "an unknown family is dropped");
  assert.equal(parseHash("#roles/engineer?family=red").canonical, "#roles/engineer", "a role page carries no list params");
  assert.equal(rolesSortLabel({ column: "role", dir: "asc" }), "sorted by name ▲");
  assert.equal(rolesSortLabel({ column: "lastTask", dir: "desc" }), "sorted by last task ▼");
});

test("role sub-nav: four groups cover every tab exactly once, with the current one marked", () => {
  assert.deepEqual(ROLE_TAB_GROUPS.map((g) => g.label), ["Role", "Runtime", "Governance", "Audit"]);
  assert.deepEqual(ROLE_TAB_GROUPS.flatMap((g) => g.tabs).sort(), ROLE_TABS.map((t) => t.id).sort());
  const nav = roleSubnav("engineer", "harness");
  assert.deepEqual(nav.flatMap((g) => g.items.filter((i) => i.current).map((i) => i.id)), ["harness"]);
  const harness = nav[1]!.items[0]!;
  assert.deepEqual([harness.label, harness.href], ["Harness / Runtime", "#roles/engineer/harness"]);
  assert.equal(nav[0]!.items[0]!.href, "#roles/engineer", "overview is the bare role hash");
  assert.equal(nav[2]!.items[0]!.label, "Capabilities / Trust");
  assert.ok(nav.every((g) => g.items.every((i) => i.icon.length > 0)));
});

test("role header meta and Overview cards read only the payload", () => {
  const detail = {
    role: "engineer",
    generation: { id: "gen-1" },
    overview: {
      resolution: { activity: "default", profile: "claude-subscription", model: "claude-opus-5-5", auth: "subscription", runtime: "claude-oauth", resolvedBy: "defaults.profile", error: null },
      mountMode: { mode: "rw", source: "blue" },
      protocolSha: "487dd8acab33ffff",
      skills: ["browser-tools"],
      recentTasks: [{ taskId: "task-1", runId: "run-1", runTitle: "FG-829 role glyph tiles", status: "complete", createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }],
    },
    capabilities: {
      activities: [{ activity: "default" }, { activity: "review" }],
      routes: [{ route: "implementation_quick", relations: ["responsible"] }, { route: "plan-review", relations: ["consulted", "followup"] }],
      constraints: [{ id: "c1", file: "/h/constraints/no-ai-attribution.md" }, { id: "atlas-stack-rn", file: null }],
    },
    skills: { hostOnly: [{ name: "forge-backlog" }] },
  };
  assert.deepEqual(roleMeta(detail, "build"), { runtime: "claude-oauth", model: "claude-opus-5-5", family: "build", mount: "read-write" });
  assert.deepEqual(roleMeta(null, "neutral"), { runtime: "—", model: "—", family: "neutral", mount: "—" });
  const cards = overviewCards(detail, "build");
  assert.deepEqual(cards.identity.rows.map((r) => r.slice(0, 2)), [["Family", "build"], ["Default activity", "default"], ["Mount", "read-write"], ["Seed generation", "gen-1"], ["Protocol sha", "487dd8acab33"]]);
  assert.deepEqual(cards.harness.link, { label: "Configure", href: "#roles/engineer/harness" });
  assert.deepEqual(cards.capabilities.rows.map((r) => r[1]), ["default, review", "implementation_quick (responsible), plan-review (consulted, required follow-up)", "no-ai-attribution · atlas-stack-rn"]);
  assert.deepEqual(cards.skills.chips.map((c) => c.name), ["browser-tools"]);
  assert.deepEqual(cards.skills.hostOnly, ["forge-backlog"]);
  const unresolved = overviewCards({ ...detail, overview: { ...detail.overview, resolution: { error: "no mapping" } } }, "build");
  assert.deepEqual(unresolved.harness.rows, [["Resolution", "unresolved: no mapping", "err"]]);
  assert.deepEqual(recentTaskRows(detail.overview).map((t) => [t.taskId, t.title, t.meta]), [["task-1", "FG-829 role glyph tiles", "complete · 3h ago"]]);
});

// FG-849: the row's click target is a handler on the <tr>, never a stretched ::after
// overlay anchored on a positioned <tr> (WebKit ignores it; the last row took every click).
test("FG-849: the Roles row opens through a row handler — no ::after overlay on the link, no positioned <tr>", async () => {
  const { renderShell } = await import("./shell.js");
  const shell = renderShell();
  assert.doesNotMatch(shell, /\.roles-ident a::after/, "the stretched-link overlay is gone");
  assert.doesNotMatch(shell, /\.roles-table tbody tr \{[^}]*position:/, "nothing depends on a positioned <tr> as a containing block");
  assert.doesNotMatch(shell, /\.roles-[\w-]+[^{}]*::after \{[^}]*inset: 0/, "no Roles overlay pseudo-element anywhere");
  assert.match(shell, /\.roles-table tbody tr\[data-row-href\] \{ cursor: pointer; \}/);
  assert.match(shell, /\.roles-table tbody tr\[data-role\]:hover \{ background: var\(--bg-elev-2\); \}/);
  const view = readFileSync(fileURLToPath(new URL("../client/roles-index-view.js", import.meta.url)), "utf8");
  const row = view.match(/<tr key=\$\{r\.role\}[^>]*>/)?.[0] ?? "";
  assert.match(row, /data-row-href=\$\{r\.href\}/, "the row carries its own role's hash");
  assert.match(row, /onClick=\$\{openRoleRow\}/, "the row is activated by its own handler");
  assert.doesNotMatch(row, /tabindex/i, "one tab stop per row — the link (FG-692)");
});

test("FG-849: roleRowClickHref decision table preserves controls and browser gestures", () => {
  const plain = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const cell = { closest: () => null };
  const control = (name: string) => ({ closest: (selector: string) => selector === ROLE_ROW_CONTROLS && selector.split(", ").includes(name) ? {} : null });
  assert.equal(roleRowClickHref({ ...plain, target: cell }, "#roles/architecture-advisor"), "#roles/architecture-advisor");
  for (const name of ["a", "button", "input", "[role=button]"]) {
    assert.equal(roleRowClickHref({ ...plain, target: control(name) }, "#roles/engineer"), null, `${name} keeps its native behaviour`);
  }
  for (const mod of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
    assert.equal(roleRowClickHref({ ...plain, [mod]: true, target: cell }, "#roles/engineer"), null, mod);
  }
  for (const button of [1, 2]) assert.equal(roleRowClickHref({ ...plain, button, target: cell }, "#roles/engineer"), null, `button ${button}`);
  assert.equal(roleRowClickHref({ ...plain, defaultPrevented: true, target: cell }, "#roles/engineer"), null);
  assert.equal(roleRowClickHref({ ...plain, target: cell }, "#roles/engineer", "selected text"), null, "a text selection is not a click");
  assert.equal(roleRowClickHref({ ...plain, target: cell }, undefined), null, "a row without data-row-href does not navigate");
});
