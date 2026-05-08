import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync } from "node:fs";
import { DB_PATH, ensureForgeDirs } from "../util/paths.js";
import { SCHEMA_SQL } from "./schema.js";

// Idempotent ALTERs for existing DBs whose `runs` table predates a column added
// in schema.ts. New DBs get the column from CREATE TABLE; existing DBs get it
// here. Each migration is guarded by PRAGMA table_info so the second run is a
// noop. Add a new entry here whenever you add a column to an existing table.
function applyMigrations(db: DatabaseInstance): void {
  const runsCols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const haveRuns = new Set(runsCols.map((r) => r.name));
  if (!haveRuns.has("project_dir")) {
    db.exec(`ALTER TABLE runs ADD COLUMN project_dir TEXT`);
  }
  const tasksCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const haveTasks = new Set(tasksCols.map((r) => r.name));
  if (!haveTasks.has("agent_alias")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_alias TEXT`);
  }
  if (!haveTasks.has("agent_model")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_model TEXT`);
  }

  // Phase rename: investigation.frame → investigation.frame-question. UPDATE
  // any existing task rows so dashboards / status / loadWorkflow can resolve
  // the phase against the renamed workflow file. Idempotent — second run finds
  // 0 rows.
  db.exec(`UPDATE tasks SET phase = 'frame-question' WHERE phase = 'frame'`);

  // Workflow rename (2026-05-08): old run rows reference deleted workflow names.
  // Rather than maintain alias maps in workflows.ts forever (Steven 2026-05-08:
  // "Start after this run. Solves it no?"), in-place migrate. Idempotent.
  db.exec(`UPDATE runs SET workflow = 'feature' WHERE workflow = 'feature-design-needed'`);
  db.exec(`UPDATE runs SET workflow = 'feature-ui-design-provided' WHERE workflow = 'feature-design-provided'`);
  db.exec(`UPDATE runs SET workflow = 'ui-design-revise' WHERE workflow = 'design-revise'`);

  // Phase rename: ui-design.review → ui-design.ui-review. Same idempotent UPDATE.
  // Scope by phase only — both ui-design and ui-design-revise use this phase
  // and there's no other workflow with a phase named "review" today.
  db.exec(`UPDATE tasks SET phase = 'ui-review' WHERE phase = 'review'`);
}

let _db: DatabaseInstance | null = null;

export function getDb(opts?: { readOnly?: boolean }): DatabaseInstance {
  if (_db) return _db;
  ensureForgeDirs();
  // A read-only open on a non-existent file would fail. If no DB exists yet, fall through
  // to a writable open so the schema gets created — read-only callers running on a fresh
  // install will simply observe an empty DB.
  const readOnly = opts?.readOnly === true && existsSync(DB_PATH);
  const db = new Database(DB_PATH, readOnly ? { readonly: true } : undefined);
  if (!readOnly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
  }
  // Wait up to 5s for a held write lock instead of failing immediately. Cheap insurance
  // against contention between concurrent forge invocations (e.g. `status` while `next`
  // is mid-flight). With WAL, readers don't block writers; this matters mostly for the
  // small write window during commit.
  db.pragma("busy_timeout = 5000");
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Test seam: install a fresh in-memory DB as the singleton. Used by tests so they
// don't touch the real on-disk forge.db. Returns the previous DB so the caller can
// restore it after the test.
export function setDbForTest(db: DatabaseInstance): DatabaseInstance | null {
  const prev = _db;
  _db = db;
  return prev;
}

export function makeInMemoryDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}
