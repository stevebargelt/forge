// Integration tests for the compression API endpoints (FG-321).
// Starts a minimal HTTP server wired to the real query functions against a
// temp SQLite DB. Makes live HTTP requests to exercise the four routes
// end-to-end: query logic, JSON serialisation, filter parameter parsing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http from "node:http";

// ─── Temp DB setup ────────────────────────────────────────────────────────────

const tmpHome = mkdtempSync(join(tmpdir(), "forge-srv-comp-"));
// Set FORGE_HOME before any queries.ts import so the singleton DB path resolves.
process.env.FORGE_HOME = tmpHome;

const dbPath = join(tmpHome, "forge.db");
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    -- project /alpha: 3 compression events across 2 roles and 2 days
    INSERT INTO runs VALUES ('r1','Run-1','feature','/alpha','complete', datetime('now','-5 days'));
    INSERT INTO tasks VALUES ('t1','r1','engineer','engineer','complete',NULL,NULL,NULL);
    INSERT INTO tasks VALUES ('t2','r1','tech-lead','tech-lead','complete',NULL,NULL,NULL);

    INSERT INTO events VALUES (NULL,'r1','t1','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":[],"original_size_bytes":100000,"compressed_size_bytes":40000,"compression_ratio":0.4,"method":"headroom"}',
      datetime('now','-5 days'));
    INSERT INTO events VALUES (NULL,'r1','t1','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,"fields_compressed":["diff_summary"],"original_size_bytes":60000,"compressed_size_bytes":30000,"compression_ratio":0.5,"method":"truncate"}',
      datetime('now','-2 days'));
    INSERT INTO events VALUES (NULL,'r1','t2','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":[],"original_size_bytes":20000,"compressed_size_bytes":8000,"compression_ratio":0.4,"method":"headroom"}',
      datetime('now','-2 days'));

    -- project /beta: 1 event without size fields (older format)
    INSERT INTO runs VALUES ('r2','Run-2','feature','/beta','complete', datetime('now','-3 days'));
    INSERT INTO tasks VALUES ('t3','r2','orchestrator','orchestrator','complete',NULL,NULL,NULL);
    INSERT INTO events VALUES (NULL,'r2','t3','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":false,"fields_compressed":[]}',
      datetime('now','-3 days'));

    -- non-compression event that must be excluded
    INSERT INTO events VALUES (NULL,'r1','t1','task.completed',NULL, datetime('now','-5 days'));
  `);
  db.close();
}

// ─── Query functions + server harness ────────────────────────────────────────

const {
  compressionSummary,
  compressionTimeSeries,
  compressionByRole,
  compressionMethods,
} = await import("./queries.js");

let BASE = "";
let testServer: ReturnType<typeof createServer>;

before(async () => {
  testServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const path = u.pathname;
      const since = u.searchParams.get("since") ?? "30d";
      const projectDir = u.searchParams.get("projectDir") ?? undefined;
      const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

      if (path === "/api/compression/summary") {
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(compressionSummary(since, projectDir)));
        return;
      }
      if (path === "/api/compression/timeseries") {
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(compressionTimeSeries(since, projectDir)));
        return;
      }
      if (path === "/api/compression/by-role") {
        const limit = clamp(Number(u.searchParams.get("limit") ?? 50), 1, 200);
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(compressionByRole(since, projectDir, limit)));
        return;
      }
      if (path === "/api/compression/methods") {
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(compressionMethods(since, projectDir)));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: msg }));
    }
  });
  await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", () => resolve()));
  testServer.unref();
  const addr = testServer.address() as { port: number };
  BASE = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  testServer?.close();
});

function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk: string) => { raw += chunk; });
      res.on("end", () => {
        res.socket?.unref();
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on("error", reject);
  });
}

// ─── /api/compression/summary ────────────────────────────────────────────────

test("GET /api/compression/summary returns valid JSON with correct totals", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/summary`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.ok(typeof s["totalEvents"] === "number", "totalEvents must be a number");
  assert.equal(s["totalEvents"], 4);            // 3 from /alpha + 1 from /beta
  assert.ok(typeof s["agentCompressed"] === "number");
  assert.equal(s["agentCompressed"], 2);        // t1 event-1 + t2 event
  assert.ok(typeof s["orchestratorCompressed"] === "number");
  assert.equal(s["orchestratorCompressed"], 1); // t1 event-2
  assert.ok(typeof s["totalOriginalBytes"] === "number");
  assert.equal(s["totalOriginalBytes"], 180000); // 100k+60k+20k+0
  assert.ok(typeof s["totalCompressedBytes"] === "number");
  assert.equal(s["totalCompressedBytes"], 78000); // 40k+30k+8k+0
  assert.ok(typeof s["bytesSaved"] === "number");
  assert.equal(s["bytesSaved"], 102000);
  assert.ok(typeof s["avgCompressionRatio"] === "number");
  // (0.4 + 0.5 + 0.4) / 3 = 0.4333...
  assert.ok(Math.abs(s["avgCompressionRatio"] - (0.4 + 0.5 + 0.4) / 3) < 0.001);
});

test("GET /api/compression/summary with no events returns zero struct", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/summary?projectDir=/nonexistent`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 0);
  assert.equal(s["agentCompressed"], 0);
  assert.equal(s["orchestratorCompressed"], 0);
  assert.equal(s["totalOriginalBytes"], 0);
  assert.equal(s["totalCompressedBytes"], 0);
  assert.equal(s["bytesSaved"], 0);
  assert.equal(s["avgCompressionRatio"], 0);
});

test("GET /api/compression/summary ?projectDir scopes to one project", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/summary?projectDir=/alpha`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 3);
  assert.equal(s["agentCompressed"], 2);
  assert.equal(s["orchestratorCompressed"], 1);
});

test("GET /api/compression/summary ?since=4d excludes events older than 4 days", async () => {
  // since=4d: cutoff = now - 4 days. The -5d event is excluded; -3d and -2d included.
  const { status, body } = await httpGet(`${BASE}/api/compression/summary?since=4d`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 3); // -2d (2 events) + -3d (1 event); -5d excluded
});

test("GET /api/compression/summary ?since=30d includes all seeded events", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/summary?since=30d`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 4);
});

test("GET /api/compression/summary ?since=ISO date filter works", async () => {
  // Use a date 4 days ago: -5d event excluded, -2d and -3d included.
  const cutoff = new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10);
  const { status, body } = await httpGet(`${BASE}/api/compression/summary?since=${encodeURIComponent(cutoff)}`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 3);
});

// ─── /api/compression/timeseries ─────────────────────────────────────────────

test("GET /api/compression/timeseries returns array with date/events fields", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/timeseries`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), "body must be an array");
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 1, "expected at least one timeseries row");
  for (const row of rows) {
    assert.match(String(row["date"]), /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
    assert.ok(typeof row["events"] === "number");
    assert.ok(typeof row["agentCompressed"] === "number");
    assert.ok(typeof row["orchestratorCompressed"] === "number");
    assert.ok(typeof row["bytesSaved"] === "number");
  }
});

test("GET /api/compression/timeseries rows are ordered ascending by date", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/timeseries`);
  assert.equal(status, 200);
  const rows = body as Array<{ date: string }>;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.date >= rows[i - 1]!.date, "timeseries must be ASC by date");
  }
});

test("GET /api/compression/timeseries groups by day correctly", async () => {
  // Total events spread across 3 days: -5d(1), -3d(1), -2d(2).
  const { status, body } = await httpGet(`${BASE}/api/compression/timeseries`);
  assert.equal(status, 200);
  const rows = body as Array<{ events: number }>;
  const total = rows.reduce((s, r) => s + r.events, 0);
  assert.equal(total, 4); // all 4 events distributed across days
});

test("GET /api/compression/timeseries returns empty array when no events", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/timeseries?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("GET /api/compression/timeseries ?projectDir scopes to one project", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/timeseries?projectDir=/beta`);
  assert.equal(status, 200);
  const rows = body as Array<{ events: number }>;
  const total = rows.reduce((s, r) => s + r.events, 0);
  assert.equal(total, 1);
});

// ─── /api/compression/by-role ────────────────────────────────────────────────

test("GET /api/compression/by-role returns rows with agentRole and numeric counts", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/by-role`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), "body must be an array");
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 1, "expected at least one role row");
  for (const row of rows) {
    assert.ok(typeof row["agentRole"] === "string");
    assert.ok(typeof row["events"] === "number");
    assert.ok(typeof row["agentCompressed"] === "number");
    assert.ok(typeof row["orchestratorCompressed"] === "number");
    assert.ok(typeof row["bytesSaved"] === "number");
    assert.ok(typeof row["avgCompressionRatio"] === "number");
  }
});

test("GET /api/compression/by-role rows sorted by events DESC", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/by-role`);
  assert.equal(status, 200);
  const rows = body as Array<{ events: number }>;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.events <= rows[i - 1]!.events, "rows must be DESC by event count");
  }
});

test("GET /api/compression/by-role matches expected agent_role values", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/by-role`);
  assert.equal(status, 200);
  const rows = body as Array<{ agentRole: string; events: number }>;
  const roles = rows.map((r) => r.agentRole);
  assert.ok(roles.includes("engineer"), "engineer role expected");
  assert.ok(roles.includes("tech-lead"), "tech-lead role expected");
  assert.ok(roles.includes("orchestrator"), "orchestrator role expected");
  // engineer: 2 events from /alpha/t1
  const eng = rows.find((r) => r.agentRole === "engineer");
  assert.ok(eng, "engineer row must be present");
  assert.equal(eng.events, 2);
});

test("GET /api/compression/by-role returns empty array when no events", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/by-role?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("GET /api/compression/by-role ?projectDir filter scopes results", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/by-role?projectDir=/alpha`);
  assert.equal(status, 200);
  const rows = body as Array<{ agentRole: string; events: number }>;
  const total = rows.reduce((s, r) => s + r.events, 0);
  assert.equal(total, 3); // 3 events in /alpha
  const roles = rows.map((r) => r.agentRole);
  assert.ok(!roles.includes("orchestrator"), "orchestrator from /beta must not appear");
});

// ─── /api/compression/methods ────────────────────────────────────────────────

test("GET /api/compression/methods returns array with method/count fields", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/methods`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), "body must be an array");
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 1, "expected at least one method row");
  for (const row of rows) {
    assert.ok(typeof row["method"] === "string");
    assert.ok(typeof row["count"] === "number");
  }
});

test("GET /api/compression/methods sorted by count DESC", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/methods`);
  assert.equal(status, 200);
  const rows = body as Array<{ count: number }>;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.count <= rows[i - 1]!.count, "must be DESC by count");
  }
});

test("GET /api/compression/methods headroom count=2, truncate count=1 for /alpha", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/methods?projectDir=/alpha`);
  assert.equal(status, 200);
  const rows = body as Array<{ method: string; count: number }>;
  const headroom = rows.find((r) => r.method === "headroom");
  assert.ok(headroom, "headroom method expected");
  assert.equal(headroom.count, 2); // t1 event-1 and t2 both use headroom
  const truncate = rows.find((r) => r.method === "truncate");
  assert.ok(truncate, "truncate method expected");
  assert.equal(truncate.count, 1); // t1 event-2 uses truncate
});

test("GET /api/compression/methods events without method field bucketed as (unknown)", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/methods?projectDir=/beta`);
  assert.equal(status, 200);
  const rows = body as Array<{ method: string; count: number }>;
  const unknown = rows.find((r) => r.method === "(unknown)");
  assert.ok(unknown, "events with no method field must be bucketed as (unknown)");
  assert.equal(unknown.count, 1);
});

test("GET /api/compression/methods returns empty array when no events", async () => {
  const { status, body } = await httpGet(`${BASE}/api/compression/methods?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("GET /api/compression/methods ?since=4d excludes events older than 4 days", async () => {
  // since=4d: -5d event excluded; -2d (2 events) + -3d (1 event) included = 3 total
  const { status, body } = await httpGet(`${BASE}/api/compression/methods?since=4d`);
  assert.equal(status, 200);
  const rows = body as Array<{ method: string; count: number }>;
  const total = rows.reduce((s, r) => s + r.count, 0);
  assert.equal(total, 3); // -5d event excluded
});

// ─── Cross-cutting: events → tasks → runs join ────────────────────────────────

test("projectDir filter uses events→tasks→runs join correctly", async () => {
  // If the join were broken (e.g. using event.run_id directly without going
  // through tasks), filtering by projectDir might include wrong events.
  // This verifies that alpha + beta = all, proving each is genuinely scoped.
  const alpha = (await httpGet(`${BASE}/api/compression/summary?projectDir=/alpha`)).body as Record<string, number>;
  const beta = (await httpGet(`${BASE}/api/compression/summary?projectDir=/beta`)).body as Record<string, number>;
  const all = (await httpGet(`${BASE}/api/compression/summary`)).body as Record<string, number>;
  assert.equal(
    alpha["totalEvents"]! + beta["totalEvents"]!,
    all["totalEvents"]!,
    "alpha + beta events must sum to total (join scoping must be correct)"
  );
  assert.equal(
    alpha["totalOriginalBytes"]! + beta["totalOriginalBytes"]!,
    all["totalOriginalBytes"]!,
    "alpha + beta bytes must sum to total"
  );
});
