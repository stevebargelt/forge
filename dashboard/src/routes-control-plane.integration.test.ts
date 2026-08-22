// FG-349 [G]: the /api/config-graph route, end-to-end over HTTP. Boot the real
// dashboard server against a temp FORGE_HOME; assert the GET returns the graph,
// the projectKey-without-checkout 409, the POST-405 (no mutation route), and
// byte-equality with the in-process effectiveConfigGraph.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18823;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cp-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// minimal forge.db so the server boots cleanly (config-graph does not read it)
const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
`);
db.close();

const projectDir = mkdtempSync(join(tmpdir(), "forge-cp-rt-proj-"));
mkdirSync(join(projectDir, ".forge"), { recursive: true });

const { effectiveConfigGraph } = await import("./queries.js");
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

test("GET /api/config-graph?projectDir=<dir> returns 200 with the graph", async () => {
  const res = await fetch(`${BASE}/api/config-graph?projectDir=${encodeURIComponent(projectDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.equal(body.project.status, "active");
  assert.ok(body.sections.sources.rows.length > 0);
});

test("the body equals effectiveConfigGraph(projectDir) serialized", async () => {
  const res = await fetch(`${BASE}/api/config-graph?projectDir=${encodeURIComponent(projectDir)}`);
  const text = await res.text();
  assert.equal(text, JSON.stringify(effectiveConfigGraph(projectDir)));
});

test("a projectKey without an exact projectDir returns 409", async () => {
  const res = await fetch(`${BASE}/api/config-graph?projectKey=some-key`);
  assert.equal(res.status, 409);
});

test("a POST to /api/config-graph falls through to 405 (no mutation route)", async () => {
  const res = await fetch(`${BASE}/api/config-graph?projectDir=${encodeURIComponent(projectDir)}`, { method: "POST" });
  assert.equal(res.status, 405);
});
