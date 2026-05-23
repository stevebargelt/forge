import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { ensureForgeDirs, sanitizeTitleForFilename, expandTildePath } from "../../util/paths.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { loadWorkflow } from "../../v2/loader.js";
import { startRun } from "../../v2/startRun.js";

// v2: workflow names are arbitrary YAML files in ~/.forge/workflows/.
// We don't enforce a fixed list; the loader raises if the YAML is missing.

export function registerNew(program: Command): void {
  program
    .command("new")
    .argument("<workflow>", "workflow name — looks up ~/.forge/workflows/<name>.yml (or <project>/.forge/workflows/<name>.yml)")
    .argument("<title>", "human-readable run title (used to derive the run id)")
    .option("--brief <text>", "freeform brief input passed into the workflow")
    .option("--question <q>", "question input (legacy: investigation workflows)")
    .option("--prd <path>", "PRD path input (legacy: feature-ui-design-provided)")
    .option("--design-dir <path>", "design artifact directory; mounted RO at /design in agent containers")
    .option("--project <path>", "project directory mounted at /project (default: cwd; persisted on run)")
    .option("--workspace <path>", "orchestrator's workspace dir (default: cwd). For per-workspace `forge status` filtering. Distinct from --project when an audit workspace targets external repos.")
    .option("--meta <json>", "extra run metadata as JSON")
    .description("Create a new workflow run (v2 YAML-driven)")
    .action(async (workflowName: string, title: string, options) => {
      validateCredsForNewRun();
      ensureForgeDirs();

      const projectDir = expandTildePath((options as { project?: string }).project ?? process.cwd());
      const workspace = expandTildePath((options as { workspace?: string }).workspace ?? process.cwd());

      // Load YAML (workspace default with project override).
      const workflow = loadWorkflow(workflowName, { projectDir });

      // Build the inputs object from the workflow's declared inputs + CLI flags.
      // The runner validates required inputs in startRun.
      const inputs: Record<string, unknown> = options.meta ? JSON.parse(options.meta) : {};
      if (options.brief) inputs["brief"] = options.brief;
      if (options.question) inputs["question"] = options.question;
      if (options.prd) inputs["prd"] = options.prd;

      // Resolve --design-dir or derive a default for workflows that name suggests
      // (kept matching v1 ergonomics — the new RACI model means design is now
      // a host-led activity, but `feature-ui-design-needed` still uses /design).
      const designDirRaw =
        (options as { designDir?: string }).designDir
        ?? deriveDefaultDesignDir(workflowName, title);
      const designDir = designDirRaw ? expandTildePath(designDirRaw) : undefined;
      if (designDir) {
        mkdirSync(designDir, { recursive: true });
        mkdirSync(`${designDir}/designs`, { recursive: true });
        mkdirSync(`${designDir}/code`, { recursive: true });
        inputs["designDir"] = designDir;
      }

      const { runId } = startRun({
        workflow,
        title,
        inputs,
        projectDir,
        designDir,
        workspace,
      });

      console.log(`Created run ${runId}`);
      console.log(`Workflow: ${workflow.name}`);
      console.log(`Title:    ${title}`);
      console.log(`Project:  ${projectDir}`);
      if (designDir) console.log(`Design dir: ${designDir}`);
      console.log(`\nNext:\n  forge next ${runId}`);
    });
}

// Default design-dir convention: ~/code/<sanitized-title>/. Matches v1 ergonomics
// for the feature-ui-design-needed workflow.
function deriveDefaultDesignDir(workflowName: string, title: string): string | undefined {
  if (!workflowName.includes("ui-design") && !workflowName.includes("design-needed")) return undefined;
  const home = process.env.HOME ?? "~";
  return `${home}/code/${sanitizeTitleForFilename(title)}`;
}
