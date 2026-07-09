// FG-487 AC7: a rendering-level test for VerificationRow's mode-label logic
// (dashboard/client/main.js), which queries-verification.test.ts's
// query-layer coverage does not exercise. Regression coverage for the
// "ci-wait" vs "ci_wait" mismatch: review-loop.ts emits "ci_wait", so the
// label must resolve to "waiting-on-ci" for both spellings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verificationRowLabel } from "../client/verification-label.js";

test("verificationRowLabel: ci_wait (the real emitted value) maps to waiting-on-ci", () => {
  assert.equal(verificationRowLabel({ mode: "ci_wait" }), "waiting-on-ci");
});

test("verificationRowLabel: ci-wait (hyphen) also maps to waiting-on-ci", () => {
  assert.equal(verificationRowLabel({ mode: "ci-wait" }), "waiting-on-ci");
});

test("verificationRowLabel: local mode maps to verifying", () => {
  assert.equal(verificationRowLabel({ mode: "local" }), "verifying");
});

test("verificationRowLabel: campaign_reconcile_gate kind always maps to host gate, regardless of mode", () => {
  assert.equal(verificationRowLabel({ kind: "campaign_reconcile_gate", mode: "ci_wait" }), "host gate");
});
