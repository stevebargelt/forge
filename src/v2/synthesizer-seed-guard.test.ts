// FG-343: Regression guard for synthesizer hardening.
//
// The synthesizer must not silently re-research the codebase when branch
// inputs are absent. Guard the two seed files so a future edit cannot
// quietly reintroduce that bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const synthDir = join(repoRoot, "seeds", "agents", "synthesizer");

// ---------------------------------------------------------------------------
// 1. settings.json: no codebase-investigation tools
// ---------------------------------------------------------------------------

test("synthesizer settings.json: tools does not grant read/grep/bash", () => {
  const raw = readFileSync(join(synthDir, "settings.json"), "utf8");
  const settings = JSON.parse(raw) as { tools?: string[] };
  const tools: string[] = settings.tools ?? [];

  const forbidden = ["read", "grep", "bash"];
  for (const tool of forbidden) {
    assert.ok(
      !tools.includes(tool),
      `synthesizer settings.json tools must not include '${tool}' — grants codebase-investigation capability (FG-343)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. CLAUDE.md: no re-research instruction
// ---------------------------------------------------------------------------

test("synthesizer CLAUDE.md: does not contain re-research-on-empty-inputs instruction", () => {
  const md = readFileSync(join(synthDir, "CLAUDE.md"), "utf8").toLowerCase();

  // Patterns that would indicate the old "explore /project if inputs empty" bug.
  // Note: "investigate the codebase" legitimately appears in the current prohibition
  // ("Do NOT ... investigate the codebase"), so we do NOT flag bare mentions of
  // investigative verbs — only phrases that affirmatively direct investigation when inputs
  // are absent (the original removed instruction).
  const reresearchPhrases = [
    "explore /project",
    "if inputs empty",
    "if inputs are empty",
    "inputs are sparse",
    "when inputs are empty",
    "explore the codebase if",
    "reading the project",
  ];

  for (const phrase of reresearchPhrases) {
    assert.ok(
      !md.includes(phrase),
      `synthesizer CLAUDE.md must not contain re-research instruction '${phrase}' (FG-343)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. CLAUDE.md: absent-input contract is present
// ---------------------------------------------------------------------------

test("synthesizer CLAUDE.md: contains absent-input -> inconclusive verdict contract", () => {
  const md = readFileSync(join(synthDir, "CLAUDE.md"), "utf8");

  // Must mention inconclusive verdict for absent inputs
  assert.ok(
    md.includes("inconclusive"),
    "synthesizer CLAUDE.md must direct the agent to return 'inconclusive' when branch inputs are absent (FG-343)",
  );

  // Must mention that absent/missing inputs should be surfaced, not papered over
  const lower = md.toLowerCase();
  const surfacesPhrases = ["missing", "absent", "required branch input"];
  const hasAnySurfacePhrase = surfacesPhrases.some((p) => lower.includes(p));
  assert.ok(
    hasAnySurfacePhrase,
    `synthesizer CLAUDE.md must name the absent-input condition explicitly — expected one of: ${surfacesPhrases.join(", ")} (FG-343)`,
  );

  // Must prohibit substituting outside knowledge or self-investigation
  const prohibitsSubstitution =
    lower.includes("do not read") ||
    lower.includes("do not use") ||
    lower.includes("do not investigate") ||
    lower.includes("do not substitute");
  assert.ok(
    prohibitsSubstitution,
    "synthesizer CLAUDE.md must explicitly prohibit substituting outside knowledge or investigation when inputs are absent (FG-343)",
  );
});
