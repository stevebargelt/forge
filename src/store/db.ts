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
  // AWN-7: per-task model resolution record (policy mode). Additive + nullable —
  // old binaries tolerate the extra columns; new binaries ALTER on first open.
  if (!haveTasks.has("resolved_profile")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN resolved_profile TEXT`);
  }
  if (!haveTasks.has("resolved_provider")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN resolved_provider TEXT`);
  }
  if (!haveTasks.has("resolved_auth")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN resolved_auth TEXT`);
  }
  if (!haveTasks.has("resolved_by")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN resolved_by TEXT`);
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

  // #155: model_calls table reshape. The 0.1.x schema had prompt_tokens/
  // completion_tokens/cost; we want input_tokens/output_tokens/cache_* and no
  // cost column. Add the new columns idempotently; leave the legacy columns in
  // place (they're NOT NULL with no data rows that matter — the table was
  // empty until #155 anyway).
  const modelCallsCols = db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[];
  const haveModelCalls = new Set(modelCallsCols.map((r) => r.name));
  if (!haveModelCalls.has("task_id")) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN task_id TEXT REFERENCES tasks(id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_task ON model_calls(task_id)`);
  }
  if (!haveModelCalls.has("input_tokens")) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!haveModelCalls.has("output_tokens")) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!haveModelCalls.has("cache_read_tokens")) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!haveModelCalls.has("cache_creation_tokens")) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  // Created indexes (created_at index too — used by --since time filters).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_request ON model_calls(request_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at)`);
}

// Separate caches for readonly vs writable handles. The earlier single-cache
// implementation had a latent footgun: the first caller's mode locked in the
// connection for the rest of the process, so a process that opened readonly
// for one query and tried to write later silently dropped writes. Caught
// twice now (#155 backfill, #157 sweep). Fixed by keeping both handles.
let _dbRW: DatabaseInstance | null = null;
let _dbRO: DatabaseInstance | null = null;

export function getDb(opts?: { readOnly?: boolean }): DatabaseInstance {
  ensureForgeDirs();
  // A read-only open on a non-existent file would fail. If no DB exists yet,
  // fall through to a writable open so the schema gets created — read-only
  // callers on a fresh install simply observe an empty DB.
  const wantReadOnly = opts?.readOnly === true && existsSync(DB_PATH);

  if (wantReadOnly) {
    if (_dbRO) return _dbRO;
    // Schema + migrations must have run at least once before a readonly handle
    // is useful. If no writable handle has opened yet, open one transiently to
    // bootstrap schema, then return a fresh readonly handle. (Idempotent —
    // both `getDb()` and the bootstrap point at the same on-disk file.)
    if (!_dbRW) getDb();
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma("busy_timeout = 5000");
    _dbRO = db;
    return db;
  }

  if (_dbRW) return _dbRW;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  // Wait up to 5s for a held write lock instead of failing immediately. Cheap
  // insurance against contention between concurrent forge invocations (e.g.
  // `status` while `next` is mid-flight). With WAL, readers don't block
  // writers; this matters mostly for the small write window during commit.
  db.pragma("busy_timeout = 5000");
  _dbRW = db;
  return db;
}

export function closeDb(): void {
  if (_dbRW) { _dbRW.close(); _dbRW = null; }
  if (_dbRO) { _dbRO.close(); _dbRO = null; }
}

// Test seam: install a fresh in-memory DB as the singleton. Used by tests so
// they don't touch the real on-disk forge.db. Returns the previous DB so the
// caller can restore it after the test. The same handle services both
// readonly and writable callers in test mode (in-memory DBs don't have the
// concurrency concern that drives the split in production).
export function setDbForTest(db: DatabaseInstance): DatabaseInstance | null {
  const prev = _dbRW;
  _dbRW = db;
  _dbRO = db;
  return prev;
}

export function makeInMemoryDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}
