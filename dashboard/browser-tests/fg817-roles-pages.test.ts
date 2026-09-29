// FG-817: the Roles surface in a real browser — the Roles list under Setup, and a role
// page at #roles/<role>/<tab> with nine source-captioned tabs, the FG-692 tablist
// keyboard, the Roles › <role> › <tab> trail and Escape back to the list.
//
// The real client is booted against a fixture server answering GET /api/roles and
// GET /api/roles/:role with payloads shaped like dashboard/src/roles.ts's (the
// integration suite fg817-roles-routes proves the real server builds them). Screenshots
// go to a fresh temp dir unless FG817_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18830;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG817_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg817-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const SHA = "3f".repeat(32);
const GEN = { id: "gen-20260928T010203Z-ab12", root: "/h/seed-generations/gen-20260928T010203Z-ab12", sourceAssetRoot: "/h/releases/r1" };
const TABS = ["overview", "instructions", "skills", "configuration", "secrets", "tools", "tasks", "receipts", "usage"];

const ROLES = {
  generatedAt: new Date().toISOString(),
  agentsDir: "/h/agents",
  generation: GEN,
  seedInstall: { kind: "healthy", reason: null },
  modelPolicy: { source: "host", path: "/h/model-policy.yml", error: null },
  storeError: null,
  roles: [
    { role: "engineer", description: "You implement the plan, one step at a time.", defaultActivity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5", resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "a blue dispatch mounts /project read-write", settings: true, protocolSha: SHA, lastTaskAt: ago(2) },
    { role: "red-wide", description: "You audit with default disbelief.", defaultActivity: "review", profile: "claude-subscription", effort: "low", model: "claude-opus-5-5", resolvedBy: "defaults.activity.review", resolutionError: null, mountMode: "ro", mountModeSource: "declared as a red in a seed-generation workflow", settings: false, protocolSha: SHA, lastTaskAt: null },
    { role: "tech-lead", description: "You translate a design into a plan.", defaultActivity: "reasoning", profile: "claude-subscription", effort: null, model: "claude-opus-5", resolvedBy: "defaults.activity.reasoning", resolutionError: null, mountMode: "rw", mountModeSource: "a blue dispatch mounts /project read-write", settings: true, protocolSha: null, lastTaskAt: ago(30) },
  ],
};

const PROTOCOL = "# Engineer protocol\n\nReport evidence per finding.";
const BASE = "\n\n---\n\n# engineer\n\nYou implement the plan, one step at a time.";
const WORKFLOW = "\n\n---\n\n# Workflow additions (step: task)\n\nYou are receiving a single freeform task.";
const CONSTRAINT = "\n\n---\n\n# Constraints\n\n## Constraint: personal-coding-conventions\n\nPrefer editing existing files.";
const FRAMING = "\n\n---\n\n## Output contract\n\nWrite a single JSON object to /task/result.json.\n";
const PROMPT = PROTOCOL + BASE + WORKFLOW + CONSTRAINT + FRAMING;
function sections() {
  const parts: Array<[string, string, string | undefined, string]> = [
    ["protocol", "Forge-owned agent protocol (seed generation)", undefined, PROTOCOL],
    ["base", "Role seed (CLAUDE.md)", undefined, BASE],
    ["workflow", "Workflow additions", undefined, WORKFLOW],
    ["constraint", "Constraint: personal-coding-conventions", "personal-coding-conventions", CONSTRAINT],
    ["framing", "Output contract and run framing", undefined, FRAMING],
  ];
  let at = 0;
  return parts.map(([kind, title, id, text]) => {
    const s = { kind, title, ...(id ? { id } : {}), start: at, end: at + text.length };
    at += text.length;
    return s;
  });
}

function detail(role: string) {
  const entry = ROLES.roles.find((r) => r.role === role)!;
  const settingsPresent = entry.settings;
  const tasks = role === "engineer"
    ? [
      { taskId: "task-e2", runId: "run-1", runTitle: "Build the roles page", projectDir: "/repos/forge", phase: "build", status: "complete", agentModel: "claude-sonnet-5", createdAt: ago(2), startedAt: ago(2), completedAt: ago(1.9) },
      { taskId: "task-e1", runId: "run-1", runTitle: "Build the roles page", projectDir: "/repos/forge", phase: "build", status: "failed", agentModel: "claude-sonnet-5", createdAt: ago(5), startedAt: ago(5), completedAt: ago(4.9) },
    ]
    : [];
  return {
    role,
    generatedAt: new Date().toISOString(),
    generation: GEN,
    storeError: null,
    overview: {
      source: `/h/agents/${role}/CLAUDE.md; model policy /h/model-policy.yml; routing policy ${GEN.root}/routing-policy.yml; tasks and model_calls in forge.db`,
      description: entry.description,
      resolution: { activity: entry.defaultActivity, profile: entry.profile, effort: entry.effort, model: entry.model, provider: "anthropic", auth: "subscription", runtime: "claude-oauth", resolvedBy: entry.resolvedBy, mappingPath: "exact", error: null },
      modelPolicy: ROLES.modelPolicy,
      mountMode: { mode: entry.mountMode, source: entry.mountModeSource },
      routingPolicy: { path: `${GEN.root}/routing-policy.yml`, available: true },
      routes: role === "engineer"
        ? [{ route: "feature", path: "workflow", relations: ["responsible"] }, { route: "plan-review", path: "invoke", relations: ["consulted", "followup"] }]
        : [],
      recentTasks: tasks,
      ops: { since: "30d", terminal: 2, complete: 1, failed: 1, successRate: 0.5, timed: 2, medianMs: 360_000 },
      usage: { since: "30d", inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 9 },
      protocolSha: entry.protocolSha,
    },
    instructions: {
      source: `composeSystemPrompt over /h/agents/${role}/CLAUDE.md, /h/constraints and the seed generation's agent protocol`,
      ok: true,
      context: `forge invoke ${role} (workflow: invoke, step: task, /project ${entry.mountMode}, no project anchored)`,
      prompt: PROMPT,
      sha256: "9c".repeat(32),
      sections: sections(),
      protocol: { sha256: SHA, source: `${GEN.root}/agent-protocols/${role}.md` },
      constraintsSkipped: [],
    },
    skills: {
      source: `host: /h/releases/r1/seeds/skills; container: the claude-oauth runtime's skill mounts (${GEN.root}/runtimes/claude-oauth.yml)`,
      host: [{ name: "forge-backlog", path: "/h/releases/r1/seeds/skills/forge-backlog/SKILL.md" }],
      container: [{ name: "browser-tools", host: "${FORGE_BROWSER_TOOLS_DIR:-~/pi-skills/browser-tools}", container: "/home/agent/.claude/skills/browser-tools", mode: "ro", optional: true }],
      runtimeError: null,
    },
    configuration: {
      source: `/h/agents/${role}/settings.json; runtime ${GEN.root}/runtimes/claude-oauth.yml`,
      settings: settingsPresent
        ? { path: `/h/agents/${role}/settings.json`, present: true, text: '{\n  "tools": ["read", "edit", "write", "bash"]\n}\n', tools: ["read", "edit", "write", "bash"], error: null }
        : { path: `/h/agents/${role}/settings.json`, present: false, text: null, tools: null, error: null },
      runtime: { name: "claude-oauth", source: "host", path: `${GEN.root}/runtimes/claude-oauth.yml`, text: "name: claude-oauth\nauth_strategy: oauth-volume\n", kind: "claude-code", authStrategy: "oauth-volume", authMode: "oauth-volume", image: "agent-dev-worker:latest", skillMounts: [], error: null },
      authStrategy: "oauth-volume",
      runtimeBoundBy: `model policy ${entry.resolvedBy} (anthropic/subscription)`,
    },
    secrets: { source: "the dispatch mount set: no project secret is mounted or passed into a container", text: "none: containers receive no project secrets" },
    tools: {
      source: `/h/agents/${role}/settings.json`,
      settingsPresent,
      declared: settingsPresent ? ["read", "edit", "write", "bash"] : null,
      enforced: false,
      note: "declared, not enforced: nothing outside tests reads settings.json's tools list",
      mcp: "none",
    },
    tasks: { source: "tasks WHERE agent_role = role, newest first, in forge.db", rows: tasks, limit: 50 },
    receipts: {
      source: "each task's manifest.json agentProtocol receipt; /h/seed-generations; /h/pre-upgrade-backup",
      dispatches: tasks.map((t, i) => ({ taskId: t.taskId, runId: t.runId, createdAt: t.createdAt, manifest: true, mountMode: "rw", protocol: i === 0 ? { sha256: SHA, source: `${GEN.root}/agent-protocols/${role}.md` } : null, dispatchRefused: null, generation: i === 0 ? GEN.id : null })),
      generations: [{ id: GEN.id, current: true, publishedAt: ago(20), sourceAssetRoot: GEN.sourceAssetRoot, protocolSha: SHA }],
      backups: [],
    },
    usage: {
      source: "model_calls joined to tasks by agent_role in forge.db (forge usage --by role)",
      windows: [
        { since: "7d", inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 100, cacheCreationTokens: 5, requests: 9 },
        { since: "30d", inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 100, cacheCreationTokens: 5, requests: 9 },
        { since: "all", inputTokens: 1_234_567, outputTokens: 9_876, cacheReadTokens: 100, cacheCreationTokens: 5, requests: 90 },
      ],
      byModel: [{ model: "claude-sonnet-5", inputTokens: 1_234_567, outputTokens: 9_876, requests: 90 }],
      ceilings: "none: per-role spend ceilings are a future ticket",
    },
  };
}

let server: Server;
let browser: Browser;
const baseUrl = `http://127.0.0.1:${PORT}`;

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(PORT, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function open(hash = "", width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const crumbs = (page: Page) => page.locator(".breadcrumbs li").evaluateAll((items) =>
  items.map((li) => ({ label: li.textContent?.trim(), href: li.querySelector("a")?.getAttribute("href") ?? null })));
const caption = (page: Page) => page.locator(".role-caption").textContent();
const tablist = (page: Page) => page.evaluate(() => {
  const list = document.querySelector('.object-tabs[role="tablist"]');
  const panel = document.querySelector('[role="tabpanel"]');
  return {
    tabs: Array.from(list?.children ?? []).map((t) => [t.getAttribute("role"), t.getAttribute("data-tab"), t.getAttribute("aria-selected"),
      t.getAttribute("tabindex"), t.getAttribute("aria-controls") === panel?.id && !!panel?.id]),
    labelledBy: panel ? document.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.getAttribute("data-tab") ?? null : null,
  };
});

async function waitFor<T>(read: () => Promise<T>, expected: T, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let last: T = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(last, expected, what);
}

test("FG-817: the Roles list renders every seed with its activity, resolved profile, mount and last task", async () => {
  const { page, errors } = await open("#roles");
  await page.locator(".roles-table tbody tr").first().waitFor();
  const rows = await page.locator(".roles-table tbody tr").evaluateAll((trs) => trs.map((tr) => ({
    role: tr.getAttribute("data-role"),
    href: tr.querySelector("a")?.getAttribute("href"),
    activity: tr.querySelector('[data-col="activity"]')?.textContent?.trim(),
    profile: tr.querySelector('[data-col="profile"]')?.textContent?.trim(),
    mount: tr.querySelector('[data-col="mount"]')?.textContent?.trim(),
    lastTask: tr.querySelector('[data-col="last-task"]')?.textContent?.trim(),
  })));
  assert.deepEqual(rows.map((r) => [r.role, r.href, r.activity, r.profile, r.mount]), [
    ["engineer", "#roles/engineer", "default", "claude-subscription · claude-sonnet-5", "read-write"],
    ["red-wide", "#roles/red-wide", "review", "claude-subscription · claude-opus-5-5 · effort low", "read-only"],
    ["tech-lead", "#roles/tech-lead", "reasoning", "claude-subscription · claude-opus-5", "read-write"],
  ]);
  assert.equal(rows[1]!.lastTask, "never");
  assert.notEqual(rows[0]!.lastTask, "never");
  assert.match((await page.locator('.roles-table tr[data-role="red-wide"]').textContent()) ?? "", /no settings\.json/);
  assert.match((await caption(page)) ?? "", /^Source: \/h\/agents; seed generation gen-20260928T010203Z-ab12; \/h\/model-policy.yml/);
  assert.equal(await page.locator('.nav-column a[data-view="roles"]').getAttribute("aria-current"), "page");
  assert.equal(await page.locator(".placeholder-view").count(), 0, "the FG-820 placeholder is gone");
  await page.screenshot({ path: join(SHOTS, "fg817-roles-list.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: a deep link to #roles/engineer/instructions restores the tab, across a reload", async () => {
  const { page, errors } = await open("#roles/engineer/instructions");
  await page.locator(".role-prompt-section").first().waitFor();
  for (let pass = 0; pass < 2; pass += 1) {
    assert.equal(hashOf(page), "#roles/engineer/instructions");
    assert.equal(await page.locator(".page-title").textContent(), "engineer");
    assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "instructions");
    const marks = await page.locator(".role-prompt-section").evaluateAll((els) => els.map((el) => [el.getAttribute("data-section"), el.getAttribute("data-constraint")]));
    assert.deepEqual(marks, [["protocol", null], ["base", null], ["workflow", null], ["constraint", "personal-coding-conventions"], ["framing", null]]);
    const text = await page.locator(".role-prompt").evaluateAll((els) => els.map((el) => el.textContent ?? "").join(""));
    assert.equal(text, PROMPT, "the sections render the composed prompt byte for byte");
    assert.equal(await page.locator("[data-prompt-sha]").textContent(), "9c".repeat(32));
    assert.equal(await page.locator('.nav-column a[data-view="roles"]').getAttribute("aria-current"), "page", "a role page highlights Roles");
    if (pass === 0) {
      await page.reload();
      await page.locator(".role-prompt-section").first().waitFor();
    }
  }
  await page.screenshot({ path: join(SHOTS, "fg817-instructions-tab.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: every tab renders with its source caption", async () => {
  const { page, errors } = await open("#roles/engineer");
  await page.locator(".role-overview").waitFor();
  const body = detail("engineer") as unknown as Record<string, { source: string }>;
  for (const tab of TABS) {
    await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
    await waitFor(() => page.locator(".role-caption").getAttribute("data-caption"), tab, `${tab} is on screen`);
    assert.equal(await caption(page), `Source: ${body[tab]!.source}`, `${tab} names its source`);
    assert.equal(hashOf(page), tab === "overview" ? "#roles/engineer" : `#roles/engineer/${tab}`);
    if (tab === "overview") {
      assert.match((await page.locator(".role-overview").textContent()) ?? "", /claude-subscription · claude-sonnet-5/);
      assert.deepEqual(await page.locator(".role-routes li").evaluateAll((lis) => lis.map((li) => li.getAttribute("data-route"))), ["feature", "plan-review"]);
      assert.match((await page.locator('.role-routes li[data-route="plan-review"]').textContent()) ?? "", /consulted, required follow-up/);
      assert.match((await page.locator(".role-overview").textContent()) ?? "", /50% of 2 finished/);
      await page.screenshot({ path: join(SHOTS, "fg817-engineer-overview.png"), fullPage: true });
    }
    if (tab === "secrets") assert.equal(await page.locator("[data-secrets]").textContent(), "none: containers receive no project secrets");
    if (tab === "tools") {
      assert.match((await page.locator("[data-tools-flag]").textContent()) ?? "", /^declared, not enforced/);
      assert.match((await page.locator(".role-tools").textContent()) ?? "", /MCP: none/);
    }
    if (tab === "skills") assert.equal(await page.locator('[data-skill="browser-tools"]').count(), 1);
    if (tab === "tasks") {
      const links = await page.locator('.role-tasks tr[data-task="task-e2"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      assert.deepEqual(links.slice(0, 2), ["#task/task-e2", "#task/task-e2/explain"]);
      assert.deepEqual(await page.locator(".role-tasks tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-task"))), ["task-e2", "task-e1"], "newest first");
      await page.screenshot({ path: join(SHOTS, "fg817-tasks-tab.png"), fullPage: true });
    }
    if (tab === "receipts") assert.match((await page.locator('[data-receipt="task-e2"]').textContent()) ?? "", /generation gen-20260928T010203Z-ab12/);
    if (tab === "usage") assert.match((await page.locator(".role-usage").textContent()) ?? "", /Ceilings: none/);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: the role tabs are a tablist (FG-692) — arrow keys move between them, wrapping", async () => {
  const { page, errors } = await open("#roles/engineer");
  await page.locator(".role-overview").waitFor();
  const shape = await tablist(page);
  assert.deepEqual(shape.tabs.map((t) => t[1]), TABS);
  for (const [role, id, selected, tabindex, controls] of shape.tabs) {
    assert.deepEqual([role, controls], ["tab", true], `${id} is a tab controlling the panel`);
    assert.deepEqual([selected, tabindex], id === "overview" ? ["true", "0"] : ["false", "-1"], `${id} roving tabindex`);
  }
  assert.equal(shape.labelledBy, "overview");
  await page.locator('[role="tab"][data-tab="overview"]').focus();
  await page.keyboard.press("ArrowRight");
  await waitFor(async () => hashOf(page), "#roles/engineer/instructions", "ArrowRight selects the next tab");
  await waitFor(() => page.evaluate(() => document.activeElement?.getAttribute("data-tab") ?? null), "instructions", "focus follows");
  await page.keyboard.press("ArrowLeft");
  await waitFor(async () => hashOf(page), "#roles/engineer", "ArrowLeft goes back to overview");
  await page.keyboard.press("ArrowLeft");
  await waitFor(async () => hashOf(page), "#roles/engineer/usage", "ArrowLeft from the first tab wraps to the last");
  await waitFor(async () => (await tablist(page)).labelledBy, "usage", "the panel is labelled by the selected tab");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: breadcrumbs read Roles › <role> › <tab>, built from the page, and link back up", async () => {
  const { page, errors } = await open("#roles/engineer/receipts");
  await page.locator(".role-receipts").waitFor();
  assert.deepEqual(await crumbs(page), [
    { label: "Roles", href: "#roles" },
    { label: "engineer", href: "#roles/engineer" },
    { label: "Receipts", href: null },
  ]);
  await page.locator('.breadcrumbs a[href="#roles/engineer"]').click();
  await waitFor(() => crumbs(page), [
    { label: "Roles", href: "#roles" },
    { label: "engineer", href: "#roles/engineer" },
    { label: "Overview", href: null },
  ], "the role crumb opens the overview");
  await page.locator('.breadcrumbs a[href="#roles"]').click();
  await page.locator(".roles-table").waitFor();
  assert.equal(hashOf(page), "#roles");
  assert.equal(await page.locator(".breadcrumbs").count(), 0, "the list view shows its group and title, not a trail");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: Escape on a role page returns to the Roles list, and the list itself ignores it", async () => {
  const { page, errors } = await open("#roles/red-wide/tools");
  await page.locator(".role-tools").waitFor();
  await page.keyboard.press("Escape");
  await waitFor(async () => hashOf(page), "#roles", "Escape goes to the parent list");
  await page.locator(".roles-table").waitFor();
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hashOf(page), "#roles");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: a seed missing settings.json says so, an unknown tab lands on overview, an unknown role is named", async () => {
  const { page, errors } = await open("#roles/red-wide/configuration");
  await page.locator("[data-settings-missing]").waitFor();
  assert.match((await page.locator("[data-settings-missing]").textContent()) ?? "", /no settings\.json at \/h\/agents\/red-wide\/settings\.json/);
  await page.locator('[role="tab"][data-tab="tools"]').click();
  await page.locator(".role-tools").waitFor();
  assert.match((await page.locator(".role-tools").textContent()) ?? "", /No settings\.json, so no tools are declared/);

  await page.goto(`${baseUrl}/#roles/engineer/bogus`);
  await page.locator(".role-overview").waitFor();
  assert.equal(hashOf(page), "#roles/engineer", "an unknown tab is rewritten to the role's overview");

  await page.goto(`${baseUrl}/#roles/nobody`);
  await page.locator(".role-page [role=alert]").waitFor();
  assert.match((await page.locator(".role-page [role=alert]").textContent()) ?? "", /No role seed named nobody/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-817: at 400px a role page fits the viewport, its tabs wrap and the bottom bar stays", async () => {
  const { page, errors } = await open("#roles/engineer", 400);
  await page.locator(".role-overview").waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at 400px (overflow ${overflow}px)`);
  const tabsFit = await page.locator(".object-tab").evaluateAll((tabs) => tabs.every((t) => t.getBoundingClientRect().right <= window.innerWidth));
  assert.equal(tabsFit, true, "every tab is on screen without scrolling");
  assert.equal(await page.locator(".bottom-bar").isVisible(), true);
  await page.screenshot({ path: join(SHOTS, "fg817-mobile-400-role-page.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
      return;
    }
    if (url.pathname.startsWith("/client/")) {
      const filePath = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!filePath.startsWith(`${CLIENT_DIR}/`) || !existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      const contentType = filePath.endsWith(".js") ? "application/javascript; charset=utf-8"
        : filePath.endsWith(".svg") ? "image/svg+xml"
          : filePath.endsWith(".png") ? "image/png"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/roles") {
      json(ROLES);
      return;
    }
    const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
    if (roleMatch) {
      const role = decodeURIComponent(roleMatch[1]!);
      if (ROLES.roles.some((r) => r.role === role)) json(detail(role));
      else json({ error: `no role seed named ${role}` }, 404);
      return;
    }
    if (url.pathname === "/api/attention-inbox") {
      json({ generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null }, degraded: [], items: [], empty: true, counts: { open: 0, high: 0 } });
      return;
    }
    if (url.pathname === "/api/runs") {
      json({ runs: [], activeCount: 0, nextCursor: null, generatedAt: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/projects") {
      json([]);
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      json({ generatedAt: new Date(0).toISOString(), services: [] });
      return;
    }
    if (url.pathname === "/api/ops") {
      json({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      });
      return;
    }
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
