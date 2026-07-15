import type { Command } from "commander";
import {
  getDb,
  runDestructiveConvergenceMigration,
  DESTRUCTIVE_BOUNDARY_VERSION,
  LEGACY_MODEL_CALLS_COLUMNS,
} from "../../store/db.js";

// FG-568: the operator-facing entry point for the destructive convergence
// migration. runDestructiveConvergenceMigration lives OFF the ordinary open
// path (a DROP there would destroy schema an in-flight old peer still writes
// to), so without this command an operator has no way to converge a
// 0.1.x-migrated store to the fresh model_calls shape or stamp the one-way
// rollback boundary. The migration is quiesce-gated: it refuses unless it can
// leave WAL mode, which is only possible when no other process holds the store.
//
// THE OPERATIONAL CONTRACT — the six points this command surfaces to the
// operator (in the preview, the confirmation, and CONVERGENCE_CONTRACT below);
// stated in full on runDestructiveConvergenceMigration in src/store/db.ts:
//
//   1. `forge store converge` ENDS the supported old/new overlap window.
//   2. Before confirming, the operator must STOP ALL forge processes using that
//      FORGE_HOME — launches, campaigns, dashboards, and interactive sessions.
//   3. The journal-mode gate detects active database locks/snapshots and refuses
//      convergence; it is a BACKSTOP, not proof that every process is dead.
//   4. A pre-FG-568 process that starts or resumes AFTER convergence is OUTSIDE
//      the supported window. Its legacy usage inserts may fail ATOMICALLY and
//      lose one or more telemetry captures until that process exits; they do NOT
//      partially write or corrupt the store.
//   5. The forward schema-version gate CANNOT constrain already-installed UNGATED
//      binaries — a release predating the gate never performs the check. This is
//      an HONEST LIMIT, preserved and restated, not a promise the tool can keep.
//   6. This tool asserts NO PID/process-liveness proof and NO automatic exclusion
//      of idle old binaries. It quiesce-gates and stamps a boundary — nothing more.

// The six-point operational contract, printed VERBATIM in both the preview and
// the confirmation output so the operator sees the same words whether they are
// scoping the change or committing it. Kept as one block so the two paths can
// never drift apart.
const CONVERGENCE_CONTRACT = [
  "OPERATIONAL CONTRACT — read before you converge:",
  "  1. This ENDS the supported old/new overlap window. It is ONE-WAY: once the",
  "     boundary is stamped, a forge that understands only an older schema version",
  "     refuses the store.",
  "  2. STOP ALL forge processes using this FORGE_HOME first — launches, campaigns,",
  "     dashboards, and interactive sessions. --confirm-quiesced ASSERTS you have.",
  "  3. The journal-mode gate detects active locks/snapshots and refuses; it is a",
  "     BACKSTOP, not proof that every process is dead.",
  "  4. A pre-FG-568 process that starts or resumes AFTER convergence is OUTSIDE the",
  "     supported window: its legacy usage inserts may fail ATOMICALLY and lose one",
  "     or more telemetry captures until it exits — they never partially write or",
  "     corrupt the store.",
  "  5. The forward gate CANNOT constrain an already-installed UNGATED old binary",
  "     (it predates the check) — an honest limit, not something this tool fixes.",
  "  6. This tool asserts NO PID/liveness proof and NO automatic exclusion of idle",
  "     old binaries.",
].join("\n");

function presentLegacyColumns(db: ReturnType<typeof getDb>): string[] {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[]).map((c) => c.name),
  );
  return LEGACY_MODEL_CALLS_COLUMNS.filter((c) => present.has(c));
}

export function registerStore(program: Command): void {
  const store = program.command("store").description("Inspect and converge the shared forge SQLite store.");

  store
    .command("converge")
    .description(
      "Run the destructive convergence migration: drop the legacy 0.1.x model_calls columns and stamp the " +
        "one-way rollback boundary. ENDS the supported old/new overlap window — stop ALL forge processes on " +
        "this FORGE_HOME first. Quiesce-gated (a BACKSTOP, not liveness proof): refuses while another forge " +
        "process holds the store.",
    )
    .option(
      "--confirm-quiesced",
      "assert you have stopped ALL forge processes on this FORGE_HOME and actually run the migration " +
        "(without this flag, only previews what would change)",
    )
    .option("--json", "emit the structured result as JSON")
    .action((opts: { confirmQuiesced?: boolean; json?: boolean }) => {
      const db = getDb();
      const stored = db.pragma("user_version", { simple: true }) as number;

      if (!opts.confirmQuiesced) {
        const legacy = presentLegacyColumns(db);
        const preview = {
          preview: true,
          storedVersion: stored,
          boundaryVersion: DESTRUCTIVE_BOUNDARY_VERSION,
          legacyColumnsPresent: legacy,
          wouldDrop: legacy,
          contract: CONVERGENCE_CONTRACT,
        };
        if (opts.json) {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        console.log(
          `forge store converge (preview): user_version=${stored}, boundary=${DESTRUCTIVE_BOUNDARY_VERSION}.`,
        );
        console.log(
          legacy.length
            ? `Would drop legacy model_calls column(s): ${legacy.join(", ")}.`
            : `No legacy model_calls columns present — the migration would only stamp the boundary.`,
        );
        console.log("");
        console.log(CONVERGENCE_CONTRACT);
        console.log("");
        console.log(
          "Re-run with --confirm-quiesced ONLY after you have stopped every forge process on this FORGE_HOME.",
        );
        return;
      }

      let result: { dropped: string[]; boundaryVersion: number };
      try {
        result = runDestructiveConvergenceMigration(db);
      } catch (e) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
        } else {
          console.error(`forge store converge: ${(e as Error).message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, contract: CONVERGENCE_CONTRACT, ...result }, null, 2));
        return;
      }
      console.log(
        result.dropped.length
          ? `forge store converge: dropped ${result.dropped.join(", ")}; stamped boundary version ${result.boundaryVersion}.`
          : `forge store converge: no legacy columns to drop; boundary version ${result.boundaryVersion} in force.`,
      );
      console.log("");
      console.log(CONVERGENCE_CONTRACT);
      console.log("");
      console.log(
        "The old/new overlap window is now CLOSED for this store. A pre-FG-568 process that resumes against " +
          "it is outside the supported window (point 4).",
      );
    });
}
