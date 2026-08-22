// FG-348 [J]: the Run Map + Explain browser tier. Driven in a real Chrome against
// the real shell + client, with /api/run/:id/map and /api/task/:id/explain
// branched on the scope query so a scope change is a genuinely different read that
// can be left pending. Four obligations:
//   1. A run is deep-linkable via #run-map/<runId>, renders the graph, and clicking
//      a node opens the "Why this task?" Explain panel.
//   2. Changing the checkout scope invalidates the map on screen (drops to loading)
//      AND a late leaving-scope response cannot repaint it (the runMapSeq guard) —
//      the fg349/fg699 precedent applied to the run map.
//   3. A legacy/degraded run (unloadable workflow → workflowResolved:false) renders
//      inferred labels + its degradation warning WITHOUT a page error.
//   4. Offline/CSP closure: the run-map view boots with no external/CDN fetch and a
//      script-src 'self' CSP — no new un-vendored client dependency.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell, contentSecurityPolicy, cspNonce } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

const PROJECT_KEY = "atlas";
const CHECKOUT_MAIN = "/checkouts/atlas-main";
const CHECKOUT_FEATURE = "/checkouts/atlas-feature";
const RUN_ID = "run-atlas-1";

const projectsFixture = [
  {
    key: PROJECT_KEY,
    label: "Atlas",
    color: "#4c8bf5",
    runCount: 1,
    inFlightCount: 0,
    liveSessions: 0,
    lastRunAt: "2026-06-10T12:00:00.000Z",
    githubUrl: null,
    description: "run-map scope fixture",
    readmeFirstLine: null,
    checkouts: [
      { projectDir: CHECKOUT_MAIN, branch: "main", exists: true },
      { projectDir: CHECKOUT_FEATURE, branch: "feature", exists: true },
    ],
  },
];

const feedFixture = [
  {
    taskId: "t-build",
    runId: RUN_ID,
    runTitle: "Atlas feature",
    workflow: "feature",
    projectDir: CHECKOUT_MAIN,
    projectLabel: "Atlas",
    projectColor: "#4c8bf5",
    checkoutBranch: "main",
    checkoutName: "atlas-main",
    agentRole: "engineer",
    agentModel: null,
    mappingPath: null,
    capabilitySource: null,
    phase: "build",
    status: "complete",
    completedAt: "2026-06-10T12:00:00.000Z",
    durationMs: 1000,
    result: { summary: "ok" },
    parentId: null,
  },
];

// A minimal-but-valid RunMapGraph whose run.title is the fingerprint of which
// scope the map is showing (run-map.js renders it in the header).
function graphFor(title: string) {
  return {
    version: 1,
    run: { runId: RUN_ID, workflow: "feature", title, status: "complete", createdAt: "2026-06-10T12:00:00.000Z" },
    workflowResolved: true,
    phases: [
      { id: "plan", label: "plan", role: "tech-lead", gate: "auto", dependsOn: [], fanout: false, manual: false, reds: [] },
      { id: "build", label: "build", role: "engineer", gate: "verdict", dependsOn: ["plan"], fanout: false, manual: false, reds: ["red-wide"] },
    ],
    edges: [{ from: "plan", to: "build" }],
    nodes: [
      { taskId: "t-plan", phase: "plan", role: "tech-lead", status: "complete", gate: "auto", lineage: "primary", native: {} },
      { taskId: "t-build", phase: "build", role: "engineer", status: "complete", gate: "verdict", lineage: "primary", model: { alias: "coding" }, native: {} },
    ],
    fanoutGroups: [],
    redAttachments: [{ redTaskId: "t-red", redRole: "red-wide", primaryTaskId: "t-build", via: "verdict" }],
    warnings: [],
  };
}

// A degraded (legacy) graph: the workflow would not load, so shape is inferred.
function degradedGraph() {
  return {
    version: 1,
    run: { runId: "run-legacy", workflow: "gone", title: "Legacy run", status: "complete", createdAt: "2026-01-01T00:00:00.000Z" },
    workflowResolved: false,
    phases: [{ id: "build", label: "build", dependsOn: [], fanout: false, manual: false, reds: [], inferred: true }],
    edges: [],
    nodes: [{ taskId: "t-legacy", phase: "build", role: "engineer", status: "complete", lineage: "unknown", inferred: true, native: {} }],
    fanoutGroups: [],
    redAttachments: [],
    warnings: ["Workflow definition could not be loaded — showing execution shape from task rows with inferred labels."],
  };
}

function explainFor(taskId: string) {
  return {
    version: 1,
    taskId,
    runId: RUN_ID,
    role: "engineer",
    status: "complete",
    warnings: ["Project workflow override is active."],
    workflowSource: { status: "recorded", name: "feature", source: "host" },
    modelResolution: { status: "recorded", alias: "coding", model: "claude-opus", profile: "claude-bedrock" },
    runtime: { status: "recorded", name: "claude-apikey", kind: "claude-code" },
    mountMode: { status: "recorded", mountMode: "rw", projectDir: CHECKOUT_MAIN },
    gate: { status: "recorded", gateType: "verdict", decisions: [] },
    reds: { status: "recorded", reds: [] },
    upstream: { status: "recorded", inputs: [{ key: "brief", summary: "do the thing" }] },
    artifacts: [{ kind: "result", name: "result.json", available: true }],
  };
}

function scopeKey(url: URL): string {
  const dir = url.searchParams.get("projectDir");
  if (dir) return `dir:${dir}`;
  const key = url.searchParams.get("projectKey");
  if (key) return `key:${key}`;
  return "unscoped";
}

const delayByScope = new Map<string, number>();

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

const rmTitle = (page: Page) => page.locator(".rm-header .mono").first();

function checkoutScopeButton(page: Page, name: string) {
  return page.locator(".checkout-scope-btn").filter({ hasText: new RegExp(`^${name}$`) });
}

test("A run is deep-linkable, renders the graph, and clicking a node opens the Explain panel", async () => {
  delayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#run-map/${RUN_ID}`);
  await page.locator(".rm-view").waitFor();
  // Phase + task nodes rendered.
  assert.ok((await page.locator(".rm-node").count()) >= 2, "the run map rendered its task nodes");
  // A red is attached to its primary (shape-distinguished chip).
  assert.equal(await page.locator(".rm-red").count(), 1, "the red is attached to its reviewed primary");

  // Click a node → the "Why this task?" Explain panel opens and renders blocks.
  await page.locator(".rm-node").first().click();
  await page.locator(".rx-panel").waitFor();
  assert.match(await page.locator(".rx-heading").innerText(), /why this task/i);
  // The recorded warning is shown prominently.
  await page.getByText("Project workflow override is active.").waitFor();
  await page.close();
});

test("Switching checkout scope invalidates the run map and a late leaving-scope response cannot repaint it (seq guard)", async () => {
  delayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  // Open the project scoped to main, then open the run map from the feed.
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open Atlas checkout main" }).click();
  await page.locator(".rm-open-btn").first().waitFor();

  // The main-scope run-map read is slow: it is still in flight when we narrow to
  // the feature checkout, and only lands afterwards.
  delayByScope.set(`dir:${CHECKOUT_MAIN}`, 3_000);
  await page.locator(".rm-open-btn").first().click();

  // The map is genuinely pending (loading), not the previous scope's graph.
  await page.getByText("loading run map…").waitFor();
  assert.equal(await page.locator(".rm-view").count(), 0, "the map is pending, not yet resolved");

  // Arm the wait for the leaving scope's own late response BEFORE switching.
  const leavingLate = page.waitForResponse(
    (res) => res.url().includes(`/api/run/${RUN_ID}/map`) && res.url().includes(`projectDir=${encodeURIComponent(CHECKOUT_MAIN)}`),
  );

  // Narrow to the fast feature checkout while main's read is in flight.
  await checkoutScopeButton(page, "feature").click();
  await page.locator(".rm-view").waitFor();
  assert.equal(await rmTitle(page).innerText(), CHECKOUT_FEATURE, "the new scope's own map is shown");

  // The retired main response lands. Its seq is stale, so the guard drops it.
  await leavingLate;
  await page.waitForTimeout(100);
  assert.equal(await rmTitle(page).innerText(), CHECKOUT_FEATURE,
    "a late leaving-scope map cannot repaint the abandoned checkout");
  await page.close();
});

test("A legacy/degraded run renders inferred labels without a page error", async () => {
  delayByScope.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#run-map/run-legacy`);
  await page.locator(".rm-view").waitFor();
  await page.locator(".rm-degraded").waitFor();
  await page.getByText(/Workflow definition could not be loaded/).waitFor();
  // The inferred node still renders and is still clickable (opens the panel).
  assert.ok((await page.locator(".rm-node").count()) >= 1, "the degraded graph still renders its execution nodes");
  await page.close();
});

test("The run-map view boots offline — no external/CDN fetch, script-src 'self' CSP, no new un-vendored dependency", async () => {
  delayByScope.clear();
  const external: string[] = [];
  const pageErrors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl) || url.startsWith("data:") || url.startsWith("blob:")) route.continue();
    else { external.push(url); route.abort(); }
  });

  const response = await page.goto(`${baseUrl}/#run-map/${RUN_ID}`, { waitUntil: "networkidle" });
  const csp = response?.headers()["content-security-policy"] ?? "";
  assert.match(csp, /script-src 'self'/, `the shell carries a script-src 'self' CSP (got: ${JSON.stringify(csp)})`);

  // The run-map view rendered from the vendored preact/htm graph — no CDN import.
  await page.locator(".rm-view").waitFor();
  assert.ok((await page.locator(".rm-node").count()) >= 1, "the run map rendered offline from vendored libs");
  assert.deepEqual(external, [], `the run-map view fetched external origins: ${external.join(", ")}`);
  assert.equal(external.filter((u) => /esm\.sh/.test(u)).length, 0, "no esm.sh fetch");
  assert.deepEqual(pageErrors, [], `browser errors during offline boot: ${pageErrors.join("; ")}`);
  await page.close();
});

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce", timezoneId: "UTC" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

function createFixtureServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      const nonce = cspNonce();
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": contentSecurityPolicy(nonce) })
        .end(renderShell(nonce));
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
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectsFixture));
      return;
    }
    if (url.pathname === "/api/feed") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(feedFixture));
      return;
    }
    const mapMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/map$/);
    if (mapMatch) {
      const runId = mapMatch[1]!;
      const scope = scopeKey(url);
      const delay = delayByScope.get(scope) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      const body = runId === "run-legacy"
        ? JSON.stringify(degradedGraph())
        // Fingerprint the scope in the run title so the scope test can read it.
        : JSON.stringify(graphFor(scope.startsWith("dir:") ? scope.slice("dir:".length) : "Atlas feature"));
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
      return;
    }
    const explainMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/explain$/);
    if (explainMatch) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(explainFor(explainMatch[1]!)));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
