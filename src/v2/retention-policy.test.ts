// FG-590: the pure retention authority — classification, override precedence, and the
// surface disposition. No fs/docker/tmux is reachable from this module, so these run as
// ordinary pure unit tests with an injected env and explicit ages.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FAILURE_RETENTION_MS,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SUCCESS_RETENTION_MS,
  classifyRetention,
  reapEligible,
  resolveRetention,
  retentionDisposition,
  retentionWindowMs,
  type RetentionPolicy,
} from "./retention-policy.js";

test("FG-590 defaults: success is prompt (minutes), failure is a multi-day window", () => {
  assert.equal(DEFAULT_SUCCESS_RETENTION_MS, 15 * 60_000);
  assert.equal(DEFAULT_FAILURE_RETENTION_MS, 7 * 24 * 60 * 60_000);
  assert.ok(DEFAULT_SUCCESS_RETENTION_MS < DEFAULT_FAILURE_RETENTION_MS);
});

test("FG-590 classifyRetention(launch): exited_ok is success; every other terminal state is failure/ambiguous", () => {
  assert.equal(classifyRetention({ kind: "launch", state: "exited_ok" }), "success");
  for (const state of ["exited_error", "signaled", "terminated_unattributed", "owner_gone", "unknown"]) {
    assert.equal(classifyRetention({ kind: "launch", state }), "failure_ambiguous", state);
  }
  // A misused `running` never SHORTENS retention — it reads as the longer window.
  assert.equal(classifyRetention({ kind: "launch", state: "running" }), "failure_ambiguous");
});

test("FG-590 classifyRetention(container): complete is success; failed is failure/ambiguous", () => {
  assert.equal(classifyRetention({ kind: "container", taskStatus: "complete" }), "success");
  assert.equal(classifyRetention({ kind: "container", taskStatus: "failed" }), "failure_ambiguous");
});

test("FG-590 resolveRetention precedence: override > env > default", () => {
  // No overrides, no env → code defaults.
  assert.deepEqual(resolveRetention(undefined, {}), DEFAULT_RETENTION_POLICY);

  // Env overrides the default; an explicit override beats the env.
  const env = { FORGE_RETENTION_SUCCESS_MS: "1000", FORGE_RETENTION_FAILURE_MS: "2000" } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveRetention(undefined, env), { success: 1000, failureAmbiguous: 2000 });
  assert.deepEqual(resolveRetention({ successMs: 5 }, env), { success: 5, failureAmbiguous: 2000 });
  assert.deepEqual(resolveRetention({ successMs: 5, failureAmbiguousMs: 9 }, env), { success: 5, failureAmbiguous: 9 });
});

test("FG-590 resolveRetention: a malformed override or env falls through to a safe default, never a negative/NaN window", () => {
  const env = { FORGE_RETENTION_SUCCESS_MS: "not-a-number", FORGE_RETENTION_FAILURE_MS: "-5" } as NodeJS.ProcessEnv;
  // Bad env → default. A negative env value is ignored too.
  assert.deepEqual(resolveRetention(undefined, env), DEFAULT_RETENTION_POLICY);
  // A malformed override falls to env; a negative override is ignored.
  assert.deepEqual(resolveRetention({ successMs: -1, failureAmbiguousMs: Number.NaN }, {}), DEFAULT_RETENTION_POLICY);
});

test("FG-590 reapEligible: eligible strictly AFTER the window elapses", () => {
  const policy: RetentionPolicy = { success: 100, failureAmbiguous: 1000 };
  assert.equal(reapEligible("success", 100, policy), false); // exactly at the window: not yet
  assert.equal(reapEligible("success", 101, policy), true);
  assert.equal(reapEligible("failure_ambiguous", 1000, policy), false);
  assert.equal(reapEligible("failure_ambiguous", 1001, policy), true);
  assert.equal(retentionWindowMs("failure_ambiguous", policy), 1000);
});

test("FG-590 retentionDisposition: the three surface states from class + age", () => {
  const policy: RetentionPolicy = { success: 100, failureAmbiguous: 1000 };
  // Failure/ambiguous within the window is deliberately retained for investigation.
  assert.equal(retentionDisposition("failure_ambiguous", 500, policy), "within_retention_for_investigation");
  // Past its diagnostic window it is routinely eligible.
  assert.equal(retentionDisposition("failure_ambiguous", 1500, policy), "expired_eligible");
  // A success inside its short window is routine (nothing to investigate).
  assert.equal(retentionDisposition("success", 50, policy), "expired_eligible");
  // A success STILL present past its prompt window has leaked.
  assert.equal(retentionDisposition("success", 500, policy), "leaked");
});
