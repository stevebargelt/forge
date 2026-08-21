// FG-590 (RF-9): the dashboard labels a terminal host launch's retention disposition —
// retained-for-investigation vs expired/eligible vs leaked — via the SHARED rule
// (server-computed `retentionDisposition`, rendered by the pure decision functions
// `launchRetentionLabel`/`launchRetentionClass`). This is the browser-tier proof that the
// label reaches the page THROUGH THE REAL LAUNCH ROW an operator reads: a fixture server
// serves the actual client bundle and a `/api/current-activity` payload whose launches
// carry the disposition, Chrome renders it, and every assertion is over the DOM the real
// `LaunchRow` produced — never a span the test fabricated. A running launch (null
// disposition) is never labeled a cleanup candidate. Per the tier's rule it never skips:
// it resolves Chrome through the shared resolver and fails loudly when the browser is absent.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";
import { launchRetentionLabel, launchRetentionClass } from "../client/current-activity-render.js";
import type { CurrentActivity } from "@forge/current-activity";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const NOW = "2026-08-21T12:00:00.000Z";

type Activity = CurrentActivity;
type Launch = Activity["launches"][number];
type Disposition = Launch["retentionDisposition"];

function launch(launchId: string, disposition: Disposition, status: Launch["status"]): Launch {
  return {
    launchId,
    name: launchId,
    command: ["npm", "run", "test:worktree"],
    commandLine: "npm run test:worktree",
    projectDir: "/repos/forge",
    projectLabel: "forge",
    associationKind: "explicit",
    purpose: "generic",
    unassociated: false,
    placement: "project",
    runId: "run-fg590",
    taskId: null,
    ticketId: "FG-590",
    campaignId: null,
    itemId: null,
    startedAt: "2026-08-21T11:00:00.000Z",
    observedAt: "2026-08-21T11:59:00.000Z",
    status,
    recordedStatus: status,
    statusLabel: status.state === "running" ? "running" : "exited",
    observation: "fresh",
    retentionDisposition: disposition,
  };
}

// A launch row per disposition, PLUS a running launch that must carry no retention badge.
const LAUNCHES: Launch[] = [
  launch("l-retained", "within_retention_for_investigation", { state: "exited_error", code: 1 }),
  launch("l-expired", "expired_eligible", { state: "exited_error", code: 2 }),
  launch("l-leaked", "leaked", { state: "exited_ok", code: 0 }),
  launch("l-run", null, { state: "running" }),
];

const served: Activity = {
  generatedAt: NOW,
  scope: { runId: null, projectDirs: null },
  agents: [],
  hostVerification: [],
  launches: LAUNCHES,
  requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
  ciWaits: [],
  operatorWaits: [],
  unassociated: [],
};

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
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
    if (url.pathname === "/api/current-activity") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(served));
      return;
    }
    // Everything else main.js polls (in-flight, usage/limits, ops, …) — enough to render.
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function openActivity(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/#activity`);
  await page.locator("details.activity-diagnostics > summary").click();
  await page.waitForFunction(() => document.querySelector(".ca-loading") === null);
  await page.locator("section.current-activity .ca-launch-row").first().waitFor();
  return page;
}

test("FG-590 RF-9: the three dispositions render as three distinct labeled badges IN THE REAL launch rows", async () => {
  const page = await openActivity();

  // The badges are rendered by the production LaunchRow, inside real .ca-launch-row rows —
  // not fabricated DOM. Each disposition renders exactly once with the shared class + text.
  assert.equal(
    await page.locator("section.current-activity .ca-launch-row .launch-retention-retained").textContent(),
    "retained for investigation",
  );
  assert.equal(
    await page.locator("section.current-activity .ca-launch-row .launch-retention-expired").textContent(),
    "expired — eligible for cleanup",
  );
  assert.equal(
    await page.locator("section.current-activity .ca-launch-row .launch-retention-leaked").textContent(),
    "leaked — past retention",
  );

  // Exactly three retention badges across all launch rows — the running launch has none.
  assert.equal(
    await page.locator("section.current-activity .ca-launch-row [class^='launch-retention-']").count(),
    3,
  );

  // The running launch's row (l-run) carries no retention badge — it is live work, never a
  // cleanup candidate.
  const runRow = page.locator("section.current-activity .ca-launch-row", { hasText: "l-run" });
  assert.equal(await runRow.locator("[class^='launch-retention-']").count(), 0);

  await page.close();
});

test("FG-590 RF-9: the shared decision functions the production row calls are null-safe for a pre-field entry", () => {
  // The SAME functions LaunchRow invokes: an entry that predates the field makes no claim.
  assert.equal(launchRetentionLabel({}), null);
  assert.equal(launchRetentionLabel(undefined), null);
  assert.equal(launchRetentionClass(null), null);
});
