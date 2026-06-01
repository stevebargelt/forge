import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { doctorReport } from "../../v2/provider-doctor.js";

export function registerProviders(program: Command): void {
  const providers = program
    .command("providers")
    .description("Provider / auth diagnostics (AWN-7)");

  providers
    .command("doctor")
    .description("Report which auth modes have working credentials in this environment")
    .option("--json", "emit JSON instead of a human summary")
    .action((opts: { json?: boolean }) => {
      ensureForgeDirs();
      const report = doctorReport();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log("Provider auth status:");
      for (const p of report) {
        const icon = p.status === "available" ? "✓" : p.status === "unavailable" ? "✗" : "?";
        console.log(`  ${icon} ${`${p.provider}/${p.mode}`.padEnd(24)}${p.status.padEnd(13)}${p.detail}`);
      }
      console.log("");
      console.log("'?' = couldn't determine from the host (e.g. OAuth lives in a docker volume).");
    });
}
