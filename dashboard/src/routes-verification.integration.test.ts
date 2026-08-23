// Integration tests for the host-side verification visibility routes:
// GET /api/verifications/in-progress, /api/review-loop/phases,
// /api/host-verifications (?ticketId / ?itemId), and the FG-746 Explain
// verificationEvidence sidecar on GET /api/task/:id/explain. The unscoped
// /api/host-verifications/recent feed was RETIRED with the standalone
// Verification tab (FG-746) and now 404s.
//
// Mirrors the harness in routes-backlog.integration.test.ts: boot the real
// dashboard HTTP server on a dedicated test port against a real forge.db
// (hand-shaped fixture, same table set as queries-verification.test.ts),
// exercise the routes end-to-end over HTTP.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18765;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// --- env must be set before server.ts is evaluated (module-level reads) ---
const tmpHome = mkdtempSync(join(tmpdir(), "forge-verify-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// --- fixture forge.db: same table set as queries-verification.test.ts ---
const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_alias TEXT, agent_model TEXT, status TEXT, task_package TEXT, result TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
  CREATE TABLE gates (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, decision TEXT, rationale TEXT, decided_at TEXT, decided_by TEXT);
  CREATE TABLE verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, red_task_id TEXT, red_role TEXT, verdict TEXT, authority TEXT, confidence REAL, findings TEXT, created_at TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE campaigns (id TEXT PRIMARY KEY, status TEXT, source_kind TEXT, source_input TEXT, mode TEXT, created_at TEXT, updated_at TEXT, metadata TEXT, project_dir TEXT);
  CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT, item_order INTEGER, ticket_id TEXT, run_id TEXT, lifecycle_status TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE reviews (id TEXT PRIMARY KEY, run_id TEXT, candidate_sha TEXT, updated_at TEXT);
  CREATE TABLE host_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, project_dir TEXT, commit_sha TEXT, gate_name TEXT, command TEXT, exit_code INTEGER, run_id TEXT, recorded_at TEXT, source TEXT DEFAULT 'host', ci_url TEXT);
`);

function insertEvent(runId: string | null, eventType: string, payload: unknown, createdAtIso: string): void {
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`).run(
    runId,
    eventType,
    JSON.stringify(payload),
    createdAtIso,
  );
}

const nowIso = new Date().toISOString();

// a fresh, unmatched review-loop verification start
db.prepare(`INSERT INTO runs VALUES ('run-fresh','review-loop #FG-900','invoke','/proj/a','active', ?)`).run(nowIso);
insertEvent("run-fresh", "review_loop.verification_started", { attemptId: "attempt-fresh", round: 1, ticketId: "FG-900", sha: "abc1234", mode: "local" }, nowIso);

// a run mid-task ("reviewing" phase): verification finished, red-wide task still running
db.prepare(`INSERT INTO runs VALUES ('run-reviewing','review-loop #FG-920','invoke','/proj/b','active', ?)`).run(nowIso);
insertEvent("run-reviewing", "review_loop.verification_started", { attemptId: "attempt-rev-1", round: 1, ticketId: "FG-920", sha: "eee4444", mode: "local" }, nowIso);
insertEvent("run-reviewing", "review_loop.verification_finished", { attemptId: "attempt-rev-1", ok: true }, nowIso);
db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, agent_alias, agent_model, status, task_package, result, started_at, created_at, parent_id)
  VALUES ('task-red-1','run-reviewing','red-wide','red-wide',NULL,'sonnet','running','{}',NULL, ?, ?, NULL)`).run(nowIso, nowIso);
// FG-746 (AC6): the run's review names its candidate sha; two host_verifications rows
// share it (one run_id-tagged, one run_id-NULL) so the Explain sidecar's sha-primary /
// run_id-fallback binding is exercised over HTTP.
db.prepare(`INSERT INTO reviews VALUES ('rev-reviewing','run-reviewing','eee4444', ?)`).run(nowIso);
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-920','/proj/b','eee4444','npm run test:all','npm run test:all',0,'run-reviewing',?, 'host', NULL)
`).run(nowIso);
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-920','/proj/b','eee4444','test-extended','npm run test:extended',0,NULL,?, 'ci', 'https://ci.example/920')
`).run(nowIso);

// host_verifications evidence rows, scoped by ticket + campaign item
db.prepare(`INSERT INTO campaigns VALUES ('camp-2','paused','tickets','[]','auto', ?, ?, NULL, '/proj/c')`).run(nowIso, nowIso);
db.prepare(`INSERT INTO campaign_items VALUES ('item-ev-1','camp-2', 0, 'FG-930', NULL, 'awaiting_gate', ?, ?)`).run(nowIso, nowIso);
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-930','/proj/c','sha1','npm run test:all','npm run test:all',0,NULL,?, 'host', NULL)
`).run(nowIso);

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

// ---- tests ----

test("GET /api/verifications/in-progress: returns 200 with the fresh unmatched start", async () => {
  const res = await fetch(`${BASE}/api/verifications/in-progress`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r["attemptId"] === "attempt-fresh");
  assert.ok(row, "expected attempt-fresh to be in progress over HTTP");
  assert.equal(row!["ticketId"], "FG-900");
});

test("GET /api/verifications/in-progress: projectDir filter scopes to the matching run", async () => {
  const res = await fetch(`${BASE}/api/verifications/in-progress?projectDir=${encodeURIComponent("/proj/b")}`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  assert.equal(rows.find((r) => r["attemptId"] === "attempt-fresh"), undefined, "/proj/a row must not leak into /proj/b");
});

test("GET /api/review-loop/phases: returns 200 with run-reviewing in phase 'reviewing'", async () => {
  const res = await fetch(`${BASE}/api/review-loop/phases`);
  assert.equal(res.status, 200);
  const phases = (await res.json()) as Array<Record<string, unknown>>;
  const entry = phases.find((p) => p["runId"] === "run-reviewing");
  assert.ok(entry, "expected a phase entry for run-reviewing over HTTP");
  assert.equal(entry!["phase"], "reviewing");
  assert.equal(entry!["ticketId"], "FG-920");
});

test("GET /api/host-verifications: ticketId param returns scoped evidence rows", async () => {
  const res = await fetch(`${BASE}/api/host-verifications?ticketId=FG-930`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["commitSha"], "sha1");
});

test("GET /api/host-verifications: itemId param resolves via campaign_items and returns the same evidence", async () => {
  const res = await fetch(`${BASE}/api/host-verifications?itemId=item-ev-1`);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["ticketId"], "FG-930");
});

test("GET /api/host-verifications: neither ticketId nor itemId → 400", async () => {
  const res = await fetch(`${BASE}/api/host-verifications`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error);
});

test("GET /api/host-verifications/recent: RETIRED with the standalone Verification tab (FG-746) — 404, while the scoped lookups above still serve", async () => {
  const res = await fetch(`${BASE}/api/host-verifications/recent?limit=10`);
  assert.equal(res.status, 404, "the unscoped global recent feed had no remaining consumer after tab retirement and was removed");
  // drain the body so the connection is not left half-read
  await res.text();
});

test("GET /api/task/:id/explain: returns the untouched TaskExplain PLUS a candidate-bound verificationEvidence sidecar (FG-746 AC6)", async () => {
  const res = await fetch(`${BASE}/api/task/task-red-1/explain?projectDir=${encodeURIComponent("/proj/b")}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version?: unknown; task?: unknown; verificationEvidence?: Array<Record<string, unknown>> };
  // The shared TaskExplain shape is intact (version + task present) alongside the sidecar.
  assert.ok(body.version !== undefined, "the untouched TaskExplain fields ride alongside the sidecar");
  assert.ok(Array.isArray(body.verificationEvidence), "verificationEvidence is a sibling array");
  const shas = body.verificationEvidence!.map((r) => r["commitSha"]);
  assert.deepEqual(shas.sort(), ["eee4444", "eee4444"], "both candidate-sha rows attach, incl. the run_id-NULL one; bound to the run's candidate");
  assert.ok(
    body.verificationEvidence!.some((r) => r["source"] === "ci" && r["runId"] === null),
    "the run_id-NULL ci row attaches by the primary sha bind",
  );
});

test("GET /api/task/:id/explain: cross-project scoping is fail-closed — no evidence under a foreign project scope", async () => {
  const res = await fetch(`${BASE}/api/task/task-red-1/explain?projectDir=${encodeURIComponent("/proj/elsewhere")}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { verificationEvidence?: Array<Record<string, unknown>> };
  assert.deepEqual(body.verificationEvidence ?? [], [], "the task's run is out of scope, so the sidecar attaches nothing");
});
