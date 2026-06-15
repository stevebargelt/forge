// Integration tests for FG-323: per-task compression detail verification.
//
// These tests go beyond the unit-level engineer tests (compression-task-detail.test.ts)
// by explicitly covering the seven scenarios from the verification checklist:
//   1. taskDetail() query correctly joins compression.verification events
//   2. Tasks with no compression events return compressionEvent=null
//   3. Agent-compressed tasks → green-class badge with correct text/metrics
//   4. Orchestrator-compressed tasks → amber-class badge
//   5. Tasks below 20KB threshold → no compression section (resultSizeBytes < 20480, compressionEvent null)
//   6. Expandable detail section renders all fields (method, fields, sizes, ratio, ccrId)
//   7. Old tasks (pre-FG-317) render without errors (no events table rows, no crash)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http from "node:http";

// ─── Isolated tmp forge home ─────────────────────────────────────────────────

const tmpHome = mkdtempSync(join(tmpdir(), "fg323-int-"));
process.env.FORGE_HOME = tmpHome;

// ─── Seed DB ─────────────────────────────────────────────────────────────────

const dbPath = join(tmpHome, "forge.db");
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT,
      status TEXT, created_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT,
      agent_model TEXT, status TEXT, result TEXT, error TEXT, parent_id TEXT,
      started_at TEXT, completed_at TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT,
      event_type TEXT, payload TEXT, created_at TEXT
    );
    CREATE TABLE verdicts (
      id TEXT PRIMARY KEY, task_id TEXT, red_task_id TEXT, red_role TEXT,
      verdict TEXT, confidence REAL, authority TEXT, findings TEXT, created_at TEXT
    );
    CREATE TABLE gates (
      id TEXT PRIMARY KEY, task_id TEXT, decision TEXT, rationale TEXT,
      decided_at TEXT, decided_by TEXT
    );

    INSERT INTO runs VALUES ('r1','Test Run','feature','/proj','complete',datetime('now','-1 day'));

    -- Scenario 1 + 3: agent-compressed, full payload (result ~120KB so above threshold)
    INSERT INTO tasks VALUES (
      'agent-task','r1','impl','engineer',NULL,'complete',
      '{"status":"complete","diff_summary":"long diff text that gets compressed for context budget"}',
      NULL,NULL,datetime('now','-2 hour'),datetime('now','-1 hour')
    );
    INSERT INTO events VALUES (
      NULL,'r1','agent-task','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,
        "fields_compressed":["diff_summary","stdout"],
        "original_size_bytes":122880,"compressed_size_bytes":15360,
        "compression_ratio":0.875,"method":"SmartCrusher","ccr_id":"ccr-agent-001"}',
      datetime('now','-1 hour')
    );

    -- Scenario 4: orchestrator-compressed task
    INSERT INTO tasks VALUES (
      'orch-task','r1','impl','engineer',NULL,'complete',
      '{"status":"complete","notes":"orchestrator took over compression"}',
      NULL,NULL,datetime('now','-2 hour'),datetime('now','-1 hour')
    );
    INSERT INTO events VALUES (
      NULL,'r1','orch-task','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,
        "fields_compressed":["notes"],
        "original_size_bytes":45000,"compressed_size_bytes":5400,
        "compression_ratio":0.88,"method":"OrchestratorCompressor","ccr_id":null}',
      datetime('now','-1 hour')
    );

    -- Scenario 2 + 5: task with a result but NO compression event (result 8KB < 20KB threshold)
    INSERT INTO tasks VALUES (
      'small-task','r1','impl','engineer',NULL,'complete',
      '{"status":"complete","notes":"small output below threshold"}',
      NULL,NULL,datetime('now','-2 hour'),datetime('now','-1 hour')
    );

    -- Scenario 5 explicit: task whose result is exactly < 20KB (8192 bytes JSON)
    INSERT INTO tasks VALUES (
      'below-threshold','r1','impl','tech-lead',NULL,'complete',
      '{"status":"complete","steps":[{"id":1,"summary":"small plan step"}]}',
      NULL,NULL,datetime('now','-2 hour'),datetime('now','-1 hour')
    );

    -- Scenario 7: old task — has a result but NO events rows at all (simulates pre-FG-317 task)
    INSERT INTO tasks VALUES (
      'old-task','r1','impl','engineer',NULL,'complete',
      '{"status":"complete","diff_summary":"old format result before FG-317"}',
      NULL,NULL,datetime('now','-30 day'),datetime('now','-29 day')
    );

    -- Multiple compression events for one task: only the latest should be used
    INSERT INTO tasks VALUES (
      'multi-ev','r1','impl','engineer',NULL,'complete',
      '{"status":"complete"}',
      NULL,NULL,datetime('now','-3 hour'),datetime('now','-2 hour')
    );
    INSERT INTO events VALUES (
      NULL,'r1','multi-ev','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,
        "fields_compressed":["old_field"],"original_size_bytes":10000,
        "compressed_size_bytes":5000,"compression_ratio":0.5,"method":"OldMethod","ccr_id":"old-ccr"}',
      datetime('now','-3 hour')
    );
    INSERT INTO events VALUES (
      NULL,'r1','multi-ev','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,
        "fields_compressed":["new_field"],"original_size_bytes":20000,
        "compressed_size_bytes":8000,"compression_ratio":0.6,"method":"NewMethod","ccr_id":"new-ccr"}',
      datetime('now','-2 hour')
    );

    -- Non-compression events must not pollute compressionEvent
    INSERT INTO events VALUES (NULL,'r1','agent-task','task.completed',NULL,datetime('now','-1 hour'));
    INSERT INTO events VALUES (NULL,'r1','agent-task','task.started','{}',datetime('now','-2 hour'));
  `);
  db.close();
}

const { taskDetail } = await import("./queries.js");

// ─── Scenario 1: taskDetail() correctly joins compression.verification events ─

test("FG-323 sc1: taskDetail returns compressionEvent when compression.verification event exists", () => {
  const d = taskDetail("agent-task");
  assert.ok(d, "taskDetail must find agent-task");
  assert.ok(d.compressionEvent !== null, "compressionEvent must be non-null when event exists");
});

test("FG-323 sc1: compressionEvent payload fields all map correctly", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  const ev = d.compressionEvent!;
  assert.equal(ev.agentCompressed, true, "agentCompressed must be true");
  assert.equal(ev.orchestratorCompressed, false, "orchestratorCompressed must be false");
  assert.deepEqual(ev.fieldsCompressed, ["diff_summary", "stdout"]);
  assert.equal(ev.originalSizeBytes, 122880);
  assert.equal(ev.compressedSizeBytes, 15360);
  assert.ok(Math.abs(ev.compressionRatio! - 0.875) < 0.001, "compressionRatio must be ~0.875");
  assert.equal(ev.method, "SmartCrusher");
  assert.equal(ev.ccrId, "ccr-agent-001");
});

test("FG-323 sc1: only latest compression.verification event used when multiple exist", () => {
  const d = taskDetail("multi-ev");
  assert.ok(d?.compressionEvent);
  // Latest event has method "NewMethod"
  assert.equal(d.compressionEvent!.method, "NewMethod");
  assert.equal(d.compressionEvent!.ccrId, "new-ccr");
  assert.equal(d.compressionEvent!.orchestratorCompressed, true);
});

test("FG-323 sc1: non-compression events do not pollute compressionEvent (task still has correct event)", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  // Events array includes task.started and task.completed — compressionEvent must still be set
  assert.equal(d.compressionEvent!.method, "SmartCrusher");
  // events array should include all event types
  const types = d.events.map((e) => e.eventType);
  assert.ok(types.includes("task.completed"), "events array must include task.completed");
  assert.ok(types.includes("task.started"), "events array must include task.started");
});

// ─── Scenario 2: Tasks with no compression events ─────────────────────────────

test("FG-323 sc2: task with result but no compression event → compressionEvent=null", () => {
  const d = taskDetail("small-task");
  assert.ok(d, "must find small-task");
  assert.equal(d.compressionEvent, null, "compressionEvent must be null when no event");
});

test("FG-323 sc2: resultSizeBytes is set for task with no compression event", () => {
  const d = taskDetail("small-task");
  assert.ok(d);
  assert.ok(typeof d.resultSizeBytes === "number", "resultSizeBytes must be a number");
  assert.ok(d.resultSizeBytes! > 0, "resultSizeBytes must be positive");
});

// ─── Scenario 3: Agent-compressed badge class verification ───────────────────
// The badge class is set in renderers.js: "compression-badge-agent" for agentCompressed.
// We verify the data shape that drives the badge.

test("FG-323 sc3: agent-compressed task has agentCompressed=true (drives green badge)", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  assert.equal(d.compressionEvent!.agentCompressed, true);
  assert.equal(d.compressionEvent!.orchestratorCompressed, false);
});

test("FG-323 sc3: agent badge metrics — original/compressed sizes present", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  assert.ok(typeof d.compressionEvent!.originalSizeBytes === "number");
  assert.ok(typeof d.compressionEvent!.compressedSizeBytes === "number");
  assert.ok(d.compressionEvent!.compressedSizeBytes! < d.compressionEvent!.originalSizeBytes!,
    "compressed must be smaller than original");
});

// ─── Scenario 4: Orchestrator-compressed badge class ─────────────────────────

test("FG-323 sc4: orchestrator-compressed task has orchestratorCompressed=true (drives amber badge)", () => {
  const d = taskDetail("orch-task");
  assert.ok(d?.compressionEvent);
  assert.equal(d.compressionEvent!.agentCompressed, false);
  assert.equal(d.compressionEvent!.orchestratorCompressed, true);
});

test("FG-323 sc4: orchestrator badge method and size fields present", () => {
  const d = taskDetail("orch-task");
  assert.ok(d?.compressionEvent);
  assert.equal(d.compressionEvent!.method, "OrchestratorCompressor");
  assert.ok(typeof d.compressionEvent!.originalSizeBytes === "number");
  assert.ok(typeof d.compressionEvent!.compressedSizeBytes === "number");
});

// ─── Scenario 5: Below 20KB threshold → no compression section ───────────────
// The 20KB threshold is a UI concern: UI shows "below threshold" note when
// compressionEvent=null and resultSizeBytes is set but small.
// The data layer just sets compressionEvent=null when no event exists.

test("FG-323 sc5: task below 20KB threshold has compressionEvent=null", () => {
  const d = taskDetail("below-threshold");
  assert.ok(d, "must find below-threshold task");
  assert.equal(d.compressionEvent, null, "no compression event for below-threshold task");
});

test("FG-323 sc5: below-threshold task resultSizeBytes is well below 20KB", () => {
  const d = taskDetail("below-threshold");
  assert.ok(d);
  assert.ok(typeof d.resultSizeBytes === "number");
  // The seeded result JSON is < 100 bytes, well below 20480 (20KB)
  assert.ok(d.resultSizeBytes! < 20480,
    `resultSizeBytes (${d.resultSizeBytes}) must be < 20KB for below-threshold task`);
});

test("FG-323 sc5: small-task also has compressionEvent=null (no event, not compressed)", () => {
  const d = taskDetail("small-task");
  assert.ok(d);
  assert.equal(d.compressionEvent, null);
});

// ─── Scenario 6: Expandable detail section — all fields present in compressionEvent ─

test("FG-323 sc6: all CompressionEventData fields are present for fully-populated event", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  const ev = d.compressionEvent!;
  // All required fields
  assert.ok("agentCompressed" in ev, "agentCompressed field required");
  assert.ok("orchestratorCompressed" in ev, "orchestratorCompressed field required");
  assert.ok("fieldsCompressed" in ev, "fieldsCompressed field required");
  assert.ok(Array.isArray(ev.fieldsCompressed), "fieldsCompressed must be array");
  assert.ok("originalSizeBytes" in ev, "originalSizeBytes field required");
  assert.ok("compressedSizeBytes" in ev, "compressedSizeBytes field required");
  assert.ok("compressionRatio" in ev, "compressionRatio field required");
  assert.ok("method" in ev, "method field required");
  assert.ok("ccrId" in ev, "ccrId field required");
});

test("FG-323 sc6: fieldsCompressed array contains all expected field names", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent);
  assert.deepEqual(d.compressionEvent!.fieldsCompressed, ["diff_summary", "stdout"]);
});

test("FG-323 sc6: compressionRatio is a fraction between 0 and 1", () => {
  const d = taskDetail("agent-task");
  assert.ok(d?.compressionEvent?.compressionRatio != null);
  const ratio = d.compressionEvent!.compressionRatio!;
  assert.ok(ratio > 0 && ratio < 1, `compressionRatio ${ratio} must be between 0 and 1`);
});

test("FG-323 sc6: ccrId is null when not present in payload (orchestrator task)", () => {
  const d = taskDetail("orch-task");
  assert.ok(d?.compressionEvent);
  // The seeded orch-task payload has "ccr_id":null
  assert.equal(d.compressionEvent!.ccrId, null);
});

// ─── Scenario 7: Old tasks (pre-FG-317) render without errors ────────────────

test("FG-323 sc7: old task (no events at all) returns compressionEvent=null without crashing", () => {
  const d = taskDetail("old-task");
  assert.ok(d, "taskDetail must return a result for old-task");
  assert.equal(d.compressionEvent, null, "compressionEvent must be null for pre-FG-317 task");
  assert.ok(d.events.length === 0, "old task must have empty events array");
});

test("FG-323 sc7: old task still returns correct base task fields", () => {
  const d = taskDetail("old-task");
  assert.ok(d);
  assert.equal(d.task.taskId, "old-task");
  assert.equal(d.task.agentRole, "engineer");
  assert.equal(d.task.status, "complete");
  assert.ok(d.resultSizeBytes !== null, "resultSizeBytes must be present for old task with result");
});

test("FG-323 sc7: old task failureKind is null (complete, not failed)", () => {
  const d = taskDetail("old-task");
  assert.ok(d);
  assert.equal(d.failureKind, null);
});

// ─── HTTP endpoint integration (taskDetail via real HTTP) ────────────────────

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

test("FG-323 HTTP: agent-compressed task response includes compressionEvent with agentCompressed=true", async () => {
  const { status, body } = await get(`${BASE}/api/task/agent-task`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  assert.ok(d["compressionEvent"] !== null, "compressionEvent must be in response");
  const ev = d["compressionEvent"] as Record<string, unknown>;
  assert.equal(ev["agentCompressed"], true);
  assert.equal(ev["method"], "SmartCrusher");
  assert.equal(ev["ccrId"], "ccr-agent-001");
});

test("FG-323 HTTP: orchestrator-compressed task response includes compressionEvent with orchestratorCompressed=true", async () => {
  const { status, body } = await get(`${BASE}/api/task/orch-task`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  const ev = d["compressionEvent"] as Record<string, unknown>;
  assert.equal(ev["agentCompressed"], false);
  assert.equal(ev["orchestratorCompressed"], true);
  assert.equal(ev["method"], "OrchestratorCompressor");
});

test("FG-323 HTTP: below-threshold task response has compressionEvent=null and resultSizeBytes set", async () => {
  const { status, body } = await get(`${BASE}/api/task/below-threshold`);
  assert.equal(status, 200);
  const d = body as Record<string, unknown>;
  assert.equal(d["compressionEvent"], null);
  assert.ok(typeof d["resultSizeBytes"] === "number");
  assert.ok((d["resultSizeBytes"] as number) < 20480);
});

test("FG-323 HTTP: old task (no events) returns compressionEvent=null without 500 error", async () => {
  const { status, body } = await get(`${BASE}/api/task/old-task`);
  assert.equal(status, 200, "old task must not return 500");
  const d = body as Record<string, unknown>;
  assert.equal(d["compressionEvent"], null);
  const evs = d["events"] as unknown[];
  assert.ok(Array.isArray(evs) && evs.length === 0, "events array must be empty for old task");
});

test("FG-323 HTTP: 404 for unknown task id", async () => {
  const { status } = await get(`${BASE}/api/task/does-not-exist`);
  assert.equal(status, 404);
});
