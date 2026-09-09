// FG-783 (step 6) — the Remote Board's BOUNDED PLANNING UI, driven in a REAL Chrome
// (dashboard_browser tier). It serves the real remote shell (renderRemoteShell) under the real
// remote CSP (now `script-src 'self' 'nonce-…'; connect-src 'self'`) and the real
// dashboard/remote-client/board.js, STUBS GET /api/board with a live project board, and STUBS the
// POST planning route with scripted recorded-outcome / refusal / transport-failure fixtures.
//
// It isolates the AC7 client claims to board.js: the confirm → submit → result flow for the four
// planning categories is keyboard- and screen-reader-operable; on a recorded APPLIED outcome the
// client RE-READS /api/board rather than optimistically painting success; a stale-precondition
// refusal shows the current safe summary and a retry path; the submitted envelope carries the
// queue version the board LOADED and never a server-authoritative key; and a transport failure
// retries with the SAME idempotency key (replay-safe) rather than a fresh one.
//
// It deliberately does NOT stand up the real remote server, DB, identity resolver or CSRF guard —
// those are step 5's server integration tests (AC1-AC6 end to end). Here the /api/plan response is
// the fixture, so applied / refused / transport-loss are all reachable deterministically and the
// UI's honesty (never optimistic) is what is under test.
//
// Needs Chrome; since FG-642 it gets one everywhere the tier runs. A Chrome-less environment FAILS
// the `before` precondition (requireChrome) — it never skips to green. Registered in
// src/util/browser-tier-census.ts so the FG-642 guards move with it.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import {
  REMOTE_BOARD_ENDPOINT,
  REMOTE_CLIENT_URL_PREFIX,
  REMOTE_PLAN_ENDPOINT,
  remoteContentSecurityPolicy,
  remoteCspNonce,
  renderRemoteShell,
} from "../src/remote/shell.js";
import type { RemoteBoard, RemoteBoardEnvelope } from "../src/remote/projection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE_CLIENT_DIR = resolve(HERE, "..", "remote-client");

const QUEUE_VERSION = 7;

// A live board with two backlog tickets and a queue whose top row (FG-781) is queued and whose
// second (FG-783) is not — so enqueue/annotate appear on the backlog and dequeue/rank/move/annotate
// on the queued row. `queue.version` is the rank/reorder precondition the client must carry.
function sampleBoard(extraTicketId?: string): RemoteBoard {
  const tickets = [
    { id: "FG-781", type: "story", status: "active", title: "Remote Board foundation", revision: 4, epic: "FG-780", created: "2026-09-01", closed: null, related: [] },
    { id: "FG-782", type: "story", status: "queued", title: "Tailscale Serve adapter", revision: 5, epic: "FG-780", created: "2026-09-02", closed: null, related: [] },
  ];
  if (extraTicketId) {
    tickets.push({ id: extraTicketId, type: "story", status: "active", title: "Re-read marker ticket", revision: 1, epic: "FG-780", created: "2026-09-08", closed: null, related: [] });
  }
  return {
    projectSummary: {
      projectKey: "forge", label: "forge", color: "#7dd3fc", description: "the forge CLI",
      lastRunAt: "2026-09-08T12:00:00.000Z", runCount: 42, inFlightCount: 1, liveSessions: 0,
    },
    backlog: { projectKey: "forge", storageMode: "db", tickets },
    queue: {
      projectKey: "forge", storageMode: "db", queueAvailable: true, unavailableReason: null,
      version: QUEUE_VERSION,
      rows: [
        { ticketId: "FG-781", title: "Remote Board foundation", type: "story", status: "active", rank: 1, revision: 4, queued: true, blocked: false, inProgress: true, executionState: "running", view: "in_progress", waitKind: null },
        { ticketId: "FG-782", title: "Tailscale Serve adapter", type: "story", status: "queued", rank: 2, revision: 5, queued: true, blocked: false, inProgress: false, executionState: "idle", view: "queued", waitKind: null },
        { ticketId: "FG-783", title: "Planning mutation capability", type: "story", status: "blocked", rank: 3, revision: 6, queued: false, blocked: true, inProgress: false, executionState: "idle", view: "blocked", waitKind: "dependency" },
      ],
      views: { backlog: [], queued: ["FG-781", "FG-782"], in_progress: [], blocked: ["FG-783"], done: [], executing_not_queued: [] },
    },
    campaigns: [],
    inbox: { generatedAt: "2026-09-08T12:00:00.000Z", items: [], empty: true, degraded: [] },
    activity: {
      generatedAt: "2026-09-08T12:00:00.000Z", agents: [],
      counts: { agents: 0, hostVerifications: 0, launches: 0, ciWaits: 0, operatorWaits: 0 },
      requiredCiState: "none", hasLiveWork: false,
    },
  };
}

// RF-2: a plan-capable envelope, so the planning affordances render. Tests that need a read-only
// board build their own envelope with capabilities: ["read"] via liveEnvelopeWithCaps.
function liveEnvelope(board: RemoteBoard): RemoteBoardEnvelope {
  return liveEnvelopeWithCaps(board, ["read", "plan"]);
}

function liveEnvelopeWithCaps(board: RemoteBoard, capabilities: RemoteBoardEnvelope["capabilities"]): RemoteBoardEnvelope {
  return { state: "live", generatedAt: "2026-09-08T12:00:00.000Z", generation: 1_757_332_800_000, board, capabilities };
}

// ─── scripted server state, reset per test ──────────────────────────────────────
type PlanScript = { status: number; body: unknown } | { destroy: true };

let boardEnvelope: RemoteBoardEnvelope = liveEnvelope(sampleBoard());
let boardReads = 0; // GET /api/board count — the re-read oracle
let planScripts: PlanScript[] = []; // consumed one per POST /api/plan (else a default `applied`)
let planRequests: Array<Record<string, unknown>> = []; // the parsed bodies the client POSTed

function appliedResponse(body: Record<string, unknown>): { status: number; body: unknown } {
  return {
    status: 200,
    body: { ok: true, outcome: "applied", replayed: false, requestId: body.requestId, action: body.action, targetId: body.ticketId ?? null, precondition: null, summary: { message: "applied" }, createdAt: "2026-09-08T12:00:01.000Z" },
  };
}

function refusedResponse(body: Record<string, unknown>): { status: number; body: unknown } {
  return {
    status: 409,
    body: {
      ok: false, outcome: "refused", replayed: false, requestId: body.requestId, action: body.action, targetId: body.ticketId ?? null,
      precondition: `expectedVersion=${QUEUE_VERSION}`,
      error: "the queue moved since you loaded it (expected version 7); no change was made.",
      summary: { message: "the queue moved since you loaded it", queueVersion: 9, queue: ["FG-782", "FG-781"] },
      createdAt: "2026-09-08T12:00:01.000Z",
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(""));
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

// Reset scripted state before each test opens a page.
function reset(board: RemoteBoard = sampleBoard()): void {
  boardEnvelope = liveEnvelope(board);
  boardReads = 0;
  planScripts = [];
  planRequests = [];
}

// ─── the four planning categories are reachable ───────────────────────────────────

test("offers the four planning categories (five wire actions) as accessible triggers", async () => {
  reset();
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  // Backlog: enqueue + annotate. Queue (a queued row): dequeue + rank + move + annotate.
  await page.locator('[data-plan-action="enqueue"]').first().waitFor();
  for (const action of ["enqueue", "dequeue", "change-rank", "reorder-queue", "append-annotation"]) {
    assert.ok((await page.locator(`[data-plan-action="${action}"]`).count()) >= 1, `${action} is reachable from the board`);
  }
  // Each trigger is a real, labelled button (not a bare div).
  const enqueue = page.locator('[data-plan-action="enqueue"][data-plan-target="FG-782"]').first();
  assert.equal(await enqueue.evaluate((n) => n.tagName), "BUTTON");
  assert.match((await enqueue.getAttribute("aria-label")) ?? "", /Enqueue FG-782/);
  await page.close();
});

// ─── applied → re-read, never optimistic ──────────────────────────────────────────

test("on a recorded APPLIED outcome the client RE-READS /api/board and never paints optimistic success", async () => {
  // The re-read returns a board carrying a distinctive marker ticket that the initial load did NOT
  // have. If the client optimistically painted instead of re-reading, the marker never appears.
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();
  const readsAfterBoot = boardReads;

  // Swap the board the NEXT read returns, and script the plan to apply.
  boardEnvelope = liveEnvelope(sampleBoard("FG-999"));
  planScripts = []; // default applied

  await page.locator('[data-plan-action="dequeue"][data-plan-target="FG-781"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  const boardReloaded = page.waitForResponse((r) => r.url().endsWith(REMOTE_BOARD_ENDPOINT) && r.request().method() === "GET");
  await dialog.getByRole("button", { name: "Dequeue" }).click();

  // The client re-fetched the board (non-optimistic), the dialog closed, and the re-read's marker
  // ticket is now on screen — proof the DOM reflects the host's re-read, not a client-painted state.
  await assert.doesNotReject(boardReloaded, "an applied outcome triggers a board re-read");
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });
  await assert.doesNotReject(page.getByText("Re-read marker ticket").first().waitFor(), "the board shows the re-read payload");
  assert.ok(boardReads > readsAfterBoot, "the board was read again after the applied outcome");
  await page.close();
});

// ─── refusal → safe summary + retry, nothing optimistic ────────────────────────────

test("a stale-precondition refusal surfaces the current safe summary and a retry path, applying nothing", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();
  const readsBeforeSubmit = boardReads;

  planScripts = [{ status: 409, body: null }]; // marker; the handler builds a refusedResponse
  await page.locator('[data-plan-action="reorder-queue"][data-plan-target="FG-781"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  await dialog.locator(".rb-plan-input").fill("2");
  await dialog.getByRole("button", { name: "Move" }).click();

  // The alert region carries the server's refusal message AND its redacted safe summary.
  // (textContent, not innerText: the alert lives in a fixed-position overlay whose layout can lag
  // innerText's rendered-text read; textContent reflects the DOM the moment showError populated it.)
  const alert = dialog.locator('[role="alert"]');
  await alert.waitFor();
  const alertText = (await alert.textContent()) ?? "";
  assert.match(alertText.toLowerCase(), /queue moved/, "the refusal message is shown");
  assert.match(alertText, /version 9/, "the current safe summary (new queue version) is shown");
  assert.match(alertText, /FG-782 → FG-781/, "the current safe queue order is shown to re-read against");

  // A retry path exists, the dialog stays open, and NOTHING was optimistically applied (no board
  // re-read happened on the refusal itself — the operator drives the re-read via the retry).
  assert.ok((await dialog.getByRole("button", { name: /Re-read/ }).count()) === 1, "a retry / re-read path is offered");
  assert.equal(await page.locator(".rb-plan-dialog").count(), 1, "the dialog stays open on a refusal");
  assert.equal(boardReads, readsBeforeSubmit, "a refusal does not itself re-read; it waits for the operator");
  await page.close();
});

// ─── the loaded precondition + no forged server-authoritative keys ─────────────────

test("the submitted envelope carries the LOADED queue version and no server-authoritative key", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  planScripts = []; // applied
  await page.locator('[data-plan-action="change-rank"][data-plan-target="FG-781"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  // placement select defaults to "before"; pick the reference (the other queued ticket).
  await dialog.locator("select").nth(1).selectOption("FG-782");
  await dialog.getByRole("button", { name: "Rank" }).click();
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });

  assert.equal(planRequests.length, 1, "exactly one command was POSTed");
  const sent = planRequests[0]!;
  assert.equal(sent.action, "change-rank");
  assert.equal(sent.ticketId, "FG-781");
  assert.equal(sent.reference, "FG-782");
  assert.equal(sent.expectVersion, QUEUE_VERSION, "the precondition is the queue version the board LOADED");
  assert.ok(typeof sent.requestId === "string" && (sent.requestId as string).length > 0, "an idempotency key is carried");
  for (const forbidden of ["actor", "subject", "transport", "projectKey", "projectDir", "timestamp"]) {
    assert.ok(!(forbidden in sent), `the body must not carry the server-authoritative key ${forbidden}`);
  }
  await page.close();
});

// ─── keyboard operability ──────────────────────────────────────────────────────────

test("keyboard: a trigger opens by Enter, the dialog takes focus, Escape closes and returns focus", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  const trigger = page.locator('[data-plan-action="append-annotation"][data-plan-target="FG-782"]').first();
  await trigger.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-plan-action")), "append-annotation", "focus lands on the trigger");
  await page.keyboard.press("Enter");

  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  // Focus moved INTO the dialog (the first field / the confirm control), not stranded on <body>.
  assert.ok(await page.evaluate(() => !!document.querySelector(".rb-plan-dialog")?.contains(document.activeElement)), "focus moves into the dialog on open");

  await page.keyboard.press("Escape");
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });
  // Escape returns focus to the control that opened it, so a keyboard operator keeps their place.
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-plan-action")), "append-annotation", "focus returns to the trigger after Escape");
  await page.close();
});

test("keyboard: the annotation flow submits from the keyboard and re-reads on the applied outcome", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  planScripts = []; // applied
  await page.locator('[data-plan-action="append-annotation"][data-plan-target="FG-782"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  await dialog.locator("textarea").fill("re-rank after the transport lands");
  const reloaded = page.waitForResponse((r) => r.url().endsWith(REMOTE_BOARD_ENDPOINT) && r.request().method() === "GET");
  // Submit the form from the keyboard (Enter inside the field submits the form).
  await dialog.getByRole("button", { name: "Annotate" }).focus();
  await page.keyboard.press("Enter");
  await assert.doesNotReject(reloaded, "a keyboard submit reaches the host and re-reads on applied");
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });

  assert.equal(planRequests.length, 1);
  assert.equal(planRequests[0]!.action, "append-annotation");
  assert.equal(planRequests[0]!.body, "re-rank after the transport lands");
  await page.close();
});

// ─── screen-reader semantics ────────────────────────────────────────────────────────

test("screen-reader: the dialog is a labelled modal with status + alert live regions and labelled fields", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  await page.locator('[data-plan-action="append-annotation"][data-plan-target="FG-782"]').first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();

  assert.equal(await dialog.getAttribute("aria-modal"), "true", "the dialog is a modal");
  const labelledby = await dialog.getAttribute("aria-labelledby");
  assert.ok(labelledby, "the dialog names its label");
  assert.match((await page.locator(`#${labelledby}`).textContent()) ?? "", /Annotate/, "the label heading describes the action");

  // A polite status region (progress) and an assertive alert region (refusal) both exist, scoped
  // to the dialog — so a live→refused transition is spoken.
  assert.equal(await dialog.locator('[role="status"]').count(), 1, "a polite status region narrates progress");
  assert.equal(await dialog.locator('[role="alert"]').count(), 1, "an assertive alert region announces a refusal");

  // The annotation field has an associated <label> (a for/id pair), not a bare input.
  const input = dialog.locator("textarea");
  const id = await input.getAttribute("id");
  assert.ok(id, "the field has an id");
  assert.equal(await dialog.locator(`label[for="${id}"]`).count(), 1, "the field has an associated label");
  await page.close();
});

// ─── idempotency across a transport failure ─────────────────────────────────────────

test("idempotency: a transport failure retries with the SAME request id, then applies once on success", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  // First POST: the server drops the connection (a transport loss — no verdict reaches the client).
  // Second POST (the retry): apply.
  planScripts = [{ destroy: true }];
  await page.locator('[data-plan-action="dequeue"][data-plan-target="FG-782"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Dequeue" }).click();

  // A transport failure surfaces a plain Retry (same-id) path, dialog still open.
  const retry = dialog.getByRole("button", { name: "Retry" });
  await retry.waitFor();
  const reloaded = page.waitForResponse((r) => r.url().endsWith(REMOTE_BOARD_ENDPOINT) && r.request().method() === "GET");
  await retry.click(); // second POST — the default applied response
  await assert.doesNotReject(reloaded, "the retry applies and re-reads");
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });

  assert.equal(planRequests.length, 2, "the command was sent twice (initial + retry)");
  assert.equal(planRequests[0]!.requestId, planRequests[1]!.requestId, "a transport retry REUSES the idempotency key so a redelivery cannot double-apply");
  await page.close();
});

// ─── RF-2: planning affordances are capability-gated ───────────────────────────────

test("RF-2: a read-only board (no 'plan' capability) shows no planning controls and no plan note", async () => {
  reset(sampleBoard());
  boardEnvelope = liveEnvelopeWithCaps(sampleBoard(), ["read"]);
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();
  await page.locator(".rb-card").first().waitFor(); // the board itself renders...
  assert.equal(await page.locator("[data-plan-action]").count(), 0, "a read-only identity is shown NO planning triggers");
  assert.equal(await page.locator(".rb-plan-note").count(), 0, "no planning note is rendered for a read-only board");
  await page.close();
});

test("RF-2: an annotation carries the LOADED ticket revision as its precondition, never 0", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  planScripts = []; // applied
  await page.locator('[data-plan-action="append-annotation"][data-plan-target="FG-782"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  await dialog.locator("textarea").fill("bump priority");
  await dialog.getByRole("button", { name: "Annotate" }).click();
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });

  assert.equal(planRequests.length, 1);
  assert.equal(planRequests[0]!.action, "append-annotation");
  assert.equal(planRequests[0]!.ticketId, "FG-782");
  assert.equal(planRequests[0]!.ticketRevision, 5, "the annotation carries the loaded ticket revision (not a 0 fallback)");
  await page.close();
});

// ─── RF-3: the applied confirmation is announced in a persistent live region ────────

test("RF-3: an applied outcome persists a screen-reader announcement after the dialog closes", async () => {
  reset(sampleBoard());
  const page = await open();
  await page.locator('[data-state="live"]').waitFor();

  planScripts = []; // applied
  await page.locator('[data-plan-action="dequeue"][data-plan-target="FG-781"]').first().click();
  const dialog = page.locator(".rb-plan-dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Dequeue" }).click();
  await page.locator(".rb-plan-dialog").waitFor({ state: "detached" });

  // The confirmation lives in a role=status region OUTSIDE the (now-removed) dialog, so a screen
  // reader still hears the applied outcome after the dialog is gone.
  const announcer = page.locator(".rb-sr-only[role='status']");
  await announcer.waitFor();
  assert.match((await announcer.textContent()) ?? "", /Applied/, "the applied confirmation persists after the dialog closes");
  await page.close();
});

// ─── RF-4: a browser without Web Crypto fails closed rather than reusing a constant id ──

test("RF-4: no Web Crypto → planning is disabled with an 'unsupported' note and no controls", async () => {
  reset(sampleBoard());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Strip Web Crypto BEFORE board.js evaluates: no randomUUID, no getRandomValues.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "crypto", { value: { subtle: {} }, configurable: true });
  });
  await page.goto(`${baseUrl}/`);
  await page.locator('[data-state="live"]').waitFor();

  // Capability IS 'plan', but with no secure random source planning FAILS CLOSED: an explicit
  // unsupported note and NO triggers — never an all-zero constant id that would replay-collide.
  await page.locator(".rb-plan-unsupported").waitFor();
  assert.match((await page.locator(".rb-plan-unsupported").textContent()) ?? "", /secure random|Web Crypto/i, "the unsupported reason is stated");
  assert.equal(await page.locator("[data-plan-action]").count(), 0, "no planning triggers when the id source is unavailable");
  assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
  await page.close();
});

// ─── harness ────────────────────────────────────────────────────────────────────

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  await page.goto(`${baseUrl}/`);
  return page;
}

function createFixtureServer(): Server {
  // `Connection: close` on every response — no keep-alive. This matters for the transport-failure
  // test: on a REUSED keep-alive connection Chrome silently retries a request whose socket drops
  // before any bytes arrive (a connection-reuse race), so `fetch` would never reject. A fresh
  // connection per request means a dropped socket surfaces as net::ERR_EMPTY_RESPONSE and `fetch`
  // rejects — the transport-loss the test needs the client to observe. Functionally inert for the
  // other tests.
  const CLOSE = { Connection: "close" };
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // The real remote shell, under the real remote CSP (nonce matched), so board.js loads as a
    // first-party module and the connect-src 'self' pin governs its fetches exactly as in prod.
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = remoteCspNonce();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": remoteContentSecurityPolicy(nonce), ...CLOSE }).end(renderRemoteShell(nonce));
      return;
    }
    // The real focused asset set (board.js), served by runtime path as the remote server does.
    if (req.method === "GET" && url.pathname.startsWith(REMOTE_CLIENT_URL_PREFIX)) {
      const filePath = resolve(REMOTE_CLIENT_DIR, url.pathname.slice(REMOTE_CLIENT_URL_PREFIX.length));
      if (!filePath.startsWith(`${REMOTE_CLIENT_DIR}/`) || !existsSync(filePath)) {
        res.writeHead(404, CLOSE).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", ...CLOSE }).end(readFileSync(filePath));
      return;
    }
    // The stubbed projection read — counted so a test can prove the client re-read after an outcome.
    if (req.method === "GET" && url.pathname === REMOTE_BOARD_ENDPOINT) {
      boardReads += 1;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CLOSE }).end(JSON.stringify(boardEnvelope));
      return;
    }
    // The stubbed planning POST: capture the body, then respond per the next scripted entry (or a
    // default `applied`). A `{destroy:true}` entry simulates a transport loss (connection dropped).
    if (req.method === "POST" && url.pathname === REMOTE_PLAN_ENDPOINT) {
      const raw = await readBody(req);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      planRequests.push(parsed);
      const script = planScripts.shift();
      if (script && "destroy" in script) {
        req.socket.destroy();
        return;
      }
      const chosen = script && script.status === 409 ? refusedResponse(parsed) : appliedResponse(parsed);
      res.writeHead(chosen.status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CLOSE }).end(JSON.stringify(chosen.body));
      return;
    }
    res.writeHead(404, CLOSE).end();
  });
}
