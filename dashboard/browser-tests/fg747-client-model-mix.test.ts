// FG-747 RF-3 browser regression: the RF-1 backend fix groups usage by durable project
// IDENTITY, returning a distinct `key` per identity even when two identities share a
// display `bucket` label. The dashboard CLIENT drill-down must join the model-mix map to
// each rollup row by that durable `key`, NOT by the `bucket` label — keying by label
// re-collapsed same-label independent identities on the client, undoing RF-1.
//
// This drives the REAL client (usage.js) against a fixture server whose /api/usage and
// /api/usage/model-mix carry two independent identities sharing ONE label but different
// model mixes. It asserts each row keeps its OWN drill-down and its own expand state.
// The bug is purely client-side, so the API is stubbed on purpose; RF-1's unit/
// integration tests prove the backend keys by identity.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

// Two independent durable identities that render to the SAME label. Row A is Opus-only,
// row B is Haiku-only, so a client that collapses them by label loses one mix entirely.
const SHARED_LABEL = "Acme Toolkit";
const rollupFixture = [
  { key: "repo-acme-a", bucket: SHARED_LABEL, inputTokens: 900_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 900 },
  { key: "repo-acme-b", bucket: SHARED_LABEL, inputTokens: 300_000, outputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 300 },
];
const modelMixFixture = [
  { key: "repo-acme-a", bucket: SHARED_LABEL, models: [{ model: "claude-opus-4-8", weightedTokens: 1_900_000, requests: 900 }] },
  { key: "repo-acme-b", bucket: SHARED_LABEL, models: [{ model: "claude-haiku-4-5", weightedTokens: 550_000, requests: 300 }] },
];

const limitsFixture = { generatedAt: "2026-08-22T00:00:00.000Z", services: [] };

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolveClosed) => server?.close(() => resolveClosed()));
});

test("two independent identities sharing a label keep SEPARATE client model-mix drill-downs", async () => {
  const page = await newPage({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/#usage`);
  await page.getByRole("heading", { name: "Token & cache analytics" }).waitFor();

  const rows = page.locator(".usage-row-wrap");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2, "both same-label identities render as distinct rows (never collapsed to one)");
  assert.deepEqual(await page.locator(".usage-bucket").allTextContents().then((labels) => labels.map((l) => l.replace(/^[▸▾]\s*/, "").trim())), [SHARED_LABEL, SHARED_LABEL]);

  const rowA = rows.nth(0);
  const rowB = rows.nth(1);

  // Expanding row A reveals ONLY the Opus mix, and must NOT expand row B (expand state is
  // keyed on the durable identity, not the shared label).
  await rowA.locator(".usage-row").click();
  await assertEventually(async () => (await rowA.locator(".usage-detail").evaluate((el) => (el as HTMLElement).style.maxHeight)) !== "0px");
  const detailA = await rowA.locator(".usage-detail").innerText();
  assert.match(detailA, /opus/, "row A's drill-down shows its own Opus mix");
  assert.doesNotMatch(detailA, /haiku/, "row A must NOT show the other identity's Haiku mix");
  assert.equal(await rowB.locator(".usage-detail").evaluate((el) => (el as HTMLElement).style.maxHeight), "0px", "expanding A must not also expand the same-label row B");

  // Expanding row B reveals ONLY the Haiku mix — the second identity was not overwritten.
  await rowB.locator(".usage-row").click();
  await assertEventually(async () => (await rowB.locator(".usage-detail").evaluate((el) => (el as HTMLElement).style.maxHeight)) !== "0px");
  const detailB = await rowB.locator(".usage-detail").innerText();
  assert.match(detailB, /haiku/, "row B's drill-down shows its own Haiku mix");
  assert.doesNotMatch(detailB, /opus/, "row B must NOT inherit the other identity's Opus mix");

  await page.close();
});

test("FG-692 RF-1: model-mix drill-down rows are keyboard-reachable and activatable (Enter/Space), with button semantics announced", async () => {
  const page = await newPage({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/#usage`);
  await page.getByRole("heading", { name: "Token & cache analytics" }).waitFor();

  const rowA = page.locator(".usage-row-wrap").first();
  const control = rowA.locator(".usage-row");
  await control.waitFor();

  // Interactive semantics are announced: it's a button and exposes its expanded state.
  assert.equal(await control.getAttribute("role"), "button", "the drill-down row announces itself as a button");
  assert.equal(await control.getAttribute("aria-expanded"), "false", "collapsed state is exposed to AT");

  // Reachable and activatable from the keyboard: focus it and press Enter.
  await control.focus();
  assert.ok(await control.evaluate((el) => el === document.activeElement), "the row is keyboard-focusable (tabindex)");
  await page.keyboard.press("Enter");
  await assertEventually(async () => (await rowA.locator(".usage-detail").evaluate((el) => (el as HTMLElement).style.maxHeight)) !== "0px");
  assert.equal(await control.getAttribute("aria-expanded"), "true", "Enter expanded the drill-down and updated aria-expanded");

  // Space collapses it again.
  await page.keyboard.press(" ");
  await assertEventually(async () => (await rowA.locator(".usage-detail").evaluate((el) => (el as HTMLElement).style.maxHeight)) === "0px");
  assert.equal(await control.getAttribute("aria-expanded"), "false", "Space collapsed the drill-down again");

  await page.close();
});

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

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
    if (url.pathname === "/api/usage") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(rollupFixture));
      return;
    }
    if (url.pathname === "/api/usage/model-mix") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(modelMixFixture));
      return;
    }
    if (url.pathname === "/api/usage/timeseries") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(limitsFixture));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}

async function assertEventually(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail("condition was not met before timeout");
}
