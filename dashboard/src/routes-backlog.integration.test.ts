// Integration tests for GET /api/backlog (FG-363 Dashboard Backlog Viewer,
// re-based on host-wide DB truth by FG-608).
//
// Boots the real dashboard HTTP server on a dedicated test port, exercises the
// route with a real fixture project, and confirms read-only behaviour.
//
// The fixture is a registered, db-mode project: tickets live in the host store
// keyed by project_key, and `backlog/notes.md` stays a per-checkout filesystem
// read (FG-380 operational state). The dashboard and `forge backlog list` must
// still name the same tickets — the agreement is now against the seam's DB
// reader rather than against a directory of markdown files.
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
import { repositoryCheckoutIdentity } from "../../src/util/repository-identity.js";

const TEST_PORT = 18764;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// --- env must be set before server.ts is evaluated (module-level reads) ---
const tmpHome = mkdtempSync(join(tmpdir(), "forge-backlog-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "forge-backlog-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// --- fixture project: a real git checkout with backlog/notes.md, registered
// (via a DB run row) so projectsForDashboard() resolves an exact projectDir
// request to it, and registered again in project_identity so its repository
// evidence resolves to a project_key that owns ticket rows. ---
const fixtureDir = mkdtempSync(join(tmpdir(), "forge-backlog-fx-"));
execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"], { cwd: fixtureDir, stdio: "ignore" });
mkdirSync(join(fixtureDir, "backlog"), { recursive: true });

writeFileSync(
  join(fixtureDir, "backlog", "notes.md"),
  "# Session handoff\n\nSome notes here.\n",
);

const PROJECT_KEY = "pk-backlog-fx";

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
  database
    .prepare("INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)")
    .run(PROJECT_KEY, repositoryCheckoutIdentity(fixtureDir).key, "remote", "2026-07-15T10:00:00Z");
  database
    .prepare("INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)")
    .run(PROJECT_KEY, "db", "2026-07-15T10:00:00Z");
  const insertTicket = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,NULL)`,
  );
  const at = "2026-07-15T10:00:00Z";
  insertTicket.run(PROJECT_KEY, "FG-100", "epic", "active", "Test Epic", "Epic body.", null, at);
  insertTicket.run(PROJECT_KEY, "FG-101", "story", "active", "Test Story", "Story body.", "FG-100", at);
  insertTicket.run(PROJECT_KEY, "FG-102", "idea", "active", "Test Idea", "Idea body.", null, at);
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

type BacklogBody = {
  notes: string;
  tickets: Array<Record<string, unknown>>;
  ticketsProjectKey: string | null;
  ticketsStorageMode: string | null;
};

async function getBacklog(params: string): Promise<BacklogBody> {
  const res = await fetch(`${BASE}/api/backlog${params}`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status} for /api/backlog${params}`);
  return res.json() as Promise<BacklogBody>;
}

// ---- tests ----

test("GET /api/backlog: returns 200 with notes and tickets for a real backlog", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  assert.ok(body.notes.includes("Session handoff"), "notes must include fixture content");
  assert.ok(Array.isArray(body.tickets), "tickets must be an array");
  assert.ok(body.tickets.length >= 3, `expected >=3 tickets, got ${body.tickets.length}`);
  assert.equal(body.ticketsProjectKey, PROJECT_KEY, "the response names the project_key it read");
  assert.equal(body.ticketsStorageMode, "db");
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

test("GET /api/backlog: story ticket carries epic field when set", async () => {
  const { tickets } = await getBacklog(`?projectDir=${encodeURIComponent(fixtureDir)}`);
  const story = tickets.find((t) => t["id"] === "FG-101");
  assert.ok(story, "FG-101 story not found in response");
  assert.equal(story!["epic"], "FG-100", "story must carry its epic field");
});

test("GET /api/backlog: unknown project dir → 200 with empty notes and tickets, not 500", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "forge-no-backlog-"));
  const res = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(emptyDir)}`);
  assert.equal(res.status, 200, "an unknown project must return 200, not an error status");
  const body = (await res.json()) as BacklogBody;
  assert.equal(body.notes, "", "notes must be empty string for a directory with no backlog");
  assert.deepEqual(body.tickets, [], "tickets must be empty array with no ticket truth");
  assert.equal(body.ticketsProjectKey, null);
});

test("GET /api/backlog: missing projectDir param → 200 with empty payload", async () => {
  const body = await getBacklog("");
  assert.equal(body.notes, "", "notes must be empty when projectDir is omitted");
  assert.deepEqual(body.tickets, [], "tickets must be empty when projectDir is omitted");
  assert.equal(body.ticketsProjectKey, null);
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
