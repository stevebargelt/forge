// FG-799 (follow-up): the ONE parse of the per-project `ai_attribution` value.
//
// The mode a project selects is read at several enforcement points, and until now
// two of them parsed the raw `.forge/config.yml` DIFFERENTLY: the TypeScript reader
// (ai-attribution.ts) ran the `yaml` library, while the commit-msg hook ran a bash
// grep. A regex and a YAML parser cannot be kept in agreement at the edges — a
// root key with leading indentation (valid YAML the grep's `^` anchor missed), or a
// mismatched-quote value (invalid YAML the reader failed closed on, the grep let
// through) — so they DISAGREED, and "every enforcement point reads the same mode"
// stopped holding.
//
// This module is that single parse, expressed WITHOUT a dependency: it is the exact
// logic the standalone hook reader (scripts/git-hooks/read-ai-attribution.mjs) also
// runs, so both sides agree by construction. The reader cannot import this compiled
// module — it runs as a plain `.mjs` under bare `node`, with no tsx loader and, in a
// provisioned workspace clone, no reachable node_modules — so it carries a
// character-for-character copy of the algorithm below, PINNED BY TEST to this one:
// ai-attribution.test.ts drives readAiAttribution and the reader over the same table
// AND compares the two copies' parse helpers (parseAiAttributionConfig, scalarValue,
// stripComment) return value BY VALUE across the divergence-prone edges — so a drift
// that is behaviorally inert at the mode level (the malformed-quote sentinel once
// differed space-vs-NUL between the copies) still fails the pin (the
// forge-backlog-reader.mjs precedent).
//
// Fail-closed is the invariant: absent, malformed, nested, unrecognized, or a value
// with an unterminated quote all resolve to `suppress`. A silent `allow` from a
// broken or hand-mangled config is the one outcome no enforcement point may produce.

export type AiAttributionMode = "suppress" | "allow";

export const AI_ATTRIBUTION_MODES: readonly AiAttributionMode[] = ["suppress", "allow"];

export type ParsedAiAttribution = {
  mode: AiAttributionMode;
  /** true only when a TOP-LEVEL `ai_attribution` key carried a recognized value
   *  (allow | suppress). false — with mode `suppress` — for every fail-closed
   *  outcome (absent key, nested key, unknown/mangled value). */
  recognized: boolean;
  /** FG-845: true when a TOP-LEVEL `ai_attribution` key exists at all, recognized
   *  or not. A present-but-unrecognized key fails closed at ITS level — the host
   *  default beneath it is never consulted — while an absent key falls through. */
  present: boolean;
};

const NONE: ParsedAiAttribution = { mode: "suppress", recognized: false, present: false };

/** Parse the `ai_attribution` mode out of a `.forge/config.yml` body. `null` (the
 *  file could not be read) is the absent case. See the module header for why this
 *  is dependency-free and why the hook reader duplicates it. */
export function parseAiAttributionConfig(text: string | null): ParsedAiAttribution {
  if (text == null) return NONE;

  // Collect simple `key:` lines with their indentation. A line that is blank, a
  // comment, a list item, or a bare `:` does not match and is skipped.
  const keyLines: { indent: number; key: string; rest: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) keyLines.push({ indent: (m[1] ?? "").length, key: m[2] ?? "", rest: m[3] ?? "" });
  }
  if (keyLines.length === 0) return NONE;

  // The top level is the least-indented mapping level, NOT column 0: a document
  // whose whole top-level mapping is indented (valid YAML) still has its keys at
  // the top. A key deeper than that minimum is nested and is not the toggle.
  const minIndent = Math.min(...keyLines.map((k) => k.indent));
  const top = keyLines.find((k) => k.indent === minIndent && k.key === "ai_attribution");
  if (!top) return NONE;

  const value = scalarValue(top.rest);
  if (value === "allow" || value === "suppress") return { mode: value, recognized: true, present: true };
  return { mode: "suppress", recognized: false, present: true };
}

/** The scalar after `key:` — inline comment stripped, then unquoted. A value that
 *  OPENS a quote it never closes (or closes with the other kind) is malformed and
 *  returns a sentinel that matches no recognized value, so it fails closed. */
export function scalarValue(rest: string): string {
  const s = stripComment(rest).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  if (s[0] === '"' || s[0] === "'") return " malformed-quote";
  return s;
}

/** Drop a trailing `#` comment — but only a `#` that is outside quotes and either
 *  starts the scalar or follows whitespace, matching YAML's comment rule. */
export function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(s.charAt(i - 1)))) {
      return s.slice(0, i);
    }
  }
  return s;
}

// FG-845: the level resolution — project file, then host file, then the built-in
// `suppress`. Like the parse above it is dependency-free and duplicated (pinned by
// test) into the hook reader, so the hook and readAiAttribution resolve the SAME
// level, not just the same per-file parse. A level whose file is absent, or which
// has no top-level key, falls through to the next. A level whose file cannot be read,
// or whose key carries an unrecognized value, STOPS the resolution: it fails closed to
// `suppress` right there — a broken project file never lets a host `allow` through.

export type AiAttributionLevelRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "text"; text: string };

export type AiAttributionLevel = "project" | "host";

export type ResolvedAiAttributionLevels = {
  mode: AiAttributionMode;
  source: AiAttributionLevel | "default";
  /** Set only on a fail-closed stop: the level that stopped the resolution and why. */
  failed?: { level: AiAttributionLevel; why: "unreadable" | "unrecognized" };
};

export function resolveAiAttributionLevels(
  project: AiAttributionLevelRead,
  host: AiAttributionLevelRead,
): ResolvedAiAttributionLevels {
  const levels: [AiAttributionLevel, AiAttributionLevelRead][] = [
    ["project", project],
    ["host", host],
  ];
  for (const [level, read] of levels) {
    if (read.kind === "absent") continue;
    if (read.kind === "unreadable") return { mode: "suppress", source: "default", failed: { level, why: "unreadable" } };
    const parsed = parseAiAttributionConfig(read.text);
    if (!parsed.present) continue;
    if (!parsed.recognized) return { mode: "suppress", source: "default", failed: { level, why: "unrecognized" } };
    return { mode: parsed.mode, source: level };
  }
  return { mode: "suppress", source: "default" };
}

/** Absent means the file does not exist (ENOENT / ENOTDIR); any other read failure is
 *  `unreadable`, which fails closed rather than falling through. */
export function classifyAiAttributionReadError(err: unknown): AiAttributionLevelRead {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unreadable" };
}
