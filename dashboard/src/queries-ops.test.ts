// Tests for opsMetrics (RUN-3). Mirrors the harness in queries-usage.test.ts:
// seed a temp forge.db, then exercise the read-only query.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qops-"));
process.env.FORGE_HOME = tmpHome;

const { opsMetrics } = await import("./queries.js");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    -- run A: clean (1 complete task, 10s + 30s engineer durations)
    INSERT INTO runs VALUES ('rA','A','feature','/proj/a','complete', datetime('now','-1 day'));
    INSERT INTO tasks VALUES ('a1','rA','engineer','engineer','complete',NULL,'2026-05-20T00:00:00Z','2026-05-20T00:00:10Z');
    INSERT INTO tasks VALUES ('a2','rA','engineer','engineer','complete',NULL,'2026-05-20T00:00:00Z','2026-05-20T00:00:30Z');

    -- run B: a failed top-level task (idle_timeout), a retry + red-block event
    INSERT INTO runs VALUES ('rB','B','feature','/proj/b','complete', datetime('now','-2 days'));
    INSERT INTO tasks VALUES ('b1','rB','engineer','engineer','failed',NULL,NULL,NULL);
    INSERT INTO events VALUES (NULL,'rB','b1','task.failed','{"failure_kind":"idle_timeout"}', datetime('now','-2 days'));
    INSERT INTO events VALUES (NULL,'rB','b1','task.retried',NULL, datetime('now','-2 days'));
    INSERT INTO events VALUES (NULL,'rB','b1','task.blocked_by_red',NULL, datetime('now','-2 days'));

    -- a failed CHILD task must NOT count toward run failures or failure kinds
    INSERT INTO tasks VALUES ('b2','rB','red','red-wide','failed','b1',NULL,NULL);

    -- run C: ACTIVE (in-flight). Must NOT count as a clean success.
    INSERT INTO runs VALUES ('rC','C','feature','/proj/c','active', datetime('now','-1 hour'));
    INSERT INTO tasks VALUES ('c1','rC','engineer','engineer','running',NULL,NULL,NULL);

    -- run D: FAILED (FG-585). A terminal, unsuccessful run — must count as
    -- terminal + withFailures, never as active or clean.
    INSERT INTO runs VALUES ('rD','D','feature','/proj/d','failed', datetime('now','-3 hours'));
    INSERT INTO tasks VALUES ('d1','rD','engineer','engineer','failed',NULL,NULL,NULL);
  `);
  db.close();
}

test("opsMetrics: success rate is terminal-only; active run excluded from clean/denominator", () => {
  const m = opsMetrics("30d");
  assert.equal(m.runs.total, 4);          // A + B + active C + failed D
  assert.equal(m.runs.active, 1);         // C is in-flight — a failed run is NOT active
  assert.equal(m.runs.terminal, 3);       // A + B + D (FG-585: failed is terminal)
  assert.equal(m.runs.clean, 1);          // run A only
  assert.equal(m.runs.withFailures, 2);   // run B + failed run D
  assert.equal(m.runs.successRate, 1 / 3); // 1 clean / 3 terminal
});

test("opsMetrics: FG-585 — a failed run is terminal-with-failures, never active or clean", () => {
  const m = opsMetrics("30d", "/proj/d");
  assert.equal(m.runs.total, 1);
  assert.equal(m.runs.active, 0, "a failed run must NOT be counted as active/in-flight");
  assert.equal(m.runs.terminal, 1, "a failed run is a terminal run");
  assert.equal(m.runs.clean, 0, "a failed run is never clean");
  assert.equal(m.runs.withFailures, 1);
  assert.equal(m.runs.successRate, 0);
});

test("opsMetrics: failure_kind from events; child failures excluded", () => {
  const m = opsMetrics("30d");
  assert.deepEqual(m.failureKinds, [{ kind: "idle_timeout", count: 1 }]);
  assert.equal(m.counts.idleKills, 1);
});

test("opsMetrics: operational counts from events", () => {
  const m = opsMetrics("30d");
  assert.equal(m.counts.retries, 1);
  assert.equal(m.counts.redBlocks, 1);
  assert.equal(m.counts.cancels, 0);
});

test("opsMetrics: median engineer duration = 20s (median of 10s, 30s)", () => {
  const m = opsMetrics("30d");
  const eng = m.durations.find((d) => d.dimension === "engineer")!;
  assert.equal(eng.count, 2);
  assert.equal(eng.medianMs, 20_000);
});

test("opsMetrics: project filter scopes to one run", () => {
  const m = opsMetrics("30d", "/proj/a");
  assert.equal(m.runs.total, 1);
  assert.equal(m.runs.clean, 1);
});

test("opsMetrics: canonical scope aggregates member checkout runs", () => {
  const m = opsMetrics("30d", ["/proj/a", "/proj/b"]);
  assert.equal(m.runs.total, 2);
  assert.equal(m.runs.clean, 1);
  assert.equal(m.runs.withFailures, 1);
});
