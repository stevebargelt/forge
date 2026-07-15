// FG-568: end-to-end coverage for the operator-invoked `forge store converge`
// command — the non-test caller that makes runDestructiveConvergenceMigration
// reachable. Spawns the real CLI against a real legacy-shaped forge.db under a
// per-test FORGE_HOME, the way an operator actually runs it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-store-converge-home-"));
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

const LEGACY_MODEL_CALLS_DDL = `CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  alias TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost REAL NOT NULL
)`;

// Build a real forge.db still carrying the 0.1.x legacy model_calls columns,
// then close it (checkpointing WAL) so the spawned CLI is the only connection.
function seedLegacyStore(): string {
  const dbPath = join(forgeHome, "forge.db");
  const setup = new Database(dbPath);
  setup.exec(SCHEMA_SQL);
  setup.exec(`DROP TABLE model_calls`);
  setup.exec(LEGACY_MODEL_CALLS_DDL);
  setup.close();
  return dbPath;
}

function columnNames(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  const cols = new Set((db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[]).map((c) => c.name));
  db.close();
  return cols;
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const v = db.pragma("user_version", { simple: true }) as number;
  db.close();
  return v;
}

test("integ store converge: preview (no --confirm) reports legacy columns and drops nothing", () => {
  const dbPath = seedLegacyStore();

  const result = runForge(["store", "converge"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /preview/i, `stdout must mark itself a preview, got: ${result.stdout}`);
  assert.match(result.stdout, /prompt_tokens/, `preview must name the legacy columns, got: ${result.stdout}`);

  const cols = columnNames(dbPath);
  assert.ok(cols.has("prompt_tokens"), "preview must NOT drop the legacy columns");
  assert.equal(userVersion(dbPath), 0, "preview must NOT stamp the boundary");
});

test("integ store converge --json --confirm: drops legacy columns and stamps the one-way boundary", () => {
  const dbPath = seedLegacyStore();
  assert.ok(columnNames(dbPath).has("prompt_tokens"), "precondition: legacy column present");

  const result = runForge(["store", "converge", "--confirm", "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as { ok: boolean; dropped: string[]; boundaryVersion: number };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.dropped.sort(), ["completion_tokens", "cost", "prompt_tokens"]);
  assert.equal(parsed.boundaryVersion, 1);

  const cols = columnNames(dbPath);
  assert.ok(!cols.has("prompt_tokens") && !cols.has("completion_tokens") && !cols.has("cost"), "legacy columns dropped");
  assert.ok(cols.has("input_tokens"), "fresh columns survive");
  assert.equal(userVersion(dbPath), 1, "the one-way boundary is stamped");
});

test("integ store converge --confirm: idempotent second run drops nothing, boundary stays stamped", () => {
  const dbPath = seedLegacyStore();
  runForge(["store", "converge", "--confirm"]);

  const result = runForge(["store", "converge", "--confirm"]);
  assert.equal(result.status, 0, `expected exit 0\nstderr: ${result.stderr}`);
  assert.equal(userVersion(dbPath), 1, "boundary remains stamped, never downgraded");
});

test("integ store converge --confirm: on a fresh store (no legacy columns) drops nothing and still stamps", () => {
  // A fresh SCHEMA_SQL store never creates the legacy columns — converge is a
  // no-op drop but still records the boundary.
  const result = runForge(["store", "converge", "--confirm", "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { ok: boolean; dropped: string[]; boundaryVersion: number };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.dropped, []);
  assert.equal(parsed.boundaryVersion, 1);
  assert.equal(userVersion(join(forgeHome, "forge.db")), 1, "boundary stamped on a fresh store too");
});
