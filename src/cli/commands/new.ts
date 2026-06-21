import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { profileStatus } from "../../util/auth-profiles.js";
import { loadWorkflow } from "../../v2/loader.js";
import { startRun, CONTROL_PLANE_METADATA_KEYS } from "../../v2/startRun.js";
import { applyRoutePreflight, preflightEnforceFromEnv } from "../route-preflight.js";

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
    .option("--auth-profile <name>", "inject a captured auth profile (#176) into browser-verify steps so they test the app authenticated")
    .option("--profile <name>", "AWN-7: pin every task in the run (primary/red/fanout) to a model profile (policy mode) — highest profile-selection precedence; no-op without model-policy.yml")
    .option("--route <key>", "#297: the route key you resolved via `forge route explain` — satisfies the dispatch preflight")
    .option("--unrouted", "#297: acknowledge an intentionally unrouted run (suppress the route-preflight warning)")
    .option("--tag <tag>", "FG-28: tag this run for constraint scoping; repeat to add multiple tags (e.g. --tag ios --tag mobile)", (val: string, acc: string[]) => [...acc, val], [] as string[])
    .option("--out <path>", "research-synthesis: write the final report to this path instead of <project>/research/<slug>.md")
    .description("Create a new workflow run (v2 YAML-driven)")
    .action(async (workflowName: string, title: string, options) => {
      ensureForgeDirs();

      const projectDir = expandTildePath((options as { project?: string }).project ?? process.cwd());
      const workspace = expandTildePath((options as { workspace?: string }).workspace ?? process.cwd());

      // #297: route-resolution preflight FIRST — before any credential/Docker work.
      // validateCredsForNewRun() can run an OAuth Docker probe, so a bogus --route
      // (or FORGE_ROUTE_PREFLIGHT=error) must surface here, not after auth work.
      applyRoutePreflight({
        command: "forge new",
        route: (options as { route?: string }).route,
        unrouted: (options as { unrouted?: boolean }).unrouted,
        projectDir,
        enforce: preflightEnforceFromEnv(),
      });

      validateCredsForNewRun();

      // Load YAML (workspace default with project override).
      const workflow = loadWorkflow(workflowName, { projectDir });

      // Build the inputs object from the workflow's declared inputs + CLI flags.
      // The runner validates required inputs in startRun.
      const inputs: Record<string, unknown> = options.meta ? JSON.parse(options.meta) : {};
      assertNoControlPlaneMeta(inputs);
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
        // Don't pre-create a designs/ subdir anymore — with the new flat
        // layout the .pen + PNGs live at designDir root.
        inputs["designDir"] = designDir;
      }

      // #176: validate the auth profile up front so a missing/expired session
      // fails the run at creation, not deep into a browser-verify step.
      const authProfile = (options as { authProfile?: string }).authProfile;
      if (authProfile) {
        const st = profileStatus(authProfile);
        if (!st.exists) {
          throw new Error(`auth profile '${authProfile}' not found — run: forge auth-profile login ${authProfile} --url <url>`);
        }
        if (st.expired) {
          throw new Error(`auth profile '${authProfile}' is expired — run: forge auth-profile login ${authProfile} --url <url>`);
        }
      }

      const reportOutput = (options as { out?: string }).out;
      if (reportOutput) {
        const expandedReportOutput = expandTildePath(reportOutput);
        inputs["reportOutputPath"] = expandedReportOutput;
        console.log(`Report output: ${expandedReportOutput}`);
      }

      const modelProfile = (options as { profile?: string }).profile;
      const tags = (options as { tag: string[] }).tag;

      const { runId } = startRun({
        workflow,
        title,
        inputs,
        projectDir,
        designDir,
        workspace,
        authProfile,
        modelProfile,
        ...(tags.length > 0 ? { tags } : {}),
      });

      console.log(`Created run ${runId}`);
      console.log(`Workflow: ${workflow.name}`);
      console.log(`Title:    ${title}`);
      console.log(`Project:  ${projectDir}`);
      if (designDir) console.log(`Design dir: ${designDir}`);
      console.log(`\nNext:\n  forge next ${runId}`);
    });
}

// --meta is workflow input, not a control-plane backdoor. Reject the reserved
// keys (modelProfile/workspace/designDir/authProfile) so a profile/workspace/
// mount can only be set through its explicit flag, never smuggled in as freeform
// metadata where it would also leak into the task prompt. Exported for testing.
export function assertNoControlPlaneMeta(meta: Record<string, unknown>): void {
  for (const key of CONTROL_PLANE_METADATA_KEYS) {
    if (key in meta) {
      throw new Error(
        `--meta may not set the reserved key '${key}' — use the dedicated flag instead ` +
          `(--profile / --workspace / --design-dir / --auth-profile)`
      );
    }
  }
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
