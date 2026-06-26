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
import { evaluateReadiness } from "../../readiness/readiness.js";

export function registerReadiness(program: Command): void {
  program
    .command("readiness")
    .argument("<ticket-id>", "ticket id (e.g. FG-123)")
    .description(
      "Evaluate a ticket's structural readiness for implementation. Mechanical check only — does not assess semantic quality or operator-instruction reconciliation (orchestrator's job). Read-only.",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit { ticketId, outcome, gaps, refinementProposal } as JSON")
    .action((ticketId: string, opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const ticket = readTicket(projectDir, ticketId);
      const result = evaluateReadiness(ticket);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ticketId,
              outcome: result.outcome,
              gaps: result.gaps,
              refinementProposal: result.refinementProposal,
            },
            null,
            2,
          ),
        );
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
