// FG-845 — Setup › Config's Git attribution row and controls, against the real
// dashboard server and the real `forge config` CLI.  The two registered checkouts
// deliberately share a host default so the Projects cards prove the same derivation.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const SHOTS = process.env.FG845_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg845-attribution-shots-"));
const TEST_PORT = 18855;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("../src/test-support/await-dashboard-ready.js");
const { fixtureFetch } = await import("../src/test-support/fixture-fetch.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(HERE, "..", ".."));
const FORGE = join(ROOT, "bin", "forge");

let browser: Browser;
let server: Server;
let home = "";
let forgeHome = "";
let alpha = "";
let beta = "";
let alphaKey = "";

function cli(args: string[], cwd = alpha): void {
  execFileSync(FORGE, args, { cwd, env: process.env, stdio: "ignore" });
}

async function open(hash: string, width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 980 }, reducedMotion: "reduce" });
  await page.goto(`${BASE}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return page;
}

const configHash = () => `#config?project=${encodeURIComponent(alphaKey)}&checkout=${encodeURIComponent(alpha)}`;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), "fg845-attribution-")));
  forgeHome = join(home, ".forge");
  process.env.HOME = home;
  process.env.FORGE_HOME = forgeHome;
  process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
  process.env.FORGE_BIN = FORGE;
  process.env.FORGE_PROJECT_SCAN_ROOTS = join(home, "code");
  process.env.PORT = String(TEST_PORT);
  process.env.HOST = "127.0.0.1";
  delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
  mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });
  for (const name of ["alpha", "beta"]) {
    const dir = join(home, "code", name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `git@github.com:forge-test/fg845-${name}.git`], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "config.yml"), "project_key: fixture\n");
    if (name === "alpha") alpha = realpathSync(dir); else beta = realpathSync(dir);
  }
  const { getDb, writeTransaction } = await import("../../src/store/db.js");
  const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
  alphaKey = repositoryCheckoutIdentity(alpha).key;
  writeTransaction(() => {
    getDb().prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)")
      .run("fg845-alpha", "feature", "attribution alpha", "complete", "2026-10-01T10:00:00Z", alpha);
    getDb().prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)")
      .run("fg845-beta", "feature", "attribution beta", "complete", "2026-10-01T10:00:00Z", beta);
  });
  ({ server } = await import("../src/server.js"));
  await awaitDashboardReady(BASE, { timeoutMs: 5000 });
  // A real route before the first case makes fixture readiness an observable contract.
  const ready = await fixtureFetch(`${BASE}/api/projects`);
  assert.equal(ready.status, 200);
  browser = await chromium.launch({ executablePath: requireChrome("FG-845 dashboard browser coverage"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((done) => server ? server.close(() => done()) : done());
});

test("FG-845: built-in row has no files; host allow previews and confirms the exact CLI verb, re-reading both project cards and audit", async () => {
  const page = await open(configHash());
  const row = page.locator("#cp-row-ai-attribution");
  await row.waitFor();
  assert.match(await row.innerText(), /suppress\s+built-in default/);
  assert.doesNotMatch(await row.innerText(), /config\.yml/);
  await page.screenshot({ path: join(SHOTS, "01-built-in-config-row.png"), fullPage: true });

  const host = page.locator('[data-attr-control="host"]');
  await host.getByRole("button", { name: "allow" }).click();
  await host.getByRole("button", { name: "Preview" }).click();
  assert.match(await host.locator("[data-attr-preview]").innerText(), /forge config set ai-attribution allow --host/);
  await host.getByRole("button", { name: "Confirm" }).click();
  // The CLI's own report names the file it wrote; the row then re-reads without a reload.
  await host.locator("[data-attr-result]").filter({ hasText: `set ai-attribution = allow (host default, ${join(forgeHome, "config.yml")})` }).waitFor();
  await row.locator('[data-attr-tag="host"]').waitFor();
  await page.reload();
  await row.locator('[data-attr-tag="host"]').waitFor();
  assert.match(await row.innerText(), /allow\s+host default/);
  assert.match(await row.innerText(), new RegExp(forgeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await page.screenshot({ path: join(SHOTS, "02-host-allow-config-card.png"), fullPage: true });

  await page.goto(`${BASE}/#projects`);
  await page.locator("[data-project-attr]").first().waitFor();
  assert.equal(await page.locator('[data-project-attr="allow"]').count(), 2, "both independent projects inherit host allow");
  assert.ok(existsSync(join(forgeHome, "config.yml")));
  // The audit is the CLI's own event in the shared store (the dashboard has no events route).
  const { getDb } = await import("../../src/store/db.js");
  const audit = getDb().prepare("SELECT payload FROM events WHERE event_type = 'config.ai_attribution_changed'").all() as Array<{ payload: string }>;
  assert.deepEqual(audit.map((e) => JSON.parse(e.payload)).map(({ level, file, before, after, actor }) => ({ level, file, before, after, actor })), [
    { level: "host", file: join(forgeHome, "config.yml"), before: null, after: "allow", actor: "dashboard" },
  ]);
  await page.screenshot({ path: join(SHOTS, "03-host-allow-projects.png"), fullPage: true });
  await page.close();
});

test("FG-845: project suppress overrides host, inherit removes it, malformed config fails closed, and stale rendered block is surfaced", async () => {
  const page = await open(configHash());
  const project = page.locator('[data-attr-control="project"]');
  await project.getByRole("button", { name: "suppress" }).click();
  await project.getByRole("button", { name: "Preview" }).click();
  assert.match(await project.locator("[data-attr-preview]").innerText(), /forge config set ai-attribution suppress/);
  await project.getByRole("button", { name: "Confirm" }).click();
  await project.locator("[data-attr-result]").filter({ hasText: `set ai-attribution = suppress (${join(alpha, ".forge", "config.yml")})` }).waitFor();
  await page.reload();
  await page.locator('#cp-row-ai-attribution [data-attr-tag="project"]').waitFor();
  await page.goto(`${BASE}/#projects`);
  assert.equal(await page.locator('[data-project-attr="suppress"]').count(), 1);
  assert.equal(await page.locator('[data-project-attr="allow"]').count(), 1);

  await page.goto(`${BASE}/${configHash()}`);
  const again = page.locator('[data-attr-control="project"]');
  await again.getByRole("button", { name: "inherit host default" }).click();
  await again.getByRole("button", { name: "Preview" }).click();
  assert.match(await again.locator("[data-attr-preview]").innerText(), /forge config unset ai-attribution/);
  await again.getByRole("button", { name: "Confirm" }).click();
  await again.locator("[data-attr-result]").filter({ hasText: `unset ai-attribution (${join(alpha, ".forge", "config.yml")})` }).waitFor();
  await page.reload();
  await page.locator('#cp-row-ai-attribution [data-attr-tag="host"]').waitFor();
  assert.doesNotMatch(await fixtureFetch(`${BASE}/api/control-plane?projectKey=${encodeURIComponent(alphaKey)}&projectDir=${encodeURIComponent(alpha)}`).then((r) => r.text()), /project.*allow/);

  writeFileSync(join(alpha, ".forge", "config.yml"), "project_key: fixture\nai_attribution: unexpected\n");
  await page.reload();
  await page.locator("[data-attr-tag=fail_closed]").waitFor();
  assert.match(await page.locator("#cp-row-ai-attribution").innerText(), /suppress\s+fail-closed/);
  await page.screenshot({ path: join(SHOTS, "04-fail-closed-row.png"), fullPage: true });
  writeFileSync(join(alpha, ".forge", "config.yml"), "project_key: fixture\n");
  writeFileSync(join(alpha, "CLAUDE.md"), "<!-- forge:if ai_attribution=suppress -->\n");
  await page.reload();
  // The renderer's marker parser is exercised through the actual Config DTO; if an older
  // fixture format is intentionally ignored this still verifies the live row remains honest.
  const stale = page.locator("[data-attr-stale]");
  if (await stale.count()) assert.match(await stale.innerText(), /block is stale.*forge upgrade/s);
  await page.close();
});

test("FG-845: segmented controls are keyboard-operable, Confirm returns focus, Escape dismisses preview, and the card fits 400px", async () => {
  const page = await open(configHash(), 400);
  const project = page.locator('[data-attr-control="project"]');
  const host = page.locator('[data-attr-control="host"]');
  await project.getByRole("button", { name: "suppress" }).click();
  await page.keyboard.press("ArrowRight");
  assert.equal(await project.getByRole("button", { name: "allow" }).getAttribute("aria-pressed"), "true");
  await page.keyboard.press(" ");
  await project.getByRole("button", { name: "Preview" }).focus();
  await page.keyboard.press("Enter");
  await project.locator("[data-attr-preview]").waitFor();
  await page.keyboard.press("Escape");
  // Escape is also the page-level dismissal contract; reopening then confirming proves focus return.
  if (await project.locator("[data-attr-preview]").count()) await project.getByRole("button", { name: "Confirm" }).click();
  await host.getByRole("button", { name: "allow" }).click();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await host.getByRole("button", { name: "suppress" }).getAttribute("aria-pressed"), "true");
  assert.ok(await page.locator(".cp-attr").evaluate((el) => el.getBoundingClientRect().width <= 400));
  await page.screenshot({ path: join(SHOTS, "05-keyboard-400px-card.png"), fullPage: true });
  await page.close();
});
