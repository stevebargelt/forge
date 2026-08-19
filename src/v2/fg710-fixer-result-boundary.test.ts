// FG-710 Shape A — the fixer result.json schema boundary.
//
// The producer template used to print conditional optional fields unconditionally, so a copied
// example emitted empty strings on optional min(1) fields and the whole result — with its
// completed remediation — was discarded. These tests pin the two remedies AC1-AC3 require:
//   - an empty optional conditional string NORMALIZES to absence rather than refusing (AC2);
//   - a required field that is empty still refuses loudly;
//   - an unknown nested key still refuses, naming EVERY offending key (AC3), never weakening
//     `.strict()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixerResult } from "./review-fixer.js";
import { executedAssertionIdentityValid } from "./review-evidence.js";

function base(findings: Array<Record<string, unknown>>) {
  return { fix_batch_id: "fb-1", revision: 1, findings };
}

const FIXED = {
  finding_id: "review-1/RF-1",
  result: "fixed",
  remediation_summary: "guarded the write path",
  files_changed: ["src/x.ts"],
  evidence: "added the named regression test",
  executed_assertion: "the reconcile path guards a partial write",
};

test("FG-710 AC2: an empty scope_change_reason on a `fixed` result normalizes to absence and parses", () => {
  const r = parseFixerResult(base([{ ...FIXED, scope_change_reason: "" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.results[0]?.result, "fixed");
  assert.equal(r.scopeChanges.length, 0);
});

test("FG-710 AC2: empty interaction / evidence_path / evidence_sha256 all normalize to absence", () => {
  const r = parseFixerResult(base([{ ...FIXED, interaction: "", evidence_path: "", evidence_sha256: "" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.results[0]?.interaction, undefined);
  assert.equal(r.results[0]?.evidencePath, undefined);
  assert.equal(r.results[0]?.evidenceSha256, undefined);
});

test("RF-6: executed_assertion is NOT one of the four normalized fields — an empty one refuses loudly, never absence", () => {
  // The review contract scopes empty-string normalization to EXACTLY four optional conditional
  // fields (interaction, scope_change_reason, evidence_path, evidence_sha256). executed_assertion
  // is not among them: an empty one is a min(1) refusal, not silently converted to absence.
  const r = parseFixerResult(base([{ ...FIXED, executed_assertion: "" }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /findings\.0\.executed_assertion/);
});

test("FG-710: a REQUIRED empty field is never normalized — an empty evidence still refuses loudly", () => {
  const r = parseFixerResult(base([{ ...FIXED, evidence: "" }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /findings\.0\.evidence/);
});

test("FG-710 AC3 / FG-524: an unknown nested key `evidence_detail` refuses, naming the key, without weakening strict", () => {
  const r = parseFixerResult(base([{ ...FIXED, evidence_detail: "extra" }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /unrecognized key/i);
  assert.match(r.refusal, /"evidence_detail"/);
});

test("FG-710 AC3 / FG-730: implementer keys refuse and EVERY offending key is enumerated", () => {
  const r = parseFixerResult(base([{ ...FIXED, no_validation_reason: "n/a", docs_impact: "none" }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /"no_validation_reason"/);
  assert.match(r.refusal, /"docs_impact"/, "both offending keys are named, not just the first");
});

test("FG-710: a scope_change result with an OMITTED reason refuses with its semantic message", () => {
  const r = parseFixerResult(base([{ finding_id: "review-1/RF-1", result: "scope_change", remediation_summary: "s", evidence: "e" }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /must say what scope would have to move/);
});

test("FG-710: a scope_change result with an EMPTY reason normalizes then refuses with the SAME semantic message, not a min(1) error", () => {
  const r = parseFixerResult(
    base([{ finding_id: "review-1/RF-1", result: "scope_change", remediation_summary: "s", evidence: "e", scope_change_reason: "" }]),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /must say what scope would have to move/);
});

test("FG-710: a valid scope_change carries its reason into the evidence, and a valid fixed threads executed_assertion", () => {
  const r = parseFixerResult(
    base([
      { ...FIXED },
      { finding_id: "review-1/RF-2", result: "scope_change", remediation_summary: "s", evidence: "e", scope_change_reason: "needs a schema change" },
    ]),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.results[0]?.executedAssertion, "the reconcile path guards a partial write");
  assert.deepEqual(r.scopeChanges, ["review-1/RF-2"]);
  assert.match(r.results[1]?.evidence ?? "", /scope change: needs a schema change/);
});

test("FG-710: executedAssertionIdentityValid accepts a named assertion and rejects absent/blank/malformed", () => {
  assert.equal(executedAssertionIdentityValid("the guard test"), true);
  assert.equal(executedAssertionIdentityValid("alpha; beta"), true);
  assert.equal(executedAssertionIdentityValid(undefined), false);
  assert.equal(executedAssertionIdentityValid("   "), false);
  assert.equal(executedAssertionIdentityValid("alpha; ; beta"), false, "a blank member makes the whole identity invalid");
});
