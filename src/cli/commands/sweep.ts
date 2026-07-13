// #157: `forge sweep` — close phantom-active runs.
//
// A run is "phantom-active" when its status is 'active' but every one of its
// tasks is in a terminal state (complete/failed/blocked_by_red) AND at least
// one task exists. These leaked from the pre-#157 `forge invoke` path which
// marked the task complete but never flipped the run-level status.
//
// Idempotent: re-running on a clean DB is a no-op. Safe with concurrent forge
// processes: writes to existing rows only, no schema change, WAL mode means
// readers don't block.

import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { getDb, writeTransaction } from "../../store/db.js";

type PhantomRow = {
  id: string;
  workflow: string;
  title: string;
  task_count: number;
  last_completed_at: string | null;
  any_failed: number;
};

export function registerSweep(program: Command): void {
  program
    .command("sweep")
    .description("Close phantom-active runs (status=active but all tasks terminal). Fixes the pre-#157 forge invoke leak.")
    .option("--dry-run", "report what would change without writing")
    .option("--limit <n>", "max rows to process (default: all)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of a table")
    .action((opts: { dryRun?: boolean; limit?: number; json?: boolean }) => {
      ensureForgeDirs();
      const phantoms = findPhantomRuns(opts.limit);
      if (phantoms.length === 0) {
        if (opts.json) console.log(JSON.stringify({ swept: 0, runs: [] }, null, 2));
        else console.log("No phantom-active runs found. Nothing to sweep.");
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({
          dryRun: opts.dryRun ?? false,
          swept: opts.dryRun ? 0 : phantoms.length,
          runs: phantoms.map((p) => ({
            id: p.id, workflow: p.workflow, title: p.title,
            taskCount: p.task_count, lastCompletedAt: p.last_completed_at,
            anyFailed: p.any_failed > 0,
          })),
        }, null, 2));
        if (!opts.dryRun) closeRuns(phantoms);
        return;
      }
      console.log(`Found ${phantoms.length} phantom-active run(s):`);
      const idW = Math.min(50, Math.max(2, ...phantoms.map((p) => p.id.length)));
      for (const p of phantoms.slice(0, 20)) {
        const tag = p.any_failed > 0 ? " [had failed task]" : "";
        console.log(`  ${p.id.padEnd(idW)}  ${p.workflow.padEnd(10)}  ${p.task_count} task(s)  ${p.last_completed_at ?? "(no ts)"}${tag}`);
      }
      if (phantoms.length > 20) console.log(`  ... and ${phantoms.length - 20} more`);
      if (opts.dryRun) {
        console.log(`\n(dry-run — no writes)`);
        return;
      }
      const updated = closeRuns(phantoms);
      console.log(`\nClosed ${updated} run(s); status='complete' and completed_at set to MAX(tasks.completed_at).`);
    });
}

function findPhantomRuns(limit?: number): PhantomRow[] {
  const sql = `
    SELECT
      r.id,
      r.workflow,
      r.title,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id)                                                  AS task_count,
      (SELECT MAX(t.completed_at) FROM tasks t WHERE t.run_id = r.id AND t.completed_at IS NOT NULL)        AS last_completed_at,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.status = 'failed')                          AS any_failed
    FROM runs r
    WHERE r.status = 'active'
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id AND t.status NOT IN ('complete','failed','blocked_by_red'))
    ORDER BY last_completed_at DESC NULLS LAST
    ${limit ? "LIMIT ?" : ""}
  `;
  const stmt = getDb({ readOnly: true }).prepare(sql);
  return (limit ? stmt.all(limit) : stmt.all()) as PhantomRow[];
}

function closeRuns(phantoms: PhantomRow[]): number {
  if (phantoms.length === 0) return 0;
  const db = getDb();
  // Flip to 'complete' with completed_at = last task's completed_at. This
  // preserves chronological honesty in the data — the run is recorded as
  // having ended when its work actually ended, not when the sweep ran.
  // Use the existing updateRunStatus shape would always set completedAt to
  // NOW; we want the historical timestamp instead, so direct UPDATE.
  const upd = db.prepare(`UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'active'`);
  return writeTransaction(() => {
    let count = 0;
    for (const p of phantoms) {
      const ts = p.last_completed_at ?? new Date().toISOString();
      const info = upd.run(ts, p.id);
      if (info.changes > 0) count += 1;
    }
    return count;
  });
}
