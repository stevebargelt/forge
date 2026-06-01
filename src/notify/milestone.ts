// #202/#203 — orchestrator milestones (Crawl slice).
//
// The orchestrator declares a checkpoint with `forge notify milestone`; forge
// owns delivery. We ALWAYS record an `orchestrator.milestone` event (audit
// trail), then apply a conservative per-kind policy + run-scoped dedupe to
// decide whether to actually push (ntfy/twilio via the shared dispatch).
//
// Design: meaning is the orchestrator's; delivery/dedupe/policy is forge's. We
// never infer significance from agent returns — the orchestrator says so.
//
// Walk will add per-run policy (quiet|normal|verbose) + --notify-policy; Run
// adds the orchestrator-contract (emit only at checkpoint boundaries). Crawl is
// the command + event + default policy + dedupe + dispatch.

import { logEvent, eventsForRun } from "../store/events.js";
import { getRun } from "../store/runs.js";
import { dispatch, isAnyProviderEnabled } from "./trigger.js";

export const MILESTONE_KINDS = [
  "plan_started",
  "batch_complete",
  "acceptance_green",
  "decision_needed",
  "blocked",
  "risk_found",
  "ready_for_review",
  "shipped",
] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

type Rule = "send" | "elapsed" | "suppress";
type Importance = "low" | "normal" | "high";

// Conservative defaults. `send` = always push; `suppress` = low-importance, only
// pushed once per-run policy opts in (Walk); `elapsed` = push only if the run has
// run long enough to be worth interrupting for.
const KIND_POLICY: Record<MilestoneKind, { rule: Rule; importance: Importance }> = {
  decision_needed:  { rule: "send",     importance: "high" },   // interrupt-worthy
  blocked:          { rule: "send",     importance: "high" },
  risk_found:       { rule: "send",     importance: "high" },
  acceptance_green: { rule: "send",     importance: "high" },
  shipped:          { rule: "send",     importance: "high" },
  ready_for_review: { rule: "send",     importance: "normal" },
  batch_complete:   { rule: "elapsed",  importance: "normal" }, // only if meaningful time passed
  plan_started:     { rule: "suppress", importance: "low" },    // noise by default
};

export const BATCH_ELAPSED_MIN_MS = 10 * 60 * 1000; // 10m

export function isMilestoneKind(s: string): s is MilestoneKind {
  return (MILESTONE_KINDS as readonly string[]).includes(s);
}

export type MilestoneDecision = { send: boolean; reason: string };

// Pure policy decision. Dedupe (run-scoped, key-scoped) wins over everything:
// a kind already pushed under this dedupe key for this run is never re-pushed.
export function decideMilestone(
  kind: MilestoneKind,
  runElapsedMs: number,
  alreadyDispatchedKey: boolean,
  dedupeKey?: string,
): MilestoneDecision {
  if (alreadyDispatchedKey) {
    return { send: false, reason: `dedupe: '${dedupeKey}' already notified this run` };
  }
  const pol = KIND_POLICY[kind];
  if (pol.rule === "send") return { send: true, reason: `${kind} — notify (importance: ${pol.importance})` };
  if (pol.rule === "suppress") return { send: false, reason: `${kind} — low importance, suppressed by default` };
  // elapsed
  const mins = Math.round(runElapsedMs / 60000);
  return runElapsedMs >= BATCH_ELAPSED_MIN_MS
    ? { send: true, reason: `${kind} after ${mins}m (>= 10m)` }
    : { send: false, reason: `${kind} after ${mins}m (< 10m, suppressed)` };
}

export type EmitMilestoneArgs = {
  runId: string;
  kind: string;
  title: string;
  body?: string;
  dedupeKey?: string;
};

export type EmitMilestoneResult = {
  dispatched: boolean;
  decision: MilestoneDecision;
  importance: Importance;
};

// Record the milestone event (always) + apply policy/dedupe + dispatch if the
// decision says so and a provider is configured. Never throws on delivery
// failure (dispatch swallows). Throws only on bad input (unknown kind / run).
export async function emitMilestone(args: EmitMilestoneArgs): Promise<EmitMilestoneResult> {
  if (!isMilestoneKind(args.kind)) {
    throw new Error(
      `unknown milestone kind '${args.kind}'. Valid: ${MILESTONE_KINDS.join(", ")}`,
    );
  }
  const run = getRun(args.runId);
  if (!run) throw new Error(`run not found: ${args.runId}`);

  const kind = args.kind;
  const importance = KIND_POLICY[kind].importance;
  const runElapsedMs = Math.max(0, Date.now() - new Date(run.createdAt).getTime());

  // Dedupe vs prior DISPATCHED milestones with the same key in this run.
  const alreadyDispatchedKey = args.dedupeKey
    ? eventsForRun(args.runId).some((e) => {
        if (e.eventType !== "orchestrator.milestone") return false;
        const p = e.payload as { dedupeKey?: string; dispatched?: boolean } | null;
        return !!p && p.dedupeKey === args.dedupeKey && p.dispatched === true;
      })
    : false;

  const decision = decideMilestone(kind, runElapsedMs, alreadyDispatchedKey, args.dedupeKey);

  let dispatched = false;
  if (decision.send && isAnyProviderEnabled()) {
    await dispatch(args.body ?? args.title, `forge: ${kind} — ${args.title}`);
    dispatched = true;
  }

  // Always record — audit trail independent of delivery.
  logEvent("orchestrator.milestone", {
    runId: args.runId,
    payload: {
      kind,
      importance,
      title: args.title,
      ...(args.body ? { body: args.body } : {}),
      ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
      dispatched,
      reason: decision.reason,
    },
  });

  return { dispatched, decision, importance };
}
