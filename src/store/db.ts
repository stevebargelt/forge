import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync } from "node:fs";
import { DB_PATH, ensureForgeDirs } from "../util/paths.js";
import { SCHEMA_SQL } from "./schema.js";

// FG-568 (BD-15): store-compatibility policy across the supported overlap window
// (a version-A process and a version-B process sharing ~/.forge/forge.db).
//
// The ordinary open path (getDb / applyMigrations) is ADDITIVE-ONLY: no DROP, no
// RENAME, no type-narrowing, no NOT NULL without a default, no new CHECK/UNIQUE an
// in-flight version-A writer's inserts can't satisfy. Old readers/writers keep
// working BY CONSTRUCTION, because a newer process never removes what an older one
// still depends on. That is the only policy safe against a deployed peer that
// cannot be made to cooperate — you cannot retrofit a gate into an already-running
// old binary (see the HONEST LIMIT on assertSchemaVersionSupported).
//
// SCHEMA_VERSION is the newest one-way boundary this binary understands, stamped
// into the store via PRAGMA user_version. It is bumped ONLY when a destructive /
// converging migration crosses a boundary an older release can no longer safely
// open past — never for ordinary additive evolution. A fresh DB and every DB
// written by a pre-FG-568 binary reads back user_version 0.
export const SCHEMA_VERSION = 1;

// The user_version stamp written by the explicit destructive convergence
// migration. Once the store carries this, it has crossed the one-way rollback
// boundary: a binary understanding a LOWER version must refuse it.
export const DESTRUCTIVE_BOUNDARY_VERSION = 1;

// The 0.1.x legacy model_calls columns the destructive convergence migration
// removes. NOT NULL with no DEFAULT and write-only dead weight — a fresh
// SCHEMA_SQL never creates them. The additive-only open path never drops them, so
// an unconverged 0.1.x store still carries all three; the current insertUsageRows
// is dual-shape — it inspects the schema and, when these columns are present,
// writes them with 0/0/0 placeholders, so usage capture SUCCEEDS on both the fresh
// and the unconverged 0.1.x shape. Converging the two shapes is a real problem, but
// a CONVERGENCE one, not an every-open one — so the drop lives here (in
// runDestructiveConvergenceMigration, run explicitly via `forge store converge`),
// off the ordinary open path, behind an explicit quiesce gate.
export const LEGACY_MODEL_CALLS_COLUMNS = ["prompt_tokens", "completion_tokens", "cost"] as const;

// Idempotent ALTERs for existing DBs whose `runs` table predates a column added
// in schema.ts. New DBs get the column from CREATE TABLE; existing DBs get it
// here. Each migration is guarded by PRAGMA table_info so the second run is a
// noop. Add a new entry here whenever you add a column to an existing table.
// Exported as a test seam so migration behavior (e.g. #295 legacy-column drop)
// can be exercised against a hand-shaped DB.
export function applyMigrations(db: DatabaseInstance): void {
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
  // FG-351: per-task worktree path. Additive + nullable — existing binaries tolerate
  // the column; new binaries ALTER on first open. Task branch identity is NOT stored
  // here — it is deterministically derived as forge/<runId>/<taskId> at runtime.
  if (!haveTasks.has("worktree_path")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`);
  }

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
  // #295 / FG-568: the 0.1.x legacy columns (prompt_tokens/completion_tokens/cost)
  // are NO LONGER dropped here. A DROP on the ordinary open path is destructive
  // DDL that would remove schema an in-flight version-A peer still depends on — so
  // it moved OFF this additive-only path into runDestructiveConvergenceMigration
  // (explicit, operator-invoked, quiesce-gated). A migrated DB that still carries
  // the legacy NOT NULL columns keeps working for old writers AND for current
  // inserts — insertUsageRows is dual-shape and fills the legacy columns with 0/0/0
  // when present. Converging it to the fresh shape (dropping the dead columns) is
  // that migration's job, not this one's. See LEGACY_MODEL_CALLS_COLUMNS.
  // Created indexes (created_at index too — used by --since time filters).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_request ON model_calls(request_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at)`);

  // FG-391: plan_hash column on campaigns. New DBs get it from CREATE TABLE in
  // schema.ts; existing DBs get it here. Preferred over metadata-only so FG-392
  // can compare current-vs-approved plan_hash with a simple column lookup.
  const campaignsCols = db.prepare(`PRAGMA table_info(campaigns)`).all() as { name: string }[];
  const haveCampaigns = new Set(campaignsCols.map((r) => r.name));
  if (!haveCampaigns.has("plan_hash")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN plan_hash TEXT`);
  }
  // FG-392: approval columns — each guarded independently so a crash between
  // ALTER statements leaves a partial schema that subsequent opens can repair.
  if (!haveCampaigns.has("approved_by")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN approved_by TEXT`);
  }
  if (!haveCampaigns.has("approved_at")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN approved_at TEXT`);
  }
  if (!haveCampaigns.has("approval_rationale")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN approval_rationale TEXT`);
  }
  if (!haveCampaigns.has("approved_plan_hash")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN approved_plan_hash TEXT`);
  }
  // FG-392: project_dir on campaigns. Separate guard so it applies independently.
  if (!haveCampaigns.has("project_dir")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN project_dir TEXT`);
  }

  // FG-474: source/ci_url on host_verifications — distinguishes a row backed by a
  // real host command execution ('host') from one backed by a green required CI
  // check ('ci'). DEFAULT 'host' so every pre-existing row (all host-run, by
  // construction — CI-sourced rows didn't exist before this) classifies correctly
  // without a backfill.
  const hostVerificationsCols = db.prepare(`PRAGMA table_info(host_verifications)`).all() as { name: string }[];
  const haveHostVerifications = new Set(hostVerificationsCols.map((r) => r.name));
  if (!haveHostVerifications.has("source")) {
    db.exec(`ALTER TABLE host_verifications ADD COLUMN source TEXT NOT NULL DEFAULT 'host'`);
  }
  if (!haveHostVerifications.has("ci_url")) {
    db.exec(`ALTER TABLE host_verifications ADD COLUMN ci_url TEXT`);
  }

  // FG-523 (F16): gate_on_verdict on verdicts. Additive + nullable, NO default —
  // existing rows keep reading back NULL, which aggregateVerdicts treats as
  // "blocks" (fail closed), exactly as before the column existed.
  const verdictsCols = db.prepare(`PRAGMA table_info(verdicts)`).all() as { name: string }[];
  const haveVerdicts = new Set(verdictsCols.map((r) => r.name));
  if (!haveVerdicts.has("gate_on_verdict")) {
    db.exec(`ALTER TABLE verdicts ADD COLUMN gate_on_verdict INTEGER`);
  }
}

// FG-568 (BD-15 §3): the forward schema-version gate. A process refuses to open a
// store whose stamped one-way boundary version is NEWER than this binary
// understands — the newer process may have crossed a destructive boundary this
// binary can't safely operate past. Additive-only evolution keeps user_version at
// 0, so this NEVER fires for ordinary column additions; only the destructive
// convergence migration bumps the stamp.
//
// HONEST LIMIT — this constrains only FUTURE binaries. It cannot constrain an
// ALREADY-INSTALLED old binary: a release predating this gate never performs the
// check, so it will still open (and can still corrupt) a post-boundary store. The
// gate makes every future promotion safe; it is powerless over what is already
// deployed. That is exactly why the ordinary open path must ALSO be additive-only
// (a deployed old binary that cannot be gated must never be broken by a new one).
//
// `understoodVersion` is injectable so a test can stand in for an older-schema
// binary (one whose SCHEMA_VERSION is lower) without a second real process.
export function assertSchemaVersionSupported(
  db: DatabaseInstance,
  understoodVersion: number = SCHEMA_VERSION,
): void {
  const stored = db.pragma("user_version", { simple: true }) as number;
  if (stored > understoodVersion) {
    throw new Error(
      `forge: refusing to open store — its schema version (${stored}) is newer than this ` +
        `binary understands (${understoodVersion}). A newer forge crossed a one-way migration ` +
        `boundary; upgrade this install to open the store.`,
    );
  }
}

// Drops the legacy columns (idempotent) and stamps the one-way boundary WITHOUT
// ever moving user_version backwards. Runs inside the caller's open transaction.
function convergeLegacyModelCalls(db: DatabaseInstance): { dropped: string[]; boundaryVersion: number } {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[]).map((c) => c.name),
  );
  const dropped: string[] = [];
  for (const col of LEGACY_MODEL_CALLS_COLUMNS) {
    if (cols.has(col)) {
      db.exec(`ALTER TABLE model_calls DROP COLUMN ${col}`);
      dropped.push(col);
    }
  }
  // Record that the one-way boundary was crossed — but only ADVANCE it. A store
  // already at or past the boundary is never stamped backwards (HIGH 2); the
  // forward gate below refuses an older binary from here on.
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current < DESTRUCTIVE_BOUNDARY_VERSION) {
    db.pragma(`user_version = ${DESTRUCTIVE_BOUNDARY_VERSION}`);
  }
  return { dropped, boundaryVersion: DESTRUCTIVE_BOUNDARY_VERSION };
}

// FG-568 (BD-15 §2/§4): the explicit, operator-invoked, quiesce-gated destructive
// migration. It converges a 0.1.x-migrated model_calls table to the fresh shape by
// dropping the legacy NOT NULL columns, and stamps the one-way rollback boundary
// via user_version. This is deliberately NOT on the ordinary open path — a DROP
// there would destroy schema an in-flight old peer still writes to.
//
// THE OPERATIONAL CONTRACT — the six points the `forge store converge` CLI surfaces
// to the operator (preview + confirmation) and that this function embodies. State
// them precisely; do NOT overclaim beyond them:
//
//   1. Running this ENDS the supported old/new overlap window for the store.
//   2. Before invoking it, the operator must STOP ALL forge processes using that
//      FORGE_HOME — launches, campaigns, dashboards, and interactive sessions. The
//      CLI's `--confirm-quiesced` flag is the operator ASSERTING they have done so.
//   3. The journal-mode quiesce gate (guarantee 2 below) detects active database
//      locks/snapshots and refuses convergence — but it is a BACKSTOP, not proof
//      that every forge process is dead. A perfectly idle old binary that holds no
//      lock cannot be observed here; the operator's quiescence (point 2) is what
//      actually makes the window safe to close.
//   4. A pre-FG-568 process that STARTS or RESUMES after convergence is OUTSIDE the
//      supported window. Its legacy usage inserts (which name the now-dropped legacy
//      columns) may fail ATOMICALLY — the write transaction rolls back whole, so one
//      or more telemetry captures are LOST until that process exits, but the store
//      is NEVER partially written or corrupted. Existing rows and integrity are
//      untouched by such a failed insert.
//   5. The forward schema-version gate (assertSchemaVersionSupported) CANNOT
//      constrain an ALREADY-INSTALLED ungated binary — a release predating the gate
//      never performs the check. This HONEST LIMIT (already stated on the gate)
//      applies here too and is preserved, not papered over.
//   6. This function/CLI asserts NO PID/process-liveness proof and NO automatic
//      exclusion of idle old binaries. There is no opener registry, maintenance
//      lease, or process-liveness probe on any store path (reverted by operator
//      decision — it cannot observe an already-deployed old binary, broadens every
//      open path, and adds stale-marker/PID-reuse failure modes). The tool
//      quiesce-gates and stamps a boundary; it claims nothing more.
//
// TWO integrity guarantees this function must hold, both proven by execution
// against real temp DBs in the integration test:
//
//  1. NO DOWNGRADE / ONE-WAY BOUNDARY (HIGH 2). Before touching any schema or
//     lock, it refuses a store whose stamped user_version is NEWER than the
//     boundary this binary would set (assertSchemaVersionSupported) — a store a
//     future binary already owns is not ours to converge, and we must never write
//     user_version backwards. Guard FIRST, fail fast, drop nothing.
//
//  2. READER-EXCLUDING QUIESCE (HIGH 1). BEGIN EXCLUSIVE in WAL mode takes only
//     the WRITER slot — in WAL a reader on an existing snapshot is NOT excluded,
//     so a plain BEGIN EXCLUSIVE could DROP COLUMN out from under an old reader
//     mid-query (SQLITE_SCHEMA / stale reads). SQLite semantics we rely on
//     instead: switching the journal OUT of WAL (PRAGMA journal_mode=DELETE)
//     requires SQLite to acquire an exclusive lock and fully checkpoint the WAL,
//     which it CANNOT do while ANY other connection — reader OR writer — holds the
//     database; the switch then leaves the mode as "wal" (or raises SQLITE_BUSY).
//     A successful switch to "delete" is therefore proof the store was quiescent
//     AT THAT INSTANT — but journal_mode=DELETE RELEASES its exclusive lock as it
//     returns, reopening a window in which a peer can BEGIN a rollback-journal
//     read. So the DROPs run under BEGIN EXCLUSIVE, not BEGIN IMMEDIATE: a plain
//     RESERVED lock would PERMIT such a reader to hold a schema snapshot while
//     DROP COLUMN runs, whereas EXCLUSIVE takes the reader-excluding lock up
//     front. If a peer grabbed the store in that handoff window, EXCLUSIVE cannot
//     be acquired (busy_timeout=0) and the migration FAILS CLOSED rather than
//     dropping under a live reader. WAL is restored before returning.
//
// The host-level two-version stress test (two real processes) is the
// orchestrator's; this function guarantees the single-process-provable half.
export function runDestructiveConvergenceMigration(
  db: DatabaseInstance,
  // Test seam only: invoked in the window AFTER the journal-mode quiesce and
  // BEFORE the reader-excluding lock, so a test can prove a reader attaching
  // there is fenced out (the HIGH-1 handoff race). Never passed in production.
  opts?: { onQuiescedBeforeDdl?: () => void },
): { dropped: string[]; boundaryVersion: number } {
  // HIGH 2 — refuse a store past this boundary BEFORE any schema or lock work.
  assertSchemaVersionSupported(db);

  const inMemory = db.name === ":memory:" || db.name === "";
  if (inMemory) {
    // No cross-process peer and no WAL journal on a single-connection :memory:
    // DB — a plain transaction is a sufficient quiesce.
    db.exec("BEGIN");
    try {
      const result = convergeLegacyModelCalls(db);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // LOW 3 — save the caller's busy_timeout and restore it on EVERY exit.
  const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma("busy_timeout = 0");
  let leftWal = false;
  try {
    let journalMode: unknown;
    try {
      journalMode = db.pragma("journal_mode = DELETE", { simple: true });
    } catch (e) {
      throw new Error(
        `forge: refusing the destructive convergence migration — the store is in use by ` +
          `another forge process (quiesce required). Underlying: ${(e as Error).message}`,
      );
    }
    if (journalMode !== "delete") {
      // Could not leave WAL — a peer (reader or writer) still holds the store.
      throw new Error(
        `forge: refusing the destructive convergence migration — the store is in use by ` +
          `another forge process (quiesce required): could not acquire exclusive access ` +
          `to leave WAL mode.`,
      );
    }
    leftWal = true;

    opts?.onQuiescedBeforeDdl?.();

    // READER-EXCLUDING lock (HIGH 1 handoff race). journal_mode=DELETE proved the
    // store quiescent only for the instant of the switch — it releases its
    // exclusive lock as it returns, so a peer can BEGIN a rollback-journal read
    // before we lock. BEGIN IMMEDIATE takes only a RESERVED lock, which PERMITS
    // that reader to hold a schema snapshot while DROP COLUMN runs. BEGIN
    // EXCLUSIVE takes the reader-excluding lock up front; if a peer grabbed a
    // SHARED lock in the handoff window it cannot be acquired (busy_timeout=0),
    // so the migration fails closed instead of dropping under a live reader.
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (e) {
      throw new Error(
        `forge: refusing the destructive convergence migration — the store is in use by ` +
          `another forge process (quiesce required): a reader attached before the ` +
          `reader-excluding lock could be taken. Underlying: ${(e as Error).message}`,
      );
    }
    try {
      const result = convergeLegacyModelCalls(db);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    // Best-effort WAL restore: a peer holding the store in the handoff window can
    // block the switch back; never let that mask the migration's own error — leave
    // the mode for the next open to re-establish.
    if (leftWal) {
      try {
        db.pragma("journal_mode = WAL");
      } catch {
        /* next open re-establishes WAL */
      }
    }
    db.pragma(`busy_timeout = ${priorBusyTimeout}`);
  }
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
  // FG-568: forward gate BEFORE we touch the schema — refuse a store a newer forge
  // has migrated past a one-way boundary we don't understand, rather than run our
  // (older) migrations against it. Read-only callers reach here too, via the
  // bootstrap open above, so they are gated identically.
  assertSchemaVersionSupported(db);
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

// FG-548: the ONE way to run a write transaction. BEGIN IMMEDIATE, always.
//
// A DEFERRED transaction (better-sqlite3's default) takes its read snapshot on
// the first statement and only tries to upgrade to a writer when the first
// write runs. Under multi-process WAL, if another process committed in that
// window the upgrade throws SQLITE_BUSY *immediately* — busy_timeout does not
// apply to a stale-snapshot upgrade, only to waiting for a held write lock.
// Taking the write lock up front means contention queues on busy_timeout
// instead of crashing whichever process happened to read first.
//
// Every read-modify-write transaction reachable from two forge processes must
// go through here. A pure-read transaction must NOT — taking the write lock to
// read is a pessimization, not a fix; read it without a transaction, or with a
// plain deferred one.
//
// On a single-connection :memory: DB there is nothing to contend with: SQLite
// treats BEGIN IMMEDIATE as BEGIN when no other connection exists, so test DBs
// see no behavior or performance change.
export function writeTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
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
