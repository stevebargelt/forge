// FG-643 — a hostile ticket body must remain raw in the real backlog store but
// become inert when the real dashboard renders it in Chrome.  This deliberately
// uses `forge backlog migrate` rather than inserting a cleaned fixture or ticket
// row: migration is the host-side storage path the dashboard is required to
// tolerate safely.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { requireChrome } from "../../src/util/chrome-bin.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../src/backlog/container-authority.testkit-spawn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
const LOCAL_TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSX = existsSync(LOCAL_TSX) ? LOCAL_TSX : "tsx";
const PORT = 18793;
const BASE = `http://127.0.0.1:${PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "fg643-browser-"));
const forgeHome = join(testHome, ".forge");
const projectDir = join(testHome, "checkout");

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = testHome;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const TICKET_ID = "FG-643-XSS";
const RAW_BODY = `# Benign heading

Normal **bold** text and [safe link](https://example.com/ok).

<img src=x onerror="window.__xss=1">
<script>window.__xss=2</script>
<a href="javascript:window.__xss=3">javascript link</a>
<a href="JaVaScRiPt:window.__xss=4">mixed case link</a>
<a href="&#106;avascript:window.__xss=5">encoded link</a>
<iframe src="javascript:window.__xss=6"></iframe>
<svg onload="window.__xss=7"></svg>`;

let browser: Browser | undefined;
let server: Server | undefined;
let projectLabel = "";

function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: projectDir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function forge(args: string[]): string {
  const result = spawnSync(TSX, withAuthorityTestkit(CLI_ENTRY, args), {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      FORGE_DB_PATH: join(forgeHome, "forge.db"),
      ...authorityTestkitEnv(),
    },
  });
  assert.equal(result.status, 0, `forge ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout ?? "";
}

async function backlog(): Promise<{ tickets: Array<{ id: string; body: string }> }> {
  const response = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(projectDir)}`);
  assert.equal(response.status, 200);
  return (await response.json()) as { tickets: Array<{ id: string; body: string }> };
}

before(async () => {
  mkdirSync(forgeHome, { recursive: true });
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", "git@github.com:forge-tests/fg643-xss.git"]);
  writeFileSync(
    join(projectDir, "backlog", "stories", `${TICKET_ID}-xss.md`),
    `---\nid: ${TICKET_ID}\ntype: story\nstatus: active\ntitle: \"Raw hostile Markdown\"\n---\n\n${RAW_BODY}\n`,
  );

  // The production writer imports the raw body into the DB and flips the project
  // to DB truth.  The only direct DB write below is the run visibility record;
  // it is not ticket data.
  forge(["backlog", "migrate", "--json"]);
  const database = new Database(join(forgeHome, "forge.db"));
  database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)")
    .run("fg643-run", "feature", "FG-643 browser fixture", "complete", "2026-08-15T00:00:00Z", projectDir);
  database.prepare("INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)")
    .run("fg643-task", "fg643-run", "engineer", "engineer", "complete", "2026-08-15T00:00:00Z", "2026-08-15T00:00:00Z", "2026-08-15T00:00:00Z");
  database.close();

  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 74) throw new Error("dashboard test server did not start");
      await new Promise((done) => setTimeout(done, 40));
    }
  }
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ label: string; projectDirs: string[] }>;
  const project = projects.find((entry) => entry.projectDirs.includes(projectDir));
  assert.ok(project, "the real dashboard registry must discover the migrated checkout");
  projectLabel = project.label;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

async function openTicket(page: Page): Promise<void> {
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: `Open all ${projectLabel} checkouts` }).click();
  await page.getByRole("button", { name: "backlog" }).click();
  await page.getByRole("button", { name: `Open story ${TICKET_ID}: Raw hostile Markdown` }).click();
  await page.getByRole("dialog", { name: `Ticket ${TICKET_ID}` }).waitFor();
}

test("raw hostile ticket content remains stored but is inert in the real dashboard", async () => {
  const stored = await backlog();
  const ticket = stored.tickets.find((entry) => entry.id === TICKET_ID);
  assert.ok(ticket, "the API returns the ticket written through the real migration path");
  assert.equal(ticket.body, RAW_BODY, "rendering sanitizes output only; it never mutates stored ticket bytes");

  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  const dialogs: string[] = [];
  const navigations: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await openTicket(page);

  // Runtime proof first: no payload was executed and it did not cause navigation
  // or a dialog.  DOM checks below distinguish removal from merely visible text.
  assert.equal(await page.evaluate(() => (window as Window & { __xss?: number }).__xss), undefined);
  assert.deepEqual(dialogs, [], "no hostile payload opened a dialog");
  assert.deepEqual(navigations, [BASE + "/#projects"], "no hostile URL navigated the dashboard");
  assert.deepEqual(await page.locator(".detail .md").evaluate((node) => ({
    scripts: node.querySelectorAll("script").length,
    handlers: node.querySelectorAll("[onerror], [onload]").length,
    javascriptLinks: node.querySelectorAll('a[href^="javascript:"]').length,
    encodedOrMixedCaseJavascriptLinks: Array.from(node.querySelectorAll("a[href]")).filter((link) =>
      /^\s*javascript\s*:/i.test(link.getAttribute("href") ?? "")
    ).length,
    iframes: node.querySelectorAll("iframe").length,
    svgs: node.querySelectorAll("svg").length,
  })), {
    scripts: 0,
    handlers: 0,
    javascriptLinks: 0,
    encodedOrMixedCaseJavascriptLinks: 0,
    iframes: 0,
    svgs: 0,
  });

  // A safe control from that exact stored field still passes through Markdown.
  assert.equal(await page.locator(".detail .md h1").innerText(), "Benign heading");
  assert.equal(await page.locator(".detail .md strong").innerText(), "bold");
  assert.equal(await page.locator('.detail .md a[href="https://example.com/ok"]').count(), 1);
  await page.close();
});
