import type { Command } from "commander";
import { getDb } from "../../store/db.js";
import { renderedEmptyStore } from "../no-store.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { queryRuns, parseSince, type RunFilters, type RunQueryRow } from "../../v2/runs-query.js";

// RUN-1: `forge runs query` — search historical runs by status, failure_kind,
// project, age. Read-only; cross-project by default (like the dashboard).

function toJson(r: RunQueryRow) {
  return {
    runId: r.run.id,
    status: r.run.status,
    workflow: r.run.workflow,
    title: r.run.title,
    projectDir: r.run.projectDir ?? null,
    createdAt: r.run.createdAt,
    completedAt: r.run.completedAt ?? null,
    taskCount: r.taskCount,
    failedCount: r.failedCount,
    failureKinds: r.failureKinds,
  };
}

export function registerRuns(program: Command): void {
  const runs = program.command("runs").description("Query historical runs");

  runs
    .command("query")
    .description("Search runs by status, failure-kind, project, or age")
    .option("--status <s>", "filter by run status (active | complete | failed | abandoned)")
    .option("--failure-kind <k>", "keep runs with a top-level task that failed with this kind")
    .option("--project <dir>", "filter by project dir (exact path or basename)")
    .option("--workflow <w>", "filter by workflow name")
    .option("--since <window>", "time window: <N>d | all (default: all)", "all")
    .option("--json", "emit JSON instead of a table")
    .action((opts: { status?: string; failureKind?: string; project?: string; workflow?: string; since: string; json?: boolean }) => {
      ensureForgeDirs();
      if (renderedEmptyStore(opts.json, [], "No matching runs.")) return;
      getDb({ readOnly: true });

      const filters: RunFilters = {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.failureKind ? { failureKind: opts.failureKind } : {}),
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.workflow ? { workflow: opts.workflow } : {}),
        ...(() => { const c = parseSince(opts.since); return c !== undefined ? { sinceMs: c } : {}; })(),
      };

      const rows = queryRuns(filters);

      if (opts.json) {
        console.log(JSON.stringify(rows.map(toJson), null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No matching runs.");
        return;
      }
      for (const r of rows) {
        const fk = r.failureKinds.length > 0 ? `  failures: ${r.failureKinds.join(",")}` : "";
        console.log(
          `${r.run.id}  [${r.run.status}]  ${r.run.workflow}  ${r.run.createdAt.slice(0, 10)}  ` +
          `tasks:${r.taskCount} failed:${r.failedCount}${fk}  — ${r.run.title}`,
        );
      }
      console.log(`\n${rows.length} run(s).`);
    });
}
