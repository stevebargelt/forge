import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolveDbPath, ensureForgeDirs } from "../util/paths.js";
import { SCHEMA_SQL, ADDITIVE_COLUMNS } from "./schema.js";

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

// Idempotent ALTERs for an existing DB whose tables predate a column added to
// SCHEMA_SQL. New DBs get the column from CREATE TABLE; existing DBs get it here.
// The column set is DATA (ADDITIVE_COLUMNS in schema.ts) so the two shapes cannot
// drift — see the invariant stated there, and fg608-migration-parity.test.ts,
// which proves the list is complete rather than remembered.
//
// Two guards, both load-bearing:
//   - the TABLE must exist. PRAGMA table_info on a missing table returns zero rows,
//     so an unguarded `!have.has(col)` would fire the ALTER and throw on EVERY open
//     against a foreign/minimal fixture DB (the dashboard read tests hand-shape one,
//     and several integration tests call applyMigrations on a legacy DDL directly).
//     That is the FG-563 hazard.
//   - the COLUMN must be absent, so the second run is a no-op.
//
// Exported as a test seam so migration behavior (e.g. #295 legacy-column drop) can
// be exercised against a hand-shaped DB.
export function applyMigrations(db: DatabaseInstance): void {
  const liveColumns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));

  const present = new Map<string, Set<string>>();
  for (const col of ADDITIVE_COLUMNS) {
    let have = present.get(col.table);
    if (!have) {
      have = liveColumns(col.table);
      present.set(col.table, have);
    }
    if (have.size === 0) continue; // table absent — nothing to bring forward
    if (have.has(col.column)) continue;
    db.exec(col.ddl);
    have.add(col.column);
  }

  const haveRuns = present.get("runs") ?? liveColumns("runs");
  // FG-563 (FIX A/FIX B, round 3): the dispatch-key discoverability index. It lives on
  // this guarded migration path (not the always-exec SCHEMA_SQL) for two reasons:
  //
  //   FIX A — RESILIENCE. The index is an expression index over
  //   json_extract(metadata, '$.dispatchKey'); on a `runs` table that has NO
  //   `metadata` column the CREATE INDEX throws SQLITE_ERROR. Because migrations run
  //   on EVERY open (read opens included, FG-568), a foreign/minimal runs fixture
  //   without that column would make every open fail. Guarding on the column's
  //   presence via PRAGMA table_info(runs) means a metadata-less open no longer
  //   throws; production `runs` always has `metadata`, so it is unaffected.
  //
  //   FIX B — EXACTLY-ONE-RUN-PER-RECEIPT. The index is UNIQUE (partial, over the
  //   non-null receipt), so a second physical run can never be inserted under a
  //   dispatch_key that already has one. The DB-level backstop behind the code-enforced
  //   unique controller owners (see resolveControllerOwner in continue.ts). NULL
  //   dispatchKeys (ordinary runs with no receipt) stay non-unique — SQLite's partial
  //   WHERE excludes them.
  //
  // Round 4 — SAFE CONVERGENCE. A bare `CREATE UNIQUE INDEX IF NOT EXISTS` keys on the
  // index NAME, so a DB that ALREADY carries a NON-unique index of this name (a stale dev
  // DB from an earlier build) silently keeps it — receipt uniqueness UNENFORCED. main is
  // born-unique (no shipped DB ever had the non-unique index), so this is dev-only, but we
  // close it properly with an atomic, duplicate-guarded convergence (NOT the round-2
  // machinery that bricked opens): in ONE BEGIN IMMEDIATE transaction — so concurrent opens
  // serialize on the write lock and never observe a window where the index is absent —
  //   (a) inspect index_list for idx_runs_dispatch_key;
  //   (b) if it exists and is NON-unique: if any duplicate non-null dispatchKey exists,
  //       SKIP (leave the non-unique index, do not brick the open); else DROP it and CREATE
  //       the UNIQUE version;
  //   (c) if it does not exist, CREATE UNIQUE INDEX IF NOT EXISTS.
  // Idempotent: a fresh DB is born unique in one step (case c); a stale non-unique dev DB
  // converges atomically (case b, no dups); a (dev-only) duplicate DB is left usable, never
  // bricked (case b/c, dups → skip). Behind the PRAGMA table_info(runs) metadata-column
  // guard so a metadata-less runs table (dashboard fixtures) never throws.
  if (haveRuns.has("metadata")) {
    const hasDuplicateReceipt = (): boolean =>
      db
        .prepare(
          `SELECT 1 FROM runs
             WHERE json_extract(metadata, '$.dispatchKey') IS NOT NULL
             GROUP BY json_extract(metadata, '$.dispatchKey')
            HAVING COUNT(*) > 1
             LIMIT 1`,
        )
        .get() !== undefined;

    const createUnique = (): void => {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_key
           ON runs(json_extract(metadata, '$.dispatchKey'))
           WHERE json_extract(metadata, '$.dispatchKey') IS NOT NULL`,
      );
    };

    db.transaction(() => {
      const existing = (
        db.prepare(`PRAGMA index_list(runs)`).all() as { name: string; unique: number }[]
      ).find((i) => i.name === "idx_runs_dispatch_key");

      if (existing) {
        if (existing.unique === 1) return; // already unique — nothing to converge
        // A NON-unique index of this name is present (stale dev DB). Converge only if it
        // is SAFE: a live duplicate would make the DROP+CREATE UNIQUE throw and, since
        // migrations run on EVERY open, brick every subsequent open. Leave it usable.
        if (hasDuplicateReceipt()) return;
        db.exec(`DROP INDEX idx_runs_dispatch_key`);
        createUnique();
        return;
      }
      // No index yet. Create born-unique — unless a raw duplicate already exists (a stale
      // dev DB that inserted before any index), in which case skip to avoid a throw.
      if (hasDuplicateReceipt()) return;
      createUnique();
    }).immediate();
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

  // #295 / FG-568: the 0.1.x legacy columns (prompt_tokens/completion_tokens/cost)
  // are NO LONGER dropped here. A DROP on the ordinary open path is destructive
  // DDL that would remove schema an in-flight version-A peer still depends on — so
  // it moved OFF this additive-only path into runDestructiveConvergenceMigration
  // (explicit, operator-invoked, quiesce-gated). A migrated DB that still carries
  // the legacy NOT NULL columns keeps working for old writers AND for current
  // inserts — insertUsageRows is dual-shape and fills the legacy columns with 0/0/0
  // when present. Converging it to the fresh shape (dropping the dead columns) is
  // that migration's job, not this one's. See LEGACY_MODEL_CALLS_COLUMNS.
  // Created indexes (created_at index too — used by --since time filters). The
  // task_id index is here rather than in SCHEMA_SQL because model_calls.task_id can
  // arrive by ALTER above; unconditional so a fresh DB and a migrated one carry the
  // same indexes, not just the same columns.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_task ON model_calls(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_request ON model_calls(request_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at)`);
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
let _generation = 0;

// A CLOSED handle is not a connection. better-sqlite3 keeps the object alive
// after close() and throws "The database connection is not open" on first use,
// so a cached-but-closed handle is a landmine that only detonates at the call
// site. It used to be harmless — whoever closed the DB was the only one reaching
// for it. Since FG-607, reading a ticket resolves a storage mode, so ANY reader
// sits downstream of these handles, including one that legitimately closed the
// DB (a simulated restart, a swap between stores). Treat closed as absent
// everywhere, so the next getDb() reopens and a reopen is transparent.
function forgetClosedHandles(): void {
  if (_dbRW && !_dbRW.open) {
    _dbRW = null;
    _generation++;
  }
  if (_dbRO && !_dbRO.open) {
    _dbRO = null;
    _generation++;
  }
}

// Bumped whenever the process stops pointing at a connection it previously
// served (closed, forgotten, or swapped by a test). Anything memoizing an answer
// DERIVED from the store — see resolveBacklogStore — records the generation it
// was computed under, so a resolution can never outlive the connection that
// produced it.
export function dbGeneration(): number {
  forgetClosedHandles();
  return _generation;
}

// Is there a store to consult at all? True once a handle is open (including the
// in-memory test seam) or a forge.db exists on disk. Lets a pure reader skip the
// open on a host that has never run forge — where no row it could ask about can
// exist anyway, and where getDb() would CREATE the file just to find nothing.
export function storeExists(): boolean {
  forgetClosedHandles();
  return _dbRW !== null || _dbRO !== null || existsSync(resolveDbPath());
}

// FG-608 (MANDATE 4): a read-only consumer asked for a store that is not there.
// Named so a caller that legitimately tolerates "no store yet" can branch on it
// (storeExists() is the cheap pre-check) instead of pattern-matching a message.
export class StoreUnavailableError extends Error {
  constructor(
    message: string,
    readonly dbPath: string,
  ) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

// FG-608 (MANDATE 4): the READ-ONLY policy, decided and stated — not implied.
//
// Before this, `getDb({readOnly: true})` was read-only in name only: it gated
// wantReadOnly on existsSync(dbPath) and, with no writable handle cached, called
// getDb() transiently first — which execs SCHEMA_SQL and applyMigrations
// (db.ts's writable branch below). A "read" therefore CREATED ~/.forge/forge.db,
// wrote the whole schema into it, and ran every migration. FORGE-DEC-012
// predicted this and left it unpaid; FG-608 pays it, because the container read
// surface and the dashboard are both pure readers that must never mutate a store.
//
// THE POLICY, in two halves:
//
//   ABSENT DB      -> REFUSE (StoreUnavailableError). Creating a database as a
//                     side effect of reading it is never right: the reader learns
//                     nothing (a fresh DB has no rows) and the host gains a file
//                     and a full schema it never asked for. Callers that tolerate
//                     "no store on this host" call storeExists() first — that is
//                     what it is for.
//
//   UN-MIGRATED DB -> READ IT AS-IS. No schema exec, no migration. The open-path
//                     contract is additive-only (FG-568/BD-15), so an older shape
//                     is a strict SUBSET of the current one: every column a reader
//                     asks for either exists or genuinely never existed. A query
//                     against a table this binary knows but the file lacks raises
//                     an ordinary SQLite error AT THE QUERY, which names the
//                     missing table — strictly more honest than silently migrating
//                     a store the reader has no authority over. Refusing instead
//                     would be worse: it would make every read of a store written
//                     by an older peer fail, which is exactly the compatibility the
//                     additive-only policy exists to preserve.
function openReadOnly(dbPath: string): DatabaseInstance {
  if (!existsSync(dbPath)) {
    throw new StoreUnavailableError(
      `forge: refusing a read-only open — no store exists at ${dbPath}. A read never creates or ` +
        `migrates the store; run a forge command that writes (e.g. \`forge backlog import\`) to ` +
        `create it, or call storeExists() first if "no store yet" is a normal outcome here.`,
      dbPath,
    );
  }
  // NOTHING between here and the return may write: no SCHEMA_SQL, no
  // applyMigrations, no journal_mode pragma (switching journal mode WRITES the
  // database header and would fail on a genuinely read-only file anyway).
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  // The forward gate is a PRAGMA READ (user_version) — safe on a read-only handle,
  // and a store a newer forge migrated past a one-way boundary is not one this
  // binary may interpret, read or not.
  assertSchemaVersionSupported(db);
  return db;
}

export function getDb(opts?: { readOnly?: boolean }): DatabaseInstance {
  forgetClosedHandles();
  // Resolved per call, not from paths.ts's import-time snapshot: since FG-607
  // `@forge/backlog` drags this module into the import graph, so it can be
  // evaluated before a host has set FORGE_HOME (see resolveDbPath's note).
  // Opening the wrong host's forge.db is a data-correctness failure, not a
  // cosmetic one. The handle caches below are unaffected — an OPEN handle stays
  // the store for this process; closing it is how you re-point.
  const dbPath = resolveDbPath();

  // FG-608: the read path returns BEFORE ensureForgeDirs() — creating ~/.forge as
  // a side effect of reading is the same class of mutation as creating forge.db.
  if (opts?.readOnly === true) {
    if (_dbRO) return _dbRO;
    // Deliberately NOT `if (!_dbRW) getDb()`. That bootstrap was the whole bug:
    // it ran SCHEMA_SQL + applyMigrations from a read. A cached writable handle is
    // reused (same file, already open) only because it exists — never opened for
    // this purpose.
    const db = openReadOnly(dbPath);
    _dbRO = db;
    return db;
  }

  ensureForgeDirs();
  if (_dbRW) return _dbRW;
  const db = new Database(dbPath);
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
  // FG-608: the snapshot publish barrier. Ticket writers mark their project_key
  // dirty inside the transaction; the fan-out runs HERE, after the commit, never
  // inside it — file I/O under the write lock would stall every other forge
  // process, and publishing mid-transaction could ship rows that then roll back.
  // A rollback discards the pending set (nothing durable, nothing to publish).
  //
  // Imported lazily: src/backlog/snapshot.ts imports getDb from this module, and a
  // top-level import here would close that cycle at module-eval time.
  const { beginPublishBarrier, endPublishBarrier } = publishBarrier();
  beginPublishBarrier();
  let committed = false;
  try {
    const result = getDb().transaction(fn).immediate();
    committed = true;
    return result;
  } finally {
    endPublishBarrier(committed);
  }
}

// Resolved on first use so the module cycle (snapshot.ts -> db.ts) is broken at
// eval time rather than at import time. `require` is unavailable under ESM, so the
// binding is installed by snapshot.ts's own consumers via registerPublishBarrier;
// until then this is an inert no-op and writeTransaction behaves exactly as before.
type PublishBarrier = {
  beginPublishBarrier: () => void;
  endPublishBarrier: (committed: boolean) => void;
};
const NO_BARRIER: PublishBarrier = { beginPublishBarrier: () => {}, endPublishBarrier: () => {} };
let _publishBarrier: PublishBarrier = NO_BARRIER;

/** Installed once by src/store/tickets.ts (which imports snapshot.ts). Keeps the
 *  publisher the OWNER of publication while letting writeTransaction — the single
 *  host write path — decide WHEN the fan-out runs. */
export function registerPublishBarrier(barrier: PublishBarrier): void {
  _publishBarrier = barrier;
}

function publishBarrier(): PublishBarrier {
  return _publishBarrier;
}

export function closeDb(): void {
  if (_dbRW) { _dbRW.close(); _dbRW = null; _generation++; }
  if (_dbRO) { _dbRO.close(); _dbRO = null; _generation++; }
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
  _generation++;
  return prev;
}

export function makeInMemoryDb(): DatabaseInstance {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}
