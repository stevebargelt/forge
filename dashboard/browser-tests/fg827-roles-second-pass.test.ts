// FG-827: the Roles second pass in a real browser — the Instructions Files panel with its
// Read / Raw / Composed viewer, the Harness / Runtime resolution table and container facts,
// Skills rows with description and source badges, the Capabilities card, Tools' effective
// access, Usage periods by model and provider, and the Overview's Latest task card and
// Skills chips — with no status of the role's own anywhere.
//
// Unlike fg817-roles-pages (a hand-built fixture), the role payload here is the REAL
// dashboard/src/roles.ts roleDetail over a scratch FORGE_HOME (a published seed
// generation, the shipped seeds, a model policy, a seeded store), so the page renders
// what the server actually builds. Screenshots go to a fresh temp dir unless
// FG827_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18831;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const REPO_ROOT = resolve(HERE, "..", "..");
const SHOTS = process.env.FG827_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg827-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "forge-fg827-browser-"));
process.env.FORGE_HOME = home;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AWS_PROFILE;
delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
process.env.CLAUDE_CODE_USE_BEDROCK = "0";
const SKILL_DIR = mkdtempSync(join(tmpdir(), "fg827-browser-tools-"));
writeFileSync(join(SKILL_DIR, "SKILL.md"), "---\nname: browser-tools\ndescription: Drive a headless Chrome on :9222 to navigate, screenshot and verify UI changes.\n---\n");
process.env.FORGE_BROWSER_TOOLS_DIR = SKILL_DIR;

const { publishTestGeneration } = await import("../../src/v2/seed-generation.testkit.js");
const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { roleDetail, rolesIndex } = await import("../src/roles.js");

publishTestGeneration(home, {
  assetsParent: home,
  raciPath: join(REPO_ROOT, "seeds", "forge-raci.md"),
  runtimes: { "claude-oauth": readFileSync(join(REPO_ROOT, "seeds", "runtimes", "claude-oauth.yml"), "utf8") },
});
cpSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), join(home, "model-policy.yml"));
for (const role of ["engineer", "red-wide"]) {
  mkdirSync(join(home, "agents", role), { recursive: true });
  cpSync(join(REPO_ROOT, "seeds", "agents", role, "CLAUDE.md"), join(home, "agents", role, "CLAUDE.md"));
}
cpSync(join(REPO_ROOT, "seeds", "agents", "engineer", "settings.json"), join(home, "agents", "engineer", "settings.json"));
cpSync(join(REPO_ROOT, "seeds", "constraints"), join(home, "constraints"), { recursive: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
writeTransaction(() => {
  const db = getDb();
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`).run("run-1", "feature", "Roles second pass", "complete", ago(200), "/repos/forge");
  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at, resolved_provider, resolved_auth) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  task.run("task-e1", "run-1", "build", "engineer", "complete", "{}", ago(100), ago(100), ago(99.8), "anthropic", "api");
  task.run("task-e2", "run-1", "build", "engineer", "failed", "{}", ago(3), ago(3), ago(2.9), "anthropic", "subscription");
  const call = db.prepare(
    `INSERT INTO model_calls (task_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  call.run("task-e1", "req-1", "claude-opus-5", 120_000, 8_000, 900_000, 40_000, ago(100));
  call.run("task-e1", "req-2", "claude-sonnet-5", 30_000, 2_000, 200_000, 9_000, ago(99.9));
  call.run("task-e2", "req-3", "claude-sonnet-5", 12_000, 1_500, 80_000, 3_000, ago(3));
});

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

async function open(hash: string, width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const text = async (page: Page, selector: string) => (await page.locator(selector).first().textContent()) ?? "";
const detail = (role: string) => JSON.parse(JSON.stringify(roleDetail(role)));

test("FG-827: Instructions — a Files panel in composition order with the entry marked; Read renders, Raw is the bytes", async () => {
  const d = detail("engineer");
  const { page, errors } = await open("#roles/engineer/instructions");
  await page.locator(".instr-files .instr-file").first().waitFor();
  const files = await page.locator(".instr-file").evaluateAll((els) => els.map((el) => [el.getAttribute("data-file"), el.querySelector(".instr-kind")?.textContent, el.getAttribute("aria-pressed")]));
  assert.deepEqual(files.map((f) => f[0]), d.instructions.files.map((f: any) => f.id), "the server's composition order");
  assert.deepEqual(files.find((f) => f[0] === "entry"), ["entry", "ENTRY", "true"], "the seed CLAUDE.md is the entry, open by default");
  assert.equal(files.filter((f) => f[1] === "ENTRY").length, 1);
  assert.equal(await page.locator('[data-mode="read"]').getAttribute("aria-pressed"), "true");
  assert.ok(await page.locator(".instr-md h1, .instr-md h2").count() > 0, "Read renders the seed's Markdown headings");
  assert.match(await text(page, "[data-edit]"), /forge upgrade/);
  await page.screenshot({ path: join(SHOTS, "fg827-instructions-files.png"), fullPage: true });

  await page.locator('[data-file="constraint:personal-coding-conventions"]').click();
  assert.equal(await text(page, "[data-viewer-file]"), "personal-coding-conventions.md");
  assert.match(await text(page, "[data-frontmatter]"), /level: suggest/, "frontmatter is shown literally, not rendered");
  await page.locator('[data-mode="raw"]').click();
  const constraint = d.instructions.files.find((f: any) => f.id === "constraint:personal-coding-conventions");
  assert.equal(await page.locator("[data-view=raw]").textContent(), constraint.markdown);
  assert.equal(await page.locator(".instr-copy").getAttribute("data-copy-bytes"), String(constraint.markdown.length), "copy copies the file shown");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Instructions — Composed is the exact prompt with sections marked, the selected file's highlighted, and its sha256", async () => {
  const d = detail("engineer");
  const { page, errors } = await open("#roles/engineer/instructions");
  await page.locator('[data-file="protocol"]').click();
  await page.locator('[data-mode="composed"]').click();
  await page.locator("[data-view=composed] .role-prompt-section").first().waitFor();
  const composed = await page.locator("[data-view=composed] .role-prompt").evaluateAll((els) => els.map((el) => el.textContent ?? "").join(""));
  assert.equal(composed, d.instructions.prompt, "byte for byte");
  assert.equal(await text(page, "[data-prompt-sha]"), d.instructions.sha256);
  assert.deepEqual(await page.locator(".role-prompt-selected").evaluateAll((els) => els.map((el) => el.getAttribute("data-section"))), ["protocol"]);
  assert.equal(await page.locator(".instr-copy").getAttribute("data-copy-bytes"), String(d.instructions.prompt.length), "copy copies the whole composed prompt");
  await page.screenshot({ path: join(SHOTS, "fg827-instructions-composed.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Harness / Runtime — one row per dispatchable activity, container facts captioned, raw files behind a disclosure", async () => {
  const d = detail("engineer");
  const { page, errors } = await open("#roles/engineer/harness");
  await page.locator(".role-harness-table tbody tr").first().waitFor();
  const rows = await page.locator(".role-harness-table tbody tr").evaluateAll((trs) => trs.map((tr) => ({
    activity: tr.getAttribute("data-activity"),
    model: tr.querySelector('[data-col="model"]')?.textContent,
    auth: tr.querySelector('[data-col="auth"]')?.textContent,
    effort: tr.querySelector('[data-col="effort"]')?.textContent,
  })));
  assert.deepEqual(rows.map((r) => r.activity), d.harness.activities.map((a: any) => a.activity));
  const review = d.harness.activities.find((a: any) => a.activity === "review");
  assert.deepEqual(rows.find((r) => r.activity === "review"), { activity: "review", model: review.model, auth: "subscription", effort: review.effort });
  const mounts = await page.locator(".role-mounts tbody tr").evaluateAll((trs) => trs.map((tr) => [tr.getAttribute("data-mount"), tr.querySelector('[data-col="mode"]')?.textContent?.trim()]));
  assert.deepEqual(mounts.slice(0, 2), [["/task", "rw"], ["/project", "rw"]]);
  assert.match(await text(page, "[data-auth-volume]"), /forge-claude-oauth-v2 → \/home\/agent \(rw\)/);
  assert.match(await text(page, "[data-idle-timeout]"), /^600 s/);
  assert.match(await text(page, ".role-harness"), /no --network flag/);
  assert.equal(await page.locator("[data-raw-files]").getAttribute("open"), null, "raw files start closed");
  assert.match(await text(page, "[data-raw-files] summary"), /published by forge upgrade/);
  await page.screenshot({ path: join(SHOTS, "fg827-harness.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Skills — description, source badge, optional and seed reference per mounted skill; available and host-only apart", async () => {
  const { page, errors } = await open("#roles/engineer/skills");
  await page.locator('[data-group="mounted"] [data-skill="browser-tools"]').waitFor();
  const row = page.locator('[data-group="mounted"] [data-skill="browser-tools"]');
  assert.match((await row.locator("[data-description]").textContent()) ?? "", /Drive a headless Chrome/);
  assert.equal(await row.locator("[data-source]").textContent(), "Host path");
  assert.equal(await row.locator("[data-optional]").count(), 1);
  assert.equal(await row.locator("[data-referenced]").getAttribute("data-referenced"), "yes");
  assert.match(await text(page, '[data-group="available"]'), /Available, not mounted\s*0/);
  assert.match(await text(page, "[data-available-note]"), /FG-797\/FG-798/);
  assert.ok(await page.locator('[data-group="host-only"] [data-skill="forge-backlog"]').count() === 1);
  await page.screenshot({ path: join(SHOTS, "fg827-skills.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Capabilities — activities, routes with relations, result-contract fields, mount mode and constraints by name", async () => {
  const d = detail("engineer");
  const { page, errors } = await open("#roles/engineer/capabilities");
  await page.locator(".role-capabilities").waitFor();
  assert.equal(await text(page, "[data-activities]"), d.capabilities.activities.map((a: any) => a.activity).join(", "));
  assert.deepEqual(await page.locator(".role-routes li").evaluateAll((lis) => lis.map((li) => li.getAttribute("data-route"))), d.capabilities.routes.map((r: any) => r.route));
  assert.deepEqual(await page.locator("[data-contract] [data-field]").evaluateAll((els) => els.map((el) => el.getAttribute("data-field"))), d.capabilities.resultContract.fields.map((f: any) => f.name));
  assert.ok((await page.locator('[data-field="tests_run"]').count()) === 1 && (await page.locator('[data-field="docs_impact"]').count()) === 1);
  assert.equal(await text(page, "[data-mount-mode]"), "read-write");
  assert.deepEqual(await page.locator("[data-constraint]").evaluateAll((els) => els.map((el) => [el.getAttribute("data-constraint"), el.getAttribute("data-level")])),
    d.capabilities.constraints.map((c: any) => [c.id, c.level]));
  await page.screenshot({ path: join(SHOTS, "fg827-capabilities.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Tools — the declared list keeps 'not enforced', effective access shows mounts, network, toolchain and MCP none", async () => {
  const { page, errors } = await open("#roles/engineer/tools");
  await page.locator("[data-effective]").waitFor();
  assert.match(await text(page, "[data-tools-flag]"), /^declared, not enforced/);
  assert.deepEqual(await page.locator("[data-effective-mount]").evaluateAll((els) => els.map((el) => el.getAttribute("data-effective-mount"))).then((m) => m.slice(0, 2)), ["/task", "/project"]);
  assert.equal(await text(page, "[data-network]"), "docker default (bridge)");
  assert.equal(await text(page, "[data-mcp]"), "none");
  for (const tool of ["node", "git", "chromium"]) assert.equal(await page.locator(`[data-tool="${tool}"]`).count(), 1, tool);
  await page.screenshot({ path: join(SHOTS, "fg827-tools.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Usage — 1d/7d/30d/all periods, by provider and by model with requests, tokens only without a pricing source", async () => {
  const { page, errors } = await open("#roles/engineer/usage");
  await page.locator("[data-period]").first().waitFor();
  assert.deepEqual(await page.locator("[data-period]").evaluateAll((els) => els.map((el) => el.getAttribute("data-period"))), ["1d", "7d", "30d", "all"]);
  assert.equal(await page.locator('[data-period="30d"]').getAttribute("aria-pressed"), "true");
  const providers = await page.locator(".role-usage-provider tbody tr").evaluateAll((trs) => trs.map((tr) => [tr.getAttribute("data-provider"), tr.querySelector("[data-cost]")?.textContent]));
  assert.deepEqual(providers.map((p) => p[0]), ["anthropic", "anthropic"]);
  assert.ok(providers.some((p) => p[1] === "tokens only (subscription)"));
  assert.ok(providers.some((p) => /^API key — no pricing source on this host/.test(p[1] ?? "")));
  assert.deepEqual(await page.locator(".role-usage-model tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-model"))), ["claude-opus-5", "claude-sonnet-5"]);
  await page.screenshot({ path: join(SHOTS, "fg827-usage.png"), fullPage: true });
  await page.locator('[data-period="1d"]').click();
  await page.waitForFunction(() => document.querySelector("[data-window]")?.getAttribute("data-window") === "1d");
  assert.deepEqual(await page.locator(".role-usage-model tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-model"))), ["claude-sonnet-5"]);
  assert.match(await text(page, "[data-window]"), /1 requests/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: Overview — a Latest task card with its status token and relative time, Skills chips to the Skills tab, no role status", async () => {
  const { page, errors } = await open("#roles/engineer");
  await page.locator("[data-latest-task]").waitFor();
  const card = page.locator("[data-latest-task]");
  assert.equal(await card.getAttribute("data-latest-task"), "task-e2");
  assert.equal(await card.locator(".badge").getAttribute("class"), "badge status-failed");
  assert.equal(await card.locator('a[href="#task/task-e2"]').count(), 1);
  assert.match((await card.locator("[data-relative]").textContent()) ?? "", /ago$/);
  assert.equal(await page.locator(".role-routes").count(), 0);
  await page.screenshot({ path: join(SHOTS, "fg827-overview.png"), fullPage: true });
  // The only status token on the whole role page is the latest TASK's; the role has none.
  assert.equal(await page.locator(".role-page .badge").count(), 1);
  await page.locator('[data-chip="browser-tools"]').click();
  await page.waitForFunction(() => location.hash === "#roles/engineer/skills");
  await page.locator('[data-group="mounted"]').waitFor();
  for (const tab of ["harness", "skills", "capabilities", "tools", "usage"]) {
    await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
    await page.waitForFunction((t) => document.querySelector(".role-caption")?.getAttribute("data-caption") === t, tab);
    assert.equal(await page.locator(".role-page .badge").count(), 0, `${tab} carries no status pill`);
  }
  await page.goto(`${baseUrl}/#roles`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  assert.equal(await page.locator(".roles-table .badge").count(), 0, "the Roles list carries no status pill");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-827: new role tabs reload and alias canonically; Files are keyboard operable, copy exact composed bytes, safely render hostile Markdown, and fit at 400px", async () => {
  const seedPath = join(home, "agents", "engineer", "CLAUDE.md");
  const original = readFileSync(seedPath, "utf8");
  const hostile = `${original}\n\n<script>window.__rolesXss = true</script>\n<img src=x onerror="window.__rolesXss = true">\n`;
  writeFileSync(seedPath, hostile);
  const { page, errors } = await open("#roles/engineer/configuration", 400);
  try {
    await page.locator(".role-harness").waitFor();
    assert.equal(hashOf(page), "#roles/engineer/harness", "configuration aliases to Harness canonically");
    await page.reload();
    await page.locator(".role-harness").waitFor();
    await page.goto(`${baseUrl}/#roles/engineer/capabilities`);
    await page.locator(".role-capabilities").waitFor();
    await page.reload();
    await page.locator(".role-capabilities").waitFor();

    await page.goto(`${baseUrl}/#roles/engineer/instructions`);
    await page.locator('[data-file="entry"]').waitFor();
    await page.locator('[data-file="entry"]').focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('[data-file="protocol"]').getAttribute("aria-pressed"), "true", "native keyboard reaches and selects a Files row");
    await page.locator('[data-file="entry"]').click();
    assert.equal(await page.locator(".instr-md script").count(), 0, "hostile script never becomes an element");
    assert.equal(await page.locator(".instr-md [onerror]").count(), 0, "event-handler HTML never becomes an element");
    assert.match((await page.locator(".instr-md").textContent()) ?? "", /<script>window\.__rolesXss = true<\/script>/, "hostile HTML is visible as text, not silently rendered");

    await page.locator('[data-mode="composed"]').click();
    const expected = detail("engineer").instructions.prompt;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    await page.locator(".instr-copy").click();
    await page.getByRole("button", { name: "Copy to clipboard" }).getByText("Copied").waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, "Copy writes the Composed bytes");
    const overflow = await page.locator(".instr-layout").evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(overflow, false, "the Files panel and viewer fit a 400px viewport");
    await page.screenshot({ path: join(SHOTS, "fg827-instructions-400px.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    writeFileSync(seedPath, original);
    await page.close();
  }
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
      json(rolesIndex());
      return;
    }
    const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
    if (roleMatch) {
      const body = roleDetail(decodeURIComponent(roleMatch[1]!));
      if (body) json(body);
      else json({ error: "no role seed" }, 404);
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
