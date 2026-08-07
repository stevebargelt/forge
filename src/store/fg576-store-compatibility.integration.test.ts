// FG-576 step 1 — the orchestrator receipt table against the store-compatibility
// policy (FG-568/BD-15), proven by EXECUTION against real SQLite files rather than
// by asserting on source patterns (the FG-551 rule).
//
// "Two forge versions" is simulated the way fg568-store-compatibility.integration.test.ts
// simulates it: real separate opens of ONE real file, where version A is a binary
// that PREDATES orchestrator_receipts (its store simply does not carry the table and
// its code never names it) and version B is this binary's real open path — the exact
// getDb() writable sequence: forward gate, SCHEMA_SQL, applyMigrations.
//
// Four properties:
//   C1  a pre-FG-576 store opens, gains the table additively, and every pre-existing
//       row is unchanged. No DROP, no RENAME, no user_version bump.
//   C2  version A is STILL RUNNING against the migrated store: it keeps reading and
//       writing its own tables and is unaffected by a table it knows nothing about.
//   C3  a Codex receipt read back through the GENERIC columns reports provider
//       'openai' — never 'anthropic'. The two providers are discriminated by a real
//       recorded column, not by a default a reader supplies.
//   C4  a store whose orchestrator_receipts predates the fail-closed trust columns
//       is brought forward by ADDITIVE_COLUMNS, and its pre-existing rows read back
//       'unknown'/'unproven' — never as an asserted identity or an accepted carrier
//       nothing proved (AC8/AC9).
//
// Every DB here lives under the per-process temp FORGE_HOME the harness installs
// (src/test-setup.ts) — never the operator's ~/.forge/forge.db (AC13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations, assertSchemaVersionSupported, setDbForTest, closeDb, SCHEMA_VERSION } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  persistPendingOrchestratorReceipt,
  getOrchestratorReceipt,
  markOrchestratorReceiptRunning,
  type OrchestratorLaunchDecision,
} from "./orchestrator-receipts.js";

function tempDb(name: string): string {
  return join(FORGE_HOME, name);
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined
  );
}

/** A "NEW binary" open: exactly getDb()'s writable path. */
function openAsNewBinary(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** A "version A" store: this binary's schema with orchestrator_receipts removed —
 *  i.e. exactly what a pre-FG-576 forge creates. Seeds a run so C1 has a
 *  pre-existing row to protect. */
function buildPreFg576Store(path: string): void {
  const a = new Database(path);
  a.pragma("journal_mode = WAL");
  a.exec(SCHEMA_SQL);
  a.exec(`DROP TABLE orchestrator_receipts`);
  assert.equal(tableExists(a, "orchestrator_receipts"), false, "precondition: version A carries no receipt table");
  a.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "run-pre-fg576",
    "feature",
    "written by a pre-FG-576 binary",
    "active",
    "2026-08-01T00:00:00Z",
    "/tmp/proj",
  );
  a.close();
}

/** Version A's code: it names ONLY the columns it has, and never the new table. */
function versionAInsertRun(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    "feature",
    `title ${id}`,
    "active",
    "2026-08-02T00:00:00Z",
  );
}

const CODEX_DECISION: OrchestratorLaunchDecision = {
  receiptId: "orx-compat-codex",
  sessionKey: "codex-session-key",
  projectDir: "/tmp/proj",
  projectName: "proj",
  resolvedProfile: "codex-subscription",
  runtime: "codex-cli",
  provider: "openai",
  model: "gpt-5-codex",
  authMode: "openai-subscription",
  resolvedBy: "policy:overrides.agents.orchestrator",
  adapter: "codex",
  sessionOperation: "new",
  identityStrength: "correlated",
  identityBasis: "post-spawn correlation",
  carrier: { generation: "gen-1", path: "/forge/gen-1/codex/orchestrator-instructions.md", acceptance: "accepted" },
  limitations: [{ capability: "usage_capture", note: "no equivalent usage evidence" }],
};

const CLAUDE_DECISION: OrchestratorLaunchDecision = {
  receiptId: "orx-compat-claude",
  sessionKey: "claude-session-key",
  projectDir: "/tmp/proj",
  projectName: "proj",
  resolvedProfile: "claude-subscription",
  runtime: "claude-code",
  provider: "anthropic",
  model: "claude-opus-5",
  authMode: "anthropic-oauth",
  resolvedBy: "policy:defaults.profile",
  adapter: "claude",
  sessionOperation: "new",
  identityStrength: "asserted",
};

// ===========================================================================
// C1 + C2 — a pre-FG-576 store migrates additively, and version A keeps working.
// ===========================================================================
test("C1/C2: a pre-FG-576 store gains orchestrator_receipts additively; its rows and its old binary are unharmed", () => {
  const path = tempDb("fg576-c1-pre-existing.db");
  buildPreFg576Store(path);

  const before = new Database(path);
  assert.equal(before.pragma("user_version", { simple: true }), 0, "precondition: the version-A store is user_version 0");
  const preExisting = before.prepare(`SELECT id, title, project_dir FROM runs`).all();
  before.close();

  // --- Version B (this binary) opens the SAME file. ---
  const b = openAsNewBinary(path);
  assert.ok(tableExists(b, "orchestrator_receipts"), "the ordinary open path creates the table additively");
  assert.equal(
    b.pragma("user_version", { simple: true }),
    0,
    "an additive table NEVER bumps the one-way boundary — an older peer must keep opening this store",
  );
  assert.deepEqual(
    b.prepare(`SELECT id, title, project_dir FROM runs`).all(),
    preExisting,
    "every pre-existing row is byte-identical after the migration",
  );

  // The table is EMPTY: creating it invents no receipt for the sessions that ran
  // before FG-576 (the ticket's "no retrofitting historical rows" non-goal).
  assert.equal(
    (b.prepare(`SELECT COUNT(*) AS n FROM orchestrator_receipts`).get() as { n: number }).n,
    0,
    "the new table starts empty — no historical orchestrator row is invented",
  );

  // Version B writes a receipt through the REAL accessors against this real file.
  const restore = setDbForTest(b);
  try {
    persistPendingOrchestratorReceipt(CODEX_DECISION);
    markOrchestratorReceiptRunning("orx-compat-codex", { launcherPid: 999, launcherIdentity: "boot:999:1" });
  } finally {
    if (restore) setDbForTest(restore);
  }
  b.close();

  // --- C2: version A is STILL RUNNING against the now-migrated store. ---
  const a2 = new Database(path);
  a2.pragma("journal_mode = WAL");
  assert.doesNotThrow(
    () => versionAInsertRun(a2, "run-A-after-migration"),
    "an in-flight pre-FG-576 writer is not broken by a table it knows nothing about",
  );
  assert.deepEqual(
    (a2.prepare(`SELECT id FROM runs ORDER BY id`).all() as { id: string }[]).map((r) => r.id),
    ["run-A-after-migration", "run-pre-fg576"],
    "the old reader still sees every row through its own column set",
  );
  a2.close();
});

// ===========================================================================
// C3 — the provider column discriminates. A generic reader never reads a Codex
// receipt as a Claude one.
// ===========================================================================
test("C3: a Codex receipt read through the GENERIC columns reports provider 'openai' — never 'anthropic'", () => {
  const path = tempDb("fg576-c3-provider.db");
  const writer = openAsNewBinary(path);
  const restore = setDbForTest(writer);
  try {
    persistPendingOrchestratorReceipt(CODEX_DECISION);
    persistPendingOrchestratorReceipt(CLAUDE_DECISION);
    // The decoded read is honest too — both providers survive their own round trip.
    assert.equal(getOrchestratorReceipt("orx-compat-codex")?.provider, "openai");
    assert.equal(getOrchestratorReceipt("orx-compat-claude")?.provider, "anthropic");
  } finally {
    if (restore) setDbForTest(restore);
  }
  writer.close();

  // A DIFFERENT reader, on its own connection, selecting only the generic columns a
  // peer that knows nothing of adapters would name. No forge code in the path.
  const reader = new Database(path, { readonly: true });
  const rows = reader
    .prepare(`SELECT receipt_id, state, provider, runtime, adapter, project_dir FROM orchestrator_receipts ORDER BY receipt_id`)
    .all() as { receipt_id: string; provider: string; runtime: string; adapter: string }[];
  reader.close();

  assert.deepEqual(
    rows,
    [
      {
        receipt_id: "orx-compat-claude",
        state: "pending",
        provider: "anthropic",
        runtime: "claude-code",
        adapter: "claude",
        project_dir: "/tmp/proj",
      },
      {
        receipt_id: "orx-compat-codex",
        state: "pending",
        provider: "openai",
        runtime: "codex-cli",
        adapter: "codex",
        project_dir: "/tmp/proj",
      },
    ] as unknown as typeof rows,
    "provider/runtime/adapter are recorded columns — a generic reader gets the truth without knowing either adapter",
  );

  const codex = rows.find((r) => r.receipt_id === "orx-compat-codex");
  assert.notEqual(codex?.provider, "anthropic", "the Codex receipt is NEVER readable as an Anthropic one");
});

// ===========================================================================
// C4 — an orchestrator_receipts that predates the fail-closed trust columns is
// brought forward, and its old rows read DOWN, not up.
// ===========================================================================
test("C4: an older receipt shape migrates additively and its rows read 'unknown'/'unproven', never asserted/accepted", () => {
  const path = tempDb("fg576-c4-older-receipt-shape.db");

  // A store whose orchestrator_receipts predates the trust columns — built by
  // stripping them, the same way fg608-migration-parity builds its oldest shape.
  const old = new Database(path);
  old.pragma("journal_mode = WAL");
  old.exec(SCHEMA_SQL);
  for (const col of ["identity_strength", "carrier_acceptance", "carrier_evidence", "limitations"]) {
    old.exec(`ALTER TABLE orchestrator_receipts DROP COLUMN ${col}`);
  }
  const stripped = columnNames(old, "orchestrator_receipts");
  assert.equal(stripped.has("identity_strength"), false, "precondition: the old shape lacks identity_strength");
  assert.equal(stripped.has("carrier_acceptance"), false, "precondition: the old shape lacks carrier_acceptance");
  // An old-shape writer records what it had: provider, runtime, adapter, state.
  old
    .prepare(
      `INSERT INTO orchestrator_receipts
         (receipt_id, session_key, state, created_at, updated_at, project_dir, runtime, provider, adapter, session_operation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "orx-old-shape",
      "old-session",
      "running",
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "/tmp/proj",
      "codex-cli",
      "openai",
      "codex",
      "new",
    );
  old.close();

  // This binary opens it: ADDITIVE_COLUMNS restores the stripped columns.
  const b = openAsNewBinary(path);
  const brought = columnNames(b, "orchestrator_receipts");
  for (const col of ["identity_strength", "carrier_acceptance", "carrier_evidence", "limitations"]) {
    assert.ok(brought.has(col), `${col} must be restored by the additive migration`);
  }
  assert.equal(b.pragma("user_version", { simple: true }), 0, "the column migration crosses no one-way boundary");

  const restore = setDbForTest(b);
  try {
    const read = getOrchestratorReceipt("orx-old-shape");
    assert.ok(read, "the pre-existing row survives the migration");
    assert.equal(read.provider, "openai", "and it is still a Codex receipt, not an Anthropic one");
    assert.equal(read.runtime, "codex-cli");
    assert.equal(read.state, "running", "the old writer's lifecycle state is preserved verbatim");
    assert.equal(
      read.identityStrength,
      "unknown",
      "AC9: a row that predates the column reads as unknown — never as an asserted session identity",
    );
    assert.equal(
      read.carrier.acceptance,
      "unproven",
      "AC8: a row that predates the column reads as unproven — never as an accepted instruction carrier",
    );
    assert.deepEqual(read.limitations, [], "a null limitations blob is no recorded limitation, not a fabricated one");
  } finally {
    if (restore) setDbForTest(restore);
  }
  b.close();
  closeDb();
});
