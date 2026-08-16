// FG-386: the shipping-audit panel in a real browser.
//
// The projection's whole contract is a VISUAL one the query layer cannot prove:
// every audit state is legible and distinct, absence renders "not observed" and
// never green, and the two kinds of evidence — mechanical checks (readiness gaps +
// host-verification shipping checks) and MODEL-authored reviewer findings — sit in
// visually distinct blocks. So this drives Chrome against a fixture server that
// serves the real shell + client bundle and a canned /api/shipping-audit payload,
// exactly the harness usage-limits.test.ts / backlog-count.test.ts established.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOT_DIR = process.env.SHIPAUDIT_SHOT_DIR;

const projectsFixture = [{
  key: "repo-forge",
  projectDir: "/workspace/forge",
  primaryCheckout: "/workspace/forge",
  projectDirs: ["/workspace/forge"],
  label: "Forge",
  color: "#7a9fff",
  runCount: 4,
  inFlightCount: 0,
  liveSessions: 0,
  lastRunAt: new Date().toISOString(),
  checkouts: [
    { projectDir: "/workspace/forge", projectDirs: ["/workspace/forge"], branch: "main", exists: true, runCount: 4, inFlightCount: 0, liveSessions: 0 },
    // A second checkout so the scope banner offers a switch target. Its shipping-audit
    // fetch is made to FAIL by the fixture server (RF-3): switching to it must never
    // leave the first scope's rows on screen.
    { projectDir: "/workspace/forge-wt", projectDirs: ["/workspace/forge-wt"], branch: "wt", exists: true, runCount: 1, inFlightCount: 0, liveSessions: 0 },
  ],
}];

// One ticket per state the AC distinguishes. FG-100 passed on every axis, with a
// mechanical check, a model finding and an accepted deferral so the distinct blocks
// are all on screen. FG-101 failed readiness with NO review (its review axis is the
// not_observed case). FG-102 stale readiness. FG-103 is a completed blocker whose
// recorded mechanical check failed. FG-104 an open architecture question. FG-105
// has no evidence at all: a projection must represent that absence neutrally.
const auditFixture = {
  projectKey: "pk-forge",
  degraded: [],
  rows: [
    {
      ticketId: "FG-104",
      title: "needs a human",
      status: "needs_human",
      readiness: { outcome: "ready", status: "passed", gaps: [], refinementProposal: null, revision: 1, evaluatedAt: "t", stale: false },
      review: {
        id: "review-104", runId: "run-104", subjectTaskId: "task-104", state: "shipping_review", status: "needs_human",
        candidateSha: "sha104candidate", stale: false, riskLenses: ["wide"], openArchitectureQuestions: 1, unresolvedFixNow: 0,
        modelFindings: [{ findingRef: "RF-1", summary: "should this be a new table?", severity: "medium", riskLens: "architecture", reachability: null, disposition: "architecture_question", resolution: null, file: null, line: null }],
        acceptedDeferrals: [],
      },
      shippingChecks: [],
      campaign: null, runId: "run-104", taskIds: ["task-104"], candidateSha: "sha104candidate",
      links: { ticketId: "FG-104", runId: "run-104", subjectTaskId: "task-104", commit: "sha104candidate" },
    },
    {
      ticketId: "FG-101",
      title: "not ready yet",
      status: "failed",
      readiness: { outcome: "needs_refinement", status: "failed", gaps: ["add an acceptance criteria section", "state the goal"], refinementProposal: "split into two", revision: 1, evaluatedAt: "t", stale: false },
      review: null,
      shippingChecks: [],
      campaign: null, runId: null, taskIds: [], candidateSha: null,
      links: { ticketId: "FG-101", runId: null, subjectTaskId: null, commit: null },
    },
    {
      ticketId: "FG-102",
      title: "body moved since assessment",
      status: "stale",
      readiness: { outcome: "ready", status: "stale", gaps: [], refinementProposal: null, revision: 1, evaluatedAt: "t", stale: true },
      review: null,
      shippingChecks: [],
      campaign: null, runId: null, taskIds: [], candidateSha: null,
      links: { ticketId: "FG-102", runId: null, subjectTaskId: null, commit: null },
    },
    {
      ticketId: "FG-103",
      title: "mechanical blocker",
      status: "failed",
      readiness: { outcome: "ready", status: "passed", gaps: [], refinementProposal: null, revision: 1, evaluatedAt: "t", stale: false },
      review: {
        id: "review-103", runId: "run-103", subjectTaskId: "task-103", state: "failed", status: "failed",
        candidateSha: "sha103candidate", stale: false, riskLenses: ["security"], openArchitectureQuestions: 0, unresolvedFixNow: 1,
        modelFindings: [{ findingRef: "RF-103", summary: "model-authored reviewer finding", severity: "high", riskLens: "security", reachability: null, disposition: "fix_now", resolution: null, file: null, line: null }],
        acceptedDeferrals: [],
      },
      shippingChecks: [
        { gateName: "done mechanical shipping check", status: "failed", source: "ci", commitSha: "sha103candidate", command: "npm run verify", exitCode: 2, recordedAt: "t", ciUrl: "https://ci.example/run/103" },
      ],
      campaign: null, runId: "run-103", taskIds: ["task-103"], candidateSha: "sha103candidate",
      links: { ticketId: "FG-103", runId: "run-103", subjectTaskId: "task-103", commit: "sha103candidate" },
    },
    {
      ticketId: "FG-100",
      title: "shipped clean",
      status: "passed",
      readiness: { outcome: "ready", status: "passed", gaps: [], refinementProposal: null, revision: 1, evaluatedAt: "t", stale: false },
      review: {
        id: "review-100", runId: "run-100", subjectTaskId: "task-100", state: "settled", status: "passed",
        candidateSha: "sha100candidate", stale: false, riskLenses: ["wide", "security"], openArchitectureQuestions: 0, unresolvedFixNow: 0,
        modelFindings: [{ findingRef: "RF-1", summary: "a nit in error copy", severity: "low", riskLens: "wide", reachability: null, disposition: "fix_now", resolution: "resolved", file: "src/x.ts", line: 12 }],
        acceptedDeferrals: [{ findingRef: "RF-2", summary: "broader lifecycle cleanup", followupTicketId: "FG-999", decidedBy: "orchestrator" }],
      },
      shippingChecks: [
        { gateName: "test:all", status: "passed", source: "ci", commitSha: "sha100candidate", command: "npm run test:all", recordedAt: "t", ciUrl: null },
        { gateName: "typecheck", status: "passed", source: "host", commitSha: "sha100candidate", command: "tsc", recordedAt: "t", ciUrl: null },
      ],
      campaign: null, runId: "run-100", taskIds: ["task-100"], candidateSha: "sha100candidate",
      links: { ticketId: "FG-100", runId: "run-100", subjectTaskId: "task-100", commit: "sha100candidate" },
    },
    {
      ticketId: "FG-105",
      title: "no audit recorded",
      status: "not_observed",
      readiness: null,
      review: null,
      shippingChecks: [],
      campaign: null, runId: null, taskIds: [], candidateSha: null,
      links: { ticketId: "FG-105", runId: null, subjectTaskId: null, commit: null },
    },
  ],
};

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function openShipping(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "Open all Forge checkouts" }).click();
  await page.getByRole("button", { name: "shipping" }).click();
  await page.locator(".shipping-view").waitFor();
  await page.locator('[data-testid="audit-row"]').first().waitFor();
}

test("FG-386: refusals and absent audits render failed/not-observed, never green", async () => {
  const page = await newPage({ width: 1200, height: 1000 });
  await openShipping(page);

  // Every state present with its own row and status.
  for (const [ticket, status] of [["FG-100", "passed"], ["FG-101", "failed"], ["FG-102", "stale"], ["FG-103", "failed"], ["FG-104", "needs_human"], ["FG-105", "not_observed"]]) {
    const row = page.locator(`[data-testid="audit-row"][data-status="${status}"]`).filter({ hasText: ticket });
    assert.equal(await row.count(), 1, `${ticket} must render as a ${status} row`);
  }

  // FG-101 has NO review: its review axis reads "not observed", carrying the dim
  // class and NOT the pass class. Absence must never be green.
  const fg101 = page.locator('[data-testid="audit-row"]').filter({ hasText: "FG-101" });
  const notObserved = fg101.locator(".badge.audit-not_observed");
  assert.ok((await notObserved.count()) >= 1, "an absent review axis must render a not_observed badge");
  assert.match(await notObserved.first().innerText(), /not observed/);
  assert.equal(await fg101.locator(".badge.audit-passed").count(), 0, "a not-observed axis must not carry the pass style");
  await fg101.getByRole("button", { name: "details" }).click();
  assert.match(await fg101.innerText(), /add an acceptance criteria section/, "a readiness refusal must retain its gap reason");

  const fg105 = page.locator('[data-testid="audit-row"]').filter({ hasText: "FG-105" });
  assert.ok((await fg105.locator(".badge.audit-not_observed").count()) >= 3, "a ticket with no audit evidence must render neutral not-observed badges on all axes");
  assert.equal(await fg105.locator(".badge.audit-passed").count(), 0, "an unobserved ticket must never be styled as passed");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "shipping-audit-states.png"), fullPage: true });
  await page.close();
});

test("FG-386: a failed mechanical blocker is failed and distinct from a model finding", async () => {
  const page = await newPage({ width: 1200, height: 1000 });
  await openShipping(page);

  const blocker = page.locator('[data-testid="audit-row"][data-status="failed"]').filter({ hasText: "FG-103" });
  await blocker.getByRole("button", { name: "details" }).click();

  const mechanical = blocker.locator('[data-testid="audit-mechanical"]');
  const model = blocker.locator('[data-testid="audit-model"]');
  await mechanical.waitFor();
  assert.equal(await mechanical.count(), 1, "the mechanical checks block must render");
  assert.equal(await model.count(), 1, "the model reviewer-findings block must render");
  assert.match(await mechanical.innerText(), /done mechanical shipping check/, "the failed done check is in the mechanical block");
  assert.ok((await mechanical.locator(".badge.audit-failed").count()) >= 1, "the failed mechanical check carries failed styling");
  // RF-5: a failed mechanical check is ACTIONABLE — its command is surfaced and its
  // CI run is a link, so an operator can act on it from the panel.
  assert.match(await mechanical.innerText(), /npm run verify/, "the failed check surfaces its command");
  assert.ok(
    (await mechanical.locator('a[href="https://ci.example/run/103"]').count()) >= 1,
    "the failed check links to its CI run",
  );
  assert.match(await model.innerText(), /model-authored reviewer finding/, "the reviewer finding is in the model block");
  assert.doesNotMatch(await model.innerText(), /done mechanical shipping check/, "mechanical failure wording must not be presented as a model finding");
  // The two blocks are distinct DOM nodes with distinct classes — the visual
  // distinction the AC requires, asserted structurally rather than by pixel.
  assert.notEqual(
    await mechanical.evaluate((el) => el.className),
    await model.evaluate((el) => el.className),
    "mechanical and model blocks must not share one style",
  );

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "shipping-audit-blocker.png"), fullPage: true });
  await page.close();
});

test("FG-386: a failed mechanical check surfaces an actionable failure message (RF-2)", async () => {
  const page = await newPage({ width: 1200, height: 1000 });
  await openShipping(page);

  const blocker = page.locator('[data-testid="audit-row"][data-status="failed"]').filter({ hasText: "FG-103" });
  await blocker.getByRole("button", { name: "details" }).click();
  const mechanical = blocker.locator('[data-testid="audit-mechanical"]');
  await mechanical.waitFor();

  // RF-2: a failed check surfaces its ACTIONABLE failure message — the gate that failed,
  // its non-zero exit code, and how to reproduce — so the operator can act, not just see a
  // red badge. A passing check has no such message.
  const failureMessage = mechanical.locator('[data-testid="audit-check-message"]');
  assert.equal(await failureMessage.count(), 1, "exactly the one failed check surfaces a failure message");
  const messageText = await failureMessage.innerText();
  assert.match(messageText, /done mechanical shipping check failed/, "the message names the failed gate");
  assert.match(messageText, /exit 2/, "the message surfaces the non-zero exit code");
  assert.match(messageText, /reproduce with/, "the message tells the operator how to reproduce it");

  await page.close();
});

test("FG-386: a stale row is marked stale and states why, never shown as a live pass", async () => {
  const page = await newPage({ width: 1000, height: 900 });
  await openShipping(page);

  const stale = page.locator('[data-testid="audit-row"][data-status="stale"]').filter({ hasText: "FG-102" });
  assert.equal(await stale.count(), 1);
  assert.ok((await stale.locator(".badge.audit-stale").count()) >= 1, "the stale state carries its own badge style");
  assert.equal(await stale.locator(".badge.audit-passed").count(), 0, "a stale row must never carry the pass style");
  assert.match(await stale.innerText(), /stale/, "the reason states the evidence is stale");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "shipping-audit-stale.png"), fullPage: true });
  await page.close();
});

test("FG-386: an open architecture question reads as needs-human on the review axis", async () => {
  const page = await newPage({ width: 1000, height: 900 });
  await openShipping(page);

  const row = page.locator('[data-testid="audit-row"][data-status="needs_human"]').filter({ hasText: "FG-104" });
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /needs human/);
  assert.match(await row.innerText(), /architecture question/, "the row states the open architecture question as the reason");
  await page.close();
});

test("FG-386: an unselected project renders the empty/unselected state, never a perpetual spinner (RF-3)", async () => {
  const page = await newPage({ width: 1000, height: 800 });
  // Reach the shipping view WITHOUT opening a project — projectFilter stays null.
  await page.goto(`${baseUrl}/#projects`);
  await page.getByRole("button", { name: "shipping" }).click();
  await page.locator(".shipping-view").waitFor();
  await page.locator('[data-testid="audit-no-project"]').waitFor();
  assert.equal(await page.locator('[data-testid="audit-no-project"]').count(), 1, "an unselected project shows the select-a-project state");
  assert.doesNotMatch(await page.locator(".shipping-view").innerText(), /loading shipping audit/, "it must not sit in a perpetual loading state");
  await page.close();
});

test("FG-386: the details toggle exposes aria-expanded and controls its details region (RF-4)", async () => {
  const page = await newPage({ width: 1000, height: 900 });
  await openShipping(page);

  const row = page.locator('[data-testid="audit-row"]').filter({ hasText: "FG-100" });
  const toggle = row.getByRole("button", { name: "details" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "a collapsed toggle reports aria-expanded=false to assistive tech");
  const controls = await toggle.getAttribute("aria-controls");
  assert.ok(controls, "the toggle names the region it controls");

  await toggle.click();
  const expandedToggle = row.getByRole("button", { name: "hide" });
  assert.equal(await expandedToggle.getAttribute("aria-expanded"), "true", "an expanded toggle reports aria-expanded=true");
  assert.equal(await row.locator(`#${controls}`).count(), 1, "the controlled details region is present and matches aria-controls");

  await page.close();
});

test("FG-386: an accepted-deferral follow-up ticket renders as a link, not plain text (RF-7)", async () => {
  const page = await newPage({ width: 1000, height: 900 });
  await openShipping(page);

  const row = page.locator('[data-testid="audit-row"]').filter({ hasText: "FG-100" });
  await row.getByRole("button", { name: "details" }).click();
  const deferrals = row.locator('[data-testid="audit-deferrals"]');
  await deferrals.waitFor();

  const link = deferrals.locator("a.audit-followup-link");
  assert.equal(await link.count(), 1, "the follow-up ticket is rendered as a link");
  assert.match(await link.innerText(), /FG-999/, "the link carries the follow-up ticket id");
  assert.equal(await link.getAttribute("href"), "#audit-ticket-FG-999", "the link targets the follow-up ticket");

  await page.close();
});

test("FG-386: switching scope clears the panel; a failed new-scope response never retains the prior project's rows (RF-3)", async () => {
  const page = await newPage({ width: 1000, height: 900 });
  await openShipping(page);
  assert.ok((await page.locator('[data-testid="audit-row"]').count()) > 0, "the first scope shows its rows");

  // Switch to a checkout whose audit fetch FAILS. The prior scope's rows must be gone
  // immediately — never rendered under the new scope while it resolves, and never
  // retained when it fails.
  await page.locator('button[title="/workspace/forge-wt"]').click();
  await page.getByText(/loading shipping audit/).waitFor();
  assert.equal(await page.locator('[data-testid="audit-row"]').count(), 0, "no prior-scope rows survive the switch");

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
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectsFixture));
      return;
    }
    if (url.pathname === "/api/shipping-audit") {
      // RF-3: the second checkout's audit fetch fails. A failed new-scope response must
      // not cause the panel to retain the prior scope's rows.
      if (url.searchParams.get("projectDir") === "/workspace/forge-wt") {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(auditFixture));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
