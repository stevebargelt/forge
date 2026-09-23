// FG-799: the per-project AI-attribution mode reader.
//
// <project>/.forge/config.yml carries an optional top-level `ai_attribution` key:
//   suppress | allow. ABSENT = suppress (today's behavior; no project changes on
//   upgrade). This is the single source the three enforcement points read their
//   mode from: the no-ai-attribution constraint's enabled_when gate
//   (constraints.ts), the orchestrator-block render (init.ts renderer), and — via a
//   bash-only grep, NOT this reader — the commit-msg hook.
//
// Fail-closed: absent, malformed, or an unrecognized value all read as the default
// `suppress`. A silent "allow" from a broken config is the one outcome this reader
// must never produce.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeTopLevelConfigKey } from "../backlog/config.js";

export type AiAttributionMode = "suppress" | "allow";

export const AI_ATTRIBUTION_MODES: readonly AiAttributionMode[] = ["suppress", "allow"];

export type AiAttribution = {
  mode: AiAttributionMode;
  /** `project-config` when the key is present with a recognized value; `default`
   *  when it is absent, malformed, or an unrecognized value fell back to suppress. */
  source: "project-config" | "default";
};

export function readAiAttribution(projectDir: string): AiAttribution {
  const configPath = join(projectDir, ".forge", "config.yml");
  if (!existsSync(configPath)) return { mode: "suppress", source: "default" };
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return { mode: "suppress", source: "default" };
  }
  const top = (parsed as Record<string, unknown> | null) ?? {};
  const raw = top["ai_attribution"];
  if (raw === "allow") return { mode: "allow", source: "project-config" };
  if (raw === "suppress") return { mode: "suppress", source: "project-config" };
  return { mode: "suppress", source: "default" };
}

export function writeAiAttribution(projectDir: string, mode: AiAttributionMode): void {
  writeTopLevelConfigKey(projectDir, "ai_attribution", mode);
}

/** The one-line summary `forge config show` and `forge doctor` both print, e.g.
 *  `ai attribution: suppress (default)` / `ai attribution: allow (.forge/config.yml)`. */
export function formatAiAttribution(a: AiAttribution): string {
  const where = a.source === "project-config" ? ".forge/config.yml" : "default";
  return `ai attribution: ${a.mode} (${where})`;
}

export function renderAiAttributionLine(projectDir: string): string {
  return formatAiAttribution(readAiAttribution(projectDir));
}
