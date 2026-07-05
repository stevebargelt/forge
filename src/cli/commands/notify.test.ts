import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleNotifications } from "./notify.js";

// FG-464: `forge notify test` previews every message shape so an operator can see
// the operator-action formatting with no provider configured and no real run. The
// pure preview generator is asserted here (the CLI action just prints these lines).
test("FG-464 forge notify test: sampleNotifications previews every message shape", () => {
  const lines = sampleNotifications();
  const joined = lines.join("\n");

  // run-transition shapes
  assert.match(joined, /\[complete\][^\n]*· no action/, "clean finish → no action");
  assert.match(joined, /inspect failure: result_malformed → forge show/, "failure with kind + forge show");
  assert.match(joined, /\[failed\][^\n]*inspect failure: oom_killed/, "failed state names the kind");
  assert.match(joined, /review red → forge show/, "red block → forge show the blocked task");
  assert.match(joined, /gate: forge gate/, "gate → forge gate");
  assert.match(joined, /FG-462 campaign camp-3a1b/, "campaign/ticket context");

  // milestone markers
  assert.match(joined, /▶ ACTION: your decision needed/, "actionable milestone marker");
  assert.match(joined, /✓ FYI: shipped/, "FYI milestone marker");

  // every rendered SMS-shaped preview line fits one 160-char segment
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("forge:")) assert.ok(t.length <= 160, `preview line over 160 chars: ${t}`);
  }
});
