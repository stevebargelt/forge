import type { Command } from "commander";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readReleaseManifest } from "../../v2/release.js";

// FG-569 (Resolution B): the dashboard is a SEPARATE application workspace with its own
// dependency tree — deliberately NOT bundled into a control-plane release (deferred to
// FG-572 / Child 5). When forge runs FROM a release (this module resolves a release
// manifest by walking up from its own location), refuse IMMEDIATELY with a named, nonzero
// error BEFORE any attempt to resolve dashboard/src/server.ts — else the command would die
// with a confusing "could not locate the dashboard workspace" from resolveForgeRoot. In dev
// mode (no manifest above this file) this is a no-op and behavior is unchanged.
function refuseDashboardInRelease(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  if (readReleaseManifest(here)) {
    throw new Error(
      "forge dashboard is not available from a control-plane release build (deferred to FG-572 / Child 5) — the dashboard is a separate application workspace and is not bundled. Run it from a source checkout of the forge repo instead."
    );
  }
}

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

  // Bare `forge dashboard` (no subcommand): refuse in release mode, else show help as
  // before. Registered as an action so the release refusal fires on the bare invocation
  // too, not only on `dashboard start`.
  dashboard.action(() => {
    refuseDashboardInRelease();
    dashboard.help();
  });

  dashboard
    .command("start")
    .description("Boot the dashboard HTTP server (default: http://127.0.0.1:8024)")
    .option("--port <n>", "TCP port (default: 8024)")
    .option("--host <h>", "bind host (default: 127.0.0.1)")
    .action((opts: { port?: string; host?: string }) => {
      refuseDashboardInRelease();
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
