import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
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

      // Resolve --design-dir for design-touching workflows. Default convention
      // (#67): `<projectDir>/designs/` — the per-project shared design corpus.
      // Override with --design-dir <path> for the legacy "peer dir / shared
      // design system across repos" shape (e.g. `~/code/forge-design/`).
      const designDirRaw =
        (options as { designDir?: string }).designDir
        ?? deriveDefaultDesignDir(workflowName, projectDir);
      const designDir = designDirRaw ? expandTildePath(designDirRaw) : undefined;
      if (designDir) {
        mkdirSync(designDir, { recursive: true });
        // Don't pre-create designs/ or code/ subdirs anymore — with the new
        // flat layout the .pen + PNGs live at designDir root; only the
        // optional HTML code export uses a code/ subdir, and prompt-author
        // creates that at need.
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

// Default design-dir convention (#67): a per-project shared design corpus at
// `<projectDir>/designs/`. Every design-touching run for the same project
// targets the same dir; the corpus grows monotonically. Override with
// `--design-dir <path>` to point at a peer dir or a shared-across-repos
// design system.
//
// Only fires for design-touching workflows; other workflows get no designDir.
// Exported for testing.
export function deriveDefaultDesignDir(workflowName: string, projectDir: string): string | undefined {
  if (!workflowName.includes("ui-design") && !workflowName.includes("design-needed")) return undefined;
  return join(projectDir, "designs");
}

// Project basename helper kept here in case the prompt-author seed or a
// future caller wants a non-overridden hint for naming the .pen file. Not
// currently used at the CLI level — exported for completeness.
export function defaultPenFileName(projectDir: string): string {
  return `${basename(projectDir)}.pen`;
}
