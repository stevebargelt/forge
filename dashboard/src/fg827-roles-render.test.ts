// FG-827: the Roles second pass's pure pieces — the Instructions panel's file rows, modes,
// frontmatter split and copy payload; Read mode's Markdown rendering (the md() boundary,
// escaping hostile seed text); the SKILL.md frontmatter parse; the Capabilities
// derivations (result contract from an output-schema block, constraints by name, the
// activities a role can be dispatched with); the image toolchain read; and the Harness,
// Overview and Usage view models. The browser suite (browser-tests/fg827-roles-second-pass.test.ts)
// renders these.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { md } from "../client/markdown.js";
import {
  INSTRUCTION_MODES, composedSections, copyPayload, defaultFileId, instructionFileRows, sectionMatchesFile, selectedFile, splitFrontmatter,
} from "../client/instructions-panel-render.js";
import {
  authLabel, harnessRows, latestTaskCard, skillChips, skillSourceLabel, usageWindow, USAGE_PERIODS,
} from "../client/role-page-render.js";
import {
  dockerfileToolchain, outputSchemaFields, parseSkillFrontmatter, resolveHostTemplate, roleActivities, roleConstraints, roleResultContract,
} from "../../src/v2/role-surface.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROMPT = "PROTO\n\n---\n\n# engineer\n\n---\n\n# Constraints\n\n## Constraint: x\n\nbody";
const INSTRUCTIONS = {
  ok: true,
  prompt: PROMPT,
  sha256: "ab".repeat(32),
  sections: [
    { kind: "protocol", title: "P", start: 0, end: 5 },
    { kind: "base", title: "B", start: 5, end: 23 },
    { kind: "constraint", id: "x", title: "Constraint: x", start: 23, end: PROMPT.length },
  ],
  files: [
    { id: "protocol", label: "agent-protocols/engineer.md", kind: "protocol", path: "/g/agent-protocols/engineer.md", markdown: "PROTO", bytes: 5, edit: "forge upgrade" },
    { id: "entry", label: "CLAUDE.md", kind: "entry", path: "/h/agents/engineer/CLAUDE.md", markdown: "# engineer\n", bytes: 11, edit: "forge upgrade" },
    { id: "constraint:x", label: "x.md", kind: "constraint", path: "/h/constraints/x.md", markdown: "---\nid: x\nlevel: suggest\n---\n\n# X\n\nbody\n", bytes: 2048, edit: "forge upgrade" },
  ],
};

test("instructionFileRows: composition order kept, the entry marked ENTRY, the selection marked, sizes readable", () => {
  const rows = instructionFileRows(INSTRUCTIONS, "entry");
  assert.deepEqual(rows.map((r) => [r.id, r.badge, r.entry, r.selected]), [
    ["protocol", "PROTOCOL", false, false], ["entry", "ENTRY", true, true], ["constraint:x", "CONSTRAINT", false, false],
  ]);
  assert.deepEqual(rows.map((r) => r.bytes), ["5 B", "11 B", "2.0 KB"]);
  assert.deepEqual(instructionFileRows({ ok: false }, null), []);
});

test("the panel opens on the entry file; an unknown selection falls back to it; modes are Read, Raw, Composed", () => {
  assert.equal(defaultFileId(INSTRUCTIONS), "entry");
  assert.equal(selectedFile(INSTRUCTIONS, "gone")!.id, "entry");
  assert.equal(selectedFile(INSTRUCTIONS, "constraint:x")!.label, "x.md");
  assert.deepEqual(INSTRUCTION_MODES.map((m) => m.label), ["Read", "Raw", "Composed"]);
});

test("Composed mode marks the selected file's section and still tiles the exact bytes; copy copies what is shown", () => {
  const cut = composedSections(INSTRUCTIONS, "constraint:x");
  assert.equal(cut.map((s) => s.text).join(""), PROMPT);
  assert.deepEqual(cut.map((s) => s.selected), [false, false, true]);
  assert.deepEqual(composedSections(INSTRUCTIONS, "entry").map((s) => s.selected), [false, true, false]);
  assert.equal(sectionMatchesFile({ kind: "addendum" }, "addendum"), true);
  assert.equal(copyPayload(INSTRUCTIONS, "entry", "composed"), PROMPT);
  assert.equal(copyPayload(INSTRUCTIONS, "entry", "raw"), "# engineer\n");
  assert.equal(copyPayload(INSTRUCTIONS, "constraint:x", "read"), INSTRUCTIONS.files[2]!.markdown);
});

test("splitFrontmatter: Read mode renders the body, shows the frontmatter literally", () => {
  assert.deepEqual(splitFrontmatter("---\nid: x\nlevel: suggest\n---\n\n# X\n"), { frontmatter: "id: x\nlevel: suggest", body: "\n# X\n" });
  assert.deepEqual(splitFrontmatter("# no frontmatter\n---\n"), { frontmatter: null, body: "# no frontmatter\n---\n" });
  assert.deepEqual(splitFrontmatter(null), { frontmatter: null, body: "" });
});

test("Read mode's renderer (md, html: text) renders headings/lists/code and shows hostile seed HTML as inert literal text", () => {
  const out = md("# Role\n\n- one\n- two\n\n`<b>code</b>`\n\n<script>alert(1)</script>\n\n<img src=x onerror=\"alert('x')\">\n\n[x](javascript:alert(1)) [ok](https://example.com)\n\nuse a <role> placeholder", { html: "text" });
  assert.match(out, /<h1[^>]*>Role<\/h1>/);
  assert.match(out, /<li>one<\/li>/);
  assert.match(out, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the script tag is visible text");
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt;/, "the handler is visible text");
  assert.match(out, /\[x\]\(javascript:alert\(1\)\)/, "a scriptable link is shown as its literal source");
  assert.match(out, /<a href="https:\/\/example\.com">ok<\/a>/, "a safe link still renders");
  assert.match(out, /use a &lt;role&gt; placeholder/);
  const low = out.toLowerCase();
  for (const needle of ["<script", "<img", "<role>", "href=\"javascript:"]) assert.ok(!low.includes(needle), `${needle} became markup: ${out}`);
});

test("md without html: text keeps the FG-643 behavior (raw HTML is stripped, not shown)", () => {
  const low = md("<script>alert(1)</script>\n\n[x](javascript:alert(1))").toLowerCase();
  assert.ok(!low.includes("<script") && !low.includes("javascript:"), low);
});

test("parseSkillFrontmatter: name and description, folded to one line; absent or broken frontmatter is null", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: browser-tools\ndescription: Drive a headless Chrome\n  to verify UI.\n---\n# x\n"), { name: "browser-tools", description: "Drive a headless Chrome to verify UI." });
  assert.deepEqual(parseSkillFrontmatter("---\r\nname: a\r\ndescription: \"quoted: colon\"\r\n---\r\n"), { name: "a", description: "quoted: colon" });
  assert.deepEqual(parseSkillFrontmatter("# no frontmatter"), { name: null, description: null });
  assert.deepEqual(parseSkillFrontmatter("---\nname: [unclosed\n---\n"), { name: null, description: null });
  assert.deepEqual(parseSkillFrontmatter("---\nname: a\n---\n"), { name: "a", description: null });
  for (const dir of ["forge-backlog", "forge-campaign", "forge-review-loop"]) {
    const fm = parseSkillFrontmatter(readFileSync(join(REPO_ROOT, "seeds", "skills", dir, "SKILL.md"), "utf8"));
    assert.equal(fm.name, dir);
    assert.ok(fm.description && fm.description.length > 20, `${dir} ships a description`);
  }
});

test("resolveHostTemplate: env wins, the default applies when unset, an unset variable without one is unresolved", () => {
  assert.equal(resolveHostTemplate("${FORGE_BROWSER_TOOLS_DIR:-~/pi-skills/browser-tools}", {}, "/home/u"), "/home/u/pi-skills/browser-tools");
  assert.equal(resolveHostTemplate("${FORGE_BROWSER_TOOLS_DIR:-~/x}", { FORGE_BROWSER_TOOLS_DIR: "/opt/bt" }, "/home/u"), "/opt/bt");
  assert.equal(resolveHostTemplate("${DESIGN_DIR}", {}, "/home/u"), null);
});

test("outputSchemaFields: the top-level keys of the schema block, nested keys and prose ignored", () => {
  const engineer = outputSchemaFields(readFileSync(join(REPO_ROOT, "seeds", "agents", "engineer", "CLAUDE.md"), "utf8"));
  assert.deepEqual(engineer, ["status", "steps_completed", "diff_summary", "files_modified", "tests_run", "tests_passed", "tests_failed", "no_validation_reason", "screenshots", "docs_impact", "notes"]);
  const red = outputSchemaFields(readFileSync(join(REPO_ROOT, "seeds", "agents", "red-wide", "CLAUDE.md"), "utf8"));
  assert.deepEqual(red, ["status", "verdict", "confidence", "findings", "notes"], "finding fields are nested, not top-level");
  const rechecker = outputSchemaFields(readFileSync(join(REPO_ROOT, "seeds", "agent-protocols", "review-rechecker.md"), "utf8"));
  assert.ok(rechecker && rechecker.includes("rechecked") && !rechecker.includes("finding_id"));
  assert.equal(outputSchemaFields("# role\n\nWrite a result with `tests_run`.\n"), null, "prose naming a field is not a declaration");
  assert.equal(outputSchemaFields("## Output schema\n\nSee below.\n\n## Next\n\n```\n{\"a\": 1}\n```\n"), null, "a block under a later heading is not the schema");
});

test("roleResultContract: the protocol's block wins over the seed's; status always required; none is 'not declared'", () => {
  const withProtocol = roleResultContract([
    { kind: "protocol", path: "/g/p.md", markdown: "## Output schema\n\n```json\n{\n  \"review_id\": \"x\"\n}\n```\n" },
    { kind: "entry", path: "/h/CLAUDE.md", markdown: "## Output schema\n\n```\n{\n  \"status\": \"complete\"\n}\n```\n" },
  ]);
  assert.deepEqual(withProtocol.fields.map((f) => [f.name, f.source]), [
    ["status", "the composed output contract (src/v2/compose.ts)"], ["review_id", "/g/p.md § Output schema"],
  ]);
  const seedOnly = roleResultContract([{ kind: "entry", path: "/h/CLAUDE.md", markdown: "## Output schema\n\n```\n{\n  \"status\": \"x\",\n  \"notes\": \"y\"\n}\n```\n" }]);
  assert.deepEqual(seedOnly.fields.map((f) => f.name), ["status", "notes"]);
  assert.deepEqual(roleResultContract([{ kind: "entry", path: "/h/CLAUDE.md", markdown: "# shipping-reviewer\n" }]), { declared: false, fields: [], source: null });
});

test("roleConstraints: the constraints that apply to the role, by file and first heading, force first; a toggled-off one inactive", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg827-constraints-"));
  writeFileSync(join(dir, "a-force.md"), "---\nid: a-force\nlevel: force\nroles: []\n---\n\n# Always\n\nx\n");
  writeFileSync(join(dir, "b-suggest.md"), "---\nid: b-suggest\nlevel: suggest\nroles: [engineer]\nworkflows: [feature]\n---\n\nno heading\n");
  writeFileSync(join(dir, "c-other.md"), "---\nid: c-other\nlevel: force\nroles: [tech-lead]\n---\n\n# Not mine\n");
  writeFileSync(join(dir, "d-toggle.md"), "---\nid: d-toggle\nlevel: force\nroles: []\nenabled_when: { config: ai_attribution, equals: allow }\n---\n\n# Toggled\n");
  const project = mkdtempSync(join(tmpdir(), "fg827-constraints-proj-"));
  mkdirSync(join(project, ".forge", "constraints"), { recursive: true });
  writeFileSync(join(project, ".forge", "constraints", "p.md"), "---\nid: p\nlevel: suggest\nroles: []\n---\n\n# Project rule\n");
  const out = roleConstraints({ role: "engineer", hostDir: dir, projectDir: project });
  assert.deepEqual(out.map((c) => [c.id, c.level, c.heading, c.active]), [
    ["a-force", "force", "Always", true], ["d-toggle", "force", "Toggled", false], ["b-suggest", "suggest", null, true], ["p", "suggest", "Project rule", true],
  ]);
  assert.equal(out.find((c) => c.id === "b-suggest")!.scope, "roles: engineer; workflows: feature");
  assert.match(out.find((c) => c.id === "d-toggle")!.note!, /toggle ai_attribution=/);
  assert.equal(out.find((c) => c.id === "p")!.file, join(project, ".forge", "constraints", "p.md"));
});

test("roleActivities: the role's default first, then the policy's activity map, then default; legacy has only its default", () => {
  assert.deepEqual(roleActivities("review", ["reasoning", "review", "fast"]), ["review", "reasoning", "fast", "default"]);
  assert.deepEqual(roleActivities("default", ["reasoning"]), ["default", "reasoning"]);
  assert.deepEqual(roleActivities("design", null), ["design"]);
});

test("dockerfileToolchain: the release Dockerfile's node, npm globals, apt tools, go, chromium and COPYed scripts, versions from its ARGs", () => {
  const tc = dockerfileToolchain(readFileSync(join(REPO_ROOT, "docker", "agent-dev-worker.Dockerfile"), "utf8"));
  const by = Object.fromEntries(tc.map((e) => [e.name, e]));
  assert.equal(by.node!.via, "nodesource");
  assert.match(by.node!.version!, /^\d+\.x$/);
  assert.ok(by.npm && by.git && by.gh && by.tmux && by.chromium && by["forge-test"], tc.map((e) => e.name).join(","));
  assert.match(by["@anthropic-ai/claude-code"]!.version!, /^\d+\.\d+\.\d+$/, "the ARG is expanded");
  assert.ok(!tc.some((e) => e.name.startsWith("lib") || e.name.startsWith("fonts-")), "runtime libraries are not tools");
  assert.deepEqual(dockerfileToolchain("FROM scratch\n"), []);
});

test("harnessRows: each cell a resolve value, auth named as the operator says it, an unresolvable row carries its error", () => {
  const rows = harnessRows({ activities: [
    { activity: "review", isDefault: true, profile: "p", provider: "anthropic", model: "m", auth: "api", runtime: "claude-apikey", image: "i", costTier: "premium", effort: "low", resolvedBy: "defaults.activity.review", mapping: "exact — mapped", mappingPath: "exact", dispatchable: true, error: null },
    { activity: "x", isDefault: false, error: "profile 'q' has no mapping" },
  ] });
  assert.deepEqual([rows[0]!.cells.auth, rows[0]!.cells.dispatchable, rows[0]!.cells.mapping, rows[0]!.mappingSummary, rows[0]!.isDefault], ["API key", "yes", "exact", "exact — mapped", true]);
  assert.equal(rows[1]!.error, "profile 'q' has no mapping");
  assert.deepEqual([authLabel("subscription"), authLabel("bedrock"), authLabel(null)], ["subscription", "Bedrock", "—"]);
});

test("Overview: the Latest task card carries the FG-824 task token and relative time; Skills chips link to the Skills tab", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const card = latestTaskCard({ latestTask: { taskId: "task-1", runId: "run-1", runTitle: null, status: "failed", createdAt: "2026-09-29T10:00:00.000Z" } }, now);
  assert.deepEqual([card!.href, card!.runHref, card!.runLabel, card!.token.class, card!.token.label, card!.when], ["#task/task-1", "#run/run-1", "run-1", "status-failed", "failed", "2h ago"]);
  assert.equal(latestTaskCard({ latestTask: null }), null);
  assert.deepEqual(skillChips("engineer", ["browser-tools"]), [{ name: "browser-tools", href: "#roles/engineer/skills" }]);
  assert.deepEqual([skillSourceLabel("forge-bundled"), skillSourceLabel("host"), skillSourceLabel("project")], ["Forge bundled", "Host path", "Project"]);
});

test("Usage periods: 1d/7d/30d/all, each window picked by its since", () => {
  assert.deepEqual([...USAGE_PERIODS], ["1d", "7d", "30d", "all"]);
  assert.equal(usageWindow({ windows: [{ since: "1d" }, { since: "all" }] }, "all")!.since, "all");
  assert.equal(usageWindow({ windows: [] }, "7d"), null);
});
