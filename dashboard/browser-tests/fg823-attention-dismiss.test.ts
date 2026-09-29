// FG-823: dismiss and snooze on the Home Attention inbox, in a real browser.
//
// The fixture's inbox is the REAL core composition (`composeInbox` with the dismissal rows
// the fixture holds), so which rows show, what the `dismissed` section carries and the
// Home badge's counts are all decided server-side exactly as the dashboard decides them.
// The three POST routes record what they were sent and write the fixture's rows as the
// CLI would. The browser stores nothing: localStorage/sessionStorage stay empty.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { previewTaskActions } from "../src/action-mutation.js";
import { composeInbox, type AttentionItem } from "../../src/v2/attention-inbox.js";
import { parseSnoozeUntil, type AttentionDismissal } from "../../src/store/attention-dismissals.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18828;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG823_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg823-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const MAIN = "/repos/atlas-main";
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

let startedAt: Record<string, string> = {};
let rows: AttentionDismissal[] = [];
let posts: Array<{ path: string; body: Record<string, unknown> }> = [];

function reset(): void {
  startedAt = { "task:task-auth": ago(3), "wait:gate-1": ago(2), "readiness:FG-7": ago(1) };
  rows = [];
  posts = [];
}
reset();

function item(id: string, kind: AttentionItem["kind"], severity: AttentionItem["severity"], reason: string, requestedAction: string, taskId: string | null = null): AttentionItem {
  return {
    id, kind, severity, startedAt: startedAt[id]!, reason, requestedAction, openState: "open", source: "fixture",
    links: { runId: null, taskId, ticketId: null, campaignId: null, itemId: null, projectDir: MAIN, projectLabel: "Atlas" },
  };
}

function inbox() {
  return composeInbox(
    [[
      item("task:task-auth", "auth_setup", "high", "the auth session expired", "refresh the session/profile"),
      item("wait:gate-1", "waiting_gate", "medium", "architect is waiting at its gate", "forge gate task-1", "task-1"),
      item("readiness:FG-7", "missing_acceptance_or_readiness", "medium", "acceptance criteria need refinement", "refine FG-7"),
    ]],
    { generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null }, dismissals: rows.filter((r) => r.state === "active") },
  );
}

/** What `forge attention dismiss|snooze|undismiss` does to the store, for the fixture. */
function write(itemKey: string, action: string, body: Record<string, unknown>): { status: number; payload: Record<string, unknown> } {
  const command = `forge attention ${action} ${itemKey}`;
  const now = new Date().toISOString();
  const live = rows.find((r) => r.itemKey === itemKey && r.state === "active");
  if (action === "undismiss") {
    if (!live) return { status: 409, payload: { ok: false, verb: command, exitCode: 1, error: `${itemKey} has no active dismissal or snooze` } };
    live.state = "cleared";
    live.settledAt = now;
    return { status: 200, payload: { ok: true, verb: command, exitCode: 0, stdout: `undismissed ${itemKey}`, stderr: "" } };
  }
  const until = action === "snooze" ? parseSnoozeUntil(String(body["until"]), Date.now()) : null;
  if (until && !until.ok) return { status: 400, payload: { ok: false, error: until.error } };
  rows.push({
    id: `d-${rows.length}`, itemKey, kind: "fixture", projectKey: null, runId: null, dismissedAt: now,
    snoozeUntil: until && until.ok ? until.until : null, actor: "dashboard",
    rationale: typeof body["rationale"] === "string" ? body["rationale"] : null, state: "active", settledAt: null, createdAt: now,
  });
  return { status: 200, payload: { ok: true, verb: command, exitCode: 0, stdout: `${action}ed ${itemKey}`, stderr: "" } };
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

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/#home`);
  await page.locator(".inbox-row").first().waitFor();
  return { page, errors };
}

const row = (page: Page, id: string) => page.locator(`.inbox-row[data-item-id="${id}"]`);
const rowIds = (page: Page) => page.locator(".inbox-row").evaluateAll((els) => els.map((el) => el.getAttribute("data-item-id")));
const homeBadge = (page: Page) => page.evaluate(() => document.querySelector('.nav-column a[data-view="home"] .nav-badge')?.textContent ?? null);
const storage = (page: Page) => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));

async function waitForBadge(page: Page, text: string | null): Promise<void> {
  await page.waitForFunction(
    (expected) => (document.querySelector('.nav-column a[data-view="home"] .nav-badge')?.textContent ?? null) === expected,
    text,
    { timeout: 6000 },
  );
}

test("FG-823: Dismiss hides the row and the Home badge drops on the next read; the browser stores nothing", async () => {
  reset();
  const { page, errors } = await open();
  await waitForBadge(page, "3");
  const target = row(page, "task:task-auth");
  assert.deepEqual(await target.locator(".inbox-dismiss .inbox-hold-btn").allInnerTexts(), ["Dismiss", "Snooze"]);
  const gate = row(page, "wait:gate-1");
  await gate.locator(".action-btn").first().waitFor();
  assert.deepEqual(await gate.locator(".action-btn").allInnerTexts(), [
    "forge gate task-1 advance", "forge gate task-1 reject", "forge gate task-1 request-changes",
  ], "the FG-822 resolving buttons still replace a task row's requestedAction");
  assert.deepEqual(await gate.locator(".inbox-hold-btn").allInnerTexts(), ["Dismiss", "Snooze"], "and the hold buttons sit beside them");
  await page.locator(".inbox-attention, .attention-inbox").first().screenshot({ path: join(SHOTS, "fg823-inbox-row-dismiss-snooze.png") });
  await page.locator(".nav-column").screenshot({ path: join(SHOTS, "fg823-badge-before.png") });

  await target.locator(".inbox-dismiss-btn").click();
  assert.equal(await target.locator(".action-preview-verb").innerText(), "forge attention dismiss task:task-auth");
  assert.deepEqual(posts, [], "choosing Dismiss posts nothing");
  await target.locator(".inbox-dismiss-rationale").fill("rotating the key tomorrow");
  await target.locator(".action-confirm").click();

  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="task:task-auth"]'));
  await waitForBadge(page, "2");
  assert.deepEqual(posts, [{ path: "/api/attention/task%3Atask-auth/dismiss", body: { rationale: "rotating the key tomorrow" } }]);
  assert.match(await page.locator('.nav-column a[data-view="home"] .nav-badge').getAttribute("class") ?? "", /nav-badge-neutral/, "no high item left: the badge is no longer danger-toned");
  assert.equal(await page.locator(".inbox-dismissed summary").innerText(), "Dismissed (1)");
  await page.locator(".nav-column").screenshot({ path: join(SHOTS, "fg823-badge-after.png") });
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: new activity on the dismissed item's source resurfaces it", async () => {
  reset();
  const { page, errors } = await open();
  await row(page, "wait:gate-1").locator(".inbox-dismiss-btn").click();
  await row(page, "wait:gate-1").locator(".action-confirm").click();
  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="wait:gate-1"]'));
  await waitForBadge(page, "2");

  startedAt["wait:gate-1"] = new Date(Date.now() + 1000).toISOString();
  await row(page, "wait:gate-1").waitFor({ timeout: 6000 });
  await waitForBadge(page, "3");
  assert.equal(await page.locator(".inbox-dismissed").count(), 0, "a superseded dismissal no longer holds anything");
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: Snooze with a preset holds the row, then returns it once the snooze passes", async () => {
  reset();
  const { page, errors } = await open();
  const target = row(page, "readiness:FG-7");
  await target.locator(".inbox-snooze-btn").click();
  assert.equal(await target.locator(".action-preview-verb").innerText(), "forge attention snooze readiness:FG-7 --until <until>");
  await target.locator(".action-confirm").click();
  assert.equal(await target.locator(".action-error").innerText(), "Choose how long to snooze, or enter an ISO time.");
  assert.deepEqual(await target.locator(".inbox-snooze-preset").allInnerTexts(), ["1h", "4h", "1d"]);
  await target.locator(".inbox-snooze-preset", { hasText: "4h" }).click();
  assert.equal(await target.locator(".action-preview-verb").innerText(), "forge attention snooze readiness:FG-7 --until 4h");
  await target.screenshot({ path: join(SHOTS, "fg823-snooze-presets.png") });
  await target.locator(".action-confirm").click();

  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="readiness:FG-7"]'));
  assert.deepEqual(posts, [{ path: "/api/attention/readiness%3AFG-7/snooze", body: { until: "4h" } }]);
  await page.locator(".inbox-dismissed summary").click();
  const held = page.locator('.inbox-dismissed-row[data-item-id="readiness:FG-7"]');
  assert.equal(await held.getAttribute("data-hold"), "snoozed");
  assert.match(await held.locator(".inbox-dismissed-hold").innerText(), /^Snoozed by dashboard until \S+ — or until it shows new activity$/);

  rows[0]!.snoozeUntil = new Date(Date.now() - 1000).toISOString();
  await row(page, "readiness:FG-7").waitFor({ timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector(".inbox-dismissed"));
  await waitForBadge(page, "3");
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: Undismiss from the Dismissed disclosure brings the row back", async () => {
  reset();
  write("task:task-auth", "dismiss", { rationale: "known flake" });
  write("wait:gate-1", "snooze", { until: "1d" });
  const { page, errors } = await open();
  await waitForBadge(page, "1");
  assert.deepEqual(await rowIds(page), ["readiness:FG-7"]);
  const disclosure = page.locator(".inbox-dismissed");
  assert.equal(await disclosure.locator("summary").innerText(), "Dismissed (2)");
  assert.equal(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open), false, "closed by default");
  await disclosure.locator("summary").click();
  const dismissedRow = disclosure.locator('.inbox-dismissed-row[data-item-id="task:task-auth"]');
  assert.equal(await dismissedRow.locator(".inbox-dismissed-hold").innerText(), "Dismissed by dashboard — returns when it shows new activity");
  assert.equal(await dismissedRow.locator(".inbox-dismissed-rationale").innerText(), "“known flake”");
  await page.locator(".attention-inbox").screenshot({ path: join(SHOTS, "fg823-dismissed-disclosure.png") });

  await dismissedRow.locator(".inbox-undismiss-btn").click();
  await row(page, "task:task-auth").waitFor();
  await waitForBadge(page, "2");
  assert.deepEqual(posts, [{ path: "/api/attention/task%3Atask-auth/undismiss", body: {} }]);
  assert.equal(await disclosure.locator("summary").innerText(), "Dismissed (1)");
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: Dismiss, Snooze, its presets, the custom time and Undismiss are all reachable and operable by keyboard", async () => {
  reset();
  const { page, errors } = await open();
  const target = row(page, "wait:gate-1");
  const snooze = target.locator(".inbox-snooze-btn");
  await snooze.focus();
  assert.equal(await snooze.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await snooze.getAttribute("aria-expanded"), "true");
  const preset = target.locator(".inbox-snooze-preset", { hasText: "1h" });
  await preset.focus();
  await page.keyboard.press("Enter");
  assert.equal(await preset.getAttribute("aria-pressed"), "true");
  const iso = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await target.locator(".inbox-snooze-custom").focus();
  await page.keyboard.type(iso);
  assert.equal(await target.locator(".action-preview-verb").innerText(), `forge attention snooze wait:gate-1 --until ${iso}`);
  await page.keyboard.press("Tab");
  assert.equal(await target.locator(".inbox-dismiss-rationale").evaluate((el) => el === document.activeElement), true, "Tab reaches the rationale");
  await page.keyboard.press("Tab");
  assert.equal(await target.locator(".action-confirm").evaluate((el) => el === document.activeElement), true, "then Confirm");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="wait:gate-1"]'));
  assert.deepEqual(posts, [{ path: "/api/attention/wait%3Agate-1/snooze", body: { until: iso } }]);

  const summary = page.locator(".inbox-dismissed summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const undismiss = page.locator('.inbox-dismissed-row[data-item-id="wait:gate-1"] .inbox-undismiss-btn');
  assert.equal(await undismiss.getAttribute("aria-label"), "Undismiss wait:gate-1");
  await undismiss.focus();
  await page.keyboard.press("Enter");
  await row(page, "wait:gate-1").waitFor();

  const dismiss = row(page, "task:task-auth").locator(".inbox-dismiss-btn");
  await dismiss.focus();
  await page.keyboard.press("Enter");
  await row(page, "task:task-auth").locator(".action-confirm").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector('.inbox-row[data-item-id="task:task-auth"]'));
  assert.deepEqual(posts.map((p) => p.path), [
    "/api/attention/wait%3Agate-1/snooze", "/api/attention/wait%3Agate-1/undismiss", "/api/attention/task%3Atask-auth/dismiss",
  ]);
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: an attention hold preview and an FG-822 task-action preview never coexist in one inbox row", async () => {
  reset();
  const { page, errors } = await open();
  const target = row(page, "wait:gate-1");

  await target.locator(".action-btn").first().click();
  assert.equal(await target.locator(".action-preview-verb").count(), 1, "the FG-822 action preview opened");
  assert.match(await target.locator(".action-preview-verb").innerText(), /^forge gate task-1 /);

  await target.locator(".inbox-snooze-btn").click();
  assert.equal(await target.locator(".action-preview-verb").count(), 1, "the hold preview replaces rather than joins the action preview");
  assert.equal(await target.locator(".action-preview-verb").innerText(), "forge attention snooze wait:gate-1 --until <until>");
  assert.equal(await target.locator(".action-btn").first().getAttribute("aria-expanded"), "false", "the action preview was closed");

  await target.locator(".action-btn").first().click();
  assert.equal(await target.locator(".action-preview-verb").count(), 1, "reopening the action preview closes the hold preview too");
  assert.match(await target.locator(".action-preview-verb").innerText(), /^forge gate task-1 /);
  assert.equal(await target.locator(".inbox-snooze-btn").getAttribute("aria-expanded"), "false", "the hold preview was closed");
  assert.deepEqual(await storage(page), { local: 0, session: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: opening a row preview focuses its first control, and Escape closes it back to its button", async () => {
  reset();
  const { page, errors } = await open();
  const target = row(page, "wait:gate-1");
  const focused = (selector: string) => target.locator(selector).first().evaluate((el) => el === document.activeElement);

  await target.locator(".inbox-snooze-btn").click();
  assert.equal(await target.locator(".hold-preview").count(), 1);
  assert.equal(await focused(".inbox-snooze-preset"), true, "Snooze focuses its first preset");
  await page.keyboard.press("Escape");
  assert.equal(await target.locator(".hold-preview").count(), 0, "Escape closes the hold preview");
  assert.equal(await focused(".inbox-snooze-btn"), true, "focus returns to Snooze");

  await target.locator(".action-btn").first().click();
  assert.equal(await target.locator(".task-action-preview").count(), 1);
  assert.equal(await focused(".task-action-preview .action-rationale"), true, "the gate preview focuses its rationale");
  await target.locator(".inbox-dismiss-btn").click();
  assert.equal(await target.locator(".task-action-preview").count(), 0, "Dismiss closes the action preview");
  assert.equal(await focused(".hold-preview .inbox-dismiss-rationale"), true, "the dismiss preview focuses its rationale");
  await target.screenshot({ path: join(SHOTS, "fg823-one-preview-per-row.png") });

  await target.locator(".action-btn").first().click();
  assert.equal(await target.locator(".hold-preview").count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await target.locator(".action-preview").count(), 0, "Escape closes the action preview");
  assert.equal(await focused(".action-btn"), true, "focus returns to the action button");
  assert.deepEqual(posts, [], "opening and closing previews posts nothing");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-823: an inbox holding only dismissed or snoozed items names the held count, never 'No human action is currently needed'", async () => {
  reset();
  write("task:task-auth", "dismiss", {});
  write("wait:gate-1", "snooze", { until: "1d" });
  write("readiness:FG-7", "dismiss", {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/#home`);
  const status = page.locator(".attention-inbox .inbox-empty");
  await status.waitFor();
  assert.equal(await status.innerText(), "No open items — 3 held (dismissed or snoozed)");
  assert.doesNotMatch(await page.locator(".attention-inbox").innerText(), /No human action is currently needed/);
  assert.equal(await page.locator(".inbox-row").count(), 0);
  assert.equal(await page.locator(".inbox-dismissed summary").innerText(), "Dismissed (3)");
  await page.locator(".attention-inbox").screenshot({ path: join(SHOTS, "fg823-all-held.png") });
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
    const attentionMatch = url.pathname.match(/^\/api\/attention\/([^/]+)\/(dismiss|snooze|undismiss)$/);
    if (attentionMatch && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        posts.push({ path: url.pathname, body });
        const out = write(decodeURIComponent(attentionMatch[1]!), attentionMatch[2]!, body);
        json(out.payload, out.status);
      });
      return;
    }
    if (url.pathname === "/api/task/task-1/actions") {
      return json({
        ...previewTaskActions({ taskId: "task-1", status: "awaiting_gate", failureKind: null, dispatchSource: "workflow" }),
        mutations: { available: true, reason: null },
      });
    }
    if (url.pathname === "/api/attention-inbox") return json(inbox());
    if (url.pathname === "/api/runs") return json({ runs: [], activeCount: 0, nextCursor: null, generatedAt: new Date().toISOString() });
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
