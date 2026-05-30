import type { Command } from "commander";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { parseSince } from "../../v2/runs-query.js";
import { computeMetrics, type MetricsFilters, type MetricDimension } from "../../v2/metrics.js";

// RUN-2: `forge metrics` — operational reliability rollup. Distinct from
// `forge usage` (token/cost); read-only; cross-project by default.

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function parseBy(raw: string): MetricDimension {
  if (raw === "workflow" || raw === "phase" || raw === "role") return raw;
  throw new Error(`--by must be one of: workflow | phase | role (got: ${raw})`);
}

export function registerMetrics(program: Command): void {
  program
    .command("metrics")
    .description("Operational reliability metrics: success rate, failures, durations, cancels, retries")
    .option("--since <window>", "time window: <N>d | all (default: all)", "all")
    .option("--by <dim>", "duration grouping: workflow | phase | role (default: phase)", "phase")
    .option("--project <dir>", "scope to a project dir (exact path or basename)")
    .option("--workflow <w>", "scope to a workflow")
    .option("--json", "emit JSON instead of a table")
    .action((opts: { since: string; by: string; project?: string; workflow?: string; json?: boolean }) => {
      ensureForgeDirs();
      getDb({ readOnly: true });

      const filters: MetricsFilters = {
        by: parseBy(opts.by),
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.workflow ? { workflow: opts.workflow } : {}),
        ...(() => { const c = parseSince(opts.since); return c !== undefined ? { sinceMs: c } : {}; })(),
      };

      const m = computeMetrics(filters);

      if (opts.json) {
        console.log(JSON.stringify(m, null, 2));
        return;
      }

      const pct = (m.runs.successRate * 100).toFixed(0);
      console.log(`Runs: ${m.runs.total}  (clean ${m.runs.clean} · with-failures ${m.runs.withFailures} · success rate ${pct}%)`);
      console.log(`Tasks: ${m.taskCount}`);
      console.log(`Operational: idle-kills ${m.counts.idleKills} · cancels ${m.counts.cancels} · retries ${m.counts.retries} · red-blocks ${m.counts.redBlocks}`);

      if (m.failureKinds.length > 0) {
        console.log(`\nFailure kinds:`);
        for (const { kind, count } of m.failureKinds) console.log(`  ${count.toString().padStart(4)}  ${kind}`);
      }

      if (m.durations.length > 0) {
        console.log(`\nMedian task duration by ${m.durationsBy}:`);
        for (const d of m.durations) console.log(`  ${fmtMs(d.medianMs).padStart(7)}  ${d.dimension}  (n=${d.count})`);
      }
    });
}
