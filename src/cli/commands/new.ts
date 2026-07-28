import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureForgeDirs, expandTildePath } from "../../util/paths.js";
import { resolveProjectMount } from "../../util/resolve-project-mount.js";
import { validateCredsForNewRun } from "../../util/creds.js";
import { profileStatus } from "../../util/auth-profiles.js";
import { loadWorkflow } from "../../v2/loader.js";
import { resolveSeedGeneration } from "../../v2/seed-generation.js";
import type { Workflow } from "../../v2/schema.js";
import { startRun, CONTROL_PLANE_METADATA_KEYS } from "../../v2/startRun.js";
import { assertSelfHostDispatchAllowed } from "../../v2/self-host-guard.js";
import { isWorktreeModeEnabled } from "../../v2/worktree-lifecycle.js";
import { applyRoutePreflight, preflightEnforceFromEnv, validateRouteKeyUnder } from "../route-preflight.js";
import { readTicket } from "../../backlog/structured.js";

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
    .option("--ticket <id>", "FG-472: backlog ticket id backing this run (stored as run.metadata.ticketId); required for workflows with a shipping-reviewer red")
    .option("--auth-profile <name>", "inject a captured auth profile (#176) into browser-verify steps so they test the app authenticated")
    .option("--profile <name>", "AWN-7: pin every task in the run (primary/red/fanout) to a model profile (policy mode) — highest profile-selection precedence; no-op without model-policy.yml")
    .option("--route <key>", "#297: the route key you resolved via `forge route explain` — satisfies the dispatch preflight")
    .option("--unrouted", "#297: acknowledge an intentionally unrouted run (suppress the route-preflight warning)")
    .option("--allow-subproject", "FG-374: intentionally mount a subdir of a git repo (normally an error in automation)")
    .option("--tag <tag>", "FG-28: tag this run for constraint scoping; repeat to add multiple tags (e.g. --tag ios --tag mobile)", (val: string, acc: string[]) => [...acc, val], [] as string[])
    .option("--out <path>", "research-synthesis: write the final report to this path instead of <project>/research/<slug>.md")
    .description("Create a new workflow run (v2 YAML-driven)")
    .action(async (workflowName: string, title: string, options) => {
      ensureForgeDirs();

      // FG-374: resolve the project mount root; hard-fail on suspicious subdir mounts.
      // new.ts has no --json flag; isTTY determines interactive vs automation path.
      const { projectDir, invocationCwd, resolvedFromSubdir, explicitSubproject } = resolveProjectMount(
        (options as { project?: string }).project,
        {
          isTTY: process.stdout.isTTY ?? false,
          json: false,
          allowSubproject: (options as { allowSubproject?: boolean }).allowSubproject ?? false,
        }
      );
      // FG-612: refuse a self-host dispatch before any cred/Docker work and
      // before the run and task rows exist. The workflow dispatch this run feeds
      // provisions a workspace per task when worktree mode is on, so the guard
      // gets that same answer here.
      assertSelfHostDispatchAllowed(projectDir, isWorktreeModeEnabled() ? "isolated" : "not-armed");

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

      // FG-583: resolve the seed generation ONCE at dispatch entry and thread the
      // same anchor through the workflow load AND the routeReceipt resolution, so
      // this run is pinned to ONE complete generation across workflows/runtimes and
      // the policy axis (Risk#1).
      const seedGeneration = resolveSeedGeneration();

      // FG-583 (finding 3): the CLI preflight above validated --route LIVE (advisory,
      // #297). But a concurrent `forge upgrade` promoting a new generation between
      // that live check and THIS anchor would leave the route validated only against
      // the OLD generation while the run dispatches under the anchored one. So re-
      // validate the resolved route under the SAME anchored generation this run uses
      // — the authoritative check. On a mismatch, refuse and direct re-resolution
      // rather than dispatch a route no longer valid under the anchored policy.
      const routeKey = (options as { route?: string }).route;
      if (routeKey !== undefined) {
        const anchored = validateRouteKeyUnder(routeKey, projectDir, seedGeneration);
        if (!anchored.ok) {
          process.stderr.write(
            `forge new: --route "${routeKey}" is not valid under the seed generation this run anchored ` +
              `(a promotion may have interleaved since route resolution) — ${anchored.message}\n` +
              `Re-resolve the route and retry:  forge route explain <route-key> --json\n`,
          );
          process.exit(2);
        }
      }

      const workflow = loadWorkflow(workflowName, { projectDir, seedGeneration });

      // Build the inputs object from the workflow's declared inputs + CLI flags.
      // The runner validates required inputs in startRun.
      const inputs: Record<string, unknown> = options.meta ? JSON.parse(options.meta) : {};
      assertNoControlPlaneMeta(inputs);
      if (options.brief) inputs["brief"] = options.brief;
      if (options.question) inputs["question"] = options.question;
      if (options.prd) inputs["prd"] = options.prd;

      // FG-472: workflows carrying an authoritative shipping-reviewer need a
      // backlog ticket to review against (acceptance criteria, non-goals) — fail
      // BEFORE creating the run rather than letting the reviewer pre-fail deep
      // into the build phase. --ticket is the documented path; --meta ticketId
      // still works for back-compat but the two must agree if both are given.
      const ticketId = resolveTicketId({
        workflow,
        projectDir,
        ticketOption: (options as { ticket?: string }).ticket,
        metaTicketId: inputs["ticketId"] !== undefined ? String(inputs["ticketId"]) : undefined,
      });
      if (ticketId) inputs["ticketId"] = ticketId;

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
        invocationCwd,
        resolvedFromSubdir,
        explicitSubproject,
        seedGeneration,
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

// FG-472: true when any step in the workflow carries any shipping-reviewer
// red (regardless of authority), matching the runtime pre-fail block in
// runNext.ts which does not filter on authority — that red pre-fails (and
// blocks the gate) without a backlog ticket to review against, so `forge new`
// must demand --ticket up front rather than let the run reach that phase and
// die there. Exported for testing.
export function workflowRequiresTicket(workflow: Workflow): boolean {
  return workflow.steps.some((step) =>
    step.reds.some((red) => red.agent === "shipping-reviewer")
  );
}

// FG-472: resolves the ticket id backing this run and validates it BEFORE the
// caller creates the run row — `--ticket` is the documented flag; `--meta
// ticketId` still works for back-compat, but the two must agree if both are
// given. Throws on: disagreement, a required-but-missing ticket, or an id that
// doesn't resolve to a real backlog ticket. Exported for testing.
export function resolveTicketId(args: {
  workflow: Workflow;
  projectDir: string;
  ticketOption?: string;
  metaTicketId?: string;
}): string | undefined {
  const { workflow, projectDir, ticketOption, metaTicketId } = args;
  if (ticketOption && metaTicketId && ticketOption !== metaTicketId) {
    throw new Error(
      `--ticket ${ticketOption} conflicts with --meta ticketId ${metaTicketId} — pass only one`
    );
  }
  const ticketId = ticketOption ?? metaTicketId;
  if (workflowRequiresTicket(workflow) && !ticketId) {
    throw new Error(
      `workflow '${workflow.name}' requires --ticket <id> because shipping-reviewer needs backlog acceptance criteria`
    );
  }
  if (ticketId) {
    try {
      readTicket(projectDir, ticketId);
    } catch {
      throw new Error(`--ticket ${ticketId} not found in backlog under ${projectDir}/backlog/ (ideas|epics|stories|done)`);
    }
  }
  return ticketId;
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
