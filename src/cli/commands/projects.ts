import type { Command } from "commander";
import { listProjects, sortProjects, findProject, type ProjectRecord } from "../../util/projects.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { listRuns } from "../../store/runs.js";

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
      const recs = sortProjects(listProjects(listOpts), order);
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
