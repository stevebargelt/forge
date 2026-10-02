// forge readiness <ticket-id> [--project <dir>] [--json]
//
// Runs the mechanical readiness preflight on a backlog ticket and prints
// the outcome, gaps, and refinement proposal. Read-only — no writes.
//
// The evaluator is also importable (evaluateReadiness from src/readiness/readiness.ts)
// so the orchestrator (FG-413) can call it programmatically without the CLI.

import type { Command } from "commander";
import { resolve } from "node:path";
import { readTicket } from "../../backlog/structured.js";
import { resolveBacklogStore } from "../../backlog/storage-mode.js";
import { evaluateReadiness } from "../../readiness/readiness.js";
import { readinessReport, type ReadinessReport } from "../../store/queue.js";

/** FG-847: a DB-mode ticket answers through readinessReport — the derivation the
 *  dashboard's GET /api/backlog/<id>/readiness serves. A markdown-mode ticket has no
 *  revision and no recorded assessment, so those read null/false. */
function reportFor(projectDir: string, ticketId: string): ReadinessReport {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const report = readinessReport(store.projectKey, ticketId);
    if (!report) throw new Error(`Ticket ${ticketId} not found`);
    return report;
  }
  const result = evaluateReadiness(readTicket(projectDir, ticketId));
  return { ticketId, ...result, revision: null, evaluatedAt: null, stale: false };
}

export function registerReadiness(program: Command): void {
  program
    .command("readiness")
    .argument("<ticket-id>", "ticket id (e.g. FG-123)")
    .description(
      "Evaluate a ticket's structural readiness for implementation. Mechanical check only — does not assess semantic quality or operator-instruction reconciliation (orchestrator's job). Read-only.",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit { ticketId, outcome, gaps, refinementProposal, revision, evaluatedAt, stale } as JSON")
    .action((ticketId: string, opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const result = reportFor(projectDir, ticketId);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Ticket:  ${ticketId}`);
      console.log(`Outcome: ${result.outcome}`);
      if (result.gaps.length > 0) {
        console.log("Gaps:");
        for (const g of result.gaps) console.log(`  - ${g}`);
      }
      if (result.refinementProposal) {
        console.log(`\nRefinement proposal:\n  ${result.refinementProposal}`);
      }
    });
}
