// FG-831: the checkout label rule, rendered from the REAL dashboard server over a scratch
// registry — the shape that made Forge read "main" fifteen times: a primary checkout, a
// feature clone, two disposable clones that are both a directory called `forge` on `main`,
// and a checkout whose directory is gone.
//
// Proves: every checkout is distinguishable (path context + branch) wherever it is named —
// since FG-843 the Runs rows and the Routing header chooser, the scope bar's list having
// been retired — and the primary is marked; the missing checkout reads `missing on disk`
// and its runs still render, on Runs and through a `?checkout=` deep link, with no page
// error; the Projects card names the missing count and `forge projects prune --missing`.
//
// Screenshots go to a fresh temp dir unless FG831_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const SHOTS = process.env.FG831_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg831-screenshots-"));

const TEST_PORT = 18835;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("../src/test-support/await-dashboard-ready.js");

const testHome = mkdtempSync(join(tmpdir(), "fg831-checkout-labels-"));
const forgeHome = join(testHome, ".forge");
const scanRoot = join(testHome, "scan");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoot, { recursive: true });
process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function checkout(rel: string, branch: string): string {
  const dir = join(testHome, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const primary = checkout("code/forge", "main");
const feature = checkout("code/forge-fg827", "feat/fg-827-roles-second-pass");
const clone1 = checkout("clones/run-1/forge", "main");
const clone2 = checkout("clones/run-2/forge", "main");
// A deleted scratchpad of the primary — a MISSING checkout of Forge.
const gone = join(testHome, "claude-1", primary.replaceAll("/", "-"), "sess-a", "scratchpad", "wt-a");

let browser: Browser | undefined;
let server: Server | undefined;

before(async () => {
  const { SCHEMA_SQL } = await import("../../src/store/schema.js");
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  insertRun.run("run-clone1", "feature", "Clone one run", "complete", "2026-09-20T10:00:00Z", clone1);
  insertRun.run("run-clone2", "feature", "Clone two run", "complete", "2026-09-21T10:00:00Z", clone2);
  insertRun.run("run-feature", "feature", "Roles second pass", "complete", "2026-09-22T10:00:00Z", feature);
  insertRun.run("run-gone", "feature", "Scratchpad run", "complete", "2026-09-23T10:00:00Z", gone);
  insertRun.run("run-primary", "feature", "Primary run", "complete", "2026-09-28T10:00:00Z", primary);
  database.close();

  ({ server } = await import("../src/server.js"));
await awaitDashboardReady(BASE, { timeoutMs: 4000 });
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 74) throw new Error("dashboard test server did not start");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

async function newPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

async function scopeToForge(page: Page): Promise<void> {
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: /Open all Forge checkouts/ }).click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".nav-column .nav-scope-select")?.value !== "");
}

// FG-843 retired the scope bar's checkout list: the labels it carried now live where a
// checkout is named — every Runs row (the cross-checkout view) and the header of the
// checkout-scoped views. The rule under test is unchanged: FG-831's one label module.
const runLabel = async (page: Page, runId: string) => (await page.locator(`tr[data-run-id=${runId}] .runs-checkout`).innerText()).trim();

test("FG-831: every checkout is labelled distinctly — path context plus branch — and the primary is marked", async () => {
  const page = await newPage();
  await scopeToForge(page);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tr[data-run-id=run-gone]").waitFor();
  const labels = {
    primary: await runLabel(page, "run-primary"),
    clone1: await runLabel(page, "run-clone1"),
    clone2: await runLabel(page, "run-clone2"),
    feature: await runLabel(page, "run-feature"),
  };
  assert.deepEqual(labels, {
    primary: "code/forge · main",
    clone1: "run-1/forge · main",
    clone2: "run-2/forge · main",
    feature: "forge-fg827 · feat/fg-827-roles-second-pass",
  });
  assert.equal(new Set(Object.values(labels)).size, 4, "no two checkouts read the same");
  await page.screenshot({ path: join(SHOTS, "fg831-scope-bar-labels.png") });

  await page.getByRole("link", { name: "Routing", exact: true }).click();
  const head = page.locator(".page-head .checkout-chooser");
  await head.waitFor();
  assert.match(await head.innerText(), /checkout:\s*code\/forge · main\s*primary/);
  assert.equal(await head.locator("[title]").first().getAttribute("title"), primary);
  await page.close();
});

test("FG-831: the gone checkout reads missing on disk, and its runs still render — on Runs and through a deep link", async () => {
  const page = await newPage();
  await scopeToForge(page);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tr[data-run-id=run-gone]").waitFor();
  assert.equal(await runLabel(page, "run-gone"), "wt-a · missing on disk", "the run row names its checkout by the same rule");
  await page.screenshot({ path: join(SHOTS, "fg831-scope-bar-missing-shown.png") });

  const key = new URL(page.url()).hash.match(/project=([^&]+)/)?.[1];
  assert.ok(key, "the Runs hash carries the project");
  await page.goto(`${BASE}/#routing?project=${key}&checkout=${encodeURIComponent(gone)}`);
  const chooser = page.locator(".page-head .checkout-chooser");
  await chooser.waitFor();
  assert.match(await chooser.innerText(), /wt-a · missing on disk/);
  assert.match(await page.locator(".mobile-head-scope").textContent() ?? "", /Forge › wt-a · missing on disk/);
  await page.close();
});

test("FG-831: the Projects card counts the missing checkout and names the prune verb", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  const card = page.locator(".project-card", { has: page.locator('.project-chip:has-text("Forge")') });
  await card.waitFor();
  assert.equal((await card.locator(".project-missing-count").innerText()).trim(), "1 missing on disk · prune with forge projects prune --missing");
  await card.locator(".project-dirs-toggle").click();
  const rows = await card.locator(".project-checkout-row .checkout-branch").allInnerTexts();
  assert.ok(!rows.some((r) => /missing/.test(r)), "an idle missing checkout is counted, not listed");
  assert.ok(rows.includes("forge-fg827 · feat/fg-827-roles-second-pass"));
  await page.screenshot({ path: join(SHOTS, "fg831-projects-missing-count.png"), fullPage: true });
  await page.close();
});

test("FG-831: at 400px the drawer holds the project select alone and the Runs rows keep their labels", async () => {
  const page = await browser!.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: /Open all Forge checkouts/ }).click();
  await page.getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.waitFor();
  assert.equal(await drawer.locator(".nav-scope button").count(), 0, "FG-843: no checkout buttons in the scope control");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the 400px scope drawer does not overflow");

  await drawer.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tr[data-run-id=run-clone1]").waitFor();
  assert.equal(
    (await page.locator("tr[data-run-id=run-clone1] .runs-checkout").innerText()).trim(),
    "run-1/forge · main",
    "the runs index calls the same exported checkout-label rule",
  );
  await page.screenshot({ path: join(SHOTS, "fg831-mobile-scope-to-runs.png"), fullPage: true });
  await page.close();
});
