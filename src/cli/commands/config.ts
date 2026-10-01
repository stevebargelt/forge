import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logEvent } from "../../store/events.js";
import { restoreHostConfig, restoreProjectConfig } from "../../backlog/config.js";
import { buildConfigGraph } from "../../v2/config-graph.js";
import type { ConfigGraph } from "../../v2/config-graph-types.js";
import {
  AI_ATTRIBUTION_MODES,
  readAiAttribution,
  renderAiAttributionDetail,
  unsetAiAttribution,
  writeAiAttribution,
  writeHostAiAttribution,
  hostAiAttributionFile,
  type AiAttributionMode,
} from "../../v2/ai-attribution.js";
import { parseAiAttributionConfig } from "../../v2/ai-attribution-parse.js";

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

/** One level's own value: the recognized mode, `invalid` for a present-but-unusable key,
 *  null when the file sets none. */
function levelValue(file: string): AiAttributionMode | "invalid" | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseAiAttributionConfig(text);
  if (!parsed.present) return null;
  return parsed.recognized ? parsed.mode : "invalid";
}

function actorOf(raw: string | undefined): string {
  const actor = raw ?? process.env["USER"] ?? "operator";
  if (actor === "" || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new Error("--actor must be a non-empty name");
  return actor;
}

/** FG-845: the audit record of an attribution change — only when the level's value moved.
 *  One event per applied change: when the insert fails the write is undone (the edit's
 *  previous bytes restored) and the returned refusal names the audit. */
function auditOrUndo(
  change: {
    level: "project" | "host";
    file: string;
    before: AiAttributionMode | "invalid" | null;
    after: AiAttributionMode | null;
    actor: string;
    projectDir?: string;
  },
  undo: () => void,
): string | undefined {
  if (change.before === change.after) return undefined;
  try {
    const resolved = change.projectDir ? readAiAttribution(change.projectDir) : undefined;
    logEvent("config.ai_attribution_changed", {
      payload: { ...change, ...(resolved ? { resolved: { mode: resolved.mode, source: resolved.source } } : {}) },
    });
    return undefined;
  } catch (err) {
    const why = `the config.ai_attribution_changed audit event could not be recorded (${err instanceof Error ? err.message : String(err)})`;
    try {
      undo();
    } catch (undoErr) {
      return `${why}, and restoring ${change.file} failed (${undoErr instanceof Error ? undoErr.message : String(undoErr)}) — the change is in place without an audit record; check the file by hand`;
    }
    return `${why}; ${change.file} is unchanged`;
  }
}

function report(line: string, json: object | undefined): void {
  console.log(json ? JSON.stringify(json, null, 2) : line);
}

function refuseUnaudited(error: string, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify({ ok: false, reason: "audit_unrecorded", error }, null, 2));
  console.error(`forge: refused — ${error}`);
  process.exitCode = 1;
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
    .option("--actor <name>", "who made the change, recorded on the config.ai_attribution_changed event (default: $USER)")
    .option("--json", "emit { key, mode, level, file } as JSON ({ ok: false, reason: 'audit_unrecorded', error } on a refusal)")
    .description("Set a config value. Supported key: ai-attribution (suppress|allow).")
    .action((key: string, value: string, opts: { project?: string; host?: boolean; actor?: string; json?: boolean }) => {
      if (key !== "ai-attribution") {
        throw new Error(`unknown config key '${key}'. Supported: ai-attribution`);
      }
      if (!AI_ATTRIBUTION_MODES.includes(value as AiAttributionMode)) {
        throw new Error(
          `invalid ai-attribution value '${value}'. Valid values: ${AI_ATTRIBUTION_MODES.join(", ")}`,
        );
      }
      const actor = actorOf(opts.actor);
      const mode = value as AiAttributionMode;
      if (opts.host) {
        if (opts.project !== undefined) throw new Error("--host and --project are mutually exclusive");
        const file = hostAiAttributionFile();
        const before = levelValue(file);
        const edit = writeHostAiAttribution(mode);
        const refusal = auditOrUndo({ level: "host", file, before, after: mode, actor }, () => restoreHostConfig(file, edit));
        if (refusal) return refuseUnaudited(refusal, opts.json);
        report(`set ai-attribution = ${value} (host default, ${file})`, opts.json ? { key: "ai-attribution", mode, level: "host", file } : undefined);
        return;
      }
      const projectDir = resolve(opts.project ?? process.cwd());
      const file = join(projectDir, ".forge", "config.yml");
      const before = levelValue(file);
      const edit = writeAiAttribution(projectDir, mode);
      const refusal = auditOrUndo({ level: "project", file, before, after: mode, actor, projectDir }, () => restoreProjectConfig(projectDir, edit));
      if (refusal) return refuseUnaudited(refusal, opts.json);
      report(`set ai-attribution = ${value} (${file})`, opts.json ? { key: "ai-attribution", mode, level: "project", file } : undefined);
    });

  // FG-845: `forge config unset ai-attribution` — remove the project key so the
  // project inherits the host default. Read-modify-write; an absent key is a no-op
  // that says so. Only ai-attribution is unsettable.
  config
    .command("unset <key>")
    .option("--project <dir>", "project whose .forge/config.yml to edit (default: cwd)")
    .option("--actor <name>", "who made the change, recorded on the config.ai_attribution_changed event (default: $USER)")
    .option("--json", "emit { key, removed, file, resolved } as JSON ({ ok: false, reason: 'audit_unrecorded', error } on a refusal)")
    .description("Remove a project config value so the host default applies. Supported key: ai-attribution.")
    .action((key: string, opts: { project?: string; actor?: string; json?: boolean }) => {
      if (key !== "ai-attribution") {
        throw new Error(`unknown config key '${key}'. Supported: ai-attribution`);
      }
      const projectDir = resolve(opts.project ?? process.cwd());
      const file = join(projectDir, ".forge", "config.yml");
      const actor = actorOf(opts.actor);
      const before = levelValue(file);
      const edit = unsetAiAttribution(projectDir);
      const removed = edit !== null;
      const refusal = edit
        ? auditOrUndo({ level: "project", file, before, after: null, actor, projectDir }, () => restoreProjectConfig(projectDir, edit))
        : undefined;
      if (refusal) return refuseUnaudited(refusal, opts.json);
      const resolved = readAiAttribution(projectDir);
      report(
        (removed ? `unset ai-attribution (${file})` : `ai-attribution was not set in ${file}; nothing to unset`) +
          `\n${renderAiAttributionDetail(resolved)}`,
        opts.json ? { key: "ai-attribution", removed, file, resolved } : undefined,
      );
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
