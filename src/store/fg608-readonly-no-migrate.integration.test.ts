// FG-608 MANDATE 4: getDb({readOnly: true}) NEVER migrates and NEVER writes.
//
// Before FG-608 the read path was read-only in name only: it gated on
// existsSync(dbPath) and, with no writable handle cached, called getDb()
// transiently — which execs SCHEMA_SQL and applyMigrations. A "read" therefore
// CREATED ~/.forge/forge.db and wrote the whole schema into it. FORGE-DEC-012
// predicted this and left it unpaid.
//
// Integration tier: these tests use real on-disk databases and re-point
// FORGE_DB_PATH, because the whole property under test is what happens to a FILE.
// An in-memory seam would prove nothing.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDb, closeDb, StoreUnavailableError, SCHEMA_VERSION } from "./db.js";

let home: string;
let prevDbPath: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg608-ro-"));
  prevDbPath = process.env["FORGE_DB_PATH"];
  prevHome = process.env["FORGE_HOME"];
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (prevDbPath === undefined) delete process.env["FORGE_DB_PATH"];
  else process.env["FORGE_DB_PATH"] = prevDbPath;
  if (prevHome === undefined) delete process.env["FORGE_HOME"];
  else process.env["FORGE_HOME"] = prevHome;
  rmSync(home, { recursive: true, force: true });
});

// ─── POLICY HALF 1: absent DB -> REFUSE ──────────────────────────────────────
// Stated explicitly, not implied by the absence of writes: creating a database as
// a side effect of reading it is never right. The reader learns nothing (a fresh
// DB has no rows) and the host gains a file and a schema it never asked for.

test("FG-608 read-only: an ABSENT store is REFUSED, and no file is created", () => {
  const dbPath = join(home, "forge.db");
  assert.equal(existsSync(dbPath), false, "precondition: no store yet");

  assert.throws(
    () => getDb({ readOnly: true }),
    (e: unknown) => e instanceof StoreUnavailableError,
    "a read-only open against an absent store must REFUSE, not create one",
  );

  assert.equal(existsSync(dbPath), false, "the refused read created NO database file");
  // Not even the containing forge home was materialized by the read path:
  // ensureForgeDirs() is deliberately after the read-only return.
  assert.deepEqual(readdirSync(home), [], "the read path created no directories either");
});

test("FG-608 read-only: the refusal names the store path and is a typed error", () => {
  const err = (() => {
    try {
      getDb({ readOnly: true });
      return undefined;
    } catch (e) {
      return e as StoreUnavailableError;
    }
  })();
  assert.ok(err instanceof StoreUnavailableError);
  assert.equal(err.dbPath, join(home, "forge.db"));
  assert.match(err.message, /never creates or migrates/);
});

// ─── THE CORE REGRESSION: no schema exec, no migration application ───────────

test("FG-608 read-only: an UN-MIGRATED store is READ AS IS — no schema exec, no migration", () => {
  const dbPath = join(home, "forge.db");

  // Hand-shape a MINIMAL store: one table, nothing else. This is the shape an
  // older peer (or a foreign fixture) can legitimately present.
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE legacy_only (id TEXT PRIMARY KEY)`);
  seed.prepare(`INSERT INTO legacy_only (id) VALUES ('a')`).run();
  seed.close();

  const sizeBefore = statSync(dbPath).size;
  const mtimeBefore = statSync(dbPath).mtimeMs;

  const db = getDb({ readOnly: true });

  // POLICY HALF 2, asserted: it READS. The decided answer is not "refuse an
  // un-migrated store" — the open-path contract is additive-only, so an older
  // shape is a strict subset and refusing would break exactly the compatibility
  // that policy exists to preserve.
  assert.equal(
    (db.prepare(`SELECT id FROM legacy_only`).get() as { id: string }).id,
    "a",
    "an un-migrated store is readable, not refused",
  );

  // And it was NOT migrated: none of the tables SCHEMA_SQL would have created
  // exist, and none of the FG-608 columns were added.
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  ).map((t) => t.name);
  assert.deepEqual(tables, ["legacy_only"], "no schema was exec'd on the read path");

  assert.equal(db.readonly, true, "the handle itself is read-only");
  assert.equal(statSync(dbPath).size, sizeBefore, "the file was not grown");
  assert.equal(statSync(dbPath).mtimeMs, mtimeBefore, "the file was not modified");
});

test("FG-608 read-only: a write through the read-only handle is refused by SQLite itself", () => {
  const dbPath = join(home, "forge.db");
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  seed.close();

  const db = getDb({ readOnly: true });
  assert.throws(
    () => db.prepare(`INSERT INTO t (id) VALUES ('x')`).run(),
    /readonly/i,
    "the read-only handle cannot write even if a caller tries",
  );
});

test("FG-608 read-only: the forward schema-version gate still fires on a read", () => {
  const dbPath = join(home, "forge.db");
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  seed.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  seed.close();

  // A store a NEWER forge migrated past a one-way boundary is not ours to
  // interpret — read or not. The gate is a PRAGMA read, so it is safe here.
  assert.throws(() => getDb({ readOnly: true }), /schema version/);
});

// ─── the writable path is unchanged ──────────────────────────────────────────

test("FG-608: the WRITABLE path still creates and migrates (the read fix is scoped)", () => {
  const dbPath = join(home, "forge.db");
  assert.equal(existsSync(dbPath), false);

  const db = getDb();
  assert.equal(existsSync(dbPath), true, "a writable open still creates the store");
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (t) => t.name,
    ),
  );
  assert.ok(tables.has("tickets"), "schema was exec'd on the writable path");
  assert.ok(tables.has("ticket_source_membership"), "FG-608 additive tables land on the writable path");
  assert.ok(tables.has("backlog_snapshot_targets"));

  // And a read-only open AFTER the store exists works, against the same file.
  const ro = getDb({ readOnly: true });
  assert.equal(ro.readonly, true);
  assert.equal(ro.name, dbPath);
});

test("FG-608: SCHEMA_VERSION is unchanged and additive migrations leave user_version at 0", () => {
  const db = getDb();
  assert.equal(SCHEMA_VERSION, 1, "FG-608 is additive only — the one-way boundary did not move");
  assert.equal(
    db.pragma("user_version", { simple: true }),
    0,
    "a freshly created store still reads back user_version 0 (FG-568 forward-gate contract)",
  );
});
