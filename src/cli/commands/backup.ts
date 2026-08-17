import type { Command } from "commander";
import { createBackup, verifyBackup, restoreBackup, RestoreRefusedError } from "../../store/backup.js";
import { SCHEMA_VERSION } from "../../store/db.js";

// FG-669: the operator-facing entry point for backing up, verifying, and restoring
// the shared forge SQLite store (~/.forge/forge.db). The heavy lifting — and the
// invariants (read-only create/verify, rename-is-the-only-mutation restore, the
// journal_mode quiesce proof) — live in src/store/backup.ts; this file is the CLI
// surface and the restore preview/confirm split (mirroring `forge store converge`).
//
// WHAT A BACKUP CONTAINS AND HOW SENSITIVE IT IS — surfaced in --help and the
// restore contract so an operator is never guessing. A backup is a byte-level
// snapshot of the ENTIRE control-plane store: every run, task, event, verdict,
// review and finding, campaign, queue and readiness row, ticket / relation / queue
// membership, and control-plane metadata. It is EXACTLY as sensitive as the live
// forge.db — treat it like a credential-adjacent artifact. Backups are written
// owner-only (dir 0700, files 0600) under `$FORGE_HOME/backups/<utc-stamp>/`.

// The restore operational contract, printed VERBATIM in both the preview and the
// post-restore confirmation so the operator reads the same words scoping the change
// and after committing it. Kept as ONE block so the two paths cannot drift — the
// same discipline as store.ts's CONVERGENCE_CONTRACT.
const RESTORE_CONTRACT = [
  "OPERATIONAL CONTRACT — read before you restore:",
  "  1. Restore REPLACES the live ~/.forge/forge.db with the backup. The atomic",
  "     rename is the ONLY step that touches the live path, and a pre-restore safety",
  "     backup of the CURRENT store is taken first. On failure, forge.db's own bytes",
  "     are left byte-for-byte untouched. Restore REFUSES a live store that still",
  "     carries a -wal/-shm sidecar (an un-checkpointed WAL tail is part of the live",
  "     state and must not be risked): cleanly stop every forge process and open+close",
  "     forge once to checkpoint the WAL, then retry — so there is never an",
  "     un-checkpointed WAL tail to lose in the swap.",
  "  2. STOP ALL forge processes on this FORGE_HOME first — launches, campaigns,",
  "     dashboards, and interactive sessions. --confirm-quiesced ASSERTS you have.",
  "  3. A quiesce PROOF runs immediately before the swap: it fails closed unless it",
  "     can take EXCLUSIVE access to the live store (no active writer holds it). The",
  "     proof does NOT mutate forge.db — it never switches journal_mode. This is a",
  "     BACKSTOP, not a hard fence — an uncooperative writer that predates backup.lock",
  "     is not machine-fenced; your quiescence (point 2) is what makes the window safe,",
  "     exactly the honest limit `forge store converge` documents.",
  "  4. The candidate is fully verified (integrity_check + checksum + schema-version",
  "     gate) BEFORE anything on the live path is touched, and re-verified from its",
  "     staged copy. A backup whose schema version is NEWER than this binary",
  "     understands is REFUSED, not restored.",
  "  5. Recovery: the pre-restore safety backup printed below can itself be restored",
  "     with `forge backup restore <that-dir> --confirm-quiesced`.",
].join("\n");

export function registerBackup(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Create, verify, and restore point-in-time backups of the shared forge SQLite store " +
        "(~/.forge/forge.db). Backups live under $FORGE_HOME/backups/<utc-stamp>/ and are owner-only " +
        "(dir 0700, files 0600) — they are as sensitive as the live store.",
    );

  backup
    .command("create")
    .description(
      "Create a point-in-time-consistent backup of the live store using SQLite's online backup " +
        "(safe while forge is running — readers and writers may exist). Opens the store READ-ONLY: it " +
        "never migrates or otherwise mutates it. Writes a .db artifact + manifest.json (creation time, " +
        "forge/schema version, source identity, size, sha256) under $FORGE_HOME/backups/<utc-stamp>/.",
    )
    .option("--source <path>", "path of the store to back up (default: this FORGE_HOME's forge.db)")
    .option("--json", "emit the structured result as JSON")
    .action(async (opts: { source?: string; json?: boolean }) => {
      try {
        const result = await createBackup({ sourcePath: opts.source });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
          return;
        }
        console.log(`forge backup create: wrote ${result.artifactPath}`);
        console.log(
          `  schemaVersion=${result.manifest.schemaVersion}, bytes=${result.manifest.byteSize}, ` +
            `sha256=${result.manifest.sha256}`,
        );
        console.log(`  manifest: ${result.manifestPath}`);
        console.log(
          "This backup is as sensitive as the live store (owner-only perms). Verify it with " +
            "`forge backup verify " + result.backupDir + "`.",
        );
      } catch (e) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
        else console.error(`forge backup create: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  backup
    .command("verify <backup>")
    .description(
      "Verify a backup WITHOUT touching the live store: recompute its sha256 vs the manifest, run " +
        "PRAGMA integrity_check, and apply the schema-version gate. Reports corrupt (checksum/integrity), " +
        "incompatible-newer (schema newer than this binary understands — would be refused on restore), or " +
        "ok (older schema is compatible and will migrate additively on first open).",
    )
    .option("--json", "emit the structured result as JSON")
    .action((backupPath: string, opts: { json?: boolean }) => {
      const result = verifyBackup(backupPath);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`forge backup verify: ${result.backupDir} → ${result.outcome.toUpperCase()}`);
        for (const r of result.reasons) console.log(`  - ${r}`);
        if (result.outcome === "ok" && !result.willMigrateOnFirstOpen) {
          console.log(`  schema version ${result.schemaVersion} matches this binary (${SCHEMA_VERSION}).`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  backup
    .command("restore <backup>")
    .description(
      "Restore a backup over the live store. Validates the candidate into staging, takes a pre-restore " +
        "safety backup of the CURRENT store, and atomically replaces forge.db — the rename is the only step " +
        "that touches the live path, so any failure before it leaves forge.db byte-for-byte untouched. " +
        "Quiesce-gated: refuses unless it can take exclusive access to the live store (a BACKSTOP, not a hard " +
        "fence). Without --confirm-quiesced, only PREVIEWS what would happen.",
    )
    .option(
      "--confirm-quiesced",
      "assert you have stopped ALL forge processes on this FORGE_HOME and actually perform the restore " +
        "(without this flag, only previews)",
    )
    .option("--json", "emit the structured result as JSON")
    .action(async (backupPath: string, opts: { confirmQuiesced?: boolean; json?: boolean }) => {
      // PREVIEW — validate the candidate, print the contract, mutate nothing.
      if (!opts.confirmQuiesced) {
        const verified = verifyBackup(backupPath);
        const preview = { preview: true, wouldRestore: verified.ok, verify: verified, contract: RESTORE_CONTRACT };
        if (opts.json) {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        console.log(`forge backup restore (preview): candidate ${backupPath} → ${verified.outcome.toUpperCase()}`);
        for (const r of verified.reasons) console.log(`  - ${r}`);
        console.log("");
        console.log(RESTORE_CONTRACT);
        console.log("");
        console.log(
          verified.ok
            ? "Re-run with --confirm-quiesced ONLY after you have stopped every forge process on this FORGE_HOME."
            : "The candidate did NOT verify — restore would refuse it. Nothing to confirm.",
        );
        if (!verified.ok) process.exitCode = 1;
        return;
      }

      try {
        const result = await restoreBackup({ backupPath, confirmQuiesced: true });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
          return;
        }
        console.log(`forge backup restore: restored ${result.backupDir} → ${result.targetPath}`);
        console.log(
          result.preRestoreBackupDir
            ? `  pre-restore safety backup of the previous store: ${result.preRestoreBackupDir}`
            : `  (no previous store existed — no pre-restore backup taken)`,
        );
        console.log("");
        console.log(RESTORE_CONTRACT);
      } catch (e) {
        const msg = (e as Error).message;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, refused: e instanceof RestoreRefusedError, error: msg }, null, 2));
        } else {
          console.error(`forge backup restore: ${msg}`);
        }
        process.exitCode = 1;
      }
    });
}
