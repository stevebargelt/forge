#!/usr/bin/env -S node --import tsx
//
// L2 docs-drift detector — PROTOTYPE (#240). NOT a gate.
//
// Given a git range, extract the HIGH-SIGNAL primitives that changed (CLI flags,
// `forge <verb>` command phrases, schema/YAML field keys, dotted event names,
// runtime/profile names) and grep the durable-docs corpus for mentions. A doc
// that still mentions a renamed/removed primitive is a drift CANDIDATE — what we
// did by hand 5x in one session.
//
// This is the measure-first prototype the ticket calls for: it reports candidate
// findings; it does NOT decide truth and does NOT enforce. Run it against real
// changes, hand-score precision, THEN decide whether enforcement is worth it.
//
// Usage:
//   node --import tsx scripts/drift-l2.ts [<git-range>]
//   node --import tsx scripts/drift-l2.ts e0c3384         # single commit (X~1..X)
//   node --import tsx scripts/drift-l2.ts HEAD~3..HEAD    # explicit range
//   (default range: HEAD~1..HEAD)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

type PrimType = "flag" | "command" | "field" | "event" | "runtime";
interface Primitive {
  type: PrimType;
  value: string; // canonical token, e.g. "--profile", "forge usage", "activity:"
}
interface Finding {
  primitive: Primitive;
  file: string;
  line: number;
  text: string;
}

// Broad tokens that are never high-signal on their own. The ticket is explicit:
// no giant keyword list — this is a DENY list of known-noisy words, not an
// allow list of surfaces.
const BROAD = new Set([
  "model", "test", "run", "auth", "workflow", "agent", "default", "name",
  "description", "type", "id", "file", "path", "mode", "value", "result",
  "status", "step", "steps", "gate", "image", "command", "args", "env",
]);

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function normalizeRange(arg: string | undefined): string {
  if (!arg) return "HEAD~1..HEAD";
  if (arg.includes("..")) return arg;
  return `${arg}~1..${arg}`; // single ref -> that commit's own diff
}

// ------------------------------------------------------------------
// 1. Extract changed primitives from the diff
// ------------------------------------------------------------------

function extractPrimitives(range: string): { prims: Primitive[]; changedFiles: Set<string> } {
  const diff = git(["diff", "--unified=0", range]);
  const lines = diff.split("\n");
  const seen = new Map<string, Primitive>();
  const changedFiles = new Set<string>();
  const add = (type: PrimType, value: string) => {
    const key = `${type}::${value}`;
    if (!seen.has(key)) seen.set(key, { type, value });
  };

  let currentFile = "";
  for (const raw of lines) {
    if (raw.startsWith("+++ b/") || raw.startsWith("--- a/")) {
      const f = raw.slice(6);
      if (f !== "/dev/null") { currentFile = f; changedFiles.add(f); }
      continue;
    }
    // Only content lines (single +/-, not the +++/--- headers handled above).
    if (!/^[+-]/.test(raw) || raw.startsWith("+++") || raw.startsWith("---")) continue;
    const content = raw.slice(1);

    // CLI flags: --foo, --foo-bar (>=2 chars, not a bare --).
    for (const m of content.matchAll(/(?<![\w-])--([a-z][a-z0-9-]+)/g)) {
      add("flag", `--${m[1]}`);
    }

    // `forge <verb>` and `forge <verb> <subverb>` command phrases.
    for (const m of content.matchAll(/\bforge\s+([a-z][a-z-]+)(?:\s+([a-z][a-z-]+))?/g)) {
      const verb = m[1]!;
      if (BROAD.has(verb)) continue;
      add("command", m[2] ? `forge ${verb} ${m[2]}` : `forge ${verb}`);
    }

    // Dotted event names inside quotes: "orchestrator.milestone", 'model.profile_resolved'.
    for (const m of content.matchAll(/["']([a-z][a-z_]+\.[a-z_][a-z_.]+)["']/g)) {
      const tok = m[1]!;
      if (/\.(js|ts|md|yml|yaml|json|sh|mjs)$/.test(tok)) continue; // file paths
      add("event", tok);
    }

    // Schema/YAML field keys. In .ts schema files: `name: z.<...>`. In .yml: `key:`.
    if (/schema\.ts$/.test(currentFile)) {
      for (const m of content.matchAll(/(?:^|\s)([a-z_][a-z0-9_]+):\s*z\./g)) {
        const k = m[1]!;
        if (!BROAD.has(k)) add("field", `${k}:`);
      }
    } else if (/\.ya?ml$/.test(currentFile)) {
      for (const m of content.matchAll(/^\s*([a-z_][a-z0-9_]+):/gm)) {
        const k = m[1]!;
        if (!BROAD.has(k)) add("field", `${k}:`);
      }
    }

    // Runtime / profile names from changed runtime YAML basenames.
    const rt = currentFile.match(/seeds\/runtimes\/([a-z0-9-]+)\.ya?ml$/);
    if (rt) add("runtime", rt[1]!);
  }

  return { prims: [...seen.values()], changedFiles };
}

// ------------------------------------------------------------------
// 2. Build the durable-docs corpus (tracked, prose-bearing, non-code)
// ------------------------------------------------------------------

function corpusFiles(changedFiles: Set<string>): string[] {
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  return tracked.filter((f) => {
    if (changedFiles.has(f)) return false;            // don't flag the code we just changed
    if (f === "BACKLOG.md") return false;             // session state, not durable docs
    if (f.startsWith("docs/")) return true;
    if (f.startsWith("learnings/")) return true;
    if (f === "README.md" || f === "CLAUDE.md") return true;
    if (f.startsWith("seeds/") && f.endsWith(".md")) return true; // seed prose (CLAUDE.md, templates)
    if (f === "seeds/orchestrator-template.md" || f === "seeds/forge-raci.md") return true;
    return false;
  });
}

// ------------------------------------------------------------------
// 3. Grep the corpus for each changed primitive
// ------------------------------------------------------------------

function mentionRegex(p: Primitive): RegExp {
  const esc = p.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p.type === "flag") return new RegExp(`${esc}(?![a-z0-9-])`);     // --profile not --profile-dir
  if (p.type === "field") return new RegExp(esc);                       // includes the colon already
  if (p.type === "runtime") return new RegExp(`\\b${esc}\\b`);
  return new RegExp(esc); // command / event: literal phrase
}

function scan(range: string): { prims: Primitive[]; findings: Finding[]; corpusCount: number } {
  const { prims, changedFiles } = extractPrimitives(range);
  const corpus = corpusFiles(changedFiles);
  const findings: Finding[] = [];
  for (const file of corpus) {
    let body: string;
    try { body = readFileSync(file, "utf8"); } catch { continue; }
    const fileLines = body.split("\n");
    for (const p of prims) {
      const re = mentionRegex(p);
      for (let i = 0; i < fileLines.length; i++) {
        if (re.test(fileLines[i]!)) {
          findings.push({ primitive: p, file, line: i + 1, text: fileLines[i]!.trim() });
        }
      }
    }
  }
  return { prims, findings, corpusCount: corpus.length };
}

// ------------------------------------------------------------------
// Report
// ------------------------------------------------------------------

const range = normalizeRange(process.argv[2]);
const { prims, findings, corpusCount } = scan(range);

console.log(`\nL2 drift prototype — range ${range}`);
console.log(`corpus: ${corpusCount} durable-doc files\n`);

console.log(`changed primitives (${prims.length}):`);
const byType = new Map<PrimType, string[]>();
for (const p of prims) {
  if (!byType.has(p.type)) byType.set(p.type, []);
  byType.get(p.type)!.push(p.value);
}
for (const [type, vals] of byType) console.log(`  ${type.padEnd(8)} ${vals.join(", ")}`);

console.log(`\ncandidate findings (${findings.length}) — mentions of a changed primitive in durable docs:`);
const byPrim = new Map<string, Finding[]>();
for (const f of findings) {
  const k = f.primitive.value;
  if (!byPrim.has(k)) byPrim.set(k, []);
  byPrim.get(k)!.push(f);
}
const sorted = [...byPrim.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [prim, fs] of sorted) {
  console.log(`\n  ${prim}  (${fs.length})`);
  for (const f of fs) console.log(`    ${f.file}:${f.line}  ${f.text.slice(0, 100)}`);
}
console.log(`\n[prototype — findings are CANDIDATES, not verdicts; not wired as a gate]`);
