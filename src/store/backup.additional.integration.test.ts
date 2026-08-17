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
import { closeDb, getDb } from "./db.js";
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
  // Rollback-journal (DELETE) mode so the held writer takes its lock via a
  // `forge.db-journal`, not a `-wal`/`-shm` sidecar — keeping the refuse-if-dirty gate
  // OUT of the way so this test still exercises the EXCLUSIVITY PROBE distinctly.
  {
    const conv = new Database(target);
    conv.pragma("journal_mode = DELETE");
    conv.close();
  }
  const { backupDir } = await createBackup({ home, sourcePath: target });
  const before = liveState();
  const peer = new Database(target);
  peer.exec("BEGIN IMMEDIATE");
  peer.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('held-write', 'feature', 'held', 'active', '1970-01-01T00:00:00.000Z')").run();
  assert.ok(
    !existsSync(`${target}-wal`) && !existsSync(`${target}-shm`),
    "precondition: a DELETE-mode writer must not create -wal/-shm, so the exclusivity probe (not the dirty gate) is what refuses",
  );
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

// Under refuse-if-dirty, ANY live connection that keeps the store in WAL leaves a
// -shm (and usually a -wal) beside forge.db — so even a NON-writing peer now forces
// refusal at the dirty gate, BEFORE the exclusivity probe is reached. This is the
// intended tightening: restore proceeds only on a cleanly-stopped, checkpointed store
// (the exclusivity probe's writer-only narrowing is still covered by the DELETE-mode
// active-writer test above and the staging-seam test below).
for (const [kind, hold] of [
  ["read transaction", (db: DatabaseInstance) => { db.exec("BEGIN"); db.prepare("SELECT * FROM runs").all(); }],
  ["idle open connection", (db: DatabaseInstance) => { db.pragma("journal_mode = WAL"); }],
] as const) {
  test(`restore refuses a store held open by a ${kind} (dirty sidecar gate)`, async () => {
    seed();
    const { backupDir } = await createBackup({ home, sourcePath: target });
    // Clear the empty sidecars createBackup's read-only snapshot left, so the PEER's
    // open below is what re-dirties the store — the scenario under test.
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    const before = liveState();
    const peer = new Database(target);
    hold(peer);
    assert.ok(
      existsSync(`${target}-wal`) || existsSync(`${target}-shm`),
      "precondition: an open WAL peer leaves a -wal/-shm sidecar beside forge.db",
    );
    try {
      await assert.rejects(
        restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
        (error: unknown) =>
          error instanceof RestoreRefusedError && /sidecar|checkpoint|WAL tail/i.test((error as Error).message),
      );
    } finally {
      if (peer.inTransaction) peer.exec("ROLLBACK");
      peer.close();
    }
    assert.deepEqual(liveState(), before, "a refused restore leaves the live store unchanged");
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
  // createBackup's read-only snapshot left EMPTY -wal/-shm on the live store; remove
  // them so the refuse-if-dirty gate passes and the SEAM WRITER (opened later) is what
  // the exclusivity probe refuses — the point of this test.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
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

test("an un-checkpointed WAL tail beside the target is REFUSED, preserving that committed tail (RF-1)", async () => {
  seed(); // target: one committed row 'backup-run', sidecars removed
  const { backupDir } = await createBackup({ home, sourcePath: target });

  // Fabricate a REAL residual WAL as a prior non-clean shutdown would leave one: write
  // an extra COMMITTED row into the WAL WITHOUT checkpointing, snapshot the sidecar
  // bytes, then restore them beside the target after the clean close checkpointed them
  // away. 'ghost-run' now lives ONLY in forge.db-wal — it is genuine committed live
  // data, not garbage. The pre-fix restore removed the sidecars before the swap and
  // would have SILENTLY LOST it (the AC4 hazard). Refuse-if-dirty must refuse instead.
  const w = new Database(target);
  w.pragma("journal_mode = WAL");
  w.pragma("wal_autocheckpoint = 0");
  w.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('ghost-run', 'feature', 'ghost', 'active', '1970-01-01T00:00:00.000Z')").run();
  const staleWal = readFileSync(`${target}-wal`);
  const staleShm = readFileSync(`${target}-shm`);
  w.close();
  writeFileSync(`${target}-wal`, staleWal);
  writeFileSync(`${target}-shm`, staleShm);

  await assert.rejects(
    restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
    (error: unknown) => error instanceof RestoreRefusedError && /sidecar|checkpoint|WAL tail/i.test((error as Error).message),
  );

  // The refusal ran BEFORE step 6, so the sidecars — and the committed frames they
  // carry — are untouched. Checkpointing recovers BOTH rows: nothing was lost.
  assert.ok(existsSync(`${target}-wal`), "a refused dirty restore must NOT remove the -wal tail it is protecting");
  const db = new Database(target);
  db.pragma("wal_checkpoint(TRUNCATE)");
  assert.equal((db.pragma("integrity_check") as { integrity_check: string }[])[0]?.integrity_check, "ok");
  assert.ok(db.prepare("SELECT 1 FROM runs WHERE id='ghost-run'").get(), "the un-checkpointed WAL tail survived the refusal");
  assert.ok(db.prepare("SELECT 1 FROM runs WHERE id='backup-run'").get(), "the pre-existing committed row survives too");
  db.close();
});

test("restore refuses a valid-but-SUBSTITUTED artifact swapped in after verification (RF-3)", async () => {
  seed(); // live store: one committed row 'backup-run'
  const { backupDir, artifactPath } = await createBackup({ home, sourcePath: target });
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  const before = readFileSync(target);

  // Build a DIFFERENT, structurally valid, schema-compatible SQLite file to stand in
  // for what a local attacker with write access to the backup dir could substitute in
  // the window between verify (step 2) and the staging copy (step 3): it passes
  // integrity_check and the version gate, but its bytes — and thus its sha256 — differ
  // from the manifest the candidate was authenticated against.
  const evilPath = join(home, "evil.db");
  const evil = new Database(evilPath);
  evil.exec(SCHEMA_SQL);
  evil.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('attacker', 'feature', 'evil', 'active', '1970-01-01T00:00:00.000Z')").run();
  evil.pragma("journal_mode = DELETE");
  evil.close();
  const evilBytes = readFileSync(evilPath);
  assert.notEqual(sha(evilPath), sha(artifactPath), "the substitute must differ from the verified artifact");

  await assert.rejects(
    restoreBackup({
      backupPath: backupDir,
      home,
      targetPath: target,
      confirmQuiesced: true,
      // Substitute the artifact AFTER verify authenticated it, BEFORE it is staged.
      onVerifiedBeforeStage: () => writeFileSync(artifactPath, evilBytes),
    }),
    (error: unknown) =>
      error instanceof RestoreRefusedError && /checksum|does not match/i.test((error as Error).message),
  );

  assert.ok(before.equals(readFileSync(target)), "the substituted candidate must not be installed — forge.db is untouched");
  assert.equal(liveState().count, 1, "the live store still holds only its own row, not the attacker's");
});

test("manifest schemaVersion is derived from the ARTIFACT, so a migrated store round-trips ok (RF-2)", async () => {
  // A store at a non-zero (migrated) user_version. The manifest's schemaVersion must
  // equal the ARTIFACT's real user_version — the value verify cross-checks — not a
  // value read from the live source before backup(), which a concurrent one-way
  // migration could make stale. Read the artifact independently and compare.
  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.pragma("user_version = 1"); // == SCHEMA_VERSION: migrated to the boundary, still supported
  db.close();
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });

  const { backupDir, artifactPath, manifest } = await createBackup({ home, sourcePath: target });

  const artifactDb = new Database(artifactPath, { readonly: true });
  const artifactVersion = artifactDb.pragma("user_version", { simple: true }) as number;
  artifactDb.close();

  assert.equal(manifest.schemaVersion, 1, "manifest records the store's user_version");
  assert.equal(
    manifest.schemaVersion,
    artifactVersion,
    "manifest.schemaVersion must equal the artifact's real user_version, not a pre-backup source read",
  );
  assert.equal(verifyBackup(backupDir).outcome, "ok", "verify's manifest/artifact cross-check passes");
});

// FG-730 — the PRIMARY disaster-recovery path: the store was LOST (disk failure,
// deletion, fresh host), so restore runs into a FORGE_HOME that has NO forge.db. The
// refuse-if-dirty gate and the quiesce proof both open the live target; with no target
// to open they must be SKIPPED (there is no live store to refuse or quiesce), exactly
// as the pre-restore safety-backup step already skips. Before the fix, a read-only open
// of the non-existent forge.db threw "unable to open database file".
test("restore into an EMPTY FORGE_HOME (no forge.db) recovers the store, and getDb() opens it (FG-730)", async () => {
  // Seed a store spanning several surfaces so identity — not just counts — is asserted.
  {
    const db = new Database(target);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA_SQL);
    for (const id of ["FG-1", "FG-2"]) {
      db.prepare(
        "INSERT INTO tickets (project_key, ticket_id, type, status, title, imported_at) VALUES ('forge', ?, 'story', 'active', ?, '1970-01-01T00:00:00.000Z')",
      ).run(id, `title ${id}`);
    }
    db.prepare(
      "INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('recover-run', 'feature', 'before', 'active', '1970-01-01T00:00:00.000Z')",
    ).run();
    db.close();
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
  }
  const tables = ["tickets", "runs"];
  const backupCounts = (() => {
    const db = new Database(target, { readonly: true });
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    db.close();
    return out;
  })();
  const { backupDir } = await createBackup({ home, sourcePath: target });

  // A brand-new, EMPTY FORGE_HOME — the fresh-host / DB-lost target. No forge.db, and
  // the directory itself may not carry the store yet (restore must ensure it).
  const freshHome = mkdtempSync(join(tmpdir(), "forge-backup-fresh-"));
  const freshTarget = join(freshHome, "forge.db");
  assert.ok(!existsSync(freshTarget), "precondition: the fresh FORGE_HOME has no live store");
  try {
    const result = await restoreBackup({
      backupPath: backupDir,
      home: freshHome,
      targetPath: freshTarget,
      confirmQuiesced: true,
    });
    assert.equal(result.restored, true);
    assert.equal(result.preRestoreBackupDir, null, "no live store existed, so no pre-restore safety backup is taken");

    const restored = new Database(freshTarget, { readonly: true });
    const after: Record<string, number> = {};
    for (const t of tables) after[t] = (restored.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.deepEqual(after, backupCounts, "the recovered store matches the backup's row counts exactly");
    assert.ok(restored.prepare("SELECT 1 FROM runs WHERE id='recover-run'").get(), "the backed-up run identity is restored");
    assert.ok(restored.prepare("SELECT 1 FROM tickets WHERE ticket_id='FG-2'").get(), "ticket identity is restored");
    restored.close();

    // The restored single-file store must open cleanly through the ordinary path.
    process.env.FORGE_HOME = freshHome;
    try {
      const db = getDb();
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, backupCounts.runs);
    } finally {
      closeDb();
      process.env.FORGE_HOME = home;
    }
  } finally {
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test("verify rejects a manifest whose schemaVersion disagrees with the artifact", async () => {
  seed();
  const { backupDir, artifactPath, manifestPath, manifest } = await createBackup({ home, sourcePath: target });
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 1, sha256: sha(artifactPath) }));
  const result = verifyBackup(backupDir);
  assert.equal(result.outcome, "corrupt", "manifest schemaVersion is integrity metadata and must match the artifact");
  assert.ok(result.reasons.some((reason) => /schema.*version/i.test(reason)));
});
