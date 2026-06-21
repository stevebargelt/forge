import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../../store/db.js";
import { getRun } from "../../store/runs.js";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { renderResearchReport } from "../../v2/report.js";

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Render the research report for a completed research-synthesis run")
    .argument("<run-id>", "run id of a research-synthesis run")
    .option("--out <path>", "write the report to this path instead of (or in addition to) stdout")
    .action(async (runId: string, opts: { out?: string }) => {
      ensureForgeDirs();
      getDb({ readOnly: true });

      const run = getRun(runId);
      if (!run) {
        throw new Error(`forge report: run ${runId} not found`);
      }
      if (run.workflow !== "research-synthesis") {
        throw new Error(`forge report: run ${runId} is not a research-synthesis run`);
      }
      if (run.status !== "complete") {
        console.error(`WARNING: run ${runId} is not yet complete — rendering a draft preview`);
      }

      const { markdown, outputPath } = await renderResearchReport(runId);

      if (opts.out) {
        const outPath = resolve(expandTildePath(opts.out));
        writeFileSync(outPath, markdown.endsWith("\n") ? markdown : markdown + "\n");
        console.error(`forge report: wrote ${outPath}`);
      } else {
        console.log(markdown);
        console.error(`forge report: report at ${outputPath}`);
      }
    });
}
