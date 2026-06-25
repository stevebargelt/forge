import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCampaign, resolvePlan } from "../../campaign/planner.js";
import type { PlannerInput, PlanMode } from "../../campaign/planner.js";
import { listCampaignItems, getCampaign, approveCampaign, tryTransitionCampaign } from "../../store/campaigns.js";
import { startCampaign, resumeCampaign } from "../../campaign/executor.js";
import { assembleCampaignShow, assembleCampaignReport } from "../../campaign/report.js";

export function registerCampaign(program: Command): void {
  const campaign = program
    .command("campaign")
    .description("Campaign planning and management");

  campaign
    .command("plan")
    .description("Plan a campaign from tickets, epic, or mixed input — persists and prints, does not execute")
    .option("--tickets <ids>", "comma-separated explicit ordered ticket ids (list input)")
    .option("--epic <id>", "an epic id (epic or mixed input)")
    .option("--add <ids>", "comma-separated ticket ids to add, only valid with --epic")
    .option("--exclude <ids>", "comma-separated ticket ids to exclude, only valid with --epic")
    .option("--mode <mode>", "dry_run|pilot|sequential", "dry_run")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "machine-readable JSON output")
    .action((opts: {
      tickets?: string;
      epic?: string;
      add?: string;
      exclude?: string;
      mode?: string;
      project?: string;
      json?: boolean;
    }) => {
      const hasTickets = opts.tickets !== undefined;
      const hasEpic = opts.epic !== undefined;
      const hasAdd = opts.add !== undefined;
      const hasExclude = opts.exclude !== undefined;

      if (hasTickets && hasEpic) {
        throw new Error("--tickets and --epic are mutually exclusive");
      }
      if ((hasAdd || hasExclude) && !hasEpic) {
        throw new Error("--add and --exclude require --epic");
      }
      if (!hasTickets && !hasEpic) {
        throw new Error("must provide either --tickets or --epic");
      }

      const projectDir = resolve(opts.project ?? process.cwd());
      const modeStr = opts.mode ?? "dry_run";
      const VALID_MODES = ["dry_run", "pilot", "sequential"] as const;
      if (!(VALID_MODES as readonly string[]).includes(modeStr)) {
        throw new Error(`invalid --mode "${modeStr}": must be one of ${VALID_MODES.join(", ")}`);
      }
      const mode = modeStr as PlanMode;

      let input: PlannerInput;
      if (hasTickets) {
        const ticketIds = opts.tickets!.split(",").map((s) => s.trim()).filter(Boolean);
        input = { kind: "list", ticketIds };
      } else if (hasAdd || hasExclude) {
        const additions = opts.add
          ? opts.add.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        const exclusions = opts.exclude
          ? opts.exclude.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        input = { kind: "mixed", epicId: opts.epic!, additions, exclusions };
      } else {
        input = { kind: "epic", epicId: opts.epic! };
      }

      const result = planCampaign(input, { projectDir, mode });
      const items = listCampaignItems(result.campaign.id);

      const orderedItems = items.map((item) => ({
        order: item.itemOrder,
        ticketId: item.ticketId,
        lifecycleStatus: item.lifecycleStatus,
      }));

      if (opts.json) {
        console.log(JSON.stringify({
          campaignId: result.campaign.id,
          orderedItems,
          canonicalContent: result.canonicalContent,
          planHash: result.planHash,
        }, null, 2));
      } else {
        console.log(`Campaign: ${result.campaign.id}`);
        console.log(`Plan hash: ${result.planHash}`);
        console.log(`Mode: ${result.campaign.mode}`);
        console.log("Items:");
        for (const item of orderedItems) {
          console.log(`  ${item.order}: ${item.ticketId} [${item.lifecycleStatus}]`);
        }
        console.log("Canonical content:");
        console.log(JSON.stringify(result.canonicalContent, null, 2));
      }
    });

  campaign
    .command("approve <campaign-id>")
    .description("Approve a planned campaign, recording the current plan hash as the approved baseline")
    .requiredOption("--rationale <text>", "approval rationale")
    .option("--by <operator>", "operator identifier")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, opts: { rationale: string; by?: string; json?: boolean }) => {
      const existing = getCampaign(campaignId);
      if (!existing) {
        process.stderr.write(`Error: campaign ${campaignId} not found\n`);
        process.exit(1);
      }
      if (existing.status !== "planned") {
        process.stderr.write(`Error: campaign ${campaignId} is not in planned state (status: ${existing.status})\n`);
        process.exit(1);
      }

      // Validate projectDir
      const projectDir = existing.projectDir;
      if (!projectDir) {
        process.stderr.write(
          `Error: campaign predates projectDir capture; re-plan with forge campaign plan\n`
        );
        process.exit(1);
      }
      if (!existsSync(projectDir) || !existsSync(join(projectDir, "backlog"))) {
        process.stderr.write(`Error: campaign projectDir is invalid or missing backlog: ${projectDir}\n`);
        process.exit(1);
      }

      // Non-fatal staleness warning
      if (existing.planHash) {
        try {
          const sourceInput = existing.sourceInput as { kind: string; ticketIds?: string[]; epicId?: string; additions?: string[]; exclusions?: string[] };
          let plannerInput: PlannerInput;
          if (sourceInput["kind"] === "list") {
            plannerInput = { kind: "list", ticketIds: (sourceInput["ticketIds"] ?? []) };
          } else if (sourceInput["kind"] === "epic") {
            plannerInput = { kind: "epic", epicId: sourceInput["epicId"] as string };
          } else {
            plannerInput = { kind: "mixed", epicId: sourceInput["epicId"] as string, additions: sourceInput["additions"], exclusions: sourceInput["exclusions"] };
          }
          const { planHash: currentHash } = resolvePlan(plannerInput, {
            projectDir,
            mode: existing.mode as PlanMode,
          });
          if (currentHash !== existing.planHash) {
            process.stderr.write(
              `Warning: backlog has changed since this campaign was planned — plan is already stale.\n` +
              `Approving the current plan hash anyway. Re-plan and re-approve to reset the baseline.\n`
            );
          }
        } catch {
          // Non-fatal: warn if we can detect staleness, skip if backlog resolution fails
        }
      }

      const ok = approveCampaign(campaignId, { approvedBy: opts.by, rationale: opts.rationale });
      if (!ok) {
        process.stderr.write(`Error: campaign ${campaignId} could not be approved (not in planned state)\n`);
        process.exit(1);
      }

      const approved = getCampaign(campaignId)!;
      if (opts.json) {
        console.log(JSON.stringify({
          campaignId,
          approvedBy: approved.approvedBy ?? null,
          approvedAt: approved.approvedAt,
          approvedPlanHash: approved.approvedPlanHash,
        }, null, 2));
      } else {
        console.log(`Campaign ${campaignId} approved.`);
        if (approved.approvedBy) console.log(`Approved by: ${approved.approvedBy}`);
        console.log(`Approved at: ${approved.approvedAt}`);
        console.log(`Approved plan hash: ${approved.approvedPlanHash}`);
      }
    });

  campaign
    .command("start <campaign-id>")
    .description("Start executing a planned, approved campaign sequentially")
    .option("--project <dir>", "verify the stored campaign projectDir matches this path (does not override it)")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, opts: { project?: string; json?: boolean }) => {
      if (opts.project) {
        const resolvedProject = resolve(opts.project);
        const existing = getCampaign(campaignId);
        if (!existing) {
          process.stderr.write(`Error: campaign ${campaignId} not found\n`);
          process.exit(1);
        }
        if (existing.projectDir !== resolvedProject) {
          process.stderr.write(
            `Error: --project ${resolvedProject} does not match stored campaign projectDir ${existing.projectDir ?? "(none)"}\n` +
            `Campaign always executes against its stored project directory.\n`
          );
          process.exit(1);
        }
      }

      const result = await startCampaign(campaignId);

      const refusalReasons = new Set([
        "not_planned",
        "no_project_dir",
        "invalid_project_dir",
        "dry_run_not_executable",
        "not_approved",
        "stale_plan",
        "already_running",
      ]);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Stop reason: ${result.stopReason}`);
        for (const rec of result.itemRecords) {
          const outcomeStr = rec.outcome ? ` (outcome: ${rec.outcome})` : "";
          console.log(`  ${rec.ticketId}: ${rec.lifecycleStatus}${outcomeStr}${rec.runId ? ` [run: ${rec.runId}]` : ""}`);
        }

        if (result.stopReason === "dry_run_not_executable") {
          console.error("campaign is dry_run (plan-and-report only) — re-plan with --mode pilot or --mode sequential to execute");
        } else if (result.stopReason === "no_project_dir") {
          console.error("campaign predates projectDir capture; re-plan with forge campaign plan");
        } else if (result.stopReason === "invalid_project_dir") {
          console.error("campaign projectDir is missing or has no backlog");
        } else if (result.stopReason === "not_approved") {
          console.error("campaign has not been approved; run: forge campaign approve <id> --rationale <text>");
        } else if (result.stopReason === "stale_plan") {
          console.error("campaign plan is stale — backlog changed since approval; re-plan and re-approve");
        } else if (result.stopReason === "already_running") {
          console.error("campaign is already running (concurrent start attempt refused)");
        } else if (result.stopReason === "not_planned") {
          console.error("campaign is not in planned state");
        }
      }

      if (refusalReasons.has(result.stopReason)) {
        process.exit(1);
      }
    });

  campaign
    .command("pause <campaign-id>")
    .description("Pause a running campaign (cooperative: the current item finishes first)")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, opts: { json?: boolean }) => {
      const existing = getCampaign(campaignId);
      if (!existing) {
        process.stderr.write(`Error: campaign ${campaignId} not found\n`);
        process.exit(1);
      }
      if (!tryTransitionCampaign(campaignId, "running", "paused")) {
        const current = getCampaign(campaignId);
        process.stderr.write(
          `Error: campaign is ${current?.status ?? "unknown"}; only a running campaign can be paused\n`
        );
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({
          campaignId,
          status: "paused",
          note: "pause takes effect between items; the current item finishes first",
        }, null, 2));
      } else {
        console.log(`Campaign ${campaignId} paused.`);
        console.log("Note: pause takes effect between items; the current item finishes first.");
      }
    });

  campaign
    .command("resume <campaign-id>")
    .description("Resume a paused campaign — blocks until pause/failure/complete (like start)")
    .option("--project <dir>", "verify the stored campaign projectDir matches this path (does not override it)")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, opts: { project?: string; json?: boolean }) => {
      if (opts.project) {
        const resolvedProject = resolve(opts.project);
        const existing = getCampaign(campaignId);
        if (!existing) {
          process.stderr.write(`Error: campaign ${campaignId} not found\n`);
          process.exit(1);
        }
        if (existing.projectDir !== resolvedProject) {
          process.stderr.write(
            `Error: --project ${resolvedProject} does not match stored campaign projectDir ${existing.projectDir ?? "(none)"}\n` +
            `Campaign always executes against its stored project directory.\n`
          );
          process.exit(1);
        }
      }

      const result = await resumeCampaign(campaignId);

      const refusalReasons = new Set([
        "not_paused",
        "no_project_dir",
        "invalid_project_dir",
        "not_approved",
        "stale_plan",
        "already_running",
        "abandoned",
      ]);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Stop reason: ${result.stopReason}`);
        for (const rec of result.itemRecords) {
          const outcomeStr = rec.outcome ? ` (outcome: ${rec.outcome})` : "";
          console.log(`  ${rec.ticketId}: ${rec.lifecycleStatus}${outcomeStr}${rec.runId ? ` [run: ${rec.runId}]` : ""}`);
        }

        if (result.stopReason === "not_paused") {
          console.error("campaign is not paused; only a paused campaign can be resumed");
        } else if (result.stopReason === "abandoned") {
          console.error("campaign is abandoned; cannot resume an abandoned campaign");
        } else if (result.stopReason === "no_project_dir") {
          console.error("campaign predates projectDir capture; re-plan with forge campaign plan");
        } else if (result.stopReason === "invalid_project_dir") {
          console.error("campaign projectDir is missing or has no backlog");
        } else if (result.stopReason === "not_approved") {
          console.error("campaign has not been approved; run: forge campaign approve <id> --rationale <text>");
        } else if (result.stopReason === "stale_plan") {
          console.error("campaign plan is stale — backlog changed since approval; re-plan and re-approve");
        } else if (result.stopReason === "already_running") {
          console.error("campaign is already running (concurrent resume attempt refused)");
        } else if (result.stopReason === "paused") {
          console.log("campaign paused between items — run resume again to continue");
        }
      }

      if (refusalReasons.has(result.stopReason)) {
        process.exit(1);
      }
    });

  campaign
    .command("abandon <campaign-id>")
    .description("Abandon a planned, running, or paused campaign (terminal — irreversible)")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, opts: { json?: boolean }) => {
      const existing = getCampaign(campaignId);
      if (!existing) {
        process.stderr.write(`Error: campaign ${campaignId} not found\n`);
        process.exit(1);
      }
      const terminalStatuses = new Set(["complete", "failed", "abandoned"]);
      if (terminalStatuses.has(existing.status)) {
        process.stderr.write(
          `Error: campaign is already ${existing.status} — cannot abandon a terminal campaign\n`
        );
        process.exit(1);
      }
      if (!tryTransitionCampaign(campaignId, existing.status, "abandoned")) {
        const current = getCampaign(campaignId);
        process.stderr.write(
          `Error: campaign is ${current?.status ?? "unknown"} — cannot transition to abandoned\n`
        );
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ campaignId, status: "abandoned" }, null, 2));
      } else {
        console.log(`Campaign ${campaignId} abandoned.`);
      }
    });

  campaign
    .command("show <campaign-id>")
    .description("Show current state of a campaign (read-only)")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, opts: { json?: boolean }) => {
      const result = assembleCampaignShow(campaignId);
      if (!result) {
        process.stderr.write(`Error: campaign ${campaignId} not found\n`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Campaign: ${result.campaignId}`);
      console.log(`Status:   ${result.status}`);
      console.log(`Mode:     ${result.mode}`);
      console.log(`Project:  ${result.projectDir ?? "(none)"}`);
      console.log(`Approved plan hash: ${result.approvedPlanHash ?? "(none)"}`);
      if (result.currentPlanHash) {
        const staleNote = result.planStale ? " (STALE — re-plan required)" : " (current)";
        console.log(`Current plan hash:  ${result.currentPlanHash}${staleNote}`);
      }
      if (result.activeItem) {
        console.log(`Active item: ${result.activeItem.ticketId} [run: ${result.activeItem.runId}]`);
      }
      console.log("Items:");
      for (const item of result.items) {
        const titleStr = item.title ? ` — ${item.title}` : "";
        const outcomeStr = item.outcome ? ` outcome=${item.outcome}` : "";
        const blockerStr = item.blockerKind ? ` blocker=${item.blockerKind}` : "";
        const runStr = item.runId ? ` [run: ${item.runId}]` : "";
        console.log(`  ${item.ticketId}${titleStr}: ${item.lifecycleStatus}${outcomeStr}${blockerStr}${runStr}`);
        if (item.reason) console.log(`    reason: ${item.reason}`);
        if (item.requestedHumanAction) console.log(`    action: ${item.requestedHumanAction}`);
      }
      console.log(`Next action: ${result.nextAction}`);
    });

  campaign
    .command("report <campaign-id>")
    .description("Generate a campaign checkpoint/final report (read-only)")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, opts: { json?: boolean }) => {
      const result = assembleCampaignReport(campaignId);
      if (!result) {
        process.stderr.write(`Error: campaign ${campaignId} not found\n`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Campaign Report: ${result.campaignId}`);
      console.log(`Status:          ${result.status}`);
      console.log(`Mode:            ${result.mode}`);
      if (result.goal) console.log(`Goal:            ${result.goal}`);
      console.log(`Verdict:         ${result.verdict}`);
      console.log(`Safety:          ${result.safetyToContinue}`);
      console.log(`Approved hash:   ${result.approvedPlanHash ?? "(none)"}`);
      if (result.currentPlanHash) {
        console.log(`Current hash:    ${result.currentPlanHash}`);
      }
      if (result.dirtyGitState) {
        console.log(`Dirty git state:\n${result.dirtyGitState}`);
      }
      console.log("Items:");
      for (const item of result.items) {
        const titleStr = item.title ? ` — ${item.title}` : "";
        const outcomeStr = item.outcome ? ` outcome=${item.outcome}` : "";
        const commitStr = item.commit ? ` commit=${item.commit}` : "";
        const blockerStr = item.blockerKind ? ` blocker=${item.blockerKind}` : "";
        const runStr = item.runId ? ` [run: ${item.runId}]` : "";
        console.log(`  ${item.ticketId}${titleStr}: ${item.lifecycleStatus}${outcomeStr}${commitStr}${blockerStr}${runStr}`);
        if (item.reason) console.log(`    reason: ${item.reason}`);
      }
      console.log("Groupings:");
      console.log(`  shipped: ${result.groupings.shipped.join(", ") || "(none)"}`);
      console.log(`  blocked: ${result.groupings.blocked.join(", ") || "(none)"}`);
      console.log(`  held:    ${result.groupings.held.join(", ") || "(none)"}`);
      console.log(`  skipped: ${result.groupings.skipped.join(", ") || "(none)"}`);
      console.log(`  failed:  ${result.groupings.failed.join(", ") || "(none)"}`);
      console.log(`Next operator action: ${result.nextOperatorAction}`);
    });
}
