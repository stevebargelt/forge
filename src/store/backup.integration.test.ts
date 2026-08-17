// FG-669 — heavier-tier coverage for `forge backup`: it touches the real
// filesystem and real SQLite handle boundaries (online backup, WAL quiesce probe,
// rename swap), so this runs under the integration tier against real DB files in
// per-test temp homes. NEVER ~/.forge/forge.db.
//
// The load-bearing evidence items (AC5/AC6/AC8):
//   - a full round-trip proves tickets, relations, queue state, runs, tasks,
//     events, reviews, and control-plane metadata survive create→restore with
//     identity and counts intact;
//   - restore atomically REPLACES the live store (a modification made after the
//     backup is gone; the backed-up rows are back);
//   - an interrupt BETWEEN stage and swap leaves forge.db byte-identical;
//   - an interrupt AFTER the exclusivity proof, before the swap, ALSO leaves forge.db
//     byte-identical (the non-mutating quiesce proof: the case the old
//     journal_mode=DELETE proof failed);
//   - an active WRITER makes the BEGIN EXCLUSIVE quiesce probe raise SQLITE_BUSY, so
//     restore REFUSES and the live store is unchanged;
//   - a pre-restore safety backup of the previous store is taken and is itself
//     restorable.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createBackup, verifyBackup, restoreBackup, RestoreRefusedError } from "./backup.js";
import { SCHEMA_SQL } from "./schema.js";

let home: string;
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-backup-integ-"));
  target = join(home, "forge.db");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const T0 = new Date(0).toISOString();

// Seed a store spanning every control-plane surface AC5 names. Raw SQL against the
// real SCHEMA_SQL so exactly what is inserted is what is asserted, and returns the
// per-table counts the round-trip compares against.
function seedFullStore(path: string): Record<string, number> {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const pk = "forge";
  // tickets + relations + queue membership (queue state)
  for (const id of ["FG-1", "FG-2", "FG-3"]) {
    db.prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, imported_at) VALUES (?, ?, 'story', 'active', ?, ?)`,
    ).run(pk, id, `title ${id}`, T0);
  }
  db.prepare(
    `INSERT INTO ticket_relations (project_key, ticket_id, related_id, rel_type) VALUES (?, 'FG-2', 'FG-1', 'blocks')`,
  ).run(pk);
  db.prepare(
    `INSERT INTO queue_membership (project_key, ticket_id, enqueued_at) VALUES (?, 'FG-1', ?)`,
  ).run(pk, T0);

  // runs + tasks
  for (const r of ["run-a", "run-b"]) {
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, 'active', ?)`).run(
      r,
      `run ${r}`,
      T0,
    );
  }
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at) VALUES ('task-1', 'run-a', 'implement', 'engineer', 'complete', '{}', ?)`,
  ).run(T0);

  // events
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-a', 'task-1', 'task_started', '{}', ?)`,
  ).run(T0);

  // reviews (the evidence-led ledger surface)
  db.prepare(
    `INSERT INTO reviews (id, run_id, subject_task_id, created_at, updated_at) VALUES ('rev-1', 'run-a', 'task-1', ?, ?)`,
  ).run(T0, T0);

  // representative control-plane metadata
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at) VALUES ('camp-1', 'planning', 'backlog', 'x', 'auto', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?, 'repo-abc', 'git-remote', ?)`,
  ).run(pk, T0);

  const tables = [
    "tickets",
    "ticket_relations",
    "queue_membership",
    "runs",
    "tasks",
    "events",
    "reviews",
    "campaigns",
    "project_identity",
  ];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  db.close();
  return counts;
}

function counts(path: string, tables: string[]): Record<string, number> {
  const db = new Database(path, { readonly: true });
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  db.close();
  return out;
}

test("round-trip: every control-plane surface survives create → restore with counts intact", async () => {
  const original = seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });

  // Modify the live store AFTER the backup — restore must undo this.
  {
    const db = new Database(target);
    db.exec("DELETE FROM tickets WHERE ticket_id = 'FG-3'");
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('run-post', 'feature', 'p', 'active', ?)`).run(T0);
    db.close();
  }

  const result = await restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true });
  assert.equal(result.restored, true);

  const after = counts(target, Object.keys(original));
  assert.deepEqual(after, original, "restored store must match the backed-up counts exactly");

  // Identity, not just counts: the specific rows and relations are back.
  const db = new Database(target, { readonly: true });
  assert.ok(db.prepare("SELECT 1 FROM tickets WHERE ticket_id='FG-3'").get(), "the deleted ticket is restored");
  assert.equal(db.prepare("SELECT 1 FROM runs WHERE id='run-post'").get(), undefined, "the post-backup run is gone");
  assert.ok(
    db.prepare("SELECT 1 FROM ticket_relations WHERE ticket_id='FG-2' AND related_id='FG-1'").get(),
    "relation identity survives",
  );
  db.close();
});

test("restore takes a pre-restore safety backup of the previous store, and it is itself restorable", async () => {
  seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });

  const result = await restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true });
  assert.ok(result.preRestoreBackupDir, "a pre-restore safety backup must be recorded");
  const safety = verifyBackup(result.preRestoreBackupDir!);
  assert.equal(safety.outcome, "ok", "the pre-restore safety backup must itself verify ok");
});

test("interrupt between stage and swap leaves forge.db byte-identical", async () => {
  seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });
  const before = readFileSync(target);

  await assert.rejects(
    restoreBackup({
      backupPath: backupDir,
      home,
      targetPath: target,
      confirmQuiesced: true,
      // Simulate a crash the instant staging completes, before any live-path touch.
      onStagedBeforeSwap: () => {
        throw new Error("simulated crash between stage and swap");
      },
    }),
    /simulated crash between stage and swap/,
  );

  const after = readFileSync(target);
  assert.ok(before.equals(after), "forge.db must be byte-for-byte unchanged after a pre-swap crash");
});

test("interrupt AFTER the exclusivity proof, before swap, leaves forge.db byte-identical", async () => {
  seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });
  const before = readFileSync(target);

  await assert.rejects(
    restoreBackup({
      backupPath: backupDir,
      home,
      targetPath: target,
      confirmQuiesced: true,
      // The exact window the OLD journal_mode=DELETE proof failed: exclusivity is
      // proven and the pre-restore safety backup is taken, but the rename has not run.
      // The non-mutating proof must have touched none of forge.db's own bytes.
      onQuiesceProvenBeforeSwap: () => {
        throw new Error("simulated crash after quiesce proof, before swap");
      },
    }),
    /simulated crash after quiesce proof, before swap/,
  );

  const after = readFileSync(target);
  assert.ok(before.equals(after), "forge.db must be byte-for-byte unchanged after a post-proof pre-swap crash");
});

test("active writer: a live write transaction makes the quiesce probe refuse, live store unchanged", async () => {
  const original = seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });

  // A second connection holding an OPEN write transaction holds the WAL writer lock,
  // so the restore's BEGIN EXCLUSIVE probe (busy_timeout=0) raises SQLITE_BUSY and
  // restore fails closed. (A mere reader in WAL does NOT block a writer lock and no
  // longer forces refusal — the non-mutating proof only fences an active WRITER.)
  const writer = new Database(target);
  writer.pragma("journal_mode = WAL");
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('held-writer', 'feature', 'held', 'active', ?)",
  ).run(T0);
  try {
    await assert.rejects(
      restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
      (e: unknown) => e instanceof RestoreRefusedError && /exclusive access/i.test((e as Error).message),
    );
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }

  const after = counts(target, Object.keys(original));
  assert.deepEqual(after, original, "a refused restore must leave the live store's data unchanged");
  // user_version is unchanged on refusal too — the probe never switched journal_mode.
  const db = new Database(target, { readonly: true });
  assert.equal(db.pragma("user_version", { simple: true }), 0, "refusal must not touch user_version");
  db.close();
});

test("restore refuses a corrupt candidate before touching the live path", async () => {
  const original = seedFullStore(target);
  const { backupDir, artifactPath } = await createBackup({ home, sourcePath: target });
  const before = readFileSync(target);

  // Corrupt the candidate (checksum will mismatch).
  const bytes = readFileSync(artifactPath);
  const i = Math.floor(bytes.length / 2);
  bytes[i] = bytes[i]! ^ 0xff;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(artifactPath, bytes);

  await assert.rejects(
    restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
    (e: unknown) => e instanceof RestoreRefusedError,
  );

  assert.ok(before.equals(readFileSync(target)), "a refused (corrupt) restore leaves forge.db untouched");
  assert.deepEqual(counts(target, Object.keys(original)), original);
});

test("restore requires confirmQuiesced", async () => {
  seedFullStore(target);
  const { backupDir } = await createBackup({ home, sourcePath: target });
  await assert.rejects(
    restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: false }),
    (e: unknown) => e instanceof RestoreRefusedError && /confirmQuiesced/i.test((e as Error).message),
  );
});
