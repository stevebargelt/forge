// FG-563 (Slice 4, FIX3, CP1 AC): `forge lost-signals` — the OPERATOR surface over
// the durable lost-signal recovery audit (continuation_lost_signal_recoveries).
//
// Without this command the audit was reachable only through store readers
// (listLostSignalRecoveries / lostSignalRecoveriesFor) that no CLI or report
// imported, so an operator could not answer "which controller recovered which
// launch, by watchdog vs normal delivery?" without transcript archaeology (the exact
// question the PRD's Operator-visible-evidence AC requires answering). This wires the
// store reader to a human-readable listing (plus an optional `--json`).

import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import {
  listLostSignalRecoveries,
  type LostSignalRecovery,
} from "../../store/continuation-lost-signal.js";
import type { ConsumerKind } from "../../store/continuations.js";

type LostSignalsOpts = {
  consumerKind?: string;
  json?: boolean;
};

export function registerLostSignals(program: Command): void {
  program
    .command("lost-signals")
    .description(
      "List durable lost-signal recoveries — completions the watchdog recovered because " +
        "their normal wake never arrived. Answers WHICH controller recovered WHICH launch, " +
        "and by what trigger, without transcript archaeology.",
    )
    .option("--consumer-kind <kind>", "filter to one consumer kind (e.g. orchestrator)")
    .option("--json", "emit the recoveries as JSON")
    .action((opts: LostSignalsOpts) => {
      ensureForgeDirs();
      const recoveries = listLostSignalRecoveries(
        opts.consumerKind ? { consumerKind: opts.consumerKind as ConsumerKind } : {},
      );
      process.stdout.write(`${renderLostSignals(recoveries, !!opts.json)}\n`);
    });
}

/** The human/JSON rendering, factored out so it is directly assertable against real
 *  store rows (the FIX3 AC: assert the HUMAN CLI output, not only the JSON field). */
export function renderLostSignals(recoveries: LostSignalRecovery[], json: boolean): string {
  if (json) {
    return JSON.stringify({ count: recoveries.length, recoveries });
  }
  if (recoveries.length === 0) {
    return "No lost-signal recoveries recorded — every completion wake arrived on the normal path.";
  }
  const header = `${recoveries.length} lost-signal recover${recoveries.length === 1 ? "y" : "ies"} (newest first):`;
  const lines = recoveries.map((r) => lostSignalLine(r));
  return [header, ...lines].join("\n");
}

function lostSignalLine(r: LostSignalRecovery): string {
  const parts = [
    r.recoveredAt,
    `continuation=${r.continuationId}`,
    `phase=${r.currentPhase}`,
    `launch=${r.sourceLaunchId}`,
    `controller=${r.controller}`,
    `status=${r.observedStatus}`,
    `recovered-by=${r.recoveryTrigger}`,
  ];
  if (r.dispatchedRunId) parts.push(`run=${r.dispatchedRunId}`);
  if (r.dispatchedTaskId) parts.push(`task=${r.dispatchedTaskId}`);
  return `  ${parts.join("  ")}`;
}
