// FG-821: the cockpit's object pages — the run index, the run page (map and evidence
// tabs), the task page and its Explain page, the ticket page and a review by id — with
// breadcrumbs built from the payload and the Runs badge read from the server's
// activeCount.
//
// The real client is booted against a fixture server that answers the step A endpoints
// (GET /api/runs, /api/review/:id, /api/task/:id with links, /api/backlog/:id/runs) and
// step C's GET /api/run/:id/evidence, plus
// the run map, Explain and attention-inbox reads those pages already used.

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

const PORT = 18825;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG821_SCREENSHOT_DIR ?? join(tmpdir(), "fg821-screenshots");
mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas-main";
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

type RunsMode = "count" | "zero" | "unavailable";
let runsMode: RunsMode = "count";
const apiRequests: string[] = [];

const RUNS = [
  { runId: "run-1", status: "active", workflow: "feature", title: "Build the cockpit", projectDir: MAIN, ticketId: "FG-9", createdAt: ago(1), completedAt: null, taskCount: 2, failedCount: 0, failureKinds: [] },
  { runId: "run-2", status: "complete", workflow: "feature", title: "Ship the nav", projectDir: MAIN, ticketId: null, createdAt: ago(3), completedAt: ago(2), taskCount: 1, failedCount: 0, failureKinds: [] },
  { runId: "run-3", status: "failed", workflow: "feature", title: "Fix the merge", projectDir: MAIN, ticketId: null, createdAt: ago(5), completedAt: ago(4), taskCount: 1, failedCount: 1, failureKinds: ["merge_conflict"] },
  { runId: "run-4", status: "complete", workflow: "bugfix", title: "Older run four", projectDir: MAIN, ticketId: null, createdAt: ago(7), completedAt: ago(6), taskCount: 1, failedCount: 0, failureKinds: [] },
  { runId: "run-5", status: "abandoned", workflow: "bugfix", title: "Older run five", projectDir: "/elsewhere/unregistered", ticketId: null, createdAt: ago(9), completedAt: ago(8), taskCount: 0, failedCount: 0, failureKinds: [] },
];

function runsBody(url: URL): { status: number; body: unknown } {
  if (runsMode === "unavailable") return { status: 503, body: { runs: [], activeCount: null, nextCursor: null, error: "store unreadable" } };
  const status = url.searchParams.get("status");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const start = Number(url.searchParams.get("cursor") ?? 0);
  const rows = RUNS.filter((r) => !status || r.status === status);
  const page = rows.slice(start, start + limit);
  return {
    status: 200,
    body: {
      runs: page,
      // Deliberately NOT a count of the rows: a badge showing 1 or 5 counted in the browser.
      activeCount: runsMode === "zero" ? 0 : 7,
      nextCursor: start + limit < rows.length ? String(start + limit) : null,
      generatedAt: new Date().toISOString(),
    },
  };
}

function task(id: string, role: string, status: string, runId: string, runTitle: string) {
  return {
    taskId: id, runId, runTitle, workflow: "feature", projectDir: MAIN, projectLabel: "Atlas", projectColor: "#345",
    checkoutBranch: "main", checkoutName: null, agentRole: role, agentModel: "opus", mappingPath: null, capabilitySource: null,
    phase: "build", status, completedAt: ago(1), durationMs: 1000, result: { diff_summary: `${role} did the work` }, parentId: null,
  };
}

const DETAILS: Record<string, unknown> = {
  "task-1": {
    task: task("task-1", "engineer", "awaiting_gate", "run-1", "Build the cockpit"),
    links: { runId: "run-1", ticketId: "FG-9", reviewIds: ["review-1"], launchIds: ["launch-1"], hostVerificationIds: [7] },
    stdoutLog: "hello from stdout", stderrLog: null, stdoutBytes: 17, stderrBytes: 0,
    verdicts: [], gates: [], events: [{ eventType: "task.started", createdAt: ago(1), payload: {} }], failureKind: null, idle: null, resultSizeBytes: 10,
  },
  "task-2": {
    task: task("task-2", "red-wide", "complete", "run-1", "Build the cockpit"),
    links: { runId: "run-1", ticketId: "FG-9", reviewIds: ["review-1"], launchIds: ["launch-1", "launch-2"], hostVerificationIds: [] },
    stdoutLog: null, stderrLog: null, stdoutBytes: 0, stderrBytes: 0, verdicts: [], gates: [], events: [], failureKind: null, idle: null, resultSizeBytes: 10,
  },
  "task-3": {
    task: task("task-3", "engineer", "failed", "run-3", "Fix the merge"),
    links: { runId: "run-3", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] },
    stdoutLog: null, stderrLog: null, stdoutBytes: 0, stderrBytes: 0, verdicts: [], gates: [], events: [], failureKind: "merge_conflict", idle: null, resultSizeBytes: 10,
  },
};

// The server-side union of each run's task links — the run page reads this, never the tasks.
const RUN_EVIDENCE: Record<string, unknown> = {
  "run-1": { runId: "run-1", ticketId: "FG-9", reviewIds: ["review-1"], launchIds: ["launch-1", "launch-2"], hostVerificationIds: [7] },
  "run-3": { runId: "run-3", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] },
};

function runMap(runId: string) {
  const run = RUNS.find((r) => r.runId === runId);
  if (!run) return null;
  const nodes = runId === "run-1"
    ? [
      { taskId: "task-1", phase: "build", role: "engineer", status: "awaiting_gate", gate: "human", lineage: "primary", native: null },
      { taskId: "task-2", phase: "review", role: "red-wide", status: "complete", gate: "auto", lineage: "primary", native: null },
    ]
    : runId === "run-3"
      ? [{ taskId: "task-3", phase: "build", role: "engineer", status: "failed", gate: "auto", lineage: "primary", native: null }]
      : [];
  return {
    version: 1,
    run: { runId, workflow: run.workflow, title: run.title, status: run.status, createdAt: run.createdAt, projectDir: run.projectDir },
    workflowResolved: true,
    phases: [
      { id: "build", label: "build", role: "engineer", gate: "human", dependsOn: [], fanout: false, manual: false, reds: [] },
      { id: "review", label: "review", role: "red-wide", gate: "auto", dependsOn: ["build"], fanout: false, manual: false, reds: [] },
    ],
    edges: [{ from: "build", to: "review" }],
    nodes,
    fanoutGroups: [],
    redAttachments: [],
    warnings: [],
  };
}

function inbox(runId: string | null) {
  const base = { generatedAt: new Date().toISOString(), scope: { runId, projectDirs: null }, degraded: [] };
  const gate = {
    id: "att-gate", kind: "waiting_gate", severity: "medium", startedAt: ago(1), reason: "engineer is waiting at its gate",
    requestedAction: "forge gate task-1", openState: "open", source: "fixture",
    links: { runId: "run-1", taskId: "task-1", ticketId: "FG-9", campaignId: null, itemId: null, projectDir: MAIN, projectLabel: "Atlas" },
  };
  const failed = {
    id: "att-failed", kind: "failed_task", severity: "high", startedAt: ago(4), reason: "engineer failed: merge_conflict",
    requestedAction: "rebase the task branch onto the current base and resolve the conflict, or retry", openState: "open", source: "fixture",
    links: { runId: "run-3", taskId: "task-3", ticketId: null, campaignId: null, itemId: null, projectDir: MAIN, projectLabel: "Atlas" },
  };
  const items = runId === "run-1" ? [gate] : runId === "run-3" ? [failed] : runId ? [] : [gate, failed];
  return { ...base, items, empty: items.length === 0, counts: { open: items.length, high: items.filter((i) => i.severity === "high").length } };
}

const REVIEW = {
  id: "review-1", runId: "run-1", subjectTaskId: "task-1", ticketId: "FG-9", projectDir: MAIN, baseSha: "a".repeat(40),
  contractConfirmedSha: null, candidateSha: "b".repeat(40), trustedRemoteSha: null, reviewMode: "evidence_led", state: "awaiting_disposition",
  riskLenses: ["correctness"], createdAt: ago(1), updatedAt: ago(1), settledAt: null,
  countsByDisposition: { pending: 1 }, countsByResolution: {},
  findings: [{ id: "f-1", findingRef: "RF-1", severity: "high", riskLens: "correctness", reachability: "reachable", summary: "an old finding", sources: [], disposition: "pending", resolution: null }],
};

let server: Server;
let browser: Browser;
const baseUrl = `http://127.0.0.1:${PORT}`;

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(PORT, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function open(hash = "", width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const crumbs = (page: Page) => page.locator(".breadcrumbs li").evaluateAll((items) =>
  items.map((li) => ({ label: li.textContent?.trim(), href: li.querySelector("a")?.getAttribute("href") ?? null })));
// The tablist pattern (FG-692): every tab is role=tab with aria-selected, a roving tabindex
// and aria-controls naming the one tabpanel, which is labelled by the selected tab.
const tablist = (page: Page) => page.evaluate(() => {
  const list = document.querySelector('.object-tabs[role="tablist"]');
  const panel = document.querySelector('[role="tabpanel"]');
  return {
    tabs: Array.from(list?.children ?? []).map((t) => [t.getAttribute("role"), t.getAttribute("data-tab"), t.getAttribute("aria-selected"),
      t.getAttribute("tabindex"), t.getAttribute("aria-controls") === panel?.id && !!panel?.id]),
    labelledBy: panel ? document.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.getAttribute("data-tab") ?? null : null,
    panels: document.querySelectorAll('[role="tabpanel"]').length,
  };
});
const runsBadgeText = (page: Page) => page.evaluate(() => document.querySelector('.nav-column a[data-view="runs"] .nav-badge')?.textContent ?? null);

async function waitFor<T>(read: () => Promise<T>, expected: T, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let last: T = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(last, expected, what);
}

test("FG-821: the run index lists project, ticket, status, started and duration, and filters by status in the hash", async () => {
  runsMode = "count";
  apiRequests.length = 0;
  const { page, errors } = await open("#runs?project=atlas");
  await page.locator(".runs-table tbody tr").first().waitFor();
  assert.equal(await page.locator(".page-title").innerText(), "Runs");
  assert.deepEqual(await page.locator(".runs-table th").allTextContents(), ["run", "project", "ticket", "status", "started", "duration"]);
  const first = page.locator('.runs-table tr[data-run-id="run-1"]');
  assert.equal(await first.locator("a").first().getAttribute("href"), "#run/run-1", "a run row links to its page");
  assert.equal(await first.locator("td").nth(1).locator("a").innerText(), "Atlas", "the project column names the registered project");
  assert.equal(await first.locator("td .runs-checkout").innerText(), "atlas-main · main", "FG-831: …and its checkout, by the shared label rule");
  assert.equal(await first.locator("td").nth(1).locator("a").getAttribute("href"), "#runs?project=atlas");
  assert.equal(await first.locator("td").nth(2).locator("a").getAttribute("href"), "#backlog/FG-9?project=atlas", "the ticket column links to the ticket in its project");
  assert.equal(await page.locator('.runs-table tr[data-run-id="run-2"] td').nth(2).innerText(), "—", "a run without a ticket shows none");
  assert.match(await first.locator("td").nth(5).innerText(), /so far/, "an active run's duration is running");
  assert.match(await page.locator('.runs-table tr[data-run-id="run-2"] td').nth(5).innerText(), /^1h 0m$/);
  assert.equal(await page.locator(".screen-line").innerText(), "7 runs are active",
    "FG-838: the header states the server's activeCount alone; the contract and verb are in the info tip");
  assert.ok(apiRequests.some((u) => u.startsWith("/api/runs?") && new URL(u, baseUrl).searchParams.get("projectKey") === "atlas"),
    "the index read carries the scope");
  await page.screenshot({ path: join(SHOTS, "fg821-runs-index-badge.png") });

  // Status filter: a link that writes the hash; the server does the filtering.
  await page.locator('.runs-filters a[data-status="failed"]').click();
  await page.waitForFunction(() => location.hash === "#runs?project=atlas&status=failed");
  await waitFor(() => page.locator(".runs-table tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-run-id"))), ["run-3"], "only the failed run shows");
  assert.ok(apiRequests.some((u) => u.startsWith("/api/runs?") && new URL(u, baseUrl).searchParams.get("status") === "failed"), "the status reached the server");
  assert.equal(await page.locator('.runs-filters a[aria-current="page"]').innerText(), "failed");
  await page.reload();
  await waitFor(() => page.locator(".runs-table tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-run-id"))), ["run-3"], "reload restores the filter");

  // Load more follows the cursor and appends, never re-counting in the browser.
  await page.locator('.runs-filters a[data-status="all"]').click();
  await page.waitForFunction(() => location.hash === "#runs?project=atlas");
  await waitFor(() => page.locator(".runs-table tbody tr").count(), 5, "all five runs fit one 50-row page");
  assert.equal(await page.locator(".runs-load-more").count(), 0, "no cursor, no Load more");
  const row5 = page.locator('.runs-table tr[data-run-id="run-5"] td').nth(1);
  assert.equal(await row5.innerText(), "unregistered", "an unregistered directory reads as its basename");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-821: Load more reads the next page through the server cursor", async () => {
  runsMode = "count";
  // A 2-row page size forces the button: the fixture honours ?limit, so shrink it.
  pageSizeOverride = 2;
  const { page: paged } = await open("#runs");
  await waitFor(() => paged.locator(".runs-table tbody tr").count(), 2, "the first page");
  await paged.locator(".runs-load-more").click();
  await waitFor(() => paged.locator(".runs-table tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-run-id"))),
    ["run-1", "run-2", "run-3", "run-4"], "Load more appends the next page");
  await paged.locator(".runs-load-more").click();
  await waitFor(() => paged.locator(".runs-table tbody tr").count(), 5, "the last page");
  assert.equal(await paged.locator(".runs-load-more").count(), 0, "the last page has no cursor");
  pageSizeOverride = null;
  await paged.close();
});

test("FG-821: the Runs badge is the server's activeCount — never danger, ? when unavailable, hidden at 0", async () => {
  runsMode = "count";
  const { page } = await open("#usage");
  await waitFor(() => runsBadgeText(page), "7", "the badge shows activeCount, not a row count");
  const badge = page.locator('.nav-column a[data-view="runs"] .nav-badge');
  assert.match(await badge.getAttribute("class") ?? "", /nav-badge-neutral/);
  assert.doesNotMatch(await badge.getAttribute("class") ?? "", /danger/, "the Runs badge is informational, never danger-toned");
  assert.match(await page.locator('.nav-column a[data-view="runs"] .nav-sr-only').innerText(), /7 active runs/);

  runsMode = "unavailable";
  await page.reload();
  await waitFor(() => runsBadgeText(page), "?", "an unreadable count shows ?");

  runsMode = "zero";
  await page.reload();
  await page.locator(".page-title", { hasText: "Usage" }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await runsBadgeText(page), null, "0 active runs hides the badge");

  // The bottom bar carries the same badge.
  runsMode = "count";
  const narrow = await open("#usage", 400);
  await waitFor(() => narrow.page.evaluate(() => document.querySelector('.bottom-bar a[data-view="runs"] .nav-badge')?.textContent ?? null), "7", "the bottom bar's Runs badge");
  assert.ok(await narrow.page.evaluate(() => Object.keys(localStorage).length === 0 && Object.keys(sessionStorage).length === 0), "nothing is stored client-side");
  await narrow.page.close();
  await page.close();
});

test("FG-821: #run/<id> renders the map tab by default and an evidence tab linking each review, verification and launch", async () => {
  runsMode = "count";
  apiRequests.length = 0;
  const { page, errors } = await open("#run/run-1");
  await page.locator(".rm-node").first().waitFor();
  assert.equal(await page.locator(".page-title").innerText(), "Build the cockpit");
  assert.deepEqual(await page.locator('.nav-column a[aria-current="page"] .nav-item-label').allInnerTexts(), ["Runs"], "a run page highlights Runs");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), "Map");
  assert.deepEqual(await tablist(page), {
    tabs: [["tab", "map", "true", "0", true], ["tab", "evidence", "false", "-1", true]],
    labelledBy: "map",
    panels: 1,
  });
  assert.equal(await page.locator('[role="tabpanel"] .rm-node').count() > 0, true, "the map renders inside the tabpanel");
  assert.equal(await page.locator('.rm-node[href="#task/task-1/explain"]').count(), 1, "a map node links to its task's Explain page");
  assert.match(await page.locator(".screen-line").innerText(), /Needs you: engineer is waiting at its gate · Run: forge gate task-1$/);

  // Arrow keys move along the tablist and navigate.
  await page.locator('[role="tab"][data-tab="map"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => location.hash === "#run/run-1/evidence");
  const evidence = page.locator(".run-evidence");
  await evidence.waitFor();
  await page.locator('[data-evidence="launches"] li').nth(1).waitFor();
  assert.deepEqual(await page.locator('[data-evidence="reviews"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href"))), ["#reviews/review-1"]);
  assert.deepEqual(await page.locator('[data-evidence="host-verifications"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href"))), ["#task/task-1/explain"]);
  assert.deepEqual(await page.locator('[data-evidence="launches"] li > a.mono').evaluateAll((as) => as.map((a) => a.getAttribute("href"))),
    ["/api/launches/launch-1", "/api/launches/launch-2"]);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), "Evidence");
  assert.deepEqual(await tablist(page), {
    tabs: [["tab", "map", "false", "-1", true], ["tab", "evidence", "true", "0", true]],
    labelledBy: "evidence",
    panels: 1,
  });
  assert.equal(await page.locator('[role="tabpanel"] .run-evidence').count(), 1, "the evidence renders inside the tabpanel");
  assert.ok(apiRequests.includes("/api/run/run-1/evidence"), "the evidence is read by run, unscoped");
  assert.ok(!apiRequests.some((u) => u.startsWith("/api/task/")), "the run page never fans out over its tasks");
  await page.screenshot({ path: join(SHOTS, "fg821-run-page-evidence.png"), fullPage: true });

  await page.goto(`${baseUrl}/#run/run-1/nonsense`);
  await page.waitForFunction(() => location.hash === "#run/run-1");
  await page.locator(".rm-node").first().waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-821: #run-map/<id> stays a permanent alias to the run page's map tab", async () => {
  const { page } = await open("#run-map/run-1");
  await page.waitForFunction(() => location.hash === "#run/run-1");
  await page.locator(".rm-node").first().waitFor();
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), "Map");
  await page.goto(`${baseUrl}/#run-map`);
  await page.waitForFunction(() => location.hash === "#runs");
  await page.locator(".route-notice", { hasText: "Open a run from the run index" }).waitFor();
  await page.close();
});

test("FG-821: a task page deep link survives reload, links its run, ticket, reviews, launches and verifications, and links to Explain and back", async () => {
  apiRequests.length = 0;
  const { page, errors } = await open("#task/task-1");
  await page.locator(".task-links").waitFor();
  await page.reload();
  await page.locator(".task-links").waitFor();
  assert.equal(hashOf(page), "#task/task-1");
  assert.equal(await page.locator(".page-title").innerText(), "engineer");
  assert.match(await page.locator(".task-page-body").innerText(), /engineer did the work/, "the result renders through the role renderer");
  assert.match(await page.locator(".task-page-body").innerText(), /hello from stdout/, "the stdout tail renders");
  assert.equal(await page.locator(".detail-overlay").count(), 0, "no modal overlay");
  const links = await page.locator(".task-links a").evaluateAll((as) => as.map((a) => [a.getAttribute("data-link"), a.getAttribute("href")]).filter(([k]) => k));
  assert.deepEqual(links, [
    ["run", "#run/run-1"],
    ["ticket", "#backlog/FG-9?project=atlas"],
    ["review", "#reviews/review-1"],
    ["launch", "/api/launches/launch-1"],
    ["host-verification", "#task/task-1/explain"],
  ]);
  assert.match(await page.locator(".screen-line").innerText(), /engineer is awaiting a gate · Needs you: engineer is waiting at its gate · Decide the gate: forge gate task-1/);
  assert.ok(!apiRequests.some((u) => u.startsWith("/api/task/task-1") && u.includes("project")), "an object page reads unscoped");
  await page.screenshot({ path: join(SHOTS, "fg821-task-page-breadcrumbs-links.png"), fullPage: true });

  assert.deepEqual(await tablist(page), {
    tabs: [["tab", "detail", "true", "0", true], ["tab", "explain", "false", "-1", true]],
    labelledBy: "detail",
    panels: 1,
  });
  assert.equal(await page.locator('[role="tabpanel"] .task-links').count(), 1, "the task body renders inside the tabpanel");
  await page.locator('[role="tab"][data-tab="explain"]').click();
  await page.waitForFunction(() => location.hash === "#task/task-1/explain");
  await page.locator(".rx-panel .rx-identity").waitFor();
  assert.equal(await page.locator(".page-title").innerText(), "Explain");
  assert.deepEqual(await tablist(page), {
    tabs: [["tab", "detail", "false", "-1", true], ["tab", "explain", "true", "0", true]],
    labelledBy: "explain",
    panels: 1,
  });
  assert.equal(await page.locator(".detail-overlay").count(), 0, "Explain is a page, not an overlay");
  await page.screenshot({ path: join(SHOTS, "fg821-explain-page.png"), fullPage: true });
  await page.reload();
  await page.locator(".rx-panel .rx-identity").waitFor();
  await page.locator('[role="tab"][data-tab="detail"]').click();
  await page.waitForFunction(() => location.hash === "#task/task-1");
  await page.locator(".task-links").waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-821: a failed task's header names forge show and the retry policy's advice from the payload", async () => {
  const { page } = await open("#task/task-3");
  await page.locator(".screen-line", { hasText: "forge show task-3" }).waitFor();
  assert.equal(
    await page.locator(".screen-line").innerText(),
    "engineer is failed (merge_conflict) · Needs you: engineer failed: merge_conflict · rebase the task branch onto the current base and resolve the conflict, or retry: forge show task-3",
  );
  await page.close();
});

test("FG-821: breadcrumbs come from the payload — an inbox click and a pasted link give the same trail", async () => {
  const expectedRun = [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "Build the cockpit", href: null },
  ];
  // Inbox click, from a scoped Home.
  const clicked = await open("#home?project=atlas");
  await clicked.page.locator(".inbox-link", { hasText: "Open run" }).first().click();
  await clicked.page.waitForFunction(() => location.hash === "#run/run-1");
  await waitFor(() => crumbs(clicked.page), expectedRun, "the inbox click's trail");
  // Then into a task through the map and on to Explain.
  await clicked.page.locator('.rm-node[href="#task/task-1/explain"]').click();
  await clicked.page.locator(".rx-panel").waitFor();
  const expectedExplain = [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "Build the cockpit", href: "#run/run-1" },
    { label: "engineer · task-1", href: "#task/task-1" },
    { label: "Explain", href: null },
  ];
  await waitFor(() => crumbs(clicked.page), expectedExplain, "the clicked-through Explain trail");

  // Pasted links, cold, unscoped.
  const pasted = await open("#run/run-1");
  await waitFor(() => crumbs(pasted.page), expectedRun, "a pasted run link gives the same trail");
  await pasted.page.goto(`${baseUrl}/#task/task-1/explain`);
  await waitFor(() => crumbs(pasted.page), expectedExplain, "a pasted Explain link gives the same trail");
  // List views show group and title, never a trail.
  await pasted.page.goto(`${baseUrl}/#runs`);
  await pasted.page.locator(".runs-table").waitFor();
  assert.equal(await pasted.page.locator(".breadcrumbs").count(), 0);
  assert.equal(await pasted.page.locator(".page-kicker").textContent(), "Evidence");
  await clicked.page.close();
  await pasted.page.close();
});

test("FG-821: the ticket-to-review trace has the same payload breadcrumbs as every cold object link", async () => {
  const expectedRun = [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "Build the cockpit", href: null },
  ];
  const expectedTask = [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "Build the cockpit", href: "#run/run-1" },
    { label: "engineer · task-1", href: null },
  ];
  const expectedExplain = [...expectedTask.slice(0, -1), { label: "engineer · task-1", href: "#task/task-1" }, { label: "Explain", href: null }];
  const expectedReview = [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "run-1", href: "#run/run-1" },
    { label: "review-1", href: null },
  ];
  const walked = await open("#backlog/FG-9?project=atlas");
  await walked.page.locator(".ticket-run-row a").first().click();
  await walked.page.locator(".rm-node").first().waitFor();
  await waitFor(() => crumbs(walked.page), expectedRun, "ticket run link trail");

  // A map node's legacy Explain entry still reaches a page. Escape exposes the task
  // parent; returning to Explain proves both object routes retain the same payload chain.
  await walked.page.locator('.rm-node[href="#task/task-1/explain"]').click();
  await walked.page.locator(".rx-panel").waitFor();
  await waitFor(() => crumbs(walked.page), expectedExplain, "map-node Explain trail");
  assert.equal(await walked.page.locator(".detail-overlay").count(), 0, "the map node did not open an overlay");
  await walked.page.keyboard.press("Escape");
  await walked.page.locator(".task-links").waitFor();
  await waitFor(() => crumbs(walked.page), expectedTask, "Explain Escape reaches the task parent");
  await walked.page.locator('[role="tab"][data-tab="explain"]').click();
  await walked.page.locator(".rx-panel").waitFor();
  await waitFor(() => crumbs(walked.page), expectedExplain, "task Explain tab trail");
  await walked.page.locator('[role="tab"][data-tab="detail"]').click();
  await walked.page.locator('.task-links a[data-link="review"]').click();
  await walked.page.locator(".review-page").waitFor();
  await waitFor(() => crumbs(walked.page), expectedReview, "review reached from the task");

  for (const [hash, expected] of [
    ["#run/run-1", expectedRun],
    ["#task/task-1", expectedTask],
    ["#task/task-1/explain", expectedExplain],
    ["#reviews/review-1", expectedReview],
  ] as const) {
    const pasted = await open(hash);
    await pasted.page.locator(".breadcrumbs").waitFor();
    await waitFor(() => crumbs(pasted.page), expected, `cold ${hash} trail`);
    await pasted.page.close();
  }
  await walked.page.close();
});

test("FG-821: Escape on an object page navigates to its parent — Explain to task, task to run, run to the index", async () => {
  const { page } = await open("#task/task-1/explain");
  await page.locator(".rx-panel .rx-identity").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#task/task-1");
  await page.locator(".task-links").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#run/run-1");
  await page.locator(".rm-node").first().waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#runs");
  await page.locator(".runs-table").waitFor();
  // A list view does not react to Escape.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(hashOf(page), "#runs");
  await page.close();
});

test("FG-821: the ticket page shows the ticket's fields and its runs, read with the scope in hand", async () => {
  apiRequests.length = 0;
  const { page, errors } = await open("#backlog/FG-9?project=atlas");
  await page.locator(".ticket-run-row").first().waitFor();
  assert.equal(await page.locator(".page-title").innerText(), "Wire the cockpit");
  assert.match(await page.locator(".ticket-fields").innerText(), /active[\s\S]*story[\s\S]*FG-9/);
  assert.equal(await page.locator(".ticket-run-row a").first().getAttribute("href"), "#run/run-1");
  assert.ok(apiRequests.some((u) => u.startsWith("/api/backlog/FG-9/runs") && new URL(u, baseUrl).searchParams.get("projectKey") === "atlas"),
    "the ticket's runs are read in the project's scope — ticket ids are per project");
  assert.deepEqual(await crumbs(page), [{ label: "Atlas", href: "#runs?project=atlas" }, { label: "FG-9", href: null }]);
  await page.screenshot({ path: join(SHOTS, "fg821-ticket-page.png"), fullPage: true });

  // The backlog list opens the page; Escape returns to the list.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#backlog?project=atlas");
  await page.locator(".backlog-ticket-card").first().click();
  await page.waitForFunction(() => location.hash === "#backlog/FG-9?project=atlas");
  await page.locator(".ticket-run-row").first().waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-821: a review opens by id even when the ledger window does not hold it", async () => {
  const { page } = await open("#reviews/review-1");
  await page.locator('.review-page .review-card[data-review-id="review-1"]').waitFor();
  assert.match(await page.locator(".review-page").innerText(), /an old finding/);
  assert.deepEqual(await crumbs(page), [
    { label: "Atlas", href: "#runs?project=atlas" },
    { label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { label: "run-1", href: "#run/run-1" },
    { label: "review-1", href: null },
  ]);
  await page.goto(`${baseUrl}/#reviews/review-missing`);
  await page.locator(".review-page [role=alert]", { hasText: "No review review-missing" }).waitFor();
  await page.close();
});

let pageSizeOverride: number | null = null;

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) apiRequests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
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
        : filePath.endsWith(".svg") ? "image/svg+xml"
          : filePath.endsWith(".png") ? "image/png"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/runs") {
      if (pageSizeOverride !== null && !url.searchParams.has("cursor") && Number(url.searchParams.get("limit")) > 1) {
        url.searchParams.set("limit", String(Math.min(pageSizeOverride, Number(url.searchParams.get("limit")))));
      }
      if (pageSizeOverride !== null && url.searchParams.has("cursor")) url.searchParams.set("limit", String(pageSizeOverride));
      const { status, body } = runsBody(url);
      json(body, status);
      return;
    }
    const evidenceMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/evidence$/);
    if (evidenceMatch) {
      const body = RUN_EVIDENCE[decodeURIComponent(evidenceMatch[1]!)];
      if (body) json(body);
      else json({ error: "not found" }, 404);
      return;
    }
    const mapMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/map$/);
    if (mapMatch) {
      const graph = runMap(decodeURIComponent(mapMatch[1]!));
      if (graph) json(graph);
      else json({ error: "not found" }, 404);
      return;
    }
    const explainMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/explain$/);
    if (explainMatch) {
      const id = decodeURIComponent(explainMatch[1]!);
      json({ taskId: id, role: "engineer", status: "awaiting_gate", warnings: [], workflowSource: { name: "feature", source: "seed", status: "recorded" } });
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (taskMatch) {
      const detail = DETAILS[decodeURIComponent(taskMatch[1]!)];
      if (detail) json(detail);
      else json({ error: "not found" }, 404);
      return;
    }
    if (url.pathname === "/api/attention-inbox") {
      json(inbox(url.searchParams.get("runId")));
      return;
    }
    const ticketRuns = url.pathname.match(/^\/api\/backlog\/([^/]+)\/runs$/);
    if (ticketRuns) {
      json({ ticketId: decodeURIComponent(ticketRuns[1]!), runs: [{ runId: "run-1", status: "active", title: "Build the cockpit", startedAt: ago(1) }] });
      return;
    }
    if (url.pathname === "/api/backlog") {
      json({
        notes: "",
        tickets: url.searchParams.get("projectKey") === "atlas"
          ? [{ id: "FG-9", type: "story", status: "active", title: "Wire the cockpit", body: "The cockpit body.", revision: 1 }]
          : [],
        ticketsProjectKey: url.searchParams.get("projectKey") ? "atlas" : null,
        ticketsStorageMode: "db",
      });
      return;
    }
    const reviewMatch = url.pathname.match(/^\/api\/review\/([^/]+)$/);
    if (reviewMatch) {
      if (decodeURIComponent(reviewMatch[1]!) === "review-1") json(REVIEW);
      else json({ error: "review not found" }, 404);
      return;
    }
    if (url.pathname === "/api/reviews") {
      json({ reviews: [] });
      return;
    }
    if (url.pathname === "/api/projects") {
      json([{ key: "atlas", label: "Atlas", color: "#345", classification: "independent", checkouts: [{ projectDir: MAIN, branch: "main", exists: true }] }]);
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      json({ generatedAt: new Date(0).toISOString(), services: [] });
      return;
    }
    if (url.pathname === "/api/ops") {
      json({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      });
      return;
    }
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
