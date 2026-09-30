import { existsSync } from "node:fs";
import type { Command } from "commander";
import { listProjects, sortProjects, findProject, operatorProjects, type ProjectRecord } from "../../util/projects.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { listRuns } from "../../store/runs.js";
import { recordPrunedCheckouts } from "../../store/pruned-checkouts.js";
import {
  classifyWorkspacePurpose,
  isWorkspaceKind,
  WORKSPACE_KIND_VALUES,
  WorkspacePurposeConflictError,
} from "../../store/workspace-purpose.js";

export function registerProjects(program: Command): void {
  const projects = program
    .command("projects")
    .description("Local forge projects registry (derived from runs DB + filesystem scan)");

  projects
    .command("list")
    .description("List all forge projects on this host with last-activity and in-flight counts.")
    .option("--json", "emit JSON instead of a text table")
    .option("--sort <order>", "activity | name (default: activity)", "activity")
    .option("--scan-root <dir>", "filesystem root to scan (can repeat; default: $FORGE_PROJECT_SCAN_ROOTS or ~/code)", collect, [] as string[])
    .option("--scan-depth <n>", "max depth to walk during filesystem scan (default: 3)", (v) => parseInt(v, 10), 3)
    .action((opts: { json?: boolean; sort: string; scanRoot: string[]; scanDepth: number }) => {
      ensureForgeDirs();
      const order = opts.sort === "name" ? "name" : "activity";
      const listOpts = {
        ...(opts.scanRoot.length > 0 ? { scanRoots: opts.scanRoot } : {}),
        scanMaxDepth: opts.scanDepth,
      };
      // FG-745: the Projects list represents OPERATOR projects. operatorProjects()
      // drops only records recorded as an explicit artifact kind (disposable_clone /
      // worktree / evidence_fixture) and keeps operator + (flagged) unclassified — the
      // SAME membership GET /api/projects applies, so the two agree (AC7). No path,
      // name, age, run-count, or remote heuristic decides visibility.
      const recs = sortProjects(operatorProjects(listProjects(listOpts)), order);
      if (opts.json) {
        console.log(JSON.stringify({ projects: recs }, null, 2));
        return;
      }
      if (recs.length === 0) {
        console.log("No forge projects found. Try: cd ~/code/<your-project> && forge init");
        return;
      }
      printTable(recs);
    });

  projects
    .command("show")
    .argument("<query>", "project name, basename, or path (substring match OK)")
    .description("Show detailed info for one project (recent runs, paths, color, description).")
    .option("--json", "emit JSON instead of a human-readable view")
    .option("--scan-root <dir>", "filesystem root to scan (can repeat)", collect, [] as string[])
    .option("--scan-depth <n>", "max scan depth (default: 3)", (v) => parseInt(v, 10), 3)
    .action((query: string, opts: { json?: boolean; scanRoot: string[]; scanDepth: number }) => {
      ensureForgeDirs();
      const listOpts = {
        ...(opts.scanRoot.length > 0 ? { scanRoots: opts.scanRoot } : {}),
        scanMaxDepth: opts.scanDepth,
      };
      const recs = listProjects(listOpts);
      const match = findProject(query, recs);
      if (!match) {
        console.error(`No project matched "${query}". Try: forge projects list`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        const recent = listRuns()
          .filter((r) => r.projectDir === match.projectDir)
          .slice(0, 10)
          .map((r) => ({ id: r.id, workflow: r.workflow, title: r.title, status: r.status, createdAt: r.createdAt }));
        console.log(JSON.stringify({ project: match, recentRuns: recent }, null, 2));
        return;
      }
      printShow(match);
    });

  projects
    .command("classify")
    .argument("<dir>", "the workspace directory to classify (a path on this host)")
    .requiredOption(
      "--purpose <kind>",
      `workspace kind: ${WORKSPACE_KIND_VALUES.join(" | ")}`,
    )
    .option("--owner-identity <projectIdentity>", "the durable project identity that owns this artifact")
    .option("--run <runId>", "the run that created this artifact")
    .option("--task <taskId>", "the task that created this artifact")
    .option("--actor <who>", "the acting operator, recorded on the classify audit trail (defaults to $USER)")
    .option("--json", "emit JSON instead of a human-readable line")
    .description(
      "Classify a legacy or manually-created workspace's purpose (FG-745 repair path). " +
        "Refuses to silently reassign a directory already recorded with a different purpose.",
    )
    .action(
      (
        dir: string,
        opts: { purpose: string; ownerIdentity?: string; run?: string; task?: string; actor?: string; json?: boolean },
      ) => {
        ensureForgeDirs();
        if (!isWorkspaceKind(opts.purpose)) {
          console.error(
            `Unknown --purpose "${opts.purpose}". Expected one of: ${WORKSPACE_KIND_VALUES.join(", ")}.`,
          );
          process.exitCode = 1;
          return;
        }
        const owner = {
          ...(opts.ownerIdentity ? { projectIdentity: opts.ownerIdentity } : {}),
          ...(opts.run ? { runId: opts.run } : {}),
          ...(opts.task ? { taskId: opts.task } : {}),
        };
        // Best-effort attribution for the audit trail: an explicit --actor, else the OS
        // user running the CLI. Never fabricated — an empty $USER stays unattributed.
        const actor = opts.actor ?? process.env["USER"] ?? undefined;
        try {
          const result = classifyWorkspacePurpose({
            path: dir,
            kind: opts.purpose,
            ...(Object.keys(owner).length > 0 ? { owner } : {}),
            ...(actor ? { actor } : {}),
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const from = result.previousKind ? ` (was ${result.previousKind})` : "";
            console.log(`Classified ${result.path} as ${result.kind}${from}.`);
          }
        } catch (err) {
          if (err instanceof WorkspacePurposeConflictError) {
            console.error(err.message);
          } else {
            console.error(err instanceof Error ? err.message : String(err));
          }
          process.exitCode = 1;
        }
      },
    );

  registerPrune(projects);
}

// FG-831: the registry-hygiene verb. `--missing` is the only criterion: a checkout
// registration whose directory no longer exists. It prints each registration and, without
// --dry-run, records it as pruned (src/store/pruned-checkouts.ts) so the registry stops
// offering it. It never touches a directory and never deletes a run.
function registerPrune(projects: Command): void {
  projects
    .command("prune")
    .description(
      "Remove checkout registrations whose directory no longer exists on disk. Prints each one; " +
        "--dry-run writes nothing. Never touches a directory or deletes a run.",
    )
    .option("--missing", "prune registrations whose checkout directory is gone (required)")
    .option("--dry-run", "print what would be pruned without recording anything")
    .option("--json", "emit JSON instead of text")
    .option("--actor <who>", "the acting operator, recorded on the prune audit trail (defaults to $USER)")
    .option("--scan-root <dir>", "filesystem root to scan (can repeat)", collect, [] as string[])
    .option("--scan-depth <n>", "max scan depth (default: 3)", (v) => parseInt(v, 10), 3)
    .action((opts: { missing?: boolean; dryRun?: boolean; json?: boolean; actor?: string; scanRoot: string[]; scanDepth: number }) => {
      if (!opts.missing) {
        console.error("forge projects prune: pass --missing (the only prune criterion: a checkout whose directory is gone).");
        process.exitCode = 1;
        return;
      }
      ensureForgeDirs();
      const recs = listProjects({
        ...(opts.scanRoot.length > 0 ? { scanRoots: opts.scanRoot } : {}),
        scanMaxDepth: opts.scanDepth,
      });
      const seen = new Set<string>();
      const candidates: Array<{ checkoutRoot: string; project: string; runCount: number }> = [];
      for (const rec of recs) {
        for (const checkout of rec.checkouts) {
          // Re-check at the moment of pruning: the registry's answer may be up to one
          // listing old, and a directory that came back is not missing.
          if (checkout.exists || existsSync(checkout.projectDir) || seen.has(checkout.projectDir)) continue;
          seen.add(checkout.projectDir);
          candidates.push({ checkoutRoot: checkout.projectDir, project: rec.label, runCount: checkout.runCount });
        }
      }
      candidates.sort((a, b) => a.project.localeCompare(b.project) || a.checkoutRoot.localeCompare(b.checkoutRoot));
      const actor = opts.actor ?? process.env["USER"] ?? "operator";
      if (!opts.dryRun && candidates.length > 0) recordPrunedCheckouts(candidates.map((c) => c.checkoutRoot), actor);
      if (opts.json) {
        console.log(JSON.stringify({ dryRun: !!opts.dryRun, pruned: candidates }, null, 2));
        return;
      }
      if (candidates.length === 0) {
        console.log("No checkout registrations point at a missing directory.");
        return;
      }
      const verb = opts.dryRun ? "would prune" : "pruned";
      for (const c of candidates) {
        console.log(`${verb}  ${c.checkoutRoot}  (${c.project}, ${c.runCount} run${c.runCount === 1 ? "" : "s"})`);
      }
      console.log(
        opts.dryRun
          ? `${candidates.length} missing checkout registration(s); nothing written (--dry-run).`
          : `${candidates.length} missing checkout registration(s) pruned. Their runs are kept; no directory was touched.`,
      );
    });
}

// commander option collector for repeatable --scan-root flags.
function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function printTable(recs: ProjectRecord[]): void {
  const nameW = Math.min(40, Math.max(4, ...recs.map((r) => r.label.length)));
  const liveW = 4;          // "LIVE" header
  const activityW = 14;
  const runsW = 6;
  const flightW = 9;

  const header =
    `${"LIVE".padEnd(liveW)}  ${"NAME".padEnd(nameW)}  ${"LAST ACTIVITY".padEnd(activityW)}  ${"RUNS".padStart(runsW)}  ${"IN-FLIGHT".padStart(flightW)}  PATH`;
  console.log(header);
  console.log("─".repeat(Math.min(120, header.length)));
  for (const r of recs) {
    const live = (r.liveSessions > 0 ? (r.liveSessions === 1 ? "●" : `●${r.liveSessions}`) : " ").padEnd(liveW);
    const name = truncate(r.label, nameW).padEnd(nameW);
    const activity = (r.lastRunAt ? relativeTime(r.lastRunAt) : "no runs").padEnd(activityW);
    const runs = String(r.runCount).padStart(runsW);
    const flight = (r.inFlightCount > 0 ? `⚡ ${r.inFlightCount}` : String(r.inFlightCount)).padStart(flightW);
    console.log(`${live}  ${name}  ${activity}  ${runs}  ${flight}  ${r.projectDir}`);
  }
}

function printShow(r: ProjectRecord): void {
  console.log(`Project:  ${r.label}`);
  console.log(`Path:     ${r.projectDir}`);
  console.log(`Color:    ${r.color}`);
  console.log(`Purpose:  ${r.purpose} (${r.classification})`);
  if (r.owner?.projectIdentity) console.log(`Owner:    ${r.owner.projectIdentity}${r.owner.runId ? ` (run ${r.owner.runId})` : ""}`);
  if (r.retentionReason)   console.log(`Retained: ${r.retentionReason}`);
  if (r.description)        console.log(`Desc:     ${r.description}`);
  if (r.readmeFirstLine)    console.log(`README:   ${r.readmeFirstLine}`);
  console.log(``);
  console.log(`Activity:`);
  console.log(`  Live now:    ${r.liveSessions > 0 ? `${r.liveSessions} orchestrator session(s)` : "—"}`);
  console.log(`  Last run:    ${r.lastRunAt ? relativeTime(r.lastRunAt) + ` (${r.lastRunAt})` : "no runs yet"}`);
  console.log(`  Total runs:  ${r.runCount}`);
  console.log(`  In-flight:   ${r.inFlightCount}`);
  const recent = listRuns().filter((run) => run.projectDir === r.projectDir).slice(0, 10);
  if (recent.length > 0) {
    console.log(``);
    console.log(`Recent runs:`);
    for (const run of recent) {
      const status = `[${run.status}]`.padEnd(12);
      console.log(`  ${status} ${run.id}  ${run.title}`);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "?";
  const ms = Date.now() - t;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}
