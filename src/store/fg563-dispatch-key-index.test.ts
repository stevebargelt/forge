// FG-563 fixer rounds 2/3 — FALSIFICATION for FIX A (schema robustness) and the
// DB-level half of FIX B (exactly-one-run-per-receipt), on the REAL store path.
// Round 3 SIMPLIFIED the migration: the convergence machinery (drop legacy + create
// unique across autocommit statements) is gone; on main the index is born unique from a
// single idempotent CREATE, and a stale-dev duplicate receipt SKIPS rather than bricks.
//
// FIX A: the dispatch-key discoverability index is an expression index over
// json_extract(metadata, '$.dispatchKey'). It USED to live in SCHEMA_SQL, which
// applyMigrations/getDb exec on EVERY open (read opens included, FG-568). Against a
// runs table with NO metadata column — the dashboard read fixtures, and any foreign
// minimal store — CREATE INDEX threw SQLITE_ERROR and every open failed. The index
// moved to applyMigrations behind a PRAGMA table_info(runs) metadata-column guard;
// a metadata-less open must no longer throw.
//
// FIX B: the same index is now UNIQUE (partial, over the non-null receipt) so a
// second physical run can never be inserted under a dispatch_key that already has
// one — the DB-level backstop that makes two same-host controllers converge on ONE
// run. NULL dispatchKeys (ordinary runs with no receipt) stay non-unique.
//
// Each assertion was observed RED against the pre-fix baseline (SCHEMA_SQL index,
// non-unique) and green after.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applyMigrations, makeInMemoryDb, setDbForTest, closeDb } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { insertRun, runByDispatchKey } from "./runs.js";
import type { Run } from "../types/index.js";

function run(id: string, metadata: Record<string, unknown> | undefined): Run {
  return {
    id,
    workflow: "feature",
    title: id,
    status: "active",
    createdAt: new Date("2026-07-19T00:00:00Z").toISOString(),
    ...(metadata ? { metadata } : {}),
    projectDir: "/tmp/p",
  };
}

// ── FIX A: a pre-existing metadata-less runs table must open without throwing ──

test("FIX A: SCHEMA_SQL + applyMigrations open a pre-existing metadata-less runs table without throwing (was SQLITE_ERROR)", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // The dashboard read-fixture shape: a foreign/minimal runs table with NO metadata
  // column. CREATE TABLE IF NOT EXISTS in SCHEMA_SQL will NOT replace it, so the open
  // sees a metadata-less runs table — exactly the case that used to throw.
  db.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);`,
  );
  assert.doesNotThrow(() => {
    db.exec(SCHEMA_SQL); // brings the OTHER tables forward; runs stays metadata-less
    applyMigrations(db); // the guarded index step must SKIP when metadata is absent
  });
  const idx = db.prepare(`PRAGMA index_list(runs)`).all() as { name: string }[];
  assert.ok(
    !idx.some((i) => i.name === "idx_runs_dispatch_key"),
    "the dispatch-key index is correctly SKIPPED on a metadata-less runs table",
  );
  db.close();
});

// ── FIX A/B: on a real runs table the index IS created, and is UNIQUE ──

test("FIX A/B: a real runs table (with metadata) gets the guarded index, and it is UNIQUE", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL); // a fresh runs table HAS a metadata column
  applyMigrations(db);
  const idx = db.prepare(`PRAGMA index_list(runs)`).all() as { name: string; unique: number }[];
  const dispatchIdx = idx.find((i) => i.name === "idx_runs_dispatch_key");
  assert.ok(dispatchIdx, "the dispatch-key index IS created on a real runs table");
  assert.equal(dispatchIdx!.unique, 1, "and it is UNIQUE (FIX B exactly-one-run-per-receipt)");
  db.close();
});

// ── FIX 1 (round 3, HIGH-1): a pre-existing DUPLICATE dispatch_key must NOT brick ──
//
// Round 2 dropped the legacy index and ran CREATE UNIQUE unconditionally. On a stale
// dev DB that already holds two runs under the SAME receipt, that CREATE UNIQUE throws
// SQLITE_CONSTRAINT — and because migrations run on EVERY open, the throw wedges every
// subsequent open PERMANENTLY. Round 3 duplicate-checks first and SKIPS creation, so the
// open never wedges. Observed RED against the round-2 baseline (applyMigrations threw).

test("FIX 1 (HIGH-1): a pre-existing DUPLICATE dispatch_key does NOT brick the open — applyMigrations skips the index instead of throwing", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  // A stale dev DB shape: two runs already carry the SAME dispatch_key. No UNIQUE index
  // exists yet (they were inserted before it), so the raw duplicate is present.
  db.exec(`DROP INDEX IF EXISTS idx_runs_dispatch_key`);
  const ins = db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, metadata, project_dir) VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run("run-dupA", "feature", "A", "active", "2026-07-19T00:00:00Z", JSON.stringify({ dispatchKey: "DUP" }), "/tmp/p");
  ins.run("run-dupB", "feature", "B", "active", "2026-07-19T00:00:00Z", JSON.stringify({ dispatchKey: "DUP" }), "/tmp/p");
  assert.doesNotThrow(() => applyMigrations(db), "a duplicate receipt must NOT wedge the open");
  const idx = db.prepare(`PRAGMA index_list(runs)`).all() as { name: string }[];
  assert.ok(
    !idx.some((i) => i.name === "idx_runs_dispatch_key"),
    "the unique index is SKIPPED (not created) while a duplicate exists — never a throw",
  );
  db.close();
});

// ── FIX 1 (round 3): the simplified create is idempotent across repeated opens ──

test("FIX 1 (round 3): repeated applyMigrations on a fresh runs table are idempotent and keep the index UNIQUE", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  assert.doesNotThrow(() => applyMigrations(db), "second open is a noop (CREATE ... IF NOT EXISTS)");
  const idx = db.prepare(`PRAGMA index_list(runs)`).all() as { name: string; unique: number }[];
  const dispatchIdx = idx.find((i) => i.name === "idx_runs_dispatch_key");
  assert.ok(dispatchIdx, "the index persists across repeated opens");
  assert.equal(dispatchIdx!.unique, 1, "and stays UNIQUE");
  db.close();
});

// ── FIX B (DB-level) + runByDispatchKey semantics against a real runs table ──

test("FIX B (DB-level): a second run under the SAME dispatch_key COLLIDES; runByDispatchKey still resolves the ONE run", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    insertRun(run("run-A", { dispatchKey: "K1", foo: "bar" }));
    // runByDispatchKey resolves the one run against the real (indexed) query.
    assert.equal(runByDispatchKey("K1")?.id, "run-A", "the one run is discoverable by its receipt");
    assert.equal(runByDispatchKey("nope"), undefined, "a receipt with no run resolves to undefined");

    // A second physical run under the SAME receipt is rejected by the UNIQUE index —
    // the exactly-one-run-per-receipt guarantee (FIX B) at the DB level.
    assert.throws(
      () => insertRun(run("run-B", { dispatchKey: "K1" })),
      /UNIQUE|constraint/i,
      "a duplicate dispatch_key insert collides on the UNIQUE index",
    );
    // The collision left the original untouched — still exactly one run under K1.
    assert.equal(runByDispatchKey("K1")?.id, "run-A", "still the ONE original run after the rejected duplicate");
  } finally {
    if (prev) setDbForTest(prev);
    else closeDb();
  }
});

test("FIX B (DB-level): runs with NO dispatchKey are NON-unique — ordinary runs are unaffected", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    // Ordinary runs: one with metadata lacking the key, one with no metadata at all.
    // The partial UNIQUE index excludes null receipts, so these never collide.
    assert.doesNotThrow(() => insertRun(run("run-1", { foo: "bar" })));
    assert.doesNotThrow(() => insertRun(run("run-2", undefined)));
    assert.doesNotThrow(() => insertRun(run("run-3", { foo: "baz" })));
    assert.equal(runByDispatchKey("K1"), undefined, "no receipt-bearing run exists");
  } finally {
    if (prev) setDbForTest(prev);
    else closeDb();
  }
});
