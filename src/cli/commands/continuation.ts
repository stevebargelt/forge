// FG-565 (Slice 6, G1): `forge continuation show <id>` / `forge continuation list`
// — the read-only OPERATOR surface over the durable continuation evidence.
//
// The `continuations` and `continuation_stale_observations` tables record the
// closeout evidence for the durable-orchestration-continuation model (BD-5), but
// until now they had NO read CLI: `forge lost-signals` only covers watchdog-
// recovered rows (continuation_lost_signal_recoveries), and `forge continue` is a
// MUTATING on-wake command, not an after-the-fact query. So an operator could not
// answer the FG-565 operator-visible-evidence questions from durable state alone:
//   Q3 which controller/consumer claimed it (claim_owner + consumer_kind),
//   Q4 what next action was selected (next_action, rendered STRUCTURED),
//   Q5 was a run/task dispatched and under what durable id (dispatched_run/task_id),
//   Q6 did a duplicate/stale completion arrive and get ignored safely
//      (continuation_stale_observations),
//   Q7 is it blocked, and what operator action is required (state='blocked').
//
// This mirrors the shipped `forge lost-signals` shape: a thin command that reads the
// existing store readers and hands a stable DTO projection to a factored render
// function (so the HUMAN and JSON output are directly assertable). It is READ-ONLY —
// no schema change, no write path. BD-3 SINGLE-STORE PROJECTION: it renders from the
// continuation tables ALONE and never joins the filesystem launch record or the runs
// table (those are a separate source of truth; `forge launch show` / `forge runs`
// surface them).

import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import {
  getContinuation,
  listContinuations,
  staleObservationsFor,
  staleObservationsForMany,
  type Continuation,
  type ContinuationState,
  type ConsumerKind,
  type NextAction,
  type ObservedStatus,
  type StaleObservation,
} from "../../store/continuations.js";

// The stable DTO projection the renderer asserts against — a single-store view that
// folds a continuation together with its stale-observation audit and the derived
// operator action, WITHOUT exposing raw store rows or joining any other source.
export type ContinuationEvidence = {
  continuationId: string;
  consumerKind: ConsumerKind;
  currentPhase: string;
  sourceLaunchId: string;
  state: ContinuationState;
  claimOwner: string | null; // Q3
  claimExpiresAt: number | null;
  lastObservedStatus: ObservedStatus | null;
  nextAction: NextAction; // Q4 — structured, never a raw JSON string
  dispatchKey: string | null;
  dispatchedRunId: string | null; // Q5
  dispatchedTaskId: string | null; // Q5
  staleObservations: StaleObservation[]; // Q6
  operatorAction: string | null; // Q7 — the required action when blocked
  createdAt: string;
  updatedAt: string;
};

/** The Q7 answer: when a continuation is `blocked` (its claim-to-dispatch window
 *  could not be completed), name the standing operator action so the "stuck, human
 *  needed" case has a surface. Derived from durable state alone. */
export function operatorActionFor(c: Continuation): string | null {
  if (c.state !== "blocked") return null;
  const owner = c.claimOwner ?? "(unknown owner)";
  const key = c.dispatchKey ?? "(none)";
  return (
    `BLOCKED — claim owner ${owner} could not complete the claim-to-dispatch window for phase ` +
    `${c.currentPhase}. An operator or reconciler must adopt dispatch_key=${key}: look up whether the ` +
    `dispatch already ran (idempotent under that receipt) and complete/advance it, or re-drive the phase.`
  );
}

/** Fold a continuation together with its ALREADY-FETCHED stale-observation audit
 *  (Q6) into the read-only evidence DTO. Single-store: continuations +
 *  continuation_stale_observations only. The stale observations are passed IN so a
 *  LIST render can batch them (staleObservationsForMany) and avoid a per-row N+1. */
export function toContinuationEvidenceWith(c: Continuation, staleObservations: StaleObservation[]): ContinuationEvidence {
  return {
    continuationId: c.continuationId,
    consumerKind: c.consumerKind,
    currentPhase: c.currentPhase,
    sourceLaunchId: c.sourceLaunchId,
    state: c.state,
    claimOwner: c.claimOwner ?? null,
    claimExpiresAt: c.claimExpiresAt ?? null,
    lastObservedStatus: c.lastObservedStatus ?? null,
    nextAction: c.nextAction,
    dispatchKey: c.dispatchKey ?? null,
    dispatchedRunId: c.dispatchedRunId ?? null,
    dispatchedTaskId: c.dispatchedTaskId ?? null,
    staleObservations,
    operatorAction: operatorActionFor(c),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Single-continuation fold (the `show` path): reads the one continuation's stale-
 *  observation audit directly. The list path uses toContinuationEvidenceWith with a
 *  batched lookup instead. */
export function toContinuationEvidence(c: Continuation): ContinuationEvidence {
  return toContinuationEvidenceWith(c, staleObservationsFor(c.continuationId));
}

type ShowOpts = { json?: boolean };
type ListOpts = { state?: string; consumerKind?: string; json?: boolean };

const CONTINUATION_STATES: ContinuationState[] = [
  "awaiting_completion",
  "ready",
  "dispatching",
  "advanced",
  "blocked",
];

export function registerContinuation(program: Command): void {
  const continuation = program
    .command("continuation")
    .description(
      "Read-only operator surface over durable continuation evidence (Q3–Q7): which " +
        "controller claimed a completion, the next action selected, the run/task dispatched, " +
        "stale/duplicate completions ignored safely, and blocked slots needing an operator.",
    );

  continuation
    .command("show <id>")
    .description("Show the durable continuation evidence for one continuation id, with its stale-observation audit.")
    .option("--json", "emit the evidence as JSON")
    .action((id: string, opts: ShowOpts) => {
      ensureForgeDirs();
      const c = getContinuation(id);
      if (!c) {
        process.exitCode = 1;
        process.stdout.write(`${renderContinuationNotFound(id, !!opts.json)}\n`);
        return;
      }
      process.stdout.write(`${renderContinuationShow(toContinuationEvidence(c), !!opts.json)}\n`);
    });

  continuation
    .command("list")
    .description("List durable continuations (newest activity first). Filter to blocked/stuck slots with --state blocked.")
    .option("--state <state>", `filter to one state (${CONTINUATION_STATES.join(", ")})`)
    .option("--consumer-kind <kind>", "filter to one consumer kind (orchestrator, campaign)")
    .option("--json", "emit the continuations as JSON")
    .action((opts: ListOpts) => {
      ensureForgeDirs();
      if (opts.state && !CONTINUATION_STATES.includes(opts.state as ContinuationState)) {
        process.exitCode = 2;
        process.stderr.write(
          `error: --state must be one of: ${CONTINUATION_STATES.join(", ")} (got '${opts.state}')\n`,
        );
        return;
      }
      const rows = listContinuations({
        ...(opts.state ? { state: opts.state as ContinuationState } : {}),
        ...(opts.consumerKind ? { consumerKind: opts.consumerKind as ConsumerKind } : {}),
      });
      // Batch the stale-observation audit for every row in ONE query (no N+1).
      const staleByContinuation = staleObservationsForMany(rows.map((c) => c.continuationId));
      process.stdout.write(
        `${renderContinuationList(
          rows.map((c) => toContinuationEvidenceWith(c, staleByContinuation.get(c.continuationId) ?? [])),
          !!opts.json,
        )}\n`,
      );
    });
}

// ── rendering (factored + exported so the HUMAN and JSON output are assertable) ──

export function renderContinuationNotFound(id: string, json: boolean): string {
  if (json) return JSON.stringify({ found: false, continuationId: id });
  return `No continuation recorded for id '${id}'.`;
}

export function renderContinuationShow(e: ContinuationEvidence, json: boolean): string {
  if (json) return JSON.stringify(e);
  const lines = [
    `continuation ${e.continuationId}`,
    `  consumer:        ${e.consumerKind}`,
    `  phase:           ${e.currentPhase}`,
    `  state:           ${e.state}`,
    `  source-launch:   ${e.sourceLaunchId}`,
    `  claim-owner:     ${e.claimOwner ?? "-"}`,
    `  last-observed:   ${e.lastObservedStatus ?? "-"}`,
    // Q4 — structured next action, canonically stringified (NOT a raw stored blob).
    `  next-action:     ${JSON.stringify(e.nextAction)}`,
    `  dispatch-key:    ${e.dispatchKey ?? "-"}`,
    `  dispatched-run:  ${e.dispatchedRunId ?? "-"}`,
    `  dispatched-task: ${e.dispatchedTaskId ?? "-"}`,
    `  created:         ${e.createdAt}`,
    `  updated:         ${e.updatedAt}`,
  ];
  // Q6 — stale/duplicate completions recorded-and-ignored.
  if (e.staleObservations.length === 0) {
    lines.push(`  stale-observations: none`);
  } else {
    lines.push(`  stale-observations (${e.staleObservations.length}):`);
    for (const s of e.staleObservations) {
      lines.push(`    ${s.observedAt}  launch=${s.sourceLaunchId}  phase=${s.currentPhase}  status=${s.status}`);
    }
  }
  // Q7 — the required operator action for a blocked slot.
  if (e.operatorAction) lines.push(`  operator-action: ${e.operatorAction}`);
  return lines.join("\n");
}

export function renderContinuationList(rows: ContinuationEvidence[], json: boolean): string {
  if (json) return JSON.stringify({ count: rows.length, continuations: rows });
  if (rows.length === 0) {
    return "No continuations recorded.";
  }
  const header = `${rows.length} continuation${rows.length === 1 ? "" : "s"} (newest activity first):`;
  const lines = rows.map((e) => continuationLine(e));
  return [header, ...lines].join("\n");
}

function continuationLine(e: ContinuationEvidence): string {
  const parts = [
    e.updatedAt,
    `id=${e.continuationId}`,
    `consumer=${e.consumerKind}`,
    `phase=${e.currentPhase}`,
    `state=${e.state}`,
    `launch=${e.sourceLaunchId}`,
  ];
  if (e.claimOwner) parts.push(`owner=${e.claimOwner}`);
  if (e.lastObservedStatus) parts.push(`observed=${e.lastObservedStatus}`);
  if (e.dispatchedRunId) parts.push(`run=${e.dispatchedRunId}`);
  if (e.dispatchedTaskId) parts.push(`task=${e.dispatchedTaskId}`);
  if (e.staleObservations.length > 0) parts.push(`stale=${e.staleObservations.length}`);
  if (e.state === "blocked") parts.push(`ACTION-REQUIRED`);
  return `  ${parts.join("  ")}`;
}
