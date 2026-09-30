// FG-835: the pure resolution-diff computation behind `forge model policy propose|apply`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRow, isUndispatchable, rowIsChange, type RowState } from "./model-policy-gate.js";

const OK: RowState = {
  profile: "claude-subscription",
  provider: "anthropic",
  model: "claude-sonnet-5",
  auth: "subscription",
  runtime: "claude-oauth",
  costTier: "standard",
  outcome: "resolved",
  dispatchable: true,
  error: null,
};

test("diffRow: identical states produce no changed fields and are not a change", () => {
  const row = diffRow("engineer", "default", true, OK, { ...OK });
  assert.deepEqual(row.changed, []);
  assert.equal(row.becomesUnmapped, false);
  assert.equal(row.becomesUndispatchable, false);
  assert.equal(rowIsChange(row), false);
});

test("diffRow: names each of profile/provider/model/auth/runtime/costTier that moved, before → after", () => {
  const after: RowState = { ...OK, profile: "claude-api", model: "claude-opus-5-5", auth: "api", runtime: "claude-apikey", costTier: "premium" };
  const row = diffRow("engineer", "reasoning", false, OK, after);
  assert.deepEqual(row.changed, [
    { field: "profile", before: "claude-subscription", after: "claude-api" },
    { field: "model", before: "claude-sonnet-5", after: "claude-opus-5-5" },
    { field: "auth", before: "subscription", after: "api" },
    { field: "runtime", before: "claude-oauth", after: "claude-apikey" },
    { field: "costTier", before: "standard", after: "premium" },
  ]);
  assert.equal(rowIsChange(row), true);
});

test("diffRow: a row that becomes activity_unmapped is flagged unmapped AND undispatchable", () => {
  const row = diffRow("red-security", "fast", false, OK, { ...OK, outcome: "activity_unmapped", dispatchable: false });
  assert.equal(row.becomesUnmapped, true);
  assert.equal(row.becomesUndispatchable, true);
  assert.equal(rowIsChange(row), true, "an outcome flip is a change even with no field movement");
});

test("diffRow: a resolution error on the candidate side becomes undispatchable; an already-broken row does not 'become' it", () => {
  const broken: RowState = { ...OK, profile: null, provider: null, model: null, auth: null, runtime: null, costTier: null, outcome: null, dispatchable: null, error: "no mapping" };
  assert.equal(isUndispatchable(broken), true);
  assert.equal(diffRow("engineer", "default", true, OK, broken).becomesUndispatchable, true);
  assert.equal(diffRow("engineer", "default", true, broken, broken).becomesUndispatchable, false);
  assert.equal(diffRow("engineer", "default", true, broken, OK).becomesUndispatchable, false);
});

test("isUndispatchable: legacy rows (dispatchable null, no error) are not undispatchable", () => {
  const legacy: RowState = { ...OK, profile: null, provider: null, auth: null, costTier: null, outcome: null, dispatchable: null };
  assert.equal(isUndispatchable(legacy), false);
  assert.equal(isUndispatchable({ ...OK, dispatchable: false }), true);
});
