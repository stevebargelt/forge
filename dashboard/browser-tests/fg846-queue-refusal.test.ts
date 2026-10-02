// FG-846/847 — real Chrome over the actual dashboard server and co-located forge CLI.
// This pins the operator loop: refusal at the triggering control, refine in place, save,
// re-check, then enqueue.  The screenshots deliberately preserve the mock's two states.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18860;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.FG846_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg846-queue-refusal-"));
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("../src/test-support/await-dashboard-ready.js");
const { fixtureFetch } = await import("../src/test-support/fixture-fetch.js");
const home = mkdtempSync(join(tmpdir(), "fg846-home-"));
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
process.env.FORGE_HOME = join(home, ".forge");
process.env.FORGE_DB_PATH = join(process.env.FORGE_HOME, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = projectDir;
process.env.PORT = String(PORT); process.env.HOST = "127.0.0.1";
const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { upsertTicket, setStorageMode } = await import("../../src/store/tickets.js");
const { rankTicket } = await import("../../src/store/queue.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { authorityTestkitBinEnv } = await import("../../src/backlog/container-authority.testkit-spawn.js");
Object.assign(process.env, authorityTestkitBinEnv());
const PK = "pk-fg846-browser";
const BAD = "A ticket without the headings.\n";
const GOOD = "## Problem\n\nIt is hidden.\n\n## Goal\n\nIt is visible.\n\n## Acceptance Criteria\n- it works\n";
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:forge/fg846-browser.git"], { cwd: projectDir, stdio: "ignore" });
writeTransaction(() => {
  getDb().prepare("INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)")
    .run(PK, repositoryCheckoutIdentity(projectDir).key, "remote", "2026-10-01T00:00:00Z");
  getDb().prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)")
    .run("run-fg846-browser", "feature", "fixture", "complete", "2026-10-01T00:00:00Z", projectDir);
});
setStorageMode(PK, "db", "2026-10-01T00:00:00Z");
for (const [id, body] of [["FG-846", BAD], ["FG-847", GOOD], ["FG-848", BAD]] as const) {
  upsertTicket({ projectKey: PK, ticketId: id, type: "story", status: "active", title: `title ${id}`, body, created: "2026-10-01", closed: null, closedCommit: null, epic: null, frontmatter: null, importedAt: "2026-10-01T00:00:00Z", importedFrom: null } as never);
  rankTicket(PK, id, undefined, "2026-10-01T00:00:00Z");
}

let browser: Browser; let server: Server; let label = ""; let dashboardKey = "";
before(async () => {
  const chrome = requireChrome("FG-846/FG-847 browser coverage");
  ({ server } = await import("../src/server.js"));
  await awaitDashboardReady(BASE, { timeoutMs: 4000 });
  const projects = await (await fixtureFetch(`${BASE}/api/projects`)).json() as Array<{ key: string; label: string; projectDirs: string[] }>;
  const project = projects.find((p) => p.projectDirs.includes(projectDir))!;
  label = project.label; dashboardKey = project.key;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: CHROME_LAUNCH_ARGS });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); await new Promise<void>((done) => server ? server.close(() => done()) : done()); });

async function page(): Promise<Page> {
  const p = await browser.newPage({ viewport: { width: 400, height: 760 } });
  await p.goto(`${BASE}/#projects`);
  await p.getByRole("button", { name: `Open all ${label} checkouts` }).click();
  await p.getByRole("link", { name: "Queue", exact: true }).click();
  await p.locator(".queue-view").waitFor();
  return p;
}
async function shot(p: Page, name: string): Promise<void> { await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); }
function card(p: Page, id: string) { return p.locator(".queue-card", { hasText: id }); }

test("FG-846/847: scrolled refusal is focused, verbatim and resolvable in place", async () => {
  const p = await page();
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const button = card(p, "FG-846").getByRole("button", { name: "enqueue" });
  await button.click();
  const outcome = card(p, "FG-846").locator(".action-outcome");
  await outcome.waitFor();
  assert.equal(await outcome.getAttribute("role"), "alert");
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("action-outcome")), true);
  assert.equal(await outcome.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
  const cli = await fixtureFetch(`${BASE}/api/backlog/FG-846/readiness?projectDir=${encodeURIComponent(projectDir)}`);
  const readiness = await cli.json() as { gaps: string[] };
  for (const gap of readiness.gaps) assert.match(await outcome.innerText(), new RegExp(gap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await outcome.innerText(), /FG-846 evaluates 'needs_refinement'/);
  assert.match(await card(p, "FG-846").innerText(), /needs refinement/);
  await shot(p, "a-refused-mock-side-by-side");
  await outcome.press("Escape"); assert.equal(await p.evaluate(() => document.activeElement?.textContent), "enqueue");
  await outcome.getByRole("button", { name: "Dismiss" }).focus(); await p.keyboard.press("Enter");
  await outcome.waitFor({ state: "detached" });
  assert.equal(await p.evaluate(() => document.activeElement?.textContent), "enqueue", "Dismiss returns focus to the triggering control");
  await button.click(); await outcome.getByRole("button", { name: "Refine…" }).click();
  const editor = p.getByLabel("Body of FG-846"); await editor.waitFor();
  assert.match(await editor.inputValue(), /## Problem/); assert.match(await editor.inputValue(), /## Goal/);
  await editor.fill(GOOD); await p.getByRole("button", { name: "Save and re-check" }).click();
  await p.getByText(/ready at r\d+/).waitFor(); await shot(p, "c-refined-mock-side-by-side");
  await p.setViewportSize({ width: 1200, height: 800 });
  await p.getByRole("button", { name: "Enqueue now" }).click();
  await p.locator(".queue-column-queued", { hasText: "FG-846" }).waitFor();
  assert.doesNotMatch(await card(p, "FG-846").innerText(), /needs refinement/); await p.close();
});

test("FG-846/847: ready applied outcome, client-side missing-section refusal, ticket deep link and keyboard reach", async () => {
  const p = await page();
  // The applied card moves lanes after the real CLI succeeds; use the desktop lane layout
  // for that assertion, then return to the phone layout for the ticket-page check.
  await p.setViewportSize({ width: 1200, height: 800 });
  const ready = card(p, "FG-847").getByRole("button", { name: "enqueue" }); await ready.focus(); await p.keyboard.press("Enter");
  const applied = card(p, "FG-847").locator(".action-outcome"); await applied.waitFor(); assert.equal(await applied.getAttribute("role"), "status");
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("action-outcome")), true); await shot(p, "d-applied");
  await p.setViewportSize({ width: 400, height: 760 });
  await p.goto(`${BASE}/#backlog/FG-848?project=${encodeURIComponent(dashboardKey)}&mode=edit`); await p.getByLabel("Body of FG-848").waitFor(); await p.reload(); await p.getByLabel("Body of FG-848").waitFor();
  const editor = p.getByLabel("Body of FG-848"); await editor.fill("## Problem\nonly"); await p.getByRole("button", { name: "Save and re-check" }).click();
  await p.getByRole("alert").filter({ hasText: "still missing" }).waitFor();
  for (const name of ["Body of FG-848", "Save and re-check", "Cancel"]) {
    const control = p.getByRole(name === "Body of FG-848" ? "textbox" : "button", { name });
    await control.focus();
    assert.equal(await control.evaluate((el) => document.activeElement === el), true, `${name} remains keyboard reachable`);
  }
  await shot(p, "ticket-edit-400px"); await p.close();
});
