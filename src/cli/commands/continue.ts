// FG-563 (Slice 4, CP6): `forge continue` — the orchestrator's continuation-consumer
// command, invoked on every wake (normal completion OR the health-bound watchdog).
//
// This is the command the orchestrator CALLS on wake — NOT the wake transport
// itself (the disposable `forge launch wait` adapter is OQ-2 policy, authored
// separately). It carries the COMPLETE phase-bound continuation identity: a
// launch-id-only shape ("forge continue <launch-id>") is explicitly non-conforming
// (CP4) and is rejected here before any store touch.
//
// On invocation it delegates to the durable consumer (consumeContinuation): re-read
// the AUTHORITATIVE launch record (BD-3), claim exactly-once (FG-562 phase-bound
// CAS), adopt-not-duplicate (F17), and — on the watchdog path only — record a
// durable lost-signal recovery when it recovered terminal-but-unadvanced work.

import type { Command } from "commander";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import {
  consumeContinuation,
  recoverInFlightDispatches,
  type ConsumeOutcome,
  type ContinuationIdentity,
  type PhysicalDispatch,
  type WakeTrigger,
} from "../../v2/continuation-consumer.js";
import type { NextAction } from "../../store/continuations.js";
import { startRun } from "../../v2/startRun.js";
import { runNext } from "../../v2/runNext.js";
import { loadWorkflow } from "../../v2/loader.js";

type ContinueOpts = {
  continuationId?: string;
  sourceLaunch?: string;
  phase?: string;
  nextAction?: string;
  consumerKind?: string;
  owner?: string;
  trigger?: string;
  recover?: boolean;
  json?: boolean;
};

export function registerContinue(program: Command): void {
  program
    .command("continue")
    .description(
      "Advance the orchestrator's continuation on a launch completion or watchdog wake. " +
        "Carries the FULL phase-bound continuation identity — a launch-id-only form is non-conforming.",
    )
    // A bare positional is accepted ONLY to reject the illustrative launch-id-only
    // misuse with a clear message — it is never treated as a valid identity.
    .argument("[launch-id]", "REJECTED shorthand: a launch id alone is non-conforming — use the identity flags")
    .option("--continuation-id <id>", "the durable continuation id (required)")
    .option("--source-launch <id>", "the launch whose completion this advance rests on (required)")
    .option("--phase <phase>", "the current phase this continuation is bound to (required)")
    .option("--next-action <json>", "the structured next action as JSON, e.g. '{\"kind\":\"invoke\",\"agentRole\":\"engineer\",\"task\":\"...\"}' (required)")
    .option("--consumer-kind <kind>", "consumer kind (default: orchestrator)", "orchestrator")
    .option("--owner <id>", "the controller identity claiming the transition (default: derived)")
    .option("--trigger <trigger>", "delivery | watchdog (default: delivery)", "delivery")
    .option("--recover", "restart-replay: adopt every in-flight orchestrator dispatch instead of a single wake")
    .option("--json", "emit the structured outcome as JSON")
    .action(async (launchId: string | undefined, opts: ContinueOpts) => {
      ensureForgeDirs();
      const owner = opts.owner ?? defaultOwner();

      // Restart-replay recovery (F17): adopt all in-flight dispatches; no single
      // identity needed.
      if (opts.recover) {
        const outcomes = recoverInFlightDispatches({ owner, dispatch: cliDispatch });
        renderMany(outcomes, !!opts.json);
        return;
      }

      // CP4: reject the launch-id-only shape explicitly. A bare positional with no
      // identity flags is the non-conforming form the brief calls out.
      if (launchId && !opts.continuationId && !opts.sourceLaunch) {
        fail(
          `'forge continue ${launchId}' is non-conforming — a launch id alone cannot bind a ` +
            `phase-bound claim. Pass the full identity: --continuation-id --source-launch --phase --next-action.`,
          opts.json,
        );
        return;
      }

      const nextAction = parseNextAction(opts.nextAction, opts.json);
      if (!nextAction) return;

      const identity: Partial<ContinuationIdentity> = {
        ...(opts.continuationId ? { continuationId: opts.continuationId } : {}),
        // A --source-launch flag wins; a bare positional is NOT accepted as the launch.
        ...(opts.sourceLaunch ? { sourceLaunchId: opts.sourceLaunch } : {}),
        ...(opts.phase ? { currentPhase: opts.phase } : {}),
        ...(opts.consumerKind ? { consumerKind: opts.consumerKind as ContinuationIdentity["consumerKind"] } : {}),
        ...(nextAction ? { nextAction } : {}),
      };

      let outcome: ConsumeOutcome;
      try {
        outcome = consumeContinuation(identity as ContinuationIdentity, {
          owner,
          trigger: (opts.trigger as WakeTrigger) ?? "delivery",
          dispatch: cliDispatch,
        });
      } catch (e) {
        fail((e as Error).message, opts.json);
        return;
      }
      renderOne(outcome, !!opts.json);
    });
}

/** A stable-per-host controller id when the caller does not supply --owner. The
 *  orchestrator normally passes its own session id; this keeps the CLI usable
 *  standalone and the claim owner-scoped. */
function defaultOwner(): string {
  return `orchestrator@${process.env["FORGE_CONTROLLER_ID"] ?? process.env["HOSTNAME"] ?? "host"}`;
}

/**
 * The REAL orchestrator physical-dispatch seam. It creates the physical run on the
 * genuine run-creation path (invoke / startRun) THREADING the deterministic
 * dispatch receipt into run metadata, so the run is discoverable by runByDispatchKey
 * BEFORE its spawn is observable — the F17 adopt-not-duplicate bridge (CP2). The
 * consumer only reaches here when NO run already exists under the receipt.
 */
const cliDispatch: PhysicalDispatch = (args) => {
  const action = args.nextAction;
  switch (action.kind) {
    case "start_run": {
      const a = action as StartRunAction;
      if (!a.workflow || !a.title) {
        throw new Error("continue: start_run nextAction requires { workflow, title }");
      }
      const projectDir = a.project ? resolve(a.project) : process.cwd();
      const workflow = loadWorkflow(a.workflow, { projectDir });
      const { runId } = startRun({
        workflow,
        title: a.title,
        inputs: a.inputs ?? {},
        projectDir,
        dispatchKey: args.dispatchKey, // CP2: receipt into run metadata before the wave
      });
      // Kick the first wave. runNext is async; the run row (with the receipt) already
      // exists and is discoverable, so a crash here still adopts on recovery.
      void runNext({ runId, workflow });
      return { runId };
    }
    default:
      throw new Error(
        `continue: unsupported nextAction.kind='${action.kind}'. Supported: 'start_run'. ` +
          `(The action is structured — never an opaque shell string.)`,
      );
  }
};

type StartRunAction = NextAction & {
  kind: "start_run";
  workflow?: string;
  title?: string;
  inputs?: Record<string, unknown>;
  project?: string;
};

function parseNextAction(raw: string | undefined, json?: boolean): NextAction | undefined {
  if (!raw) {
    fail("--next-action <json> is required (a structured action with a 'kind' field)", json);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`--next-action is not valid JSON: ${(e as Error).message}`, json);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { kind?: unknown }).kind !== "string") {
    fail("--next-action must be a JSON object with a string 'kind' field", json);
    return undefined;
  }
  return parsed as NextAction;
}

function fail(message: string, json?: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else process.stderr.write(`forge continue: ${message}\n`);
  process.exitCode = 2;
}

function renderOne(o: ConsumeOutcome, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(outcomeJson(o))}\n`);
    return;
  }
  process.stdout.write(`${outcomeLine(o)}\n`);
}

function renderMany(outcomes: ConsumeOutcome[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ recovered: outcomes.length, outcomes: outcomes.map(outcomeJson) })}\n`);
    return;
  }
  process.stdout.write(`forge continue: replayed ${outcomes.length} in-flight dispatch(es)\n`);
  for (const o of outcomes) process.stdout.write(`  ${outcomeLine(o)}\n`);
}

function outcomeJson(o: ConsumeOutcome): unknown {
  switch (o.kind) {
    case "advanced":
      return {
        kind: "advanced",
        continuationId: o.continuation.continuationId,
        dispatchKey: o.dispatchKey,
        adopted: o.adopted,
        lostSignalRecovered: o.lostSignalRecovered,
        dispatchedRunId: o.continuation.dispatchedRunId ?? null,
        dispatchedTaskId: o.continuation.dispatchedTaskId ?? null,
      };
    case "rearmed":
      return { kind: "rearmed", reason: o.reason, status: o.status ?? null };
    case "already_advanced":
      return { kind: "already_advanced", continuationId: o.continuation.continuationId };
    case "lost_claim":
      return { kind: "lost_claim", state: o.continuation?.state ?? null };
    case "blocked":
      return { kind: "blocked", error: o.error, continuationId: o.continuation?.continuationId ?? null };
  }
}

function outcomeLine(o: ConsumeOutcome): string {
  switch (o.kind) {
    case "advanced":
      return (
        `advanced ${o.continuation.continuationId}` +
        (o.adopted ? " (adopted existing run — no duplicate)" : "") +
        (o.lostSignalRecovered ? " [lost signal recovered by watchdog]" : "") +
        (o.continuation.dispatchedRunId ? ` → run ${o.continuation.dispatchedRunId}` : "")
      );
    case "rearmed":
      return `re-armed watchdog (${o.reason}) — nothing advanced`;
    case "already_advanced":
      return `already advanced ${o.continuation.continuationId} — no action (duplicate wake)`;
    case "lost_claim":
      return `lost the claim race — another controller advanced it (${o.continuation?.state ?? "unknown"})`;
    case "blocked":
      return `blocked: ${o.error}`;
  }
}
