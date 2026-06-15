// Tests for compression query functions (FG-321).
// Mirrors the harness in queries-ops.test.ts: seed a temp forge.db, then
// exercise the read-only query functions.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qcomp-"));
process.env.FORGE_HOME = tmpHome;

const { compressionSummary, compressionTimeSeries, compressionByRole, compressionMethods } =
  await import("./queries.js");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    -- project A: two compression events, one agent-compressed, one orchestrator-compressed with size data
    INSERT INTO runs VALUES ('rA','A','feature','/proj/a','complete', datetime('now','-1 day'));
    INSERT INTO tasks VALUES ('a1','rA','engineer','engineer','complete',NULL,NULL,NULL);
    INSERT INTO tasks VALUES ('a2','rA','tech-lead','tech-lead','complete',NULL,NULL,NULL);

    INSERT INTO events VALUES (NULL,'rA','a1','compression.verification',
      '{"agent_compressed":true,"orchestrator_compressed":false,"fields_compressed":[],"original_size_bytes":50000,"compressed_size_bytes":20000,"compression_ratio":0.4,"method":"headroom"}',
      datetime('now','-1 day'));
    INSERT INTO events VALUES (NULL,'rA','a2','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":true,"fields_compressed":["diff_summary"],"original_size_bytes":30000,"compressed_size_bytes":15000,"compression_ratio":0.5,"method":"headroom"}',
      datetime('now','-1 day'));

    -- project B: one event without size data (older event format)
    INSERT INTO runs VALUES ('rB','B','feature','/proj/b','complete', datetime('now','-2 days'));
    INSERT INTO tasks VALUES ('b1','rB','engineer','engineer','complete',NULL,NULL,NULL);
    INSERT INTO events VALUES (NULL,'rB','b1','compression.verification',
      '{"agent_compressed":false,"orchestrator_compressed":false,"fields_compressed":[]}',
      datetime('now','-2 days'));

    -- a non-compression event that must be excluded
    INSERT INTO events VALUES (NULL,'rA','a1','task.completed',NULL, datetime('now','-1 day'));
  `);
  db.close();
}

// ─── compressionSummary ───────────────────────────────────────────────────────

test("compressionSummary: counts all events and agent/orchestrator breakdown", () => {
  const s = compressionSummary("30d");
  assert.equal(s.totalEvents, 3);
  assert.equal(s.agentCompressed, 1);
  assert.equal(s.orchestratorCompressed, 1);
});

test("compressionSummary: sums bytes from events that have size fields", () => {
  const s = compressionSummary("30d");
  assert.equal(s.totalOriginalBytes, 80000);   // 50000 + 30000
  assert.equal(s.totalCompressedBytes, 35000); // 20000 + 15000
  assert.equal(s.bytesSaved, 45000);
});

test("compressionSummary: avgCompressionRatio only from events with ratio field", () => {
  const s = compressionSummary("30d");
  // (0.4 + 0.5) / 2 = 0.45
  assert.ok(Math.abs(s.avgCompressionRatio - 0.45) < 0.0001);
});

test("compressionSummary: projectDir filter scopes to one project", () => {
  const s = compressionSummary("30d", "/proj/a");
  assert.equal(s.totalEvents, 2);
  assert.equal(s.agentCompressed, 1);
});

test("compressionSummary: returns zero counts when no events exist", () => {
  const s = compressionSummary("30d", "/proj/nonexistent");
  assert.equal(s.totalEvents, 0);
  assert.equal(s.agentCompressed, 0);
  assert.equal(s.orchestratorCompressed, 0);
  assert.equal(s.totalOriginalBytes, 0);
  assert.equal(s.totalCompressedBytes, 0);
  assert.equal(s.bytesSaved, 0);
  assert.equal(s.avgCompressionRatio, 0);
});

test("compressionSummary: since=7d parses Nd shorthand", () => {
  // All test data is within 30d; 7d covers 1-day-old events only.
  const s7 = compressionSummary("7d");
  const s30 = compressionSummary("30d");
  // 7d should include 1-day-old events; both /proj/a events qualify.
  assert.ok(s7.totalEvents <= s30.totalEvents);
  assert.ok(s7.totalEvents >= 2); // at least the 1-day-old events
});

// ─── compressionTimeSeries ────────────────────────────────────────────────────

test("compressionTimeSeries: returns one row per day, ordered ASC", () => {
  const rows = compressionTimeSeries("30d");
  assert.ok(rows.length >= 1, "expected at least one day");
  for (const r of rows) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
    assert.ok(typeof r.events === "number");
    assert.ok(typeof r.agentCompressed === "number");
    assert.ok(typeof r.orchestratorCompressed === "number");
    assert.ok(typeof r.bytesSaved === "number");
  }
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.date >= rows[i - 1]!.date, "rows must be ASC by date");
  }
});

test("compressionTimeSeries: returns empty array when no events", () => {
  const rows = compressionTimeSeries("30d", "/proj/nonexistent");
  assert.deepEqual(rows, []);
});

test("compressionTimeSeries: projectDir filter scopes results", () => {
  const rows = compressionTimeSeries("30d", "/proj/b");
  assert.ok(rows.length >= 1);
  const total = rows.reduce((sum, r) => sum + r.events, 0);
  assert.equal(total, 1);
});

// ─── compressionByRole ────────────────────────────────────────────────────────

test("compressionByRole: returns rows sorted by event count DESC", () => {
  const rows = compressionByRole("30d");
  assert.ok(rows.length >= 2, "expected at least 2 roles");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.events <= rows[i - 1]!.events, "must be DESC by events");
  }
});

test("compressionByRole: engineer has 2 events (proj/a + proj/b)", () => {
  const rows = compressionByRole("30d");
  const eng = rows.find((r) => r.agentRole === "engineer");
  assert.ok(eng, "expected engineer row");
  assert.equal(eng.events, 2);
});

test("compressionByRole: returns empty when no events", () => {
  const rows = compressionByRole("30d", "/proj/nonexistent");
  assert.deepEqual(rows, []);
});

test("compressionByRole: projectDir filter works", () => {
  const rows = compressionByRole("30d", "/proj/a");
  const total = rows.reduce((sum, r) => sum + r.events, 0);
  assert.equal(total, 2);
});

// ─── compressionMethods ───────────────────────────────────────────────────────

test("compressionMethods: returns method distribution sorted by count DESC", () => {
  const rows = compressionMethods("30d");
  assert.ok(rows.length >= 1, "expected at least one method");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.count <= rows[i - 1]!.count, "must be DESC by count");
  }
});

test("compressionMethods: headroom method appears for seeded events with method field", () => {
  const rows = compressionMethods("30d", "/proj/a");
  const headroom = rows.find((r) => r.method === "headroom");
  assert.ok(headroom, "expected headroom method");
  assert.equal(headroom.count, 2);
});

test("compressionMethods: events without method field count as (unknown)", () => {
  const rows = compressionMethods("30d", "/proj/b");
  const unknown = rows.find((r) => r.method === "(unknown)");
  assert.ok(unknown, "expected (unknown) bucket for events without method");
  assert.equal(unknown.count, 1);
});

test("compressionMethods: returns empty array when no events", () => {
  const rows = compressionMethods("30d", "/proj/nonexistent");
  assert.deepEqual(rows, []);
});
