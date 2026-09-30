// FG-348 [J]: the Run Map + Explain browser tier. Driven in a real Chrome against
// the real shell + client, with /api/run/:id/map delayed per run so a navigation is a
// genuinely different read that can be left pending. Four obligations:
//   1. A run is deep-linkable via #run-map/<runId> (FG-821: an alias of #run/<runId>),
//      renders the graph, and a node links to its task's "Why this task?" Explain page.
//   2. Navigating to another run invalidates the map on screen (drops to loading) AND a
//      late response for the run left behind cannot repaint it (the run page's sequence
//      guard). FG-821: the run page reads by global id, never with the scope in hand.
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
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

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
function graphFor(title: string, runId = RUN_ID) {
  return {
    version: 1,
    run: { runId, workflow: "feature", title, status: "complete", createdAt: "2026-06-10T12:00:00.000Z" },
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

const delayByRun = new Map<string, number>();
const mapRequests: string[] = [];

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

const rmTitle = (page: Page) => page.locator(".rm-header .mono").first();

test("A run is deep-linkable, renders the graph, and clicking a node opens its Explain page", async () => {
  delayByRun.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#run-map/${RUN_ID}`);
  await page.waitForFunction((id) => location.hash === `#run/${id}`, RUN_ID);
  await page.locator(".rm-view").waitFor();
  // Phase + task nodes rendered.
  assert.ok((await page.locator(".rm-node").count()) >= 2, "the run map rendered its task nodes");
  // A red is attached to its primary (shape-distinguished chip).
  assert.equal(await page.locator(".rm-red").count(), 1, "the red is attached to its reviewed primary");

  // Click a node → the task's "Why this task?" Explain page renders its blocks.
  await page.locator(".rm-node").first().click();
  await page.waitForFunction(() => location.hash === "#task/t-plan/explain");
  await page.locator(".rx-panel").waitFor();
  assert.match(await page.locator(".rx-heading").innerText(), /why this task/i);
  // The recorded warning is shown prominently.
  await page.getByText("Project workflow override is active.").waitFor();
  assert.equal(await page.locator(".detail-overlay").count(), 0, "Explain is a page, not an overlay");
  await page.close();
});

test("FG-692 RF-2 (FG-821): a map node opens Explain by keyboard, Escape goes up to the task, and Back returns focus-reachable to the map", async () => {
  delayByRun.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#run/${RUN_ID}`);
  await page.locator(".rm-view").waitFor();

  // A node is a link: Enter on it navigates.
  const node = page.locator(".rm-node").first();
  await node.focus();
  await node.press("Enter");
  await page.locator(".rx-panel").waitFor();
  assert.equal(new URL(page.url()).hash, "#task/t-plan/explain");

  // Escape goes to the parent object — the task page — with no mouse.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#task/t-plan");
  // And Back returns to the Explain page, then the map, whose nodes are links again.
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#task/t-plan/explain");
  await page.goBack();
  await page.locator(".rm-view").waitFor();
  assert.equal(await page.locator(".rm-node").first().evaluate((el) => el.tagName), "A");
  await page.close();
});

test("FG-692 RF-3 (FG-821): Explain is a page, not an aria-modal — nothing traps Tab, and its tabs link back to the task", async () => {
  delayByRun.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#task/t-build/explain`);
  await page.locator(".rx-panel").waitFor();
  assert.equal(await page.locator("[aria-modal='true']").count(), 0, "no modal dialog is open over the page");
  const back = page.locator('[role="tab"][data-tab="detail"]');
  assert.equal(await back.getAttribute("href"), "#task/t-build");
  assert.equal(await page.locator('[role="tab"][data-tab="explain"]').getAttribute("aria-selected"), "true");
  // Tab walks out of the content into the rest of the page: focus is not contained.
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".nav-column")), true, "Tab reaches the navigation");
  await page.close();
});

test("Navigating to another run invalidates the map and a late response for the run left behind cannot repaint it (seq guard); the read is unscoped", async () => {
  delayByRun.clear();
  mapRequests.length = 0;
  const page = await newPage({ width: 1440, height: 1200 });

  // Scope to the main checkout, then open the run from the feed.
  await page.goto(`${baseUrl}/#projects`);
  await page.locator(".project-dirs-toggle").click();
  await page.getByRole("button", { name: "Open Atlas checkout atlas-main · main" }).click();
  await page.locator(".rm-open-btn").first().waitFor();

  // The first run's map read is slow: it is still in flight when we move to another
  // run, and only lands afterwards.
  delayByRun.set(RUN_ID, 3_000);
  // Arm the waits for the leaving run's own request and late response BEFORE either happens.
  const leavingSent = page.waitForRequest((req) => req.url().includes(`/api/run/${RUN_ID}/map`));
  const leavingLate = page.waitForResponse((res) => res.url().includes(`/api/run/${RUN_ID}/map`));
  await page.locator(".rm-open-btn").first().click();
  await page.waitForFunction((id) => location.hash === `#run/${id}`, RUN_ID);

  // The map is genuinely pending (loading), not a previous graph, and its read is in flight.
  await page.getByText("loading run map…").waitFor();
  await leavingSent;
  assert.equal(await page.locator(".rm-view").count(), 0, "the map is pending, not yet resolved");

  await page.evaluate(() => { location.hash = "#run/run-other"; });
  await page.locator(".rm-view").waitFor();
  assert.equal(await rmTitle(page).innerText(), "Other run", "the new run's own map is shown");

  // The retired response lands. Its seq is stale, so the guard drops it.
  await leavingLate;
  await page.waitForTimeout(100);
  assert.equal(await rmTitle(page).innerText(), "Other run", "a late response for the run left behind cannot repaint the map");
  assert.ok(mapRequests.length > 0);
  assert.deepEqual(mapRequests.filter((q) => q.includes("project")), [], "an object page reads by global id, not with the scope in hand");
  await page.close();
});

test("A legacy/degraded run renders inferred labels without a page error", async () => {
  delayByRun.clear();
  const page = await newPage({ width: 1440, height: 1200 });

  await page.goto(`${baseUrl}/#run-map/run-legacy`);
  await page.locator(".rm-view").waitFor();
  await page.locator(".rm-degraded").waitFor();
  await page.getByText(/Workflow definition could not be loaded/).waitFor();
  // The inferred node still renders and is still a link (to its Explain page).
  assert.ok((await page.locator(".rm-node").count()) >= 1, "the degraded graph still renders its execution nodes");
  await page.close();
});

test("The run-map view boots offline — no external/CDN fetch, script-src 'self' CSP, no new un-vendored dependency", async () => {
  delayByRun.clear();
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
      mapRequests.push(url.search);
      const delay = delayByRun.get(runId) ?? 0;
      if (delay) await new Promise((wait) => setTimeout(wait, delay));
      const body = runId === "run-legacy"
        ? JSON.stringify(degradedGraph())
        : JSON.stringify(runId === RUN_ID ? graphFor("Atlas feature") : graphFor("Other run", runId));
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
