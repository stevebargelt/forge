// FG-523 (F19): unit coverage for the single evaluator that decides whether a
// primary result satisfies the validation contract. The behavior through the
// real ingestion path is in fg523-validation-contract.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateValidationContract } from "./validation-contract.js";

const IMPLEMENTERS = [
  "engineer",
  "frontend-specialist",
  "backend-specialist",
  "security-advisor",
  "agentic-platform-builder",
];

test("held: every implementer role, status complete, no tests_run, no waiver", () => {
  for (const role of IMPLEMENTERS) {
    const out = evaluateValidationContract({ role, result: { status: "complete" } });
    assert.equal(out.held, true, `${role} must be held`);
    assert.match((out as { reason: string }).reason, new RegExp(`^validation contract: ${role} returned status=complete`));
  }
});

test("held: tests_run present but zero, or not a number", () => {
  for (const testsRun of [0, -1, "12", null, NaN]) {
    const out = evaluateValidationContract({ role: "engineer", result: { status: "complete", tests_run: testsRun } });
    assert.equal(out.held, true, `tests_run=${String(testsRun)} must not satisfy the contract`);
  }
});

test("not held: tests_run > 0", () => {
  assert.deepEqual(
    evaluateValidationContract({ role: "engineer", result: { status: "complete", tests_run: 1 } }),
    { held: false },
  );
});

test("not held: a non-empty no_validation_reason waives, and the reason comes back trimmed", () => {
  const out = evaluateValidationContract({
    role: "engineer",
    result: { status: "complete", no_validation_reason: "  no runtime surface to drive  " },
  });
  assert.deepEqual(out, { held: false, waiver: "no runtime surface to drive" });
});

test("not held: an empty or non-string waiver does not waive", () => {
  for (const waiver of ["", "   ", 1, true, null]) {
    const out = evaluateValidationContract({
      role: "engineer",
      result: { status: "complete", no_validation_reason: waiver },
    });
    assert.equal(out.held, true, `waiver=${JSON.stringify(waiver)} must not waive the contract`);
  }
});

test("not held: roles outside the implementer set are never subject to the contract", () => {
  for (const role of ["red-security", "test-engineer", "documentation-maintainer", "research-specialist", "manual-qa", "architect", "tech-lead", "prompt-author"]) {
    assert.deepEqual(evaluateValidationContract({ role, result: { status: "complete" } }), { held: false });
  }
});

test("not held: only a status:complete result is subject — failed/partial/other pass through", () => {
  for (const status of ["failed", "partial", undefined]) {
    assert.deepEqual(
      evaluateValidationContract({ role: "engineer", result: { status, error: "x" } }),
      { held: false },
    );
  }
});

test("not held: a null / non-object / array result is an infra failure, not a validation hold", () => {
  for (const result of [null, undefined, "complete", 42, ["complete"]]) {
    assert.deepEqual(evaluateValidationContract({ role: "engineer", result }), { held: false });
  }
});
