// Post-validation for red-agent findings (#147).
//
// Mechanically check that any finding citing {file, line, quoted_text} actually
// has that text at that location in the project source. Findings whose quoted
// text doesn't appear get dropped. A `fail` verdict whose findings are 100%
// dropped downgrades to `inconclusive` — the red built its case on hallucinated
// evidence and can't be trusted to block.
//
// Findings without all three anchor fields pass through un-anchored. Intended
// for prose-y artifacts (architect outputs, plans) where source-anchoring
// isn't always applicable.
//
// Pure: no DB writes, no side effects beyond readFileSync of the cited file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Verdict } from "../types/index.js";

// ±3 lines around the cited line. Agents sometimes cite a line that's off by
// a few because of whitespace / formatter drift between the time they read
// the file and the time we re-read it. ±3 catches the common cases without
// being so wide it loses the anchor's value.
const LINE_WINDOW = 3;

export type FindingValidation = { ok: true } | { ok: false; reason: string };

export function validateFinding(f: Finding, projectDir: string): FindingValidation {
  // Un-anchored findings (or partial anchors) pass through.
  if (!f.file || typeof f.line !== "number" || !f.quoted_text) {
    return { ok: true };
  }
  const path = join(projectDir, f.file);
  if (!existsSync(path)) {
    return { ok: false, reason: `file does not exist: ${f.file}` };
  }
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch (e) {
    return { ok: false, reason: `read failed: ${(e as Error).message}` };
  }
  if (f.line < 1 || f.line > lines.length + 1) {
    return { ok: false, reason: `line ${f.line} > file has ${lines.length} lines` };
  }
  const start = Math.max(0, f.line - 1 - LINE_WINDOW);
  const end = Math.min(lines.length, f.line - 1 + LINE_WINDOW + 1);
  const window = lines.slice(start, end).join("\n");
  // Compare with whitespace-normalized contains. The agent's quoted_text often
  // varies on leading indentation; we don't want to reject for indent drift.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!norm(window).includes(norm(f.quoted_text))) {
    return { ok: false, reason: `quoted_text not found at ${f.file}:${f.line} ±${LINE_WINDOW}` };
  }
  return { ok: true };
}

export type ValidationOutcome = {
  validated: Verdict;
  dropped: Array<{ finding: Finding; reason: string }>;
};

export function validateVerdict(v: Verdict, projectDir: string): ValidationOutcome {
  const survivors: Finding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  for (const f of v.findings ?? []) {
    const res = validateFinding(f, projectDir);
    if (res.ok) survivors.push(f);
    else dropped.push({ finding: f, reason: res.reason });
  }
  // If we dropped EVERYTHING from a fail verdict, the red's case was entirely
  // un-validatable. Downgrade so it doesn't block on hallucinated evidence.
  if (
    v.verdict === "fail" &&
    dropped.length > 0 &&
    survivors.length === 0
  ) {
    return {
      validated: {
        verdict: "inconclusive",
        confidence: v.confidence,
        findings: [],
        notes: `all ${dropped.length} finding(s) dropped post-validation (citations did not verify against project source); verdict downgraded from fail to inconclusive`,
      },
      dropped,
    };
  }
  return {
    validated: { ...v, findings: survivors },
    dropped,
  };
}
