// FG-845 part 2 — the git-attribution DTO the Config row, the controls and the Projects
// cards read: describeAiAttribution over every source, the fail-closed stops, the
// rendered-block states, the graph and projects carriers, and the client's pure helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "fg845-dto-home-"));
process.env["FORGE_HOME"] = HOME;
delete process.env["FORGE_AI_ATTRIBUTION_CARRIED"];

const { attributionStatements, describeAiAttribution, readAiAttribution, renderOrchestratorTemplate, renderedBlockMode } = await import(
  "../../src/v2/ai-attribution.js"
);
const { buildConfigGraph } = await import("../../src/v2/config-graph.js");
const { attributionCheckout, withAiAttribution } = await import("./ai-attribution-mutation.js");
const render = await import("../client/attribution-render.js");
const { statusToken } = await import("../client/status-tokens.js");
const { renderShell } = await import("./shell.js");

const SEED = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seeds", "orchestrator-template.md"), "utf8");

const TEMPLATE = [
  "# head",
  "<!-- forge:orchestrator-start -->",
  "policy",
  "<!-- forge:if ai_attribution=suppress -->",
  "- **No attribution** (suppress).",
  "<!-- forge:endif -->",
  "<!-- forge:if ai_attribution=allow -->",
  "- **Attribution allowed** (allow).",
  "<!-- forge:endif -->",
  "<!-- forge:orchestrator-end -->",
  "tail",
].join("\n");

function home(hostValue?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fg845-home-"));
  if (hostValue !== undefined) writeFileSync(join(dir, "config.yml"), `other: 1\nai_attribution: ${hostValue}\n`);
  return dir;
}

function checkout(projectValue?: string, rendered?: "suppress" | "allow"): string {
  const dir = mkdtempSync(join(tmpdir(), "fg845-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), projectValue === undefined ? "project_key: pk\n" : `project_key: pk\nai_attribution: ${projectValue}\n`);
  if (rendered) writeFileSync(join(dir, "CLAUDE.md"), renderOrchestratorTemplate(TEMPLATE, rendered));
  return dir;
}

test("every source: project override, host default, built-in default — mode/source/file are readAiAttribution's own answer", () => {
  const cases = [
    { project: "allow", host: "suppress", mode: "allow", source: "project", inherits: false, hostView: "suppress" },
    { project: undefined, host: "allow", mode: "allow", source: "host", inherits: true, hostView: "allow" },
    { project: undefined, host: undefined, mode: "suppress", source: "default", inherits: true, hostView: null },
    { project: "suppress", host: undefined, mode: "suppress", source: "project", inherits: false, hostView: null },
  ] as const;
  for (const c of cases) {
    const h = home(c.host);
    const dir = checkout(c.project);
    const v = describeAiAttribution(dir, { forgeHome: h, template: TEMPLATE });
    const a = readAiAttribution(dir, { forgeHome: h, carried: null });
    assert.deepEqual({ mode: v.mode, source: v.source, file: v.file, reason: v.reason }, { mode: a.mode, source: a.source, file: a.file, reason: a.reason }, JSON.stringify(c));
    assert.equal(v.mode, c.mode);
    assert.equal(v.source, c.source);
    assert.equal(v.inheritsHost, c.inherits);
    assert.deepEqual(v.host, c.hostView ? { mode: c.hostView, file: join(h, "config.yml") } : null);
    assert.equal(v.hostFile, join(h, "config.yml"));
    assert.equal(v.checkout, dir);
    assert.equal(v.reason, undefined);
  }
});

test("fail-closed: an unrecognized project value stops at the project (no inherit) and a malformed host value is never allow", () => {
  const h = home("allow");
  const bad = checkout("yes-please");
  const v = describeAiAttribution(bad, { forgeHome: h, template: TEMPLATE });
  assert.equal(v.mode, "suppress");
  assert.equal(v.source, "default");
  assert.equal(v.file, join(bad, ".forge", "config.yml"));
  assert.match(v.reason ?? "", /unrecognized ai_attribution value/);
  assert.equal(v.inheritsHost, false, "a broken project file is not inheriting");
  assert.deepEqual(v.host, { mode: "allow", file: join(h, "config.yml") });
  assert.equal(render.attributionTag(v).key, "fail_closed");
  assert.equal(render.currentProjectChoice(v), null);

  const badHost = home("perhaps");
  const inherits = checkout();
  const w = describeAiAttribution(inherits, { forgeHome: badHost, template: TEMPLATE });
  assert.equal(w.mode, "suppress");
  assert.equal(w.source, "default");
  assert.equal(w.file, join(badHost, "config.yml"));
  assert.ok(w.reason);
  assert.equal(w.inheritsHost, true);
  assert.equal(w.host, null, "a malformed host value is no host default");
  assert.equal(render.currentHostChoice(w), null);
});

test("renderedBlock: absent with no CLAUDE.md or no block, in_sync when the block renders the resolved mode, stale otherwise", () => {
  const h = home();
  assert.equal(describeAiAttribution(checkout("allow"), { forgeHome: h, template: TEMPLATE }).renderedBlock, "absent");

  const noBlock = checkout("allow");
  writeFileSync(join(noBlock, "CLAUDE.md"), "# just prose\n- **Attribution allowed** (allow).\n");
  const nb = describeAiAttribution(noBlock, { forgeHome: h, template: TEMPLATE });
  assert.deepEqual([nb.renderedBlock, nb.renderedMode], ["absent", null]);

  const sync = describeAiAttribution(checkout("allow", "allow"), { forgeHome: h, template: TEMPLATE });
  assert.deepEqual([sync.renderedBlock, sync.renderedMode], ["in_sync", "allow"]);

  const stale = describeAiAttribution(checkout("allow", "suppress"), { forgeHome: h, template: TEMPLATE });
  assert.deepEqual([stale.renderedBlock, stale.renderedMode], ["stale", "suppress"]);

  const hostStale = describeAiAttribution(checkout(undefined, "suppress"), { forgeHome: home("allow"), template: TEMPLATE });
  assert.deepEqual([hostStale.source, hostStale.renderedBlock], ["host", "stale"], "a host allow the block has not caught up with is stale");

  const unrecognizedBlock = checkout("suppress");
  writeFileSync(join(unrecognizedBlock, "CLAUDE.md"), "<!-- forge:orchestrator-start -->\nan old block with no statement\n<!-- forge:orchestrator-end -->\n");
  const ub = describeAiAttribution(unrecognizedBlock, { forgeHome: h, template: TEMPLATE });
  assert.deepEqual([ub.renderedBlock, ub.renderedMode], ["stale", null]);
});

test("the shipped orchestrator template: both statements are found, and each mode's render reads back as that mode", () => {
  const statements = attributionStatements(SEED);
  assert.ok(statements.suppress && statements.allow, "the seed carries a statement line for each mode");
  assert.notEqual(statements.suppress, statements.allow);
  for (const mode of ["suppress", "allow"] as const) {
    assert.deepEqual(renderedBlockMode(renderOrchestratorTemplate(SEED, mode), statements), { block: "present", mode });
  }
  const dir = checkout("allow");
  writeFileSync(join(dir, "CLAUDE.md"), renderOrchestratorTemplate(SEED, "allow"));
  assert.equal(describeAiAttribution(dir, { forgeHome: home() }).renderedBlock, "in_sync", "the default template is the installed seed");
});

test("the config graph carries the same derivation (so `forge config graph --json` and the dashboard agree)", () => {
  const h = home("allow");
  const dir = checkout();
  const graph = buildConfigGraph({ projectDir: dir, forgeHome: h });
  assert.deepEqual(graph.aiAttribution, describeAiAttribution(dir, { forgeHome: h }));
});

test("two config-graph reads straddling a host-file write see the change (nothing memoizes the host file)", () => {
  const h = home();
  const dir = checkout();
  const before = buildConfigGraph({ projectDir: dir, forgeHome: h }).aiAttribution;
  assert.equal(before?.source, "default");
  assert.equal(before?.host, null);
  writeFileSync(join(h, "config.yml"), "ai_attribution: allow\n");
  const after = buildConfigGraph({ projectDir: dir, forgeHome: h }).aiAttribution;
  assert.equal(after?.mode, "allow");
  assert.equal(after?.source, "host");
  assert.deepEqual(after?.host, { mode: "allow", file: join(h, "config.yml") });
});

test("withAiAttribution: the primary checkout (else the first on disk), one resolver call per checkout per request", () => {
  const calls: string[] = [];
  const describe = (dir: string) => {
    calls.push(dir);
    return describeAiAttribution(dir, { forgeHome: home(), template: TEMPLATE });
  };
  const a = checkout();
  const b = checkout("allow");
  const projects = [
    { key: "p1", primaryCheckout: a, checkouts: [{ projectDir: b, exists: true }, { projectDir: a, exists: true }] },
    { key: "p2", primaryCheckout: "/gone", checkouts: [{ projectDir: "/gone", exists: false }, { projectDir: b, exists: true }] },
    { key: "p3", primaryCheckout: a, checkouts: [{ projectDir: a, exists: true }] },
    { key: "p4", primaryCheckout: "/gone", checkouts: [{ projectDir: "/gone", exists: false }] },
  ] as unknown as Parameters<typeof withAiAttribution>[0];
  const out = withAiAttribution(projects, describe);
  assert.deepEqual(calls.sort(), [a, b].sort(), "each checkout resolved once");
  assert.equal(out[0]!.aiAttribution!.checkout, a);
  assert.equal(out[1]!.aiAttribution!.mode, "allow");
  assert.equal(out[3]!.aiAttribution, null);
  assert.equal(attributionCheckout(projects[1]!), b);
});

test("client helpers: the source tag, the exact verbs, the current choices and the inherit count", () => {
  const base = { mode: "suppress", file: null, host: null, hostFile: "/h/config.yml", inheritsHost: true, checkout: "/c" } as const;
  assert.equal(render.attributionTag({ ...base, source: "project" }).label, "project override");
  assert.equal(render.attributionTag({ ...base, source: "host" }).label, "host default");
  assert.equal(render.attributionTag({ ...base, source: "default" }).label, "built-in default");
  assert.equal(render.attributionTag({ ...base, source: "default", reason: "x" }).label, "fail-closed");
  assert.equal(render.attributionCommand("project", "allow"), "forge config set ai-attribution allow");
  assert.equal(render.attributionCommand("project", "inherit"), "forge config unset ai-attribution");
  assert.equal(render.attributionCommand("host", "suppress"), "forge config set ai-attribution suppress --host");
  assert.equal(render.attributionTargetFile("project", { ...base, source: "default" }), "/c/.forge/config.yml");
  assert.equal(render.attributionTargetFile("host", { ...base, source: "default" }), "/h/config.yml");
  assert.equal(render.currentProjectChoice({ ...base, source: "host" }), "inherit");
  assert.equal(render.currentProjectChoice({ ...base, source: "project", mode: "allow", inheritsHost: false }), "allow");
  assert.equal(render.currentHostChoice({ ...base, source: "host", host: { mode: "allow", file: "/h/config.yml" } }), "allow");
  const p = (inheritsHost: boolean) => ({ aiAttribution: { ...base, source: "default" as const, inheritsHost } });
  assert.deepEqual(render.inheritCount([p(true), p(true), p(false), { aiAttribution: null }, null]), { inherit: 2, total: 3 });
  assert.deepEqual(render.PROJECT_CHOICES.map((c) => c.value), ["suppress", "allow", "inherit"]);
  assert.deepEqual(render.HOST_CHOICES.map((c) => c.value), ["suppress", "allow"]);
});

test("client helpers: the segmented group's arrow keys wrap, Home/End jump, anything else is not a move (FG-692)", () => {
  const values = ["suppress", "allow", "inherit"];
  assert.equal(render.segmentStep(values, "suppress", "ArrowRight"), "allow");
  assert.equal(render.segmentStep(values, "inherit", "ArrowRight"), "suppress");
  assert.equal(render.segmentStep(values, "suppress", "ArrowLeft"), "inherit");
  assert.equal(render.segmentStep(values, "allow", "Home"), "suppress");
  assert.equal(render.segmentStep(values, "allow", "End"), "inherit");
  for (const key of ["Enter", " ", "Tab", "a"]) assert.equal(render.segmentStep(values, "allow", key), null);
});

test("the rendered-block and fail-closed states paint through the FG-824 token map, each with a badge colour rule", () => {
  const css = renderShell();
  for (const value of ["in_sync", "stale", "absent", "fail_closed"]) {
    const token = statusToken("attribution", value);
    assert.equal(token.known, true, value);
    assert.match(css, new RegExp(`\\.badge\\.${token.class}\\b`), `${value} → .badge.${token.class}`);
  }
  assert.equal(statusToken("attribution", "stale").label, "stale — run forge upgrade");
  assert.equal(statusToken("attribution", "in_sync").tone, "ok");
});

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];
function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props));
  return textOf(props.children as Vnode);
}

test("Config row: Git attribution sits right after Model policy with mode, tag, file, host default, checkout and block state; the Projects line names the fail-closed file", async () => {
  const { h } = await import("preact");
  const { ControlPlaneView } = await import("../client/control-plane.js");
  const { ProjectAttributionLine } = await import("../client/attribution-view.js");
  const row = (key: string, label: string) => ({ key, label, truth: "EFFECTIVE", status: "active", sourcePaths: [], overrideSemantics: "none", native: {} });
  const view = {
    mode: "suppress", source: "project", file: "/c/.forge/config.yml", host: { mode: "allow", file: "/h/config.yml" }, hostFile: "/h/config.yml",
    inheritsHost: false, checkout: "/c", renderedBlock: "in_sync", renderedMode: "suppress",
  };
  const data = {
    version: 1, project: { dir: "/c", status: "active", native: {} }, forgeHome: "/h",
    sections: { sources: { rows: [row("workflow", "Workflow"), row("model-policy", "Model policy"), row("routing", "Routing policy")] }, capabilities: { providers: [], capabilities: [], prerequisites: [] } },
    aiAttribution: view,
  };
  const text = textOf(h(ControlPlaneView as never, { data, projects: [] }) as unknown as Vnode);
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("Model policy") < at("Git attribution") && at("Git attribution") < at("Routing policy"), text);
  for (const s of ["suppress", "project override", "/c/.forge/config.yml", "host default: allow", "/h/config.yml", "built-in: suppress", "applies to checkout", "in sync"]) {
    assert.ok(text.includes(s), `row shows ${s}`);
  }
  const line = textOf(h(ProjectAttributionLine as never, { view: { ...view, checkout: "/p", source: "default", reason: "unrecognized", file: "/p/.forge/config.yml" } }) as unknown as Vnode);
  assert.match(line, /Git attribution: suppress.*fail-closed.*· \.forge\/config\.yml has an unrecognized value — fix it in the checkout/s);
  const bare = textOf(h(ProjectAttributionLine as never, { view: { ...view, source: "default", host: null, file: null } }) as unknown as Vnode);
  assert.match(bare, /built-in default.*no host value/s);
});
