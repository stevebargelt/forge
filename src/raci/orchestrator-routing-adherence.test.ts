// #287 regression guard: the orchestrator template must REQUIRE resolving the
// route from the compiled policy (`forge route explain`) before any dispatch, and
// must forbid dispatching a role from memory. This locks the guidance against
// silent regression — if a future edit drops the routing-before-dispatch rule
// from the dispatch path, this test fails.
//
// Regression case (named per #287 acceptance): in the Pixtron dogfood the
// orchestrator jumped straight to `forge invoke engineer` from memory, skipping
// Step 2 — so project routing overrides / routing-policy changes would not affect
// the actual work even though `route explain` and the dashboard were correct.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "..", "seeds", "orchestrator-template.md");
const tpl = readFileSync(TEMPLATE, "utf8");

/** The "### Step 4 — Execute the route" section (where dispatch actually happens),
 *  bounded by the next "### Step 5" heading. */
function dispatchSection(): string {
  const start = tpl.indexOf("### Step 4 — Execute the route");
  assert.ok(start >= 0, "template must have a 'Step 4 — Execute the route' dispatch section");
  const end = tpl.indexOf("### Step 5", start);
  return tpl.slice(start, end >= 0 ? end : undefined);
}

test("#287: the dispatch section gates every invoke/new on a just-resolved route", () => {
  const s = dispatchSection();
  assert.match(s, /hard precondition/i, "dispatch must open with a hard precondition");
  assert.match(s, /forge route explain/, "must name the compiled-policy resolver");
  assert.match(s, /before any .{0,40}forge invoke/i, "must require resolution BEFORE dispatch");
  assert.match(s, /from memory/i, "must call out routing-from-memory as the failure mode");
  assert.match(s, /defect/i, "memory dispatch must be marked a defect, not a shortcut");
});

test("#287: the route-resolution rule precedes the dispatch commands in Step 4", () => {
  const s = dispatchSection();
  const precondition = s.search(/hard precondition/i);
  const firstDispatch = s.indexOf("forge invoke <agent-role>");
  assert.ok(firstDispatch >= 0, "Step 4 should show the forge invoke dispatch command");
  assert.ok(
    precondition >= 0 && precondition < firstDispatch,
    "the route-resolution precondition must come BEFORE the first dispatch command",
  );
});

test("#287: 'present the plan' requires showing the resolved-route basis before spawning", () => {
  const start = tpl.indexOf("### Step 3 — Present the plan");
  const end = tpl.indexOf("### Step 4", start);
  const step3 = tpl.slice(start, end >= 0 ? end : undefined);
  assert.match(step3, /resolved route/i, "Step 3 must require presenting the resolved route");
  // the route basis fields the orchestrator must surface
  assert.match(step3, /route key/i);
  assert.match(step3, /responsible/i);
  assert.match(step3, /source/i);
});

test("#287: 'What NOT to do' forbids dispatching from memory", () => {
  assert.match(tpl, /Don't dispatch from memory/i);
});

test("#287: the Pixtron direct-memory-dispatch regression is named in the guidance", () => {
  assert.match(tpl, /Pixtron/, "the regression case must be named so the rule's origin is traceable");
  assert.match(tpl, /#287/, "the rule must cite its ticket");
});
