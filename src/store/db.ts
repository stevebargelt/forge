import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { DB_PATH, ensureForgeDirs } from "../util/paths.js";
import { SCHEMA_SQL } from "./schema.js";

let _db: DatabaseInstance | null = null;

export function getDb(): DatabaseInstance {
  if (_db) return _db;
  ensureForgeDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
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
  return db;
}
