// FG-799: the per-project AI-attribution mode reader.
//
// <project>/.forge/config.yml carries an optional top-level `ai_attribution` key:
//   suppress | allow. ABSENT = suppress (today's behavior; no project changes on
//   upgrade). This is the single source the enforcement points read their mode
//   from: the no-ai-attribution constraint's enabled_when gate (constraints.ts),
//   the orchestrator-block render (init.ts renderer), and the commit-msg hook.
//
// The parse itself lives in ai-attribution-parse.ts — dependency-free, and shared
// (by test-pinned duplication) with the standalone hook reader — so the hook and
// this reader can no longer DISAGREE at the edges the way the old bash grep and
// `yaml` library did (FG-799 follow-up). Fail-closed: absent, malformed, nested, or
// an unrecognized value all read as the default `suppress`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTopLevelConfigKey } from "../backlog/config.js";
import {
  AI_ATTRIBUTION_MODES,
  parseAiAttributionConfig,
  type AiAttributionMode,
} from "./ai-attribution-parse.js";

export { AI_ATTRIBUTION_MODES };
export type { AiAttributionMode };

export type AiAttribution = {
  mode: AiAttributionMode;
  /** `project-config` when the key is present with a recognized value; `default`
   *  when it is absent, malformed, or an unrecognized value fell back to suppress. */
  source: "project-config" | "default";
};

export function readAiAttribution(projectDir: string): AiAttribution {
  const configPath = join(projectDir, ".forge", "config.yml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { mode: "suppress", source: "default" };
  }
  const parsed = parseAiAttributionConfig(text);
  return parsed.recognized
    ? { mode: parsed.mode, source: "project-config" }
    : { mode: "suppress", source: "default" };
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
