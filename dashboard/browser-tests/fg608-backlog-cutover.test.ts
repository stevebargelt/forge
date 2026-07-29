// FG-608 (FG-496 Slice C) — the cutover as an OPERATOR SEES IT, in a real
// browser, against a project cut over by the real `forge backlog migrate`.
//
// Every other FG-608 dashboard test stops at the JSON payload. But the three
// truth states this slice introduced are only useful if they REACH THE SCREEN,
// and each one is a different rendering branch in client/backlog.js:
//
//   - db mode          -> the board renders, with no caveat badge
//   - markdown mode    -> `.backlog-shadow-badge` ("import shadow — not
//                         authoritative"): rows exist but are NOT truth
//   - no project_key   -> `.backlog-no-truth`: never imported, which is every
//                         project until its operator runs migrate
//
// backlog-state.test.ts covers the pure function that decides between them and
// the integration tests cover the payload that feeds it, but nothing has ever
// rendered them. A board that silently showed "no tickets" for an unmigrated
// project — rather than saying it has no ticket truth — is precisely the
// operational trap flagged at the build gate, and it is invisible to a payload
// assertion.
//
// The store here is built by the REAL cutover verb (no hand-seeded ticket rows),
// the server is the real dashboard, and the browser is real Chrome. The suite
// skips with a named reason when no Chrome binary is present, matching the
// convention in inactive-checkouts.test.ts and usage-limits.test.ts.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
const LOCAL_TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSX = existsSync(LOCAL_TSX) ? LOCAL_TSX : "tsx";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  // The agent-dev-worker image ships chromium here; without this entry the whole
  // file would skip in exactly the container the verify phase runs in, which is
  // how a browser suite quietly stops being evidence.
  "/usr/local/bin/chromium",
].filter((candidate): candidate is string => Boolean(candidate));
const CHROME_PATH = CHROME_CANDIDATES.find(existsSync);
const SHOT_DIR = process.env.FG608_SHOT_DIR;

const TEST_PORT = 18782;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "fg608-cutover-browser-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function forge(projectDir: string, args: string[]): string {
  const res = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, FORGE_DB_PATH: join(forgeHome, "forge.db") },
  });
  assert.equal(res.status, 0, `forge ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout ?? "";
}

function ticketFile(fm: Record<string, string>, body: string): string {
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
}

function makeProject(name: string, remoteName: string, tickets: Array<[string, Record<string, string>, string]>): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["remote", "add", "origin", `git@github.com:stevebargelt/${remoteName}.git`]);
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  for (const [id, fm, body] of tickets) {
    writeFileSync(join(dir, "backlog", "stories", `${id}-slug.md`), ticketFile(fm, body));
  }
  writeFileSync(join(dir, "backlog", "notes.md"), `# ${name} handoff\n\nnotes for ${name}.\n`);
  return dir;
}

const CUTOVER_TICKETS: Array<[string, Record<string, string>, string]> = [
  ["FG-E", { id: "FG-E", type: "epic", status: "active", title: '"Cutover epic"' }, "epic body"],
  ["FG-1", { id: "FG-1", type: "story", status: "active", title: '"Migrated alpha"', epic: "FG-E" }, "alpha body"],
  ["FG-2", { id: "FG-2", type: "story", status: "blocked", title: '"Migrated blocked"' }, "blocked body"],
];

// cutover: migrated to db mode. shadow: imported but NOT flipped. virgin: never
// imported at all — the state every project is in before its operator migrates.
const cutoverDir = makeProject("cutover", "fg608-cutover", CUTOVER_TICKETS);
const shadowDir = makeProject("shadow", "fg608-shadow", [
  ["SH-1", { id: "SH-1", type: "story", status: "active", title: '"Shadow story"' }, "shadow body"],
]);
const virginDir = makeProject("virgin", "fg608-virgin", [
  ["VI-1", { id: "VI-1", type: "story", status: "active", title: '"Never imported story"' }, "virgin body"],
]);

// Written to the cutover checkout AFTER the flip: the frozen-Markdown shape. It
// must never reach the DOM.
const FROZEN_ID = "FG-FROZEN";

let browser: Browser | undefined;
let server: Server | undefined;
let labels: Record<string, string> = {};

before(async () => {
  // The real cutover. Only `cutover` flips; `shadow` imports and stops.
  forge(cutoverDir, ["backlog", "migrate", "--json"]);
  forge(shadowDir, ["backlog", "import", "--json"]);

  writeFileSync(
    join(cutoverDir, "backlog", "stories", `${FROZEN_ID}-slug.md`),
    ticketFile({ id: FROZEN_ID, type: "story", status: "active", title: '"Frozen markdown story"' }, "frozen body"),
  );

  const database = new Database(join(forgeHome, "forge.db"));
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [cutoverDir, shadowDir, virginDir].forEach((projectDir, index) => {
    const at = `2026-07-${20 + index}T10:00:00Z`;
    insertRun.run(`run-${index}`, "feature", `Run ${index}`, "complete", at, projectDir);
    insertTask.run(`done-${index}`, `run-${index}`, "engineer", "engineer", "complete", at, at, at);
  });
  database.close();

  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 74) throw new Error("dashboard test server did not start");
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // The card label is derived host-side (basename of the project dir, prettified),
  // so read it rather than restating the rule here — a label-format change should
  // not silently turn these assertions into no-ops.
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{
    label: string;
    projectDirs: string[];
  }>;
  labels = Object.fromEntries(
    [["cutover", cutoverDir], ["shadow", shadowDir], ["virgin", virginDir]].map(([name, dir]) => {
      const match = projects.find((p) => p.projectDirs.includes(dir as string));
      assert.ok(match, `the dashboard did not resolve a project for ${name}`);
      return [name as string, match.label];
    }),
  );

  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  if (CHROME_PATH) browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

async function newPage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

/** Drive the real UI to one project's backlog board, exactly as an operator
 *  would: Projects view -> open that project -> backlog tab. */
async function openBacklog(page: Page, project: "cutover" | "shadow" | "virgin"): Promise<void> {
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: `Open all ${labels[project]} checkouts` }).click();
  await page.getByRole("button", { name: "backlog" }).click();
  await page.locator(".backlog-view").waitFor();
}

test("a migrated project's board renders the DB tickets and never the frozen Markdown", { skip: !CHROME_PATH }, async () => {
  const page = await newPage();
  await openBacklog(page, "cutover");
  await page.locator(".backlog-result-count").waitFor();

  const ids = await page.locator(".backlog-id").allTextContents();
  assert.deepEqual(ids.map((s) => s.trim()).sort(), ["FG-1", "FG-2", "FG-E"], "the migrated tickets render");

  const body = await page.locator("body").innerText();
  assert.ok(!body.includes(FROZEN_ID), "a ticket file frozen in backlog/*.md must never render");
  assert.ok(!body.includes("Frozen markdown story"), "nor its title");

  // Legacy `blocked` is stored as active + evidence and reconstructed on read.
  // Here it has to survive all the way into a rendered status badge.
  const blockedCard = page.locator(".backlog-ticket-card", { hasText: "Migrated blocked" });
  await blockedCard.waitFor();
  assert.match(await blockedCard.innerText(), /blocked/, "the reconstructed blocked status reaches the badge");

  // A db-mode board carries no caveat: it IS truth.
  assert.equal(await page.locator(".backlog-shadow-badge").count(), 0, "an authoritative board shows no shadow badge");
  assert.equal(await page.locator(".backlog-no-truth").count(), 0);

  // A ticket belongs to a project, not a checkout — the checkout chip that the
  // deleted branch-local resolution used to attach is gone from ticket cards.
  assert.equal(
    await page.locator(".backlog-ticket-card .checkout-chip").count(),
    0,
    "ticket cards carry no checkout chip after the cutover",
  );

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "fg608-cutover-board.png"), fullPage: true });
  await page.close();
});

test("an imported-but-not-migrated project is labeled a non-authoritative shadow", { skip: !CHROME_PATH }, async () => {
  const page = await newPage();
  await openBacklog(page, "shadow");

  const badge = page.locator(".backlog-shadow-badge");
  await badge.waitFor();
  const text = await badge.innerText();
  assert.match(text, /not authoritative/i, "the operator is told these rows are not truth");
  assert.match(text, /markdown mode/i, "and which store is");
  assert.equal(await page.locator(".backlog-no-truth").count(), 0, "a shadow is not 'no truth'");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "fg608-shadow-board.png"), fullPage: true });
  await page.close();
});

test("a never-imported project says it has no ticket truth, not that it has no tickets", { skip: !CHROME_PATH }, async () => {
  const page = await newPage();
  await openBacklog(page, "virgin");

  const noTruth = page.locator(".backlog-no-truth");
  await noTruth.waitFor();
  const text = await noTruth.innerText();
  // The distinction this slice's payload fields exist to make: an unimported
  // project must not be rendered with the empty-board copy, because the operator
  // action for each is different (migrate vs file a ticket).
  assert.doesNotMatch(
    text,
    /^No backlog tickets found for this project\.$/,
    "'never imported' must not render as 'empty board'",
  );
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("VI-1"), "its branch-local Markdown ticket is not rendered as truth");

  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, "fg608-no-truth-board.png"), fullPage: true });
  await page.close();
});
