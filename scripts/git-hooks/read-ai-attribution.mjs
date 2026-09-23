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
// Contract: print exactly `allow` or `suppress` on stdout, exit 0. On ANY failure — no
// config, unreadable file, a malformed value, an unexpected error — print `suppress`
// and exit 0. A throw into the hook, or a silent `allow` from a broken config, are the
// two outcomes this must never produce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function main() {
  const projectDir = process.argv[2];
  if (!projectDir) return "suppress";
  let text;
  try {
    text = readFileSync(join(projectDir, ".forge", "config.yml"), "utf8");
  } catch {
    return "suppress"; // absent or unreadable
  }
  return parseAiAttributionConfig(text).mode;
}

// ── inline copy of src/v2/ai-attribution-parse.ts (pinned by ai-attribution.test.ts) ──

function parseAiAttributionConfig(text) {
  const NONE = { mode: "suppress", recognized: false };
  if (text == null) return NONE;

  const keyLines = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) keyLines.push({ indent: (m[1] ?? "").length, key: m[2] ?? "", rest: m[3] ?? "" });
  }
  if (keyLines.length === 0) return NONE;

  const minIndent = Math.min(...keyLines.map((k) => k.indent));
  const top = keyLines.find((k) => k.indent === minIndent && k.key === "ai_attribution");
  if (!top) return NONE;

  const value = scalarValue(top.rest);
  if (value === "allow" || value === "suppress") return { mode: value, recognized: true };
  return NONE;
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

export { parseAiAttributionConfig, scalarValue, stripComment };
