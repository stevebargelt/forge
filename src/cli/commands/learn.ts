import type { Command } from "commander";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import {
  detectFailedRuns,
  extractFailureLogs,
  runHeadroomLearn,
  parseSeedCorrections,
  projectDirsFromFailedRuns,
} from "../../v2/headroom-learn.js";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description("Mine failed runs with headroom learn to generate agent seed improvements")
    .option("--agent-role <role>", "filter to a specific agent role (e.g. engineer, tech-lead)")
    .option("--project <dir>", "project directory to analyze (default: cwd)")
    .option("--since <days>", "only consider runs from the last N days (default: 30)", "30")
    .option("--limit <n>", "max failed tasks to surface (default: 50)", "50")
    .option("--apply", "write seed corrections (default: dry-run, shows proposed changes)")
    .option("--model <model>", "LLM model for headroom learn analysis")
    .option("--json", "emit structured JSON output")
    .action(async (opts: {
      agentRole?: string;
      project?: string;
      since?: string;
      limit?: string;
      apply?: boolean;
      model?: string;
      json?: boolean;
    }) => {
      ensureForgeDirs();

      const projectDir = resolve(opts.project ?? process.cwd());
      const sinceMs = Date.now() - parseInt(opts.since ?? "30", 10) * 86_400_000;
      const limit = parseInt(opts.limit ?? "50", 10);

      // 1. Find failed runs from SQLite.
      const failedRuns = detectFailedRuns({
        agentRole: opts.agentRole,
        sinceMs,
        limit,
      });

      if (failedRuns.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ failedRunsFound: 0, projectsAnalyzed: [], corrections: [] }, null, 2));
        } else {
          console.log("No failed runs found in the requested window. Nothing to learn from.");
        }
        return;
      }

      // 2. Determine project dirs to analyze (from run metadata, or fallback to cwd).
      const projectDirs = projectDirsFromFailedRuns(failedRuns);
      const targets = projectDirs.length > 0 ? projectDirs : [projectDir];

      if (!opts.json) {
        const roleLabel = opts.agentRole ? ` for agent '${opts.agentRole}'` : "";
        console.log(`Found ${failedRuns.length} failed task(s)${roleLabel} across ${targets.length} project(s).`);
        if (!opts.apply) {
          console.log(`Running headroom learn in dry-run mode. Pass --apply to write corrections.\n`);
        } else {
          console.log(`Running headroom learn with --apply. Corrections will be written.\n`);
        }
      }

      // 3. Run headroom learn for each project dir.
      const allCorrections: Array<{ projectDir: string; file: string; summary: string }> = [];
      const learnOutputs: Array<{ projectDir: string; stdout: string; stderr: string; exitCode: number }> = [];

      for (const dir of targets) {
        const result = runHeadroomLearn({ projectDir: dir, apply: opts.apply, model: opts.model });
        learnOutputs.push({ projectDir: dir, ...result });

        const corrections = parseSeedCorrections(result.stdout + "\n" + result.stderr);
        for (const c of corrections) {
          allCorrections.push({ projectDir: dir, ...c });
        }

        if (!opts.json) {
          console.log(`── ${dir}`);
          if (result.stdout) console.log(result.stdout.trimEnd());
          if (result.stderr && result.exitCode !== 0) console.error(result.stderr.trimEnd());
          console.log();
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          failedRunsFound: failedRuns.length,
          projectsAnalyzed: targets,
          corrections: allCorrections,
          applied: opts.apply ?? false,
          outputs: learnOutputs,
        }, null, 2));
        return;
      }

      // 4. Summarize corrections and optionally prompt to apply.
      if (allCorrections.length === 0) {
        console.log("headroom learn found no actionable corrections.");
        return;
      }

      console.log(`Proposed corrections (${allCorrections.length}):`);
      for (const c of allCorrections) {
        console.log(`  ${c.summary}`);
      }

      if (!opts.apply) {
        console.log(`\nReview the output above, then run with --apply to write changes.`);
      } else {
        console.log(`\nCorrections applied.`);
      }
    });
}
