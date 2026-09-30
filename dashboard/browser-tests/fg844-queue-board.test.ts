// FG-844: the Queue board is ONE row of lanes, one screen tall.
//
// Before this ticket `.queue-columns` was `repeat(auto-fit, minmax(280px, 1fr))` with no
// lane height bound, so six lanes wrapped into a second grid row that started below the
// ~55-card Queued lane — Blocked, Done and Executing sat at the bottom of a 12,353px page.
// The real client is booted against a fixture server whose queue carries a 200-card Queued
// lane (including a deliberately long title), an exactly-20-card Blocked lane and a
// 21-card Done lane, and this suite measures the rendered board: every lane
// header on one line at 1400, 1200 and 1000px with the document bounded by the viewport
// plus the controls above the board; the long lane scrolling inside itself while every
// other header stays put; compact cards past 20 that expand on focus, hover and an
// aria-expanded toggle; the under-900px lane strip with `#queue?lane=` round-tripping;
// and keyboard reach in DOM order through a focusable horizontal scroller.
//
// Screenshots go to a fresh temp dir unless FG844_SCREENSHOT_DIR names one.

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

const PORT = 18851;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG844_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg844-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const LANES = ["backlog", "queued", "in_progress", "blocked", "done", "executing_not_queued"];
const QUEUE_HASH = "#queue?project=atlas";

const TITLES = [
  "Add profile-aware findings to the review lens table",
  "Dashboard: cockpit object pages",
  "Orchestrator template restructure",
  "Per-model prompt overlays",
  "Detect a silent model switch on container dispatches",
  "forge init requires or derives a backlog prefix",
  "Operator-surface skills in the registry",
  "Container agents that arm a Monitor exit without result.json",
];

function queuePayload() {
  const rows: Record<string, unknown>[] = [];
  const views: Record<string, string[]> = Object.fromEntries(LANES.map((lane) => [lane, []]));
  let n = 100;
  const add = (view: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    const ticketId = `FG-${n}`;
    rows.push({
      ticketId,
      title: TITLES[n % TITLES.length],
      type: "story",
      status: "active",
      rank: view === "queued" ? views.queued!.length + 1 : null,
      queued: view === "queued" || view === "blocked",
      blocked: view === "blocked",
      inProgress: view === "in_progress",
      executionState: view === "in_progress" || view === "executing_not_queued" ? "running" : "idle",
      reservation: null,
      readiness: { outcome: "ready", stale: false },
      view,
      wait: null,
      ...extra,
    });
    views[view]!.push(ticketId);
  };
  for (let i = 0; i < 200; i += 1) {
    add("queued", i === 0
      ? { title: "The deliberately long Queue title must wrap inside its own compact card without moving any lane header " + "or widening the board beyond its horizontal scroller ".repeat(20) }
      : i === 1 ? { wait: { kind: "capacity", reason: "the ceiling is full", source: "dispatcher_evaluation", observedAt: null } } : {});
  }
  add("in_progress");
  for (let i = 0; i < 20; i += 1) {
    add("blocked", { wait: { kind: "blocker", reason: "depends on FG-456", source: "blocker_evidence", observedAt: null } });
  }
  for (let i = 0; i < 21; i += 1) add("done", { status: "done", readiness: null });
  add("executing_not_queued");
  return {
    projectKey: "atlas",
    storageMode: "db",
    queueAvailable: true,
    version: 7,
    rows,
    views,
    dispatcher: { state: "disarmed", armed: false, configured: true, maxActiveRuns: 1, capacityScope: "host", stateDetail: "" },
    capacity: { scope: "host", limit: 1, queueOwnedActive: 0, holders: [] },
    degraded: [],
    nowMs: Date.now(),
  };
}

let server: Server;
let browser: Browser;
const baseUrl = `http://127.0.0.1:${PORT}`;

before(async () => {
  const chromeBin = requireChrome("the dashboard browser tier");
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(PORT, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: chromeBin, headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function open(width: number, hash = QUEUE_HASH): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".queue-column-queued .queue-card").first().waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;

type Box = { lane: string; top: number; bottom: number; left: number; right: number };

async function laneHeaders(page: Page): Promise<Box[]> {
  return page.locator(".queue-column").evaluateAll((sections) =>
    sections.map((section) => {
      const r = section.querySelector(".queue-column-head")!.getBoundingClientRect();
      const lane = Array.from(section.classList).find((c) => c.startsWith("queue-column-") && c !== "queue-column-selected" && c !== "queue-column-compact")!;
      return { lane: lane.slice("queue-column-".length), top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }),
  );
}

test("FG-844 AC1: at 1400, 1200 and 1000px every lane header sits on one line and the page is one screen plus the controls", async () => {
  for (const width of [1400, 1200, 1000]) {
    const { page, errors } = await open(width);
    const headers = await laneHeaders(page);
    assert.deepEqual(headers.map((h) => h.lane), LANES, `${width}px: six lanes in board order`);
    for (const h of headers) {
      assert.ok(Math.abs(h.top - headers[0]!.top) < 0.5, `${width}px: ${h.lane}'s header top ${h.top} matches ${headers[0]!.top}`);
    }
    for (let i = 1; i < headers.length; i += 1) {
      assert.ok(headers[i]!.left >= headers[i - 1]!.right, `${width}px: ${headers[i]!.lane} sits right of ${headers[i - 1]!.lane}, never below it`);
      assert.ok(headers[i]!.top < headers[i - 1]!.bottom, `${width}px: ${headers[i]!.lane} is not below ${headers[i - 1]!.lane}`);
    }

    const layout = await page.evaluate(() => {
      const board = document.querySelector(".queue-columns")!;
      return {
        docHeight: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
        controls: board.getBoundingClientRect().top + window.scrollY,
        overflowX: getComputedStyle(board).overflowX,
        sideways: board.scrollWidth > board.clientWidth,
      };
    });
    assert.ok(layout.docHeight <= layout.viewport + layout.controls,
      `${width}px: document ${layout.docHeight}px exceeds viewport ${layout.viewport}px + controls ${layout.controls}px`);
    assert.equal(layout.overflowX, "auto", `${width}px: the board scrolls sideways inside itself`);
    assert.ok(layout.sideways, `${width}px: six 260px lanes are wider than the content, so the board scrolls rather than wraps`);

    await page.screenshot({ path: join(SHOTS, `fg844-board-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("FG-844 AC2: a 200-card lane scrolls inside itself while every other lane header stays visible", async () => {
  const { page, errors } = await open(1400);
  await page.locator(".queue-columns").evaluate((board) => board.scrollIntoView({ block: "start" }));
  const scroller = page.locator(".queue-column-queued .queue-lane-scroll");
  assert.equal(await page.locator(".queue-column-queued .queue-card").count(), 200);
  const dims = await scroller.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  assert.equal(dims.overflowY, "auto");
  assert.ok(dims.scroll > dims.client * 2, `the Queued lane scrolls internally (${dims.scroll} vs ${dims.client})`);

  const before = await laneHeaders(page);
  const windowScroll = await page.evaluate(() => window.scrollY);
  const vh = await page.evaluate(() => window.innerHeight);
  for (const h of before) assert.ok(h.top >= 0 && h.bottom <= vh, `${h.lane}'s header is on screen (${h.top}–${h.bottom})`);

  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const last = page.locator(".queue-column-queued .queue-card").last();
  const lastBox = (await last.boundingBox())!;
  const laneBox = (await scroller.boundingBox())!;
  assert.ok(lastBox.y + lastBox.height <= laneBox.y + laneBox.height + 1, "the 200th card is reachable inside the lane");

  const afterScroll = await laneHeaders(page);
  assert.deepEqual(afterScroll.map((h) => h.top), before.map((h) => h.top), "scrolling one lane moves no header");
  assert.equal(await page.evaluate(() => window.scrollY), windowScroll, "and does not scroll the page");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-844 AC2: 20 cards stay full, 21 cards go compact, and keyboard expansion does not reflow sibling lanes", async () => {
  const { page, errors } = await open(1400);
  const queued = page.locator(".queue-column-queued .queue-card");
  assert.equal(await page.locator(".queue-column-queued .queue-card-compact").count(), 200, "the 200-card lane is compact");
  assert.equal(await page.locator(".queue-column-done .queue-card-compact").count(), 21, "21 cards is compact");
  assert.equal(await page.locator(".queue-column-blocked .queue-card-compact").count(), 0, "exactly 20 cards keeps the full card");
  assert.equal(await page.locator(".queue-column-blocked .queue-card-detail").first().isVisible(), true);

  const second = queued.nth(1);
  assert.equal(await second.locator(".queue-card-detail").isVisible(), false, "a compact card hides its detail");
  assert.equal(await second.locator(".queue-card-status").innerText(), "active · At capacity", "and shows one status line");
  assert.match(await second.locator(".queue-card-id").innerText(), /FG-\d+/);
  assert.ok((await second.locator(".queue-card-title").innerText()).length > 0);

  await second.focus();
  assert.equal(await second.locator(".queue-card-detail").isVisible(), true, "focus expands it");
  assert.match(await second.locator(".queue-card-detail").innerText(), /the ceiling is full/, "to the full FG-591 card");
  await page.locator("#queue-enqueue-id").focus();
  assert.equal(await second.locator(".queue-card-detail").isVisible(), false, "and it collapses again when focus leaves");

  const done = page.locator(".queue-column-done .queue-card").nth(3);
  await done.scrollIntoViewIfNeeded();
  await done.hover();
  assert.equal(await done.locator(".queue-card-detail").isVisible(), true, "hover expands it");
  await page.mouse.move(0, 0);
  assert.equal(await done.locator(".queue-card-detail").isVisible(), false);

  const toggle = done.locator(".queue-card-toggle");
  const siblingBoxes = await page.locator(".queue-column:not(.queue-column-done)").evaluateAll((lanes) =>
    lanes.map((lane) => { const r = lane.getBoundingClientRect(); return [r.top, r.height]; }),
  );
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "the toggle announces its state");
  await page.locator("#queue-enqueue-id").focus();
  await page.mouse.move(0, 0);
  assert.equal(await done.locator(".queue-card-detail").isVisible(), true, "an expanded card stays expanded without focus or hover");
  assert.deepEqual(await page.locator(".queue-column:not(.queue-column-done)").evaluateAll((lanes) =>
    lanes.map((lane) => { const r = lane.getBoundingClientRect(); return [r.top, r.height]; }),
  ), siblingBoxes, "expanding one compact card changes only its lane's internal scroller, not sibling lane geometry");

  await page.screenshot({ path: join(SHOTS, "fg844-compact-expanded.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-844 AC3: at 899px the top lane strip composes with scope, and at 900px the full row returns", async () => {
  const { page, errors } = await open(899);
  const strip = page.getByRole("tablist", { name: "Queue lane" });
  await strip.waitFor();
  const visibleLanes = () => page.locator(".queue-column").evaluateAll((sections) =>
    sections.filter((s) => getComputedStyle(s).display !== "none").map((s) => s.id));
  assert.deepEqual(await visibleLanes(), ["queue-lane-queued"], "with no lane named, the first lane with cards (Backlog is empty)");
  assert.equal(await strip.getByRole("tab", { selected: true }).getAttribute("data-lane"), "queued");

  await strip.locator('[data-lane="blocked"]').click();
  await page.waitForFunction(() => location.hash.includes("lane=blocked"));
  await page.locator("#queue-lane-blocked").waitFor({ state: "visible" });
  assert.equal(hashOf(page), "#queue?project=atlas&lane=blocked");
  assert.deepEqual(await visibleLanes(), ["queue-lane-blocked"]);
  await page.screenshot({ path: join(SHOTS, "fg844-strip-800.png"), fullPage: true });

  await page.reload();
  await page.locator(".queue-column-blocked .queue-card").first().waitFor();
  assert.deepEqual(await visibleLanes(), ["queue-lane-blocked"], "the lane survives a reload");

  await strip.locator('[data-lane="blocked"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => location.hash.includes("lane=done"));
  await page.locator("#queue-lane-done").waitFor({ state: "visible" });
  assert.deepEqual(await visibleLanes(), ["queue-lane-done"], "arrow keys move along the strip");

  await page.goto(`${baseUrl}/#queue?project=atlas&lane=nope`);
  await page.locator(".queue-column-queued .queue-card").first().waitFor();
  await page.waitForFunction(() => !location.hash.includes("lane="));
  assert.equal(hashOf(page), "#queue?project=atlas", "an unknown lane is dropped from the hash");
  assert.deepEqual(await visibleLanes(), ["queue-lane-queued"], "and the board falls back to the first lane with cards");

  const box = (await page.locator(".queue-column-queued").boundingBox())!;
  assert.ok(box.width > 400, `the one lane fills the content width (${box.width}px)`);
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".queue-lane-strip")!).display === "none");
  assert.deepEqual(await page.locator(".queue-column").evaluateAll((lanes) =>
    lanes.filter((lane) => getComputedStyle(lane).display !== "none").map((lane) => lane.id),
  ), LANES.map((lane) => "queue-lane-" + lane), "at 900px every lane returns to the horizontal row");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-844 AC5: the horizontal scroller is focusable, and Tab reaches lanes and cards in DOM order past headers that hold no stop", async () => {
  const { page, errors } = await open(1200);
  const board = page.locator(".queue-columns");
  assert.equal(await board.getAttribute("tabindex"), "0");
  assert.equal(await board.getAttribute("aria-label"), "Queue lanes (scrolls sideways)");
  await board.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("queue-columns")), true);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".queue-columns")!.scrollLeft > 0);
  await board.evaluate((el) => { el.scrollLeft = 0; });
  assert.equal(await page.locator(".queue-column-head").evaluateAll((heads) =>
    heads.reduce((n, head) => n + head.querySelectorAll("a, button, input, select, [tabindex]").length, 0)), 0,
    "the sticky headers carry no focus stop");
  const firstCardAndHeader = await page.locator(".queue-column-queued").evaluate((lane) => {
    const header = lane.querySelector(".queue-column-head")!.getBoundingClientRect();
    const card = lane.querySelector(".queue-card")!.getBoundingClientRect();
    return { headerBottom: header.bottom, cardTop: card.top };
  });
  assert.ok(firstCardAndHeader.cardTop >= firstCardAndHeader.headerBottom,
    "the sticky header ends before the first card, so it cannot cover the first card");

  const seen: { lane: string; inHead: boolean; visible: boolean }[] = [];
  for (let i = 0; i < 700; i += 1) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const lane = el?.closest(".queue-column");
      if (!el || !lane) return null;
      const board = document.querySelector(".queue-columns")!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        lane: lane.id.replace("queue-lane-", ""),
        inHead: Boolean(el.closest(".queue-column-head")),
        visible: r.left >= board.left - 1 && r.right <= board.right + 1,
      };
    });
    if (!at) break;
    seen.push(at);
  }
  const order = seen.map((s) => s.lane).filter((lane, i, all) => all[i - 1] !== lane);
  assert.deepEqual(order, ["queued", "in_progress", "blocked", "done", "executing_not_queued"],
    "every lane with cards is reached once, in board order");
  assert.equal(seen.some((s) => s.inHead), false, "focus never lands in a header");
  assert.equal(seen.every((s) => s.visible), true, "the board scrolls sideways to keep the focused element in view");
  assert.ok(seen.length > 200 + 21, `every card is a stop (${seen.length})`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-844 AC1 stress: a long title and 200 cards keep every header aligned and the page bounded", async () => {
  const { page, errors } = await open(1000);
  const headers = await laneHeaders(page);
  assert.equal(await page.locator(".queue-column-backlog .queue-card").count(), 0, "the empty Backlog lane remains a peer in the row");
  assert.ok((await page.locator(".queue-column-queued .queue-card-title").first().innerText()).length > 900,
    "the stress fixture contains a long title");
  assert.ok(await page.locator(".queue-columns").evaluate((board) => board.scrollWidth > board.clientWidth),
    "the board scrolls sideways rather than wrapping");
  assert.ok(headers.every((header) => Math.abs(header.top - headers[0]!.top) < 0.5), "all lane headers share one top under stress");
  const layout = await page.evaluate(() => {
    const board = document.querySelector(".queue-columns")!;
    return { height: document.documentElement.scrollHeight, bound: innerHeight + board.getBoundingClientRect().top + scrollY };
  });
  assert.ok(layout.height <= layout.bound, "the stress page remains bounded by the viewport plus its controls");
  await page.screenshot({ path: join(SHOTS, "fg844-stress-1000.png"), fullPage: true });
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
    if (url.pathname === "/api/queue") {
      json(queuePayload());
      return;
    }
    if (url.pathname === "/api/projects") {
      json([{ key: "atlas", label: "Atlas", color: "#345", classification: "independent", checkouts: [{ projectDir: "/repos/atlas", branch: "main", exists: true }] }]);
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
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
