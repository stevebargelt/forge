// FG-831: the scope bar's checkout selector, rendered from the REAL dashboard server over
// a scratch registry — the shape that made Forge read "main" fifteen times: a primary
// checkout, a feature clone, two disposable clones that are both a directory called
// `forge` on `main`, and a checkout whose directory is gone.
//
// Proves: every option is distinguishable (path context + branch), the primary is first
// and marked; the missing checkout is withheld behind "show 1 missing" and reads
// `missing on disk` when revealed; selecting it renders its runs with no page error; and
// the Projects card names the missing count and `forge projects prune --missing`.
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
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await page.locator(".nav-column .project-scope-options").waitFor();
}

const options = (page: Page) => page.locator(".nav-column .checkout-scope-btn");

test("FG-831: the selector labels every checkout distinctly — path context plus branch — with the primary first and marked", async () => {
  const page = await newPage();
  await scopeToForge(page);
  const texts = (await options(page).allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(texts, [
    "all checkouts",
    "code/forge · main primary",
    "run-1/forge · main",
    "run-2/forge · main",
    "forge-fg827 · feat/fg-827-roles-second-pass",
  ]);
  assert.equal(await options(page).nth(1).getAttribute("data-primary"), "true");
  assert.equal(await options(page).nth(1).getAttribute("title"), primary);
  assert.equal(new Set(texts).size, texts.length, "no two options read the same");
  assert.ok(!texts.some((t) => /missing/.test(t)), "the missing checkout is not offered by default");
  assert.equal(await page.locator(".nav-column .checkout-missing-toggle").innerText(), "show 1 missing");
  await page.screenshot({ path: join(SHOTS, "fg831-scope-bar-labels.png") });
  await page.close();
});

test("FG-831: show 1 missing reveals the gone checkout labeled missing on disk; selecting it renders its runs", async () => {
  const page = await newPage();
  await scopeToForge(page);
  const toggle = page.locator(".nav-column .checkout-missing-toggle");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const missing = page.locator(".nav-column .checkout-scope-btn-missing");
  assert.equal(await missing.innerText(), "wt-a · missing on disk");
  await page.screenshot({ path: join(SHOTS, "fg831-scope-bar-missing-shown.png") });

  await missing.click();
  await page.waitForFunction(() => document.querySelector(".nav-column .checkout-scope-btn-active")?.textContent?.includes("missing on disk"));
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tr[data-run-id=run-gone]").waitFor();
  assert.equal(await page.locator("tr[data-run-id]").count(), 1, "the missing checkout's scope holds exactly its own run");
  assert.match(await page.locator("tr[data-run-id=run-gone]").innerText(), /wt-a · missing on disk/, "the run row names its checkout by the same rule");
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

test("FG-831: at 400px the drawer keeps unique checkout labels and the selected label reaches Runs unchanged", async () => {
  const page = await browser!.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: /Open all Forge checkouts/ }).click();
  await page.getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.waitFor();
  const drawerOptions = drawer.locator(".checkout-scope-btn");
  const labels = (await drawerOptions.allInnerTexts()).map((text) => text.trim());
  assert.equal(new Set(labels).size, labels.length, "the narrow scope bar never repeats a checkout label");
  assert.ok(labels.includes("run-1/forge · main"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the 400px scope drawer does not overflow");

  await drawer.getByRole("button", { name: "run-1/forge · main", exact: true }).click();
  await drawer.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tr[data-run-id=run-clone1]").waitFor();
  assert.equal(
    (await page.locator("tr[data-run-id=run-clone1] .runs-checkout").innerText()).trim(),
    "run-1/forge · main",
    "the selected scope and runs index call the same exported checkout-label rule",
  );
  await page.screenshot({ path: join(SHOTS, "fg831-mobile-scope-to-runs.png"), fullPage: true });
  await page.close();
});
