// FG-819: the Home lists hold their order while an operator reads them.
//
// The Attention inbox and In flight both re-read every 2s, and the server re-ranks on
// every read, so rows used to jump under the reader mid-sentence. The real client is
// booted against a fixture server whose ranking this test rewrites between polls; the
// rows must keep the order first shown (new rows appended, never interleaved) until one
// of the three boundaries — an idle stretch with no pointer/keyboard activity over the
// list, the tab coming back from hidden, or a manual Refresh — and then adopt the
// server's order.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import { ORDER_PIN_IDLE_MS } from "../client/order-pin-render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG819_SCREENSHOT_DIR ?? join(tmpdir(), "fg819-screenshots");
mkdirSync(SHOTS, { recursive: true });

const KINDS: Record<string, string> = {
  A: "stale_verification",
  B: "kanban_conflict",
  C: "waiting_gate",
  D: "merge_conflict",
  E: "campaign_paused",
  F: "blocked_by_red_or_reviewer",
  G: "missing_acceptance_or_readiness",
  H: "auth_setup",
  I: "integration_blocked_park",
  U: "future_kind_from_a_newer_host",
};

const KNOWN_INBOX_KINDS = [
  ["A", "stale_verification", "Stale verification"],
  ["B", "kanban_conflict", "Kanban conflict"],
  ["C", "waiting_gate", "Waiting on gate"],
  ["D", "merge_conflict", "Merge conflict"],
  ["E", "campaign_paused", "Campaign paused"],
  ["F", "blocked_by_red_or_reviewer", "Blocked by review"],
  ["G", "missing_acceptance_or_readiness", "Readiness gap"],
  ["H", "auth_setup", "Auth / setup"],
  ["I", "integration_blocked_park", "Integration parked"],
] as const;

function inboxItem(id: string) {
  return {
    id: `att-${id}`,
    kind: KINDS[id] ?? "waiting_gate",
    severity: "medium",
    startedAt: "2026-09-28T10:00:00.000Z",
    reason: `reason-${id}`,
    requestedAction: `act on ${id}`,
    openState: "open",
    source: "fixture",
    links: { runId: `run-${id}`, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
  };
}

function inFlightTask(id: string) {
  return {
    taskId: `task-${id}`,
    runId: `run-${id}`,
    runTitle: `run ${id}`,
    workflow: "feature",
    phase: "build",
    agentRole: "engineer",
    agentModel: null,
    status: "running",
    startedAt: "2026-09-28T10:00:00.000Z",
    projectDir: "/repos/forge",
    projectLabel: "forge",
    orchestrator: null,
    reconcile: null,
  };
}

let inboxRank: string[] = [];
let inFlightRank: string[] = [];

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function inboxOrder(page: Page): Promise<string[]> {
  const reasons = await page.locator("section.attention-inbox .inbox-reason").allInnerTexts();
  return reasons.map((r) => r.replace(/^reason-/, ""));
}

async function inFlightOrder(page: Page): Promise<string[]> {
  const rows = await page.locator("section.home-view section.in-flight .item").allInnerTexts();
  return rows.flatMap((text) => {
    const m = text.match(/task-([A-Z])/);
    return m ? [m[1]!] : [];
  });
}

async function waitForOrder(read: () => Promise<string[]>, expected: string[], what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(last, expected, `${what} never reached the expected order`);
}

/** Two full poll cycles in real time: long enough that a re-ranked read has landed and
 *  rendered, so an unchanged order afterwards is the pin holding, not a read not yet
 *  arrived. */
async function letPollsLand(page: Page, sentinel: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await sentinel())) {
    assert.ok(Date.now() < deadline, "the re-ranked read never landed");
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(4500);
}

async function openHome(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto(`${baseUrl}/`);
  await page.locator("section.home-view").waitFor();
  return page;
}

test("FG-819: every store kind renders through /api/attention-inbox with its own badge, while a future kind stays forward-tolerant", async () => {
  // The real browser goes through the dashboard's normal polling route. The fixture is shaped
  // exactly like the store route's public envelope so this exercises parsing, pinning and DOM
  // rendering together rather than just KIND_META as a unit.
  inboxRank = [...KNOWN_INBOX_KINDS.map(([id]) => id), "U"];
  inFlightRank = ["A", "B"];
  const page = await openHome();
  await waitForOrder(() => inboxOrder(page), inboxRank, "inbox");
  for (const [, kind, label] of KNOWN_INBOX_KINDS) {
    const badge = page.locator(`.badge.inbox-kind-${kind}`);
    assert.equal(await badge.count(), 1, `${kind} has one real browser row`);
    assert.equal(await badge.innerText(), label, `${kind} keeps its operator label`);
  }
  const stale = page.locator(".badge.inbox-kind-stale_verification");
  const unknown = page.locator(".badge.inbox-kind-unknown");
  assert.equal(await unknown.count(), 1, "a future server kind is rendered instead of rejecting the whole inbox");
  assert.equal(await unknown.innerText(), KINDS.U, "the future kind remains intelligible to the operator");
  const staleColor = await stale.evaluate((el) => getComputedStyle(el).color);
  const unknownColor = await unknown.evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(staleColor, unknownColor, "the new kinds carry a toned rule, not the neutral one");
  await page.locator("section.attention-inbox").screenshot({ path: join(SHOTS, "fg819-inbox-all-badges.png") });
  await page.close();
});

test("FG-819: a re-ranked read does not reorder rows mid-read; the idle boundary re-sorts", async () => {
  inboxRank = ["A", "B", "C"];
  inFlightRank = ["A", "B", "C"];
  const page = await openHome();
  await waitForOrder(() => inboxOrder(page), ["A", "B", "C"], "inbox");
  await waitForOrder(() => inFlightOrder(page), ["A", "B", "C"], "in flight");

  // The server re-ranks and adds a row. D lands at the END; A/B/C hold their slots.
  inboxRank = ["C", "B", "A", "D"];
  inFlightRank = ["C", "B", "A", "D"];
  await letPollsLand(page, async () => (await inboxOrder(page)).includes("D") && (await inFlightOrder(page)).includes("D"));
  assert.deepEqual(await inboxOrder(page), ["A", "B", "C", "D"], "inbox order held across polls");
  assert.deepEqual(await inFlightOrder(page), ["A", "B", "C", "D"], "in-flight order held across polls");

  // Activity over the list postpones the idle boundary: most of the window passes, the
  // operator moves over the inbox, most of the window passes again — still pinned.
  await page.clock.fastForward(ORDER_PIN_IDLE_MS - 20_000);
  await page.locator("section.attention-inbox .inbox-list").hover();
  await page.mouse.move(400, 300);
  await page.locator("section.attention-inbox .inbox-list").hover({ position: { x: 20, y: 20 } });
  // FG-692's companion contract: keyboard activity inside the list is reader activity too.
  // Focus a real row link, then use the keyboard rather than manufacturing a DOM event.
  await page.locator("section.attention-inbox .inbox-link").first().focus();
  assert.equal(await page.evaluate(() => document.activeElement?.className), "inbox-link");
  await page.keyboard.press("ArrowDown");
  await page.clock.fastForward(ORDER_PIN_IDLE_MS - 20_000);
  await page.waitForTimeout(2500);
  assert.deepEqual(await inboxOrder(page), ["A", "B", "C", "D"], "activity over the inbox kept it pinned");
  // In flight saw no activity over it, so its window already elapsed.
  await waitForOrder(() => inFlightOrder(page), ["C", "B", "A", "D"], "in flight after its idle window");

  // Idle for the full window: the inbox adopts the server order too.
  await page.clock.fastForward(ORDER_PIN_IDLE_MS);
  await waitForOrder(() => inboxOrder(page), ["C", "B", "A", "D"], "inbox after its idle window");
  await page.close();
});

test("FG-819: the tab coming back from hidden re-sorts", async () => {
  inboxRank = ["A", "B", "C"];
  inFlightRank = ["A", "B", "C"];
  const page = await openHome();
  await waitForOrder(() => inboxOrder(page), ["A", "B", "C"], "inbox");
  await waitForOrder(() => inFlightOrder(page), ["A", "B", "C"], "in flight");

  inboxRank = ["B", "C", "A"];
  inFlightRank = ["B", "C", "A"];
  await page.waitForTimeout(4500);
  assert.deepEqual(await inboxOrder(page), ["A", "B", "C"]);
  assert.deepEqual(await inFlightOrder(page), ["A", "B", "C"]);

  // A string, not a closure: tsx's esbuild transform would wrap the getter in a `__name`
  // helper the page does not have.
  await page.evaluate(`(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get() { return state; } });
    document.dispatchEvent(new Event("visibilitychange"));
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  await waitForOrder(() => inboxOrder(page), ["B", "C", "A"], "inbox after the tab returned");
  await waitForOrder(() => inFlightOrder(page), ["B", "C", "A"], "in flight after the tab returned");
  await page.close();
});

test("FG-819: a manual Refresh re-sorts, and is a keyboard-reachable button", async () => {
  inboxRank = ["A", "B", "C"];
  inFlightRank = ["A", "B", "C"];
  const page = await openHome();
  await waitForOrder(() => inboxOrder(page), ["A", "B", "C"], "inbox");
  await waitForOrder(() => inFlightOrder(page), ["A", "B", "C"], "in flight");

  inboxRank = ["C", "A", "B"];
  inFlightRank = ["C", "A", "B"];
  await page.waitForTimeout(4500);
  assert.deepEqual(await inboxOrder(page), ["A", "B", "C"]);
  assert.deepEqual(await inFlightOrder(page), ["A", "B", "C"]);

  const inboxRefresh = page.getByRole("button", { name: "Refresh and re-sort the attention inbox" });
  await inboxRefresh.focus();
  await page.keyboard.press("Enter");
  await waitForOrder(() => inboxOrder(page), ["C", "A", "B"], "inbox after Refresh");
  assert.deepEqual(await inFlightOrder(page), ["A", "B", "C"], "the inbox Refresh does not re-sort In flight");

  await page.getByRole("button", { name: "Refresh and re-sort in-flight tasks" }).click();
  await waitForOrder(() => inFlightOrder(page), ["C", "A", "B"], "in flight after Refresh");
  await page.close();
});

test("FG-819: a manual Refresh adopts the order its own re-read fetched, not the order already held", async () => {
  inboxRank = ["A", "B", "C"];
  inFlightRank = ["A", "B", "C"];
  const page = await openHome();
  await waitForOrder(() => inboxOrder(page), ["A", "B", "C"], "inbox");
  await waitForOrder(() => inFlightOrder(page), ["A", "B", "C"], "in flight");

  // Freeze the page clock so no interval poll can deliver the re-ranked read: the only
  // read that sees the new ranking is the one the Refresh itself triggers.
  const pageNow = Number(await page.evaluate("Date.now()"));
  await page.clock.pauseAt(pageNow + 100);
  inboxRank = ["C", "A", "B"];
  inFlightRank = ["C", "A", "B"];

  await page.getByRole("button", { name: "Refresh and re-sort in-flight tasks" }).click();
  await waitForOrder(() => inFlightOrder(page), ["C", "A", "B"], "in flight after Refresh fetched the new ranking");

  await page.getByRole("button", { name: "Refresh and re-sort the attention inbox" }).click();
  await waitForOrder(() => inboxOrder(page), ["C", "A", "B"], "inbox after Refresh fetched the new ranking");
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
        : filePath.endsWith(".png") ? "image/png"
          : filePath.endsWith(".svg") ? "image/svg+xml"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/attention-inbox") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        generatedAt: new Date().toISOString(),
        scope: { runId: null, projectDirs: null },
        items: inboxRank.map(inboxItem),
        empty: inboxRank.length === 0,
        degraded: [],
      }));
      return;
    }
    if (url.pathname === "/api/in-flight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inFlightRank.map(inFlightTask)));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
