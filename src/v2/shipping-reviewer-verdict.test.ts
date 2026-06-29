// Tests for mapShippingReviewerVerdict (FG-384).
// Covers: basic verdict mapping, ship_with_named_deferrals validation,
// guardrail backstop, and golden fixtures for canonical failure modes.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { insertGate } from "../store/gates.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import { mapShippingReviewerVerdict } from "./runNext.js";
import type { DoneAuditResult, Run, Task, TaskPackage } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function makeRun(id: string, metadata?: Record<string, unknown>): Run {
  return {
    id,
    workflow: "feature",
    title: "test run",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...(metadata ? { metadata } : {}),
  };
}

function makeTask(
  id: string,
  runId: string,
  phase: string,
  agentRole: string,
  status: Task["status"] = "pending",
  result?: unknown,
): Task {
  const pkg: TaskPackage = {
    taskId: id,
    runId,
    phase,
    role: agentRole,
    inputs: {},
    composedSystemPrompt: "",
  };
  return {
    id,
    runId,
    phase,
    agentRole,
    status,
    taskPackage: pkg,
    createdAt: "2026-01-01T00:00:00Z",
    ...(result !== undefined ? { result } : {}),
  };
}

function writeStructuredTicket(
  projectDir: string,
  opts: { id: string; title: string; body: string },
): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const yaml = ["---", `id: ${opts.id}`, "type: story", "status: active", `title: ${opts.title}`, "---", ""].join("\n");
  writeFileSync(join(storiesDir, `${opts.id}-${slug}.md`), yaml + opts.body);
}

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

// Fixture 1: "green tests but wrong production path"
// Scenario: engineer changed only test files, but AC requires a production behavior change.
// Assembles the REAL packet and asserts it surfaces the all-test-files signal.
test("GOLDEN: green tests but wrong production path -> fail, packet signals all-test changedFiles", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg384-golden1-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-T01",
      title: "Prod Feature",
      body: [
        "## Acceptance Criteria",
        "",
        "- Produce a change in src/ production code (not just test files)",
        "",
      ].join("\n"),
    });

    insertRun(makeRun("run-golden1", { ticketId: "FG-T01" }));
    insertTask(makeTask("task-eng-golden1", "run-golden1", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: ["src/foo.test.ts"],
    }));

    const packet = assembleReviewerContextPacket("run-golden1", "task-eng-golden1", projectDir);

    // Assert the REAL packet surfaces the all-test-files signal
    assert.ok(
      packet.git.changedFiles.every((f) => f.endsWith(".test.ts")),
      "all changedFiles must be *.test.ts — signal is present in the real packet",
    );
    assert.ok(
      packet.backlog !== null && packet.backlog.acceptanceCriteria.includes("production code"),
      "acceptanceCriteria must name production requirement in the real packet",
    );

    // Shipping-reviewer result citing acceptance_criterion must map to fail
    const reviewerResult = {
      verdict: "needs_fix",
      confidence: 0.95,
      findings: [
        {
          severity: "high",
          summary: "All changed files are test files; AC requires a production behavior change",
          cites: "acceptance_criterion",
          evidence: "files_modified: src/foo.test.ts",
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
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// Fixture 2: "clean diff but missed operator instruction"
// Scenario: operator gave an instruction via human-advance gate, engineer missed it.
// Assembles the REAL packet and asserts packet.operatorAsk carries the instruction.
test("GOLDEN: clean diff but missed operator instruction -> fail, packet has operatorAsk", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg384-golden2-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-T02",
      title: "Middleware Feature",
      body: "## Acceptance Criteria\n\n- Apply rate-limiter correctly\n\n",
    });

    insertRun(makeRun("run-golden2", { ticketId: "FG-T02" }));
    insertTask(makeTask("task-arch-golden2", "run-golden2", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-eng-golden2", "run-golden2", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: ["src/middleware/auth.ts"],
    }));
    // Human-advance gate carries the operator instruction
    insertGate({
      id: "gate-golden2",
      taskId: "task-arch-golden2",
      decision: "advance",
      rationale: "Make sure the rate-limiter is applied before the auth middleware, not after.",
      decidedAt: "2026-01-01T01:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-golden2", "task-eng-golden2", projectDir);

    // Assert the REAL packet surfaces the operatorAsk from the gate rationale
    assert.ok(
      typeof packet.operatorAsk === "string" && packet.operatorAsk.includes("rate-limiter"),
      "operatorAsk must contain the operator instruction from the real assembler",
    );

    // Shipping-reviewer result citing operator_instruction must map to fail
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
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
