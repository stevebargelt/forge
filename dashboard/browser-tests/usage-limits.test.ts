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

const inFlightFixture = [{
  taskId: "task-home-live",
  runId: "run-home-live",
  runTitle: "Dashboard home",
  agentRole: "engineer",
  agentModel: "gpt-5",
  phase: "implementation",
  status: "running",
  startedAt: new Date().toISOString(),
  projectDir: "/workspace/forge",
  projectLabel: "Forge",
  projectColor: "#7a9fff",
  checkoutBranch: "main",
}];

const projectsFixture = [{
  key: "repo-forge",
  projectDir: "/workspace/forge",
  primaryCheckout: "/workspace/forge",
  projectDirs: ["/workspace/forge", "/workspace/forge-dashboard", "/workspace/forge-fg571"],
  label: "Forge",
  color: "#7a9fff",
  runCount: 9,
  inFlightCount: 1,
  liveSessions: 1,
  lastRunAt: new Date().toISOString(),
  checkouts: [
    { projectDir: "/workspace/forge", projectDirs: ["/workspace/forge"], branch: "main", exists: true, runCount: 3, inFlightCount: 0, liveSessions: 0 },
    { projectDir: "/workspace/forge-dashboard", projectDirs: ["/workspace/forge-dashboard"], branch: "dashboard-home", exists: true, runCount: 4, inFlightCount: 1, liveSessions: 0 },
    { projectDir: "/workspace/forge-fg571", projectDirs: ["/workspace/forge-fg571"], branch: "fg578-raci-clobber", exists: true, runCount: 2, inFlightCount: 0, liveSessions: 1 },
  ],
}];

const feedFixture = [{
  taskId: "task-feed", runId: "run-feed", runTitle: "Canonical project identity", workflow: "feature",
  projectDir: "/workspace/forge-dashboard", projectLabel: "Forge", projectColor: "#7a9fff", checkoutBranch: null, checkoutName: "forge-dashboard",
  agentRole: "engineer", agentModel: "gpt-5", phase: "implementation", status: "complete",
  completedAt: new Date().toISOString(), durationMs: 1000, result: { summary: "Grouped correctly" }, parentId: null,
}];

const opsFixture = {
  runs: { total: 1157, active: 13, terminal: 1144, clean: 971, withFailures: 173, successRate: 0.85 },
  taskCount: 2269,
  counts: { idleKills: 3, cancels: 67, retries: 13, redBlocks: 41 },
  failureKinds: [{ kind: "gate_rejected", count: 58 }],
  durations: [{ phase: "implementation", medianMs: 120_000, count: 25 }],
};

const backlogFixture = {
  notes: "",
  notesByCheckout: [
    {
      checkoutDir: "/workspace/forge",
      checkoutBranch: "main",
      notes: "# Main handoff\n\nMain checkout context with enough detail to belong in the detail view rather than expanding the list.",
    },
    {
      checkoutDir: "/workspace/forge-dashboard",
      checkoutBranch: "dashboard-home",
      notes: "# Dashboard handoff\n\nDashboard checkout context with implementation notes for the next session.",
    },
  ],
  tickets: [],
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
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolveClosed) => server?.close(() => resolveClosed()));
});

test("Home is the hashless default and combines plan limits with in-flight work", async () => {
  limitsMode = "full";
  delayLimitsMs = 0;
  refreshFails = false;
  const page = await newPage({ width: 1440, height: 1000 });
  const requestedApiPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === baseUrl && url.pathname.startsWith("/api/")) requestedApiPaths.push(url.pathname);
  });

  await page.goto(baseUrl);
  await page.locator(".plan-service").first().waitFor();
  await page.locator("section.in-flight .item").first().waitFor();

  assert.equal(await page.locator(".view-tabs .tab-active").innerText(), "home");
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(await page.getByRole("heading", { name: "Plan limits & windows" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "In flight" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Operations" }).count(), 1);
  // FG-679 added a `Current activity` surface (kicker "Right now") above the task panel.
  // The FG-694 post-ship correction took it back off Home: two top-level activity
  // surfaces duplicated every agent between them, and the panel measured 810.5px in an
  // 862px viewport. Home has ONE — `In flight` — and the compact host/CI waits are rows
  // inside it. The full panel is on the Activity view, asserted below.
  assert.deepEqual(await page.locator(".home-section-kicker").allTextContents(), ["Tasks", "Forge activity"]);
  assert.equal(await page.getByRole("heading", { name: "Current activity" }).count(), 0);
  assert.equal(await page.locator(".home-in-flight-group > .in-flight > h2").count(), 0, "Home heading belongs above the panel");
  assert.deepEqual(await page.locator(".home-ops-summary .stat-num").allTextContents(), ["85%", "1157", "2269", "3", "67", "13", "41"]);
  assert.match(await page.locator(".home-ops-summary").innerText(), /30d/);
  assert.equal(await page.getByRole("heading", { name: "Failure kinds" }).count(), 0);
  assert.match(await page.locator("section.in-flight .item").innerText(), /Dashboard home/);
  assert.equal(await page.getByRole("heading", { name: "Token & cache analytics" }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Recent agent outputs" }).count(), 0);
  assert.equal(requestedApiPaths.includes("/api/usage"), false, "Home must not fetch token analytics");
  assert.equal(requestedApiPaths.includes("/api/usage/timeseries"), false, "Home must not fetch usage history");
  assert.equal(requestedApiPaths.includes("/api/usage/model-mix"), false, "Home must not fetch model mix");

  await page.getByRole("button", { name: "activity" }).click();
  await page.getByRole("heading", { name: "Recent agent outputs" }).waitFor();
  assert.equal(new URL(page.url()).hash, "#activity");
  assert.equal(await page.getByRole("heading", { name: "Plan limits & windows" }).count(), 0);
  // …and this is where the panel went. It is off Home, not deleted.
  assert.equal(await page.getByRole("heading", { name: "Current activity" }).count(), 1);

  await page.getByRole("button", { name: "home", exact: true }).click();
  await page.getByRole("heading", { name: "Plan limits & windows" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await page.close();
});

test("Home stays contained and reflows in-flight work at a narrow width", async () => {
  limitsMode = "full";
  delayLimitsMs = 0;
  const page = await newPage({ width: 390, height: 844 });
  await page.goto(baseUrl);
  await page.locator(".plan-service").first().waitFor();
  const item = page.locator("section.in-flight .item").first();
  await item.waitFor();
  await page.getByRole("heading", { name: "Operations" }).waitFor();

  const layout = await page.evaluate(() => {
    const activeTab = document.querySelector(".view-tabs .tab-active")?.getBoundingClientRect();
    const inFlightItem = document.querySelector("section.in-flight .item");
    const badge = inFlightItem?.querySelector(".badge")?.getBoundingClientRect();
    const main = inFlightItem?.children[1]?.getBoundingClientRect();
    const statCards = Array.from(document.querySelectorAll(".home-ops-summary .stat"), (element) => element.getBoundingClientRect());
    return {
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      activeTabVisible: Boolean(activeTab && activeTab.left >= 0 && activeTab.right <= window.innerWidth),
      badgeAboveMain: Boolean(badge && main && badge.bottom <= main.top),
      mainWidth: main?.width ?? 0,
      statCount: statCards.length,
      minStatLeft: Math.min(...statCards.map((card) => card.left)),
      maxStatRight: Math.max(...statCards.map((card) => card.right)),
    };
  });
  assert.ok(layout.documentWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.ok(layout.bodyWidth <= layout.innerWidth, JSON.stringify(layout));
  assert.equal(layout.activeTabVisible, true);
  assert.equal(layout.badgeAboveMain, true);
  assert.ok(layout.mainWidth >= 180, JSON.stringify(layout));
  assert.equal(layout.statCount, 7);
  assert.ok(layout.minStatLeft >= 0, JSON.stringify(layout));
  assert.ok(layout.maxStatRight <= layout.innerWidth, JSON.stringify(layout));
  await page.close();
});

test("In-flight rows copy their task id without opening task detail", async () => {
  const page = await newPage({ width: 1200, height: 800 });
  await page.goto(baseUrl);
  const copy = page.getByRole("button", { name: "Copy task id task-home-live" });
  await copy.waitFor();
  await copy.click();
  await assertEventually(async () => (await copy.innerText()) === "copied!");
  assert.equal(await page.locator(".detail-overlay").count(), 0);
  await page.close();
});

test("Projects renders one canonical card with subordinate checkouts and preserves exact checkout selection", async () => {
  const page = await newPage({ width: 1200, height: 900 });
  const activityRequests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/feed") activityRequests.push(url);
  });
  await page.goto(`${baseUrl}/#projects`);
  const card = page.locator(".project-card");
  await card.waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator(".project-card-head .project-chip").innerText(), "Forge");
  assert.deepEqual(await card.locator(".checkout-branch").allTextContents(), ["main", "dashboard-home", "fg578-raci-clobber"]);
  assert.match(await card.innerText(), /\/workspace\/forge-dashboard/);

  await card.locator(".project-checkout-row").filter({ hasText: "dashboard-home" }).click();
  await page.getByRole("heading", { name: "Recent agent outputs" }).waitFor();
  await assertEventually(async () => activityRequests.some((url) => url.searchParams.get("projectDir") === "/workspace/forge-dashboard"));
  const projectChip = page.locator(".feed .project-chip").first();
  assert.equal(await projectChip.innerText(), "Forge");
  assert.equal(await page.locator(".feed .checkout-chip").first().innerText(), "forge-dashboard");
  assert.equal(await projectChip.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(122, 159, 255)");
  assert.equal(await page.locator(".feed .checkout-chip").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.match(await page.locator(".feed .project-identity").first().getAttribute("title") ?? "", /forge-dashboard$/);
  const copy = page.getByRole("button", { name: "Copy task id task-feed" });
  await copy.click();
  await assertEventually(async () => (await copy.innerText()) === "copied!");
  assert.equal(await page.locator(".detail-overlay").count(), 0);
  await page.close();
});

test("Backlog renders multi-checkout handoffs as compact list cards with one detail view", async () => {
  const page = await newPage({ width: 1200, height: 900 });
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Forge checkouts" }).click();
  await page.getByRole("button", { name: "backlog" }).click();

  const cards = page.locator(".backlog-note-card");
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  assert.equal(await page.locator(".backlog-notes-body").count(), 0, "multi-checkout notes must not render expanded markdown cards");
  assert.match(await cards.first().innerText(), /main/);
  assert.match(await cards.nth(1).innerText(), /dashboard-home/);
  assert.ok((await page.locator(".backlog-notes").evaluate((element) => element.getBoundingClientRect().height)) < 400);

  await cards.nth(1).click();
  const detail = page.getByRole("dialog", { name: "Session handoff for dashboard-home" });
  await detail.waitFor();
  assert.match(await detail.innerText(), /Dashboard checkout context/);
  assert.match(await detail.innerText(), /\/workspace\/forge-dashboard/);
  assert.equal(await page.locator(".detail-overlay").count(), 1);
  await detail.getByRole("button", { name: "Close session handoff detail" }).click();
  assert.equal(await page.locator(".detail-overlay").count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    cardsContained: Array.from(document.querySelectorAll(".backlog-note-card")).every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
  }));
  assert.ok(narrow.documentWidth <= narrow.viewport, JSON.stringify(narrow));
  assert.equal(narrow.cardsContained, true, JSON.stringify(narrow));
  await page.close();
});

test("Usage UI renders provider channels, analytics, refresh failures, and successful refreshes", async () => {
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
  assert.equal(await page.locator(".usage-headline-value").first().innerText(), "1.34B");

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

test("Usage UI covers loading, provider error, and empty states", async () => {
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

test("Usage UI stays contained and keeps analytics visible at a narrow width", async () => {
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
    if (url.pathname === "/api/in-flight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inFlightFixture));
      return;
    }
    // A CURRENT server with nothing to wait on. Without it this fixture answers `[]`
    // for the route, which is a malformed payload — and since FG-694 a failed read is
    // an explicit row on Home rather than a silent absence, so this suite would be
    // measuring that row instead of the in-flight work it is about.
    if (url.pathname === "/api/current-activity") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        generatedAt: new Date(0).toISOString(),
        scope: { runId: null, projectDirs: null },
        agents: [],
        hostVerification: [],
        requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
        unassociated: [],
      }));
      return;
    }
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectsFixture));
      return;
    }
    if (url.pathname === "/api/feed") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(feedFixture));
      return;
    }
    if (url.pathname === "/api/backlog") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(backlogFixture));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(opsFixture));
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
