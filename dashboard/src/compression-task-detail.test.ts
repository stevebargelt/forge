// Integration tests for FG-323: per-task compression detail in taskDetail().
//
// Tests the three scenarios:
//   1. Task with a compression.verification event (agent_compressed=true) → compressionEvent populated
//   2. Task with a compression.verification event (orchestrator_compressed=true) → compressionEvent populated
//   3. Task with a result but no compression event → compressionEvent=null, resultSizeBytes set
//   4. Task with no result and no compression event → compressionEvent=null, resultSizeBytes=null
//   5. Malformed compression event payload → compressionEvent=null (graceful)
//   6. compressionEvent fields: fieldsCompressed array, method, ccrId, sizes, ratio all map correctly
//   7. /api/task/:id HTTP endpoint includes compressionEvent + resultSizeBytes in JSON response

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http from "node:http";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-ctd-"));
process.env.FORGE_HOME = tmpHome;

const dbPath = join(tmpHome, "forge.db");
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT,
      status TEXT, result TEXT, error TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT
    );
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE verdicts (id TEXT PRIMARY KEY, task_id TEXT, red_task_id TEXT, red_role TEXT, verdict TEXT, confidence REAL, authority TEXT, findings TEXT, created_at TEXT);
    CREATE TABLE gates (id TEXT PRIMARY KEY, task_id TEXT, decision TEXT, rationale TEXT, decided_at TEXT, decided_by TEXT);

    INSERT INTO runs VALUES ('r1','Test Run','feature','/proj','complete', datetime('now','-1 day'));

    -- task A: agent compressed, with full payload
    INSERT INTO tasks VALUES (
      'ta', 'r1', 'impl', 'engineer', NULL, 'complete',
      '{"status":"complete","notes":"done"}', NULL, NULL,
      datetime('now','-1 day'), datetime('now','-1 day')
    );
    INSERT INTO events VALUES (NULL,'r1','ta','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":["notes","stdout"],"original_size_bytes":122880,"compressed_size_bytes":15360,"compression_ratio":0.875,"method":"SmartCrusher","ccr_id":"abc123"}',
      datetime('now','-1 day'));

    -- task B: orchestrator compressed, no ccr_id
    INSERT INTO tasks VALUES (
      'tb', 'r1', 'impl', 'engineer', NULL, 'complete',
      '{"status":"complete"}', NULL, NULL,
      datetime('now','-1 day'), datetime('now','-1 day')
    );
    INSERT INTO events VALUES (NULL,'r1','tb','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,"fields_compressed":["diff_summary"],"original_size_bytes":46080,"compressed_size_bytes":6144,"compression_ratio":0.8667,"method":"CodeCompressor"}',
      datetime('now','-1 day'));

    -- task C: has a result but NO compression event (below threshold)
    INSERT INTO tasks VALUES (
      'tc', 'r1', 'impl', 'engineer', NULL, 'complete',
      '{"status":"complete","notes":"small"}', NULL, NULL,
      datetime('now','-1 day'), datetime('now','-1 day')
    );

    -- task D: no result, no compression event
    INSERT INTO tasks VALUES (
      'td', 'r1', 'impl', 'engineer', NULL, 'failed',
      NULL, 'timeout', NULL,
      datetime('now','-1 day'), datetime('now','-1 day')
    );

    -- task E: malformed compression event payload
    INSERT INTO tasks VALUES (
      'te', 'r1', 'impl', 'engineer', NULL, 'complete',
      '{"status":"complete"}', NULL, NULL,
      datetime('now','-1 day'), datetime('now','-1 day')
    );
    INSERT INTO events VALUES (NULL,'r1','te','compression.verification',
      'not-valid-json!!!', datetime('now','-1 day'));

    -- non-compression event for task A (must not affect compressionEvent)
    INSERT INTO events VALUES (NULL,'r1','ta','task.completed',NULL, datetime('now','-1 day'));
  `);
  db.close();
}

const { taskDetail } = await import("./queries.js");

// ─── Unit-level tests (taskDetail() function) ─────────────────────────────────

test("taskDetail: agent_compressed=true → compressionEvent.agentCompressed=true", () => {
  const d = taskDetail("ta");
  assert.ok(d, "must find task ta");
  assert.ok(d.compressionEvent !== null, "compressionEvent must be present");
  assert.equal(d.compressionEvent!.agentCompressed, true);
  assert.equal(d.compressionEvent!.orchestratorCompressed, false);
});

test("taskDetail: compressionEvent fields map correctly from event payload", () => {
  const d = taskDetail("ta");
  assert.ok(d?.compressionEvent);
  const ev = d.compressionEvent!;
  assert.deepEqual(ev.fieldsCompressed, ["notes", "stdout"]);
  assert.equal(ev.originalSizeBytes, 122880);
  assert.equal(ev.compressedSizeBytes, 15360);
  assert.ok(Math.abs(ev.compressionRatio! - 0.875) < 0.0001);
  assert.equal(ev.method, "SmartCrusher");
  assert.equal(ev.ccrId, "abc123");
});

test("taskDetail: orchestrator_compressed=true → compressionEvent.orchestratorCompressed=true", () => {
  const d = taskDetail("tb");
  assert.ok(d?.compressionEvent);
  assert.equal(d.compressionEvent!.agentCompressed, false);
  assert.equal(d.compressionEvent!.orchestratorCompressed, true);
  assert.equal(d.compressionEvent!.method, "CodeCompressor");
  assert.equal(d.compressionEvent!.ccrId, null);
});

test("taskDetail: no compression event → compressionEvent=null", () => {
  const d = taskDetail("tc");
  assert.ok(d, "must find task tc");
  assert.equal(d.compressionEvent, null);
});

test("taskDetail: resultSizeBytes is non-null when task has a result", () => {
  const d = taskDetail("tc");
  assert.ok(d);
  assert.ok(typeof d.resultSizeBytes === "number", "resultSizeBytes must be a number");
  assert.ok(d.resultSizeBytes! > 0, "resultSizeBytes must be positive");
});

test("taskDetail: resultSizeBytes is null when task has no result", () => {
  const d = taskDetail("td");
  assert.ok(d);
  assert.equal(d.resultSizeBytes, null);
});

test("taskDetail: malformed compression event payload → compressionEvent=null", () => {
  const d = taskDetail("te");
  assert.ok(d);
  assert.equal(d.compressionEvent, null, "malformed JSON must yield null compressionEvent");
});

test("taskDetail: unknown taskId returns null", () => {
  const d = taskDetail("does-not-exist");
  assert.equal(d, null);
});

// ─── HTTP endpoint tests ───────────────────────────────────────────────────────
// Starts a minimal server wired to the real taskDetail function and verifies
// that compressionEvent + resultSizeBytes appear in the JSON response.

let BASE = "";
let srv: ReturnType<typeof createServer>;

before(async () => {
  srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const m = u.pathname.match(/^\/api\/task\/(.+)$/);
      if (m) {
        const d = taskDetail(m[1]!);
        if (!d) { res.writeHead(404).end(JSON.stringify({ error: "not found" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(d));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  srv.unref();
  const addr = srv.address() as { port: number };
  BASE = `http://127.0.0.1:${addr.port}`;
});

after(() => { srv?.close(); });

function get(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (c: string) => { raw += c; });
      res.on("end", () => {
        res.socket?.unref();
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

test("GET /api/task/:id — compressionEvent in response for agent-compressed task", async () => {
  const { status, body } = await get(`${BASE}/api/task/ta`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  assert.ok(d["compressionEvent"] !== null, "compressionEvent must be present");
  const ev = d["compressionEvent"] as Record<string, unknown>;
  assert.equal(ev["agentCompressed"], true);
  assert.equal(ev["method"], "SmartCrusher");
  assert.ok(typeof d["resultSizeBytes"] === "number");
});

test("GET /api/task/:id — compressionEvent in response for orchestrator-compressed task", async () => {
  const { status, body } = await get(`${BASE}/api/task/tb`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  const ev = d["compressionEvent"] as Record<string, unknown>;
  assert.equal(ev["orchestratorCompressed"], true);
  assert.equal(ev["agentCompressed"], false);
});

test("GET /api/task/:id — compressionEvent=null and resultSizeBytes set for uncompressed task", async () => {
  const { status, body } = await get(`${BASE}/api/task/tc`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  assert.equal(d["compressionEvent"], null);
  assert.ok(typeof d["resultSizeBytes"] === "number");
  assert.ok((d["resultSizeBytes"] as number) > 0);
});

test("GET /api/task/:id — resultSizeBytes=null when no result", async () => {
  const { status, body } = await get(`${BASE}/api/task/td`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  assert.equal(d["resultSizeBytes"], null);
});

test("GET /api/task/:id — 404 for unknown task", async () => {
  const { status } = await get(`${BASE}/api/task/no-such-task`);
  assert.equal(status, 404);
});
