import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeFindings, summarizeFindings, gatherRunReviews, findingKey } from "./review-quality.js";
import type { Finding } from "../types/index.js";

function f(o: Partial<Finding>): Finding {
  return { severity: o.severity ?? "high", summary: o.summary ?? "an issue", evidence: o.evidence ?? "", hypothesis: o.hypothesis ?? "", ...o };
}

// ── gradeFindings: reject malformed, downgrade low-evidence ──

test("gradeFindings: rejects a finding with no summary (malformed)", () => {
  const r = gradeFindings([f({ summary: "" }), f({ summary: "   " })]);
  assert.equal(r.graded.length, 0);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0]!.reason, /malformed/);
});

test("gradeFindings: downgrades a high-severity finding with no evidence, no anchor, weak confidence", () => {
  const r = gradeFindings([f({ severity: "high", evidence: "", confidence: 0.3 })]);
  assert.equal(r.graded[0]!.downgraded, true);
  assert.equal(r.graded[0]!.finding.severity, "medium", "high → medium");
  assert.match(r.graded[0]!.note ?? "", /no evidence/);
});

test("gradeFindings: does NOT downgrade when evidence is present", () => {
  const r = gradeFindings([f({ severity: "high", evidence: "src/x.ts does Y unsafely", confidence: 0.2 })]);
  assert.equal(r.graded[0]!.downgraded, false);
  assert.equal(r.graded[0]!.finding.severity, "high");
});

test("gradeFindings: does NOT downgrade when a source anchor is present", () => {
  const r = gradeFindings([f({ severity: "high", evidence: "", file: "src/x.ts", line: 10, confidence: 0.1 })]);
  assert.equal(r.graded[0]!.downgraded, false);
});

test("gradeFindings: does NOT downgrade when confidence is strong", () => {
  const r = gradeFindings([f({ severity: "high", evidence: "", confidence: 0.9 })]);
  assert.equal(r.graded[0]!.downgraded, false);
});

test("gradeFindings: a low-severity unsupported finding stays low (nothing to downgrade to)", () => {
  const r = gradeFindings([f({ severity: "low", evidence: "", confidence: 0.2 })]);
  assert.equal(r.graded[0]!.downgraded, false);
  assert.equal(r.graded[0]!.finding.severity, "low");
});

// ── findingKey / summarizeFindings: convergent vs unique ──

test("findingKey: anchored findings key by file:line; unanchored by normalized summary", () => {
  assert.equal(findingKey(f({ file: "src/a.ts", line: 5 })), "src/a.ts:5");
  assert.equal(findingKey(f({ summary: "The Cancel Race!! is unhandled" })), "sum:the cancel race is unhandled");
});

test("summarizeFindings: same file:line from two reds → convergent; single red → unique", () => {
  const reviews = [
    { redRole: "red-wide", findings: [f({ file: "src/a.ts", line: 5, severity: "high", summary: "race in cancel" })] },
    { redRole: "red-backend", findings: [f({ file: "src/a.ts", line: 5, severity: "medium", summary: "cancel race" })] },
    { redRole: "red-security", findings: [f({ file: "src/b.ts", line: 9, severity: "low", summary: "only I saw this" })] },
  ];
  const { convergent, unique } = summarizeFindings(reviews);
  assert.equal(convergent.length, 1);
  assert.deepEqual(convergent[0]!.reviewers.sort(), ["red-backend", "red-wide"]);
  assert.equal(convergent[0]!.maxSeverity, "high", "cluster takes the max severity across reds");
  assert.equal(unique.length, 1);
  assert.equal(unique[0]!.reviewers[0], "red-security");
});

test("summarizeFindings: paraphrased unanchored findings cluster by normalized summary", () => {
  const reviews = [
    { redRole: "red-wide", findings: [f({ summary: "Missing auth check on the admin route" })] },
    { redRole: "red-narrow", findings: [f({ summary: "missing auth check on the admin route!!" })] },
  ];
  assert.equal(summarizeFindings(reviews).convergent.length, 1, "paraphrases of the same issue converge");
});

test("summarizeFindings: same red twice does NOT make a finding convergent", () => {
  const reviews = [
    { redRole: "red-wide", findings: [f({ file: "src/a.ts", line: 5 }), f({ file: "src/a.ts", line: 5 })] },
  ];
  assert.equal(summarizeFindings(reviews).convergent.length, 0, "needs ≥2 DISTINCT reviewers");
  assert.equal(summarizeFindings(reviews).unique.length, 1);
});

// ── gatherRunReviews ──

test("gatherRunReviews: collects per-verdict findings, skips empty", () => {
  const verdicts: Record<string, Array<{ redRole: string; findings: Finding[] }>> = {
    "task-1": [{ redRole: "red-wide", findings: [f({ summary: "x" })] }, { redRole: "red-backend", findings: [] }],
    "task-2": [{ redRole: "red-security", findings: [f({ summary: "y" })] }],
  };
  const reviews = gatherRunReviews(["task-1", "task-2"], (id) => verdicts[id] ?? []);
  assert.equal(reviews.length, 2, "only verdicts WITH findings");
  assert.deepEqual(reviews.map((r) => r.redRole).sort(), ["red-security", "red-wide"]);
});
