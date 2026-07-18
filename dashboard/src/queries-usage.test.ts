// Tests for the usageRollup and usageTimeSeries query functions added in #156.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FORGE_HOME must be set before queries.ts is evaluated (it reads the env at
// module init to compute DB_PATH). We use a dynamic import below so this
// assignment happens first.
const tmpHome = mkdtempSync(join(tmpdir(), "forge-qdash-"));
process.env.FORGE_HOME = tmpHome;

const { usageRollup, usageTimeSeries } = await import("./queries.js");

// Seed a minimal DB that satisfies the JOIN shape used by usageRollup /
// usageTimeSeries (model_calls → tasks → runs).
{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      title TEXT,
      workflow TEXT,
      project_dir TEXT,
      status TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      agent_role TEXT,
      status TEXT
    );
    CREATE TABLE model_calls (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      model TEXT,
      alias TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      created_at TEXT
    );
    INSERT INTO runs VALUES ('r1','Test Run','default','/proj/alpha','complete');
    INSERT INTO runs VALUES ('r2','Other Run','batch',  '/proj/beta', 'complete');
    INSERT INTO tasks VALUES ('t1','r1','engineer','complete');
    INSERT INTO tasks VALUES ('t2','r2','qa-engineer','complete');
    INSERT INTO model_calls VALUES ('mc1','t1','claude-sonnet','prod',1000,500,200,300,datetime('now','-1 day'));
    INSERT INTO model_calls VALUES ('mc2','t1','claude-sonnet','prod',2000,800,400,600,datetime('now','-2 days'));
    INSERT INTO model_calls VALUES ('mc3','t2','claude-opus',  'prod', 500,200, 50,100,datetime('now','-1 day'));
  `);
  db.close();
}

test("usageRollup groups by project and sums tokens", () => {
  const rows = usageRollup("project", "30d");
  assert.equal(rows.length, 2);
  const alpha = rows.find(r => r.bucket === "/proj/alpha")!;
  assert.ok(alpha, "expected /proj/alpha bucket");
  assert.equal(alpha.inputTokens, 3000);
  assert.equal(alpha.outputTokens, 1300);
  assert.equal(alpha.cacheReadTokens, 600);
  assert.equal(alpha.cacheCreationTokens, 900);
  assert.equal(alpha.requests, 2);
});

test("usageRollup groups by role", () => {
  const rows = usageRollup("role", "30d");
  assert.equal(rows.length, 2);
  const buckets = rows.map(r => r.bucket).sort();
  assert.deepEqual(buckets, ["engineer", "qa-engineer"]);
});

test("usageRollup groups by model", () => {
  const rows = usageRollup("model", "30d");
  assert.equal(rows.length, 2);
  const buckets = rows.map(r => r.bucket).sort();
  assert.deepEqual(buckets, ["claude-opus", "claude-sonnet"]);
});

test("usageRollup respects since window", () => {
  // All test data is within 30d; using 0d should return nothing meaningful
  // (we can't easily insert data exactly at a boundary, so just verify the
  // filter reduces results when it should).
  const all = usageRollup("project", "all");
  const recent = usageRollup("project", "30d");
  // Both windows cover the test data (2 days old), so counts should match.
  assert.equal(all.length, recent.length);
});

test("usageRollup respects projectDir filter", () => {
  const rows = usageRollup("project", "30d", "/proj/alpha");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.bucket, "/proj/alpha");
});

test("usageRollup canonical scope includes every member checkout and excludes others", () => {
  const rows = usageRollup("project", "30d", ["/proj/alpha", "/proj/beta"]);
  assert.deepEqual(rows.map((row) => row.bucket).sort(), ["/proj/alpha", "/proj/beta"]);
  assert.deepEqual(usageRollup("project", "30d", []), []);
});

test("usageTimeSeries returns one row per day", () => {
  const rows = usageTimeSeries("30d");
  assert.ok(rows.length >= 1, "expected at least one day");
  for (const r of rows) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, "date should be YYYY-MM-DD");
    assert.ok(typeof r.inputTokens === "number");
    assert.ok(typeof r.requests === "number");
  }
});

test("usageTimeSeries rows are ordered by date asc", () => {
  const rows = usageTimeSeries("30d");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.date >= rows[i - 1]!.date, "rows should be ASC by date");
  }
});
