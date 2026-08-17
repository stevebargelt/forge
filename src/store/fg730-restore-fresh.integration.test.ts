// FG-730 — restore must work when a fresh host has neither FORGE_HOME nor forge.db,
// while the safety gates remain in force when there is a live target to protect.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { createBackup, restoreBackup, RestoreRefusedError, verifyBackup } from "./backup.js";
import { SCHEMA_SQL } from "./schema.js";

let root: string;
let sourceHome: string;
let sourcePath: string;

const T0 = "1970-01-01T00:00:00.000Z";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-fg730-"));
  sourceHome = join(root, "source-home");
  sourcePath = join(sourceHome, "forge.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function clearSidecars(path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function seedControlPlane(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO tickets (project_key, ticket_id, type, status, title, imported_at) VALUES ('forge', 'FG-730', 'story', 'active', 'restore recovery', ?)",
  ).run(T0);
  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('run-730', 'feature', 'recovery', 'active', ?)").run(T0);
  for (const [id, role] of [["task-primary", "engineer"], ["task-red", "red-backend"]]) {
    db.prepare(
      "INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at) VALUES (?, 'run-730', 'verify', ?, 'complete', '{}', ?)",
    ).run(id, role, T0);
  }
  db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-730', 'task-primary', 'task_completed', '{\"result\":\"ok\"}', ?)").run(T0);
  db.prepare(
    "INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at, gate_on_verdict) VALUES ('verdict-730', 'task-primary', 'task-red', 'red-backend', 'pass', 0.97, 'authoritative', '[]', ?, 1)",
  ).run(T0);
  db.prepare(
    "INSERT INTO reviews (id, run_id, subject_task_id, review_mode, state, created_at, updated_at) VALUES ('review-730', 'run-730', 'task-primary', 'evidence_led', 'settled', ?, ?)",
  ).run(T0, T0);
  db.close();
  clearSidecars(path);
}

function rowCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  const result: Record<string, number> = {};
  for (const table of ["tickets", "runs", "tasks", "events", "verdicts", "reviews"]) {
    result[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  db.close();
  return result;
}

test("FG-730: restores a full control-plane snapshot when the target directory is absent", async () => {
  seedControlPlane(sourcePath);
  const expected = rowCounts(sourcePath);
  const { backupDir } = await createBackup({ home: sourceHome, sourcePath });

  const freshHome = join(root, "fresh-host", "missing-forge-home");
  const freshTarget = join(freshHome, "forge.db");
  assert.equal(existsSync(freshHome), false, "precondition: the entire target FORGE_HOME is absent");

  const result = await restoreBackup({ backupPath: backupDir, home: freshHome, targetPath: freshTarget, confirmQuiesced: true });

  assert.equal(result.restored, true);
  assert.equal(result.preRestoreBackupDir, null, "a fresh target has no store to protect");
  assert.ok(existsSync(freshTarget), "restore creates the previously absent target directory and store");
  assert.equal(existsSync(join(freshHome, "backups")), false, "fresh restore creates no stray pre-restore backup directory");
  assert.deepEqual(rowCounts(freshTarget), expected, "all representative control-plane tables survive recovery");

  const restored = new Database(freshTarget, { readonly: true });
  assert.ok(restored.prepare("SELECT 1 FROM events WHERE event_type = 'task_completed' AND task_id = 'task-primary'").get());
  assert.ok(restored.prepare("SELECT 1 FROM verdicts WHERE id = 'verdict-730' AND confidence = 0.97").get());
  assert.ok(restored.prepare("SELECT 1 FROM reviews WHERE id = 'review-730' AND state = 'settled'").get());
  restored.close();
});

test("FG-730/RF-1: a target that appears after the fresh-restore check is refused, not clobbered", async () => {
  seedControlPlane(sourcePath);
  const { backupDir } = await createBackup({ home: sourceHome, sourcePath });

  const freshHome = join(root, "raced-host", "missing-forge-home");
  const freshTarget = join(freshHome, "forge.db");
  assert.equal(existsSync(freshHome), false, "precondition: the target FORGE_HOME is absent when restore begins");

  // Simulate a forge process starting between the top-of-function existsSync snapshot
  // and the swap: create the target, insert a distinguishing `live` row, and hold an
  // open writer — the exact race the fresh path skips its quiesce proof for.
  let liveHolder: Database.Database | undefined;
  await assert.rejects(
    restoreBackup({
      backupPath: backupDir,
      home: freshHome,
      targetPath: freshTarget,
      confirmQuiesced: true,
      onStagedBeforeSwap: () => {
        mkdirSync(dirname(freshTarget), { recursive: true });
        liveHolder = new Database(freshTarget);
        liveHolder.pragma("journal_mode = WAL");
        liveHolder.exec(SCHEMA_SQL);
        liveHolder.prepare(
          "INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('live-race', 'feature', 'live', 'active', ?)",
        ).run(T0);
      },
    }),
    (error: unknown) => error instanceof RestoreRefusedError && /appeared|fresh-restore check/i.test((error as Error).message),
  );

  try {
    // The live store the racing process created is intact — the restore did NOT
    // overwrite it, and its `live` row survives with the backup row nowhere in sight.
    assert.ok(existsSync(freshTarget), "the raced-in live store is not clobbered");
    assert.ok(liveHolder!.prepare("SELECT 1 FROM runs WHERE id = 'live-race'").get(), "the live writer's row survives");
    const backupRow = liveHolder!.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = 'run-730'").get() as { n: number };
    assert.equal(backupRow.n, 0, "the backup's row was NOT installed over the live store");
  } finally {
    liveHolder?.close();
  }
  // No staged temp is left behind on the refusal.
  assert.ok(
    !readdirSync(dirname(freshTarget)).some((entry) => entry.includes(".restore-")),
    "the staged temp is cleaned up after the refusal",
  );
});

test("FG-730: an existing clean target still receives a verified pre-restore safety backup", async () => {
  seedControlPlane(sourcePath);
  const { backupDir } = await createBackup({ home: sourceHome, sourcePath });
  const targetHome = join(root, "existing-home");
  const target = join(targetHome, "forge.db");
  seedControlPlane(target);

  const result = await restoreBackup({ backupPath: backupDir, home: targetHome, targetPath: target, confirmQuiesced: true });

  assert.ok(result.preRestoreBackupDir, "an existing store must receive a pre-restore safety backup");
  assert.match(result.preRestoreBackupDir!, /pre-restore-/);
  assert.equal(verifyBackup(result.preRestoreBackupDir!).outcome, "ok");
  assert.ok(readdirSync(join(targetHome, "backups")).some((entry) => entry.startsWith("pre-restore-")));
});

test("FG-730: target-exists safety gates still refuse WAL sidecars and an exclusive writer", async (t) => {
  await t.test("WAL sidecar remains a fail-closed dirty-target refusal", async () => {
    seedControlPlane(sourcePath);
    const { backupDir } = await createBackup({ home: sourceHome, sourcePath });
    const targetHome = join(root, "dirty-home");
    const target = join(targetHome, "forge.db");
    seedControlPlane(target);
    const holder = new Database(target);
    holder.pragma("journal_mode = WAL");
    holder.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('wal-tail', 'feature', 'dirty', 'active', ?)").run(T0);
    try {
      assert.ok(existsSync(`${target}-wal`) || existsSync(`${target}-shm`), "precondition: live target has WAL sidecars");
      await assert.rejects(
        restoreBackup({ backupPath: backupDir, home: targetHome, targetPath: target, confirmQuiesced: true }),
        (error: unknown) => error instanceof RestoreRefusedError && /sidecar|WAL tail/i.test((error as Error).message),
      );
    } finally {
      holder.close();
    }
  });

  await t.test("BEGIN EXCLUSIVE still fails closed instead of installing over a live writer", async () => {
    seedControlPlane(sourcePath);
    const { backupDir } = await createBackup({ home: sourceHome, sourcePath });
    const targetHome = join(root, "locked-home");
    const target = join(targetHome, "forge.db");
    seedControlPlane(target);
    const targetDb = new Database(target);
    targetDb.pragma("journal_mode = DELETE");
    targetDb.close();
    const writer = new Database(target);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      await assert.rejects(
        restoreBackup({ backupPath: backupDir, home: targetHome, targetPath: target, confirmQuiesced: true }),
        /SQLITE_BUSY|database is locked|exclusive access/i,
      );
      assert.ok(existsSync(target), "the live target remains in place after a busy refusal");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
