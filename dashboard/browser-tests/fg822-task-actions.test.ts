// FG-822: the task actions in the browser — the task page's buttons on its screen line,
// the preview before Confirm, the rationale a gate requires, the verb's result inline, and
// an attention-inbox row whose resolving button replaces the copy-paste requestedAction.
//
// The real client is booted against a fixture server. Its preview is the REAL server-side
// decision (`previewTaskActions` from action-mutation.ts), so the buttons the browser shows
// are the ones the dashboard would offer; the POST routes record what they were sent and
// answer with a verb's result.

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
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18826;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG822_SCREENSHOT_DIR ?? join(tmpdir(), "fg822-screenshots");
mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas-main";
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

type TaskState = { status: string; failureKind: string | null; role: string };
let tasks: Record<string, TaskState> = {};
let mutationsAvailable = true;
let posts: Array<{ path: string; body: unknown }> = [];
let cliFails = false;

function reset(): void {
  tasks = {
    "task-1": { status: "awaiting_gate", failureKind: null, role: "engineer" },
    "task-3": { status: "failed", failureKind: "container_crash", role: "engineer" },
    "task-4": { status: "failed", failureKind: "auth_expired", role: "engineer" },
  };
  mutationsAvailable = true;
  posts = [];
  cliFails = false;
}
reset();

function detail(id: string) {
  const t = tasks[id]!;
  return {
    task: {
      taskId: id, runId: "run-1", runTitle: "Build the cockpit", workflow: "feature", projectDir: MAIN, projectLabel: "Atlas", projectColor: "#345",
      checkoutBranch: "main", checkoutName: null, agentRole: t.role, agentModel: "opus", mappingPath: null, capabilitySource: null,
      phase: "build", status: t.status, completedAt: ago(1), durationMs: 1000, result: { diff_summary: `${t.role} did the work` }, parentId: null,
    },
    links: { runId: "run-1", ticketId: "FG-9", reviewIds: [], launchIds: [], hostVerificationIds: [] },
    stdoutLog: null, stderrLog: null, stdoutBytes: 0, stderrBytes: 0, verdicts: [], gates: [], events: [],
    failureKind: t.failureKind, idle: null, resultSizeBytes: 10,
  };
}

function inbox(runId: string | null) {
  const links = (taskId: string) => ({ runId: "run-1", taskId, ticketId: "FG-9", campaignId: null, itemId: null, projectDir: MAIN, projectLabel: "Atlas" });
  const all = [
    { id: "att-gate", kind: "waiting_gate", severity: "medium", startedAt: ago(1), reason: "engineer is waiting at its gate", requestedAction: "forge gate task-1", openState: "open", source: "fixture", links: links("task-1") },
    { id: "att-crash", kind: "failed_task", severity: "high", startedAt: ago(2), reason: "engineer failed: container_crash", requestedAction: "transient infrastructure failure; re-dispatch", openState: "open", source: "fixture", links: links("task-3") },
    { id: "att-auth", kind: "auth_setup", severity: "high", startedAt: ago(3), reason: "the auth session expired", requestedAction: "refresh the session/profile before retrying", openState: "open", source: "fixture", links: links("task-4") },
  ];
  const items = all.filter((item) => tasks[item.links.taskId]!.status === "awaiting_gate" || tasks[item.links.taskId]!.status === "failed");
  return {
    generatedAt: new Date().toISOString(), scope: { runId, projectDirs: null }, degraded: [],
    items, empty: items.length === 0, counts: { open: items.length, high: items.filter((i) => i.severity === "high").length },
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

async function open(hash: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const buttonLabels = (page: Page, scope: string) => page.locator(`${scope} .action-btn`).allInnerTexts();

test("FG-822: the task page shows only eligible actions, each labeled with its verb, and a refused one's advice instead of a button", async () => {
  reset();
  const { page, errors } = await open("#task/task-1");
  await page.locator(".task-page .action-btn").first().waitFor();
  assert.deepEqual(await buttonLabels(page, ".task-page"), [
    "forge gate task-1 advance", "forge gate task-1 reject", "forge gate task-1 request-changes",
  ]);
  const order = await page.evaluate(() => {
    const line = document.querySelector(".task-page .screen-line");
    const actions = document.querySelector(".task-page .task-actions");
    return !!line && !!actions && (line.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      && !actions.closest(".object-tabpanel");
  });
  assert.ok(order, "the buttons sit on the header's what-do-I-do line, above the tabs");
  assert.equal(await page.locator(".task-page .action-btn .badge, .nav-column .action-btn").count(), 0, "buttons are never badge-bearing");
  await page.locator('.task-page .action-btn[data-decision="advance"]').click();
  await page.locator(".action-rationale").waitFor();
  await page.screenshot({ path: join(SHOTS, "fg822-task-page-gate-buttons.png") });
  await page.close();

  // A failed task whose kind has advice: no button — the refusal names the precondition.
  const auth = await open("#task/task-4");
  await auth.page.locator(".task-page .action-refused-advised").waitFor();
  assert.equal(await auth.page.locator(".task-page .action-btn").count(), 0, "a refused retry is never a button");
  const advised = await auth.page.locator(".task-page .action-refused-advised li").allInnerTexts();
  assert.equal(advised.length, 1);
  assert.match(advised[0]!, /forge retry task-4 — auth_expired needs a human precondition before a retry\s+refresh the session\/profile before retrying/);
  await auth.page.close();

  // A dashboard whose bind refuses mutations shows the reason and no buttons.
  mutationsAvailable = false;
  const off = await open("#task/task-1");
  await off.page.locator(".task-page .action-note").waitFor();
  assert.match(await off.page.locator(".task-page .action-note").innerText(), /not loopback/);
  assert.equal(await off.page.locator(".task-page .action-btn").count(), 0);
  await off.page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(posts, [], "nothing was posted by looking");
});

test("FG-822 / FG-692: task and inbox action buttons are keyboard reachable and Enter opens their preview", async () => {
  reset();
  const task = await open("#task/task-1");
  const taskButton = task.page.locator('.task-page .action-btn[data-decision="reject"]');
  await taskButton.focus();
  assert.equal(await taskButton.evaluate((element) => element === document.activeElement), true, "the task action is focusable");
  await task.page.keyboard.press("Enter");
  await task.page.locator(".action-preview-verb").waitFor();
  assert.equal(await task.page.locator(".action-preview-verb").innerText(), 'forge gate task-1 reject --rationale "<rationale>"');
  await task.page.close();

  const inbox = await open("#home");
  const inboxButton = inbox.page.locator('.inbox-row[data-item-id="att-crash"] .action-btn');
  await inboxButton.focus();
  assert.equal(await inboxButton.evaluate((element) => element === document.activeElement), true, "the inbox action is focusable");
  await inbox.page.keyboard.press("Enter");
  await inbox.page.locator('.inbox-row[data-item-id="att-crash"] .action-preview-verb').waitFor();
  assert.equal(await inbox.page.locator('.inbox-row[data-item-id="att-crash"] .action-preview-verb').innerText(), "forge retry task-3");
  assert.deepEqual(posts, [], "opening a keyboard preview does not mutate");
  assert.deepEqual([...task.errors, ...inbox.errors], []);
  await inbox.page.close();
});

test("FG-822: a gate decision previews its verb before Confirm and refuses to send without a rationale", async () => {
  reset();
  const { page, errors } = await open("#task/task-1");
  await page.locator('.task-page .action-btn[data-decision="request-changes"]').click();
  const verb = page.locator(".action-preview-verb");
  assert.equal(await verb.innerText(), 'forge gate task-1 request-changes --rationale "<rationale>"', "the verb shows before confirm");
  assert.deepEqual(posts, [], "choosing an action posts nothing");

  await page.locator(".action-confirm").click();
  assert.equal(await page.locator(".action-error").innerText(), "A rationale is required for every gate decision.");
  assert.deepEqual(posts, [], "no rationale, no request");

  await page.locator(".action-rationale").fill("Tighten the test before this ships.");
  assert.equal(await verb.innerText(), 'forge gate task-1 request-changes --rationale "Tighten the test before this ships."');
  await page.screenshot({ path: join(SHOTS, "fg822-preview-confirm.png") });
  // Escape in the rationale field is the field's, not the page's.
  await page.locator(".action-rationale").press("Escape");
  assert.equal(new URL(page.url()).hash, "#task/task-1");

  await page.locator(".action-cancel").click();
  assert.equal(await page.locator(".action-preview").count(), 0, "Cancel closes the preview");
  assert.deepEqual(posts, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-822: a confirmed action renders the verb's exit status and output inline, and the page re-reads", async () => {
  reset();
  const { page, errors } = await open("#task/task-1");
  await page.locator('.task-page .action-btn[data-decision="advance"]').click();
  await page.locator(".action-rationale").fill("Reviewed the diff; ship it.");
  await page.locator(".action-confirm").click();
  await page.locator(".action-result").waitFor();
  assert.deepEqual(posts, [{ path: "/api/task/task-1/gate", body: { decision: "advance", rationale: "Reviewed the diff; ship it." } }]);
  assert.equal(await page.locator(".action-result-line").innerText(), "forge gate task-1 advance exited 0");
  assert.match(await page.locator(".action-result-output").innerText(), /Gate advance: task-1/);
  assert.ok(await page.locator(".action-result-ok").isVisible());
  // The task moved on: the page re-read it and the gate buttons are gone, the result stays.
  await page.waitForFunction(() => document.querySelectorAll(".task-page .action-btn").length === 0);
  await page.locator(".screen-line").filter({ hasText: /engineer is complete · Nothing needs you/ }).waitFor();
  assert.equal(await page.locator(".task-page .action-result").count(), 1);
  assert.equal(await page.locator(".toast, [role=alert].toast").count(), 0, "no toast for state already on screen");
  await page.screenshot({ path: join(SHOTS, "fg822-inline-result.png") });
  await page.close();

  // The CLI's own refusal renders inline too, with its exit status.
  reset();
  cliFails = true;
  const failed = await open("#task/task-3");
  await failed.page.locator('.task-page .action-btn[data-action="retry"]').click();
  assert.equal(await failed.page.locator(".action-preview-verb").innerText(), "forge retry task-3");
  assert.equal(await failed.page.locator(".action-rationale").count(), 0, "a retry takes no rationale");
  await failed.page.locator(".action-confirm").click();
  await failed.page.locator(".action-result-fail").waitFor();
  assert.equal(await failed.page.locator(".action-result-line").innerText(), "forge retry task-3 exited 1");
  assert.match(await failed.page.locator(".action-result-output").innerText(), /forge retry: Task task-3 is in status/);
  await failed.page.close();
  assert.deepEqual([...errors, ...failed.errors], []);
});

test("FG-822: an inbox row's resolving verb button replaces the requestedAction and acts in place", async () => {
  reset();
  const { page, errors } = await open("#home");
  const crashRow = page.locator('.inbox-row[data-item-id="att-crash"]');
  await crashRow.locator(".action-btn").waitFor();
  assert.deepEqual(await buttonLabels(page, '.inbox-row[data-item-id="att-crash"]'), ["forge retry task-3"]);
  assert.equal(await crashRow.locator(".inbox-action").count(), 0, "the verb button replaces the copy-paste string");
  assert.deepEqual(await buttonLabels(page, '.inbox-row[data-item-id="att-gate"]'), [
    "forge gate task-1 advance", "forge gate task-1 reject", "forge gate task-1 request-changes",
  ]);
  const authRow = page.locator('.inbox-row[data-item-id="att-auth"]');
  await page.waitForFunction(() => document.querySelectorAll(".inbox-row .action-btn").length === 4);
  assert.equal(await authRow.locator(".action-btn").count(), 0, "a row whose task has no eligible action keeps its requestedAction");
  assert.equal(await authRow.locator(".inbox-action").innerText(), "refresh the session/profile before retrying");
  await page.screenshot({ path: join(SHOTS, "fg822-inbox-row-button.png") });

  await crashRow.locator(".action-btn").click();
  assert.equal(await crashRow.locator(".action-preview-verb").innerText(), "forge retry task-3");
  await crashRow.locator(".action-confirm").click();
  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="att-crash"]'));
  assert.deepEqual(posts, [{ path: "/api/task/task-3/retry", body: {} }]);
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
      return json({
        ...preview,
        mutations: mutationsAvailable
          ? { available: true, reason: null }
          : { available: false, reason: "task actions are refused because this dashboard is bound to 0.0.0.0, not loopback." },
      });
    }
    const postMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/(gate|retry|recover-re-drive)$/);
    if (postMatch && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const id = decodeURIComponent(postMatch[1]!);
        const body = JSON.parse(raw || "{}") as { decision?: string };
        posts.push({ path: url.pathname, body });
        const verb = postMatch[2] === "gate" ? `forge gate ${id} ${body.decision}` : postMatch[2] === "retry" ? `forge retry ${id}` : `forge recover ${id} --re-drive`;
        if (cliFails) {
          const stderr = `forge retry: Task ${id} is in status 'pending', not failed.`;
          return json({ ok: false, action: postMatch[2], verb, exitCode: 1, stdout: "", stderr, error: stderr }, 409);
        }
        tasks[id] = { ...tasks[id]!, status: postMatch[2] === "gate" ? "complete" : "pending", failureKind: null };
        const stdout = postMatch[2] === "gate" ? `Gate ${body.decision}: ${id}\n\nNext:\n  forge next run-1` : `Reset ${id} to pending.`;
        return json({ ok: true, action: postMatch[2], verb, exitCode: 0, stdout, stderr: "" });
      });
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]!);
      return tasks[id] ? json(detail(id)) : json({ error: "not found" }, 404);
    }
    if (url.pathname === "/api/attention-inbox") return json(inbox(url.searchParams.get("runId")));
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
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      return json([]);
    }
    json({ error: "not in this fixture" }, 404);
  });
}
