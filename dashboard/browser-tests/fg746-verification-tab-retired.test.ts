// FG-746: the standalone Verification tab is RETIRED. In a real Chrome, the primary
// navigation carries no `verification` entry, and the `#verify` hash no longer resolves
// to a Verification view — it falls back to Home (the same fate any unknown hash gets).
//
// The evidence that used to live on that tab now lives contextually (Current Activity,
// Human Attention, run/task Explain, campaign detail, shipping audit); this suite proves
// only the retirement of the primary destination, which is AC1.

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
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    // Every other API poll returns an empty payload — this suite is about navigation.
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

async function open(hash = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator("nav.view-tabs").waitFor();
  return page;
}

test("FG-746 (AC1): the primary navigation has no `verification` tab", async () => {
  const page = await open();
  const tabTexts = await page.locator("nav.view-tabs button.tab").allInnerTexts();
  assert.ok(tabTexts.length > 0, "the nav rendered its tabs");
  assert.ok(
    !tabTexts.some((t) => t.trim().toLowerCase() === "verification"),
    `no verification tab may remain — got: ${JSON.stringify(tabTexts)}`,
  );
  await page.screenshot({ path: join(SHOTS, "nav-no-verification-tab.png") });
  await page.close();
});

test("FG-746 (AC1): the `#verify` hash no longer resolves to a Verification view — it falls back to Home", async () => {
  const page = await open("#verify");
  // Home is the fallback for an unknown/retired hash; its section is the ready signal.
  await page.locator("section.home-view").waitFor({ timeout: 5000 });
  // No verification-only surface renders: no "Host verification — in progress" heading,
  // no evidence-lookup form.
  const bodyText = await page.locator("body").innerText();
  assert.ok(!/Host verification — in progress/i.test(bodyText), "the retired tab's liveness heading must not render");
  assert.equal(await page.locator("#verify-ticket-id").count(), 0, "the retired manual evidence-lookup form must not render");
  await page.close();
});
