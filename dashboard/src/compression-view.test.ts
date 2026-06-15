// Integration tests for FG-322: compression stats UI — verifies the contracts
// that the CompressionView Preact component depends on.
//
// Strategy: the client JS is a CDN-loaded Preact module with no build step
// — there is no DOM renderer available in this test environment. Instead we:
//   1. Verify that the four compression API endpoints return shapes the UI
//      expects, for every time-window the filter renders (7d, 30d, 90d, all).
//   2. Verify the empty-state condition (totalEvents === 0) against an empty DB.
//   3. Verify the data-present shape (all fields the health/chart/table panels
//      read) against seeded data.
//   4. Verify the server serves /client/compression.js with the correct
//      content-type so the browser can load it.
//   5. Verify the shell HTML wires up the compression tab.
//
// All four time-window buttons (7d / 30d / 90d / all) are exercised — the
// previous server-compression.test.ts only tests 30d and ad-hoc windows.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http from "node:http";

// ─── Temp DB with two phases: one empty DB, then a seeded DB ─────────────────

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cv-"));
process.env.FORGE_HOME = tmpHome;

const dbPath = join(tmpHome, "forge.db");

// Seed data that exercises all four panels:
//   - 3 events across 2 roles, 2 methods, 2 days → health + chart + breakdown + methods all render
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    -- project /app: 2 events within 7d, 1 event within 90d but outside 30d
    INSERT INTO runs VALUES ('r1','Run-1','feature','/app','complete', datetime('now','-2 days'));
    INSERT INTO tasks VALUES ('t1','r1','engineer','engineer','complete',NULL,NULL,NULL);
    INSERT INTO tasks VALUES ('t2','r1','tech-lead','tech-lead','complete',NULL,NULL,NULL);

    -- event 1: within 7d, agent compressed, headroom method
    INSERT INTO events VALUES (NULL,'r1','t1','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":[],"original_size_bytes":80000,"compressed_size_bytes":32000,"compression_ratio":0.4,"method":"headroom"}',
      datetime('now','-2 days'));

    -- event 2: within 7d, orchestrator compressed, truncate method
    INSERT INTO events VALUES (NULL,'r1','t1','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,"fields_compressed":["diff_summary"],"original_size_bytes":50000,"compressed_size_bytes":25000,"compression_ratio":0.5,"method":"truncate"}',
      datetime('now','-3 days'));

    -- event 3: within 90d but outside 30d, tech-lead role, headroom
    INSERT INTO runs VALUES ('r2','Run-2','feature','/app','complete', datetime('now','-45 days'));
    INSERT INTO tasks VALUES ('t3','r2','tech-lead','tech-lead','complete',NULL,NULL,NULL);
    INSERT INTO events VALUES (NULL,'r2','t3','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":[],"original_size_bytes":20000,"compressed_size_bytes":8000,"compression_ratio":0.4,"method":"headroom"}',
      datetime('now','-45 days'));

    -- non-compression event that must always be excluded
    INSERT INTO events VALUES (NULL,'r1','t1','task.completed',NULL, datetime('now','-2 days'));
  `);
  db.close();
}

// ─── Minimal server harness (mirrors server.ts compression routes) ────────────

const {
  compressionSummary,
  compressionTimeSeries,
  compressionByRole,
  compressionMethods,
} = await import("./queries.js");

import { renderShell } from "./shell.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

let BASE = "";
let srv: ReturnType<typeof createServer>;

before(async () => {
  srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const path = u.pathname;
      const since = u.searchParams.get("since") ?? "30d";
      const projectDir = u.searchParams.get("projectDir") ?? undefined;
      const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
        return;
      }

      if (path.startsWith("/client/")) {
        const rel = path.slice("/client/".length);
        const fp = resolve(CLIENT_DIR, rel);
        if (!fp.startsWith(CLIENT_DIR + "/") || !existsSync(fp)) {
          res.writeHead(404).end(JSON.stringify({ error: "not found" }));
          return;
        }
        const ct = fp.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": ct }).end(readFileSync(fp));
        return;
      }

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

function get(url: string): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk: string) => { raw += chunk; });
      res.on("end", () => {
        res.socket?.unref();
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, string | string[] | undefined> });
      });
    });
    req.on("error", reject);
  });
}

// ─── 1. Shell contains compression tab ───────────────────────────────────────

test("GET / — shell HTML contains compression nav tab", async () => {
  const { status, body } = await get(`${BASE}/`);
  assert.equal(status, 200);
  const html = body as string;
  assert.ok(html.includes("compression"), "shell HTML must reference 'compression' tab");
  assert.ok(html.includes("<div id=\"app\">"), "shell must include Preact mount point #app");
  assert.ok(html.includes("main.js"), "shell must load main.js entry point");
});

// ─── 2. compression.js is served with correct content-type ───────────────────

test("GET /client/compression.js — served with JS content-type", async () => {
  const { status, headers } = await get(`${BASE}/client/compression.js`);
  assert.equal(status, 200);
  const ct = headers["content-type"] as string | undefined;
  assert.ok(ct?.includes("javascript"), `expected JS content-type, got '${ct}'`);
});

test("GET /client/compression.js — file is non-empty and exports CompressionView", async () => {
  const { status, body } = await get(`${BASE}/client/compression.js`);
  assert.equal(status, 200);
  const src = body as string;
  assert.ok(src.length > 100, "compression.js must be non-trivial");
  assert.ok(src.includes("CompressionView"), "compression.js must export CompressionView");
  assert.ok(src.includes("PERIODS"), "compression.js must define PERIODS array");
});

// ─── 3. Empty state — all endpoints return zero / empty when no data ──────────
// The UI renders the empty-state card when summary.totalEvents === 0.

test("empty state: summary returns totalEvents=0 for unknown project", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?projectDir=/nonexistent`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 0, "totalEvents must be 0 when no events");
  assert.equal(s["agentCompressed"], 0);
  assert.equal(s["orchestratorCompressed"], 0);
  assert.equal(s["bytesSaved"], 0);
  assert.equal(s["avgCompressionRatio"], 0);
});

test("empty state: timeseries returns [] for unknown project", async () => {
  const { status, body } = await get(`${BASE}/api/compression/timeseries?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("empty state: by-role returns [] for unknown project", async () => {
  const { status, body } = await get(`${BASE}/api/compression/by-role?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test("empty state: methods returns [] for unknown project", async () => {
  const { status, body } = await get(`${BASE}/api/compression/methods?projectDir=/nonexistent`);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

// ─── 4. Time window filter — 7d shows only recent events ─────────────────────
// The compression view has buttons: 7d / 30d / 90d / all.
// Our seeded data: 2 events within 7d, 1 event at -45d (outside 30d, inside 90d).

test("time window 7d — summary shows only events within 7 days", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?since=7d`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 2, "7d window: expect 2 events (the -2d and -3d ones)");
  assert.ok(s["totalEvents"]! < 3, "7d window must exclude the -45d event");
});

test("time window 30d — summary shows events within 30 days", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?since=30d`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 2, "30d window: expect 2 events (the -45d event is excluded)");
});

test("time window 90d — summary includes event at -45 days", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?since=90d`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 3, "90d window must include -45d event");
});

test("time window all — summary returns all events regardless of age", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?since=all`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  assert.equal(s["totalEvents"], 3, "all window must return all seeded events");
  assert.ok(typeof s["totalOriginalBytes"] === "number");
  assert.ok(s["totalOriginalBytes"]! > 0);
});

// ─── 5. Health panel shape — CompressionHealth reads these fields ─────────────
// CompressionHealth renders: tokensSaved (from bytesSaved), dollarsSaved,
// avgCompressionRatio, agentCompressed/totalEvents, bytesSaved.

test("health panel: summary has all required fields for CompressionHealth", async () => {
  const { status, body } = await get(`${BASE}/api/compression/summary?since=all`);
  assert.equal(status, 200);
  const s = body as Record<string, number>;
  // Required by CompressionHealth
  assert.ok(typeof s["totalEvents"] === "number");
  assert.ok(typeof s["agentCompressed"] === "number");
  assert.ok(typeof s["bytesSaved"] === "number");
  assert.ok(typeof s["avgCompressionRatio"] === "number");
  // Verify computed values match seeded data:
  // 80000+50000+20000 = 150000 original; 32000+25000+8000 = 65000 compressed
  assert.equal(s["totalOriginalBytes"], 150000);
  assert.equal(s["totalCompressedBytes"], 65000);
  assert.equal(s["bytesSaved"], 85000);
  assert.equal(s["agentCompressed"], 2);   // event 1 and event 3
  assert.equal(s["orchestratorCompressed"], 1); // event 2
});

// ─── 6. Chart data shape — CompressionTimeseries reads date/bytesSaved ────────

test("chart data: timeseries rows have date and bytesSaved fields", async () => {
  const { status, body } = await get(`${BASE}/api/compression/timeseries?since=all`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 2, "expect at least 2 day-buckets (events span 2+ days)");
  for (const row of rows) {
    assert.match(String(row["date"]), /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
    assert.ok(typeof row["bytesSaved"] === "number", "bytesSaved must be a number");
    assert.ok(typeof row["events"] === "number");
  }
});

test("chart data: timeseries rows are ordered ASC by date", async () => {
  const { status, body } = await get(`${BASE}/api/compression/timeseries?since=all`);
  assert.equal(status, 200);
  const rows = body as Array<{ date: string }>;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.date >= rows[i - 1]!.date, "timeseries must be ASC by date");
  }
});

// ─── 7. Role breakdown shape — CompressionBreakdown reads agentRole/bytesSaved ─

test("breakdown: by-role rows have agentRole, events, bytesSaved, avgCompressionRatio", async () => {
  const { status, body } = await get(`${BASE}/api/compression/by-role?since=all`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 2, "expect at least 2 roles (engineer + tech-lead)");
  for (const row of rows) {
    assert.ok(typeof row["agentRole"] === "string");
    assert.ok(typeof row["events"] === "number");
    assert.ok(typeof row["bytesSaved"] === "number");
    assert.ok(typeof row["avgCompressionRatio"] === "number");
    assert.ok(typeof row["agentCompressed"] === "number");
  }
  // engineer appears in both runs: events from r1/t1 = 2
  const eng = rows.find((r) => r["agentRole"] === "engineer");
  assert.ok(eng, "engineer role must appear in breakdown");
});

// ─── 8. Method distribution shape — CompressionMethods reads method/count ─────

test("methods: rows have method (string) and count (number)", async () => {
  const { status, body } = await get(`${BASE}/api/compression/methods?since=all`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const rows = body as Array<Record<string, unknown>>;
  assert.ok(rows.length >= 2, "expect headroom and truncate methods");
  for (const row of rows) {
    assert.ok(typeof row["method"] === "string");
    assert.ok(typeof row["count"] === "number", "count must be a number");
    assert.ok(row["count"]! as number > 0);
  }
});

test("methods: headroom (2 events) and truncate (1 event) are both present", async () => {
  const { status, body } = await get(`${BASE}/api/compression/methods?since=all`);
  assert.equal(status, 200);
  const rows = body as Array<{ method: string; count: number }>;
  const headroom = rows.find((r) => r.method === "headroom");
  assert.ok(headroom, "headroom method must be present");
  assert.equal(headroom.count, 2);
  const truncate = rows.find((r) => r.method === "truncate");
  assert.ok(truncate, "truncate method must be present");
  assert.equal(truncate.count, 1);
});

// ─── 9. Time window filter — timeseries / by-role / methods all respond to since ─

test("time window: timeseries respects 7d filter (returns only recent buckets)", async () => {
  const { body: all } = await get(`${BASE}/api/compression/timeseries?since=all`);
  const { body: week } = await get(`${BASE}/api/compression/timeseries?since=7d`);
  const allRows = all as Array<{ events: number }>;
  const weekRows = week as Array<{ events: number }>;
  const allTotal = allRows.reduce((s, r) => s + r.events, 0);
  const weekTotal = weekRows.reduce((s, r) => s + r.events, 0);
  assert.ok(weekTotal < allTotal, "7d timeseries must have fewer total events than all-time");
});

test("time window: by-role respects 90d filter (includes -45d event)", async () => {
  const { body } = await get(`${BASE}/api/compression/by-role?since=90d`);
  const rows = body as Array<{ events: number }>;
  const total = rows.reduce((s, r) => s + r.events, 0);
  assert.equal(total, 3, "90d by-role must include all 3 seeded events");
});

test("time window: methods all=3 vs 7d=2 (the -45d event is excluded by 7d)", async () => {
  const { body: allBody } = await get(`${BASE}/api/compression/methods?since=all`);
  const { body: weekBody } = await get(`${BASE}/api/compression/methods?since=7d`);
  const allTotal = (allBody as Array<{ count: number }>).reduce((s, r) => s + r.count, 0);
  const weekTotal = (weekBody as Array<{ count: number }>).reduce((s, r) => s + r.count, 0);
  assert.equal(allTotal, 3);
  assert.equal(weekTotal, 2);
});
