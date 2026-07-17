import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => Boolean(candidate));
const CHROME_PATH = CHROME_CANDIDATES.find(existsSync);

const generatedAt = "2026-07-16T19:00:00.000Z";
const fullLimits = {
  generatedAt,
  services: [
    {
      id: "claude-subscription", name: "Claude Code", plan: "Claude Max (20x)", authMode: "oauth", status: "live",
      source: "anthropic-oauth-api", observedAt: generatedAt,
      windows: [{ label: "5-hour limit", usedPct: 42, resetsAt: "2026-07-16T21:00:00.000Z", elapsedPct: 60, pacePct: 70 }], note: null,
    },
    {
      id: "anthropic-api", name: "Anthropic API", plan: "Usage-based billing", authMode: "api_key", status: "not_applicable",
      source: "environment", observedAt: null, windows: [], note: "Subscription limit windows do not apply to Anthropic API-key billing.",
    },
    {
      id: "bedrock", name: "Amazon Bedrock", plan: "AWS usage · work", authMode: "bedrock", status: "not_configured",
      source: "environment", observedAt: null, windows: [], note: "Bedrock usage metrics are not configured on this host yet.",
    },
    {
      id: "codex-subscription", name: "Codex", plan: "ChatGPT Pro (20×)", authMode: "subscription", status: "stale",
      source: "codex-rollout", observedAt: "2026-07-16T17:00:00.000Z",
      windows: [{ label: "5h", usedPct: 61, resetsAt: "2026-07-16T22:00:00.000Z", elapsedPct: 50, pacePct: 122 }],
      note: "The live Codex query was unavailable; these limits are a local rollout observation and may have changed.",
    },
    {
      id: "openai-api", name: "OpenAI API", plan: "Usage-based billing", authMode: "api_key", status: "not_applicable",
      source: "environment", observedAt: null, windows: [], note: "Subscription limit windows do not apply to OpenAI API-key billing.",
    },
  ],
};

let limitsMode: "full" | "empty" | "error" = "full";
let delayLimitsMs = 0;
let refreshFails = false;
let refreshedUsedPct = 55;
let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  if (CHROME_PATH) {
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  }
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolveClosed) => server?.close(() => resolveClosed()));
});

test("Usage UI renders provider channels, analytics, refresh failures, and successful refreshes", { skip: !CHROME_PATH }, async () => {
  limitsMode = "full";
  delayLimitsMs = 0;
  refreshFails = false;
  const page = await newPage({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/#usage`);
  await page.locator(".plan-service").first().waitFor();

  assert.equal(await page.locator(".plan-service").count(), 5);
  assert.deepEqual(await page.locator(".plan-service-name-row strong").allTextContents(), [
    "Claude Code", "Anthropic API", "Amazon Bedrock", "Codex", "OpenAI API",
  ]);
  assert.deepEqual(await page.locator(".plan-status").allTextContents(), [
    "live", "not applicable", "not configured", "stale", "not applicable",
  ]);
  assert.equal(await page.locator(".plan-dial-progress").count(), 2, "unknown API/Bedrock usage must not draw progress rings");
  await page.getByRole("heading", { name: "Token & cache analytics" }).waitFor();
  assert.equal(await page.locator(".usage-headline-card").count(), 3);
  assert.equal(await page.locator(".usage-headline-value").first().innerText(), "1.3357B");

  refreshFails = true;
  await page.getByRole("button", { name: "refresh" }).click();
  await page.locator(".plan-refresh-error").waitFor();
  assert.match(await page.locator(".plan-refresh-error").innerText(), /refresh failed \(503\)/);
  assert.equal(await page.locator(".plan-service").count(), 5, "failed refresh must retain the prior successful data");

  refreshFails = false;
  refreshedUsedPct = 55;
  await page.getByRole("button", { name: "refresh" }).click();
  await page.locator(".plan-window-label strong").first().waitFor({ state: "visible" });
  await assertEventually(async () => (await page.locator(".plan-window-label strong").first().innerText()) === "55%");
  assert.equal(await page.locator(".plan-refresh-error").count(), 0);
  await page.close();
});

test("Usage UI covers loading, provider error, and empty states", { skip: !CHROME_PATH }, async () => {
  delayLimitsMs = 350;
  limitsMode = "empty";
  const loadingPage = await newPage({ width: 1200, height: 800 });
  await loadingPage.goto(`${baseUrl}/#usage`);
  await loadingPage.getByText("Loading host plan limits…").waitFor();
  await loadingPage.getByText("No host plan-limit services were reported.").waitFor();
  await loadingPage.close();

  delayLimitsMs = 0;
  limitsMode = "error";
  const errorPage = await newPage({ width: 1200, height: 800 });
  await errorPage.goto(`${baseUrl}/#usage`);
  await errorPage.locator(".plan-status-error").waitFor();
  assert.equal(await errorPage.locator(".plan-dial-value").innerText(), "—");
  assert.match(await errorPage.locator(".plan-service-note").innerText(), /currently unreachable/);
  await errorPage.close();
});

test("Usage UI stays contained and keeps analytics visible at a narrow width", { skip: !CHROME_PATH }, async () => {
  limitsMode = "full";
  delayLimitsMs = 0;
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#usage`);
  await page.locator(".plan-service").first().waitFor();

  const layout = await page.evaluate(() => {
    const activeTab = document.querySelector(".view-tabs .tab-active")?.getBoundingClientRect();
    const services = Array.from(document.querySelectorAll(".plan-service"), (element) => element.getBoundingClientRect());
    return {
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      maxServiceRight: Math.max(...services.map((rect) => rect.right)),
      minServiceLeft: Math.min(...services.map((rect) => rect.left)),
      activeTabVisible: Boolean(activeTab && activeTab.left >= 0 && activeTab.right <= window.innerWidth),
    };
  });
  assert.ok(layout.documentWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.bodyWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.maxServiceRight <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.minServiceLeft >= 0, JSON.stringify(layout));
  assert.equal(layout.activeTabVisible, true);
  await page.getByRole("heading", { name: "Token & cache analytics" }).waitFor();
  await page.close();
});

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

function createFixtureServer(): Server {
  return createServer(async (req, res) => {
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
      if (delayLimitsMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayLimitsMs));
      if (url.searchParams.get("refresh") === "1" && refreshFails) {
        res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unavailable" }));
        return;
      }
      const payload = limitsFixture(url.searchParams.get("refresh") === "1");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === "/api/usage") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
        { bucket: "forge-dashboard-with-a-long-project-name", inputTokens: 1_335_700_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 55_100 },
      ]));
      return;
    }
    if (url.pathname === "/api/usage/timeseries") {
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
        { date, inputTokens: 1_335_700_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 55_100 },
      ]));
      return;
    }
    if (url.pathname === "/api/usage/model-mix") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}

function limitsFixture(isRefresh: boolean) {
  if (limitsMode === "empty") return { generatedAt, services: [] };
  if (limitsMode === "error") {
    return {
      generatedAt,
      services: [{
        id: "claude-subscription", name: "Claude Code", plan: "Claude Max (5x)", authMode: "oauth", status: "error",
        source: "none", observedAt: null, windows: [], note: "Anthropic usage is currently unreachable.",
      }],
    };
  }
  if (!isRefresh) return fullLimits;
  return {
    ...fullLimits,
    generatedAt: "2026-07-16T19:01:00.000Z",
    services: fullLimits.services.map((service, index) => index === 0
      ? { ...service, windows: service.windows.map((window) => ({ ...window, usedPct: refreshedUsedPct })) }
      : service),
  };
}

async function assertEventually(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail("condition was not met before timeout");
}
