// FG-669 — `forge backup` create / verify / restore for the shared control-plane
// store (~/.forge/forge.db). This module lives DELIBERATELY OFF the ordinary open
// path, exactly like runDestructiveConvergenceMigration (db.ts): it opens its OWN
// Database handles to explicit paths — read-only for create and verify, and a
// bare writable handle to the live target ONLY for the restore quiesce probe — so
// nothing here ever runs getDb()'s writable branch (SCHEMA_SQL + applyMigrations)
// against a store it is merely snapshotting or replacing.
//
// THE INVARIANTS this module holds, and why each mechanism is the one it is:
//
//   create  — MUST NOT migrate the store it snapshots. A `getDb()` open would exec
//             SCHEMA_SQL + applyMigrations against the live shared DB (machine-wide
//             blast radius, the FG-395 hazard). So create opens a plain
//             `new Database(path, { readonly: true })` and uses better-sqlite3's
//             ONLINE backup API (db.backup) — a page-by-page copy that yields a
//             single self-consistent rollback-journal file (no -wal/-shm sidecar)
//             as of a point in time, correct under concurrent readers AND writers.
//             NOT VACUUM INTO (needs a writer), NOT `cp` (races a live WAL writer).
//
//   verify  — opens ONLY the backup file, on its own read-only connection. Never
//             the live store, never getDb(). Recomputes sha256 vs the manifest,
//             runs PRAGMA integrity_check, and applies the SAME forward
//             schema-version gate the open path uses (assertSchemaVersionSupported)
//             so a store a newer forge migrated past a one-way boundary is REFUSED
//             rather than restored under a binary that cannot operate it.
//
//   restore — the rename(2) over forge.db is the ONLY step that mutates the live
//             path, so any failure during validation/staging leaves forge.db
//             byte-for-byte untouched. Three quiescence layers, all reusing
//             existing precedent: a host file lock (run-lock.ts), a NON-MUTATING
//             exclusivity PROOF (a read-only keeper held across a bare read-write
//             probe that runs BEGIN EXCLUSIVE/ROLLBACK — see step 5 for why the keeper
//             and the close-ordering are load-bearing), and an operator
//             `--confirm-quiesced` assertion. The proof deliberately does NOT switch
//             journal_mode: the earlier WAL→DELETE quiesce proof checkpointed the WAL
//             and rewrote forge.db's header BEFORE the rename, so a crash in the
//             post-probe→pre-rename window left forge.db non-byte-identical (the AC4
//             defect this design fixes). The HONEST LIMIT is the same one converge
//             documents: the file lock does not hard-fence an uncooperative writer
//             (`forge next` knows nothing about backup.lock, and no SQLite lock
//             survives the rename) — the guarantee against an uncooperative peer is
//             fail-closed-at-exclusivity-probe + operator quiescence, NOT a machine
//             fence.

import Database from "better-sqlite3";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { version as FORGE_VERSION } from "../../package.json" with { type: "json" };
import { FORGE_HOME, backupsDirIn, resolveDbPath } from "../util/paths.js";
import { acquireFileLockBlocking, releaseFileLock } from "../util/run-lock.js";
import { SCHEMA_VERSION, assertSchemaVersionSupported } from "./db.js";

// The backup artifact filename inside every backup directory. Fixed (not stored in
// the manifest) so verify/restore can locate the file without trusting a value the
// manifest — which is checksummed but the directory layout is not — could misstate.
const ARTIFACT_NAME = "forge.db";
const MANIFEST_NAME = "manifest.json";

export interface BackupManifest {
  createdAt: string; // ISO-8601 UTC, the instant the snapshot was taken
  forgeVersion: string; // package.json version of the forge that wrote it
  schemaVersion: number; // source PRAGMA user_version, read via the RO conn
  sourcePath: string; // absolute path of the live store snapshotted
  sourceDevice: number; // st_dev of the source — source identity, half 1
  sourceInode: number; // st_ino of the source — source identity, half 2
  byteSize: number; // size of the finished artifact in bytes
  sha256: string; // sha256 over the finished artifact AFTER the dest handle closed
}

export interface CreateBackupResult {
  backupDir: string;
  artifactPath: string;
  manifestPath: string;
  manifest: BackupManifest;
}

// A filesystem-safe UTC timestamp for a backup directory name: ISO-8601 with the
// characters a path cannot portably carry (`:`, `.`) replaced. Millisecond
// precision so two backups in the same second do not collide.
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * FG-669 — create a point-in-time-consistent backup of a live forge store.
 *
 * Opens the SOURCE strictly read-only (never getDb() writable → never migrates the
 * store it is snapshotting) and uses the online backup API, which is correct while
 * readers and writers exist. Writes `<home>/backups/<utc-stamp>/forge.db` +
 * `manifest.json`, dir 0700 and files 0600 (the store carries operational metadata;
 * a backup is exactly as sensitive as the live DB).
 *
 * `dirName` overrides the timestamped directory name — restore uses it to place the
 * pre-restore safety backup at `backups/pre-restore-<ts>/`.
 */
export async function createBackup(opts?: {
  home?: string;
  sourcePath?: string;
  dirName?: string;
}): Promise<CreateBackupResult> {
  const home = opts?.home ?? FORGE_HOME;
  const sourcePath = opts?.sourcePath ?? resolveDbPath();
  if (!existsSync(sourcePath)) {
    throw new Error(`forge backup create: no store to back up at ${sourcePath}.`);
  }

  // Source identity is captured from the FILE, not the connection: two checkouts
  // spelled differently, or a store moved onto a new inode, are distinguishable in
  // the manifest even though the online backup itself only needs the path.
  const srcStat = statSync(sourcePath);

  const now = new Date();
  const backupDir = join(backupsDirIn(home), opts?.dirName ?? utcStamp(now));
  mkdirSync(backupDir, { recursive: true });
  chmodSync(backupDir, 0o700); // mkdir mode is umask-masked; force owner-only.

  const artifactPath = join(backupDir, ARTIFACT_NAME);

  // READ-ONLY, always. `new Database(path, { readonly: true })` runs no SCHEMA_SQL,
  // no applyMigrations, no journal_mode write — it cannot mutate the source. NOT
  // openReadOnly(): create must be able to snapshot ANY store, including one a
  // newer forge migrated past a one-way boundary (the version gate is verify's and
  // restore's job, not a reason to refuse to back the store up).
  const source = new Database(sourcePath, { readonly: true });
  let schemaVersion: number;
  try {
    schemaVersion = source.pragma("user_version", { simple: true }) as number;
    // The online backup: a self-consistent snapshot as of now, under concurrency.
    await source.backup(artifactPath);
  } finally {
    source.close();
  }

  // NORMALIZE the artifact to rollback-journal (DELETE) mode. The online backup
  // copies the source pages verbatim, INCLUDING the header bytes that mark the file
  // WAL — so a WAL live store yields a WAL-marked artifact, and every later
  // read-only open (verify, restore staging) would spawn -wal/-shm sidecars beside
  // it, leaving the "single self-consistent file" a multi-file thing (and orphaning
  // sidecars after the restore rename). Switching the DEST — a file we exclusively
  // own — to DELETE makes it a true standalone single-file snapshot; the next
  // getDb() re-establishes WAL when the restored store is first opened.
  {
    const dest = new Database(artifactPath);
    try {
      dest.pragma("journal_mode = DELETE");
    } finally {
      dest.close();
    }
  }

  // sha256 over the FINISHED bytes, after the source handle, the backup's own
  // destination handle (closed internally by better-sqlite3 when the transfer
  // completes), and the normalization handle above are all closed — so the digest
  // covers exactly the single-file bytes at rest.
  chmodSync(artifactPath, 0o600);
  const sha256 = sha256File(artifactPath);
  const byteSize = statSync(artifactPath).size;

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    forgeVersion: FORGE_VERSION,
    schemaVersion,
    sourcePath,
    sourceDevice: srcStat.dev,
    sourceInode: srcStat.ino,
    byteSize,
    sha256,
  };
  const manifestPath = join(backupDir, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  chmodSync(manifestPath, 0o600); // writeFile mode is umask-masked too.

  return { backupDir, artifactPath, manifestPath, manifest };
}

export type VerifyOutcome = "ok" | "corrupt" | "incompatible_newer";

export interface VerifyBackupResult {
  outcome: VerifyOutcome;
  ok: boolean; // convenience: outcome === "ok"
  backupDir: string;
  artifactPath: string;
  schemaVersion: number | null; // null when the artifact could not be opened
  // Human-readable reasons — every failed check is recorded, not just the first,
  // so a corrupt-AND-checksum-mismatched artifact reports both.
  reasons: string[];
  // Set for a compatible-but-OLDER backup: it will migrate additively on first open.
  willMigrateOnFirstOpen: boolean;
}

/**
 * FG-669 — verify a backup without mutating anything. Opens ONLY the backup file
 * (its own read-only connection), recomputes the checksum vs the manifest, runs
 * PRAGMA integrity_check, and applies the forward schema-version gate.
 *
 * Outcomes: checksum mismatch OR integrity_check != 'ok' → corrupt;
 * user_version > SCHEMA_VERSION → incompatible_newer (refuse); <= SCHEMA_VERSION →
 * ok (older is compatible and flagged willMigrateOnFirstOpen).
 */
export function verifyBackup(backupPath: string): VerifyBackupResult {
  const backupDir = backupPath;
  const artifactPath = join(backupDir, ARTIFACT_NAME);
  const manifestPath = join(backupDir, MANIFEST_NAME);
  const reasons: string[] = [];

  const base: VerifyBackupResult = {
    outcome: "corrupt",
    ok: false,
    backupDir,
    artifactPath,
    schemaVersion: null,
    reasons,
    willMigrateOnFirstOpen: false,
  };

  if (!existsSync(manifestPath)) {
    reasons.push(`missing manifest at ${manifestPath}`);
    return base;
  }
  if (!existsSync(artifactPath)) {
    reasons.push(`missing backup artifact at ${artifactPath}`);
    return base;
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (e) {
    reasons.push(`unreadable manifest: ${(e as Error).message}`);
    return base;
  }

  // Checksum FIRST — over the bytes at rest, before opening a connection that would
  // read them through SQLite's own paging. A mismatch is definitive corruption.
  const actualSha = sha256File(artifactPath);
  if (actualSha !== manifest.sha256) {
    reasons.push(`checksum mismatch: manifest ${manifest.sha256}, actual ${actualSha}`);
    // Still fall through to integrity/version so the report is complete.
  }

  let schemaVersion: number | null = null;
  let integrityOk = false;
  let incompatibleNewer = false;
  let manifestSchemaMismatch = false;
  // A severely corrupt file makes `new Database` or PRAGMA integrity_check THROW
  // (SQLITE_CORRUPT / "file is not a database") rather than return a non-'ok' row —
  // both are "corrupt", never a leaked exception out of verify.
  try {
    const db = new Database(artifactPath, { readonly: true });
    try {
      db.pragma("busy_timeout = 5000");
      const rows = db.pragma("integrity_check") as { integrity_check: string }[];
      integrityOk = rows.length === 1 && rows[0]?.integrity_check === "ok";
      if (!integrityOk) {
        reasons.push(`integrity_check failed: ${rows.map((r) => r.integrity_check).join("; ")}`);
      }
      schemaVersion = db.pragma("user_version", { simple: true }) as number;
      // The manifest's recorded schemaVersion is integrity metadata; a value that
      // disagrees with the artifact's real user_version is a tamper signal, distinct
      // from the forward-support gate below.
      if (schemaVersion !== manifest.schemaVersion) {
        manifestSchemaMismatch = true;
        reasons.push(
          `manifest schema version ${manifest.schemaVersion} disagrees with artifact user_version ${schemaVersion}`,
        );
      }
      // Reuse the forward gate verbatim — do NOT re-derive the rule. It throws iff
      // stored > SCHEMA_VERSION, which is exactly the incompatible-newer refusal.
      try {
        assertSchemaVersionSupported(db);
      } catch (e) {
        incompatibleNewer = true;
        reasons.push((e as Error).message);
      }
    } finally {
      db.close();
    }
  } catch (e) {
    integrityOk = false;
    reasons.push(`could not open/verify artifact: ${(e as Error).message}`);
  }

  const checksumOk = actualSha === manifest.sha256;
  if (!checksumOk || !integrityOk || manifestSchemaMismatch) {
    return { ...base, outcome: "corrupt", schemaVersion };
  }
  if (incompatibleNewer) {
    return { ...base, outcome: "incompatible_newer", schemaVersion };
  }
  const willMigrate = schemaVersion !== null && schemaVersion < SCHEMA_VERSION;
  if (willMigrate) {
    reasons.push(
      `backup schema version ${schemaVersion} < ${SCHEMA_VERSION} — compatible; ` +
        `will migrate additively on first open (FG-568/BD-15).`,
    );
  }
  return {
    outcome: "ok",
    ok: true,
    backupDir,
    artifactPath,
    schemaVersion,
    reasons,
    willMigrateOnFirstOpen: willMigrate,
  };
}

export interface RestoreBackupResult {
  restored: true;
  targetPath: string;
  backupDir: string;
  preRestoreBackupDir: string | null; // null only when there was no live store to protect
  schemaVersion: number | null;
}

export class RestoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

/**
 * FG-669 — restore a validated backup over the live store with an atomic swap.
 *
 * The sequence (exactly this order — see the module header for why each layer):
 *   1. Acquire `<home>/backup.lock`; require confirmQuiesced.
 *   2. VALIDATE the candidate via the full verify() (integrity + checksum + version
 *      gate). Refuse here → nothing on the live path touched.
 *   3. STAGE: copy the validated candidate to `<targetDir>/forge.db.restore-<uuid>.tmp`
 *      on the SAME filesystem as forge.db, then re-open the staged temp read-only and
 *      re-run integrity_check + the version gate.
 *   4. PRE-RESTORE SAFETY BACKUP: a real db.backup() of the CURRENT live store — the
 *      recovery path — into `backups/pre-restore-<ts>/`.
 *   5. QUIESCE PROOF (NON-MUTATING): a read-only KEEPER handle held across a bare
 *      read-write PROBE that runs BEGIN EXCLUSIVE/ROLLBACK under busy_timeout=0; fail
 *      closed on SQLITE_BUSY. Does NOT switch journal_mode — forge.db's own bytes stay
 *      untouched (see the body for the checkpoint-on-close trap the keeper dodges).
 *   6. SIDECAR HYGIENE: unlink any residual forge.db-wal / forge.db-shm BEFORE the swap.
 *   7. SWAP: rename(2) the temp OVER forge.db — the ONLY mutating step, atomic.
 *
 * Two TEST SEAMS (both mirror runDestructiveConvergenceMigration's onQuiescedBeforeDdl;
 * never passed in production): `onStagedBeforeSwap` fires immediately AFTER staging and
 * BEFORE any live-path touch; `onQuiesceProvenBeforeSwap` fires AFTER the exclusivity
 * proof and BEFORE the rename. Either lets a test throw to simulate a crash at that
 * exact window and assert forge.db is left byte-identical (sha256).
 */
export async function restoreBackup(opts: {
  backupPath: string;
  home?: string;
  targetPath?: string;
  confirmQuiesced: boolean;
  onStagedBeforeSwap?: () => void;
  onQuiesceProvenBeforeSwap?: () => void;
}): Promise<RestoreBackupResult> {
  const home = opts.home ?? FORGE_HOME;
  const targetPath = opts.targetPath ?? resolveDbPath();
  const targetDir = dirname(targetPath);

  if (!opts.confirmQuiesced) {
    // Defensive: the CLI does the preview/confirm split and only reaches here on
    // an explicit --confirm-quiesced. A programmatic caller must assert it too.
    throw new RestoreRefusedError(
      "forge backup restore: refusing without confirmQuiesced — restore requires the operator " +
        "to assert every forge process on this FORGE_HOME is stopped.",
    );
  }

  const lockPath = join(home, "backup.lock");
  mkdirSync(home, { recursive: true });
  // Reuse the O_EXCL create-if-absent host lock (run-lock.ts). Blocks out a
  // concurrent restore; a dead holder (crashed forge) is stolen. It does NOT fence
  // an uncooperative live writer — that is the quiesce proof's job (step 5).
  await acquireFileLockBlocking(lockPath, "forge backup restore", { holderId: `restore-${process.pid}` });

  let stagedTemp: string | null = null;
  try {
    // Step 2 — VALIDATE the candidate. Refuse on ANY non-ok outcome. Live path untouched.
    const verified = verifyBackup(opts.backupPath);
    if (verified.outcome !== "ok") {
      throw new RestoreRefusedError(
        `forge backup restore: refusing — candidate did not verify (${verified.outcome}): ` +
          verified.reasons.join("; "),
      );
    }

    // Step 3 — STAGE onto the SAME filesystem as forge.db. A cross-fs rename is
    // EXDEV (see promote.ts's atomicSymlinkSwap note), and the swap MUST be a
    // rename, so the temp lives in the target's own directory.
    mkdirSync(targetDir, { recursive: true });
    stagedTemp = join(targetDir, `forge.db.restore-${randomUUID()}.tmp`);
    copyFileSync(verified.artifactPath, stagedTemp);
    chmodSync(stagedTemp, 0o600);
    // Re-open the STAGED bytes (not the source) read-only and re-prove them — the
    // copy itself is now the thing that will become the live store.
    const staged = new Database(stagedTemp, { readonly: true });
    let stagedSchemaVersion: number;
    try {
      staged.pragma("busy_timeout = 5000");
      const rows = staged.pragma("integrity_check") as { integrity_check: string }[];
      if (!(rows.length === 1 && rows[0]?.integrity_check === "ok")) {
        throw new RestoreRefusedError(
          `forge backup restore: refusing — staged copy failed integrity_check: ` +
            rows.map((r) => r.integrity_check).join("; "),
        );
      }
      // Version gate on the staged bytes too — a check UP FRONT, before we touch live.
      assertSchemaVersionSupported(staged);
      stagedSchemaVersion = staged.pragma("user_version", { simple: true }) as number;
    } finally {
      staged.close();
    }

    // TEST SEAM — a crash simulated HERE leaves forge.db byte-identical: nothing
    // below step 4 has yet run, and steps 2–3 never touched the live path.
    opts.onStagedBeforeSwap?.();

    // Step 4 — PRE-RESTORE SAFETY BACKUP of the CURRENT live store (the recovery
    // path). Skipped only when there is no live store to protect (fresh restore).
    let preRestoreBackupDir: string | null = null;
    if (existsSync(targetPath)) {
      const pre = await createBackup({
        home,
        sourcePath: targetPath,
        dirName: `pre-restore-${utcStamp(new Date())}`,
      });
      preRestoreBackupDir = pre.backupDir;
    }

    // Step 5 — QUIESCE PROOF, NON-MUTATING. The earlier design switched
    // journal_mode=DELETE on the live store to prove exclusivity — but that switch
    // CHECKPOINTS the WAL and rewrites forge.db's header, mutating its bytes BEFORE
    // the atomic rename, so a crash in the post-probe→pre-rename window left forge.db
    // non-byte-identical (the AC4 defect). This proves the same exclusivity WITHOUT
    // touching forge.db's own bytes.
    //
    // THE TRAP IT DODGES — CHECKPOINT-ON-CLOSE: the LAST read-WRITE connection to
    // close a WAL store that carries a dirty (un-checkpointed) WAL performs a
    // checkpoint as it closes, rewriting forge.db. A read-ONLY last close NEVER
    // checkpoints. So a read-only KEEPER is held OPEN across the whole probe: while
    // it is open the read-write PROBE is never the last connection, and the keeper —
    // closed LAST and read-only — cannot checkpoint. This is verified in-container.
    //
    // Both are bare `new Database` handles (NOT getDb(): no SCHEMA_SQL, no
    // applyMigrations, no opener registry / maintenance flag, and nothing cached
    // process-wide that would outlive the swap pointing at a soon-to-be-unlinked
    // inode). We NEVER switch journal_mode.
    const keeper = new Database(targetPath, { readonly: true });
    try {
      const probe = new Database(targetPath);
      try {
        probe.pragma("busy_timeout = 0");
        // BEGIN EXCLUSIVE takes the writer lock immediately; under busy_timeout=0 it
        // raises SQLITE_BUSY if an active writer holds the store. Success proves no
        // active writer AT THAT INSTANT; we needed only the proof, so ROLLBACK at
        // once (BEGIN EXCLUSIVE opened no changes to keep). Any throw ⇒ fail closed.
        try {
          probe.exec("BEGIN EXCLUSIVE");
          probe.exec("ROLLBACK");
        } catch (e) {
          throw new RestoreRefusedError(
            `forge backup restore: refusing — could not acquire exclusive access to the live store ` +
              `(quiesce required; another forge process holds it). Stop every forge process on this ` +
              `FORGE_HOME and retry. Underlying: ${(e as Error).message}`,
          );
        }
      } finally {
        // ORDERING IS LOAD-BEARING (verified): close the read-WRITE probe FIRST so the
        // read-only keeper is what closes LAST. A read-write last close of a dirty WAL
        // WOULD checkpoint-and-rewrite forge.db; a read-only last close never does.
        probe.close();
      }
    } finally {
      keeper.close();
    }

    // TEST SEAM — a crash simulated HERE (exclusivity proven, before the rename) must
    // leave forge.db byte-identical: step 5 mutated none of its own bytes. This is the
    // exact window the old journal_mode=DELETE proof failed. Never passed in production.
    opts.onQuiesceProvenBeforeSwap?.();

    // Step 6 — SIDECAR HYGIENE, load-bearing (Option A: BEFORE the rename). The
    // swapped-in artifact is a single-file DELETE-mode DB; a stale forge.db-wal left
    // beside it would be read as AUTHORITATIVE — the restored rows would vanish behind
    // a ghost WAL that even integrity_check reports as 'ok'. Removing these separate
    // sidecar files does not mutate forge.db's own bytes. (Option B — remove AFTER the
    // rename — has a silent-corruption crash window: do NOT do that.)
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });

    // Step 7 — SWAP. The ONE mutating step, atomic. On success the temp is consumed
    // (moved), so it must not be removed in the finally below.
    const toSwap = stagedTemp;
    stagedTemp = null;
    renameSync(toSwap, targetPath);
    chmodSync(targetPath, 0o600);

    return {
      restored: true,
      targetPath,
      backupDir: verified.backupDir,
      preRestoreBackupDir,
      schemaVersion: stagedSchemaVersion,
    };
  } finally {
    // A staged temp still set here means we failed (or a seam threw) before the
    // swap consumed it — clean it up; forge.db was never touched.
    if (stagedTemp) rmSync(stagedTemp, { force: true });
    releaseFileLock(lockPath);
  }
}
