// FG-799 (follow-up) — THE STANDALONE ai_attribution READER the commit-msg hook runs.
//
// ─── WHY IT EXISTS AS ITS OWN FILE ───────────────────────────────────────────
// The commit-msg hook used to read the toggle with a bash grep, while the TypeScript
// reader (src/v2/ai-attribution.ts) read it with the `yaml` library. Two parsers for
// one value cannot be held in agreement by regex — they disagreed on a root key with
// leading indentation and on a mismatched-quote value — and "every enforcement point
// reads the same mode" broke. This file replaces the grep: the hook shells out to it
// and honors the single word it prints, so there is ONE parse behind the hook and the
// reader instead of two dialects (pattern: docker/forge-backlog-reader.mjs).
//
// ─── NO DEPENDENCIES, BY CONSTRUCTION ────────────────────────────────────────
// It runs under bare `node`, with no tsx loader to transpile a `.ts` import and — when
// it sits inside a Forge-provisioned workspace clone next to the copied hook — with no
// node_modules reachable at all. So it imports nothing beyond node builtins and carries
// the parse inline. The algorithm is a character-for-character copy of
// src/v2/ai-attribution-parse.ts, PINNED BY TEST: ai-attribution.test.ts drives this
// reader and readAiAttribution over the same table AND compares the two copies' parse
// helpers (parseAiAttributionConfig, scalarValue, stripComment) return value by value
// across the edges — so a behaviorally-inert drift (the malformed-quote sentinel once
// differed space-vs-NUL between the copies) still fails the pin, not just a mode diff.
//
// ─── FAIL CLOSED, NEVER THROW ────────────────────────────────────────────────
// FG-845: the host level is read from $FORGE_HOME (default ~/.forge) in the hook's
// own environment. FG-853: an agent container has no host config mounted, so dispatch
// carries the host's resolved mode in FORGE_AI_ATTRIBUTION_CARRIED, consulted after
// the project file and before the (there absent) host file.
//
// Contract: print exactly `allow` or `suppress` on stdout (plus, on a fail-closed stop,
// one stderr note naming the level that stopped it), exit 0. On ANY failure — no
// config, unreadable file, a malformed value, an unexpected error — print `suppress`
// and exit 0. A throw into the hook, or a silent `allow` from a broken config, are the
// two outcomes this must never produce.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// FG-845/FG-853: the mode resolves project file → carried value → host file ($FORGE_HOME/config.yml, the
// same default the TypeScript reader uses) → suppress, through the inline copy of
// resolveAiAttributionLevels below — so a host `allow` reaches the hook exactly as a
// project `allow` does, and a broken project file never lets the host value through.
function hostConfigFile() {
  return join(process.env.FORGE_HOME ?? join(homedir(), ".forge"), "config.yml");
}

function readLevel(path) {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (err) {
    return classifyAiAttributionReadError(err);
  }
}

function resolve(projectDir, hostFile, carried) {
  const files = { project: join(projectDir, ".forge", "config.yml"), host: hostFile };
  const r = resolveAiAttributionLevels(readLevel(files.project), readLevel(files.host), carried);
  return { mode: r.mode, reason: r.failed ? describeAiAttributionFailure(r.failed, files, carried) : undefined };
}

function readMode(projectDir, hostFile, carried) {
  return resolve(projectDir, hostFile, carried).mode;
}

// A fail-closed stop is reported on stderr, naming the level that stopped it; the
// hook passes it through so a refusal says which level suppressed.
function main() {
  const projectDir = process.argv[2];
  if (!projectDir) return "suppress";
  const r = resolve(projectDir, hostConfigFile(), process.env.FORGE_AI_ATTRIBUTION_CARRIED);
  if (r.reason) process.stderr.write(`\x1b[33mnote:\x1b[0m no-ai-attribution hook: ${r.reason}\n`);
  return r.mode;
}

// ── inline copy of src/v2/ai-attribution-parse.ts (pinned by ai-attribution.test.ts) ──

function parseAiAttributionConfig(text) {
  const NONE = { mode: "suppress", recognized: false, present: false };
  if (text == null) return NONE;

  const keyLines = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) keyLines.push({ indent: (m[1] ?? "").length, key: m[2] ?? "", rest: m[3] ?? "" });
  }
  if (keyLines.length === 0) return NONE;

  const minIndent = Math.min(...keyLines.map((k) => k.indent));
  const tops = keyLines.filter((k) => k.indent === minIndent && k.key === "ai_attribution");
  const top = tops[0];
  if (!top) return NONE;
  if (tops.length > 1) return { mode: "suppress", recognized: false, present: true, duplicate: true };

  const value = scalarValue(top.rest);
  if (value === "allow" || value === "suppress") return { mode: value, recognized: true, present: true };
  return { mode: "suppress", recognized: false, present: true };
}

function scalarValue(rest) {
  const s = stripComment(rest).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  if (s[0] === '"' || s[0] === "'") return " malformed-quote";
  return s;
}

function stripComment(s) {
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

function parseCarriedAiAttribution(value) {
  const m = value.match(/^(allow|suppress);source=(project|host|default);file=([^;\n]*)$/);
  if (!m) return null;
  const mode = m[1] === "allow" ? "allow" : "suppress";
  const source = m[2] === "project" ? "project" : m[2] === "host" ? "host" : "default";
  if (source === "default" && mode !== "suppress") return null;
  return { mode, source, file: m[3] ? m[3] : null };
}

function resolveAiAttributionLevels(project, host, carried) {
  const levels = [
    ["project", project],
    ["host", host],
  ];
  for (const [level, read] of levels) {
    if (level === "host" && carried !== undefined) {
      const c = parseCarriedAiAttribution(carried);
      if (!c) return { mode: "suppress", source: "default", failed: { level: "carried", why: "unparseable" } };
      return { mode: c.mode, source: "carried", carried: c };
    }
    if (read.kind === "absent") continue;
    if (read.kind === "unreadable") return { mode: "suppress", source: "default", failed: { level, why: "unreadable" } };
    const parsed = parseAiAttributionConfig(read.text);
    if (!parsed.present) continue;
    if (parsed.duplicate) return { mode: "suppress", source: "default", failed: { level, why: "duplicate" } };
    if (!parsed.recognized) return { mode: "suppress", source: "default", failed: { level, why: "unrecognized" } };
    return { mode: parsed.mode, source: level };
  }
  return { mode: "suppress", source: "default" };
}

function describeAiAttributionFailure(failed, files, carried) {
  const valid = "(valid: suppress, allow); failing closed to suppress";
  if (failed.level === "carried") {
    return `FORGE_AI_ATTRIBUTION_CARRIED=${JSON.stringify(carried)} is not a valid carried value <mode>;source=<project|host|default>;file=<path> ${valid}`;
  }
  const problem =
    failed.why === "unreadable"
      ? "could not be read"
      : failed.why === "duplicate"
        ? "carries more than one top-level ai_attribution key"
        : "carries an unrecognized ai_attribution value";
  return `${files[failed.level]} ${problem} ${valid}`;
}

function classifyAiAttributionReadError(err) {
  const code = err?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unreadable" };
}

// Run the CLI ONLY when invoked directly (the commit-msg hook shells out to this
// file). Guarding it lets the pin test import the parse helpers below without the
// side effect of reading argv / writing stdout / exiting.
function runCli() {
  try {
    process.stdout.write(main() === "allow" ? "allow" : "suppress");
  } catch {
    process.stdout.write("suppress");
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();

export {
  parseAiAttributionConfig,
  scalarValue,
  stripComment,
  parseCarriedAiAttribution,
  resolveAiAttributionLevels,
  describeAiAttributionFailure,
  classifyAiAttributionReadError,
  readMode,
};
