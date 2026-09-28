import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { assetRoot } from "../../v2/asset-root.js";
import { assertDashboardClosure } from "../../v2/release.js";
import { storeExists } from "../../store/db.js";
import { composeInbox, renderAttentionInboxLines, type InboxEnvelope } from "../../v2/attention-inbox.js";

// FG-820: `forge attention list` — the Human Attention Inbox on the CLI. The derivation is
// core (deriveAttentionInbox), but its store readers are bound to the dashboard's project-
// scope resolution, so this shells into dashboard/src/attention/cli-entry.ts — the kanban
// `sync` layering precedent — which makes the SAME attentionInboxFor call GET
// /api/attention-inbox makes. `--json` therefore prints the envelope the dashboard serves.
// Read-only: the dashboard handle opens the store read-only, and a host with no store
// answers the empty inbox without creating one (FG-608).

export function resolveAttentionEntry(): { dashboardDir: string; entry: string } {
  const root = assetRoot();
  assertDashboardClosure(root);
  const dashboardDir = join(root, "dashboard");
  return { dashboardDir, entry: join(dashboardDir, "src", "attention", "cli-entry.ts") };
}

type EntryResult = InboxEnvelope | { error: string };

function readInbox(projectDir: string | undefined, runId: string | undefined): EntryResult {
  if (!storeExists()) {
    return composeInbox([], {
      generatedAt: new Date().toISOString(),
      scope: { runId: runId ?? null, projectDirs: projectDir === undefined ? null : [projectDir] },
    });
  }
  const { dashboardDir, entry } = resolveAttentionEntry();
  const args = ["--import", "tsx", entry];
  if (projectDir !== undefined) args.push("--project-dir", projectDir);
  if (runId !== undefined) args.push("--run", runId);
  // cwd=<dashboard> so tsx discovers dashboard/tsconfig.json and the `@forge/*` paths resolve.
  // stderr is inherited: a degraded source's diagnostic reaches the operator as it would
  // the dashboard's log.
  const child = spawnSync(process.execPath, args, {
    cwd: dashboardDir,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`the attention inbox read exited ${child.status ?? child.signal}`);
  return JSON.parse(child.stdout) as EntryResult;
}

export function registerAttention(program: Command): void {
  const attention = program
    .command("attention")
    .description("The Human Attention Inbox: open items that need an operator, derived as the dashboard derives them.");

  attention
    .command("list")
    .option("--project <dir>", "scope to one project checkout (default: host-wide, as the dashboard's unscoped inbox)")
    .option("--run <run-id>", "only items linked to this run")
    .option("--json", "print the inbox envelope exactly as GET /api/attention-inbox serves it")
    .description("List open attention items (read-only).")
    .action((opts: { project?: string; run?: string; json?: boolean }) => {
      const projectDir = opts.project === undefined ? undefined : resolve(opts.project);
      const result = readInbox(projectDir, opts.run);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      if ("error" in result) {
        if (!opts.json) console.error(`forge attention list: the attention inbox is unavailable: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) return;
      for (const line of renderAttentionInboxLines(result)) console.log(line);
    });
}
