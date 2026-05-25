import type { Command } from "commander";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Locate forge's root by walking up from this source file. Mirrors the pattern
// in init.ts — works under both `tsx` (src/cli/commands/dashboard.ts) and `tsc`
// build output (dist/cli/commands/dashboard.js). The dashboard workspace is at
// <forge-root>/dashboard; tsx lives at <forge-root>/node_modules/.bin/tsx.
function resolveForgeRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", ".."),       // src/cli/commands/ → root
    resolve(here, "..", "..", "..", ".."), // dist/cli/commands/ → root
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, "dashboard", "src", "server.ts"))) return c;
  }
  throw new Error(
    `forge dashboard: could not locate the dashboard workspace. Looked at:\n  ${candidates
      .map((c) => resolve(c, "dashboard"))
      .join("\n  ")}`
  );
}

export function registerDashboard(program: Command): void {
  const dashboard = program
    .command("dashboard")
    .description("Web view of forge runs across every project on the host");

  dashboard
    .command("start")
    .description("Boot the dashboard HTTP server (default: http://127.0.0.1:8024)")
    .option("--port <n>", "TCP port (default: 8024)")
    .option("--host <h>", "bind host (default: 127.0.0.1)")
    .action((opts: { port?: string; host?: string }) => {
      const root = resolveForgeRoot();
      const dashboardDir = resolve(root, "dashboard");
      const tsx = resolve(root, "node_modules", ".bin", "tsx");
      const serverEntry = resolve(dashboardDir, "src", "server.ts");

      if (!existsSync(tsx)) {
        throw new Error(
          `forge dashboard: tsx not found at ${tsx}. Run 'npm install' in the forge repo root.`
        );
      }

      const env = { ...process.env };
      if (opts.port) env["PORT"] = opts.port;
      if (opts.host) env["HOST"] = opts.host;

      const child = spawn(tsx, [serverEntry], {
        stdio: "inherit",
        cwd: dashboardDir,
        env,
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
