// FG-595: real-browser proof that the Projects view and its checkout scope
// controls suppress stale checkouts end-to-end. (FG-831: "suppressed" now means withheld
// behind the scope bar's "show N missing" and counted on the Projects card — the stale
// path still never reaches the DOM by default.) Unlike the canned-fixture
// browser tests, this boots the REAL dashboard server against a real forge DB
// so the presentation registry (queries.ts) runs for real: a deleted scratchpad
// grouped under an existing checkout must never reach the DOM, while a missing
// checkout that still has active work stays visible and reads as
// missing/unavailable rather than "unknown branch".

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const SHOT_DIR = process.env.INACTIVE_SHOT_DIR;

const TEST_PORT = 18774;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("../src/test-support/await-dashboard-ready.js");

const testHome = mkdtempSync(join(tmpdir(), "forge-inactive-browser-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

const forgeDir = join(reposRoot, "forge");
mkdirSync(forgeDir);
git(forgeDir, ["init", "-b", "main"]);
git(forgeDir, ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"]);

const forgeSegment = forgeDir.replaceAll("/", "-");
// Deleted scratchpad grouped under Forge — must be suppressed (gone + idle).
const staleScratch = join(testHome, "claude-1", forgeSegment, "sess-a", "scratchpad", "wt-a");
// Missing standalone checkout that STILL has active work — stays visible.
const ghostActive = join(testHome, "tmp", "ghost-active");

let browser: Browser | undefined;
let server: Server | undefined;

before(async () => {
  const { SCHEMA_SQL } = await import("../../src/store/schema.js");
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertDone = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  const insertRunning = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,?,?,?,'{}',?,?)",
  );
  const complete = (id: string, dir: string, at: string) => {
    insertRun.run(`run-${id}`, "feature", `Run ${id}`, "complete", at, dir);
    insertDone.run(`done-${id}`, `run-${id}`, "engineer", "engineer", "complete", at, at, at);
  };
  complete("forge", forgeDir, "2026-07-15T10:00:00Z");
  complete("stale", staleScratch, "2026-07-16T10:00:00Z");
  insertRun.run("run-ghost", "feature", "Ghost Active", "active", "2026-07-18T10:00:00Z", ghostActive);
  insertRunning.run("running-ghost", "run-ghost", "engineer", "engineer", "running", "2026-07-18T10:00:00Z", "2026-07-18T10:00:00Z");
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
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
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

test("Projects view hides the deleted scratchpad but keeps the missing-but-active checkout", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  const body = await page.locator("body").innerText();
  // The suppressed scratchpad path (and any /scratchpad/ segment) must be absent.
  assert.ok(!body.includes(staleScratch), "deleted scratchpad path must not render");
  assert.ok(!/scratchpad/.test(body), "no /scratchpad/ path segment reaches the Projects DOM");

  // Forge card shows exactly one (existing, main) checkout row.
  const forgeCard = page.locator(".project-card", { has: page.locator('.project-chip:has-text("Forge")') });
  await forgeCard.waitFor();
  const forgeRows = forgeCard.locator(".project-checkout-row");
  assert.equal(await forgeRows.count(), 1, "Forge shows only its on-disk checkout");
  assert.match(await forgeRows.first().innerText(), /main/);

  // The missing-but-active standalone checkout is present and truthfully labeled.
  const missing = page.locator(".checkout-branch.checkout-missing");
  await missing.first().waitFor();
  assert.ok((await missing.count()) >= 1, "missing checkout still rendered");
  const missingText = await missing.first().innerText();
  assert.match(missingText, /missing|unavailable/i, "missing checkout labeled missing/unavailable");
  assert.ok(!/unknown branch/i.test(missingText), "missing checkout is NOT labeled 'unknown branch'");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "projects-inactive-checkouts.png"), fullPage: true });
  await page.close();
});

// FG-843: the checkout is named in the header of the checkout-scoped views (Routing,
// Config, Notes) — the scope column's checkout list is gone — so the scope-control
// assertions below read Routing's header chooser, fed by the same project.checkouts.
test("Checkout scope controls omit stale paths and label the missing one", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  // Open the missing-but-active project (label 'Unknown repository') to scope by it.
  await page.getByRole("button", { name: /Open all Unknown repository checkouts/ }).click();
  await page.getByRole("link", { name: "Routing", exact: true }).click();

  const scope = page.locator(".page-head .checkout-chooser");
  await scope.waitFor();
  const scopeText = await scope.innerText();
  assert.ok(!scopeText.includes("scratchpad"), "scope controls never surface a stale scratchpad path");
  assert.match(scopeText, /missing/i, "the surviving missing checkout is labeled missing in the scope controls");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "scope-controls-missing.png"), fullPage: true });
  await page.close();
});

test("Forge scope selector — the project that HAD a stale scratchpad — offers only its on-disk checkout", async () => {
  // The prior test scopes a project ('Unknown repository') that never carried a
  // scratchpad, so its 'no scratchpad' assertion is trivially true. This one
  // scopes the Forge project, whose grouped scratchpad WAS suppressed, proving
  // the same suppressed project.checkouts feeds the checkout chooser — a stale
  // path can never reappear as a scope option.
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: /Open all Forge checkouts/ }).click();
  await page.getByRole("link", { name: "Routing", exact: true }).click();

  const scope = page.locator(".page-head .checkout-chooser");
  await scope.waitFor();
  const scopeText = await scope.innerText();
  assert.ok(!/scratchpad/.test(scopeText), "the suppressed scratchpad path never reaches the Forge scope selector");
  // The deleted scratchpad is a run checkout, and missing: it is never offered. With one
  // live operator checkout the header names it as plain text rather than a menu.
  assert.equal(await scope.getAttribute("data-checkout-chooser"), "label", "one on-disk checkout: the plain label, no menu");
  assert.ok(!/missing/.test(scopeText), "no missing checkout is offered");
  assert.match(scopeText, /main/, "the sole checkout named is the on-disk main checkout");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "scope-controls-forge.png"), fullPage: true });
  await page.close();
});
