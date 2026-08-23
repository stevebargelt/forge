// FG-692 (FG-576 RF-2): an interactive-orchestrator row is an actual control,
// not just a clickable div. Drive the real dashboard client through project
// selection, then open the Diagnostics disclosure where the scoped orchestrator
// rows live; Enter and Space must both open the selected task's real detail view.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const TASK_ID = "task-interactive-orchestrator";
const PROJECT_DIR = "/checkouts/keyboard-fixture";

const projectFixture = [{
  key: "keyboard-fixture",
  label: "Keyboard fixture",
  color: "#4c8bf5",
  runCount: 1,
  inFlightCount: 0,
  liveSessions: 1,
  lastRunAt: "2026-08-22T00:00:00.000Z",
  githubUrl: null,
  description: "FG-692 keyboard fixture",
  readmeFirstLine: null,
  checkouts: [{ projectDir: PROJECT_DIR, branch: "main", exists: true }],
}];

const orchestratorsFixture = {
  orchestrators: [{
    receiptId: "receipt-keyboard",
    taskId: TASK_ID,
    running: true,
    presentation: "running",
    provider: "codex",
    model: "gpt-5",
    projectLabel: "Keyboard fixture",
    projectColor: "#4c8bf5",
    resolvedProfile: "default",
    runtime: "local",
    adapter: "codex",
    resolvedBy: "fixture",
    authMode: "local",
    sessionOperation: "interactive",
    sessionTarget: null,
    identityStrength: "strong",
    interaction: "interactive",
    limitations: [],
    startedAt: "2026-08-22T00:00:00.000Z",
    remoteControlUrl: null,
  }],
};

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
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

test("FG-692: interactive orchestrator rows announce button semantics and open their task with Enter and Space", async () => {
  for (const key of ["Enter", " "]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/#projects`);

    const project = page.getByRole("button", { name: "Open all Keyboard fixture checkouts" });
    await project.waitFor();
    await project.click();
    const diagnostics = page.locator("details.activity-diagnostics");
    await diagnostics.waitFor();
    await diagnostics.locator("summary").click();

    const row = page.getByRole("button", { name: `Open orchestrator task ${TASK_ID}` });
    await row.waitFor();
    assert.equal(await row.getAttribute("aria-label"), `Open orchestrator task ${TASK_ID}`);
    await row.focus();
    assert.equal(await row.evaluate((el) => el === document.activeElement), true, `${JSON.stringify(key)} can reach the row`);

    const detail = page.waitForResponse((response) => response.url().endsWith(`/api/task/${TASK_ID}`) && response.status() === 200);
    await page.keyboard.press(key);
    await detail;
    // A response reaching the browser precedes Preact committing it; wait for the
    // returned task ID rather than asserting the transient loading overlay.
    await page.locator(".detail-overlay").getByText(TASK_ID, { exact: true }).waitFor();
    assert.match(await page.locator(".detail-overlay").innerText(), new RegExp(TASK_ID));
    await page.close();
    assert.deepEqual(errors, [], `browser errors after ${JSON.stringify(key)}: ${errors.join("; ")}`);
  }
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
      res.writeHead(200, { "Content-Type": filePath.endsWith(".js") ? "application/javascript; charset=utf-8" : "image/svg+xml" }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectFixture));
      return;
    }
    if (url.pathname === "/api/orchestrators") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(orchestratorsFixture));
      return;
    }
    if (url.pathname === `/api/task/${TASK_ID}`) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        task: { taskId: TASK_ID, agentRole: "orchestrator", runTitle: "keyboard fixture", phase: "build", status: "complete", result: {} },
        verdicts: [],
        idle: null,
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
