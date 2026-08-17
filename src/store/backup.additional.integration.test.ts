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

for (const [kind, hold] of [
  ["read transaction", (db: DatabaseInstance) => { db.exec("BEGIN"); db.prepare("SELECT * FROM runs").all(); }],
  ["write transaction", (db: DatabaseInstance) => { db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('held-write', 'feature', 'held', 'active', '1970-01-01T00:00:00.000Z')").run(); }],
  ["idle open connection", (db: DatabaseInstance) => { db.pragma("journal_mode = WAL"); }],
] as const) {
  test(`restore fails closed with a ${kind} and preserves the live store`, async () => {
    seed();
    const { backupDir } = await createBackup({ home, sourcePath: target });
    const before = liveState();
    const peer = new Database(target);
    hold(peer);
    try {
      await assert.rejects(
        restoreBackup({ backupPath: backupDir, home, targetPath: target, confirmQuiesced: true }),
        (error: unknown) => error instanceof RestoreRefusedError,
      );
    } finally {
      if (peer.inTransaction) peer.exec("ROLLBACK");
      peer.close();
    }
    assert.deepEqual(liveState(), before, "refusal must not change rows or user_version");
    // A peer in WAL may legitimately retain sidecars after close; prove they are
    // not a corrupting state by opening the main store read-only and running
    // SQLite's own consistency check (rather than treating mere existence as
    // corruption).
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

test("a peer opened at the staging seam is still refused before the swap", async () => {
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
        onStagedBeforeSwap: () => {
          peer = new Database(target);
          peer.pragma("journal_mode = WAL");
        },
      }),
      (error: unknown) => error instanceof RestoreRefusedError,
    );
  } finally {
    peer?.close();
  }
  assert.equal(liveState().count, 1);
});

test("verify rejects a manifest whose schemaVersion disagrees with the artifact", async () => {
  seed();
  const { backupDir, artifactPath, manifestPath, manifest } = await createBackup({ home, sourcePath: target });
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 1, sha256: sha(artifactPath) }));
  const result = verifyBackup(backupDir);
  assert.equal(result.outcome, "corrupt", "manifest schemaVersion is integrity metadata and must match the artifact");
  assert.ok(result.reasons.some((reason) => /schema.*version/i.test(reason)));
});
