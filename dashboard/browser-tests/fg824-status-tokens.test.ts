// FG-824: the status token map, the freshness signal and the recovery card in a real
// browser. The real client is booted against a fixture server: every inbox kind and task
// status must paint through its token (asserted by class and computed colour), an unknown
// value must paint the neutral fallback, a launch row must say how long the observer has
// been silent — measured by the payload's own generatedAt, the injected clock — and a task
// awaiting recovery must show one card naming its next verb, a button when the FG-822
// preview (the REAL `previewTaskActions`) admits it and the policy's advice when it does not.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { previewTaskActions } from "../src/action-mutation.js";
import { ATTENTION_ITEM_KINDS } from "../src/attention-inbox.js";
import { TASK_STATUSES } from "@forge/types";
import { statusToken } from "../client/status-tokens.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18832;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG824_SCREENSHOT_DIR ?? join(tmpdir(), "fg824-screenshots");
mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas-main";
const UNKNOWN_KIND = "kind_from_a_newer_host";
const UNKNOWN_STATUS = "status_from_a_newer_host";
// The injected clock: every freshness reading is generatedAt − observedAt, both served here.
const GENERATED_AT = "2026-09-29T12:00:00.000Z";
const minutesBefore = (m: number) => new Date(Date.parse(GENERATED_AT) - m * 60_000).toISOString();
const millisecondsBefore = (ms: number) => new Date(Date.parse(GENERATED_AT) - ms).toISOString();
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

type TaskState = { status: string; failureKind: string | null; events: unknown[] };
let tasks: Record<string, TaskState> = {};
let posts: Array<{ path: string; body: unknown }> = [];

function reset(): void {
  tasks = {
    "task-fanout": {
      status: "failed",
      failureKind: "fanout_wave_orphaned",
      events: [
        { eventType: "task.failed", createdAt: ago(3), payload: { failure_kind: "fanout_wave_orphaned" } },
        { eventType: "task.reconciled", createdAt: ago(2), payload: { from: "failed", to: "redriven", reason: "fanout_wave_redriven", via: "forge recover --re-drive" } },
      ],
    },
    "task-orphan": { status: "failed", failureKind: "orphaned_work_may_persist", events: [] },
    "task-park": { status: "awaiting_recovery", failureKind: null, events: [] },
    "task-done": { status: "complete", failureKind: null, events: [] },
  };
  posts = [];
}
reset();

function detail(id: string) {
  const t = tasks[id]!;
  return {
    task: {
      taskId: id, runId: "run-1", runTitle: "Recover the wave", workflow: "feature", projectDir: MAIN, projectLabel: "Atlas", projectColor: "#345",
      checkoutBranch: "main", checkoutName: null, agentRole: "engineer", agentModel: "opus", mappingPath: null, capabilitySource: null,
      phase: "build", status: t.status, completedAt: ago(1), durationMs: 1000, result: { diff_summary: "work" }, parentId: null,
    },
    links: { runId: "run-1", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] },
    stdoutLog: null, stderrLog: null, stdoutBytes: 0, stderrBytes: 0, verdicts: [], gates: [], events: t.events,
    failureKind: t.failureKind, idle: null, resultSizeBytes: 10,
  };
}

function inbox() {
  const kinds = [...ATTENTION_ITEM_KINDS, UNKNOWN_KIND];
  const items = kinds.map((kind, i) => ({
    id: `att-${kind}`, kind, severity: "medium", startedAt: ago(i + 1), reason: `reason for ${kind}`,
    requestedAction: `act on ${kind}`, openState: "open", source: "fixture",
    links: { runId: `run-${i}`, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: MAIN, projectLabel: "Atlas" },
  }));
  return {
    generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null }, degraded: [],
    items, empty: false, counts: { open: items.length, high: 0 },
  };
}

function inFlight() {
  return [...TASK_STATUSES, UNKNOWN_STATUS].map((status) => ({
    taskId: `task-${status}`, runId: `run-${status}`, runTitle: `run ${status}`, workflow: "feature", phase: "build",
    agentRole: "engineer", agentModel: null, mappingPath: null, capabilitySource: null, status, startedAt: ago(1),
    projectDir: MAIN, projectLabel: "Atlas", projectColor: "#345", checkoutBranch: "main", checkoutName: null,
    orchestrator: null, reconcile: null,
  }));
}

function launch(id: string, observedMinutesAgo: number, over: Record<string, unknown> = {}) {
  return {
    launchId: id, name: id, command: ["npm", "test"], commandLine: "npm test", projectDir: MAIN, projectLabel: "Atlas",
    associationKind: "explicit", purpose: "host_verification", unassociated: false, placement: "run",
    runId: "run-1", taskId: null, ticketId: id.toUpperCase(), campaignId: null, itemId: null,
    startedAt: minutesBefore(120), observedAt: minutesBefore(observedMinutesAgo),
    status: { state: "running" }, recordedStatus: { state: "running" }, statusLabel: "running", observation: "fresh",
    ...over,
  };
}

function currentActivity() {
  return {
    generatedAt: GENERATED_AT,
    scope: { runId: null, projectDirs: null },
    agents: [],
    hostVerification: [launch("fresh-14", 14), launch("quiet-20", 20)],
    launches: [
      launch("fresh-14m59s", 0, { purpose: "generic", observedAt: millisecondsBefore(14 * 60_000 + 59_000) }),
      launch("quiet-15", 15, { purpose: "generic" }),
      launch("quiet-59m59s", 0, { purpose: "generic", observedAt: millisecondsBefore(59 * 60_000 + 59_000) }),
      launch("silent-60", 60, {
        purpose: "generic", status: { state: "unknown" }, statusLabel: `unobserved since ${minutesBefore(60)}`, observation: "unobserved",
      }),
      launch("done-90", 90, {
        purpose: "generic", status: { state: "exited_ok", code: 0 }, recordedStatus: { state: "exited_ok", code: 0 }, statusLabel: "exited 0",
      }),
    ],
    requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
    ciWaits: [],
    operatorWaits: [],
    unassociated: [],
  };
}

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

async function open(hash: string, width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const colorOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

test("FG-824: every inbox kind paints through its token, and an unknown kind paints the neutral fallback", async () => {
  reset();
  const { page, errors } = await open("#home");
  const inboxSection = page.locator("section.attention-inbox");
  await inboxSection.locator(`.inbox-row[data-item-id="att-${UNKNOWN_KIND}"]`).waitFor();
  const fallbackColor = await colorOf(page, ".badge.inbox-kind-unknown");
  for (const kind of ATTENTION_ITEM_KINDS) {
    const token = statusToken("inbox", kind);
    const row = inboxSection.locator(`.inbox-row[data-item-id="att-${kind}"]`);
    const badge = row.locator(`.badge.${token.class}`);
    assert.equal(await badge.count(), 1, `${kind} renders its token class ${token.class}`);
    assert.equal(await badge.innerText(), token.label, `${kind} renders its token label`);
    assert.match(await row.getAttribute("class") ?? "", new RegExp(`\\btone-accent-${token.tone}\\b`), `${kind}'s row carries its tone accent`);
    assert.notEqual(await badge.evaluate((el) => getComputedStyle(el).color), fallbackColor, `${kind} is toned, not neutral`);
  }
  const unknownRow = inboxSection.locator(`.inbox-row[data-item-id="att-${UNKNOWN_KIND}"]`);
  assert.equal(await unknownRow.locator(".badge.inbox-kind-unknown").innerText(), `${UNKNOWN_KIND} (unrecognized)`);
  assert.match(await unknownRow.getAttribute("class") ?? "", /\btone-accent-neutral\b/);
  assert.equal(await unknownRow.locator(".badge.inbox-kind-unknown").evaluate((el) => getComputedStyle(el).fontStyle), "italic");
  await inboxSection.screenshot({ path: join(SHOTS, "fg824-inbox-all-kinds.png") });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-824: every task status paints through its token, and an unknown status paints the neutral fallback", async () => {
  reset();
  const { page, errors } = await open("#home");
  const inFlightSection = page.locator("section.home-view section.in-flight");
  await inFlightSection.locator(".badge.status-unknown").waitFor();
  const colors = new Map<string, string>();
  for (const status of TASK_STATUSES) {
    const token = statusToken("task", status);
    const row = inFlightSection.locator(".item", { has: page.locator(`a[href="#task/task-${status}"]`) });
    const badge = row.locator(".badge").first();
    assert.match(await badge.getAttribute("class") ?? "", new RegExp(`\\b${token.class}\\b`), `${status} renders ${token.class}`);
    assert.equal(await badge.innerText(), token.label);
    colors.set(status, await badge.evaluate((el) => getComputedStyle(el).color));
  }
  const unknown = inFlightSection.locator(".item", { has: page.locator(`a[href="#task/task-${UNKNOWN_STATUS}"]`) }).locator(".badge").first();
  assert.match(await unknown.getAttribute("class") ?? "", /\bstatus-unknown\b/);
  assert.equal(await unknown.innerText(), `${UNKNOWN_STATUS} (unrecognized)`, "never blank, never the raw value alone");
  assert.notEqual(colors.get("failed"), colors.get("complete"), "tones stay distinct");
  assert.notEqual(colors.get("awaiting_recovery"), colors.get("running"));
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-824: a launch row says how long it has gone unobserved — suspicious at 15 min, critical at 60, by the payload's clock", async () => {
  reset();
  // Home's In flight: only fresh, running, associated launches reach it (server cutoff 30 min).
  const home = await open("#home");
  const quiet = home.page.locator('.ca-host-wait-row[data-launch-id="quiet-20"]');
  await quiet.waitFor();
  assert.equal(await quiet.locator(".freshness").innerText(), "unobserved for 20 min");
  assert.equal(await quiet.locator(".freshness").getAttribute("data-freshness"), "suspicious");
  assert.match(await quiet.locator(".freshness").getAttribute("title") ?? "", /Nothing has been changed/);
  assert.equal(await home.page.locator('.ca-host-wait-row[data-launch-id="fresh-14"] .freshness').count(), 0, "under 15 min says nothing");
  assert.match(await quiet.locator(".badge").getAttribute("class") ?? "", /launch-state-running/, "the signal changes nothing about the row's state");
  await home.page.locator("section.home-view section.in-flight").screenshot({ path: join(SHOTS, "fg824-in-flight-freshness.png") });
  await home.page.close();

  // The Activity view's diagnostic launch rows carry the whole range.
  const activity = await open("#activity");
  await activity.page.locator("details.activity-diagnostics > summary").click();
  const rowFor = (name: string) => activity.page.locator(".ca-launch-row", { hasText: name });
  await rowFor("silent-60").waitFor();
  assert.equal(await rowFor("quiet-15").locator(".freshness").innerText(), "unobserved for 15 min");
  assert.equal(await rowFor("quiet-15").locator(".freshness").getAttribute("data-freshness"), "suspicious");
  assert.equal(await rowFor("silent-60").locator(".freshness").innerText(), "unobserved for 60 min");
  assert.equal(await rowFor("silent-60").locator(".freshness").getAttribute("data-freshness"), "critical");
  assert.match(await rowFor("silent-60").locator(".badge").first().getAttribute("class") ?? "", /launch-state-unobserved/);
  assert.equal(await rowFor("done-90").locator(".freshness").count(), 0, "a terminal outcome does not decay");
  const suspicious = await colorOf(activity.page, ".freshness-suspicious");
  const critical = await colorOf(activity.page, ".freshness-critical");
  assert.notEqual(suspicious, critical, "the two thresholds read as two tones");
  assert.deepEqual([...home.errors, ...activity.errors], []);
  assert.deepEqual(posts, [], "the signal is informational: nothing was posted");
  await activity.page.close();
});

test("FG-824: freshness changes only at the exact injected-clock thresholds, and a live observation stays silent", async () => {
  reset();
  const { page, errors } = await open("#activity");
  await page.locator("details.activity-diagnostics > summary").click();
  const rowFor = (name: string) => page.locator(".ca-launch-row", { hasText: name });
  await rowFor("quiet-59m59s").waitFor();

  // generatedAt is fixed above: these rows must not consult the browser clock.
  assert.equal(await rowFor("fresh-14m59s").locator(".freshness").count(), 0);
  assert.equal(await rowFor("quiet-15").locator(".freshness").innerText(), "unobserved for 15 min");
  assert.equal(await rowFor("quiet-59m59s").locator(".freshness").innerText(), "unobserved for 59 min");
  assert.equal(await rowFor("quiet-59m59s").locator(".freshness").getAttribute("data-freshness"), "suspicious");
  assert.equal(await rowFor("silent-60").locator(".freshness").innerText(), "unobserved for 60 min");
  assert.equal(await rowFor("silent-60").locator(".freshness").getAttribute("data-freshness"), "critical");
  assert.equal(await rowFor("fresh-14m59s").locator(".badge.launch-state-running").count(), 1);
  await page.screenshot({ path: join(SHOTS, "fg824-freshness-boundaries.png"), fullPage: false });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-824: the recovery card names the failure, the last forge recover and the next verb — a button when the preview admits it, advice when not", async () => {
  reset();
  const { page, errors } = await open("#task/task-fanout");
  const card = page.locator(".recovery-card");
  await card.locator(".recovery-action").waitFor();
  assert.equal(await card.locator(".recovery-kind").innerText(), "fanout_wave_orphaned");
  assert.match(await card.locator(".recovery-last").innerText(), /forge recover --re-drive: failed → redriven \(fanout_wave_redriven\)/);
  assert.equal(await card.locator(".recovery-action").innerText(), "forge recover task-fanout --re-drive");
  assert.match(await card.getAttribute("class") ?? "", /\btone-accent-err\b/);
  await card.locator(".recovery-action").click();
  assert.equal(await card.locator(".action-preview-verb").innerText(), "forge recover task-fanout --re-drive");
  assert.deepEqual(posts, [], "previewing posts nothing");
  await page.screenshot({ path: join(SHOTS, "fg824-task-recovery-card.png"), fullPage: false });
  await card.locator(".action-confirm").click();
  await card.locator(".action-result").waitFor();
  assert.deepEqual(posts, [{ path: "/api/task/task-fanout/recover-re-drive", body: {} }]);
  assert.equal(await card.locator(".action-result-line").innerText(), "forge recover task-fanout --re-drive exited 0");
  assert.equal(await page.locator(".toast").count(), 0, "no toast for a result already on screen");
  await page.close();

  const orphan = await open("#task/task-orphan");
  const orphanCard = orphan.page.locator(".recovery-card");
  await orphanCard.locator(".recovery-verb").waitFor();
  await orphan.page.waitForFunction(() => !document.querySelector(".recovery-card")?.textContent?.includes("reading the action preview"));
  assert.equal(await orphanCard.locator(".recovery-action").count(), 0, "an ineligible re-drive is never a button");
  assert.equal(await orphanCard.locator(".recovery-verb").innerText(), "forge recover task-orphan");
  assert.ok((await orphanCard.locator(".recovery-advice").innerText()).length > 0, "the retry policy's advice is shown");
  assert.equal(await orphanCard.locator(".recovery-last").innerText(), "none recorded");
  await orphan.page.close();

  const park = await open("#task/task-park");
  const parkCard = park.page.locator(".recovery-card");
  await parkCard.locator(".recovery-verb").waitFor();
  assert.equal(await parkCard.locator(".recovery-kind").innerText(), "awaiting_recovery");
  assert.equal(await parkCard.locator(".recovery-verb").innerText(), "forge next run-1");
  assert.match(await parkCard.locator(".badge.status-awaiting_recovery").innerText(), /awaiting recovery/);
  await park.page.close();

  const done = await open("#task/task-done");
  await done.page.locator(".task-page-body").waitFor();
  assert.equal(await done.page.locator(".recovery-card").count(), 0, "a task with nothing to recover has no card");
  await done.page.close();
  assert.deepEqual([...errors, ...orphan.errors, ...park.errors, ...done.errors], []);
});

test("FG-824 / FG-692: the recovery button is keyboard reachable, Enter opens its preview and Tab reaches Confirm", async () => {
  reset();
  const { page, errors } = await open("#task/task-fanout");
  const button = page.locator(".recovery-card .recovery-action");
  await button.waitFor();
  // Walk the real tab order from the top of the page rather than focusing the button directly.
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await button.evaluate((el) => el === document.activeElement);
  }
  assert.ok(reached, "Tab reaches the recovery button");
  await page.keyboard.press("Enter");
  await page.locator(".recovery-card .action-preview-verb").waitFor();
  assert.equal(await button.getAttribute("aria-expanded"), "true");
  let confirm = false;
  for (let i = 0; i < 5 && !confirm; i++) {
    await page.keyboard.press("Tab");
    confirm = await page.locator(".recovery-card .action-confirm").evaluate((el) => el === document.activeElement);
  }
  assert.ok(confirm, "Tab moves on to Confirm");
  assert.deepEqual(posts, [], "reaching Confirm by keyboard posts nothing");
  assert.deepEqual(errors, []);
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
        : filePath.endsWith(".png") ? "image/png"
          : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    const actionsMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/actions$/);
    if (actionsMatch) {
      const id = decodeURIComponent(actionsMatch[1]!);
      const t = tasks[id];
      if (!t) return json({ error: "not found" }, 404);
      const preview = previewTaskActions({ taskId: id, status: t.status, failureKind: t.failureKind, dispatchSource: "workflow" });
      return json({ ...preview, mutations: { available: true, reason: null } });
    }
    const postMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/(gate|retry|recover-re-drive)$/);
    if (postMatch && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const id = decodeURIComponent(postMatch[1]!);
        posts.push({ path: url.pathname, body: JSON.parse(raw || "{}") });
        const verb = postMatch[2] === "recover-re-drive" ? `forge recover ${id} --re-drive` : `forge ${postMatch[2]} ${id}`;
        return json({ ok: true, action: postMatch[2], verb, exitCode: 0, stdout: `Re-drove ${id}.`, stderr: "" });
      });
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]!);
      return tasks[id] ? json(detail(id)) : json({ error: "not found" }, 404);
    }
    if (url.pathname === "/api/attention-inbox") {
      return url.searchParams.get("runId")
        ? json({ generatedAt: new Date().toISOString(), scope: { runId: url.searchParams.get("runId"), projectDirs: null }, degraded: [], items: [], empty: true, counts: { open: 0, high: 0 } })
        : json(inbox());
    }
    if (url.pathname === "/api/current-activity") return json(currentActivity());
    if (url.pathname === "/api/in-flight") return json(inFlight());
    if (url.pathname === "/api/runs") return json({ runs: [], activeCount: 1, nextCursor: null, generatedAt: new Date().toISOString() });
    if (url.pathname === "/api/backlog") return json({ notes: "", tickets: [], ticketsProjectKey: null, ticketsStorageMode: "db" });
    if (url.pathname === "/api/reviews") return json({ reviews: [] });
    if (url.pathname === "/api/projects") {
      return json([{ key: "atlas", label: "Atlas", color: "#345", classification: "independent", checkouts: [{ projectDir: MAIN, branch: "main", exists: true }] }]);
    }
    if (url.pathname === "/api/usage/limits") return json({ generatedAt: new Date(0).toISOString(), services: [] });
    if (url.pathname === "/api/ops") {
      return json({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 }, failureKinds: [], durations: [],
      });
    }
    if (["/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      return json([]);
    }
    json({ error: "not in this fixture" }, 404);
  });
}
