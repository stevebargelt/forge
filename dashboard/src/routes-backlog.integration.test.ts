// Integration tests for GET /api/backlog (FG-363 Dashboard Backlog Viewer).
//
// Boots the real dashboard HTTP server on a dedicated test port, exercises the
// route with a real fixture backlog, and confirms read-only behaviour.
//
// Mirrors the harness in queries-ops.test.ts: env vars set before import,
// dynamic server import, real fixture filesystem, HTTP assertions.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { listTickets } from "@forge/backlog";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18764;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// --- env must be set before server.ts is evaluated (module-level reads) ---
const tmpHome = mkdtempSync(join(tmpdir(), "forge-backlog-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "forge-backlog-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// --- fixture project: a real canonical main checkout with backlog/ notes +
// epic/story/idea tickets. Tickets are backlog truth only on the canonical
// repository's primary main checkout, so the fixture must be a git checkout on
// main and registered (via a DB run row) so projectsForDashboard() resolves an
// exact projectDir request to it. ---
const fixtureDir = mkdtempSync(join(tmpdir(), "forge-backlog-fx-"));
execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"], { cwd: fixtureDir, stdio: "ignore" });
mkdirSync(join(fixtureDir, "backlog", "epics"), { recursive: true });
mkdirSync(join(fixtureDir, "backlog", "stories"), { recursive: true });
mkdirSync(join(fixtureDir, "backlog", "ideas"), { recursive: true });

writeFileSync(
  join(fixtureDir, "backlog", "notes.md"),
  "# Session handoff\n\nSome notes here.\n",
);
writeFileSync(
  join(fixtureDir, "backlog", "epics", "FG-100-test-epic.md"),
  "---\nid: FG-100\ntype: epic\nstatus: active\ntitle: Test Epic\n---\nEpic body.\n",
);
writeFileSync(
  join(fixtureDir, "backlog", "stories", "FG-101-test-story.md"),
  "---\nid: FG-101\ntype: story\nstatus: active\ntitle: Test Story\nepic: FG-100\n---\nStory body.\n",
);
writeFileSync(
  join(fixtureDir, "backlog", "ideas", "FG-102-test-idea.md"),
  "---\nid: FG-102\ntype: idea\nstatus: active\ntitle: Test Idea\n---\nIdea body.\n",
);

// Register the fixture as a known project so projectsForDashboard() resolves
// an exact projectDir request to this canonical main checkout.
{
  const database = new Database(join(tmpHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  database
    .prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)")
    .run("run-backlog-fx", "feature", "Backlog fixture", "complete", "2026-07-15T10:00:00Z", fixtureDir);
  database
    .prepare(
      "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
    )
    .run("done-backlog-fx", "run-backlog-fx", "engineer", "engineer", "complete", "2026-07-15T10:00:00Z", "2026-07-15T10:00:00Z", "2026-07-15T10:00:00Z");
  database.close();
}

// --- start the real server (side-effect import; reads PORT from env) ---
const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}

await waitForServer();

// ---- helpers ----

async function getBacklog(params: string): Promise<{ notes: string; tickets: Array<Record<string, unknown>> }> {
  const res = await fetch(`${BASE}/api/backlog${params}`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status} for /api/backlog${params}`);
  return res.json() as Promise<{ notes: string; tickets: Array<Record<string, unknown>> }>;
}

// ---- tests ----

test("GET /api/backlog: returns 200 with notes and tickets for a real backlog", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  assert.ok(body.notes.includes("Session handoff"), "notes must include fixture content");
  assert.ok(Array.isArray(body.tickets), "tickets must be an array");
  assert.ok(body.tickets.length >= 3, `expected >=3 tickets, got ${body.tickets.length}`);
});

test("GET /api/backlog: ticket set matches listTickets() — dashboard and CLI agree", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  const direct = listTickets(fixtureDir);

  assert.equal(
    body.tickets.length,
    direct.length,
    `HTTP returned ${body.tickets.length} tickets; listTickets() returned ${direct.length}`,
  );

  const httpIds = new Set(body.tickets.map((t) => t["id"]));
  const directIds = new Set(direct.map((t) => t.id));
  assert.deepEqual(
    [...httpIds].sort(),
    [...directIds].sort(),
    "ticket IDs from /api/backlog and listTickets() must match",
  );
});

test("GET /api/backlog: tickets include epic, story, and idea types", async () => {
  const { tickets } = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  const types = new Set(tickets.map((t) => t["type"]));
  assert.ok(types.has("epic"), "expected an epic ticket");
  assert.ok(types.has("story"), "expected a story ticket");
  assert.ok(types.has("idea"), "expected an idea ticket");
});

test("GET /api/backlog: story ticket carries epic field when set in frontmatter", async () => {
  const { tickets } = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  const story = tickets.find((t) => t["id"] === "FG-101");
  assert.ok(story, "FG-101 story not found in response");
  assert.equal(story!["epic"], "FG-100", "story must carry its epic field");
});

test("GET /api/backlog: absent backlog dir → 200 with empty notes and tickets, not 500", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "forge-no-backlog-"));
  const res = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(emptyDir)}`);
  assert.equal(res.status, 200, "absent backlog must return 200, not an error status");
  const body = (await res.json()) as { notes: string; tickets: unknown[] };
  assert.equal(body.notes, "", "notes must be empty string for absent backlog");
  assert.deepEqual(body.tickets, [], "tickets must be empty array for absent backlog");
});

test("GET /api/backlog: missing projectDir param → 200 with empty payload", async () => {
  const body = await getBacklog("");
  assert.equal(body.notes, "", "notes must be empty when projectDir is omitted");
  assert.deepEqual(body.tickets, [], "tickets must be empty when projectDir is omitted");
});

test("GET /api/backlog: read-only — no files written to fixture project", async () => {
  function snapMtimes(dir: string): Map<string, number> {
    const m = new Map<string, number>();
    function walk(d: string): void {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else m.set(full, statSync(full).mtimeMs);
      }
    }
    walk(dir);
    return m;
  }

  const backlogDir = join(fixtureDir, "backlog");
  const before = snapMtimes(backlogDir);
  await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(fixtureDir)}`);
  const after = snapMtimes(backlogDir);

  assert.deepEqual(
    [...before.keys()].sort(),
    [...after.keys()].sort(),
    "file set must not change after a GET request",
  );
  for (const [path, mt] of before) {
    assert.equal(after.get(path), mt, `${path} was modified — route must be read-only`);
  }
});
