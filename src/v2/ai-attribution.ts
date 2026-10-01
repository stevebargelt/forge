// FG-799: the per-project AI-attribution mode reader.
//
// <project>/.forge/config.yml carries an optional top-level `ai_attribution` key:
//   suppress | allow. ABSENT = suppress (today's behavior; no project changes on
//   upgrade). This is the single source the enforcement points read their mode
//   from: the no-ai-attribution constraint's enabled_when gate (constraints.ts),
//   the orchestrator-block render (renderOrchestratorTemplate below), and the commit-msg hook.
//
// The parse itself lives in ai-attribution-parse.ts — dependency-free, and shared
// (by test-pinned duplication) with the standalone hook reader — so the hook and
// this reader can no longer DISAGREE at the edges the way the old bash grep and
// `yaml` library did (FG-799 follow-up). Fail-closed: absent, malformed, nested, or
// an unrecognized value all read as the default `suppress`.
//
// FG-845: a host default sits beneath the project value — $FORGE_HOME/config.yml
// may carry the same key. Resolution is project → host → built-in suppress
// (resolveAiAttributionLevels); a level that is unreadable, unrecognized or duplicated fails
// closed where it stands rather than falling through to the next.
//
// FG-853: between the two sits the value dispatch carried into an agent container
// (FORGE_AI_ATTRIBUTION_CARRIED, set by buildDockerArgs from carriedAiAttributionValue),
// since the container cannot see the host file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeTopLevelConfigKey, writeHostConfigKey, writeTopLevelConfigKey } from "../backlog/config.js";
import {
  AI_ATTRIBUTION_CARRIED_ENV,
  AI_ATTRIBUTION_MODES,
  classifyAiAttributionReadError,
  describeAiAttributionFailure,
  formatCarriedAiAttribution,
  parseAiAttributionConfig,
  resolveAiAttributionLevels,
  type AiAttributionLevelRead,
  type AiAttributionMode,
} from "./ai-attribution-parse.js";

export { AI_ATTRIBUTION_CARRIED_ENV, AI_ATTRIBUTION_MODES };
export type { AiAttributionMode };

/** FG-853: `<x> (carried)` when the mode came from the value dispatch carried into an
 *  agent container, naming where the HOST resolved it. */
export type AiAttributionSource =
  | "project"
  | "host"
  | "default"
  | "project (carried)"
  | "host (carried)"
  | "default (carried)";

export type AiAttribution = {
  mode: AiAttributionMode;
  /** FG-845: `project` / `host` when that level's file carries a recognized value;
   *  `default` for the built-in suppress — nothing set, or a level failed closed.
   *  FG-853: `<x> (carried)` when the carried environment value resolved. */
  source: AiAttributionSource;
  /** The file the mode came from; on a fail-closed `default`, the file that stopped
   *  the resolution; null when nothing is set at either level. */
  file: string | null;
  /** Present only on a fail-closed stop, naming the file and the problem. */
  reason?: string;
  /** Present when the project value differs from a recognized host default. */
  overridesHost?: { mode: AiAttributionMode; file: string };
};

/** $FORGE_HOME resolved at CALL time, so a test (or a caller) that sets the env after
 *  import still reads the host file it names. */
export function hostAiAttributionFile(forgeHome?: string): string {
  return join(forgeHome ?? process.env.FORGE_HOME ?? join(homedir(), ".forge"), "config.yml");
}

export function projectAiAttributionFile(projectDir: string): string {
  return join(projectDir, ".forge", "config.yml");
}

function readLevel(path: string): AiAttributionLevelRead {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (err) {
    return classifyAiAttributionReadError(err);
  }
}

/** `carried` defaults to $FORGE_AI_ATTRIBUTION_CARRIED at call time; pass null to
 *  resolve without it (dispatch does, so it carries only the durable project's files). */
export function readAiAttribution(
  projectDir: string,
  opts: { forgeHome?: string; carried?: string | null } = {},
): AiAttribution {
  const files = { project: projectAiAttributionFile(projectDir), host: hostAiAttributionFile(opts.forgeHome) };
  const carried = (opts.carried === undefined ? process.env[AI_ATTRIBUTION_CARRIED_ENV] : opts.carried) ?? undefined;
  const projectRead = readLevel(files.project);
  const hostRead = readLevel(files.host);
  const r = resolveAiAttributionLevels(projectRead, hostRead, carried);
  if (r.failed) {
    const file = r.failed.level === "carried" ? null : files[r.failed.level];
    return { mode: "suppress", source: "default", file, reason: describeAiAttributionFailure(r.failed, files, carried) };
  }
  if (r.source === "default") return { mode: r.mode, source: "default", file: null };
  if (r.carried) return { mode: r.mode, source: `${r.carried.source} (carried)`, file: r.carried.file };
  const level = r.source === "host" ? "host" : "project";
  const out: AiAttribution = { mode: r.mode, source: level, file: files[level] };
  if (r.source === "project") {
    const inherited = resolveAiAttributionLevels({ kind: "absent" }, hostRead, carried);
    const inheritedFile =
      inherited.source === "host" ? files.host : inherited.carried?.source === "host" ? inherited.carried.file : null;
    if (inheritedFile && inherited.mode !== r.mode) out.overridesHost = { mode: inherited.mode, file: inheritedFile };
  }
  return out;
}

/** FG-853: the FORGE_AI_ATTRIBUTION_CARRIED value dispatch hands an agent container —
 *  the host's resolution for `projectDir`, always set (a bare built-in default is
 *  carried as `suppress;source=default;file=`), so the container's reader never falls
 *  through to a host file it cannot see. Resolved from the files alone, never from an
 *  inherited carried value, so a nested dispatch cannot propagate a stale one. */
export function carriedAiAttributionValue(projectDir: string, opts: { forgeHome?: string } = {}): string {
  const a = readAiAttribution(projectDir, { ...opts, carried: null });
  const source = a.source.startsWith("project") ? "project" : a.source.startsWith("host") ? "host" : "default";
  return formatCarriedAiAttribution({ mode: a.mode, source, file: a.file });
}

// FG-799: the orchestrator template carries ai_attribution block-conditionals —
// lines between `<!-- forge:if ai_attribution=<mode> -->` and `<!-- forge:endif -->`
// survive ONLY when <mode> matches the project's; the marker lines themselves are
// ALWAYS stripped. A template with no such markers is returned byte-for-byte. This
// is the ONLY per-mode difference in the rendered block — `forge upgrade` re-renders
// and flips it when the mode changes. FG-805: the Claude and Codex launch carriers
// render through this same function, so no delivered policy carries both bullets.
const IF_MARKER_RE = /^[ \t]*<!-- forge:if ai_attribution=(suppress|allow) -->[ \t]*$/;
const ENDIF_MARKER_RE = /^[ \t]*<!-- forge:endif -->[ \t]*$/;

export function renderOrchestratorTemplate(template: string, mode: AiAttributionMode): string {
  const lines = template.split("\n");
  const out: string[] = [];
  let keep = true;
  for (const line of lines) {
    const ifm = line.match(IF_MARKER_RE);
    if (ifm) {
      keep = ifm[1] === mode;
      continue;
    }
    if (ENDIF_MARKER_RE.test(line)) {
      keep = true;
      continue;
    }
    if (keep) out.push(line);
  }
  return out.join("\n");
}

export function writeAiAttribution(projectDir: string, mode: AiAttributionMode): void {
  writeTopLevelConfigKey(projectDir, "ai_attribution", mode, readsAs(mode));
}

// FG-845: every write is refused unless the edited file reads back as intended through
// the same parse the hook and readAiAttribution use.
function readsAs(mode: AiAttributionMode): (text: string) => boolean {
  return (text) => {
    const parsed = parseAiAttributionConfig(text);
    return parsed.recognized && parsed.mode === mode;
  };
}

/** FG-845: `forge config set ai-attribution <mode> --host` — read-modify-write of
 *  $FORGE_HOME/config.yml, preserving every other key; created when absent. */
export function writeHostAiAttribution(mode: AiAttributionMode, opts: { forgeHome?: string } = {}): string {
  const file = hostAiAttributionFile(opts.forgeHome);
  writeHostConfigKey(file, "ai_attribution", mode, readsAs(mode));
  return file;
}

/** FG-845: `forge config unset ai-attribution` — remove the project key so the
 *  project inherits the host default. Returns false (and writes nothing) when the
 *  key was not there. */
export function unsetAiAttribution(projectDir: string): boolean {
  return removeTopLevelConfigKey(projectDir, "ai_attribution", (text) => !parseAiAttributionConfig(text).present);
}

/** The one-line summary `forge config show` and `forge doctor` both print, e.g.
 *  `ai attribution: suppress (default)` / `ai attribution: allow (host (carried))`. */
export function formatAiAttribution(a: Pick<AiAttribution, "mode" | "source">): string {
  return `ai attribution: ${a.mode} (${a.source})`;
}

/** The line plus its detail: the file it came from, and a fail-closed reason when
 *  a level stopped the resolution. */
export function renderAiAttributionDetail(a: AiAttribution): string {
  const lines = [formatAiAttribution(a)];
  if (a.reason) lines.push(`  ⚠ ${a.reason}`);
  else if (a.file) lines.push(`  file: ${a.file}`);
  return lines.join("\n");
}
