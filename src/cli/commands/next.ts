import type { Command } from "commander";
import { next } from "../../spine/next.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { getRun, setRunProjectDir } from "../../store/runs.js";

export function registerNext(program: Command): void {
  program
    .command("next")
    .argument("<run-id>", "run identifier")
    .option("--project <path>", "project directory to mount into agent containers (persisted on first use; reused on subsequent calls)")
    .description("Advance the run: dispatch pending tasks, or surface what's blocking progress")
    .action(async (runId: string, options) => {
      ensureForgeDirs();
      const projectDir = resolveProjectDir(runId, options.project as string | undefined);
      const result = await next(runId, { projectDir });
      switch (result.kind) {
        case "running":
          console.log(`Run ${runId}: ${result.tasks.length} task(s) running.`);
          for (const t of result.tasks) console.log(`  ⟳ ${t.id} (${t.phase}/${t.agentRole})`);
          break;
        case "awaiting_gate":
          console.log(`Run ${runId}: ${result.tasks.length} task(s) awaiting gate.`);
          for (const t of result.tasks) {
            console.log(`  ⚠ ${t.id} (${t.phase})  →  forge gate ${t.id} advance | reject | request-changes`);
          }
          break;
        case "blocked_by_red":
          console.log(`Run ${runId}: BLOCKED by red verdicts.`);
          for (const t of result.tasks) {
            console.log(`  ✗ ${t.id} (${t.phase})  →  forge show ${t.id}  to view findings`);
            console.log(`    override: forge gate ${t.id} advance --force --rationale "..."`);
          }
          break;
        case "crashed":
          console.log(`Run ${runId}: container crash detected.`);
          for (const t of result.tasks) console.log(`  ☠ ${t.id} (${t.phase}) — ${t.error}`);
          console.log(`Inspect ~/.forge/runs/${runId}/<task-id>/container.stderr.log`);
          break;
        case "dispatched":
          console.log(`Run ${runId}: dispatched phase ${result.phase} (${result.tasks.length} tasks).`);
          console.log(`\nNext:\n  forge next ${runId}`);
          break;
        case "advanced":
          console.log(`Run ${runId}: advanced to phase ${result.phase} (${result.tasks.length} task(s) created).`);
          console.log(`\nNext:\n  forge next ${runId}`);
          break;
        case "complete":
          console.log(`Run ${runId}: complete.`);
          break;
      }
    });
}

// Resolve project_dir: explicit --project wins (and persists on the run for
// next time); otherwise read the previously-stored value; otherwise fall back
// to process.cwd() and persist that. Warns if the explicit value differs from
// the stored one — a real change is fine, but the user should know they're
// reassigning the run's project root.
function resolveProjectDir(runId: string, explicit: string | undefined): string {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (explicit) {
    const prev = setRunProjectDir(runId, explicit);
    if (prev && prev !== explicit) {
      console.error(`[forge] project_dir changed for ${runId}: ${prev} → ${explicit}`);
    }
    return explicit;
  }
  if (run.projectDir) return run.projectDir;
  // First-ever call without --project: fall back to cwd and persist so subsequent
  // calls (CLI or dashboard) can omit the flag.
  const cwd = process.cwd();
  setRunProjectDir(runId, cwd);
  console.error(`[forge] no --project supplied; persisting cwd as project_dir: ${cwd}`);
  return cwd;
}
