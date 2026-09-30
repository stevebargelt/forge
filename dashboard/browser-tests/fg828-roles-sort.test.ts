// FG-828: the Roles list sorts by its column headers in a real browser — header buttons
// carrying aria-sort and a direction glyph, the sort in the hash (#roles?sort=&dir=) so a
// reload restores it, Enter/Space operating a header (FG-692), and unknown params falling
// back to role ascending. Sorting reorders the one GET /api/roles payload; the fixture
// counts that read to prove a header click never refetches.
//
// Screenshots go to a fresh temp dir unless FG828_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18833;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG828_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg828-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function role(name: string, over: Record<string, unknown> = {}) {
  return {
    role: name, description: `The ${name} role.`, defaultActivity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5",
    resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "a blue dispatch mounts /project read-write",
    settings: true, protocolSha: null, lastTaskAt: null, ...over,
  };
}

const ROLES = {
  generatedAt: new Date().toISOString(),
  agentsDir: "/h/agents",
  generation: { id: "gen-1", root: "/h/seed-generations/gen-1", sourceAssetRoot: "/h/releases/r1" },
  seedInstall: { kind: "healthy", reason: null },
  modelPolicy: { source: "host", path: "/h/model-policy.yml", error: null },
  storeError: null,
  roles: [
    role("architecture-advisor", { defaultActivity: "reasoning", model: "claude-opus-5-5", mountMode: "ro", lastTaskAt: ago(30) }),
    role("engineer", { lastTaskAt: ago(2) }),
    role("red-wide", { defaultActivity: "review", effort: "low", mountMode: "ro", settings: false }),
    role("scout", { defaultActivity: "review", profile: null, model: null, mountMode: "ro", lastTaskAt: ago(5) }),
    role("tech-lead", { defaultActivity: "reasoning", resolutionError: "no mapping", lastTaskAt: ago(0.5) }),
  ],
};

// Deliberately mixed facts: settings.json absence is presentation-only; each sortable
// fact has a missing value; and duplicated values make the role-name tie-break observable.
const MIXED_ROLES = {
  ...ROLES,
  roles: [
    role("alpha", { settings: false, defaultActivity: "build", profile: "alpha", mountMode: "rw", lastTaskAt: "2026-01-02T00:00:00.000Z" }),
    role("bravo", { defaultActivity: "build", profile: "beta", mountMode: "ro", lastTaskAt: "2026-01-02T00:00:00.000Z" }),
    role("charlie", { defaultActivity: "build", profile: "alpha", mountMode: "rw", lastTaskAt: "2026-01-01T00:00:00.000Z" }),
    role("delta", { defaultActivity: "deploy", profile: "delta", mountMode: "ro", lastTaskAt: "2026-01-03T00:00:00.000Z" }),
    role("no-activity", { defaultActivity: "", profile: "zeta", mountMode: "rw", lastTaskAt: "2026-01-05T00:00:00.000Z" }),
    role("never", { defaultActivity: "review", profile: "echo", mountMode: "rw", lastTaskAt: null }),
    role("unresolved", { defaultActivity: "review", profile: null, model: null, resolutionError: "no policy mapping", mountMode: undefined, lastTaskAt: "2026-01-04T00:00:00.000Z" }),
  ],
};

let server: Server;
let browser: Browser;
let rolesReads = 0;
let fixtureRoles: Record<string, unknown> = ROLES;
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

async function open(hash: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const order = (page: Page) => page.locator(".roles-table tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-role")));
const headers = (page: Page) => page.locator(".roles-table thead th").evaluateAll((ths) => ths.map((th) => [
  th.getAttribute("data-sort"), th.getAttribute("aria-sort"), th.querySelector("button")?.getAttribute("type") ?? null,
  th.querySelector(".sort-glyph")?.textContent ?? null,
]));
const ariaSorts = async (page: Page) => Object.fromEntries((await headers(page)).map(([col, sort]) => [col, sort]));

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

const BY_ROLE = ["architecture-advisor", "engineer", "red-wide", "scout", "tech-lead"];
const NONE = { role: "none", activity: "none", profile: "none", mount: "none", lastTask: "none" };

test("FG-828: clicking two headers sorts the list, flips on a second click, and sets aria-sort — without refetching", async () => {
  rolesReads = 0;
  const { page, errors } = await open("#roles");
  // FG-837: headers follow the roles-mock column order (name, model, family · activity, last task, mount).
  assert.deepEqual(await headers(page), [
    ["role", "ascending", "button", "▲"],
    ["profile", "none", "button", "↕"],
    ["activity", "none", "button", "↕"],
    ["lastTask", "none", "button", "↕"],
    ["mount", "none", "button", "↕"],
  ], "every header is a button; the default is role ascending");
  await waitFor(() => order(page), BY_ROLE, "row order");
  assert.equal(await page.locator('.nav-column a[data-view="roles"]').getAttribute("href"), "#roles", "the nav link carries no sort");

  await page.locator('th[data-sort="lastTask"] button').click();
  await waitFor(async () => hashOf(page), "#roles?sort=lastTask&dir=asc", "a new column sorts ascending");
  await waitFor(() => order(page), ["architecture-advisor", "scout", "engineer", "tech-lead", "red-wide"], "oldest first, never-ran last");
  await page.locator('th[data-sort="lastTask"] button').click();
  await waitFor(async () => hashOf(page), "#roles?sort=lastTask&dir=desc", "the second click flips");
  await waitFor(() => order(page), ["tech-lead", "engineer", "scout", "architecture-advisor", "red-wide"], "newest first, never-ran still last");
  assert.deepEqual(await ariaSorts(page), { ...NONE, lastTask: "descending" });
  assert.equal(await page.locator('th[data-sort="lastTask"] .sort-glyph').textContent(), "▼");

  await page.locator('th[data-sort="profile"] button').click();
  await waitFor(async () => hashOf(page), "#roles?sort=profile&dir=asc", "profile ascending");
  await waitFor(() => order(page), ["architecture-advisor", "engineer", "red-wide", "scout", "tech-lead"], "legacy and unresolved profiles last, ties by name");
  assert.deepEqual(await ariaSorts(page), { ...NONE, profile: "ascending" });
  await page.locator('th[data-sort="profile"] button').click();
  await waitFor(async () => (await ariaSorts(page)).profile, "descending", "profile descending");
  await waitFor(() => order(page), ["red-wide", "engineer", "architecture-advisor", "scout", "tech-lead"], "descending by label; missing stays last, by name");

  assert.equal(rolesReads, 1, "sorting reorders the fetched payload; GET /api/roles was read once");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-828: a reload or a pasted link restores the sort", async () => {
  const { page, errors } = await open("#roles?sort=lastTask&dir=desc");
  for (let pass = 0; pass < 2; pass += 1) {
    assert.equal(hashOf(page), "#roles?sort=lastTask&dir=desc");
    await waitFor(() => order(page), ["tech-lead", "engineer", "scout", "architecture-advisor", "red-wide"], "row order");
    assert.deepEqual(await ariaSorts(page), { ...NONE, lastTask: "descending" });
    if (pass === 0) {
      await page.screenshot({ path: join(SHOTS, "fg828-roles-last-task-desc.png"), fullPage: true });
      await page.reload();
      await page.locator(".roles-table tbody tr").first().waitFor();
    }
  }
  await page.goto(`${baseUrl}/#roles?sort=mount&dir=asc`);
  await waitFor(() => order(page), ["architecture-advisor", "red-wide", "scout", "engineer", "tech-lead"], "read-only before read-write, ties by name");
  assert.deepEqual(await ariaSorts(page), { ...NONE, mount: "ascending" });
  await page.screenshot({ path: join(SHOTS, "fg828-roles-mount-asc.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-828: a header is reached by Tab and operated by Enter and Space (FG-692)", async () => {
  const { page, errors } = await open("#roles");
  await page.locator('th[data-sort="lastTask"] button').focus(); // FG-837: mount follows lastTask in the mock's order
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("th")?.getAttribute("data-sort") ?? null), "mount", "Tab moves to the next header button");
  await page.keyboard.press("Enter");
  await waitFor(async () => hashOf(page), "#roles?sort=mount&dir=asc", "Enter sorts");
  assert.deepEqual(await ariaSorts(page), { ...NONE, mount: "ascending" });
  await page.locator('th[data-sort="mount"] button').focus();
  await page.keyboard.press("Space");
  await waitFor(async () => hashOf(page), "#roles?sort=mount&dir=desc", "Space flips");
  await waitFor(() => order(page), ["engineer", "tech-lead", "architecture-advisor", "red-wide", "scout"], "row order");
  assert.deepEqual(await ariaSorts(page), { ...NONE, mount: "descending" });
  assert.equal(await page.evaluate(() => document.activeElement?.closest("th")?.getAttribute("data-sort") ?? null), "mount", "focus stays on the header");
  assert.equal(await page.locator('.roles-table tr[data-role="engineer"] a').getAttribute("href"), "#roles/engineer", "rows keep their links");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-828: an unknown column or dir falls back to role ascending without an error", async () => {
  const { page, errors } = await open("#roles?sort=bogus&dir=sideways");
  await waitFor(async () => hashOf(page), "#roles", "the unknown params are dropped from the hash");
  await waitFor(() => order(page), BY_ROLE, "row order");
  assert.deepEqual(await ariaSorts(page), { ...NONE, role: "ascending" });
  await page.goto(`${baseUrl}/#roles?sort=activity&dir=up`);
  await waitFor(async () => hashOf(page), "#roles?sort=activity", "a bad dir alone is dropped");
  await waitFor(() => order(page), ["engineer", "architecture-advisor", "tech-lead", "red-wide", "scout"], "activity ascending by default dir");
  assert.equal(await page.locator('[role="alert"]').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-828: mixed facts sort missing values last in both directions and break every tie by role", async () => {
  fixtureRoles = MIXED_ROLES;
  rolesReads = 0;
  const { page, errors } = await open("#roles");
  const expectations: Record<string, [string[], string[]]> = {
    role: [["alpha", "bravo", "charlie", "delta", "never", "no-activity", "unresolved"], ["unresolved", "no-activity", "never", "delta", "charlie", "bravo", "alpha"]],
    activity: [["alpha", "bravo", "charlie", "delta", "never", "unresolved", "no-activity"], ["never", "unresolved", "delta", "alpha", "bravo", "charlie", "no-activity"]],
    profile: [["alpha", "charlie", "bravo", "delta", "never", "no-activity", "unresolved"], ["no-activity", "never", "delta", "bravo", "alpha", "charlie", "unresolved"]],
    mount: [["bravo", "delta", "alpha", "charlie", "never", "no-activity", "unresolved"], ["alpha", "charlie", "never", "no-activity", "bravo", "delta", "unresolved"]],
    lastTask: [["charlie", "alpha", "bravo", "delta", "unresolved", "no-activity", "never"], ["no-activity", "unresolved", "delta", "alpha", "bravo", "charlie", "never"]],
  };

  for (const [column, [ascending, descending]] of Object.entries(expectations)) {
    if (column !== "role") await page.locator(`th[data-sort="${column}"] button`).click();
    await waitFor(() => order(page), ascending, `${column} ascending`);
    await page.locator(`th[data-sort="${column}"] button`).click();
    await waitFor(() => order(page), descending, `${column} descending`);
  }
  assert.equal(rolesReads, 1, "all header clicks sort the already fetched mixed payload");
  await page.screenshot({ path: join(SHOTS, "fg828-roles-mixed-last-task-desc.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
  fixtureRoles = ROLES;
});

test("FG-828: roles keeps only valid sort state, drops scope like Projects, and reaches Last task by keyboard at 400px", async () => {
  fixtureRoles = MIXED_ROLES;
  rolesReads = 0;
  const { page, errors } = await open("#roles?project=forge&checkout=%2Fproject%2Fworktree&sort=activity&dir=desc");
  await page.goto(`${baseUrl}/#projects?project=forge`);
  await waitFor(async () => hashOf(page), "#projects", "Projects drops scope parameters");
  const scopeFreeProjectsHash = hashOf(page);

  await page.goto(`${baseUrl}/#roles?project=forge&checkout=%2Fproject%2Fworktree&sort=activity&dir=desc`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  await waitFor(async () => hashOf(page), scopeFreeProjectsHash.replace("#projects", "#roles?sort=activity&dir=desc"), "Roles drops scope exactly like Projects while retaining valid sort state");
  await page.goto(`${baseUrl}/#roles?project=forge&checkout=%2Fproject%2Fworktree&sort=bogus&dir=sideways`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  await waitFor(async () => hashOf(page), scopeFreeProjectsHash.replace("#projects", "#roles"), "unknown sort and dir are dropped silently along with scope");
  await page.goto(`${baseUrl}/#roles?project=forge&sort=activity&dir=sideways`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  await waitFor(async () => hashOf(page), scopeFreeProjectsHash.replace("#projects", "#roles?sort=activity"), "a bad dir alone keeps a valid sort");

  const rolesReadsBeforeHeader = rolesReads;
  await page.locator('th[data-sort="activity"] button').click();
  await waitFor(async () => hashOf(page), scopeFreeProjectsHash.replace("#projects", "#roles?sort=activity&dir=desc"), "a header writes only sort and dir");
  assert.equal(rolesReads, rolesReadsBeforeHeader, "header sorting issues no request");

  await page.goto(`${baseUrl}/#runs?project=forge&checkout=%2Fproject%2Fworktree`);
  await waitFor(async () => hashOf(page), "#runs?project=forge", "the scope-bearing Runs route keeps the project; FG-843: the checkout rides only on Routing, Config and Notes");
  await page.goto(`${baseUrl}/#roles`);
  await page.locator(".roles-table tbody tr").first().waitFor();
  const rolesReadsBeforeKeyboard = rolesReads;

  await page.setViewportSize({ width: 400, height: 800 });
  await page.locator('th[data-sort="activity"] button').focus(); // FG-837: lastTask follows activity in the mock's order
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("th")?.getAttribute("data-sort") ?? null), "lastTask", "Tab reaches the Last task column");
  await page.keyboard.press("Space");
  await waitFor(async () => hashOf(page), "#roles?sort=lastTask&dir=asc", "Space sorts Last task at phone width");
  assert.deepEqual(await ariaSorts(page), { ...NONE, lastTask: "ascending" });
  await page.keyboard.press("Space");
  await waitFor(async () => (await ariaSorts(page)).lastTask, "descending", "Space flips aria-sort on Last task");
  assert.equal(rolesReads, rolesReadsBeforeKeyboard, "keyboard sorting never requests roles again");
  await page.screenshot({ path: join(SHOTS, "fg828-roles-last-task-keyboard-400.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
  fixtureRoles = ROLES;
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
      const candidate = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!existsSync(candidate)) {
        res.writeHead(404).end();
        return;
      }
      const filePath = realpathSync(candidate);
      if (!filePath.startsWith(`${CLIENT_DIR}/`)) {
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
      rolesReads += 1;
      json(fixtureRoles);
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
