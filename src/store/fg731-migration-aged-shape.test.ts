// FG-731 — the AGED host DB that has NEVER seen ci_waits, and why a fresh DB cannot
// prove this alone.
//
// ci_waits is a BRAND-NEW table. For a new table (unlike a new COLUMN on an existing
// table) the `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL IS the additive migration: db.ts
// exec's SCHEMA_SQL on EVERY writable open, so an aged ~/.forge/forge.db that predates the
// table gains it on the next open — no ADDITIVE_COLUMNS entry is needed or correct (that
// list exists only for columns a CREATE TABLE IF NOT EXISTS would no-op over). This file
// proves that end-to-end against a hand-authored store with NO ci_waits table, then opens
// it exactly as a real open does and exercises the store on the brought-forward table.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import { getCiWait, observeCiWait, registerCiWait } from "./ci-waits.js";

// A minimal aged store: real forge tables, but deliberately NO ci_waits.
const AGED_SCHEMA_SQL = `
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  project_dir TEXT
);
CREATE TABLE launch_observations (
  launch_id        TEXT PRIMARY KEY,
  name             TEXT,
  command          TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  project_dir      TEXT,
  association_kind TEXT NOT NULL,
  run_id           TEXT,
  task_id          TEXT,
  ticket_id        TEXT,
  campaign_id      TEXT,
  item_id          TEXT,
  started_at       TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  state            TEXT NOT NULL,
  exit_code        INTEGER,
  signal           TEXT,
  terminal         INTEGER NOT NULL
);
`;

function agedThenMigrated(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-aged', 'feature', 'aged', 'active', ?, ?)`)
    .run("2026-08-01T09:00:00.000Z", "/repos/forge");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function withAgedDb<T>(fn: (db: DatabaseInstance) => T): T {
  const db = agedThenMigrated();
  const prev = setDbForTest(db);
  try {
    return fn(db);
  } finally {
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
}

describe("FG-731 — an aged store gains ci_waits on the ordinary open path", () => {
  test("the fixture is genuinely aged: pre-open it has NO ci_waits table", () => {
    const raw = new Database(":memory:");
    raw.exec(AGED_SCHEMA_SQL);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((t) => t.name);
    assert.equal(tables.includes("ci_waits"), false, "the aged shape must not already carry the table");
    raw.close();
  });

  test("SCHEMA_SQL on open creates ci_waits with its full frozen column shape", () => {
    withAgedDb((db) => {
      const cols = (db.prepare(`PRAGMA table_info(ci_waits)`).all() as Array<{ name: string; notnull: number }>);
      const names = cols.map((c) => c.name).sort();
      assert.deepEqual(names, [
        "actions_run_id", "check_suite_ref", "dispatch_inputs", "dispatch_ref", "head_sha",
        "id", "kind", "lease_expires_at_ms", "lifecycle_state", "observed_at", "observed_m",
        "observed_n", "observed_reason", "observed_state", "owner", "pr_number", "project_dir",
        "project_dir_canonical", "repo", "run_id", "started_at", "terminal",
        "terminal_disposition", "ticket_id", "url", "workflow_file",
      ]);
    });
  });

  test("opening the aged store does not bump user_version — an older binary must still open it", () => {
    withAgedDb((db) => {
      assert.equal(db.pragma("user_version", { simple: true }), 0);
    });
  });

  test("re-running the open path on the brought-forward store is a no-op", () => {
    withAgedDb((db) => {
      const shape = (): string => JSON.stringify(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all());
      const before = shape();
      db.exec(SCHEMA_SQL);
      applyMigrations(db);
      assert.equal(shape(), before);
    });
  });

  test("the store serves register/observe against the brought-forward table", () => {
    withAgedDb(() => {
      registerCiWait({
        id: "ciwait-aged",
        kind: "pr_checks",
        remote: { repo: "acme/forge", prNumber: 270, headSha: "deadbeef", checkSuiteRef: "cs-1" },
        startedAt: "2026-08-18T10:00:00.000Z",
        association: { runId: "run-aged", ticketId: "FG-731", projectDir: "/repos/forge" },
      });
      observeCiWait("ciwait-aged", { state: "running", m: 1, n: 6 }, "2026-08-18T10:01:00.000Z");
      const wait = getCiWait("ciwait-aged")!;
      assert.equal(wait.lifecycleState, "running");
      assert.equal(wait.prNumber, 270);
      assert.equal(wait.observedN, 6);
    });
  });
});
