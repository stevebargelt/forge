// Tests for mapShippingReviewerVerdict (FG-384).
// Covers: basic verdict mapping, ship_with_named_deferrals validation,
// guardrail backstop, and golden fixtures for canonical failure modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapShippingReviewerVerdict } from "./runNext.js";
import type { DoneAuditResult } from "../types/index.js";

// ─── Basic verdict mapping ────────────────────────────────────────────────────

test("ship -> pass", () => {
  const v = mapShippingReviewerVerdict({ verdict: "ship", confidence: 0.9, findings: [] });
  assert.equal(v.verdict, "pass");
  assert.equal(v.confidence, 0.9);
});

test("needs_fix -> fail", () => {
  const finding = { severity: "high", summary: "missing check", evidence: "src/x.ts:1", hypothesis: "will break" };
  const v = mapShippingReviewerVerdict({ verdict: "needs_fix", confidence: 0.8, findings: [finding] });
  assert.equal(v.verdict, "fail");
  assert.equal(v.findings.length, 1);
});

test("needs_human -> inconclusive", () => {
  const v = mapShippingReviewerVerdict({ verdict: "needs_human", confidence: 0.5, findings: [] });
  assert.equal(v.verdict, "inconclusive");
});

test("missing verdict -> inconclusive", () => {
  const v = mapShippingReviewerVerdict({ confidence: 0.5, findings: [] });
  assert.equal(v.verdict, "inconclusive");
});

test("garbage verdict -> inconclusive", () => {
  const v = mapShippingReviewerVerdict({ verdict: "banana", confidence: 0.5, findings: [] });
  assert.equal(v.verdict, "inconclusive");
});

test("null output -> inconclusive with default confidence", () => {
  const v = mapShippingReviewerVerdict(null);
  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.confidence, 0.5);
});

test("confidence clamped: out-of-range value defaults to 0.5", () => {
  const v = mapShippingReviewerVerdict({ verdict: "ship", confidence: 1.5, findings: [] });
  assert.equal(v.verdict, "pass");
  assert.equal(v.confidence, 0.5);
});

test("invariants_verified carried through", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship",
    confidence: 0.9,
    findings: [],
    invariants_verified: ["AC 1: met", "AC 2: met"],
  });
  assert.deepEqual(v.invariants_verified, ["AC 1: met", "AC 2: met"]);
});

// ─── ship_with_named_deferrals ────────────────────────────────────────────────

test("ship_with_named_deferrals: all deferrals named+linked -> pass", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
    named_deferrals: [
      { description: "Defer host verify", followUpTicketId: "FG-123" },
      { description: "Defer E2E", followUpTicketId: "FG-124" },
    ],
  });
  assert.equal(v.verdict, "pass");
});

test("ship_with_named_deferrals: deferral missing followUpTicketId -> fail", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
    named_deferrals: [
      { description: "Defer host verify" },
    ],
  });
  assert.equal(v.verdict, "fail");
});

test("ship_with_named_deferrals: deferral with empty followUpTicketId -> fail", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
    named_deferrals: [
      { description: "Defer host verify", followUpTicketId: "" },
    ],
  });
  assert.equal(v.verdict, "fail");
});

test("ship_with_named_deferrals: deferral with empty description -> fail", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
    named_deferrals: [
      { description: "", followUpTicketId: "FG-123" },
    ],
  });
  assert.equal(v.verdict, "fail");
});

test("ship_with_named_deferrals: empty named_deferrals array -> fail", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
    named_deferrals: [],
  });
  assert.equal(v.verdict, "fail");
});

test("ship_with_named_deferrals: missing named_deferrals field -> fail", () => {
  const v = mapShippingReviewerVerdict({
    verdict: "ship_with_named_deferrals",
    confidence: 0.85,
    findings: [],
  });
  assert.equal(v.verdict, "fail");
});

// ─── Guardrail backstop ───────────────────────────────────────────────────────

function makeFailDoneAudit(outcome: DoneAuditResult["outcome"] = "unknown"): DoneAuditResult {
  return {
    outcome,
    checks: [{ name: "host_verification", status: "unknown" }],
    gaps: ["host verification not recorded"],
    requestedAction: "run host typecheck + full suite",
  };
}

test("GUARDRAIL: ship + doneAudit.outcome unknown + doneAuditDisposition ok -> downgraded to fail", () => {
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "ok" },
    makeFailDoneAudit("unknown"),
  );
  assert.equal(v.verdict, "fail");
});

test("GUARDRAIL: ship + doneAudit.outcome fail + doneAuditDisposition ok -> downgraded to fail", () => {
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "ok" },
    makeFailDoneAudit("fail"),
  );
  assert.equal(v.verdict, "fail");
});

test("GUARDRAIL: ship + doneAudit.outcome unknown + accepted_exception -> stays pass", () => {
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "accepted_exception: host verify waived" },
    makeFailDoneAudit("unknown"),
  );
  assert.equal(v.verdict, "pass");
});

test("GUARDRAIL: ship + doneAudit.outcome unknown + covered_by_deferral -> stays pass", () => {
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "covered_by_deferral" },
    makeFailDoneAudit("unknown"),
  );
  assert.equal(v.verdict, "pass");
});

test("GUARDRAIL: ship + doneAudit.outcome pass -> ship stays pass (no downgrade)", () => {
  const passDoneAudit: DoneAuditResult = {
    outcome: "pass",
    checks: [{ name: "host_verification", status: "pass" }],
    gaps: [],
    requestedAction: null,
  };
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "ok" },
    passDoneAudit,
  );
  assert.equal(v.verdict, "pass");
});

test("GUARDRAIL: no doneAudit provided -> no backstop (ship stays pass)", () => {
  const v = mapShippingReviewerVerdict({ verdict: "ship", confidence: 0.9, findings: [] });
  assert.equal(v.verdict, "pass");
});

test("GUARDRAIL: doneAudit null -> no backstop (ship stays pass)", () => {
  const v = mapShippingReviewerVerdict(
    { verdict: "ship", confidence: 0.9, findings: [], doneAuditDisposition: "ok" },
    null,
  );
  assert.equal(v.verdict, "pass");
});

// ─── Golden fixtures: canonical acceptance-review failure modes ───────────────

// Fixture 1: "green tests but wrong canonical production path"
// Scenario: engineer changed only test files, but AC requires a production behavior change.
// The shipping-reviewer fires needs_fix citing acceptance_criterion.
test("GOLDEN: green tests but wrong production path -> fail, packet signals all-test changedFiles", () => {
  // Packet fixture: changedFiles are all test files, AC requires prod change
  const packetFixture = {
    git: {
      changedFiles: ["src/foo.test.ts", "src/v2/bar.test.ts"],
    },
    backlog: {
      acceptanceCriteria: "Produce a change in src/ production code (not just test files)",
    },
  };

  // Shipping-reviewer result: needs_fix citing acceptance_criterion
  const reviewerResult = {
    verdict: "needs_fix",
    confidence: 0.95,
    findings: [
      {
        severity: "high",
        summary: "All changed files are test files; AC requires a production behavior change",
        cites: "acceptance_criterion",
        evidence: "files_modified: src/foo.test.ts, src/v2/bar.test.ts",
        file: "src/foo.test.ts",
        line: 1,
      },
    ],
    doneAuditDisposition: "ok",
    invariants_verified: ["AC 1: unmet"],
  };

  const verdict = mapShippingReviewerVerdict(reviewerResult);
  assert.equal(verdict.verdict, "fail", "needs_fix must map to fail");
  assert.equal(verdict.findings.length, 1);
  assert.equal(
    (verdict.findings[0]! as Record<string, unknown>)["cites"],
    "acceptance_criterion",
  );

  // Assert the packet exposes the signal a reviewer needs to catch this
  const allTestFiles = packetFixture.git.changedFiles.every((f) => f.endsWith(".test.ts"));
  assert.ok(allTestFiles, "all changedFiles are *.test.ts — signal is present in packet");
  assert.ok(
    packetFixture.backlog.acceptanceCriteria.includes("production code"),
    "acceptanceCriteria names production requirement — signal is present in packet",
  );
});

// Fixture 2: "clean diff but missed operator instruction"
// Scenario: operator gave an instruction (operatorAsk), engineer missed it.
// The shipping-reviewer fires needs_fix citing operator_instruction.
test("GOLDEN: clean diff but missed operator instruction -> fail, packet has operatorAsk", () => {
  // Packet fixture: non-empty operatorAsk naming the instruction
  const packetFixture = {
    operatorAsk: "Make sure the rate-limiter is applied before the auth middleware, not after.",
    git: {
      changedFiles: ["src/middleware/auth.ts"],
    },
  };

  // Shipping-reviewer result: needs_fix citing operator_instruction
  const reviewerResult = {
    verdict: "needs_fix",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "Rate-limiter is applied after auth middleware, violating operator instruction",
        cites: "operator_instruction",
        evidence: "src/middleware/auth.ts:42",
        file: "src/middleware/auth.ts",
        line: 42,
      },
    ],
    doneAuditDisposition: "ok",
    invariants_verified: [],
  };

  const verdict = mapShippingReviewerVerdict(reviewerResult);
  assert.equal(verdict.verdict, "fail", "needs_fix must map to fail");
  assert.equal(
    (verdict.findings[0]! as Record<string, unknown>)["cites"],
    "operator_instruction",
  );

  // Assert operatorAsk is present in the packet for the reviewer to cite
  assert.ok(
    typeof packetFixture.operatorAsk === "string" && packetFixture.operatorAsk.length > 0,
    "operatorAsk is present in packet — the reviewer can cite the missed instruction",
  );
  assert.ok(
    packetFixture.operatorAsk.includes("rate-limiter"),
    "operatorAsk names the specific instruction",
  );
});
