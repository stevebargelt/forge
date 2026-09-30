// FG-830 — session-handoff Notes moved out of the Backlog into their own view under Plan.
// The Backlog starts at its tickets with no notes section; `#notes` lists one row per
// checkout that has a note (operator checkouts, then run checkouts under their own caption —
// FG-843; FG-831 label, session date, one-line preview, primary
// marked) newest session first; a row opens `#notes/<checkout>`, the note rendered
// through the sanitized Markdown boundary with the FG-821 trail and Escape-to-parent.
//
// A fixture HTTP server serves the real shell + client bundle and a canned backlog.
// Screenshots go to a fresh temp dir unless FG830_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18837;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG830_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg830-screenshots-"));
if (process.env.FG830_SCREENSHOT_DIR) mkdirSync(SHOTS, { recursive: true });

const PRIMARY = "/workspace/forge";
const CLONE_A = "/workspace/clones/a/forge";
const CLONE_B = "/workspace/clones/b/forge";
const FEATURE = "/workspace/forge-fg830";

// FG-843: GET /api/projects states each checkout's kind. The primary and the feature
// checkout are operator checkouts; the two disposable clones are run checkouts, so their
// notes list under the Run checkouts caption and never in the header chooser.
function checkout(projectDir: string, branch: string, kind: "operator" | "run") {
  return { projectDir, projectDirs: [projectDir], branch, exists: true, runCount: 0, inFlightCount: 0, liveSessions: 0, kind };
}
const projectsFixture = [{
  key: "repo-forge",
  projectDir: PRIMARY,
  primaryCheckout: PRIMARY,
  projectDirs: [PRIMARY, CLONE_A, CLONE_B, FEATURE],
  label: "Forge",
  color: "#7a9fff",
  runCount: 0,
  inFlightCount: 0,
  liveSessions: 0,
  lastRunAt: new Date().toISOString(),
  checkouts: [checkout(PRIMARY, "main", "operator"), checkout(CLONE_A, "main", "run"), checkout(CLONE_B, "main", "run"), checkout(FEATURE, "feat/fg-830-notes-view", "operator")],
  checkoutCounts: { operator: 2, liveOperator: 2, run: 2 },
}];

// A long note, as the real ones are, so the old inline section's cost is visible.
const LONG = Array.from({ length: 60 }, (_, i) => `${i + 1}. A paragraph of handoff narrative that used to push the tickets below the fold.`).join("\n");
const notesFixture = [
  { checkoutDir: PRIMARY, checkoutBranch: "main", notes: `**Last session ended 2026-08-13.**\n\n**Where we left off:** the primary checkout's handoff.\n\n${LONG}`, modifiedAt: "2026-09-29T08:00:00.000Z" },
  { checkoutDir: CLONE_A, checkoutBranch: "main", notes: "# Clone A handoff\n\nNo session line — dated by the file.", modifiedAt: "2026-09-20T10:00:00.000Z" },
  // A date quoted in prose is not the session marker line: this row stays undated.
  { checkoutDir: CLONE_B, checkoutBranch: "main", notes: "Scribble with no session line.\n\nContext: Last session ended 2026-09-29 was copied from another handoff.", modifiedAt: null },
  {
    checkoutDir: FEATURE,
    checkoutBranch: "feat/fg-830-notes-view",
    notes: "Last session ended 2026-09-28.\n\n## Picked up next\n\n- **FG-830** Notes view\n\n<script>window.__pwned = true</script>\n\n<img src=x onerror=window.__pwned=true>\n\n[bad](javascript:alert(1))",
    modifiedAt: "2026-09-28T18:00:00.000Z",
  },
];
const backlogFixture = {
  notes: "",
  notesByCheckout: notesFixture,
  ticketsProjectKey: "repo-forge",
  ticketsStorageMode: "db",
  tickets: [
    { id: "FG-830", type: "story", status: "active", title: "Notes view", body: "", epic: null },
    { id: "FG-831", type: "story", status: "active", title: "Checkout labels", body: "", epic: null },
  ],
};

// Operator checkouts first, then run checkouts (FG-843); newest session first within each.
const EXPECTED_ORDER = [
  "forge-fg830 · feat/fg-830-notes-view",
  "workspace/forge · main",
  "a/forge · main",
  "b/forge · main",
];

let server: Server;
let browser: Browser;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function open(hash: string, viewport = { width: 1200, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  await page.goto(`${BASE}/${hash}`);
  return page;
}

async function rowLabels(page: Page): Promise<string[]> {
  await page.locator(".notes-row").first().waitFor();
  return (await page.locator(".notes-row .notes-label").allTextContents()).map((s) => s.trim());
}

const noteHash = (dir: string) => `#notes/${encodeURIComponent(dir)}?project=repo-forge`;

test("FG-830: the Backlog starts at its tickets — no notes section, no per-checkout note list", async () => {
  const page = await open("#backlog?project=repo-forge");
  await page.locator(".backlog-ticket-card").first().waitFor();
  assert.equal(await page.locator(".backlog-notes, .backlog-note-card, .backlog-notes-body").count(), 0);
  assert.equal(await page.getByText("Session handoff").count(), 0);
  assert.equal(await page.getByText("the primary checkout's handoff").count(), 0, "no note text leaks onto the Backlog");
  const firstTicketTop = await page.locator(".backlog-ticket-card").first().evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(firstTicketTop < 900, `the first ticket is above the fold (top ${firstTicketTop}px)`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(height < 2000, `the Backlog page is not inflated by notes (${height}px)`);
  await page.locator(".backlog-ticket-card").first().click();
  await page.waitForFunction(() => location.hash === "#backlog/FG-830?project=repo-forge", undefined, { timeout: 5000 });
  await page.goto(`${BASE}/#backlog?project=repo-forge`);
  await page.locator(".backlog-ticket-card").first().waitFor();
  await page.screenshot({ path: join(SHOTS, "fg830-backlog-top.png") });
  await page.close();
});

test("FG-830: #notes lists each checkout with a note once, unique FG-831 labels, newest session first, primary marked", async () => {
  const page = await open("#notes?project=repo-forge");
  const plan = page.locator('.nav-column section[aria-labelledby="nav-group-plan"] a.nav-item');
  await plan.first().waitFor();
  assert.deepEqual((await plan.allTextContents()).map((s) => s.trim()), ["Backlog", "Notes", "Queue", "Campaigns"], "Notes sits under Plan, after Backlog");
  assert.equal(await page.locator('.nav-column a.nav-item[aria-current="page"]').innerText(), "Notes");

  assert.deepEqual(await rowLabels(page), EXPECTED_ORDER, "operator checkouts (2026-09-28 note, 2026-08-13 note), then run checkouts (2026-09-20 mtime, then the undated one)");
  assert.equal((await page.locator(".notes-run-caption").innerText()).trim().toLowerCase(), "run checkouts");
  assert.deepEqual(await page.locator(".notes-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-checkout-kind"))), ["operator", "operator", "run", "run"]);
  assert.equal(new Set(EXPECTED_ORDER).size, EXPECTED_ORDER.length);
  const primaryRows = page.locator(".notes-row").filter({ has: page.locator(".notes-primary") });
  assert.equal(await primaryRows.count(), 1);
  assert.equal(await primaryRows.getAttribute("data-checkout"), PRIMARY);
  const sources = await page.locator(".notes-row .notes-session").evaluateAll((els) => els.map((el) => el.getAttribute("data-session-source")));
  assert.deepEqual(sources, ["note", "note", "modified", "unknown"]);
  assert.match(await page.locator(".notes-row").nth(3).innerText(), /session date unknown/);
  assert.equal(await page.locator(".notes-row").nth(1).locator(".notes-preview").innerText(), "Where we left off: the primary checkout's handoff.", "a one-line preview, not the whole note");
  assert.equal(await page.locator(".note-body, .md").count(), 0, "the list renders no note bodies");
  await page.screenshot({ path: join(SHOTS, "fg830-notes-list.png"), fullPage: true });

  const none = await open("#notes");
  await none.locator(".notes-no-project").waitFor();
  assert.match(await none.locator(".notes-no-project").innerText(), /Select a project/);
  assert.equal(await none.locator(".notes-row").count(), 0);
  await none.close();
  await page.close();
});

test("FG-830: opening a row renders its full note through the sanitized renderer, with the Project › Notes › checkout trail", async () => {
  const page = await open("#notes?project=repo-forge");
  await rowLabels(page);
  await page.getByRole("link", { name: `Open the session handoff for ${EXPECTED_ORDER[0]}` }).click();
  await page.waitForFunction((h) => location.hash === h, noteHash(FEATURE), { timeout: 5000 });
  const body = page.locator(".note-page .note-body");
  await body.waitFor();
  assert.equal(await body.locator("h2").textContent(), "Picked up next");
  assert.equal(await body.locator("li strong").innerText(), "FG-830");
  assert.match(await body.innerText(), /<script>window.__pwned = true<\/script>/, "raw HTML is shown as text");
  assert.equal(await body.locator("script, a[href^='javascript']").count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned ?? false), false);
  assert.equal(await page.locator(".page-title").innerText(), EXPECTED_ORDER[0]);
  assert.deepEqual(
    (await page.locator(".breadcrumbs li").allTextContents()).map((s) => s.trim()),
    ["Forge", "Notes", EXPECTED_ORDER[0]],
  );
  assert.equal(await page.locator('.breadcrumbs [data-crumb="notes"] a').getAttribute("href"), "#notes?project=repo-forge");
  assert.equal(await page.locator('.nav-column a.nav-item[aria-current="page"]').innerText(), "Notes", "the note page highlights Notes");
  await page.screenshot({ path: join(SHOTS, "fg830-note-detail.png"), fullPage: true });
  await page.close();
});

test("FG-830: a note deep link survives reload", async () => {
  const page = await open(noteHash(PRIMARY));
  await page.locator(".note-page .note-body").waitFor();
  assert.match(await page.locator(".note-page .note-body").innerText(), /the primary checkout's handoff/);
  assert.equal(await page.locator(".note-page .notes-primary").count(), 1, "the primary checkout's note is marked on its page");
  await page.reload();
  await page.locator(".note-page .note-body").waitFor();
  assert.equal(await page.evaluate(() => location.hash), noteHash(PRIMARY));
  assert.equal(await page.locator(".page-title").innerText(), "workspace/forge · main");

  const unknown = await open(noteHash("/workspace/nowhere"));
  await unknown.getByText("No session handoff note for /workspace/nowhere").waitFor();
  await unknown.close();
  await page.close();
});

test("FG-830: Escape on a note page returns to the scoped Notes list", async () => {
  const page = await open(noteHash(CLONE_A));
  await page.locator(".note-page .note-body").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#notes?project=repo-forge", undefined, { timeout: 5000 });
  assert.deepEqual(await rowLabels(page), EXPECTED_ORDER);
  await page.close();
});

test("FG-830: at 400px the Notes list and a note page fit the viewport", async () => {
  const page = await open("#notes?project=repo-forge", { width: 400, height: 844 });
  await rowLabels(page);
  const fits = () => page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    contained: Array.from(document.querySelectorAll(".notes-row, .note-body, .notes-path")).every((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth + 0.5;
    }),
  }));
  const list = await fits();
  assert.ok(list.documentWidth <= list.viewport && list.contained, JSON.stringify(list));
  await page.screenshot({ path: join(SHOTS, "fg830-notes-400.png"), fullPage: true });
  await page.locator(".notes-row").first().click();
  await page.locator(".note-page .note-body").waitFor();
  const detail = await fits();
  assert.ok(detail.documentWidth <= detail.viewport && detail.contained, JSON.stringify(detail));
  await page.close();
});

test("FG-830 / FG-831: every Notes row repeats its checkout's label — the header chooser's for operator checkouts — with mixed session dates and one primary", async () => {
  const page = await open("#notes?project=repo-forge");
  await rowLabels(page);
  await page.locator(".page-head .checkout-chooser-button").click();
  await page.locator(".checkout-chooser-menu [role=option]").first().waitFor();
  const parity = await page.evaluate(() => {
    const chooser = new Map(Array.from(document.querySelectorAll<HTMLElement>(".checkout-chooser-menu [role=option]")).map((option) => [
      option.dataset.checkout ?? "",
      option.querySelector(".checkout-chooser-value")?.textContent?.trim() ?? "",
    ]));
    return Array.from(document.querySelectorAll<HTMLElement>(".notes-row")).map((row) => ({
      checkout: row.dataset.checkout ?? "",
      label: row.querySelector(".notes-label")?.textContent?.trim() ?? "",
      chooserLabel: chooser.get(row.dataset.checkout ?? "") ?? null,
      session: row.querySelector(".notes-session")?.textContent?.trim() ?? "",
      source: row.querySelector(".notes-session")?.getAttribute("data-session-source"),
      primary: row.querySelector(".notes-primary") !== null,
    }));
  });
  await page.keyboard.press("Escape");
  assert.deepEqual(parity.map((row) => [row.checkout, row.label, row.chooserLabel]), [
    [FEATURE, "forge-fg830 · feat/fg-830-notes-view", "forge-fg830 · feat/fg-830-notes-view"],
    [PRIMARY, "workspace/forge · main", "workspace/forge · main"],
    [CLONE_A, "a/forge · main", null],
    [CLONE_B, "b/forge · main", null],
  ], "Notes and the chooser use the same FG-831 label; run checkouts are never in the chooser");
  assert.deepEqual(parity.map((row) => row.source), ["note", "note", "modified", "unknown"], "note dates, mtime fallback, and unknown stay sorted newest first within each group");
  assert.match(parity[0]!.session, /^session ended 2026-09-28 · \d+d ago$/);
  assert.match(parity[2]!.session, /^file modified \d+d ago$/);
  assert.match(parity[1]!.session, /^session ended 2026-08-13 · \d+d ago$/);
  assert.equal(parity[3]!.session, "session date unknown");
  assert.match(await page.locator(".notes-row").nth(3).locator(".notes-preview").innerText(), /^Scribble with no session line\.$/, "the prose-quoted date neither dates nor lifts the row");
  assert.deepEqual(parity.filter((row) => row.primary).map((row) => row.checkout), [PRIMARY]);
  await page.close();
});

test("FG-830 / FG-692: Notes rows open with Enter; hostile HTML is inert; Escape returns to the scoped list", async () => {
  const page = await open("#notes?project=repo-forge");
  const row = page.getByRole("link", { name: `Open the session handoff for ${EXPECTED_ORDER[0]}` });
  await row.focus();
  assert.equal(await row.evaluate((el) => el === document.activeElement), true, "a Notes row is keyboard reachable");
  await page.keyboard.press("Enter");
  await page.waitForFunction((h) => location.hash === h, noteHash(FEATURE), { timeout: 5000 });
  const hostile = await page.locator(".note-body").evaluate((body) => ({
    scripts: body.querySelectorAll("script").length,
    handlers: Array.from(body.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes).filter((attribute) => attribute.name.toLowerCase().startsWith("on")).map((attribute) => attribute.name)),
    javascriptHrefs: Array.from(body.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((link) => /^javascript:/i.test(link.href)).map((link) => link.getAttribute("href")),
  }));
  assert.deepEqual(hostile, { scripts: 0, handlers: [], javascriptHrefs: [] }, "hostile note markup remains inert text");
  assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned ?? false), false);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#notes?project=repo-forge", undefined, { timeout: 5000 });
  assert.deepEqual(await rowLabels(page), EXPECTED_ORDER);
  await page.close();
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
      // Resolve symlinks before comparing roots, rather than trusting a lexical prefix.
      if (!realpathSync(filePath).startsWith(`${CLIENT_DIR}/`)) {
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
    if (url.pathname === "/api/backlog") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(backlogFixture));
      return;
    }
    const ticketRuns = url.pathname.match(/^\/api\/backlog\/([^/]+)\/runs$/);
    if (ticketRuns) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ticketId: decodeURIComponent(ticketRuns[1]!), runs: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
