import type { Command } from "commander";
import { resolve } from "node:path";
import { buildConfigGraph } from "../../v2/config-graph.js";
import type { ConfigGraph } from "../../v2/config-graph-types.js";

// `forge config graph --project . --json` — the read-only EFFECTIVE config graph
// the orchestrator and the dashboard both consume. The JSON is buildConfigGraph
// output printed UNMODIFIED (byte-identity with the in-process dashboard query);
// human-readable output is a thin secondary renderer of the same object. Never
// writes, never spawns an agent, never runs a subprocess.

/** Resolve the project dir the same way as the dashboard query and build the
 *  graph. Exported so byte-identity is testable without spawning the CLI. */
export function cliConfigGraph(projectDir?: string): ConfigGraph {
  return buildConfigGraph({ projectDir: resolve(projectDir ?? process.cwd()) });
}

/** A thin human-readable renderer of the SAME graph object the JSON prints. */
export function renderConfigGraphHuman(graph: ConfigGraph): string {
  const lines: string[] = [];
  lines.push(`# forge config graph (v${graph.version})`);
  lines.push(`# project: ${graph.project.dir} [${graph.project.status}]`);
  lines.push(`# forge home: ${graph.forgeHome}`);
  lines.push("");
  lines.push("## Sources (EFFECTIVE config for this project)");
  for (const row of graph.sections.sources.rows) {
    lines.push(`  ${row.status.padEnd(12)} ${row.truth.padEnd(9)} ${row.label}`);
    if (row.effectivePath) lines.push(`               effective: ${row.effectivePath}`);
    if (row.overrideCallout) lines.push(`               ${row.overrideCallout}`);
    if (row.warning) lines.push(`               ⚠ ${row.warning}`);
    else if (row.detail) lines.push(`               ${row.detail}`);
  }
  lines.push("");
  lines.push("## Providers / auth (host-observed)");
  for (const p of graph.sections.capabilities.providers) {
    lines.push(`  ${p.readiness.padEnd(12)} ${p.provider} (${p.mode}) — ${p.detail}`);
  }
  lines.push("");
  lines.push("## Capability matrix (inferred — would-be run container)");
  for (const c of graph.sections.capabilities.capabilities) {
    const lim = c.limitation ? ` — ${c.limitation}` : "";
    lines.push(`  ${c.support.padEnd(14)} ${c.capability}/${c.adapter}${lim}`);
  }
  lines.push("");
  lines.push("## Workflow prerequisites");
  for (const pr of graph.sections.capabilities.prerequisites) {
    lines.push(`  ${pr.readiness.padEnd(12)} ${pr.name} — ${pr.reason}`);
  }
  return lines.join("\n");
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Inspect the effective Forge configuration.");

  config
    .command("graph")
    .option("--project <dir>", "resolve the project override under <dir>/.forge (default: cwd)")
    .option("--json", "emit the structured config graph as JSON")
    .description(
      "Read-only EFFECTIVE config graph: which config Forge would use for a run here (sources + provider/runtime capabilities), with provenance. Never writes, edits, or probes.",
    )
    .action((opts: { project?: string; json?: boolean }) => {
      const graph = cliConfigGraph(opts.project);
      if (opts.json) {
        console.log(JSON.stringify(graph, null, 2));
      } else {
        console.log(renderConfigGraphHuman(graph));
      }
    });
}
