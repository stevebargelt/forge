// FG-669 — unit coverage for `forge backup` create/verify against real SQLite
// files under per-test temp homes (NEVER ~/.forge/forge.db). Per the FG-551 rule,
// a property about the store's runtime behavior is demonstrated by RUNNING the real
// backup code against a real DB, not by asserting on source patterns.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createBackup, verifyBackup } from "./backup.js";
import { SCHEMA_SQL } from "./schema.js";
import { SCHEMA_VERSION } from "./db.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-backup-unit-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A real, valid forge store at a chosen path. WAL to match the live store shape,
// then closed so the online backup runs against a checkpointed file.
function seedStore(path: string, opts?: { userVersion?: number; runs?: number }): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  for (let i = 0; i < (opts?.runs ?? 3); i++) {
    db.prepare(
      `INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, 'feature', ?, 'active', ?)`,
    ).run(`run-${i}`, `title ${i}`, new Date(0).toISOString());
  }
  if (opts?.userVersion !== undefined) db.pragma(`user_version = ${opts.userVersion}`);
  db.close();
}

test("create: opens the source read-only and writes an owner-only artifact + manifest", async () => {
  const src = join(home, "forge.db");
  seedStore(src, { runs: 5 });

  const result = await createBackup({ home, sourcePath: src });

  // Perms: dir 0700, artifact 0600, manifest 0600.
  assert.equal(statSync(result.backupDir).mode & 0o777, 0o700, "backup dir must be owner-only 0700");
  assert.equal(statSync(result.artifactPath).mode & 0o777, 0o600, "artifact must be owner-only 0600");
  assert.equal(statSync(result.manifestPath).mode & 0o777, 0o600, "manifest must be owner-only 0600");

  // Manifest carries the required provenance.
  const m = result.manifest;
  assert.equal(m.sourcePath, src);
  assert.equal(typeof m.forgeVersion, "string");
  assert.equal(m.schemaVersion, 0, "a fresh store reads user_version 0");
  assert.ok(m.byteSize > 0);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  const srcStat = statSync(src);
  assert.equal(m.sourceDevice, srcStat.dev, "manifest records source device identity");
  assert.equal(m.sourceInode, srcStat.ino, "manifest records source inode identity");

  // The source was NOT migrated: a fresh store keeps user_version 0 and gains no
  // -wal/-shm from our read-only open (it stays whatever it was on disk).
  const after = new Database(src, { readonly: true });
  assert.equal(after.pragma("user_version", { simple: true }), 0, "create must not migrate the source");
  after.close();
});

test("verify: a freshly created backup is ok", async () => {
  const src = join(home, "forge.db");
  seedStore(src);
  const { backupDir } = await createBackup({ home, sourcePath: src });

  const v = verifyBackup(backupDir);
  assert.equal(v.outcome, "ok");
  assert.equal(v.ok, true);
  assert.equal(v.schemaVersion, 0);

  // A backup is a SINGLE self-consistent file: verifying it (a read-only open) must
  // not spawn -wal/-shm sidecars beside it — the artifact is rollback-journal mode.
  assert.deepEqual(
    readdirSync(backupDir).sort(),
    ["forge.db", "manifest.json"],
    "verify must leave the backup dir a single-file artifact + manifest (no sidecars)",
  );
});

test("verify: a checksum tamper is CORRUPT (without mutating the live store)", async () => {
  const src = join(home, "forge.db");
  seedStore(src);
  const { backupDir, artifactPath } = await createBackup({ home, sourcePath: src });

  // Flip a byte deep in the page data — enough to change the sha256.
  const bytes = readFileSync(artifactPath);
  const i = Math.floor(bytes.length / 2);
  bytes[i] = bytes[i]! ^ 0xff;
  writeFileSync(artifactPath, bytes);

  const v = verifyBackup(backupDir);
  assert.equal(v.outcome, "corrupt");
  assert.ok(
    v.reasons.some((r) => /checksum mismatch/i.test(r)),
    "verify must report the checksum mismatch",
  );
});

test("verify: a truncated (integrity-broken) artifact is CORRUPT", async () => {
  const src = join(home, "forge.db");
  seedStore(src, { runs: 40 });
  const { backupDir, artifactPath, manifest } = await createBackup({ home, sourcePath: src });

  // Truncate to a torn page and re-stamp the manifest sha256 so the checksum
  // matches — isolating the integrity_check as the thing that must catch it.
  const bytes = readFileSync(artifactPath).subarray(0, 1024);
  writeFileSync(artifactPath, bytes);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  writeFileSync(join(backupDir, "manifest.json"), JSON.stringify({ ...manifest, sha256: sha }));

  const v = verifyBackup(backupDir);
  assert.equal(v.outcome, "corrupt");
  assert.ok(
    v.reasons.some((r) => /integrity_check|could not open\/verify/i.test(r)),
    "verify must report the integrity/open failure — the checksum matched, so this is the DB check catching it",
  );
});

test("verify: a schema version NEWER than this binary is INCOMPATIBLE-NEWER (refused)", async () => {
  const src = join(home, "forge.db");
  seedStore(src, { userVersion: SCHEMA_VERSION + 1 });
  const { backupDir } = await createBackup({ home, sourcePath: src });

  const v = verifyBackup(backupDir);
  assert.equal(v.outcome, "incompatible_newer");
  assert.equal(v.schemaVersion, SCHEMA_VERSION + 1);
  assert.equal(v.ok, false);
});

test("verify: a missing manifest or artifact is CORRUPT, not a throw", () => {
  const v = verifyBackup(join(home, "does-not-exist"));
  assert.equal(v.outcome, "corrupt");
  assert.ok(v.reasons.some((r) => /missing manifest/i.test(r)));
});
