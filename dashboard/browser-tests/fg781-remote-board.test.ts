// FG-781 (step 5) — the Remote Board's focused UI, driven in a REAL Chrome (dashboard_browser
// tier). It serves the real remote shell (renderRemoteShell) under the real remote CSP and the
// real dashboard/remote-client/board.js, and STUBS /api/board with each of the five projection
// envelope states in turn. That isolates the AC5 claim to the client: does board.js render the
// five distinct states HONESTLY — never painting cached/stale data as live — responsively on a
// phone and a desktop, keyboard- and screen-reader-navigable, with no active agent session?
//
// It deliberately does NOT stand up the real remote server or a DB: identity fail-closed / no
// mutation / mode-disabled are step 3's server integration tests (AC1/AC2/AC6/AC7). Here the
// envelope is the fixture, so all five states — including the two that need real project data —
// are reachable deterministically.
//
// Needs Chrome; since FG-642 it gets one everywhere the tier runs. A Chrome-less environment
// FAILS the `before` precondition (requireChrome) — it never skips to green. Registered in
// src/util/browser-tier-census.ts so the FG-642 guards move with it.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import {
  REMOTE_BOARD_ENDPOINT,
  REMOTE_CLIENT_URL_PREFIX,
  remoteContentSecurityPolicy,
  remoteCspNonce,
  renderRemoteShell,
} from "../src/remote/shell.js";
import type { RemoteBoard, RemoteBoardEnvelope, RemoteBoardState } from "../src/remote/projection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE_CLIENT_DIR = resolve(HERE, "..", "remote-client");

// ─── fixtures: a full project-scoped board, and one envelope per state ────────────

// A board with real content in every section, and — deliberately — NO active agent session
// (hasLiveWork:false, agents:[]), so the "needs no agent session" case is the default fixture.
function sampleBoard(): RemoteBoard {
  return {
    projectSummary: {
      projectKey: "forge",
      label: "forge",
      color: "#7dd3fc",
      description: "the forge CLI",
      lastRunAt: "2026-09-08T12:00:00.000Z",
      runCount: 42,
      inFlightCount: 1,
      liveSessions: 0,
    },
    backlog: {
      projectKey: "forge",
      storageMode: "db",
      tickets: [
        { id: "FG-781", type: "story", status: "active", title: "Remote Board foundation", epic: "FG-780", created: "2026-09-01", closed: null, related: [] },
        { id: "FG-782", type: "story", status: "queued", title: "Tailscale Serve adapter", epic: "FG-780", created: "2026-09-02", closed: null, related: [] },
      ],
    },
    queue: {
      projectKey: "forge",
      storageMode: "db",
      queueAvailable: true,
      unavailableReason: null,
      version: 7,
      rows: [
        { ticketId: "FG-781", title: "Remote Board foundation", type: "story", status: "active", rank: 1, queued: true, blocked: false, inProgress: true, executionState: "running", view: "in_progress", waitKind: null },
        { ticketId: "FG-783", title: "Planning mutation capability", type: "story", status: "blocked", rank: 2, queued: false, blocked: true, inProgress: false, executionState: "idle", view: "blocked", waitKind: "dependency" },
      ],
      views: { backlog: [], queued: ["FG-782"], in_progress: ["FG-781"], blocked: ["FG-783"], done: [], executing_not_queued: [] },
    },
    campaigns: [
      { campaignId: "camp-1", goal: "Ship the remote board epic", mode: "auto", status: "running", verdict: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", counts: { shipped: 3, blocked: 1, held: 0, skipped: 0, failed: 0, total: 5 }, currentItem: { ticketId: "FG-781", title: "Remote Board foundation" } },
    ],
    inbox: {
      generatedAt: "2026-09-08T12:00:00.000Z",
      items: [
        { id: "att-1", kind: "gate", severity: "high", startedAt: "2026-09-08T11:00:00.000Z", reason: "A run is awaiting a human gate", requestedAction: "Review and advance", source: "pipeline", links: { runId: "run-1", taskId: "task-1", ticketId: "FG-781", campaignId: null, itemId: null } },
      ],
      empty: false,
      degraded: [],
    },
    activity: {
      generatedAt: "2026-09-08T12:00:00.000Z",
      agents: [],
      counts: { agents: 0, hostVerifications: 0, launches: 0, ciWaits: 0, operatorWaits: 0 },
      requiredCiState: "none",
      hasLiveWork: false,
    },
  };
}

function envelope(state: RemoteBoardState, withBoard: boolean): RemoteBoardEnvelope {
  return {
    state,
    generatedAt: "2026-09-08T12:00:00.000Z",
    generation: 1_757_332_800_000,
    board: withBoard ? sampleBoard() : null,
  };
}

const STATUS_FOR: Record<RemoteBoardState, number> = {
  live: 200,
  stale: 200,
  unauthorized: 401,
  "host-unavailable": 503,
  unsupported: 501,
};

// The response the stub /api/board returns, mutated per test before navigating/refreshing.
let boardEnvelope: RemoteBoardEnvelope = envelope("live", true);

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

// ─── the five states ──────────────────────────────────────────────────────────────

test("renders the LIVE state: the project board with a live marker (not stale)", async () => {
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 1280, height: 1000 });

  const banner = page.locator('[data-state="live"]');
  await banner.waitFor();
  assert.match(await banner.locator(".rb-state-label").innerText(), /Live/);
  assert.doesNotMatch((await banner.innerText()).toLowerCase(), /not live|stale/, "the live banner must not describe itself as stale");

  // The project-scoped board is present.
  assert.ok((await page.getByRole("heading", { level: 2, name: "Project" }).count()) === 1);
  await assert.doesNotReject(page.getByText("Remote Board foundation").first().waitFor());
  await page.close();
});

test("renders the STALE state as explicitly NOT live — cached data is never painted as live", async () => {
  // First a live read, then a stale read via Refresh: the flip must be honest, not sticky.
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 1280, height: 1000 });
  await page.locator('[data-state="live"]').waitFor();

  boardEnvelope = envelope("stale", true);
  await page.getByRole("button", { name: "Refresh the board" }).click();

  const stale = page.locator('[data-state="stale"]');
  await stale.waitFor();
  // The board data is still shown (a stale board is useful) — but the banner says NOT live,
  // and NO live marker survives the transition.
  assert.match((await stale.innerText()).toLowerCase(), /not live/, "a stale board must state that it is not live");
  assert.equal(await page.locator('[data-state="live"]').count(), 0, "the live marker must not persist once the read is stale");
  assert.equal(await page.locator(".rb-state--live").count(), 0, "no residual live styling after a stale read");
  await assert.doesNotReject(page.getByRole("heading", { level: 2, name: "Project" }).waitFor());
  await page.close();
});

test("renders each refusal state (host-unavailable / unauthorized / unsupported) with NO project data", async () => {
  for (const state of ["host-unavailable", "unauthorized", "unsupported"] as const) {
    boardEnvelope = envelope(state, false);
    const page = await open({ width: 1280, height: 1000 });
    await page.locator(`[data-state="${state}"]`).waitFor();

    // A refusal renders a message region and NOT a single project card — no leaked payload.
    assert.equal(await page.locator(".rb-refusal").count(), 1, `${state} shows a refusal region`);
    assert.equal(await page.locator(".rb-card").count(), 0, `${state} must render no project card`);
    assert.equal(await page.getByText("Remote Board foundation").count(), 0, `${state} must not leak any board content`);
    await page.close();
  }
});

// ─── accessibility ──────────────────────────────────────────────────────────────

test("is screen-reader navigable: landmark, heading hierarchy, and a status live region", async () => {
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 1280, height: 1000 });
  await page.locator('[data-state="live"]').waitFor();

  // One main landmark that is a polite live region, and it is no longer busy once rendered.
  assert.equal(await page.locator("main#remote-board[aria-live]").count(), 1, "the board is a polite live region");
  assert.equal(await page.locator("main#remote-board").getAttribute("aria-busy"), "false", "aria-busy clears after render");

  // Exactly one h1, and several h2 sections — a sane, non-skipping hierarchy.
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "exactly one top-level heading");
  assert.ok((await page.getByRole("heading", { level: 2 }).count()) >= 4, "each board section is an h2");

  // A role=status region carries the state sentence for a screen reader to announce.
  const status = page.locator('[role="status"]');
  assert.equal(await status.count(), 1);
  assert.match(await status.innerText(), /Live/);
  await page.close();
});

test("is keyboard-navigable: the Refresh control is reachable, focusable, and activates by keyboard", async () => {
  let fetches = 0;
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 1280, height: 1000 });
  page.on("requestfinished", (req) => { if (req.url().endsWith(REMOTE_BOARD_ENDPOINT)) fetches += 1; });
  await page.locator('[data-state="live"]').waitFor();

  // Tab to the Refresh button and confirm it is a real, focusable button element.
  const refresh = page.getByRole("button", { name: "Refresh the board" });
  await refresh.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON", "focus lands on the Refresh button");

  // Activating it by keyboard triggers a fresh board read (proving it is a working control).
  const before = fetches;
  const nextRead = page.waitForResponse((r) => r.url().endsWith(REMOTE_BOARD_ENDPOINT));
  await page.keyboard.press("Enter");
  await nextRead;
  assert.ok(fetches > before, "Enter on the focused Refresh control re-fetches the board");
  await page.close();
});

// ─── responsive layout ────────────────────────────────────────────────────────────

test("renders on a phone viewport with no horizontal overflow and a single-column board", async () => {
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 390, height: 844 });
  await page.locator('[data-state="live"]').waitFor();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `the phone board must not scroll horizontally (overflow ${overflow}px)`);

  // Single column: the first two cards share a left edge (stacked, not side by side).
  const cards = page.locator(".rb-card");
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  assert.ok(first && second);
  assert.ok(Math.abs(first.x - second.x) < 2, "on a phone the cards stack into one column");
  assert.ok(second.y > first.y, "the second card is below the first, not beside it");
  await page.close();
});

test("renders on a desktop viewport with a multi-column board grid", async () => {
  boardEnvelope = envelope("live", true);
  const page = await open({ width: 1280, height: 1000 });
  await page.locator('[data-state="live"]').waitFor();

  // Multi-column: the first two cards share a row (same top, different left).
  const cards = page.locator(".rb-card");
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  assert.ok(first && second);
  assert.ok(Math.abs(first.y - second.y) < 2, "on a desktop two cards sit on the same row");
  assert.ok(second.x > first.x + 100, "the second card sits to the right of the first");
  await page.close();
});

test("needs no active agent session: the board renders fully when nothing is running", async () => {
  boardEnvelope = envelope("live", true); // sampleBoard() has hasLiveWork:false, agents:[]
  const page = await open({ width: 1280, height: 1000 });
  await page.locator('[data-state="live"]').waitFor();

  // The Activity section renders honestly with no live session, and every other section is
  // present — the board does not depend on an agent being live.
  const activity = page.getByRole("heading", { level: 2, name: "Activity" }).locator("xpath=..");
  assert.match(await activity.innerText(), /No active agent session/);
  for (const name of ["Project", "Backlog", "Queue", "Campaigns", "Attention"]) {
    assert.equal(await page.getByRole("heading", { level: 2, name }).count(), 1, `${name} section renders without an agent session`);
  }
  await page.close();
});

// ─── harness ────────────────────────────────────────────────────────────────────

async function open(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  await page.goto(`${baseUrl}/`);
  return page;
}

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // The real remote shell, under the real remote CSP (nonce matched to its bootstrap), so
    // board.js loads as a first-party module exactly as it would in production.
    if (url.pathname === "/") {
      const nonce = remoteCspNonce();
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": remoteContentSecurityPolicy(nonce),
        })
        .end(renderRemoteShell(nonce));
      return;
    }
    // The real focused asset set, served by runtime path (as the remote server does).
    if (url.pathname.startsWith(REMOTE_CLIENT_URL_PREFIX)) {
      const filePath = resolve(REMOTE_CLIENT_DIR, url.pathname.slice(REMOTE_CLIENT_URL_PREFIX.length));
      if (!filePath.startsWith(`${REMOTE_CLIENT_DIR}/`) || !existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }).end(readFileSync(filePath));
      return;
    }
    // The stubbed projection endpoint: whichever envelope the current test selected.
    if (url.pathname === REMOTE_BOARD_ENDPOINT) {
      res
        .writeHead(STATUS_FOR[boardEnvelope.state], { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify(boardEnvelope));
      return;
    }
    res.writeHead(404).end();
  });
}
