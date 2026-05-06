import type { Command } from "commander";
import { startDashboard, shutdown } from "../../dashboard/server.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("--port <n>", "Port to listen on", "3737")
    .action(async (opts: { port: string }) => {
      const port = parseInt(opts.port, 10);
      await startDashboard(port);
      console.log(`Dashboard running at http://127.0.0.1:${port}`);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
