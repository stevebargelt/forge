// FG-838 — list views render their title and live state only; the static three-answer
// contract (FG-821) sits behind a 20px "?" beside the title. Hover or focus shows a
// tooltip; click/Enter/Space opens a popover (announced as a dialog, focus moved in)
// with the three answers and the CLI verb with a Copy button; Escape closes it and
// returns focus; a click outside closes it. The Roles list's Source caption is a footer
// under the table, not a line between the title and the content.
//
// A fixture HTTP server serves the real shell + client bundle and canned reads.
// Screenshots go to a fresh temp dir unless FG838_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { listHeader } from "../client/screen-header-render.js";
import { ROUTES } from "../client/view-routing.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18839;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG838_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg838-screenshots-"));
if (process.env.FG838_SCREENSHOT_DIR) mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas";
const HOME = listHeader("home")!;

let server: Server;
let browser: Browser;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function open(hash: string, width = 1200): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  // The clipboard is stubbed so Copy is observable without a permission prompt.
  await page.addInitScript(`window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copied.push(text); return Promise.resolve(); } } });`);
  await page.goto(`${BASE}/${hash}`);
  await page.locator(".page-head .page-title").waitFor();
  return page;
}

const button = (page: Page) => page.locator(".page-head .info-tip-button");
const popover = (page: Page) => page.locator(".page-head .info-tip-popover");
const focusedIs = (page: Page, selector: string) => page.evaluate((s) => document.activeElement === document.querySelector(s), selector);

/** Everything visible between the page head and the first piece of content. */
async function linesUnderTitle(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const head = document.querySelector("main .page-head");
    const out: string[] = [];
    for (let el = head?.nextElementSibling; el && el.classList.contains("screen-line"); el = el.nextElementSibling) out.push(el.textContent?.trim() ?? "");
    return out;
  });
}

test("FG-838: Home renders its title with no static line; the ? beside it is a 20px button with a hover tooltip", async () => {
  const page = await open("#home");
  await button(page).waitFor();
  assert.deepEqual(await linesUnderTitle(page), [], "nothing under Home's title");
  assert.equal(await page.locator("main .screen-line").count(), 0);
  assert.equal(await page.locator("main").getByText(HOME.needs).isVisible(), false, "the contract is not on screen until asked for");
  const box = await button(page).boundingBox();
  assert.equal(Math.round(box!.width), 20);
  assert.equal(Math.round(box!.height), 20);
  assert.equal(await button(page).getAttribute("aria-label"), "About Home");
  assert.equal(await button(page).getAttribute("aria-expanded"), "false");
  assert.equal(await popover(page).isVisible(), false);
  const tipId = await button(page).getAttribute("aria-describedby");
  const tip = page.locator(`#${tipId}`);
  assert.equal(await tip.getAttribute("role"), "tooltip");
  assert.equal(await tip.isVisible(), false);
  await button(page).hover();
  await tip.waitFor({ state: "visible" });
  assert.equal((await tip.textContent())?.trim(), HOME.happening);
  await page.screenshot({ path: join(SHOTS, "home-after.png") });
  await page.close();
});

test("FG-838: the popover opens by keyboard, is announced as a dialog, closes on Escape with focus back on the ?", async () => {
  const page = await open("#home");
  await button(page).focus();
  await page.keyboard.press("Enter");
  await popover(page).waitFor({ state: "visible" });
  assert.equal(await button(page).getAttribute("aria-expanded"), "true");
  assert.equal(await button(page).getAttribute("aria-controls"), await popover(page).getAttribute("id"));
  assert.equal(await popover(page).getAttribute("role"), "dialog");
  assert.equal(await popover(page).getAttribute("aria-label"), "About Home");
  assert.ok(await focusedIs(page, ".page-head .info-tip-popover"), "focus moves into the popover so it is announced");
  const text = await popover(page).innerText();
  for (const part of [HOME.happening, HOME.needs, HOME.todo, HOME.verb!]) assert.ok(text.includes(part), `the popover states "${part}"`);
  assert.equal(await popover(page).locator("code").textContent(), HOME.verb);
  await page.screenshot({ path: join(SHOTS, "home-popover-open.png") });

  await page.keyboard.press("Escape");
  await popover(page).waitFor({ state: "hidden" });
  assert.equal(await button(page).getAttribute("aria-expanded"), "false");
  assert.ok(await focusedIs(page, ".page-head .info-tip-button"), "Escape returns focus to the ?");
  assert.equal(new URL(page.url()).hash.startsWith("#home") || new URL(page.url()).hash === "", true, "Escape did not navigate");

  await page.keyboard.press("Space");
  await popover(page).waitFor({ state: "visible" });
  await page.mouse.click(1100, 800);
  await popover(page).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelector(".page-head .info-tip-button"), undefined, { timeout: 2000 }).catch(() => {});
  assert.ok(await focusedIs(page, ".page-head .info-tip-button"), "a click outside returns focus to the ?");
  await button(page).click();
  await popover(page).waitFor({ state: "visible" });
  await button(page).click();
  await popover(page).waitFor({ state: "hidden" });
  await page.close();
});

test("FG-838: Copy in the popover copies the verb, reachable by Tab", async () => {
  const page = await open("#home");
  await button(page).focus();
  await page.keyboard.press("Enter");
  await popover(page).waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  assert.ok(await focusedIs(page, ".page-head .info-tip-copy"), "Tab reaches Copy");
  assert.equal(await page.locator(".info-tip-copy").getAttribute("aria-label"), `Copy ${HOME.verb}`);
  await page.keyboard.press("Enter");
  await page.locator(".info-tip-copy", { hasText: "Copied" }).waitFor();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied), [HOME.verb]);
  await page.close();
});

test("FG-838: Backlog, Roles and Ops carry no static line; each has its own tip; Runs shows only its live count; Roles' Source is a footer", async () => {
  for (const [view, label] of [["backlog", "Backlog"], ["roles", "Roles"], ["ops", "Ops"]] as const) {
    const page = await open(`#${view}?project=atlas`);
    await button(page).waitFor();
    assert.deepEqual(await linesUnderTitle(page), [], `nothing under ${view}'s title`);
    const header = listHeader(view)!;
    assert.equal(await page.getByText(`${header.happening} · ${header.needs}`).count(), 0, `${view}'s old line is gone`);
    assert.equal(await button(page).getAttribute("aria-label"), `About ${label}`);
    await button(page).click();
    await popover(page).waitFor({ state: "visible" });
    assert.ok((await popover(page).innerText()).includes(header.todo), `${view}'s tip holds its own contract`);
    if (view === "roles") {
      await page.keyboard.press("Escape");
      await page.locator(".roles-table").waitFor();
      const order = await page.evaluate(() => {
        const table = document.querySelector(".roles-table")!;
        const caption = document.querySelector("[data-caption='roles']")!;
        return table.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before";
      });
      assert.equal(order, "after", "the Source caption is under the table");
      assert.match((await page.locator("[data-caption='roles']").textContent()) ?? "", /^Source: \/h\/agents/);
      await page.screenshot({ path: join(SHOTS, "roles-list-header.png") });
    }
    await page.close();
  }
  const runs = await open("#runs?project=atlas");
  await runs.locator("main .screen-line").waitFor();
  assert.deepEqual(await linesUnderTitle(runs), ["2 runs are active"]);
  await runs.close();
});

test("FG-838: at 400px the ? sits beside the title and the open popover fits the viewport", async () => {
  const page = await open("#home", 400);
  await button(page).waitFor();
  const title = await page.locator(".page-head .page-title").boundingBox();
  const b = await button(page).boundingBox();
  assert.ok(Math.abs((b!.y + b!.height / 2) - (title!.y + title!.height / 2)) < 16, "the ? is on the title's line");
  await button(page).click();
  await popover(page).waitFor({ state: "visible" });
  const pop = await popover(page).boundingBox();
  assert.ok(pop!.x >= 0 && pop!.x + pop!.width <= 400, `the popover fits 400px (${pop!.x}..${pop!.x + pop!.width})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 400), true, "no horizontal scroll");
  await page.screenshot({ path: join(SHOTS, "home-400-popover.png") });
  await page.close();
});

test("FG-838: every FG-820 list route has exactly one tip with its own contract and no static guidance line", async () => {
  const listRoutes = Object.entries(ROUTES).filter(([, route]) => route.object !== "required");
  assert.ok(listRoutes.length > 0, "the FG-820 route table supplies the cases; this test must not hand-list views");
  for (const [view] of listRoutes) {
    const header = listHeader(view)!;
    assert.ok(header, `${view} is a list view with a LIST_HEADERS contract`);
    const page = await open(`#${view}?project=atlas&checkout=${encodeURIComponent(MAIN)}`);
    const tips = page.locator(".page-head .info-tip-button");
    assert.equal(await tips.count(), 1, `${view} has exactly one info-tip button`);
    const lines = await page.locator("main .screen-line").allTextContents();
    assert.ok(lines.every((line) => ![header.happening, header.needs, header.todo, header.verb!].every((part) => line.includes(part))),
      `${view} has no static three-answer guidance line`);
    await tips.click();
    await popover(page).waitFor({ state: "visible" });
    const text = await popover(page).innerText();
    for (const part of [header.happening, header.needs, header.todo, header.verb!]) assert.ok(text.includes(part), `${view}'s popover contains ${part}`);
    assert.equal(await popover(page).locator("code[data-verb]").textContent(), header.verb, `${view}'s popover retains its CLI verb`);
    await page.close();
  }
});

test("FG-838: mixed object payloads retain live failure, gate, active-run and open-review facts without static filler", async () => {
  const cases: Array<[string, string]> = [
    ["#task/task-failed", "engineer is failed (merge_conflict) · Needs you: it failed"],
    ["#task/task-gate", "engineer is awaiting a gate · Needs you: a gate decision"],
    ["#run/run-active", "Run active · Nothing needs you"],
    ["#reviews/review-open", "Review review-open is awaiting disposition · Needs you until it settles · fix and recheck 1 finding"],
  ];
  for (const [hash, expected] of cases) {
    const page = await open(hash);
    const line = page.locator("main .screen-line").filter({ hasText: expected });
    await line.waitFor();
    assert.ok((await line.innerText()).includes(expected), `${hash} keeps its payload-derived header fact`);
    assert.doesNotMatch(await line.innerText(), /What (?:is happening|needs you)|Does it need me|What do I do|listed below|A seed changes only/, `${hash} has no static filler`);
    assert.equal(await page.locator(".object-head .info-tip-button").count(), 0, `${hash} remains an object header, not a list tip`);
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
      if (!filePath.startsWith(`${CLIENT_DIR}/`) || !existsSync(filePath) || !realpathSync(filePath).startsWith(`${CLIENT_DIR}/`)) {
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
    if (url.pathname === "/api/attention-inbox") {
      json({ generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null }, items: [], empty: true, degraded: [], counts: { open: 0, high: 0 } });
      return;
    }
    if (url.pathname === "/api/projects") {
      json([{ key: "atlas", label: "Atlas", color: "#345", classification: "independent", checkouts: [{ projectDir: MAIN, branch: "main", exists: true }] }]);
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
    if (url.pathname === "/api/runs") {
      json({ runs: [], activeCount: 2, nextCursor: null });
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]!);
      const failed = taskId === "task-failed";
      const gate = taskId === "task-gate";
      if (failed || gate) {
        json({
          task: { taskId, runId: failed ? "run-failed" : "run-gate", runTitle: "Mixed fixture", projectDir: MAIN, agentRole: "engineer", status: failed ? "failed" : "awaiting_gate", phase: "build", completedAt: null, durationMs: 0, result: null },
          links: { runId: failed ? "run-failed" : "run-gate", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] },
          stdoutLog: null, stderrLog: null, stdoutBytes: 0, stderrBytes: 0, verdicts: [], gates: [], events: [], failureKind: failed ? "merge_conflict" : null, idle: null, resultSizeBytes: 0,
        });
        return;
      }
    }
    const runMap = url.pathname.match(/^\/api\/run\/([^/]+)\/map$/);
    if (runMap && decodeURIComponent(runMap[1]!) === "run-active") {
      json({ version: 1, run: { runId: "run-active", title: "Active mixed run", status: "active", projectDir: MAIN }, workflowResolved: true, phases: [], edges: [], nodes: [], fanoutGroups: [], redAttachments: [], warnings: [] });
      return;
    }
    const runEvidence = url.pathname.match(/^\/api\/run\/([^/]+)\/evidence$/);
    if (runEvidence && decodeURIComponent(runEvidence[1]!) === "run-active") {
      json({ runId: "run-active", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] });
      return;
    }
    const reviewMatch = url.pathname.match(/^\/api\/review\/([^/]+)$/);
    if (reviewMatch && decodeURIComponent(reviewMatch[1]!) === "review-open") {
      json({ id: "review-open", runId: "run-active", subjectTaskId: "task-failed", ticketId: null, projectDir: MAIN, state: "awaiting_disposition", riskLenses: [], countsByDisposition: {}, countsByResolution: {}, findings: [{ id: "finding-1", findingRef: "RF-1", severity: "high", disposition: "fix_now", resolution: null, summary: "Open mixed finding", sources: [] }] });
      return;
    }
    if (url.pathname === "/api/backlog") {
      json({ notes: "", notesByCheckout: [], ticketsProjectKey: "atlas", ticketsStorageMode: "db", tickets: [{ id: "FG-1", type: "story", status: "active", title: "One", body: "", epic: null }] });
      return;
    }
    if (url.pathname === "/api/roles") {
      json({
        agentsDir: "/h/agents",
        generation: { id: "gen-1" },
        seedInstall: { kind: "published" },
        modelPolicy: { path: "/h/model-policy.yml", source: "file" },
        storeError: null,
        roles: [{ role: "engineer", description: "Implements.", defaultActivity: "default", profile: "claude-subscription", model: "claude-sonnet-5", effort: null, resolvedBy: "defaults.profile", resolutionError: null, mountMode: "rw", mountModeSource: "blue", settings: true, protocolSha: null, lastTaskAt: null }],
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
