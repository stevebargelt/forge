// FG-621 — the `tasks.base_sha` migration, against a REAL pre-change database.
//
// WHY THIS FILE EXISTS. FG-621 records a mutating task's base commit durably
// (AC 4 is asserted on the RECORDED value, not on an inferred one), which meant
// a new column on `tasks`. The build phase verified the migration by hand once
// and wrote the evidence into a result payload; nothing in the tree re-checks it.
// That is the wrong place for it to live: `applyMigrations` runs on EVERY forge
// process's next DB open on this host, so a base_sha migration that is
// non-additive, non-nullable or non-idempotent breaks every already-installed
// forge — including the ones not running FG-621's code. This file pins the
// property in the tree, where CI re-runs it.
//
// It builds a database with the PRE-FG-621 `tasks` shape on disk — every column
// through FG-351's `worktree_path`, and NOT base_sha — populates it with legacy
// rows, then opens it through the production getDb() path (SCHEMA_SQL +
// applyMigrations) and asserts:
//
//   - the column LANDS, and lands exactly once
//   - legacy rows survive, with baseSha reading back as `undefined` (not null,
//     not a throw) through the ordinary Task accessor
//   - a legacy row's worktree_path is untouched — the migration adds, it does
//     not recreate the table
//   - setTaskWorkspace round-trips path + base across a real close/reopen
//   - clearTaskWorkspace clears BOTH, because they are the one fact
//   - the FG-351 linked-worktree writer leaves base_sha NULL — a linked
//     worktree records no base, and must not acquire one by accident
//   - a second open is a no-op: no error, no duplicate column, no row churn
//
// The DB lives at DB_PATH under the per-process temp FORGE_HOME the harness
// installs (src/test-setup.ts) — never ~/.forge/forge.db. Modelled on
// fg606-tickets-migration.integration.test.ts.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, applyMigrations, closeDb } from "./db.js";
import { getTask, setTaskWorkspace, clearTaskWorkspace, setTaskWorktreePath } from "./tasks.js";
import { DB_PATH } from "../util/paths.js";

// A PRE-FG-621 `tasks` table: production's shape at the commit before this
// ticket — resolved_* from AWN-7 and worktree_path from FG-351 are present,
// base_sha is not. This is exactly what a database written by any currently
// installed forge on the host looks like.
const LEGACY_DDL = `
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT
);
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  parent_id         TEXT REFERENCES tasks(id),
  phase             TEXT NOT NULL,
  agent_role        TEXT NOT NULL,
  agent_alias       TEXT,
  agent_model       TEXT,
  status            TEXT NOT NULL,
  task_package      TEXT NOT NULL,
  result            TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  error             TEXT,
  resolved_profile  TEXT,
  resolved_provider TEXT,
  resolved_auth     TEXT,
  resolved_by       TEXT,
  worktree_path     TEXT
);
`;

const LEGACY_RUN = "run-fg621-legacy";
// A legacy row that never had a workspace at all.
const LEGACY_PLAIN = "task-fg621-legacy-plain";
// A legacy row that DID carry FG-351's worktree_path. The interesting one: if
// the migration recreated the table rather than altering it, this value is what
// would silently go missing.
const LEGACY_WORKTREE = "task-fg621-legacy-worktree";
const LEGACY_WORKTREE_PATH = "/home/op/.forge/worktrees/run-fg621-legacy/task-fg621-legacy-worktree";

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(LEGACY_DDL);

  assert.ok(
    !columnNames(legacy, "tasks").includes("base_sha"),
    "precondition: the legacy tasks table must NOT have base_sha, or this file proves nothing",
  );

  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(LEGACY_RUN, "feature", "a run recorded before FG-621", "active", "2026-07-20T00:00:00Z", "/home/op/proj");

  const ins = legacy.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, worktree_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(LEGACY_PLAIN, LEGACY_RUN, "build", "engineer", "complete", "{}", "2026-07-20T00:00:01Z", null);
  ins.run(
    LEGACY_WORKTREE,
    LEGACY_RUN,
    "build",
    "engineer",
    "complete",
    "{}",
    "2026-07-20T00:00:02Z",
    LEGACY_WORKTREE_PATH,
  );

  assert.equal(legacy.pragma("user_version", { simple: true }), 0, "legacy store starts at user_version 0");
  legacy.close();
});

test("FG-621 migration: opening a pre-change DB through getDb() adds base_sha additively and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  const cols = columnNames(db, "tasks");
  assert.ok(cols.includes("base_sha"), "base_sha must be added on the ordinary open path");
  assert.equal(
    cols.filter((c) => c === "base_sha").length,
    1,
    "exactly one base_sha column — an ALTER that ran twice would be an error, not a duplicate, but pin it anyway",
  );

  // Additive means every pre-existing column is still there, in place.
  for (const expected of ["worktree_path", "resolved_profile", "task_package", "error"]) {
    assert.ok(cols.includes(expected), `${expected} must survive the migration`);
  }

  assert.equal(countRows(db, "tasks"), 2, "the migration must not drop or duplicate task rows");
  assert.equal(countRows(db, "runs"), 1, "and must not touch runs");

  // Nullable: the column arrives NULL on every existing row. A NOT NULL add
  // would have thrown on a populated table; assert the value, not just the shape.
  const bases = db.prepare(`SELECT id, base_sha, worktree_path FROM tasks ORDER BY id`).all() as Array<{
    id: string;
    base_sha: string | null;
    worktree_path: string | null;
  }>;
  assert.deepEqual(
    bases.map((r) => r.base_sha),
    [null, null],
    "every legacy row's base_sha is NULL — nothing invents a base for a task that never recorded one",
  );

  // The table was ALTERED, not recreated: FG-351's recorded workspace path is
  // still on the row that had one.
  const withWorktree = bases.find((r) => r.id === LEGACY_WORKTREE);
  assert.equal(withWorktree?.worktree_path, LEGACY_WORKTREE_PATH, "a legacy worktree_path must survive untouched");

  assert.equal(db.pragma("user_version", { simple: true }), 0, "no destructive boundary crossed — user_version stays 0");
});

test("FG-621 migration: a legacy row reads back through the Task accessor with baseSha undefined, not null", () => {
  getDb();

  const plain = getTask(LEGACY_PLAIN);
  assert.ok(plain, "the legacy row must still be readable");
  assert.equal(plain!.baseSha, undefined, "a pre-FG-621 row carries no base, and surfaces as undefined");
  assert.equal(plain!.worktreePath, undefined);
  // `undefined` specifically, not null: every Task consumer reads optional
  // fields with `?? ` / `if (x)` semantics, and a null leaking through the row
  // mapper is the shape that survives those checks and fails later.
  assert.ok(!("baseSha" in plain! && plain!.baseSha === null), "baseSha must never surface as null");

  const legacyWorktree = getTask(LEGACY_WORKTREE);
  assert.equal(legacyWorktree?.worktreePath, LEGACY_WORKTREE_PATH, "the legacy workspace path reads back intact");
  assert.equal(legacyWorktree?.baseSha, undefined, "…and it acquired no base by being migrated");
});

test("FG-621 migration: setTaskWorkspace round-trips path AND base across a real close/reopen", () => {
  getDb();
  const base = "0123456789abcdef0123456789abcdef01234567";
  const clonePath = "/home/op/.forge/worktrees/clones/run-fg621-legacy/task-fg621-legacy-plain";

  setTaskWorkspace(LEGACY_PLAIN, clonePath, base);

  const beforeReopen = getTask(LEGACY_PLAIN);
  assert.equal(beforeReopen?.worktreePath, clonePath);
  assert.equal(beforeReopen?.baseSha, base);

  // The point of a COLUMN rather than in-memory state: the container has not
  // started yet, and the process that dispatched it may not be the process that
  // reconciles it.
  closeDb();
  const reopened = getTask(LEGACY_PLAIN);
  assert.equal(reopened?.worktreePath, clonePath, "the workspace path survives a process restart");
  assert.equal(reopened?.baseSha, base, "and so does the base it was created at");
});

test("FG-621 migration: clearTaskWorkspace clears BOTH columns — they are one fact", () => {
  getDb();
  const base = "fedcba9876543210fedcba9876543210fedcba98";
  setTaskWorkspace(LEGACY_WORKTREE, "/home/op/.forge/worktrees/clones/r/t", base);
  assert.equal(getTask(LEGACY_WORKTREE)?.baseSha, base, "precondition: the row carries a base to clear");

  clearTaskWorkspace(LEGACY_WORKTREE);

  const cleared = getTask(LEGACY_WORKTREE);
  assert.equal(cleared?.worktreePath, undefined, "the failed-setup lane unrecords the path…");
  assert.equal(cleared?.baseSha, undefined, "…and the base with it — a base without a workspace names nothing");
});

test("FG-621 migration: the FG-351 linked-worktree writer records NO base", () => {
  getDb();
  // setTaskWorktreePath is the non-clone substrate's writer. A linked worktree
  // has no recorded base by design (its base is the parent's HEAD at creation),
  // so this path must leave base_sha alone rather than acquiring one — otherwise
  // "row has a base_sha" stops being a usable signal about the substrate.
  clearTaskWorkspace(LEGACY_PLAIN);
  setTaskWorktreePath(LEGACY_PLAIN, "/home/op/.forge/worktrees/run-fg621-legacy/task-fg621-legacy-plain");

  const t = getTask(LEGACY_PLAIN);
  assert.equal(t?.worktreePath, "/home/op/.forge/worktrees/run-fg621-legacy/task-fg621-legacy-plain");
  assert.equal(t?.baseSha, undefined, "a linked worktree records no base");
});

test("FG-621 migration: re-running applyMigrations on the already-migrated DB is a no-op", () => {
  const db = getDb();

  // Every forge process on the host re-runs this on its next open. Twice more.
  applyMigrations(db);
  applyMigrations(db);

  const cols = columnNames(db, "tasks");
  assert.equal(cols.filter((c) => c === "base_sha").length, 1, "still exactly one base_sha column");
  assert.equal(countRows(db, "tasks"), 2, "no row churn on re-migration");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "still no user_version bump");

  // Data written post-migration survives the re-run.
  assert.equal(
    getTask(LEGACY_PLAIN)?.worktreePath,
    "/home/op/.forge/worktrees/run-fg621-legacy/task-fg621-legacy-plain",
    "no data loss on re-migration",
  );
});
