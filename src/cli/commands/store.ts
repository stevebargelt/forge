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
// prove no other forge process holds the store.

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
      "Run the destructive convergence migration: drop the legacy 0.1.x model_calls columns and stamp the one-way rollback boundary. Quiesce-gated — refuses while another forge process holds the store.",
    )
    .option("--confirm", "actually run the migration (without this flag, only previews what would change)")
    .option("--json", "emit the structured result as JSON")
    .action((opts: { confirm?: boolean; json?: boolean }) => {
      const db = getDb();
      const stored = db.pragma("user_version", { simple: true }) as number;

      if (!opts.confirm) {
        const legacy = presentLegacyColumns(db);
        const preview = {
          preview: true,
          storedVersion: stored,
          boundaryVersion: DESTRUCTIVE_BOUNDARY_VERSION,
          legacyColumnsPresent: legacy,
          wouldDrop: legacy,
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
        console.log("Re-run with --confirm to converge. Requires the store to be quiescent (no other forge process).");
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
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }
      console.log(
        result.dropped.length
          ? `forge store converge: dropped ${result.dropped.join(", ")}; stamped boundary version ${result.boundaryVersion}.`
          : `forge store converge: no legacy columns to drop; boundary version ${result.boundaryVersion} in force.`,
      );
    });
}
