// FG-694 (post-ship correction): what HOME renders, in a real Chrome.
//
// d55a29aa made the `Current activity` panel compact and honest. It left the panel
// where it was — a second top-level activity surface on Home, above `In flight` — and
// the live reproduction after it measured that panel at 810.5px in an 862px viewport:
// every agent rendered twice (once per surface), and eight CI candidates whose only
// anchor was an unfinished review row for a ticket that had already shipped.
//
// Two things fixed that, and this suite asserts both through the DOM an operator reads,
// because "the panel is smaller now" is exactly the kind of claim a view-model test
// cannot make:
//
//   1. Home has ONE activity surface, `In flight`. No `Current activity` heading, no
//      `Right now` kicker, no agent rendered twice. The compact host-verification and
//      required-check WAITS are rows inside it, and only while they are actually waits:
//      an observed-running launch, a candidate whose checks are still pending. Nothing
//      to wait on renders nothing — not a heading, not an empty subsection.
//   2. Ticket CLOSURE retires the residue. Closing a ticket never drives its review row
//      terminal, so the eight unfinished rows kept their CI current; the fixture below
//      builds that exact shape through the REAL derivation rather than serving an
//      already-filtered payload, so the selection layer is under test too.
//
// The detail is not deleted anywhere: the full `Current activity` panel — sha,
// per-context states, check URLs, observation times — is on the Activity view and is
// asserted, unchanged, in fg679-current-activity.test.ts. `forge status` is unchanged.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";
import { makeInMemoryDb } from "../../src/store/db.js";
import { deriveCurrentActivity } from "../../src/v2/current-activity.js";
import type { CurrentActivity } from "@forge/current-activity";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG679_SCREENSHOT_DIR ?? join(tmpdir(), "fg679-screenshots");
mkdirSync(SHOTS, { recursive: true });

const NOW = new Date("2026-08-08T12:00:00.000Z");
const PROJECT = "/repos/forge";
const CURRENT_SHA = "c".repeat(40);
const LIVE_TASK = "task-build-aef6ae";
const LIVE_TICKET = "FG-694";
/** The eight the reproduction showed: every one CLOSED, every one still carrying an
 *  unfinished review row, every one the newest CI observation for its pair. */
const SHIPPED = ["FG-686", "FG-576", "MG-51", "FG-591", "FG-689", "FG-584", "FG-685", "FG-610"];
const SHIPPED_REVIEW_STATES = ["verifying", "rechecking", "fixing", "discovering", "documenting", "shipping_review", "awaiting_disposition", "confirming_contract"];

const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/** The reported shape, built through the REAL derivation. Serving a hand-filtered
 *  payload here would let Home pass while the selection layer quietly went back to
 *  carrying shipped tickets' CI forward. */
function reportedShape(): CurrentActivity {
  const db = makeInMemoryDb();
  const addRun = (id: string, status: string): void => {
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, ?, ?, ?)`)
      .run(id, `run ${id}`, status, ago(7 * 24 * 3_600_000), PROJECT);
  };
  const addTicket = (ticketId: string, status: string): void => {
    db.prepare(`INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at) VALUES ('pk-forge', ?, 'story', ?, ?, '', ?)`)
      .run(ticketId, status, `ticket ${ticketId}`, ago(30 * 24 * 3_600_000));
  };
  const addReview = (runId: string, ticketId: string, state: string): void => {
    db.prepare(`INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`review-${ticketId}`, runId, ticketId, PROJECT, state, ago(3_600_000), ago(60_000));
  };
  const addCi = (runId: string, ticketId: string, sha: string, observedAt: string): void => {
    const contexts = Array.from({ length: 10 }, (_value, i) => ({
      context: `check-${i}`,
      state: i < 7 ? "success" : "pending",
      url: `https://github.com/o/r/actions/runs/${ticketId}-${i}`,
      observedAt,
    }));
    db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, 'review_loop.ci_observed', ?, ?)`)
      .run(runId, JSON.stringify({
        attemptId: `attempt-${ticketId}`, ticketId, projectDir: PROJECT, candidateSha: sha,
        observedAt, outcome: "pending", unavailableReason: null, contexts,
      }), observedAt);
  };

  SHIPPED.forEach((ticket, i) => {
    const runId = `run-${ticket.toLowerCase()}`;
    // The run is ACTIVE and the review is OPEN — neither of the two prior rules excludes
    // this row. Only the ticket being `done` does.
    addRun(runId, "active");
    addTicket(ticket, "done");
    addReview(runId, ticket, SHIPPED_REVIEW_STATES[i]!);
    addCi(runId, ticket, `${i}`.repeat(2).padEnd(40, "a"), ago(2 * 3_600_000 + i * 60_000));
  });

  addRun("run-fg694", "active");
  addTicket(LIVE_TICKET, "active");
  addReview("run-fg694", LIVE_TICKET, "verifying");
  addCi("run-fg694", LIVE_TICKET, CURRENT_SHA, ago(30_000));
  // The SAME task /api/in-flight serves below. Home must render it exactly once.
  db.prepare(`
    INSERT INTO tasks (id, run_id, phase, agent_role, agent_model, status, task_package, started_at, created_at)
    VALUES (?, 'run-fg694', 'build', 'engineer', NULL, 'running', '', ?, ?)
  `).run(LIVE_TASK, ago(600_000), ago(600_000));
  db.prepare(`
    INSERT INTO launch_observations (
      launch_id, name, command, cwd, project_dir, association_kind, run_id, task_id, ticket_id,
      campaign_id, item_id, started_at, observed_at, state, exit_code, signal, terminal
    ) VALUES (?, ?, ?, ?, ?, 'explicit', 'run-fg694', NULL, ?, NULL, NULL, ?, ?, 'running', NULL, NULL, 0)
  `).run(
    "launch-worktree-8pagjk", "worktree-tier", JSON.stringify(["npm", "run", "test:worktree"]),
    PROJECT, PROJECT, LIVE_TICKET, ago(900_000), ago(30_000),
  );

  try {
    return deriveCurrentActivity(db, { now: NOW });
  } finally {
    db.close();
  }
}

/** The in-flight task rows, as /api/in-flight serves them. Deliberately the same task
 *  the derivation carries in `agents`: that is what makes "rendered once" an assertion
 *  about duplication rather than about a fixture that only had one source. */
const IN_FLIGHT = [{
  taskId: LIVE_TASK,
  runId: "run-fg694",
  runTitle: "correct Home activity placement",
  workflow: "feature",
  phase: "build",
  agentRole: "engineer",
  agentModel: null,
  status: "running",
  startedAt: ago(600_000),
  projectDir: PROJECT,
  projectLabel: "forge",
  orchestrator: null,
  reconcile: null,
}];

let served: CurrentActivity = reportedShape();
let inFlight: unknown[] = IN_FLIGHT;
let currentActivityStatus = 200;

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

/** Home, at the viewport the regression was measured in. 862px is not a round number
 *  on purpose — it is the height the reproduction ran at, and the panel filled 810.5 of
 *  it. */
async function openHome(height = 862): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/`);
  await page.locator("section.home-view").waitFor();
  return page;
}

const homeInFlight = (page: Page) => page.locator("section.home-view section.in-flight");

test("FG-694: Home has ONE activity surface — no Current activity panel, no Right now kicker", async () => {
  served = reportedShape();
  inFlight = IN_FLIGHT;
  const page = await openHome();
  await homeInFlight(page).locator(".item").first().waitFor();

  assert.equal(await page.locator("section.home-view section.current-activity").count(), 0,
    "the second top-level activity panel is what this correction removes");
  assert.equal(await page.locator("section.home-view #current-activity-heading").count(), 0);
  const home = await page.locator("section.home-view").innerText();
  assert.doesNotMatch(home, /Current activity/i);
  assert.doesNotMatch(home, /Right now/i, "the kicker went with the panel it labelled");

  // …and the surface that remains is In flight, exactly one of it.
  assert.equal(await homeInFlight(page).count(), 1);
  assert.equal(await page.locator("#home-in-flight-heading").textContent(), "In flight");
  await page.screenshot({ path: join(SHOTS, "fg694-home-one-surface.png"), fullPage: true });
  await page.close();
});

test("FG-694: an agent in flight is rendered ONCE, not once per surface", async () => {
  served = reportedShape();
  inFlight = IN_FLIGHT;
  assert.deepEqual(served.agents.map((a) => a.taskId), [LIVE_TASK],
    "non-vacuous: the derivation DOES carry this agent, so rendering it here would duplicate it");

  const page = await openHome();
  await homeInFlight(page).locator(".item").first().waitFor();
  const home = await page.locator("section.home-view").innerText();
  assert.equal(home.split(LIVE_TASK).length - 1, 1, `${LIVE_TASK} must appear exactly once on Home`);
  assert.equal(await page.locator("section.home-view .ca-agent-row").count(), 0,
    "the agent row belongs to the Current activity panel, which is not on Home");
  await page.close();
});

test("FG-694: the host-verification and CI waits are ONE compact line each — no sha, URL, timestamp or argv", async () => {
  served = reportedShape();
  inFlight = IN_FLIGHT;
  const page = await openHome();
  await page.locator(".ca-ci-wait-row").waitFor();

  assert.equal(await page.locator(".ca-host-wait-row").count(), 1);
  assert.equal(await page.locator(".ca-ci-wait-row").count(), 1);

  const ci = await page.locator(".ca-ci-wait-row").innerText();
  assert.match(ci, new RegExp(LIVE_TICKET), "the candidate is named by its ticket");
  assert.match(ci, /CI running/);
  assert.match(ci, /7\/10 complete/);

  const waits = await page.locator(".ca-wait-row").allInnerTexts();
  const text = waits.join("\n");
  assert.match(text, /host verification/);
  assert.doesNotMatch(text, new RegExp(CURRENT_SHA), "the full sha is drill-down detail on the Activity view");
  assert.doesNotMatch(text, /github\.com/, "check URLs are drill-down detail");
  assert.doesNotMatch(text, /2026-08-08T/, "raw observation timestamps are drill-down detail");
  assert.doesNotMatch(text, /npm run test:worktree/, "the argv is context, and per-row context is what overflowed the viewport");
  assert.doesNotMatch(text, /check-0/, "the per-context enumeration is drill-down detail");
  assert.doesNotMatch(text, /launch-worktree-8pagjk/, "a launch is named by its ticket when it declared one");

  // Nothing on Home opens into the audit payload.
  assert.equal(await page.locator("section.home-view details").count(), 0);
  await page.close();
});

test("FG-694: a CLOSED ticket's unfinished review contributes NO current CI to Home", async () => {
  served = reportedShape();
  inFlight = IN_FLIGHT;
  // Non-vacuous at the source: every shipped run is ACTIVE and every review state is
  // OPEN, so only ticket closure can have removed them.
  assert.deepEqual(served.requiredCi.observations.map((o) => o.ticketId), [LIVE_TICKET]);

  const page = await openHome();
  await page.locator(".ca-ci-wait-row").waitFor();
  const home = await page.locator("section.home-view").innerText();
  for (const ticket of SHIPPED) {
    assert.doesNotMatch(home, new RegExp(ticket), `${ticket} shipped — its CI is history, not something to wait on`);
  }
  assert.equal(await page.locator(".ca-ci-wait-row").count(), 1, "eight historical candidates became none; the live one stays");
  await page.close();
});

test("FG-694: In flight fits the viewport the regression overflowed, and stays one line when nothing is running", async () => {
  served = reportedShape();
  inFlight = IN_FLIGHT;
  let page = await openHome();
  await page.locator(".ca-ci-wait-row").waitFor();
  const box = await homeInFlight(page).boundingBox();
  assert.ok(box, "the In flight surface has a box");
  assert.ok(box.height < 300,
    `In flight rendered ${box.height}px of an 862px viewport under the reported load; the panel this replaces was 810.5px`);
  await page.screenshot({ path: join(SHOTS, "fg694-home-compact.png"), fullPage: true });
  await page.close();

  // Nothing current at all: no waits section, no headings, no permanently-empty
  // subsections — one line, the one In flight has always said.
  served = { ...reportedShape(), hostVerification: [], requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] } };
  inFlight = [];
  page = await openHome();
  await homeInFlight(page).locator(".empty").waitFor();
  assert.equal(await page.locator(".ca-wait-row").count(), 0);
  const text = await homeInFlight(page).innerText();
  assert.match(text, /No live tasks/);
  for (const heading of ["Agents", "Host verification", "Required CI"]) {
    assert.doesNotMatch(text, new RegExp(heading), `${heading} is an empty subsection and must not render on Home`);
  }
  await page.close();
});

test("FG-694: a launch that is not running, and CI that is not pending, are not WAITS", async () => {
  // Both are still four distinct, fully-rendered facts on the Activity view. On Home
  // they are outcomes to read on the run/review detail, not things to watch.
  const derived = reportedShape();
  served = {
    ...derived,
    hostVerification: derived.hostVerification.map((l) => ({
      ...l, status: { state: "exited_ok" as const, code: 0 as const }, statusLabel: "exited 0", observation: "fresh" as const,
    })),
    requiredCi: {
      state: "observed",
      label: "1 observed",
      observations: derived.requiredCi.observations.map((o) => ({
        ...o,
        state: "not_running" as const,
        outcome: "success",
        contexts: o.contexts.map((c) => ({ ...c, state: "success" })),
      })),
    },
  };
  inFlight = IN_FLIGHT;
  const page = await openHome();
  await homeInFlight(page).locator(".item").first().waitFor();
  assert.equal(await page.locator(".ca-wait-row").count(), 0);
  const home = await page.locator("section.home-view").innerText();
  assert.doesNotMatch(home, /CI passed/);
  assert.doesNotMatch(home, /exited 0/);
  await page.close();
});

test("FG-694: a failed read says the WAITS are unavailable and claims no absence", async () => {
  // The AC7 rule, through the corrected surface: In flight otherwise says only what
  // /api/in-flight observed, so without this line it would silently imply it had also
  // looked at launches and checks and found none.
  currentActivityStatus = 404;
  inFlight = IN_FLIGHT;
  try {
    const page = await openHome();
    await page.locator(".ca-wait-unavailable").waitFor();
    const text = await homeInFlight(page).innerText();
    assert.match(text, /Host and CI waits unavailable/);
    assert.match(text, /predates the route/, "the detail is about the READ, never about the work");
    for (const claim of ["No agent task in flight", "No host launch observed", "CI not observed", "Nothing currently running"]) {
      assert.doesNotMatch(text, new RegExp(claim), `a failed read may not claim "${claim}"`);
    }
    assert.equal(await page.locator("section.home-view .ca-retry").count(), 1, "the operator's recovery is not a page reload");
    await page.screenshot({ path: join(SHOTS, "fg694-home-waits-unavailable.png"), fullPage: true });
    await page.close();
  } finally {
    currentActivityStatus = 200;
  }
});

test("FG-694: the Home screenshots exist", () => {
  for (const name of ["fg694-home-one-surface.png", "fg694-home-compact.png", "fg694-home-waits-unavailable.png"]) {
    assert.ok(existsSync(join(SHOTS, name)), `expected screenshot ${join(SHOTS, name)}`);
  }
  console.log(`FG-694 Home screenshots: ${SHOTS}`);
});

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
    if (url.pathname === "/api/current-activity") {
      if (currentActivityStatus !== 200) {
        res.writeHead(currentActivityStatus, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(served));
      return;
    }
    if (url.pathname === "/api/in-flight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inFlight));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
