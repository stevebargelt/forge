// FG-474 regression guard: CI (`.github/workflows/ci.yml`) is now the required
// merge-gate check, and the orchestrator must STOP re-running `npm run test:all`
// on the host before merge — that host re-run was the invisible, redundant third
// run this ticket removed. Guards BOTH the SOURCE template and the rendered live
// CLAUDE.md — if either regresses to telling the orchestrator to re-run the full
// suite on the host itself, this fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SURFACES: Array<{ name: string; text: string }> = [
  { name: "seeds/orchestrator-template.md", text: readFileSync(join(root, "seeds", "orchestrator-template.md"), "utf8") },
  { name: "CLAUDE.md (rendered live block)", text: readFileSync(join(root, "CLAUDE.md"), "utf8") },
];

for (const surface of SURFACES) {
  test(`FG-474: ${surface.name} points "required CI check" at the actual workflow`, () => {
    const t = surface.text;
    assert.match(t, /\.github\/workflows\/ci\.yml/, "must name the actual workflow file, not just the generic phrase 'CI check'");
    assert.match(t, /CI \/ test/, "must name the actual check context (job name) the merge gate reads");
  });

  test(`FG-474: ${surface.name} forbids re-running npm run test:all on the host before merge`, () => {
    const t = surface.text;
    assert.match(
      t,
      /do not re-run|do not\s+re-run|does? not re-run|instead of re-running|not re-run `npm run test:all`|not re-run.{0,20}npm run test:all/i,
      "must explicitly forbid re-running npm run test:all on the host as the merge/run-complete step"
    );
  });

  test(`FG-474: ${surface.name} run-complete step gates on the CI check, not a host test:all run`, () => {
    const start = t_indexOf(surface.text, "Run complete");
    assert.ok(start >= 0, "must have a 'Run complete' step in the pipeline-run guidance");
    const section = surface.text.slice(start, start + 800);
    assert.match(section, /CI check/i, "the run-complete step must confirm the CI check rather than run tests itself");
    assert.match(section, /gh pr checks|gh run list/, "must name a concrete command to read the CI result");
  });
}

function t_indexOf(text: string, needle: string): number {
  return text.indexOf(needle);
}

test("FG-474/FG-495: merge authorization requires BOTH required CI checks green as a blocking condition", () => {
  const t = SURFACES[1]!.text; // CLAUDE.md — the live authorization language
  const authIdx = t.indexOf("Merge authorization");
  assert.ok(authIdx >= 0, "must have a 'Merge authorization' section");
  const blockedIdx = t.indexOf("Auto-merge is BLOCKED", authIdx);
  assert.ok(blockedIdx >= 0, "must have an 'Auto-merge is BLOCKED' clause after merge authorization");
  const authSection = t.slice(authIdx, blockedIdx);
  const blockedSection = t.slice(blockedIdx, blockedIdx + 600);

  assert.match(
    blockedSection,
    /any required CI check .*is not green/i,
    "any required CI check not being green must be listed as a blocking condition for auto-merge"
  );

  assert.match(
    authSection,
    /`test-extended`/,
    "the authorization text must name the test-extended check, not just `test` (FG-495 dual required checks)"
  );
  assert.match(
    authSection,
    /a red `test-extended` blocks merge exactly like a red `test`/,
    "must state that a red test-extended blocks merge exactly like a red test — otherwise test-extended reads as advisory, not a required gate"
  );
});

test("FG-474: the review-loop's own host verification is distinguished from the CI merge gate", () => {
  // Regression target: a future edit could conflate "the loop verifies on the
  // host" with "so the orchestrator doesn't need CI" — the two must stay
  // explicitly separate so neither silently absorbs the other's job.
  const t = SURFACES[1]!.text;
  assert.match(
    t,
    /CI vs review-loop verification/i,
    "must carry an explicit section distinguishing the loop's host verification from CI's merge-gate role"
  );
});
