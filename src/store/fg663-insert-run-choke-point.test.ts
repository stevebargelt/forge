// FG-663 (RF-3, item 2) — AC4 regression guard.
//
// AC4 ("every run records its project identity by construction") holds ONLY
// because insertRun is the SOLE production INSERT INTO runs: capture lives at that
// one choke point, so no creation path can mint a run row without it. That is true
// today and unguarded tomorrow — the next contributor who adds a direct
// `INSERT INTO runs` elsewhere silently reintroduces the exact "Unknown
// repository" defect this ticket removed, and no existing test would catch it
// (they spot-check startRun and one direct caller, which proves today, not the
// invariant). This guard scans the production source and FAILS if a second
// INSERT INTO runs appears anywhere but src/store/runs.ts.
//
// A source-content guard, like fg596-drive-run-emission-guard: it matches CODE
// with comments stripped, so a comment that merely names the statement is fine; an
// executable INSERT is not. Strings are KEPT — the SQL lives inside a template
// literal, which is exactly what must be found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

// This file lives in src/store/; SRC is the production source root (src/).
const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Blank line and block comments, preserving offsets, so a comment naming the
// statement never counts. String/template literals are LEFT INTACT — the SQL we
// hunt for is a template literal.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && c2 === "/") { i += 2; state = "line"; continue; }
      if (c === "/" && c2 === "*") { i += 2; state = "block"; continue; }
      if (c === "'") { out += c; i++; state = "sq"; continue; }
      if (c === '"') { out += c; i++; state = "dq"; continue; }
      if (c === "`") { out += c; i++; state = "tpl"; continue; }
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { out += "\n"; state = "code"; } i++; continue; }
    if (state === "block") { if (c === "*" && c2 === "/") { i += 2; state = "code"; } else { i++; } continue; }
    // inside a string/template: copy verbatim, honoring escapes
    const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === "\\") { out += c + (c2 ?? ""); i += 2; continue; }
    out += c;
    if (c === quote) state = "code";
    i++;
  }
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const INSERT_INTO_RUNS = /insert\s+(?:or\s+\w+\s+)?into\s+runs\b/i;

test("FG-663 AC4: insertRun (src/store/runs.ts) is the ONLY production INSERT INTO runs", () => {
  const offenders = tsFiles(SRC)
    .filter((file) => INSERT_INTO_RUNS.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => relative(SRC, file))
    .sort();

  assert.deepEqual(
    offenders,
    ["store/runs.ts"],
    "a production INSERT INTO runs outside insertRun bypasses FG-663's single capture choke point — route the run through insertRun so it records project_identity by construction (AC4):\n" +
      offenders.join("\n"),
  );
});
