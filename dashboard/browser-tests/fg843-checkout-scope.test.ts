// FG-843: selecting a project selects its primary checkout; the scope column is the
// project select alone; a checkout chooser sits in the header of Routing, Config and Notes
// only — a real button and listbox when the project has two or more live operator
// checkouts, the plain label with one; run-only directories are never offered.
//
// Rendered from the REAL dashboard server over a scratch registry: Forge has a primary, a
// second registered checkout (`forge projects classify --purpose operator`) and three
// run-only directories, one deleted; Solo has one checkout and a run clone.
//
// Screenshots go to a fresh temp dir unless FG843_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import { provenPhysical } from "../../src/util/path-identity.js";

const SHOTS = process.env.FG843_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg843-screenshots-"));

const TEST_PORT = 18845;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const testHome = mkdtempSync(join(tmpdir(), "fg843-checkout-scope-"));
const forgeHome = join(testHome, ".forge");
process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(testHome, "no-scan");
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function checkout(rel: string, branch: string, remote: string): string {
  const dir = join(testHome, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return provenPhysical(dir)!;
}

const FORGE_REMOTE = "git@github.com:acme/forge.git";
const SOLO_REMOTE = "git@github.com:acme/solo.git";
let primary = "";
let primaryAlias = "";
let stable = "";
let clone = "";
let worktree = "";
let gone = "";
let solo = "";
let soloClone = "";

let browser: Browser | undefined;
let server: Server | undefined;
let forgeKey = "";
let soloKey = "";

before(async () => {
  mkdirSync(forgeHome, { recursive: true });
  primary = checkout("code/forge", "main", FORGE_REMOTE);
  // A run records this checkout through a symlinked *parent*. Its spelling must collapse
  // to primary's realpath identity, not produce a fourth kind of checkout or a second
  // chooser option (FG-693 / FG-843).
  symlinkSync(join(testHome, "code"), join(testHome, "code-alias"), "dir");
  primaryAlias = join(testHome, "code-alias", "forge");
  stable = checkout("code/forge-stable", "main", FORGE_REMOTE);
  clone = checkout("code/forge-fg801", "feat/fg-801", FORGE_REMOTE);
  worktree = checkout(".forge/worktrees/run-9/forge", "feat/fg-809", FORGE_REMOTE);
  // A deleted run-only directory of the primary: a scratchpad the registry recovers the
  // repository of from its encoded source segment — a MISSING run checkout.
  gone = join(provenPhysical(testHome)!, "claude-1", primary.replaceAll("/", "-"), "sess-a", "scratchpad", "wt-a");
  solo = checkout("code/solo", "main", SOLO_REMOTE);
  soloClone = checkout("code/solo-fg12", "feat/fg-12", SOLO_REMOTE);

  const { SCHEMA_SQL } = await import("../../src/store/schema.js");
  const { applyMigrations } = await import("../../src/store/db.js");
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  applyMigrations(database);
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  insertRun.run("run-primary", "feature", "Primary run", "complete", "2026-09-28T10:00:00Z", primary);
  insertRun.run("run-primary-alias", "feature", "Primary through symlink", "complete", "2026-09-28T09:00:00Z", primaryAlias);
  insertRun.run("run-stable", "feature", "Stable run", "complete", "2026-09-27T10:00:00Z", stable);
  insertRun.run("run-clone", "feature", "Clone run", "complete", "2026-09-26T10:00:00Z", clone);
  insertRun.run("run-worktree", "feature", "Worktree run", "complete", "2026-09-25T10:00:00Z", worktree);
  insertRun.run("run-gone", "feature", "Gone run", "complete", "2026-09-24T10:00:00Z", gone);
  insertRun.run("run-solo", "feature", "Solo run", "complete", "2026-09-23T10:00:00Z", solo);
  insertRun.run("run-solo-clone", "feature", "Solo clone run", "complete", "2026-09-22T10:00:00Z", soloClone);
  database.close();
  const { classifyWorkspacePurpose } = await import("../../src/store/workspace-purpose.js");
  classifyWorkspacePurpose({ path: stable, kind: "operator", actor: "fg843-test" });

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
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ key: string; primaryCheckout: string }>;
  forgeKey = projects.find((p) => p.primaryCheckout === primary)?.key ?? "";
  soloKey = projects.find((p) => p.primaryCheckout === solo)?.key ?? "";
  assert.ok(forgeKey && soloKey, `both projects are registered: ${JSON.stringify(projects)}`);
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

async function newPage(width = 1200): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

const hashOf = (page: Page) => decodeURIComponent(new URL(page.url()).hash);
const chooser = (page: Page) => page.locator(".page-head .checkout-chooser");
const chooserButton = (page: Page) => page.locator(".page-head .checkout-chooser-button");
const options = (page: Page) => page.locator(".checkout-chooser-menu [role=option]");

async function selectProject(page: Page, key: string): Promise<void> {
  await page.locator(".nav-column .nav-scope-select").selectOption(key);
}

test("FG-843: after selecting a project the scope column holds the project select only", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#routing`);
  await page.locator(".nav-column .nav-scope-select option", { hasText: "Forge" }).waitFor({ state: "attached" });
  await selectProject(page, forgeKey);
  await chooserButton(page).waitFor();
  const scope = page.locator(".nav-column .nav-scope");
  assert.equal(await scope.locator("select").count(), 1);
  assert.equal(await scope.locator("button").count(), 0, "no checkout chips, no all-checkouts pill, no clear button");
  const text = await scope.innerText();
  assert.ok(!/all checkouts|missing|forge-fg801|run-9/.test(text), `the scope column names no checkout: ${text}`);
  assert.equal(hashOf(page), `#routing?project=${forgeKey}`, "selecting a project writes no checkout — the primary is implied");
  assert.match(await chooserButton(page).innerText(), /code\/forge · main\s*primary/, "the primary checkout is selected silently");
  await page.screenshot({ path: join(SHOTS, "fg843-scope-column-routing-1200.png") });
  await chooserButton(page).click();
  await options(page).first().waitFor();
  await page.screenshot({ path: join(SHOTS, "fg843-routing-chooser-open-1200.png") });
  await page.close();
});

test("FG-843: Routing's chooser lists the two live operator checkouts, primary first; a pick rewrites ?checkout= and re-reads", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#routing?project=${forgeKey}`);
  await chooserButton(page).click();
  await options(page).first().waitFor();
  const rows = await options(page).evaluateAll((els) => els.map((el) => ({
    dir: el.getAttribute("data-checkout"),
    label: el.querySelector(".checkout-chooser-value")?.textContent?.trim(),
    primary: el.querySelector(".checkout-chooser-chip-primary") !== null,
    selected: el.getAttribute("aria-selected"),
  })));
  assert.deepEqual(rows, [
    { dir: primary, label: "code/forge · main", primary: true, selected: "true" },
    { dir: stable, label: "forge-stable · main", primary: false, selected: "false" },
  ], "run checkouts (the clone, the worktree, the deleted one) are never offered");
  assert.equal(
    (await page.locator(".checkout-chooser-footer").innerText()).trim(),
    "2 operator checkouts · 3 run checkouts are listed on their runs, not here",
  );

  const reread = page.waitForRequest((req) => req.url().includes("/api/governance") && new URL(req.url()).searchParams.get("projectDir") === stable);
  await options(page).nth(1).click();
  await reread;
  assert.equal(hashOf(page), `#routing?project=${forgeKey}&checkout=${stable}`);
  assert.match(await chooserButton(page).innerText(), /forge-stable · main/);
  assert.equal(await chooserButton(page).getAttribute("aria-expanded"), "false");

  await page.getByRole("link", { name: "Config", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#config"));
  assert.equal(hashOf(page), `#config?project=${forgeKey}&checkout=${stable}`, "Config, also checkout-scoped, keeps the pick");
  assert.match(await chooserButton(page).innerText(), /forge-stable · main/);
  await page.close();
});

test("FG-843: with one live operator checkout Routing, Config and Notes show the plain label", async () => {
  const page = await newPage();
  for (const view of ["routing", "config", "notes"]) {
    await page.goto(`${BASE}/#${view}?project=${soloKey}`);
    await chooser(page).waitFor();
    assert.equal(await chooser(page).getAttribute("data-checkout-chooser"), "label", `${view}: plain label`);
    assert.equal(await chooser(page).locator("button").count(), 0, `${view}: nothing to open`);
    assert.match(await chooser(page).innerText(), /checkout:\s*solo · main\s*primary/);
    if (view === "routing") await page.screenshot({ path: join(SHOTS, "fg843-routing-one-checkout-1200.png") });
  }
  await page.close();
});

test("FG-843: Home, Runs, Backlog, Roles, Models and Ops never show a chooser; Routing, Config and Notes do", async () => {
  const page = await newPage();
  for (const view of ["home", "activity", "runs", "backlog", "roles", "models", "ops", "usage", "queue", "reviews"]) {
    await page.goto(`${BASE}/#${view}?project=${forgeKey}&checkout=${encodeURIComponent(stable)}`);
    await page.locator(".page-title").first().waitFor();
    await page.waitForFunction(() => document.querySelector(".nav-scope-select option:checked")?.textContent === "Forge");
    assert.equal(await page.locator(".checkout-chooser").count(), 0, `${view} shows no chooser`);
    assert.ok(!hashOf(page).includes("checkout="), `${view} drops the checkout from its hash: ${hashOf(page)}`);
  }
  for (const view of ["routing", "config", "notes"]) {
    await page.goto(`${BASE}/#${view}?project=${forgeKey}`);
    await chooserButton(page).waitFor();
  }
  await page.close();
});

test("FG-843: a run-checkout deep link on Routing opens, is labelled run checkout, and offers the operator checkouts", async () => {
  const page = await newPage();
  const read = page.waitForRequest((req) => req.url().includes("/api/governance") && new URL(req.url()).searchParams.get("projectDir") === worktree);
  await page.goto(`${BASE}/#routing?project=${forgeKey}&checkout=${encodeURIComponent(worktree)}`);
  await read;
  await chooserButton(page).waitFor();
  assert.match(await chooserButton(page).innerText(), /run-9\/forge · feat\/fg-809\s*run checkout/);
  await chooserButton(page).click();
  await options(page).first().waitFor();
  assert.deepEqual(await options(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-checkout"))), [primary, stable]);
  await page.screenshot({ path: join(SHOTS, "fg843-routing-run-checkout-deep-link.png") });

  await page.goto(`${BASE}/#routing?project=${soloKey}&checkout=${encodeURIComponent(soloClone)}`);
  await page.waitForFunction((dir) => document.querySelector(".page-head .checkout-chooser-button")?.getAttribute("title") === dir, soloClone);
  assert.match(await chooserButton(page).innerText(), /solo-fg12 · feat\/fg-12\s*run checkout/, "one operator checkout: the way back is still offered");
  await chooserButton(page).click();
  await options(page).first().waitFor();
  assert.deepEqual(await options(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-checkout"))), [solo]);

  // A path that belongs to no checkout is neither an operator nor a run checkout. It
  // must not become a fabricated third kind: Routing falls back to the implied primary
  // and rewrites the stale deep link to the canonical project-only hash.
  await page.goto(`${BASE}/#routing?project=${forgeKey}&checkout=${encodeURIComponent(join(testHome, "not-a-checkout"))}`);
  await page.waitForFunction((expected) => location.hash === expected, `#routing?project=${forgeKey}`);
  await chooserButton(page).waitFor();
  assert.match(await chooserButton(page).innerText(), /code\/forge · main\s*primary/);
  await page.close();
});

test("FG-843 / FG-692: the chooser opens, moves, picks and closes by keyboard; Escape returns focus to the button", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#routing?project=${forgeKey}`);
  await chooserButton(page).waitFor();
  await chooserButton(page).focus();
  await page.keyboard.press("Enter");
  await options(page).first().waitFor();
  assert.equal(await chooserButton(page).getAttribute("aria-expanded"), "true");
  await page.waitForFunction((dir) => document.activeElement?.getAttribute("data-checkout") === dir, primary);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-checkout")), stable);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.includes("checkout="));
  assert.equal(hashOf(page), `#routing?project=${forgeKey}&checkout=${stable}`);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("checkout-chooser-button")), true, "a pick returns focus to the button");

  await page.keyboard.press("Enter");
  await options(page).first().waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  assert.equal(await options(page).count(), 0, "Escape closes the menu");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("checkout-chooser-button")), true, "Escape returns focus to the button");
  assert.equal(hashOf(page), `#routing?project=${forgeKey}&checkout=${stable}`, "Escape picks nothing");
  await page.close();
});

test("FG-843: Runs keeps its cross-checkout listing with a checkout label on every row", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#runs?project=${forgeKey}`);
  await page.locator("tr[data-run-id=run-gone]").waitFor();
  const labels = Object.fromEntries(await page.locator("tr[data-run-id]").evaluateAll((rows) => rows.map((row) => [
    row.getAttribute("data-run-id"),
    row.querySelector(".runs-checkout")?.textContent?.trim(),
  ])));
  assert.deepEqual(labels, {
    "run-primary": "code/forge · main",
    "run-primary-alias": "code/forge · main",
    "run-stable": "forge-stable · main",
    "run-clone": "forge-fg801 · feat/fg-801",
    "run-worktree": "run-9/forge · feat/fg-809",
    "run-gone": "wt-a · missing on disk",
  }, "a symlinked-parent run is attributed to its primary physical checkout, while real run checkouts retain their own labels");
  await page.screenshot({ path: join(SHOTS, "fg843-runs-per-row-labels.png"), fullPage: true });
  await page.close();
});

test("FG-843: at 400px the drawer holds the select alone and the Routing chooser and its menu fit the viewport", async () => {
  const page = await newPage(400);
  await page.goto(`${BASE}/#routing?project=${forgeKey}`);
  await page.getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.waitFor();
  assert.equal(await drawer.locator(".nav-scope button").count(), 0);
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await drawer.waitFor({ state: "detached" });
  await chooserButton(page).click();
  await options(page).first().waitFor();
  const fits = await page.evaluate(() => {
    const menu = document.querySelector(".checkout-chooser-menu")!.getBoundingClientRect();
    const button = document.querySelector(".checkout-chooser-button")!.getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth <= window.innerWidth,
      menu: menu.left >= 0 && menu.right <= window.innerWidth,
      button: button.left >= 0 && button.right <= window.innerWidth,
    };
  });
  assert.deepEqual(fits, { page: true, menu: true, button: true });
  await page.screenshot({ path: join(SHOTS, "fg843-routing-chooser-400.png"), fullPage: true });
  await page.close();
});
