// #302 regression guard: the orchestrator must adopt `forge review-loop` (#301)
// for post-implementation review instead of hand-relaying reviewer→fixer cycles.
// Guards BOTH the SOURCE template and the rendered live CLAUDE.md — if either
// drops the rule, or lets a manual reviewer/fixer relay be the default, this fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Both the source of truth and the live block this repo's orchestrator reads.
const SURFACES: Array<{ name: string; text: string }> = [
  { name: "seeds/orchestrator-template.md", text: readFileSync(join(root, "seeds", "orchestrator-template.md"), "utf8") },
  { name: "CLAUDE.md (rendered live block)", text: readFileSync(join(root, "CLAUDE.md"), "utf8") },
];

for (const surface of SURFACES) {
  test(`#302: ${surface.name} adopts forge review-loop for post-implementation review`, () => {
    const t = surface.text;
    assert.match(t, /forge review-loop/, "must reference the review-loop command");
    assert.match(t, /post-implementation only/i, "must mark review-loop as post-implementation only (not initial impl)");
    // The manual reviewer/fixer relay must be demoted to a fallback, never the default.
    assert.match(t, /Don't manually relay/i, "must forbid hand-relaying reviewer/fixer when review-loop is available");
    assert.match(t, /fallback/i, "the manual relay must be named as the fallback");
    // Close only on closeable; stop-and-ask on the bounded stop conditions.
    assert.match(t, /closeable/, "must gate ticket close on review-loop reporting closeable");
    assert.match(t, /blocked_by_reviewer|max rounds|live spend|migration|destructive/i, "must list the stop-and-ask conditions");
  });
}

test("#302: the manual red-wide→engineer relay is not presented as the default review path", () => {
  // The template still SHOWS the manual chain (as the fallback), but it must be
  // explicitly demoted. Assert the demotion phrase co-occurs with the relay.
  const t = SURFACES[0]!.text;
  assert.match(t, /manual `red-wide` (?:→|->) `engineer` chain is the \*\*fallback\*\*/i,
    "the manual relay must be explicitly labeled the fallback, not the default");
});
