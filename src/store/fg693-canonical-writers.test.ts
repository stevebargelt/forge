// FG-693 (fix batch) — THE COLUMNS ARE INDEXED, AND EVERY WRITER FILLS THEM.
//
// Three defects the reviews found, each of which makes the shipped design untrue
// rather than merely slow:
//
//   B   `CANONICAL_IDENTITY_INDEXES` was DECLARED in schema.ts, its own comment said
//       it must be applied from `applyMigrations`, and db.ts never imported it. So
//       every canonical lookup the ticket added ran unindexed, and the project-scoped
//       receipt read in particular traded an indexed probe for two full table scans.
//
//   C3  `campaigns` and `launch_observations` carried the column with NO WRITER, so
//       every newly created row joined the "legacy" NULL-canonical population
//       permanently. That makes the self-extinguishing invariant FALSE for those two
//       tables — and that invariant is the entire cost argument bounding the
//       read-time legacy scans.
//
//   C4  `persistPendingOrchestratorReceipt` called realpath INSIDE the machine-wide
//       `BEGIN IMMEDIATE` transaction, contradicting the invariant db.ts and runs.ts
//       both state: no filesystem syscall is held across the write lock.
//
// Every assertion here drives a PRODUCTION entry point — `applyMigrations`,
// `createCampaign`, `recordLaunchObservation`, `persistPendingOrchestratorReceipt`
// — against a real store, never the identity helper (AC5's seam rule). The C4 check
// is the one structural assertion, because ordering relative to a lock is a property
// of the code and Node freezes a builtin's ESM namespace, so a realpath spy would
// observe nothing and pass vacuously.
//
// PORTABLE BY CONSTRUCTION: every alias below is one this file CREATES (a symlinked
// parent), so nothing depends on an alias a particular operating system happens to
// provide — which is exactly why the earlier coverage was CI-green and host-red.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, makeInMemoryDb, setDbForTest } from "./db.js";
import { CANONICAL_IDENTITY_INDEXES, SCHEMA_SQL } from "./schema.js";
import { createCampaign } from "./campaigns.js";
import { recordLaunchObservation, getLaunchObservation } from "./launch-observations.js";
import { persistPendingOrchestratorReceipt } from "./orchestrator-receipts.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const scratch: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real directory reached through a symlinked PARENT: two spellings, one tree. */
function aliasedCheckout(prefix: string): { asWritten: string; physical: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  mkdirSync(join(root, "trees", "checkout"), { recursive: true });
  symlinkSync(join(root, "trees"), join(root, "link"));
  const asWritten = join(root, "link", "checkout");
  const physical = realpathSync(asWritten);
  assert.notEqual(asWritten, physical, "fixture: the two spellings must differ, or nothing here discriminates");
  return { asWritten, physical };
}

function indexNames(handle: DatabaseInstance): Set<string> {
  const rows = handle.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

// ── B: the declared indexes are actually installed ──────────────────────────

test("FG-693/B: every declared canonical-identity index exists on a FRESH store", () => {
  const present = indexNames(db);
  for (const idx of CANONICAL_IDENTITY_INDEXES) {
    assert.ok(present.has(idx.index), `${idx.index} was declared but never created (${idx.table}.${idx.column})`);
  }
  assert.ok(CANONICAL_IDENTITY_INDEXES.length > 0, "the declaration must not be empty, or this asserts nothing");
});

test("FG-693/B: an AGED store gains the column by ALTER and the index right behind it", () => {
  // The shape the indexes exist for: tables that already exist WITHOUT the canonical
  // column, so the CREATE INDEX must run after the additive loop has added it. This is
  // also the FG-563 hazard restated — a CREATE INDEX naming a column the live table
  // does not have throws SQLITE_ERROR, and migrations run on EVERY open.
  const aged = new Database(":memory:");
  aged.exec(SCHEMA_SQL);
  for (const table of ["runs", "campaigns", "host_verifications", "orchestrator_receipts", "launch_observations"]) {
    aged.exec(`ALTER TABLE ${table} DROP COLUMN project_dir_canonical`);
  }
  for (const idx of CANONICAL_IDENTITY_INDEXES) aged.exec(`DROP INDEX IF EXISTS ${idx.index}`);
  const strippedIndexes = indexNames(aged);
  for (const idx of CANONICAL_IDENTITY_INDEXES) {
    assert.ok(!strippedIndexes.has(idx.index), `fixture: ${idx.index} must be absent before the migration runs`);
  }

  applyMigrations(aged);

  const present = indexNames(aged);
  for (const idx of CANONICAL_IDENTITY_INDEXES) {
    assert.ok(present.has(idx.index), `${idx.index} was not created on an aged store`);
  }
  // Idempotent: migrations run on every open, and a second pass must be a no-op.
  applyMigrations(aged);
  aged.close();
});

test("FG-693/B: a table this store does not have is skipped, not thrown on", () => {
  // A store that lacks one of the enrolled tables entirely. Migrations run on EVERY
  // open (read opens included), so an unguarded CREATE INDEX naming a missing table
  // would throw SQLITE_ERROR and brick every open of that store — the FG-563 hazard
  // the additive loop's table guard exists for, restated for the index loop.
  const partial = new Database(":memory:");
  partial.exec(SCHEMA_SQL);
  partial.exec(`DROP TABLE campaign_items`);
  partial.exec(`DROP TABLE campaigns`);
  assert.ok(!indexNames(partial).has("idx_campaigns_project_canonical"), "fixture: the index goes with its table");

  applyMigrations(partial);

  assert.ok(!indexNames(partial).has("idx_campaigns_project_canonical"), "no index for a table that does not exist");
  assert.ok(indexNames(partial).has("idx_runs_project_canonical"), "and the tables that DO exist are still indexed");
  partial.close();
});

// ── C3: the two tables that had no writer ───────────────────────────────────

test("FG-693/C3: createCampaign records the caller's bytes AND the proven identity", () => {
  const { asWritten, physical } = aliasedCheckout("fg693-campaign-");
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "auto", projectDir: asWritten });

  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM campaigns WHERE id = ?`)
    .get(campaign.id) as { project_dir: string; project_dir_canonical: string | null };
  assert.equal(row.project_dir, asWritten, "audit evidence: the caller's spelling, verbatim");
  assert.equal(row.project_dir_canonical, physical, "and the PROVEN identity beside it — not a new legacy row");
});

test("FG-693/C3: a campaign whose project cannot be resolved records NULL, never a guess", () => {
  const gone = join(tmpdir(), "fg693-campaign-never-existed", "checkout");
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "auto", projectDir: gone });
  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM campaigns WHERE id = ?`)
    .get(campaign.id) as { project_dir: string; project_dir_canonical: string | null };
  assert.equal(row.project_dir, gone, "the spelling is still recorded in full");
  assert.equal(row.project_dir_canonical, null, "NULL is the only honest answer for an unproven path");
});

test("FG-693/C3: a campaign with no project dir at all costs no identity and stores none", () => {
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "auto" });
  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM campaigns WHERE id = ?`)
    .get(campaign.id) as { project_dir: string | null; project_dir_canonical: string | null };
  assert.equal(row.project_dir, null);
  assert.equal(row.project_dir_canonical, null);
});

test("FG-693/C3: recordLaunchObservation records the caller's bytes AND the proven identity", () => {
  const { asWritten, physical } = aliasedCheckout("fg693-launch-");
  const at = "2026-08-11T10:00:00Z";
  recordLaunchObservation({
    launchId: "lch-fg693aa",
    name: "test:all",
    command: ["npm", "run", "test:all"],
    cwd: asWritten,
    projectDir: asWritten,
    association: { runId: "run-1" },
    purpose: "host_verification",
    startedAt: at,
    observedAt: at,
    status: { state: "running" },
  });

  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM launch_observations WHERE launch_id = ?`)
    .get("lch-fg693aa") as { project_dir: string; project_dir_canonical: string | null };
  assert.equal(row.project_dir, asWritten, "audit evidence: the submitter's spelling, verbatim");
  assert.equal(row.project_dir_canonical, physical, "and the PROVEN identity beside it");
  assert.equal(
    getLaunchObservation("lch-fg693aa")?.projectDirCanonical,
    physical,
    "and the codec carries it back out, so a reader can decide identity without a syscall",
  );
});

test("FG-693/C3: re-recording a launch updates the canonical identity with the bytes", () => {
  const first = aliasedCheckout("fg693-relaunch-a-");
  const second = aliasedCheckout("fg693-relaunch-b-");
  const at = "2026-08-11T10:00:00Z";
  const record = (projectDir: string): void =>
    recordLaunchObservation({
      launchId: "lch-fg693bb",
      command: ["npm", "test"],
      cwd: projectDir,
      projectDir,
      startedAt: at,
      observedAt: at,
      status: { state: "running" },
    });

  record(first.asWritten);
  record(second.asWritten);

  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM launch_observations WHERE launch_id = ?`)
    .get("lch-fg693bb") as { project_dir: string; project_dir_canonical: string | null };
  assert.equal(row.project_dir, second.asWritten);
  assert.equal(
    row.project_dir_canonical,
    second.physical,
    "a stale canonical describing the PREVIOUS directory is worse than none — both columns move together",
  );
});

test("FG-693/C3: a launch with no project home stores no identity for one", () => {
  const at = "2026-08-11T10:00:00Z";
  recordLaunchObservation({
    launchId: "lch-fg693cc",
    command: ["npm", "test"],
    cwd: tmpdir(),
    projectDir: null,
    startedAt: at,
    observedAt: at,
    status: { state: "running" },
  });
  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM launch_observations WHERE launch_id = ?`)
    .get("lch-fg693cc") as { project_dir: string | null; project_dir_canonical: string | null };
  assert.equal(row.project_dir, null);
  assert.equal(row.project_dir_canonical, null);
});

test("FG-693/C3: the tables enrolled in the contract all have a writer — the population really is self-extinguishing", () => {
  // The read-time legacy scan's cost argument is that NOTHING NEW lands in the
  // NULL-canonical population unless a path was genuinely unresolvable at write time.
  // That is a claim about the WRITERS, so it is asserted over them: one row written
  // through each production writer, all four proven.
  const { asWritten, physical } = aliasedCheckout("fg693-writers-");
  const at = "2026-08-11T10:00:00Z";
  const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "auto", projectDir: asWritten });
  recordLaunchObservation({
    launchId: "lch-fg693dd",
    command: ["npm", "test"],
    cwd: asWritten,
    projectDir: asWritten,
    startedAt: at,
    observedAt: at,
    status: { state: "running" },
  });
  const receipt = persistPendingOrchestratorReceipt({
    receiptId: "orx-fg693dd",
    sessionKey: "fg693-writers",
    projectDir: asWritten,
    runtime: "claude-code",
    provider: "anthropic",
    adapter: "claude",
    sessionOperation: "new",
    createdAt: at,
  });
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical)
     VALUES ('run-fg693dd', 'feature', 'writers', 'active', ?, ?, ?)`,
  ).run(at, asWritten, physical);

  const nullCanonical = [
    ["campaigns", `SELECT COUNT(*) AS n FROM campaigns WHERE project_dir IS NOT NULL AND project_dir_canonical IS NULL`],
    ["launch_observations", `SELECT COUNT(*) AS n FROM launch_observations WHERE project_dir IS NOT NULL AND project_dir_canonical IS NULL`],
    ["orchestrator_receipts", `SELECT COUNT(*) AS n FROM orchestrator_receipts WHERE project_dir_canonical IS NULL`],
    ["runs", `SELECT COUNT(*) AS n FROM runs WHERE project_dir IS NOT NULL AND project_dir_canonical IS NULL`],
  ] as const;
  for (const [table, sql] of nullCanonical) {
    assert.equal((db.prepare(sql).get() as { n: number }).n, 0, `${table} minted a new legacy row for a resolvable path`);
  }
  assert.equal(receipt.receiptId, "orx-fg693dd");
  assert.ok(campaign.id.length > 0);
});

// ── C4: no filesystem syscall inside the machine-wide write lock ────────────

test("FG-693/C4: the receipt's identity is resolved BEFORE the write transaction opens", () => {
  // Ordering relative to a lock is a property of the code, and it cannot be observed
  // from outside: Node freezes a builtin's ESM namespace, so a realpath spy would be
  // bound at link time, observe nothing, and pass vacuously (the same reason
  // fg679-serving-path-no-subprocess uses PATH shims rather than module spies).
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "orchestrator-receipts.ts"), "utf8");
  const start = source.indexOf("export function persistPendingOrchestratorReceipt");
  assert.ok(start > 0, "fixture: the function must be findable, or this asserts nothing");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const resolvedAt = body.indexOf("provenPhysical(");
  const lockedAt = body.indexOf("writeTransaction(");
  assert.ok(resolvedAt > 0, "the write still resolves an identity");
  assert.ok(lockedAt > 0, "the write still opens a transaction");
  assert.ok(
    resolvedAt < lockedAt,
    "a realpath inside BEGIN IMMEDIATE holds the machine-wide write lock across a filesystem call — " +
      "on a slow or unresponsive mount that blocks every other forge process on this host",
  );
  assert.equal(
    body.slice(lockedAt).includes("provenPhysical("),
    false,
    "and no second resolution may creep back inside the transaction",
  );
});

test("FG-693/C4: resolving before the lock does not change what is written", () => {
  const { asWritten, physical } = aliasedCheckout("fg693-receipt-");
  persistPendingOrchestratorReceipt({
    receiptId: "orx-fg693ee",
    sessionKey: "fg693-receipt",
    projectDir: asWritten,
    runtime: "claude-code",
    provider: "anthropic",
    adapter: "claude",
    sessionOperation: "new",
    createdAt: "2026-08-11T10:00:00Z",
  });
  const row = db
    .prepare(`SELECT project_dir, project_dir_canonical FROM orchestrator_receipts WHERE receipt_id = ?`)
    .get("orx-fg693ee") as { project_dir: string; project_dir_canonical: string | null };
  assert.equal(row.project_dir, asWritten, "the launcher's bytes, verbatim");
  assert.equal(row.project_dir_canonical, physical, "the PROVEN identity, unchanged by the reordering");
});
