// FG-683 verify coverage: unlike completed-runs.test.ts this boots the real
// dashboard server against the production schema. It proves the selector renders
// the count that the real route derives from durable run rows, rather than from a
// browser fixture.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18883;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-completed-runs-real-browser-"));
const forgeHome = join(home, ".forge");
const checkouts = join(home, "checkouts");
const primary = join(checkouts, "throughput-primary");
const sibling = join(checkouts, "throughput-sibling");
const unrelated = join(checkouts, "unrelated");

mkdirSync(forgeHome, { recursive: true });
mkdirSync(checkouts, { recursive: true });
for (const dir of [primary, sibling, unrelated]) {
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
}
// Two directories are checkouts of one canonical repository; the third must not
// leak into that project's all-checkouts scope.
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/throughput.git"], { cwd: primary, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/throughput.git"], { cwd: sibling, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/unrelated.git"], { cwd: unrelated, stdio: "ignore" });

process.env.HOME = home;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = checkouts;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

{
  const { SCHEMA_SQL } = await import("../../src/store/schema.js");
  const store = new Database(join(forgeHome, "forge.db"));
  store.exec(SCHEMA_SQL);
  const run = store.prepare("INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const task = store.prepare("INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, status, task_package, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)");
  const gate = store.prepare("INSERT INTO gates (id, task_id, decision, rationale, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?)");
  const verification = store.prepare("INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

  // Exactly three included rows across the canonical repository's two paths.
  // `many-records` deliberately carries a retry and fanout-like task tree, gates,
  // and host evidence: all are records ABOUT one run, never extra completions.
  run.run("many-records", "feature", "one logical run", "complete", iso(3 * DAY), iso(2 * DAY), primary);
  run.run("sibling-complete", "review", "sibling checkout", "complete", iso(2 * DAY), iso(DAY), sibling);
  run.run("partial-complete", "invoke", "current bucket", "complete", iso(2 * HOUR), iso(HOUR), primary);
  for (let i = 0; i < 6; i += 1) {
    const id = `task-${i}`;
    task.run(id, "many-records", i === 0 ? null : "task-0", i === 1 ? "retry" : "implementation", "engineer", "complete", iso(3 * DAY), iso(3 * DAY), iso(2 * DAY));
    gate.run(`gate-${i}`, id, "pass", "fixture", iso(2 * DAY), "test-engineer");
  }
  verification.run("FG-683", primary, "abc123", "test", "true", 0, "many-records", iso(2 * DAY));

  // Every one of these must render as no contribution to the completed-runs chart.
  run.run("orchestrator", "orchestrator", "interactive session", "complete", iso(DAY), iso(DAY), primary);
  run.run("failed", "feature", "failed", "failed", iso(DAY), iso(DAY), primary);
  run.run("active", "feature", "active", "active", iso(HOUR), null, primary);
  run.run("missing-time", "feature", "missing timestamp", "complete", iso(DAY), null, primary);
  run.run("invalid-time", "feature", "invalid timestamp", "complete", iso(DAY), "not-a-timestamp", primary);
  run.run("other-project", "feature", "must be scoped out", "complete", iso(2 * DAY), iso(DAY), unrelated);
  store.close();
}

let browser: Browser;
let server: Server;

before(async () => {
  ({ server } = await import("../src/server.js"));
  for (let i = 0; i < 75; i += 1) {
    try { await fetch(`${BASE}/`); break; }
    catch (error) {
      if (i === 74) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("real run rows flow through canonical scope, the completed-runs route, and the metric selector exactly once", async () => {
  const page = await newPage({ width: 1440, height: 1200 });
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: /Open all .* checkouts/ }).first().click();
  await page.getByRole("button", { name: "ops" }).click();
  await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();

  const response = page.waitForResponse((res) => res.url().includes("/api/completed-runs?") && res.status() === 200);
  await metric(page, "Completed runs").click();
  await page.locator(".runs-chart svg").waitFor();
  const payload = await (await response).json() as { buckets: Array<{ completedRuns: number }>; totalCompletedRuns: number };

  // The browser is reading the server's real scoped response, not a client stub.
  assert.equal(payload.totalCompletedRuns, 3, "one heavily-associated run plus two other completed runs");
  assert.deepEqual(payload.buckets.map((bucket) => bucket.completedRuns), await page.locator(".runs-text-equivalent tbody td").allTextContents().then((v) => v.map(Number)));
  assert.equal(await page.locator(".runs-total-num").textContent(), "3");
  assert.equal(payload.buckets.reduce((sum, bucket) => sum + bucket.completedRuns, 0), payload.totalCompletedRuns);
  assert.equal(payload.buckets.filter((bucket) => bucket.completedRuns === 0).length > 0, true, "the real seven-day grid includes observed zero buckets");
  assert.equal(await page.locator(".runs-chart rect.runs-bar-zero").count() > 0, true, "zero is rendered as a real count bar");
  assert.equal(await page.locator(".runs-chart rect.runs-bar").count(), payload.buckets.length);
  await page.close();
});

test("the real count chart remains contained and legible from phone to desktop widths", async () => {
  for (const width of [320, 390, 768, 1280, 1920]) {
    const page = await newPage({ width, height: 1050 });
    await page.goto(`${BASE}/#ops`);
    await page.getByRole("heading", { name: "Average agent runtime over time" }).waitFor();
    await metric(page, "Completed runs").click();
    await page.locator(".runs-chart svg").waitFor();
    const layout = await page.evaluate(() => {
      const svg = document.querySelector(".runs-chart svg")!.getBoundingClientRect();
      const labels = Array.from(document.querySelectorAll(".runs-chart svg text"));
      return {
        documentWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        svg,
        minLabelPx: Math.min(...labels.map((label) => label.getBoundingClientRect().height)),
        clipped: labels.flatMap((label) => {
          const box = label.getBoundingClientRect();
          return box.left < svg.left - 0.5 || box.right > svg.right + 0.5 || box.top < svg.top - 0.5 || box.bottom > svg.bottom + 0.5
            ? [label.textContent ?? ""] : [];
        }),
      };
    });
    assert.ok(layout.documentWidth <= layout.innerWidth, `${width}px must not introduce horizontal overflow`);
    assert.ok(layout.svg.right <= layout.innerWidth + 0.5, `${width}px chart must fit its viewport`);
    assert.ok(layout.minLabelPx >= 8, `${width}px chart labels stay legible`);
    assert.deepEqual(layout.clipped, [], `${width}px chart labels stay inside its viewBox`);
    assert.equal(await labelRowOverlap(page), null, `${width}px chart labels must not collide`);
    await page.close();
  }
});

function metric(page: Page, name: string) {
  return page.getByRole("group", { name: "metric:" }).getByRole("button").filter({ hasText: new RegExp(`^${name}$`) });
}

async function newPage(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

async function labelRowOverlap(page: Page): Promise<string | null> {
  for (const selector of [".runs-x-tick", ".runs-value"]) {
    const overlaps = await page.evaluate((row) => {
      const boxes = Array.from(document.querySelectorAll(`.runs-chart svg ${row}`))
        .map((element) => element.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1]!.right);
    }, selector);
    if (overlaps) return selector;
  }
  return null;
}
