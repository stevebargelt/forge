import type { Command } from "commander";
import { insertHostVerification } from "../../store/host-verifications.js";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";

export function registerRecordHostVerification(program: Command): void {
  program
    .command("record-host-verification")
    .description("Record host-side verification evidence for a ticket/commit (FG-419)")
    .requiredOption("--ticket <ticketId>", "ticket ID (e.g. FG-419)")
    .requiredOption("--project-dir <path>", "absolute path to the project directory")
    .requiredOption("--commit <sha>", "commit SHA that was verified")
    .requiredOption(
      "--command <cmd>",
      "the exact command that was run — required to prove this is a real result, not an assertion"
    )
    .requiredOption("--exit-code <n>", "exit code of the command (0 = pass, non-zero = fail)", (val: string) => {
      if (!/^-?\d+$/.test(val.trim())) {
        throw new Error(`--exit-code must be an integer, got: "${val}"`);
      }
      return parseInt(val, 10);
    })
    .option("--gate <name>", "gate name override (defaults to the --command value)")
    .option("--run-id <id>", "optional forge run ID to associate with this record")
    .action(
      (opts: {
        ticket: string;
        projectDir: string;
        commit: string;
        command: string;
        exitCode: number;
        gate?: string;
        runId?: string;
      }) => {
        ensureForgeDirs();
        getDb();

        const gateName = opts.gate ?? opts.command;

        insertHostVerification({
          ticketId: opts.ticket,
          projectDir: opts.projectDir,
          commitSha: opts.commit,
          gateName,
          command: opts.command,
          exitCode: opts.exitCode,
          runId: opts.runId ?? null,
          recordedAt: new Date().toISOString(),
        });

        const outcome = opts.exitCode === 0 ? "pass" : `fail (exit ${opts.exitCode})`;
        console.log(
          `forge record-host-verification: recorded ${outcome} for ${opts.ticket} @ ${opts.commit.slice(0, 8)} (gate: ${gateName})`
        );
      }
    );
}
