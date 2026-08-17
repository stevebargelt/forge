// FG-669 follow-up integration coverage. Every case owns its FORGE_HOME; no test
// can resolve or mutate the operator's store.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createBackup, restoreBackup, RestoreRefusedError, verifyBackup } from "./backup.js";
import { SCHEMA_SQL } from "./schema.js";

let home: string;
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-backup-extra-"));
  process.env.FORGE_HOME = home;
  target = join(home, "forge.db");
});
afterEach(() => {
  delete process.env.FORGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function seed(path = target): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('backup-run', 'feature', 'before', 'active', '1970-01-01T00:00:00.000Z')").run();
  db.close();
  // Make the assertion below about restore/verify, rather than a sidecar created
  // while arranging this fixture.
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}
function liveState(): { count: number; version: number } {
  const db = new Database(target, { readonly: true });
  const result = {
    count: (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
    version: db.pragma("user_version", { simple: true }) as number,
  };
  db.close();
  return result;
}
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The non-mutating quiesce proof (BEGIN EXCLUSIVE on a bare probe held under a
// read-only keeper) fails closed ONLY against an active WRITER — a held writer lock
// makes BEGIN EXCLUSIVE raise SQLITE_BUSY (busy_timeout=0). A mere reader or an idle
// connection does NOT hold the writer lock in WAL and so no longer forces refusal:
// operator quiescence (--confirm-quiesced) is what covers those, exactly as the
// contract states. This is the deliberate consequence of NOT switching journal_mode.
test("restore fails closed with an active writer and preserves the live store", async () => {
  seed();
  const { backupDir } = await createBackup({ home, sourcePath: target });
  const before = liveState();
  const peer = new Database(target);
  peer.exec("BEGIN IMMEDIATE");
  peer.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('held-write', 'feature', 'held', 'active', '1970-01-01T00:00:00.000Z')").run();
  try {
    await assert.rejects(
      restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
      (error: unknown) => error instanceof RestoreRefusedError && /exclusive access/i.test((error as Error).message),
    );
  } finally {
    if (peer.inTransaction) peer.exec("ROLLBACK");
    peer.close();
  }
  assert.deepEqual(liveState(), before, "refusal must not change rows or user_version");
  const check = new Database(target, { readonly: true });
  assert.equal((check.pragma("integrity_check") as { integrity_check: string }[])[0]?.integrity_check, "ok");
  check.close();
});

// The mirror of the above: a NON-writing peer (reader / idle) does NOT hold the
// writer lock, so the exclusivity proof succeeds and restore proceeds — the proof
// still never mutated forge.db en route (the swap itself is the mutation). Documents
// the intentional narrowing to active-writer-only refusal.
for (const [kind, hold] of [
  ["read transaction", (db: DatabaseInstance) => { db.exec("BEGIN"); db.prepare("SELECT * FROM runs").all(); }],
  ["idle open connection", (db: DatabaseInstance) => { db.pragma("journal_mode = WAL"); }],
] as const) {
  test(`restore is NOT blocked by a ${kind} (writer-only quiesce proof)`, async () => {
    seed();
    const { backupDir } = await createBackup({ home, sourcePath: target });
    const peer = new Database(target);
    hold(peer);
    try {
      const result = await restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true });
      assert.equal(result.restored, true, "a non-writing peer must not force refusal");
    } finally {
      if (peer.inTransaction) peer.exec("ROLLBACK");
      peer.close();
    }
    const check = new Database(target, { readonly: true });
    assert.equal((check.pragma("integrity_check") as { integrity_check: string }[])[0]?.integrity_check, "ok");
    check.close();
  });
}

test("verify is read-only for both artifact and live store", async () => {
  seed();
  const { backupDir, artifactPath } = await createBackup({ home, sourcePath: target });
  const fixed = new Date("2001-01-01T00:00:00.000Z");
  utimesSync(target, fixed, fixed);
  const liveBefore = statSync(target);
  const artifactBefore = readFileSync(artifactPath);
  const versionBefore = liveState().version;
  const sidecarsBefore = [
    existsSync(`${target}-wal`),
    existsSync(`${target}-shm`),
    existsSync(`${artifactPath}-wal`),
    existsSync(`${artifactPath}-shm`),
  ];
  assert.equal(verifyBackup(backupDir).outcome, "ok");
  assert.ok(readFileSync(artifactPath).equals(artifactBefore), "verify must not change artifact bytes");
  assert.equal(statSync(target).mtimeMs, liveBefore.mtimeMs, "verify must not touch live mtime");
  assert.equal(liveState().version, versionBefore, "verify must not touch live user_version");
  assert.deepEqual(
    [existsSync(`${target}-wal`), existsSync(`${target}-shm`), existsSync(`${artifactPath}-wal`), existsSync(`${artifactPath}-shm`)],
    sidecarsBefore,
    "verify must not create sidecars beside the live store or artifact",
  );
});

test("a writer that appears at the staging seam is still refused before the swap", async () => {
  seed();
  const { backupDir } = await createBackup({ home, sourcePath: target });
  let peer: DatabaseInstance | undefined;
  try {
    await assert.rejects(
      restoreBackup({
        backupPath: backupDir,
        home,
        targetPath: target,
        confirmQuiesced: true,
        // A WRITER opened AFTER staging but before the (later) quiesce probe is still
        // caught by BEGIN EXCLUSIVE — proving the probe evaluates state at ITS instant,
        // not at stage time. (An idle/reader peer here would legitimately proceed.)
        onStagedBeforeSwap: () => {
          peer = new Database(target);
          peer.exec("BEGIN IMMEDIATE");
          peer.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('seam-write', 'feature', 'seam', 'active', '1970-01-01T00:00:00.000Z')").run();
        },
      }),
      (error: unknown) => error instanceof RestoreRefusedError && /exclusive access/i.test((error as Error).message),
    );
  } finally {
    if (peer?.inTransaction) peer.exec("ROLLBACK");
    peer?.close();
  }
  assert.equal(liveState().count, 1);
});

test("a stale forge.db-wal/-shm beside the target does not survive the restore to corrupt the swapped-in db", async () => {
  seed(); // target: one row 'backup-run', sidecars removed
  const { backupDir } = await createBackup({ home, sourcePath: target }); // backup captures exactly that

  // Fabricate a REAL residual WAL as a prior non-clean shutdown would leave one: write
  // an extra committed row into the WAL WITHOUT checkpointing, snapshot the sidecar
  // bytes, then restore them beside the target after the clean close checkpointed them
  // away. The stale -wal now describes a 'ghost-run' the backup does not contain.
  const w = new Database(target);
  w.pragma("journal_mode = WAL");
  w.pragma("wal_autocheckpoint = 0");
  w.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('ghost-run', 'feature', 'ghost', 'active', '1970-01-01T00:00:00.000Z')").run();
  const staleWal = readFileSync(`${target}-wal`);
  const staleShm = readFileSync(`${target}-shm`);
  w.close();
  writeFileSync(`${target}-wal`, staleWal);
  writeFileSync(`${target}-shm`, staleShm);

  const result = await restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true });
  assert.equal(result.restored, true);

  // Option-A sidecar hygiene (removal BEFORE the rename) ran: no ghost WAL survives.
  assert.equal(existsSync(`${target}-wal`), false, "restore must remove the residual -wal before the swap");
  assert.equal(existsSync(`${target}-shm`), false, "restore must remove the residual -shm before the swap");

  const db = new Database(target, { readonly: true });
  assert.equal((db.pragma("integrity_check") as { integrity_check: string }[])[0]?.integrity_check, "ok");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1, "only the backed-up row survives");
  assert.equal(db.prepare("SELECT 1 FROM runs WHERE id='ghost-run'").get(), undefined, "the stale-WAL ghost row must not be served");
  assert.ok(db.prepare("SELECT 1 FROM runs WHERE id='backup-run'").get(), "the restored row is authoritative");
  db.close();
});

test("verify rejects a manifest whose schemaVersion disagrees with the artifact", async () => {
  seed();
  const { backupDir, artifactPath, manifestPath, manifest } = await createBackup({ home, sourcePath: target });
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 1, sha256: sha(artifactPath) }));
  const result = verifyBackup(backupDir);
  assert.equal(result.outcome, "corrupt", "manifest schemaVersion is integrity metadata and must match the artifact");
  assert.ok(result.reasons.some((reason) => /schema.*version/i.test(reason)));
});
