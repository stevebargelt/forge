// FG-663 browser regression: a run written while a disposable checkout exists must
// remain visible under its project after that checkout is deleted. This uses the
// shipping run writer, the real dashboard server and a real Chromium page; neither
// the API payload nor the client is stubbed.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18863;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-fg663-browser-"));
const forgeHome = join(home, ".forge");
const checkouts = join(home, "checkouts");
const liveDir = join(checkouts, "durable-project-live");
const deletedDir = join(checkouts, "durable-project-disposable");

mkdirSync(forgeHome, { recursive: true });
mkdirSync(checkouts, { recursive: true });
process.env.HOME = home;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = checkouts;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

function checkout(dir: string): string {
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/durable-project.git"], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const live = checkout(liveDir);
const doomed = checkout(deletedDir);
const now = new Date().toISOString();

// These imports follow the environment assignment: their store/path modules resolve
// FORGE_HOME at evaluation time.
const { getDb } = await import("../../src/store/db.js");
const { insertRun } = await import("../../src/store/runs.js");

insertRun({
  id: "run-fg663-live",
  workflow: "feature",
  title: "surviving checkout control",
  status: "complete",
  createdAt: now,
  completedAt: now,
  projectDir: live,
});
insertRun({
  id: "run-fg663-deleted",
  workflow: "feature",
  title: "deleted checkout remains attributed",
  status: "complete",
  createdAt: now,
  completedAt: now,
  projectDir: doomed,
});

const store = getDb();
const identity = store.prepare("SELECT project_identity FROM runs WHERE id = ?").get("run-fg663-deleted") as { project_identity: string | null };
assert.match(identity.project_identity ?? "", /^repo-/, "fixture: the shipping writer captured repository identity before deletion");
for (const runId of ["run-fg663-live", "run-fg663-deleted"]) {
  store.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, started_at, completed_at)
     VALUES (?, ?, 'verify', 'test-engineer', 'complete', '{}', '{"tests_passed":1}', ?, ?, ?)`,
  ).run(`task-${runId}`, runId, now, now, now);
}

// The production read now has no usable checkout at this recorded path. Its tag must
// come from runs.project_identity, not a fresh repository inspection.
rmSync(doomed, { recursive: true, force: true });

let browser: Browser;
let server: Server;

before(async () => {
  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch (error) {
      if (attempt === 74) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function newPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

test("a deleted checkout's task remains project-scoped and carries its real project tag in the operator UI", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").waitFor();

  const projects = await (await fetch(`${BASE}/api/projects`)).json() as Array<{ key: string; label: string }>;
  assert.equal(projects.length, 1, "the surviving checkout establishes one observable project");
  const project = projects[0]!;

  const feedResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/feed?projectKey=${encodeURIComponent(project.key)}`) && response.status() === 200,
  );
  await page.getByRole("button", { name: `Open all ${project.label} checkouts` }).click();
  await page.getByRole("button", { name: "activity" }).click();
  const feed = await (await feedResponse).json() as Array<{ runId: string; projectLabel: string | null; projectColor: string | null }>;
  const deleted = feed.find((entry) => entry.runId === "run-fg663-deleted");

  assert.ok(deleted, "the project-scoped feed includes the run from the deleted checkout");
  assert.equal(deleted.projectLabel, project.label, "the feed API resolves the deleted run to its surviving project's label");
  assert.ok(deleted.projectColor, "the durable identity also supplies a project color");

  const card = page.locator(".feed .card", { hasText: "deleted checkout remains attributed" });
  await card.waitFor();
  assert.match(await card.innerText(), new RegExp(project.label), "the project chip is rendered in the browser");
  assert.doesNotMatch(await card.innerText(), /Unknown repository/, "a deleted checkout never regresses to Unknown repository");

  const detailResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/task/task-run-fg663-deleted") && response.status() === 200,
  );
  await card.click();
  const detail = page.locator(".detail-overlay");
  await detail.waitFor();
  await detail.getByText("deleted checkout remains attributed").waitFor();
  const taskDetail = await (await detailResponse).json() as { task: { projectLabel: string | null; projectColor: string | null } };
  assert.equal(taskDetail.task.projectLabel, project.label, "task detail resolves the same durable project presentation");
  assert.ok(taskDetail.task.projectColor, "task detail preserves the durable project color");
  await page.close();
});

