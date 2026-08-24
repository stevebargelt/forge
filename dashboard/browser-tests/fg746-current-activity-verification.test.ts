// FG-746 (AC2/AC4/C2): Current Activity shows only GENUINELY LIVE host/CI verification.
//
// The dashboard client polls /api/verifications/in-progress and renders each row inside
// the In-flight surface. Server-side terminal authority (queries.ts inProgressVerifications
// + campaignGateTerminal) already drops a terminal FG-667 reconcile gate before it can be
// served — proven in queries-verification.test.ts. This suite proves the CLIENT half: a
// fresh review-loop verification AND a fresh reconcile gate render as live work, while a
// STALE (actionable) start does NOT render here — it belongs to Human Attention, not to
// ordinary in-progress work.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG746_SCREENSHOT_DIR ?? join(tmpdir(), "fg746-screenshots");
mkdirSync(SHOTS, { recursive: true });

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// The payload /api/verifications/in-progress serves. The terminal FG-667 gate is ABSENT
// (server-side terminal authority already dropped it) — represented here by its absence.
const IN_PROGRESS = [
  // fresh review-loop verification → LIVE, renders
  { kind: "review_loop_verification", attemptId: "att-live-loop", runId: "run-201", ticketId: "FG-201", sha: "abc123abc123", mode: "local", round: 1, startedAt: ago(60_000), stale: false },
  // fresh campaign reconcile gate → LIVE, renders
  { kind: "campaign_reconcile_gate", attemptId: "att-live-gate", runId: null, campaignId: "camp-9", itemId: "citem-9", ticketId: "FG-202", command: "npm run test:all", testedSha: "def456def456", startedAt: ago(90_000), stale: false },
  // STALE unmatched start → ACTIONABLE (Human Attention), must NOT render as in-flight
  { kind: "review_loop_verification", attemptId: "att-stale", runId: "run-777", ticketId: "FG-777", sha: "999999999999", mode: "local", round: 2, startedAt: ago(40 * 60_000), stale: true },
];

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
    if (url.pathname === "/api/verifications/in-progress") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(IN_PROGRESS));
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
    // in-flight, current-activity, review-loop/phases, etc. → empty
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}

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

async function openHome(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/`);
  await page.locator("section.home-view section.in-flight").waitFor();
  return page;
}

/** Poll the in-flight surface's text until the verification poll has landed its rows. */
async function inFlightTextOnce(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const el = document.querySelector("section.home-view section.in-flight");
    return !!el && /FG-201/.test(el.textContent ?? "");
  }, undefined, { timeout: 6000 });
  return page.locator("section.home-view section.in-flight").innerText();
}

test("FG-746 (AC2): a fresh review-loop verification and a fresh reconcile gate render as live In-flight work with ticket/run association", async () => {
  const page = await openHome();
  const text = await inFlightTextOnce(page);
  assert.match(text, /FG-201/, "the live review-loop verification renders with its ticket");
  assert.match(text, /run-201/, "…and its run association");
  assert.match(text, /FG-202/, "the live reconcile gate renders with its ticket");
  assert.match(text, /npm run test:all/, "…and its command/gate");
  await page.screenshot({ path: join(SHOTS, "current-activity-live-verification.png") });
  await page.close();
});

test("FG-746 (AC4/C2): a STALE start does NOT render as live In-flight work (it routes to Human Attention)", async () => {
  const page = await openHome();
  const text = await inFlightTextOnce(page);
  assert.ok(!/FG-777/.test(text), "the stale/actionable start must not appear as ordinary in-progress work");
  await page.close();
});
