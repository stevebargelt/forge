// FG-710 — an AGED host DB that predates BOTH the fix_batch_refused_deliveries table and the
// fix_batch_results.executed_assertion column. A fresh-created test DB hides a missing migration
// (it is built from SCHEMA_SQL, which already has both), so this proves the brought-forward path
// against a hand-authored store that deliberately has neither.
//
// Two migration kinds are exercised together:
//   - a BRAND-NEW table (fix_batch_refused_deliveries): the CREATE TABLE IF NOT EXISTS in
//     SCHEMA_SQL IS the additive migration — db.ts exec's SCHEMA_SQL on every writable open.
//   - a NEW COLUMN on an existing table (fix_batch_results.executed_assertion): CREATE TABLE IF
//     NOT EXISTS no-ops over an existing table, so the ALTER in ADDITIVE_COLUMNS is what adds it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import {
  captureRefusedFixDelivery,
  claimRefusedFixDeliveryRepair,
  refusedFixDelivery,
  supersedeRefusedFixDelivery,
} from "./fix-batches.js";

// A minimal aged store: fix_batches at its full frozen shape, fix_batch_results WITHOUT
// executed_assertion, and NO fix_batch_refused_deliveries at all. Everything else (reviews,
// events, …) is created whole by SCHEMA_SQL on open.
const AGED_SCHEMA_SQL = `
CREATE TABLE fix_batches (
  id                  TEXT PRIMARY KEY,
  review_id           TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  candidate_sha       TEXT NOT NULL,
  supersedes_batch_id TEXT,
  payload_json        TEXT NOT NULL,
  payload_sha256      TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'open',
  dispatch_task_id    TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (review_id, revision)
);
CREATE TABLE fix_batch_results (
  batch_id           TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  finding_id         TEXT NOT NULL,
  result             TEXT NOT NULL,
  summary            TEXT,
  files_changed_json TEXT NOT NULL DEFAULT '[]',
  evidence           TEXT,
  interaction        TEXT,
  evidence_path      TEXT,
  evidence_sha256    TEXT,
  ingested_at        TEXT NOT NULL,
  PRIMARY KEY (batch_id, task_id, finding_id)
);
`;

function seedBatch(db: DatabaseInstance): void {
  db.prepare(
    `INSERT INTO fix_batches (id, review_id, revision, candidate_sha, payload_json, payload_sha256, state, created_at)
     VALUES ('fb-aged', 'review-aged', 1, 'candAged', '{}', 'deadbeef', 'dispatched', ?)`,
  ).run("2026-08-01T09:00:00.000Z");
}

function agedThenMigrated(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);
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

describe("FG-710 — an aged store gains the refused-delivery table and the executed_assertion column", () => {
  test("the fixture is genuinely aged: pre-open it has neither the table nor the column", () => {
    const raw = new Database(":memory:");
    raw.exec(AGED_SCHEMA_SQL);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((t) => t.name);
    assert.equal(tables.includes("fix_batch_refused_deliveries"), false, "the aged shape must not carry the table");
    const cols = (raw.prepare(`PRAGMA table_info(fix_batch_results)`).all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(cols.includes("executed_assertion"), false, "the aged shape must not carry the column");
    raw.close();
  });

  test("SCHEMA_SQL + applyMigrations on open creates the table and adds the column", () => {
    withAgedDb((db) => {
      const cols = (db.prepare(`PRAGMA table_info(fix_batch_refused_deliveries)`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
      assert.deepEqual(cols, [
        "batch_id", "captured_at_candidate_sha", "created_at", "diff_patch", "porcelain_status",
        "raw_result_bytes", "refusal_reasons_json", "repair_attempts", "revision", "state", "updated_at",
      ]);
      const resultCols = (db.prepare(`PRAGMA table_info(fix_batch_results)`).all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(resultCols.includes("executed_assertion"), "the ALTER added executed_assertion");
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

  test("the store serves capture/claim/supersede against the brought-forward table", () => {
    withAgedDb((db) => {
      seedBatch(db);
      const rec = captureRefusedFixDelivery({
        batchId: "fb-aged",
        revision: 1,
        capturedAtCandidateSha: "candAged",
        refusalReasons: ["fixer result.json invalid"],
        rawResultBytes: "{}",
        diffPatch: "diff\n",
        porcelainStatus: "M  src/x.ts\0",
      });
      assert.equal(rec.state, "open");
      const won = claimRefusedFixDeliveryRepair("fb-aged", 1);
      assert.equal(won?.state, "repairing");
      assert.equal(won?.repairAttempts, 1);
      supersedeRefusedFixDelivery("fb-aged", 1);
      assert.equal(refusedFixDelivery("fb-aged", 1)?.state, "superseded");
    });
  });
});
