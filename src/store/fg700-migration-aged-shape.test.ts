// FG-700 — the AGED `launch_observations`, and why a fresh DB cannot prove this.
//
// `purpose` is the FIRST column this table has ever gained by ALTER. FG-679 created the
// table WHOLE, so every one of its ADDITIVE_COLUMNS entries is a no-op on every store
// that exists — and that is exactly the shape in which a missing entry stays invisible.
// Every test DB in this repo is created FRESH from SCHEMA_SQL, whose CREATE now names
// the column, so a column with no matching ALTER would be green across the ENTIRE suite
// and would fail only on the machine-wide `~/.forge/forge.db` an operator has been using
// since FG-679. That is the FG-608 defect, and it is why this file exists rather than a
// PRAGMA assertion over a fresh store.
//
// The fixture is therefore HAND-AUTHORED at the shape a POST-FG-679 / PRE-FG-700 binary
// actually created — the same discipline as fg591-migration-aged-shape.test.ts and
// fg609-migration-aged-shape.test.ts. It carries real rows written the aged way (no
// purpose column at all), and the migration path is then asked to bring it forward AND
// to SERVE the reads FG-700 added: the derivation, the classification, and the
// fail-closed rule over rows that predate the declaration.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import {
  getLaunchObservation,
  launchObservationColumns,
  recordLaunchObservation,
} from "./launch-observations.js";
import { deriveCurrentActivity, renderCurrentActivityLines } from "../v2/current-activity.js";

const PROJECT = "/repos/forge";
const AGED_AT = "2026-08-01T09:00:00.000Z";
const NOW = new Date("2026-08-01T09:05:00.000Z");

// launch_observations EXACTLY as FG-679 created it: seventeen columns, no `purpose`.
// Written out by hand rather than derived from today's CREATE — a fixture built by
// dropping a column off the fresh schema would carry today's shape by construction, and
// the point is a store this binary did not create.
const AGED_SCHEMA_SQL = `
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  project_dir TEXT
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  phase        TEXT NOT NULL,
  agent_role   TEXT NOT NULL,
  agent_model  TEXT,
  status       TEXT NOT NULL,
  task_package TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  started_at   TEXT
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  task_id    TEXT,
  event_type TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
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
CREATE INDEX idx_launch_observations_run ON launch_observations(run_id);
`;

/** The aged store with real pre-FG-700 rows in it, then opened exactly as a real open
 *  does: SCHEMA_SQL (whose CREATEs no-op over the existing tables — the very reason a
 *  missing ALTER is invisible) followed by applyMigrations. */
function agedThenMigrated(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);

  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-aged', 'feature', 'aged run', 'active', ?, ?)`)
    .run(AGED_AT, PROJECT);

  // Two launches, written the aged way: seventeen columns, no purpose to declare. Both
  // are ASSOCIATED and RUNNING — which is precisely what the pre-FG-700 reader treated
  // as proof of host verification.
  const insert = db.prepare(`
    INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, ticket_id, started_at, observed_at, state, terminal)
    VALUES (?, ?, ?, ?, ?, 'explicit', 'run-aged', ?, ?, ?, 'running', 0)
  `);
  insert.run("launch-agedverify-a1", "worktree-tier", JSON.stringify(["npm", "run", "test:worktree"]), PROJECT, PROJECT, "FG-679", AGED_AT, AGED_AT);
  insert.run("launch-agedinvoke-a2", "engineer", JSON.stringify(["forge", "invoke", "engineer"]), PROJECT, PROJECT, "FG-683", AGED_AT, AGED_AT);

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

describe("FG-700 — the aged launch_observations gains `purpose` and serves every new read", () => {
  test("the fixture is genuinely aged: pre-open, launch_observations has NO purpose column", () => {
    // Guards the fixture itself. If this ever stops holding, the fixture has silently
    // become a fresh store and every assertion below proves nothing.
    const raw = new Database(":memory:");
    raw.exec(AGED_SCHEMA_SQL);
    const cols = (raw.prepare(`PRAGMA table_info(launch_observations)`).all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(cols.includes("purpose"), false, "the aged shape must not already carry the column");
    assert.equal(cols.length, 17, "…and must be exactly the seventeen columns FG-679 created");
    raw.close();
  });

  test("the guarded ALTER adds the column to a store created before it existed", () => {
    withAgedDb((db) => {
      const cols = (db.prepare(`PRAGMA table_info(launch_observations)`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>);
      const purpose = cols.find((c) => c.name === "purpose");
      assert.ok(purpose, "CREATE TABLE IF NOT EXISTS no-ops over the aged table — only the ALTER can add this");
      assert.equal(purpose.type, "TEXT");
      assert.equal(purpose.notnull, 0, "nullable: an aged row never declared a purpose, and NULL is how it says so");
      assert.equal(purpose.dflt_value, null, "…and undefaulted, so the absence is not silently rewritten as a claim");
      assert.match(launchObservationColumns(db), /purpose/);
    });
  });

  test("opening an aged store does not bump user_version — an older binary must still open it", () => {
    withAgedDb((db) => {
      assert.equal(db.pragma("user_version", { simple: true }), 0);
    });
  });

  test("re-running the open path on an already-migrated aged store is a no-op", () => {
    withAgedDb((db) => {
      const shape = (): string => JSON.stringify(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all());
      const before = shape();
      db.exec(SCHEMA_SQL);
      applyMigrations(db);
      assert.equal(shape(), before);
    });
  });

  test("the aged rows survive the migration with every fact they carried", () => {
    withAgedDb(() => {
      const obs = getLaunchObservation("launch-agedverify-a1")!;
      assert.equal(obs.runId, "run-aged");
      assert.equal(obs.ticketId, "FG-679");
      assert.equal(obs.associationKind, "explicit");
      assert.equal(obs.observedAt, AGED_AT);
      assert.deepEqual(obs.status, { state: "running" });
      assert.deepEqual(obs.command, ["npm", "run", "test:worktree"]);
    });
  });

  test("NOTHING is backfilled: a migrated aged row is `generic`, and renders as a launch diagnostic rather than host verification", () => {
    withAgedDb((db) => {
      // The column is NULL for both — the migration adds a column, it does not invent
      // declarations for rows that made none. Inferring one from the argv (`npm run
      // test:worktree` LOOKS like verification) is exactly what FG-492 forbids.
      const raw = db.prepare(`SELECT launch_id, purpose FROM launch_observations ORDER BY launch_id`).all() as Array<{ launch_id: string; purpose: string | null }>;
      assert.deepEqual(raw, [
        { launch_id: "launch-agedinvoke-a2", purpose: null },
        { launch_id: "launch-agedverify-a1", purpose: null },
      ]);

      const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-aged" } });
      assert.deepEqual(activity.hostVerification, [], "an undeclared aged row is NOT host verification");
      assert.deepEqual(activity.launches.map((l) => l.launchId).sort(), ["launch-agedinvoke-a2", "launch-agedverify-a1"]);
      assert.deepEqual(activity.launches.map((l) => l.purpose), ["generic", "generic"]);

      // Not dropped, either — the operator still sees both, under a heading that makes
      // no claim about what they are.
      const rendered = renderCurrentActivityLines(activity).join("\n");
      assert.match(rendered, /\(no host launch observed in flight\)/);
      assert.match(rendered, /launch-agedverify-a1/);
      assert.match(rendered, /launch-agedinvoke-a2/);
    });
  });

  test("a NEW launch written to the migrated aged store declares and classifies normally", () => {
    withAgedDb((db) => {
      recordLaunchObservation({
        launchId: "launch-fresh-b1",
        name: "worktree-tier",
        command: ["npm", "run", "test:all"],
        cwd: PROJECT,
        projectDir: PROJECT,
        association: { runId: "run-aged", ticketId: "FG-700" },
        purpose: "host_verification",
        startedAt: NOW.toISOString(),
        observedAt: NOW.toISOString(),
        status: { state: "running" },
      });
      assert.equal(getLaunchObservation("launch-fresh-b1")?.purpose, "host_verification");
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-aged" } });
      assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["launch-fresh-b1"],
        "the migrated store serves the write path AND the classification the ALTER exists for");
    });
  });

  test("a store whose table was NEVER migrated still serves the derivation — every row `generic`", () => {
    // The dashboard's read-only handle runs no migrations at all (src/store/db.ts), so it
    // can be pointed at the aged store as-is. Selecting a column that is not there would
    // throw `no such column: purpose` and answer 500 for data that is merely older.
    const db = new Database(":memory:");
    try {
      db.exec(AGED_SCHEMA_SQL);
      db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-aged', 'feature', 'aged run', 'active', ?, ?)`)
        .run(AGED_AT, PROJECT);
      db.prepare(`
        INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, terminal)
        VALUES ('launch-unmigrated-c1', 'worktree', ?, ?, ?, 'explicit', 'run-aged', ?, ?, 'running', 0)
      `).run(JSON.stringify(["npm", "run", "test:worktree"]), PROJECT, PROJECT, AGED_AT, AGED_AT);

      assert.doesNotMatch(launchObservationColumns(db), /purpose/);
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-aged" } });
      assert.deepEqual(activity.hostVerification, []);
      assert.deepEqual(activity.launches.map((l) => l.purpose), ["generic"]);
    } finally {
      db.close();
    }
  });
});
