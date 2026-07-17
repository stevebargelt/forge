import type { Command } from "commander";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assetRoot } from "../../v2/asset-root.js";
import { assertDashboardClosure } from "../../v2/release.js";

// FG-580 (Option A): the dashboard is BUNDLED into the promoted release, so
// `forge dashboard` works from a release, not only from a dev checkout. Resolution is
// RELEASE-OWNED — it flows from assetRoot() (module-relative to the executing release, or
// the dev checkout when running from source), never from the invocation cwd, an ambient
// FORGE_REPO_DIR, or ~/code/forge. Under a release, assetRoot() IS the release root, so
// the dashboard's `dashboard/`↔`src/` sibling layout and tsconfig-paths `@forge/*` resolve
// from the closure's own bytes.
//
// FG-569's named release-mode refusal is RETIRED — but its intent is preserved: a
// torn/incomplete release (missing dashboard entry, static asset, vendored client lib, or
// a dashboard-relevant dep) fails NAMED and NONZERO via assertDashboardClosure, and NEVER
// silently falls back to a dev checkout (assetRoot() cannot reach one from a release).
function resolveDashboard(): { dashboardDir: string; serverEntry: string } {
  const root = assetRoot();
  // Refuse a torn/incomplete release up front, by name — never proceed to a half-present
  // dashboard, and never reach outside the executing release for missing bytes.
  assertDashboardClosure(root);
  const dashboardDir = join(root, "dashboard");
  const serverEntry = join(dashboardDir, "src", "server.ts");
  return { dashboardDir, serverEntry };
}

export function registerDashboard(program: Command): void {
  const dashboard = program
    .command("dashboard")
    .description("Web view of forge runs across every project on the host");

  // Bare `forge dashboard` (no subcommand): show help, as before. No release refusal —
  // the dashboard is bundled now (FG-580).
  dashboard.action(() => {
    dashboard.help();
  });

  dashboard
    .command("start")
    .description("Boot the dashboard HTTP server (default: http://127.0.0.1:8024)")
    .option("--port <n>", "TCP port (default: 8024)")
    .option("--host <h>", "bind host (default: 127.0.0.1)")
    .action((opts: { port?: string; host?: string }) => {
      const { dashboardDir, serverEntry } = resolveDashboard();

      const env = { ...process.env };
      if (opts.port) env["PORT"] = opts.port;
      if (opts.host) env["HOST"] = opts.host;

      // FG-580: run the server under THIS process's interpreter (process.execPath) — under
      // a release that IS the release's pinned interpreter, so the dashboard boots with NO
      // PATH lookup and NO node required on the caller's PATH. `--import tsx` resolves tsx
      // from the release's own node_modules (walked up from cwd=<release>/dashboard), and
      // cwd=<release>/dashboard is what lets tsx discover dashboard/tsconfig.json so the
      // `@forge/*` → `../src/*.ts` paths resolve at runtime. Spawning the tsx bin directly
      // would depend on `#!/usr/bin/env node` finding node on PATH — which a node-free
      // caller PATH does not — so we exec the interpreter ourselves.
      const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
        stdio: "inherit",
        cwd: dashboardDir,
        env,
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
