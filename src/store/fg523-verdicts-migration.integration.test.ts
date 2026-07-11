// FG-523 (F16) — the migration, against a REAL pre-change database.
//
// The unit coverage (v2/fg523-gate-on-verdict.test.ts) simulates a legacy row by
// insert-bypassing the accessor on an already-migrated in-memory DB. That proves
// the READ rule but not the migration: it never exercises a verdicts table that
// genuinely lacks the column. This file does — it builds a database from the
// PRE-change schema on disk, then opens it through the production `getDb()` path
// (SCHEMA_SQL + applyMigrations, exactly what a real upgraded install runs on
// first open) and asserts:
//
//   - the ALTER lands: gate_on_verdict appears on a table that didn't have it
//   - no data loss: row counts unchanged, field-level spot-check intact
//   - old rows read back gateOnVerdict === null (nullable, NOT back-filled)
//   - aggregateVerdicts still BLOCKS on them — pre-migration behavior preserved
//   - the migration is idempotent, and new rows coexist with legacy ones
//
// The DB lives at DB_PATH under the per-process temp FORGE_HOME the harness
// installs (src/test-setup.ts) — never ~/.forge/forge.db.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, applyMigrations } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { insertVerdict, verdictsForTask } from "./verdicts.js";
import { aggregateVerdicts, verdictBlocksGate } from "../v2/gate.js";
import { DB_PATH } from "../util/paths.js";

// The verdicts table EXACTLY as it stood before FG-523 — no gate_on_verdict.
// Created first, so the subsequent SCHEMA_SQL exec (all CREATE TABLE IF NOT
// EXISTS) leaves it alone and creates only the other tables. That is precisely
// the state of a database written by the pre-FG-523 binary.
const LEGACY_VERDICTS_DDL = `
CREATE TABLE verdicts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  red_task_id     TEXT NOT NULL REFERENCES tasks(id),
  red_role        TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  confidence      REAL NOT NULL,
  authority       TEXT NOT NULL,
  findings        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdicts_task ON verdicts(task_id);
`;

const PRIMARY = "task-fg523-legacy-primary";
const LEGACY_FINDINGS = [
  { severity: "high", summary: "auth bypass on the admin route", evidence: "no session check in handler", hypothesis: "missing middleware" },
];

// What the pre-change binary would have on disk. Counted after the migration to
// prove nothing was dropped or rewritten.
const EXPECTED_ROWS = { runs: 1, tasks: 3, verdicts: 2 };

function columnNames(db: Database.Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// Build the legacy DB and close it BEFORE anything in this process calls
// getDb() — the first getDb() must be the one that finds this file and migrates
// it, exactly as a real upgrade does.
before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(LEGACY_VERDICTS_DDL);
  legacy.exec(SCHEMA_SQL);

  assert.equal(
    columnNames(legacy, "verdicts").has("gate_on_verdict"),
    false,
    "precondition: the legacy verdicts table must NOT have the column, or this test proves nothing",
  );

  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-fg523-legacy", "feature", "a run recorded before FG-523", "active", "2026-06-01T00:00:00Z");

  const insertTaskRow = legacy.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, role] of [
    [PRIMARY, "engineer"],
    ["task-red-legacy-auth", "red-security"],
    ["task-red-legacy-perf", "red-performance"],
  ] as const) {
    insertTaskRow.run(
      id,
      "run-fg523-legacy",
      "build",
      role,
      "awaiting_gate",
      JSON.stringify({ taskId: id, runId: "run-fg523-legacy", phase: "build", role, inputs: {}, composedSystemPrompt: "P" }),
      "2026-06-01T00:00:01Z",
    );
  }

  const insertVerdictRow = legacy.prepare(
    `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertVerdictRow.run(
    "v-legacy-auth", PRIMARY, "task-red-legacy-auth", "red-security",
    "fail", 0.92, "authoritative", JSON.stringify(LEGACY_FINDINGS), "2026-06-01T00:10:00Z",
  );
  insertVerdictRow.run(
    "v-legacy-perf", PRIMARY, "task-red-legacy-perf", "red-performance",
    "fail", 0.4, "specialist", JSON.stringify([]), "2026-06-01T00:11:00Z",
  );

  legacy.close();
});

test("FG-523 F16 migration: opening a pre-change DB through getDb() adds gate_on_verdict and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  assert.ok(columnNames(db, "verdicts").has("gate_on_verdict"), "applyMigrations must ALTER the existing table");

  for (const [table, n] of Object.entries(EXPECTED_ROWS)) {
    assert.equal(countRows(db, table), n, `${table}: the migration must not drop or duplicate rows`);
  }

  // Field-level spot-check: the ALTER must not have rewritten the surviving
  // columns (a table-rebuild migration is where data quietly changes shape).
  const row = db.prepare(`SELECT * FROM verdicts WHERE id = 'v-legacy-auth'`).get() as Record<string, unknown>;
  assert.equal(row["task_id"], PRIMARY);
  assert.equal(row["red_role"], "red-security");
  assert.equal(row["verdict"], "fail");
  assert.equal(row["confidence"], 0.92);
  assert.equal(row["authority"], "authoritative");
  assert.equal(row["created_at"], "2026-06-01T00:10:00Z");
  assert.deepEqual(JSON.parse(String(row["findings"])), LEGACY_FINDINGS);
  assert.equal(row["gate_on_verdict"], null, "the new column is nullable with NO default — old rows are not back-filled");
});

test("FG-523 F16 migration: migrated legacy rows read back gateOnVerdict null and STILL block the gate", () => {
  getDb();
  const rows = verdictsForTask(PRIMARY);
  assert.equal(rows.length, 2);

  const auth = rows.find((r) => r.id === "v-legacy-auth")!;
  assert.equal(auth.gateOnVerdict, null, "null means 'unknown', not false");
  assert.equal(verdictBlocksGate(auth), true, "fail closed: an unknown flag blocks");
  assert.deepEqual(auth.findings, LEGACY_FINDINGS, "findings survive the accessor round-trip");

  // The whole point of fail-closed: the migration must not silently un-block
  // authoritative fails recorded before the column existed.
  const agg = aggregateVerdicts(rows);
  assert.equal(agg.verdict, "fail");
  assert.deepEqual(agg.authoritativeFails.map((v) => v.id), ["v-legacy-auth"]);
  assert.deepEqual(agg.specialistFails.map((v) => v.id), ["v-legacy-perf"]);
});

test("FG-523 F16 migration: re-running applyMigrations on the already-migrated DB is a no-op", () => {
  const db = getDb();
  applyMigrations(db);
  applyMigrations(db);

  const cols = [...columnNames(db, "verdicts")].filter((c) => c === "gate_on_verdict");
  assert.deepEqual(cols, ["gate_on_verdict"], "the guard makes the ALTER idempotent — no duplicate column, no throw");
  assert.equal(countRows(db, "verdicts"), EXPECTED_ROWS.verdicts, "and no row churn");
  assert.equal(verdictsForTask(PRIMARY).find((r) => r.id === "v-legacy-auth")!.gateOnVerdict, null);
});

test("FG-523 F16 migration: rows written AFTER the migration coexist with legacy rows in one aggregate", () => {
  getDb();
  // An upgraded install keeps writing to the same table. The post-migration row
  // carries an explicit false; the legacy rows stay null. Both are read by one
  // predicate, and only the explicit false opts out of blocking.
  insertVerdict({
    id: "v-post-migration",
    taskId: PRIMARY,
    redTaskId: "task-red-legacy-perf",
    redRole: "red-advisory",
    verdict: "fail",
    confidence: 0.8,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-11T00:00:00Z",
    gateOnVerdict: false,
  });

  const rows = verdictsForTask(PRIMARY);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === "v-post-migration")!.gateOnVerdict, false, "the new column round-trips on a migrated table");

  const agg = aggregateVerdicts(rows);
  assert.deepEqual(
    agg.authoritativeFails.map((v) => v.id),
    ["v-legacy-auth"],
    "the legacy NULL fail still blocks; the explicit gate_on_verdict:false fail does not",
  );
});
