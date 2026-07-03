import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCampaign, resolvePlan, sourceInputToPlannerInput } from "../../campaign/planner.js";
import type { PlannerInput, PlanMode, ItemModeOverride, ExecutionLane } from "../../campaign/planner.js";
import { classifyItemsForPlan } from "../../campaign/lane-classifier.js";
import type { ClassifyTicketFn } from "../../campaign/lane-classifier.js";
import { listCampaignItems, getCampaign, approveCampaign, tryTransitionCampaign } from "../../store/campaigns.js";
import { startCampaign, resumeCampaign, escalateCampaignItemLane, hasUnresolvedLaneEscalation } from "../../campaign/executor.js";
import { assembleCampaignShow, assembleCampaignReport, renderCampaignReportHuman } from "../../campaign/report.js";
import { reconcileCampaign } from "../../campaign/reconcile.js";
import { describeMissingReason } from "../../campaign/reconcile-evidence.js";
import { listTickets } from "../../backlog/structured.js";

// FG-442: builds the injectable classifyTicket judgment for `forge campaign
// plan --routes`. The judgment itself (ticketId -> routeKey) is supplied by the
// caller — an operator or orchestrator who has already read the ticket and
// decided its route (e.g. via `forge route explain`) — never inferred here by
// keyword-matching ticket content (the RACI invariant). Tickets absent from the
// map classify as an unmatched route key, which lane-classifier.ts's
// projectRouteToLane deterministically projects to lane 'manual'.
function makeRouteLookupClassifier(routes: Record<string, string>): ClassifyTicketFn {
  return (ticket) => routes[ticket.id] ?? "unclassified";
}

function recoveryGuidanceMessage(rec: { ticketId: string; lifecycleStatus: string; runId?: string | undefined } | undefined): string {
  if (rec) {
    const runPart = rec.runId ? ` (run ${rec.runId})` : "";
    return `recovery needed: item ${rec.ticketId} is ${rec.lifecycleStatus}${runPart} — inspect the run; reset the item to pending or mark it failed before retrying`;
  }
  return "recovery needed: campaign has an in-flight item that must be resolved before retrying";
}

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
    .option(
      "--routes <json>",
      "JSON map of ticketId -> compiled routing-policy route key (e.g. implementation_quick), supplying the FG-442 lane judgment for each ticket. Tickets omitted here are unclassified (lane 'manual'). Omit --routes entirely to skip classification and keep every item on the full_feature default."
    )
    .option("--json", "machine-readable JSON output")
    .action((opts: {
      tickets?: string;
      epic?: string;
      add?: string;
      exclude?: string;
      mode?: string;
      project?: string;
      routes?: string;
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

      // FG-442: run the lane classifier OUTSIDE resolvePlan/planCampaign, at
      // plan-authoring time — the one-time cost per plan. Only when --routes
      // supplies a real ticket->route judgment; otherwise every item keeps the
      // full_feature default (planner.ts's own fold logic), preserving current
      // behavior when no judgment source is wired in.
      if (opts.routes) {
        let routes: Record<string, string>;
        try {
          routes = JSON.parse(opts.routes) as Record<string, string>;
        } catch {
          throw new Error("--routes must be valid JSON: a map of ticketId -> route key");
        }
        const { resolvedIds } = resolvePlan(input, { projectDir, mode });
        const tickets = listTickets(projectDir).filter((t) => resolvedIds.includes(t.id));
        const classified = classifyItemsForPlan(tickets, {
          projectDir,
          classifyTicket: makeRouteLookupClassifier(routes),
        });
        input = { ...input, itemOverrides: { ...(input.itemOverrides ?? {}), ...classified.itemOverrides } };
      }

      const result = planCampaign(input, { projectDir, mode });
      const items = listCampaignItems(result.campaign.id);
      const laneByTicketId = new Map(
        (result.canonicalContent.orderedItems ?? []).map((entry) => [entry.ticketId, entry])
      );

      const orderedItems = items.map((item) => {
        const laneEntry = laneByTicketId.get(item.ticketId);
        return {
          order: item.itemOrder,
          ticketId: item.ticketId,
          lifecycleStatus: item.lifecycleStatus,
          lane: laneEntry?.lane ?? "full_feature",
          laneRationale: laneEntry?.laneRationale ?? "no lane override supplied — defaulting to full_feature",
        };
      });

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
          console.log(`  ${item.order}: ${item.ticketId} [${item.lifecycleStatus}] lane=${item.lane} — ${item.laneRationale}`);
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
      // FG-442: 'paused' is also a valid pre-approve state — the escalation path
      // (escalateCampaignItemLane) produces a fresh unapproved plan_hash on a
      // paused campaign, and this is the SAME confirm/override point used at
      // first approval, not a new command.
      if (existing.status !== "planned" && existing.status !== "paused") {
        process.stderr.write(`Error: campaign ${campaignId} is not in a state that can be approved (status: ${existing.status})\n`);
        process.exit(1);
      }

      // FG-442: refuse to rubber-stamp a paused-for-lane_escalation campaign whose
      // plan_hash hasn't actually changed — that would record a false "approved"
      // signal without a genuine escalateCampaignItemLane fix having happened. The
      // normal planned-campaign approve path and re-approval AFTER a real escalate
      // (which always produces a fresh plan_hash) are both unaffected.
      if (existing.status === "paused" && existing.planHash === existing.approvedPlanHash) {
        const items = listCampaignItems(campaignId);
        if (hasUnresolvedLaneEscalation(items)) {
          process.stderr.write(
            `Error: campaign ${campaignId} is paused on an unresolved lane escalation and its plan hash has not changed since the last approval — ` +
            `run forge campaign escalate-lane ${campaignId} <ticket-id> --new-lane <lane> --rationale <text> first, then approve\n`
          );
          process.exit(1);
        }
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
          const plannerInput = sourceInputToPlannerInput(existing.sourceInput);
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

      // FG-442: restate the lane basis being recorded — the approve gate is the
      // confirm/override point for lanes too, whether this is the first
      // approval or a re-approval after a lane escalation.
      const planContent = existing.metadata?.["planContent"] as Record<string, unknown> | undefined;
      const orderedItemsForApproval = Array.isArray(planContent?.["orderedItems"])
        ? (planContent!["orderedItems"] as Array<Record<string, unknown>>)
        : [];
      if (!opts.json && orderedItemsForApproval.length > 0) {
        console.log("Lane basis being recorded:");
        for (const entry of orderedItemsForApproval) {
          console.log(`  ${entry["ticketId"]}: lane=${entry["lane"] ?? "full_feature"} — ${entry["laneRationale"] ?? "no lane override supplied — defaulting to full_feature"}`);
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
          laneBasis: orderedItemsForApproval.map((entry) => ({
            ticketId: entry["ticketId"],
            lane: entry["lane"] ?? "full_feature",
            laneRationale: entry["laneRationale"] ?? "no lane override supplied — defaulting to full_feature",
          })),
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

      // Exit 0 only for clean completion states; all other stop reasons are failures
      const startSuccessReasons = new Set(["complete", "paused"]);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Stop reason: ${result.stopReason}`);
        for (const rec of result.itemRecords) {
          const outcomeStr = rec.outcome ? ` (outcome: ${rec.outcome})` : "";
          console.log(`  ${rec.ticketId}: ${rec.lifecycleStatus}${outcomeStr}${rec.runId ? ` [run: ${rec.runId}]` : ""}`);
        }

        if (result.stopReason === "recovery_needed") {
          console.error(recoveryGuidanceMessage(result.itemRecords[0]));
        } else if (result.stopReason === "dry_run_not_executable") {
          console.error("campaign is dry_run (plan-and-report only) — re-plan with --mode pilot or --mode sequential to execute");
        } else if (result.stopReason === "no_project_dir") {
          console.error("campaign predates projectDir capture; re-plan with forge campaign plan");
        } else if (result.stopReason === "invalid_project_dir") {
          console.error("campaign projectDir is missing or has no backlog");
        } else if (result.stopReason === "not_approved") {
          console.error("campaign has not been approved; run: forge campaign approve <id> --rationale <text>");
        } else if (result.stopReason === "stale_plan") {
          console.error("campaign plan is stale — backlog changed since approval; re-plan and re-approve");
        } else if (result.stopReason === "plan_unresolvable") {
          console.error("campaign plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan");
        } else if (result.stopReason === "already_running") {
          console.error("campaign is already running (concurrent start attempt refused)");
        } else if (result.stopReason === "not_planned") {
          console.error("campaign is not in planned state");
        } else if (result.stopReason === "item_failed") {
          console.error("campaign stopped — an item failed during execution; inspect the failed item and re-plan or abandon");
        } else if (result.stopReason === "abandoned") {
          console.error("campaign was abandoned during execution");
        } else if (result.stopReason === "paused") {
          const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
          const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");
          const blocked = result.itemRecords.filter((r) => r.outcome === "blocked");
          if (readinessHeld.length) {
            const heldIds = readinessHeld.map((r) => r.ticketId).join(", ");
            console.error(`campaign paused — ${readinessHeld.length} item(s) not ready: refine ${heldIds} then resume`);
          } else if (dependencyHeld.length) {
            const heldIds = dependencyHeld.map((r) => r.ticketId).join(", ");
            const reasonPart = dependencyHeld.length === 1 && dependencyHeld[0]?.reason ? ` (${dependencyHeld[0].reason})` : "";
            console.error(`campaign paused — ${dependencyHeld.length} item(s) held pending an unresolved blocker: ${heldIds}${reasonPart}; resolve the blocker (see forge campaign show/report) then resume`);
          } else if (blocked.length) {
            console.error(`campaign paused — ${blocked.length} item(s) blocked; resolve and resume`);
          } else {
            console.log("campaign paused between items — run resume to continue");
          }
        }
      }

      if (!startSuccessReasons.has(result.stopReason)) {
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

      // Exit 0 only for clean completion states; all other stop reasons are failures
      const resumeSuccessReasons = new Set(["complete", "paused"]);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Stop reason: ${result.stopReason}`);
        for (const rec of result.itemRecords) {
          const outcomeStr = rec.outcome ? ` (outcome: ${rec.outcome})` : "";
          console.log(`  ${rec.ticketId}: ${rec.lifecycleStatus}${outcomeStr}${rec.runId ? ` [run: ${rec.runId}]` : ""}`);
        }

        if (result.stopReason === "recovery_needed") {
          console.error(recoveryGuidanceMessage(result.itemRecords[0]));
        } else if (result.stopReason === "lane_escalation_unresolved") {
          console.error(
            `campaign paused on an item that outgrew its lane — resume refused. ` +
            `Run forge campaign escalate-lane ${campaignId} <ticket-id> --new-lane <lane> --rationale <text>, then forge campaign approve, before resuming.`
          );
        } else if (result.stopReason === "not_paused") {
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
        } else if (result.stopReason === "plan_unresolvable") {
          console.error("campaign plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan");
        } else if (result.stopReason === "already_running") {
          console.error("campaign is already running (concurrent resume attempt refused)");
        } else if (result.stopReason === "item_failed") {
          console.error("campaign stopped — an item failed during execution; inspect the failed item and re-plan or abandon");
        } else if (result.stopReason === "paused") {
          const readinessHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind === "readiness");
          const dependencyHeld = result.itemRecords.filter((r) => r.outcome === "held" && r.blockerKind !== "readiness");
          const blocked = result.itemRecords.filter((r) => r.outcome === "blocked");
          if (readinessHeld.length) {
            const heldIds = readinessHeld.map((r) => r.ticketId).join(", ");
            console.error(`campaign paused — ${readinessHeld.length} item(s) not ready: refine ${heldIds} then resume`);
          } else if (dependencyHeld.length) {
            const heldIds = dependencyHeld.map((r) => r.ticketId).join(", ");
            const reasonPart = dependencyHeld.length === 1 && dependencyHeld[0]?.reason ? ` (${dependencyHeld[0].reason})` : "";
            console.error(`campaign paused — ${dependencyHeld.length} item(s) held pending an unresolved blocker: ${heldIds}${reasonPart}; resolve the blocker (see forge campaign show/report) then resume`);
          } else if (blocked.length) {
            console.error(`campaign paused — ${blocked.length} item(s) blocked; resolve and resume`);
          } else {
            console.log("campaign paused between items — run resume again to continue");
          }
        }
      }

      if (!resumeSuccessReasons.has(result.stopReason)) {
        process.exit(1);
      }
    });

  campaign
    .command("escalate-lane <campaign-id> <ticket-id>")
    .description(
      "Escalate a paused campaign item to a stronger lane after it outgrew its assigned lane — mints a fresh unapproved plan hash; `campaign approve` then `campaign resume` are required afterward"
    )
    .requiredOption(
      "--new-lane <lane>",
      "the item's new execution lane: full_feature|quick_implementation|docs_only|test_only|review_only|research_only|ticketing_only|manual"
    )
    .requiredOption("--rationale <text>", "escalation rationale")
    .option("--agent-role <role>", "agent role for the new lane, required by docs_only/test_only/review_only/research_only")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, ticketId: string, opts: { newLane: string; rationale: string; agentRole?: string; json?: boolean }) => {
      const VALID_LANES = [
        "full_feature",
        "quick_implementation",
        "docs_only",
        "test_only",
        "review_only",
        "research_only",
        "ticketing_only",
        "manual",
      ] as const;
      if (!(VALID_LANES as readonly string[]).includes(opts.newLane)) {
        process.stderr.write(`Error: invalid --new-lane "${opts.newLane}": must be one of ${VALID_LANES.join(", ")}\n`);
        process.exit(1);
      }

      const result = escalateCampaignItemLane(campaignId, ticketId, {
        newLane: opts.newLane as ExecutionLane,
        laneRationale: opts.rationale,
        agentRole: opts.agentRole,
      });

      if (!result.ok) {
        process.stderr.write(`Error: ${result.reason}\n`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ campaignId, ticketId, newLane: opts.newLane, planHash: result.planHash }, null, 2));
      } else {
        console.log(`Escalated ${ticketId} in campaign ${campaignId} to lane '${opts.newLane}'.`);
        console.log(`Fresh plan hash: ${result.planHash}`);
        console.log(`Run: forge campaign approve ${campaignId} --rationale <text>  (then forge campaign resume ${campaignId})`);
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
    .command("reconcile <campaign-id>")
    .description(
      "Operator recovery: re-derive outcomes for scope-blocked items from durable evidence (ticket/git/host-verification/event records) and ship them if all facts hold — no evidence override; only a paused campaign is eligible"
    )
    .option("--by <operator>", "operator identifier (attribution only, not evidence)")
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, opts: { by?: string; json?: boolean }) => {
      const result = reconcileCampaign(campaignId, { decidedBy: opts.by });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!result.ok) {
        process.stderr.write(`Error: ${result.reason}\n`);
      } else {
        console.log(`Campaign: ${campaignId}`);
        for (const item of result.items) {
          const missingStr =
            item.missing && item.missing.length
              ? ` missing: ${item.missing.map(describeMissingReason).join(", ")}`
              : "";
          console.log(`  ${item.ticketId}: ${item.status}${missingStr}`);
        }
        if (result.items.every((i) => i.status === "not_applicable")) {
          console.log("No scope-blocked items eligible for reconciliation.");
        }
      }

      if (!result.ok) {
        process.exit(1);
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
        console.log(`    lane: ${item.lane} — ${item.laneRationale}`);
        if (item.blockerKind === "lane_escalation") {
          console.log(`    LANE ESCALATION: item outgrew its approved lane — the whole campaign is paused pending re-approval of a new plan basis`);
        }
        if (item.reason) console.log(`    reason: ${item.reason}`);
        if (item.requestedHumanAction) console.log(`    action: ${item.requestedHumanAction}`);
        if (item.hostVerificationReconcileHint) console.log(`    host-verification-status: ${item.hostVerificationReconcileHint}`);
        if (item.readiness && (item.readiness.outcome === "needs_refinement" || item.readiness.outcome === "blocked" || (item.outcome === "held" && item.blockerKind === "readiness"))) {
          console.log(`    readiness: ${item.readiness.outcome}`);
          if (item.readiness.gaps.length > 0) console.log(`    gaps: ${item.readiness.gaps.join("; ")}`);
          if (item.readiness.refinementProposal) console.log(`    refinement: ${item.readiness.refinementProposal}`);
        }
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

      for (const line of renderCampaignReportHuman(result)) {
        console.log(line);
      }
    });
}
