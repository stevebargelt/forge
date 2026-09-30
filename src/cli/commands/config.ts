import type { Command } from "commander";
import { join, resolve } from "node:path";
import { buildConfigGraph } from "../../v2/config-graph.js";
import type { ConfigGraph } from "../../v2/config-graph-types.js";
import {
  AI_ATTRIBUTION_MODES,
  readAiAttribution,
  renderAiAttributionDetail,
  unsetAiAttribution,
  writeAiAttribution,
  writeHostAiAttribution,
  type AiAttributionMode,
} from "../../v2/ai-attribution.js";

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

  // FG-799: `forge config set ai-attribution <suppress|allow>` — a read-modify-write
  // of <project>/.forge/config.yml that PRESERVES every other key. The CLI key is
  // kebab (ai-attribution); the YAML key is snake (ai_attribution). Invalid values
  // are refused, naming the two that are valid. FG-845: `--host` writes the host
  // default ($FORGE_HOME/config.yml) instead, with the same discipline.
  config
    .command("set <key> <value>")
    .option("--project <dir>", "project whose .forge/config.yml to write (default: cwd)")
    .option("--host", "write the host default ($FORGE_HOME/config.yml) instead of the project file")
    .description("Set a config value. Supported key: ai-attribution (suppress|allow).")
    .action((key: string, value: string, opts: { project?: string; host?: boolean }) => {
      if (key !== "ai-attribution") {
        throw new Error(`unknown config key '${key}'. Supported: ai-attribution`);
      }
      if (!AI_ATTRIBUTION_MODES.includes(value as AiAttributionMode)) {
        throw new Error(
          `invalid ai-attribution value '${value}'. Valid values: ${AI_ATTRIBUTION_MODES.join(", ")}`,
        );
      }
      if (opts.host) {
        if (opts.project !== undefined) throw new Error("--host and --project are mutually exclusive");
        const file = writeHostAiAttribution(value as AiAttributionMode);
        console.log(`set ai-attribution = ${value} (host default, ${file})`);
        return;
      }
      const projectDir = resolve(opts.project ?? process.cwd());
      writeAiAttribution(projectDir, value as AiAttributionMode);
      console.log(`set ai-attribution = ${value} (${join(projectDir, ".forge", "config.yml")})`);
    });

  // FG-845: `forge config unset ai-attribution` — remove the project key so the
  // project inherits the host default. Read-modify-write; an absent key is a no-op
  // that says so. Only ai-attribution is unsettable.
  config
    .command("unset <key>")
    .option("--project <dir>", "project whose .forge/config.yml to edit (default: cwd)")
    .description("Remove a project config value so the host default applies. Supported key: ai-attribution.")
    .action((key: string, opts: { project?: string }) => {
      if (key !== "ai-attribution") {
        throw new Error(`unknown config key '${key}'. Supported: ai-attribution`);
      }
      const projectDir = resolve(opts.project ?? process.cwd());
      const file = join(projectDir, ".forge", "config.yml");
      const removed = unsetAiAttribution(projectDir);
      console.log(
        removed
          ? `unset ai-attribution (${file})`
          : `ai-attribution was not set in ${file}; nothing to unset`,
      );
      console.log(renderAiAttributionDetail(readAiAttribution(projectDir)));
    });

  // FG-799: `forge config show` — the effective per-project settings and where each
  // came from. Today that is the ai_attribution mode; the line is identical to the
  // one `forge doctor` prints. FG-845: the source is project / host / default.
  config
    .command("show")
    .option("--project <dir>", "project whose effective config to show (default: cwd)")
    .option("--json", "emit { aiAttribution: { mode, source, file } } as JSON")
    .description("Show effective config (ai attribution mode + source: project, host, or default).")
    .action((opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const a = readAiAttribution(projectDir);
      if (opts.json) console.log(JSON.stringify({ aiAttribution: a }, null, 2));
      else console.log(renderAiAttributionDetail(a));
    });
}
