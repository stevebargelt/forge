import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCampaign, resolvePlan, sourceInputToPlannerInput } from "../../campaign/planner.js";
import type { PlannerInput, PlanMode, ItemModeOverride, ExecutionLane } from "../../campaign/planner.js";
import { classifyItemsForPlan } from "../../campaign/lane-classifier.js";
import type { ClassifyTicketFn } from "../../campaign/lane-classifier.js";
import { listCampaignItems, getCampaign, approveCampaign, tryTransitionCampaign, tryOperatorPauseCampaign } from "../../store/campaigns.js";
import { startCampaign, resumeCampaign, escalateCampaignItemLane, hasUnresolvedLaneEscalation, retryCampaignItem, driveOneCampaignItem, launchDriveItemUnderForge, driveRemainingItems, prepareCampaignItemDispatch, DEFAULT_CONTROLLER_LEASE_MS } from "../../campaign/executor.js";
import { recoverCampaign, type CampaignDispatchDeps } from "../../campaign/continuation-adapter.js";
import { invoke } from "../../v2/invoke.js";
import { assembleCampaignShow, assembleCampaignReport, renderCampaignReportHuman, formatOutOfBandEligibleHint, formatCampaignSystemRetryHint } from "../../campaign/report.js";
import { reconcileCampaign } from "../../campaign/reconcile.js";
import { describeMissingReason } from "../../campaign/reconcile-evidence.js";
import { listTickets } from "../../backlog/structured.js";
import { projectHasBacklog } from "../../backlog/storage-mode.js";

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

// FG-489: recovery_needed fires on an item stuck in an indeterminate lifecycle
// state (e.g. still 'running' after a crash never recorded a terminal
// outcome) — distinct from a cleanly-terminal 'failed' item, which is what
// `forge campaign retry` acts on. This message must not tell the operator to
// hand-edit the DB to force a state; it points at the durable inspection
// surface (forge show) and, once the run is confirmed dead, `forge campaign
// retry` is the supported path IF the item ends up failed with a transient
// (auth/infrastructure) blockerKind — never a raw reset.
function recoveryGuidanceMessage(rec: { ticketId: string; lifecycleStatus: string; runId?: string | undefined } | undefined): string {
  if (rec) {
    const runPart = rec.runId ? ` run ${rec.runId}` : "the run";
    return `recovery needed: item ${rec.ticketId} is ${rec.lifecycleStatus} — inspect ${runPart} (forge show${rec.runId ? ` ${rec.runId}` : ""}); if it turns out to be a transient failure (auth/infrastructure), \`forge campaign retry <campaign-id> ${rec.ticketId}\` once the campaign is paused will reset it for a clean re-dispatch`;
  }
  return "recovery needed: campaign has an in-flight item that must be resolved before retrying";
}

// FG-489: the message shown for 'paused'-with-blocked-items — the actual shape
// a transient (auth/infrastructure) failure produces. Splits retryable items
// (name the supported `forge campaign retry` verb) from everything else
// (scope/verdict failures and other blockers, which retry refuses — re-plan,
// escalate the lane, or abandon instead).
// FG-511: campaign_system is a THIRD bucket — retry neither accepts it outright
// (like auth/infrastructure) nor refuses it outright (like scope): it judges the
// item from the underlying run's durable failure evidence. Only `forge campaign
// retry` can make that call, so name it as the verb to try rather than sending
// the operator straight to re-plan/abandon.
const RETRYABLE_BLOCKER_KINDS = new Set(["auth", "infrastructure"]);

function blockedItemsGuidance(campaignId: string, blocked: { ticketId: string; blockerKind?: string }[]): string {
  const retryable = blocked.filter((r) => r.blockerKind && RETRYABLE_BLOCKER_KINDS.has(r.blockerKind));
  const campaignSystem = blocked.filter((r) => r.blockerKind === "campaign_system");
  const other = blocked.filter((r) => !r.blockerKind || (!RETRYABLE_BLOCKER_KINDS.has(r.blockerKind) && r.blockerKind !== "campaign_system"));
  const parts: string[] = [];
  if (retryable.length) {
    const ids = retryable.map((r) => r.ticketId).join(", ");
    parts.push(
      `${retryable.length} item(s) blocked on a transient failure (${ids}) — run \`forge campaign retry ${campaignId} <ticket-id>\` for each, then resume`
    );
  }
  if (campaignSystem.length) {
    const ids = campaignSystem.map((r) => r.ticketId).join(", ");
    parts.push(
      `${campaignSystem.length} item(s) blocked on campaign_system (${ids}) — \`forge campaign retry ${campaignId} <ticket-id>\` applies if the underlying run's failure evidence is transient (auth/infrastructure); it judges from that evidence and refuses otherwise, naming what is missing`
    );
  }
  if (other.length) {
    const ids = other.map((r) => r.ticketId).join(", ");
    parts.push(`${other.length} item(s) blocked (${ids}) — inspect and re-plan or abandon`);
  }
  return `campaign paused — ${parts.join("; ")}`;
}

// FG-490 review: startCampaign/resumeCampaign rethrow (never return) when the
// executor's drive path parks the campaign on an uncaught error — every OTHER
// stop reason renders through the structured result below, so this is the one
// failure class an uncaught throw would otherwise hand to the CLI's generic
// top-level catch as a bare non-JSON stderr line. Renders it the same way:
// --json gets a machine-readable object, human output keeps the wrapped
// message text (unchanged wording — it already carries the resume guidance).
// ticketId/runId come from the campaign item the executor parked with this
// exact reason before it rethrows — undefined only in the rare case the park
// write itself failed, in which case nothing was recorded to look up. Two
// park shapes exist: a thrown runNext parks the (still-live) item at
// 'awaiting_gate' (parkCampaignOnDriveThrow); a thrown startRun has no live
// run to reattach to and parks directly at its true terminal state instead —
// failed/blocked/infrastructure (parkCampaignOnStartRunThrow). Match both by
// reason so --json carries ticketId/runId regardless of which shape parked.
function renderDriveErrorAndExit(campaignId: string, err: unknown, json: boolean | undefined): never {
  const message = err instanceof Error ? err.message : String(err);
  const original = err instanceof Error && err.cause instanceof Error ? err.cause.message : message;
  const parked = listCampaignItems(campaignId).find(
    (item) =>
      item.reason === original &&
      (item.lifecycleStatus === "awaiting_gate" ||
        (item.lifecycleStatus === "failed" && item.outcome === "blocked" && item.blockerKind === "infrastructure"))
  );

  if (json) {
    const guidance =
      parked && parked.lifecycleStatus === "failed" && parked.outcome === "blocked" && parked.blockerKind === "infrastructure"
        ? `forge campaign retry ${campaignId} ${parked.ticketId} && forge campaign resume ${campaignId}`
        : `forge campaign resume ${campaignId}`;
    console.log(JSON.stringify({
      stopReason: "drive_error",
      campaignId,
      ticketId: parked?.ticketId,
      runId: parked?.runId,
      error: original,
      guidance,
    }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}

// FG-596: reconstruct the argv that re-invokes THIS forge CLI, so the launch-per-item
// controller can start `forge campaign drive-item …` under `forge launch`. execArgv
// carries the interpreter flags (e.g. `--import tsx` in dev) and argv[1] the entry
// script, so a dev tsx invocation and a built release both re-run correctly. The
// recorder spawns argv[0] directly, so this must name the real interpreter + entry.
// FG-564 (D1): the campaign-controller lease TTL (DEFAULT_CONTROLLER_LEASE_MS) is defined in
// the executor and imported — it fences a longer-lived physical driver than the FG-562
// per-phase continuation lease, so it is deliberately longer.

// FG-564 (P1-D / provider-neutral identity): the instance-stable campaign-controller owner
// campaign@<campaignId>@<controllerInstanceId>. Identity is bound to the instance-stable id
// the PROCESS actually owns — resolved ONLY from the environment (FORGE_CONTROLLER_ID, the
// provider-neutral controller-instance id the orchestrator establishes from its durable
// session) — and FAILS CLOSED when none resolves. A caller-supplied owner string is NEVER
// accepted as proof of identity on any mutation/renew path: that would let any caller pass a
// live controller's owner and renew/impersonate a lease it does not own. Takeover of a live
// lease is only ever by real expiry (generation bump), never by matching a supplied owner
// string. A host-stable value (hostname) is likewise refused — it cannot fence a same-host
// peer.
function resolveCampaignControllerOwner(
  campaignId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; owner: string } | { ok: false; error: string } {
  const instanceId = env["FORGE_CONTROLLER_ID"]?.trim();
  if (!instanceId) {
    return {
      ok: false,
      error:
        "no stable controller identity resolved — refusing to acquire/renew a campaign-controller lease. " +
        "A host-stable owner cannot fence a same-host peer, and a caller-supplied owner string cannot prove " +
        "identity, so recovery will not mutate under either. Set FORGE_CONTROLLER_ID to the controller's " +
        "instance-stable identity (the orchestrator establishes this from its durable session).",
    };
  }
  return { ok: true, owner: `campaign@${campaignId}@${instanceId}` };
}

// FG-564 (AC8): the shared recovery driver for `campaign recover` / `campaign continue`.
// Acquires the campaign-controller lease (fail closed if a different owner holds a live one),
// then adopts every in-flight campaign continuation through the lease-gated reservation
// authority — the SAME shared consumer core, no fork. The physical re-drive kicks the
// existing, tested per-item launch path (launchDriveItemUnderForge); the run row it reserves
// is stamped with the FG-596 dispatch key so the launched child adopts it by key (no duplicate).
async function runCampaignRecovery(
  campaignId: string,
  opts: { json?: boolean },
  verb: "recover" | "continue",
): Promise<void> {
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: "not_found" }));
    else process.stderr.write(`Error: campaign ${campaignId} not found\n`);
    process.exit(1);
  }
  const ownerRes = resolveCampaignControllerOwner(campaignId);
  if (!ownerRes.ok) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: ownerRes.error }));
    else process.stderr.write(`forge campaign ${verb}: ${ownerRes.error}\n`);
    process.exit(1);
  }

  // FG-564 (FIX round 5): the continuation/recover advance resolves N+1's lane + filesystem
  // inputs and materializes its run through the SAME ONE lane-aware authority the normal drive
  // path uses — a real, correctly-shaped run (full_feature pipeline OR invoke/invoke_chain, keyed
  // by the item's actual lane) the launched drive-item child reattaches to and drives through the
  // matching real physical path. prepareItemDispatch runs BEFORE the reservation (fs reads outside
  // the tx) and FAILS CLOSED on a missing ticket / projectDir / unresolved workflow / non-dispatch
  // lane, so the reservation rolls back / is never entered and the continuation stays recoverable.
  const projectDir = campaign.projectDir;
  const prepareItemDispatch: CampaignDispatchDeps["prepareItemDispatch"] = ({ campaignId: cid, itemId }) => {
    if (!projectDir) {
      throw new Error(`campaign ${cid} has no stored project directory — cannot materialize a drivable run for ${itemId}`);
    }
    return prepareCampaignItemDispatch({ campaignId: cid, itemId }, { projectDir });
  };
  const driveItem: CampaignDispatchDeps["driveItem"] = ({ campaignId: cid, itemId }) => {
    // Fire-and-forget: the run row is durable (reserved), so the launched child adopts by key and
    // re-enters the physical driver for the run's RECORDED lane (runNext or the real invoke path).
    void launchDriveItemUnderForge(forgeSelfArgv())(cid, itemId);
  };

  const result = recoverCampaign({
    campaignId,
    owner: ownerRes.owner,
    ttlMs: DEFAULT_CONTROLLER_LEASE_MS,
    campaign: { prepareItemDispatch, driveItem },
  });

  if (result.status === "lease_held_live") {
    const msg =
      `forge campaign ${verb}: refusing — the prior controller's lease is still LIVE ` +
      `(owner ${result.lease.owner}, generation ${result.lease.generation}, expires ` +
      `${new Date(result.lease.leaseExpiresAtMs).toISOString()}). Takeover is only possible after expiry.`;
    if (opts.json) console.log(JSON.stringify({ ok: false, status: "lease_held_live", lease: result.lease }));
    else process.stderr.write(`${msg}\n`);
    process.exit(1);
  }

  const advanced = result.adopted.filter((o) => o.kind === "advanced").length;

  // FG-564 (P1-G): after adopting in-flight continuations/runs (only reached AFTER the prior
  // lease expired and we hold the lease), CONTINUE the item loop to completion — driving any
  // item whose launch is linked but whose continuation was never recorded, and every remaining
  // pending item — WITHOUT manual SQL, without resetting the item, and without minting a
  // replacement run (driveRemainingItems skips terminal items, reattaches to parked runs, and
  // the FG-596 pending-guard refuses to replace an item that already carries a run). This runs
  // under the SAME lease we just acquired, so the whole continuation is fenced.
  let loopStop: string | undefined;
  if (campaign.status === "running" && campaign.projectDir) {
    const loopResult = await driveRemainingItems(campaignId, {
      dispatch: invoke,
      projectDir: campaign.projectDir,
      mode: campaign.mode,
      launchDriveItem: launchDriveItemUnderForge(forgeSelfArgv()),
      controllerOwner: ownerRes.owner,
      controllerLeaseTtlMs: DEFAULT_CONTROLLER_LEASE_MS,
    });
    loopStop = loopResult.stopReason;
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, status: "recovered", mode: result.mode, adopted: result.adopted.length, advanced, loopStop, lease: result.lease }, null, 2));
  } else {
    console.log(`campaign ${verb}: lease ${result.mode} (owner ${result.lease.owner}#${result.lease.generation})`);
    console.log(`  adopted ${result.adopted.length} in-flight continuation(s); ${advanced} advanced`);
    if (loopStop) console.log(`  continued the item loop → ${loopStop}`);
  }
}

function forgeSelfArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

// FG-564 (P0-A) / FG-737 (Option X): the instance-stable campaign-controller owner for a normal
// `forge campaign start/resume`. Prefers the provider-neutral FORGE_CONTROLLER_ID the orchestrator
// establishes from its durable session; absent one, falls back to a process-unique id
// (`cli-<pid>`) so a lease is ALWAYS acquired (the machinery is exercised on every normal start)
// and two concurrent controllers still get DIFFERENT owners.
//
// FG-737 Option X: the detached-resume wedge is fixed by the SETTLED-linkage REFRESH
// (recordDriveItemLaunchLinkage → refreshItemLaunchBornUnder, guarded on run_id IS NULL), NOT by
// collapsing owner-uniqueness with a stable `@auto`. A stable owner would let two concurrent
// same-campaign controllers that both lack FORGE_CONTROLLER_ID resolve to the SAME owner; because
// acquireCampaignLease renews a same-owner lease at the SAME generation, both would renew and both
// would pass the born-under fence — reopening the FG-564 double-driver hazard. Keeping the
// fallback instance-unique fences the second controller (held_by_live_owner while the first lease
// is live; takeover only after STRICT expiry, which bumps the generation).
//
// The recovery path: a detached resume comes up as a NEW instance-unique owner. Once the dead
// first controller's lease has EXPIRED it takes over (new generation), then the settled-linkage
// refresh re-pins the held item's born-under token (run_id NULL) to the new (owner, generation)
// and the born-under fence AUTHORIZES — the held item is re-driven. A resume issued while the
// first lease is still LIVE is correctly denied and recovers on the next post-expiry resume;
// bounded TTL latency is the accepted cost (ticket AC2). An explicit FORGE_CONTROLLER_ID still
// WINS. Unlike `recover` (P1-D), start does not fail closed on a missing id: it is establishing,
// not taking over, a lease.
function resolveStartControllerOwner(campaignId: string): string {
  const instanceId = process.env["FORGE_CONTROLLER_ID"]?.trim() || `cli-${process.pid}`;
  return `campaign@${campaignId}@${instanceId}`;
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
      "JSON map of ticketId -> compiled routing-policy route key (e.g. implementation_quick), supplying the FG-442 lane judgment for each ticket. Tickets omitted here are unclassified (lane 'manual'). A lane judgment is required for every resolved item: supply --routes, or pass --default-lane for items --routes doesn't cover — `campaign plan` refuses rather than silently defaulting to full_feature (FG-442)."
    )
    .option(
      "--default-lane <lane>",
      "explicit opt-in: assign this lane to every resolved item left unjudged by --routes (or all items, if --routes is omitted). One of full_feature|quick_implementation|ticketing_only|manual — lanes that require an agentRole (docs_only|test_only|review_only|research_only) cannot be used as a blanket default; route those items individually via --routes instead. Requires --default-lane-rationale."
    )
    .option(
      "--default-lane-rationale <text>",
      "rationale recorded against every item defaulted via --default-lane (required when --default-lane is used)"
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
      defaultLane?: string;
      defaultLaneRationale?: string;
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

      const BLANKET_DEFAULT_LANES = ["full_feature", "quick_implementation", "ticketing_only", "manual"] as const;
      if (opts.defaultLane !== undefined) {
        if (!opts.defaultLaneRationale) {
          throw new Error("--default-lane requires --default-lane-rationale");
        }
        if (!(BLANKET_DEFAULT_LANES as readonly string[]).includes(opts.defaultLane)) {
          throw new Error(
            `invalid --default-lane "${opts.defaultLane}": must be one of ${BLANKET_DEFAULT_LANES.join(", ")} ` +
            `(lanes requiring an agentRole — docs_only, test_only, review_only, research_only — cannot be used as a blanket default; route those items via --routes)`
          );
        }
      }

      // FG-442: run the lane classifier OUTSIDE resolvePlan/planCampaign, at
      // plan-authoring time — the one-time cost per plan. Only when --routes
      // supplies a real ticket->route judgment.
      const { resolvedIds } = resolvePlan(input, { projectDir, mode });
      const itemOverrides: Record<string, ItemModeOverride> = { ...(input.itemOverrides ?? {}) };
      if (opts.routes) {
        let routes: Record<string, string>;
        try {
          routes = JSON.parse(opts.routes) as Record<string, string>;
        } catch {
          throw new Error("--routes must be valid JSON: a map of ticketId -> route key");
        }
        const tickets = listTickets(projectDir).filter((t) => resolvedIds.includes(t.id));
        const classified = classifyItemsForPlan(tickets, {
          projectDir,
          classifyTicket: makeRouteLookupClassifier(routes),
        });
        Object.assign(itemOverrides, classified.itemOverrides);
      }

      // FG-442 finding 3: the CLI is the refusal point — resolvePlan's own
      // full_feature fallback (planner.ts foldItemEntry) remains for legacy/
      // programmatic callers, but `campaign plan` must never reach it silently.
      // Every resolved item needs a lane from --routes or an explicit
      // --default-lane opt-in before a plan is persisted.
      const unjudgedIds = resolvedIds.filter((id) => !itemOverrides[id]?.lane);
      if (unjudgedIds.length > 0) {
        if (!opts.defaultLane) {
          throw new Error(
            `campaign plan: no lane judgment supplied for ${unjudgedIds.length} item(s) (FG-442): ${unjudgedIds.join(", ")}. ` +
            `Supply per-item lanes via --routes, or pass --default-lane <lane> --default-lane-rationale <text> to explicitly default the unjudged items.`
          );
        }
        for (const id of unjudgedIds) {
          itemOverrides[id] = {
            lane: opts.defaultLane as ExecutionLane,
            laneRationale: opts.defaultLaneRationale!,
            materialLaneAssumptions: [`operator default via --default-lane=${opts.defaultLane}`],
          };
        }
      }

      if (Object.keys(itemOverrides).length > 0) {
        input = { ...input, itemOverrides };
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

      // FG-442 / RED-WIDE: refuse ANY paused campaign with an unresolved lane
      // escalation, regardless of whether plan_hash has moved — a fresh hash
      // minted for the WRONG ticket (escalateCampaignItemLane validates ticketId
      // itself now, but this is defense in depth) must not let approve through
      // while the REAL escalated item is still unresolved. Re-approval after a
      // genuine escalate is unaffected: a real escalate clears the escalated
      // item's lane_escalation blocker, so hasUnresolvedLaneEscalation is false.
      if (existing.status === "paused") {
        const items = listCampaignItems(campaignId);
        if (hasUnresolvedLaneEscalation(items)) {
          process.stderr.write(
            `Error: campaign ${campaignId} is paused on an unresolved lane escalation — ` +
            `run forge campaign escalate-lane ${campaignId} <ticket-id> --new-lane <lane> --rationale <text> first, then approve\n`
          );
          process.exit(1);
        }

        // FG-442 (PR #11 follow-up, Finding 2): a paused campaign only has something
        // genuinely new to approve when escalate-lane minted a fresh plan_hash. A
        // paused campaign whose plan hasn't changed since its last approval (e.g. one
        // paused at awaiting_gate for an unrelated reason) has nothing to re-approve —
        // approving it would only rewrite approval metadata on a preserved campaign.
        if (existing.planHash === existing.approvedPlanHash) {
          process.stderr.write(
            `Error: campaign ${campaignId} is paused but its plan hash is unchanged since it was last approved — ` +
            `there is nothing new to approve. If it's paused for a reason other than a lane escalation, resolve it ` +
            `via forge campaign reconcile or resume, not approve.\n`
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
      // FG-607: db-mode projects have no backlog/ directory — ask the store.
      // FG-608: existsSync stays alongside it — host-path liveness on the
      // recorded projectDir, which the store check cannot answer (in db mode it
      // returns `true` for a directory that has been deleted). Locked by
      // src/campaign/fg608-dir-guard-regression.integration.test.ts.
      if (!existsSync(projectDir) || !projectHasBacklog(projectDir)) {
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

      let result;
      try {
        // FG-596: production drives one launch per item (forge campaign drive-item)
        // under forge launch — the controller no longer blocks in-process on containers.
        result = await startCampaign(campaignId, {
          launchDriveItem: launchDriveItemUnderForge(forgeSelfArgv()),
          controllerOwner: resolveStartControllerOwner(campaignId),
        });
      } catch (err) {
        renderDriveErrorAndExit(campaignId, err, opts.json);
      }

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
            console.error(blockedItemsGuidance(campaignId, blocked));
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
      // FG-516: no pause notification here — this is the operator's OWN pause
      // action, not an unattended wedge. Only the executor's automatic
      // running→paused parks (drive errors, blockers, gates) notify.
      // FG-750 (RF-2): pause via the operator-scoped CAS, which durably marks the
      // campaign operatorPaused in the SAME transaction — so a cross-process
      // item-scoped-park continuation cannot resume over this campaign-wide pause.
      if (!tryOperatorPauseCampaign(campaignId)) {
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

      let result;
      try {
        result = await resumeCampaign(campaignId, {
          launchDriveItem: launchDriveItemUnderForge(forgeSelfArgv()),
          controllerOwner: resolveStartControllerOwner(campaignId),
        });
      } catch (err) {
        renderDriveErrorAndExit(campaignId, err, opts.json);
      }

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
            console.error(blockedItemsGuidance(campaignId, blocked));
          } else {
            console.log("campaign paused between items — run resume again to continue");
          }
        }
      }

      if (!resumeSuccessReasons.has(result.stopReason)) {
        process.exit(1);
      }
    });

  // FG-564 (Slice 5b, AC8/D2/D4): `forge campaign recover` — the running-campaign takeover
  // entry point. Fails closed while the prior controller's lease is live; after expiry adopts
  // in-flight continuations/runs through the SAME lease-gated reservation authority and
  // continues the item loop WITHOUT manual SQL, without resetting the item or minting a
  // replacement run. `forge campaign continue` is the per-wake sibling — both reuse the shared
  // campaign consumer core internally (never a fork of continue.ts).
  campaign
    .command("recover <campaign-id>")
    .description("Recover a campaign whose controller died — fails closed while the prior lease is live, then after expiry adopts in-flight continuations/runs and continues (no manual SQL)")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, opts: { json?: boolean }) => {
      await runCampaignRecovery(campaignId, opts, "recover");
    });

  campaign
    .command("continue <campaign-id>")
    .description("Advance a campaign's in-flight continuations on a launch-completion or watchdog wake (lease-gated; shares the campaign consumer core)")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, opts: { json?: boolean }) => {
      await runCampaignRecovery(campaignId, opts, "continue");
    });

  // FG-596: the launchable single-item drive. This is what `forge campaign start/resume`
  // launches (once per item) under `forge launch`, and waits on. It drives EXACTLY ONE
  // item to a terminal drive-process outcome or a legal park — synchronously, in this
  // child process: startRun/insertRun + generation persist + dispatch-key stamp, runNext
  // within-item waves, publication convergence, gates, item finalization, and every
  // park-on-throw all commit to durable state BEFORE this process exits. Its own exit
  // code describes the DRIVE-PROCESS lifecycle ONLY (exit 0 = clean settle, exit 1 = the
  // drive threw); the item's shipped/parked/failed outcome and the controller-level
  // stopReason are read by the controller from DURABLE state after the wake
  // (deriveDriveItemResultFromDurableState) — this command prints NO machine-readable
  // marker, because a stdout line anything in the child's output could forge must never
  // be the controller's source of truth (FG-596 fix 3). Human stdout is advisory only.
  campaign
    .command("drive-item <campaign-id> <item-id>")
    .description("Drive ONE campaign item to a terminal drive-process outcome or a legal park (the launchable unit `campaign start/resume` runs under forge launch)")
    .option("--json", "machine-readable JSON output")
    .action(async (campaignId: string, itemId: string, opts: { json?: boolean }) => {
      // FG-596: the early refusals emit the SAME structured `--json` error envelope the
      // unknown-item guard below uses ({ error, campaignId, itemId }) so a launch controller
      // (or any --json consumer) gets a machine-readable refusal in every mode, not a
      // stderr-only message it cannot parse.
      const emitRefusal = (message: string): void => {
        if (opts.json) console.log(JSON.stringify({ error: message, campaignId, itemId }, null, 2));
        process.stderr.write(`${message}\n`);
      };
      const campaign = getCampaign(campaignId);
      if (!campaign) {
        emitRefusal(`Error: campaign ${campaignId} not found`);
        process.exit(1);
      }
      if (!campaign.projectDir) {
        emitRefusal(`Error: campaign ${campaignId} has no stored project directory`);
        process.exit(1);
      }
      // FG-596 (fix 5): a raw drive-item invocation must NOT mutate a paused/abandoned
      // campaign out-of-band — that bypasses the controller's cooperative pause and
      // drives an item the operator has stopped. Only a running campaign is drivable
      // (the controller transitions it to running before it ever launches a drive-item).
      // Refuse otherwise; nothing is mutated, so this is a clean no-op park guard.
      if (campaign.status !== "running") {
        emitRefusal(
          `Error: campaign ${campaignId} is ${campaign.status}; drive-item only drives a running campaign ` +
            `(it is launched by \`forge campaign start/resume\`, which transitions the campaign to running first)`,
        );
        process.exit(1);
      }
      // FG-596: an itemId that is not a real item of this campaign is a drive-PROCESS
      // failure — the process could not drive the named item — NOT a settled drive.
      // driveOneCampaignItem returns an empty settled result for an item it cannot find,
      // which the renderers below would misreport as "settled (campaign continues)" at
      // exit 0. Reject it here at the operator boundary: exit non-zero with a clear
      // error in BOTH output modes, creating/mutating no run or durable state. (The
      // "disposition describes the process, never the item fate" contract is intact —
      // there is no item to have a fate.)
      if (!listCampaignItems(campaignId).some((i) => i.id === itemId)) {
        const message = `Error: item ${itemId} is not a drivable item of campaign ${campaignId}`;
        if (opts.json) console.log(JSON.stringify({ error: message, campaignId, itemId }, null, 2));
        process.stderr.write(`${message}\n`);
        process.exit(1);
      }
      // FG-564 (item 3, C7 fence): this is a LAUNCHED drive-item child. Its authorization to do
      // physical work is resolved by driveOneCampaignItem from the DURABLE launch linkage row
      // (campaign_item_launches) — NEVER from a caller/env token — and fails closed when the
      // linkage is missing or its immutable born-under owner/generation no longer holds the live
      // campaign-controller lease. A raw/forged `campaign drive-item` invocation cannot drive.
      try {
        const result = await driveOneCampaignItem(campaignId, itemId, {
          dispatch: invoke,
          projectDir: campaign.projectDir,
          mode: campaign.mode,
          enforceFence: true,
        });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`drive-item ${itemId}: ${result.stopReason ? `stop=${result.stopReason}` : "settled (campaign continues)"}`);
          for (const rec of result.itemRecords) {
            const outcomeStr = rec.outcome ? ` (outcome: ${rec.outcome})` : "";
            console.log(`  ${rec.ticketId}: ${rec.lifecycleStatus}${outcomeStr}${rec.runId ? ` [run: ${rec.runId}]` : ""}`);
          }
        }
      } catch (err) {
        // A drive error already committed a durable park (parkCampaignOnDriveThrow /
        // parkCampaignOnStartRunThrow) before rethrowing. Exit 1 with the message on
        // stderr; the controller reconstructs the drive-error from the DURABLE parked
        // item (its reason) — NOT from any stdout marker — and re-raises so the CLI's
        // renderDriveErrorAndExit renders drive_error (FG-490).
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${message}\n`);
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
    .command("retry <campaign-id> <ticket-id>")
    .description(
      "Reset a transiently-failed campaign item (auth/infrastructure) back to pending for a clean re-dispatch — campaign must be paused; a scope/verdict-failed item is refused. A campaign_system item is judged from its run's durable failure evidence: accepted only when every failed task classifies transient (auth/infrastructure), refused otherwise naming the missing or non-transient evidence. Run `forge campaign resume` afterward to re-dispatch."
    )
    .option("--json", "machine-readable JSON output")
    .action((campaignId: string, ticketId: string, opts: { json?: boolean }) => {
      const result = retryCampaignItem(campaignId, ticketId);

      if (!result.ok) {
        process.stderr.write(`Error: ${result.reason}\n`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ campaignId, ticketId, lifecycleStatus: "pending" }, null, 2));
      } else {
        console.log(`Reset ${ticketId} in campaign ${campaignId} to pending.`);
        console.log(`Run: forge campaign resume ${campaignId}`);
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
      "Operator recovery: re-derive outcomes for scope-blocked, out-of-band-delivered, and campaign_system-recoverable items from durable evidence (ticket/git/host-verification/event records) and ship them if all facts hold — no evidence override; only a paused campaign is eligible"
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
        if (item.outOfBandEligible) console.log(`    out-of-band-eligible: ${formatOutOfBandEligibleHint(item.ticketId)}`);
        if (item.campaignSystemEligible) console.log(`    campaign-system-recoverable: ${formatOutOfBandEligibleHint(item.ticketId)}`);
        if (item.campaignSystemRetryEligible) console.log(`    campaign-system-retryable: ${formatCampaignSystemRetryHint(result.campaignId, item.ticketId)}`);
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
