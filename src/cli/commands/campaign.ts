import type { Command } from "commander";
import { resolve } from "node:path";
import { planCampaign } from "../../campaign/planner.js";
import type { PlannerInput, PlanMode } from "../../campaign/planner.js";
import { listCampaignItems } from "../../store/campaigns.js";

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
}
