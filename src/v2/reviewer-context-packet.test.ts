import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, markTaskComplete } from "../store/tasks.js";
import { insertGate } from "../store/gates.js";
import { insertVerdict } from "../store/verdicts.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import type { Run, Task, TaskPackage } from "../types/index.js";

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

// Write a structured backlog ticket file in backlog/stories/<id>-<slug>.md
function writeStructuredTicket(
  projectDir: string,
  opts: {
    id: string;
    type?: string;
    status?: string;
    title: string;
    epic?: string;
    body: string;
  },
): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const yaml = [
    "---",
    `id: ${opts.id}`,
    `type: ${opts.type ?? "story"}`,
    `status: ${opts.status ?? "active"}`,
    `title: ${opts.title}`,
    ...(opts.epic ? [`epic: ${opts.epic}`] : []),
    "---",
    "",
  ].join("\n");
  writeFileSync(join(storiesDir, `${opts.id}-${slug}.md`), yaml + opts.body);
}


test("(a) happy path: structured backlog — all fields populated, missingContext empty", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-a-"));
  try {
    const body = [
      "## Acceptance Criteria",
      "",
      "- Ship the feature to production",
      "",
      "## Non-Goals",
      "",
      "- No UI changes",
      "",
    ].join("\n");
    writeStructuredTicket(projectDir, {
      id: "FG-042",
      title: "Test Feature",
      epic: "FG-372",
      status: "active",
      body,
    });

    insertRun(makeRun("run-a", { ticketId: "FG-042" }));
    insertTask(makeTask("task-arch-a", "run-a", "architect", "architecture-advisor", "complete", { decisions: ["Use TypeScript"] }));
    insertTask(makeTask("task-tech-a", "run-a", "tech-lead", "tech-lead", "complete", { steps: ["do X"] }));
    insertTask(makeTask("task-eng-a", "run-a", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: ["src/foo.ts"],
      commitSha: "abc123",
    }));
    insertGate({
      id: "gate-a1",
      taskId: "task-arch-a",
      decision: "advance",
      rationale: "Ship it",
      decidedAt: "2026-01-01T01:00:00Z",
      decidedBy: "human",
    });
    insertTask(makeTask("task-red-a1", "run-a", "red-wide", "red-wide", "complete"));
    insertVerdict({
      id: "verdict-a1",
      taskId: "task-eng-a",
      redTaskId: "task-red-a1",
      redRole: "red-wide",
      verdict: "pass",
      confidence: 0.9,
      authority: "authoritative",
      findings: [],
      createdAt: "2026-01-01T02:00:00Z",
    });

    const packet = assembleReviewerContextPacket("run-a", "task-eng-a", projectDir);

    assert.deepEqual(packet.missingContext, []);
    assert.ok(packet.backlog !== null);
    assert.equal(packet.backlog.id, "FG-042");
    assert.equal(packet.backlog.type, "story");
    assert.equal(packet.backlog.title, "Test Feature");
    assert.equal(packet.backlog.status, "active");
    assert.ok(packet.backlog.body.length > 0, "body must be present");
    assert.ok(packet.backlog.acceptanceCriteria.includes("Ship the feature to production"));
    assert.ok(packet.backlog.nonGoals.includes("No UI changes"));
    assert.equal(packet.backlog.parentEpic, "FG-372");
    assert.equal(packet.operatorAsk, "Ship it");
    assert.deepEqual(packet.git.changedFiles, ["src/foo.ts"]);
    assert.equal(packet.git.commitSha, "abc123");
    assert.deepEqual(packet.architectDecisions, { decisions: ["Use TypeScript"] });
    assert.deepEqual(packet.techLeadPlan, { steps: ["do X"] });
    assert.equal(packet.redFindings.length, 1);
    assert.equal(packet.redFindings[0]!.redRole, "red-wide");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(b) missing ticket: no run.metadata.ticketId → missingContext has required:true backlogTicket", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-b-"));
  try {
    // No ticketId in metadata
    insertRun(makeRun("run-b", { brief: "do stuff" }));
    insertTask(makeTask("task-eng-b", "run-b", "engineer", "engineer", "complete", { status: "complete", files_modified: [] }));

    const packet = assembleReviewerContextPacket("run-b", "task-eng-b", projectDir);

    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.ok(missingTicket, "should have backlogTicket in missingContext");
    assert.equal(missingTicket.required, true);
    assert.equal(packet.backlog, null);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(c) missing operator ask: ticketId set but no human-gate rationale → missingContext has required:false operatorAsk", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-c-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-007",
      title: "My Feature",
      body: "- Do the thing\n",
    });

    insertRun(makeRun("run-c", { ticketId: "FG-007" }));
    insertTask(makeTask("task-arch-c", "run-c", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-eng-c", "run-c", "engineer", "engineer", "complete", { status: "complete", files_modified: [] }));
    // Only a system advance gate — no human rationale
    insertGate({
      id: "gate-c1",
      taskId: "task-arch-c",
      decision: "advance",
      rationale: "auto",
      decidedAt: "2026-01-01T01:00:00Z",
      decidedBy: "system",
    });

    const packet = assembleReviewerContextPacket("run-c", "task-eng-c", projectDir);

    const missingOp = packet.missingContext.find((m) => m.field === "operatorAsk");
    assert.ok(missingOp, "should have operatorAsk in missingContext");
    assert.equal(missingOp.required, false);
    assert.equal(packet.operatorAsk, null);
    // backlogTicket should NOT be missing
    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.equal(missingTicket, undefined, "backlogTicket should not be missing");
    assert.ok(packet.backlog !== null);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(d) request-changes ordering: two gates inserted out of order → sorted by decidedAt ASC", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-d-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-001",
      title: "Ticket",
      body: "- do it\n",
    });

    insertRun(makeRun("run-d", { ticketId: "FG-001" }));
    insertTask(makeTask("task-eng-d1", "run-d", "engineer", "engineer", "complete", {}));
    insertTask(makeTask("task-eng-d2", "run-d", "engineer", "engineer", "complete", {}));
    insertTask(makeTask("task-eng-d3", "run-d", "engineer", "engineer", "complete", {}));

    // Insert LATER gate first (out of order)
    insertGate({
      id: "gate-d2",
      taskId: "task-eng-d2",
      decision: "request-changes",
      rationale: "needs more tests",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: "human",
    });
    // Insert EARLIER gate second (out of order)
    insertGate({
      id: "gate-d1",
      taskId: "task-eng-d1",
      decision: "request-changes",
      rationale: "fix the bug",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-d", "task-eng-d3", projectDir);

    assert.equal(packet.requestChangesHistory.length, 2);
    assert.equal(packet.requestChangesHistory[0]!.decidedAt, "2026-01-01T00:00:00Z");
    assert.equal(packet.requestChangesHistory[0]!.rationale, "fix the bug");
    assert.equal(packet.requestChangesHistory[1]!.decidedAt, "2026-01-02T00:00:00Z");
    assert.equal(packet.requestChangesHistory[1]!.rationale, "needs more tests");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(e) finding disposition round-trip: redFindings retain disposition from DB", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-e-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-005",
      title: "Feature",
      body: "- do stuff\n",
    });

    insertRun(makeRun("run-e", { ticketId: "FG-005" }));
    insertTask(makeTask("task-eng-e", "run-e", "engineer", "engineer", "complete", { status: "complete", files_modified: ["src/x.ts"] }));
    insertTask(makeTask("task-red-e1", "run-e", "red-wide", "red-wide", "complete"));

    insertVerdict({
      id: "verdict-e1",
      taskId: "task-eng-e",
      redTaskId: "task-red-e1",
      redRole: "red-wide",
      verdict: "fail",
      confidence: 0.85,
      authority: "authoritative",
      findings: [
        {
          severity: "high",
          summary: "missing null check",
          evidence: "src/x.ts:10",
          hypothesis: "will crash on null input",
          disposition: "confirmed",
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    });

    const packet = assembleReviewerContextPacket("run-e", "task-eng-e", projectDir);

    assert.equal(packet.redFindings.length, 1);
    const finding = packet.redFindings[0]!.findings[0];
    assert.ok(finding, "should have a finding");
    assert.equal(finding.disposition, "confirmed");
    assert.equal(finding.severity, "high");
    assert.equal(finding.summary, "missing null check");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(f) tests-green-wrong-production-path: packet shape preserves acceptanceCriteria and changedFiles unaltered", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-f-"));
  try {
    const body = [
      "## Acceptance Criteria",
      "",
      "- Produce a change in src/ production code (not just test files)",
      "",
    ].join("\n");
    writeStructuredTicket(projectDir, {
      id: "FG-099",
      title: "Prod Feature",
      body,
    });

    insertRun(makeRun("run-f", { ticketId: "FG-099" }));
    // Engineer changed only a test file
    insertTask(makeTask("task-eng-f", "run-f", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: ["src/v2/reviewer-context-packet.test.ts"],
    }));

    const packet = assembleReviewerContextPacket("run-f", "task-eng-f", projectDir);

    // Assert packet SHAPE only — not reviewer judgment (that is FG-384)
    assert.ok(packet.backlog !== null, "backlog should be populated");
    assert.ok(
      packet.backlog.acceptanceCriteria.includes("Produce a change in src/ production code"),
      "acceptanceCriteria should be present and unaltered",
    );
    assert.deepEqual(
      packet.git.changedFiles,
      ["src/v2/reviewer-context-packet.test.ts"],
      "changedFiles should be present and unaltered",
    );
    // Both fields coexist in the packet — the reviewer (FG-384) makes the judgment
    assert.ok(
      packet.backlog.acceptanceCriteria.length > 0 && packet.git.changedFiles.length > 0,
      "both acceptanceCriteria and changedFiles are present for the reviewer to evaluate",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});


test("(h) operatorAsk uses LAST human-advance gate, not first", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-h-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-010",
      title: "Gate Order Test",
      body: "body\n",
    });

    insertRun(makeRun("run-h", { ticketId: "FG-010" }));
    insertTask(makeTask("task-arch-h1", "run-h", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-arch-h2", "run-h", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-eng-h", "run-h", "engineer", "engineer", "complete", {}));

    // First human-advance gate (earlier)
    insertGate({
      id: "gate-h1",
      taskId: "task-arch-h1",
      decision: "advance",
      rationale: "early scope: just the basic feature",
      decidedAt: "2026-01-01T01:00:00Z",
      decidedBy: "human",
    });
    // Second human-advance gate (later) — scope was updated
    insertGate({
      id: "gate-h2",
      taskId: "task-arch-h2",
      decision: "advance",
      rationale: "updated scope: also include the edge-case handling",
      decidedAt: "2026-01-02T01:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-h", "task-eng-h", projectDir);

    assert.equal(
      packet.operatorAsk,
      "updated scope: also include the edge-case handling",
      "operatorAsk must be the LATEST human-advance gate rationale",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── FG-381 adversarial: Finding 1 structured-path hardening ─────────────────

test("(i) structured path: epic ticket in backlog/epics/ resolves correctly; no BACKLOG.md present", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-i-"));
  try {
    // Write to epics subdir, not stories — exercises the epic branch of findTicketFile
    const epicsDir = join(projectDir, "backlog", "epics");
    mkdirSync(epicsDir, { recursive: true });
    const body = [
      "## Acceptance Criteria",
      "",
      "- Epic criterion one",
      "",
      "## Non-Goals",
      "",
      "- Not a story",
      "",
    ].join("\n");
    const content = [
      "---",
      "id: FG-200",
      "type: epic",
      "status: active",
      "title: Epic Feature",
      "---",
      "",
    ].join("\n") + body;
    writeFileSync(join(epicsDir, "FG-200-epic-feature.md"), content);
    // Explicitly NO BACKLOG.md — proves we don't fall through to legacy

    insertRun(makeRun("run-i", { ticketId: "FG-200" }));
    insertTask(makeTask("task-eng-i", "run-i", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));
    insertGate({
      id: "gate-i1",
      taskId: "task-eng-i",
      decision: "advance",
      rationale: "go ahead",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-i", "task-eng-i", projectDir);

    assert.ok(packet.backlog !== null, "backlog must be populated for epic ticket");
    assert.equal(packet.backlog.id, "FG-200");
    assert.equal(packet.backlog.type, "epic");
    assert.equal(packet.backlog.status, "active");
    assert.equal(packet.backlog.title, "Epic Feature");
    assert.ok(packet.backlog.body.length > 0, "body must be present");
    assert.ok(packet.backlog.acceptanceCriteria.includes("Epic criterion one"), "acceptanceCriteria parsed from epic ticket");
    assert.ok(packet.backlog.nonGoals.includes("Not a story"), "nonGoals parsed from epic ticket");
    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.equal(missingTicket, undefined, "backlogTicket must not be missing");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(j) structured path: done ticket in backlog/done/ resolves correctly", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-j-"));
  try {
    const doneDir = join(projectDir, "backlog", "done");
    mkdirSync(doneDir, { recursive: true });
    const body = "## Acceptance Criteria\n\n- Done criterion\n\n";
    const content = [
      "---",
      "id: FG-050",
      "type: story",
      "status: done",
      "title: Completed Story",
      "epic: FG-049",
      "---",
      "",
    ].join("\n") + body;
    writeFileSync(join(doneDir, "FG-050-completed-story.md"), content);

    insertRun(makeRun("run-j", { ticketId: "FG-050" }));
    insertTask(makeTask("task-eng-j", "run-j", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));
    insertGate({
      id: "gate-j1",
      taskId: "task-eng-j",
      decision: "advance",
      rationale: "approved",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-j", "task-eng-j", projectDir);

    assert.ok(packet.backlog !== null, "backlog must be populated for done ticket");
    assert.equal(packet.backlog.id, "FG-050");
    assert.equal(packet.backlog.type, "story");
    assert.equal(packet.backlog.status, "done");
    assert.equal(packet.backlog.title, "Completed Story");
    assert.equal(packet.backlog.parentEpic, "FG-049", "parentEpic from epic frontmatter");
    assert.ok(packet.backlog.body.length > 0, "body must be present");
    assert.ok(packet.backlog.acceptanceCriteria.includes("Done criterion"));
    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.equal(missingTicket, undefined, "done ticket must not appear as missing");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(k) body WITHOUT acceptanceCriteria/nonGoals sections → both fields are empty strings, not fabricated", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-k-"));
  try {
    // Body has no ## Acceptance Criteria or ## Non-Goals headings at all
    writeStructuredTicket(projectDir, {
      id: "FG-300",
      title: "Sparse Ticket",
      body: "This ticket only has a prose description.\n",
    });

    insertRun(makeRun("run-k", { ticketId: "FG-300" }));
    insertTask(makeTask("task-eng-k", "run-k", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));
    insertGate({
      id: "gate-k1",
      taskId: "task-eng-k",
      decision: "advance",
      rationale: "go",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-k", "task-eng-k", projectDir);

    assert.ok(packet.backlog !== null);
    assert.equal(
      packet.backlog.acceptanceCriteria,
      "",
      "acceptanceCriteria must be empty string when section is absent — not fabricated",
    );
    assert.equal(
      packet.backlog.nonGoals,
      "",
      "nonGoals must be empty string when section is absent — not fabricated",
    );
    assert.ok(packet.backlog.body.includes("prose description"), "body itself is still present");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(l) ticketId set but no structured match and no BACKLOG.md → missingContext required:true", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-l-"));
  try {
    // Empty project dir — no backlog/ dir, no BACKLOG.md
    // ticketId references a ticket that does not exist anywhere
    insertRun(makeRun("run-l", { ticketId: "FG-999" }));
    insertTask(makeTask("task-eng-l", "run-l", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));

    const packet = assembleReviewerContextPacket("run-l", "task-eng-l", projectDir);

    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.ok(missingTicket, "backlogTicket must appear in missingContext");
    assert.equal(missingTicket.required, true, "must be required:true");
    assert.ok(
      missingTicket.reason.includes("FG-999") && missingTicket.reason.includes("backlog/"),
      `reason must identify ticket id and structured backlog path, got: ${missingTicket.reason}`,
    );
    assert.equal(packet.backlog, null, "backlog must be null");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── FG-381 adversarial: Finding 2 — no legacy BACKLOG.md fallback ──────────

test("(n) no-legacy-fallback: ticketId set, structured ticket ABSENT, BACKLOG.md PRESENT → missingContext required:true; BACKLOG.md ignored", () => {
  // Regression guard: the legacy readBacklog/BACKLOG.md path was removed in FG-381.
  // Even when BACKLOG.md exists in the project root and would have matched the ticketId
  // under the old code, the packet must NOT consult it. Structured-only invariant.
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-n-"));
  try {
    // Write a BACKLOG.md with content that mentions FG-888.
    // A pre-FG-381 implementation might find this and populate backlog from it.
    writeFileSync(
      join(projectDir, "BACKLOG.md"),
      [
        "# Backlog",
        "",
        "## FG-888 — Legacy Feature",
        "",
        "Do the legacy thing. This content must never reach the reviewer packet.",
        "",
      ].join("\n"),
    );
    // Explicitly NO backlog/ directory — no structured ticket for FG-888.

    insertRun(makeRun("run-n", { ticketId: "FG-888" }));
    insertTask(makeTask("task-eng-n", "run-n", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));

    const packet = assembleReviewerContextPacket("run-n", "task-eng-n", projectDir);

    const missingTicket = packet.missingContext.find((m) => m.field === "backlogTicket");
    assert.ok(
      missingTicket !== undefined,
      "backlogTicket must appear in missingContext even when BACKLOG.md is present",
    );
    assert.equal(missingTicket.required, true, "must be required:true");
    assert.ok(
      missingTicket.reason.includes("FG-888") && missingTicket.reason.includes("backlog/"),
      `reason must reference structured backlog path, not legacy BACKLOG.md; got: ${missingTicket.reason}`,
    );
    assert.equal(
      packet.backlog,
      null,
      "backlog must be null — legacy BACKLOG.md must not be consulted",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── FG-381 adversarial: Finding 3 — reverse insertion order ────────────────

// ─── FG-384: doneAudit in ReviewerContextPacket ───────────────────────────────

test("(p) doneAudit: populated with DoneAuditResult shape when ticket is resolvable", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg384-p-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-500",
      title: "Done Audit Test",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    insertRun(makeRun("run-p", { ticketId: "FG-500" }));
    insertTask(makeTask("task-eng-p", "run-p", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: ["src/foo.ts"],
      tests_run: 12,
    }));
    insertGate({
      id: "gate-p1",
      taskId: "task-eng-p",
      decision: "advance",
      rationale: "go",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-p", "task-eng-p", projectDir);

    // doneAudit must be a non-null DoneAuditResult
    assert.ok(packet.doneAudit !== null, "doneAudit must be populated when ticket resolves");
    assert.ok(
      ["pass", "fail", "unknown"].includes(packet.doneAudit.outcome),
      `outcome must be a valid DoneAuditOutcome, got: ${packet.doneAudit.outcome}`,
    );
    assert.ok(Array.isArray(packet.doneAudit.checks), "doneAudit.checks must be an array");
    assert.ok(Array.isArray(packet.doneAudit.gaps), "doneAudit.gaps must be an array");
    // checks should include at least the standard named checks
    const checkNames = packet.doneAudit.checks.map((c) => c.name);
    assert.ok(checkNames.includes("ticket_closed"), "must have ticket_closed check");
    assert.ok(checkNames.includes("host_verification"), "must have host_verification check");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(q) doneAudit: null when ticket cannot be resolved (ticketId in metadata but file not found)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg384-q-"));
  try {
    // No backlog directory — ticket FG-999 is not findable
    insertRun(makeRun("run-q", { ticketId: "FG-999" }));
    insertTask(makeTask("task-eng-q", "run-q", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));

    const packet = assembleReviewerContextPacket("run-q", "task-eng-q", projectDir);

    assert.equal(packet.backlog, null, "backlog must be null when ticket not found");
    assert.equal(packet.doneAudit, null, "doneAudit must be null when ticket cannot be resolved");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(r) doneAudit: null when run has no ticketId in metadata", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg384-r-"));
  try {
    // No ticketId in metadata
    insertRun(makeRun("run-r", { brief: "do stuff" }));
    insertTask(makeTask("task-eng-r", "run-r", "engineer", "engineer", "complete", {
      status: "complete",
      files_modified: [],
    }));

    const packet = assembleReviewerContextPacket("run-r", "task-eng-r", projectDir);

    assert.equal(packet.doneAudit, null, "doneAudit must be null when run has no ticketId");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(m) Finding 3 reverse insertion: LATER gate inserted FIRST, EARLIER inserted SECOND → operatorAsk = LATER", () => {
  // This test exercises that operatorAsk resolution is by decidedAt (not insertion order).
  // gatesForRun orders by decided_at ASC; the loop takes the last element — so the
  // gate with the LATEST decidedAt wins regardless of which was inserted first.
  const projectDir = mkdtempSync(join(tmpdir(), "fg381-m-"));
  try {
    writeStructuredTicket(projectDir, {
      id: "FG-011",
      title: "Reverse Gate Test",
      body: "body\n",
    });

    insertRun(makeRun("run-m", { ticketId: "FG-011" }));
    insertTask(makeTask("task-arch-m1", "run-m", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-arch-m2", "run-m", "architect", "architecture-advisor", "complete", {}));
    insertTask(makeTask("task-eng-m", "run-m", "engineer", "engineer", "complete", {}));

    // Insert LATER gate FIRST (out of chronological insertion order)
    insertGate({
      id: "gate-m2",
      taskId: "task-arch-m2",
      decision: "advance",
      rationale: "final scope: include all edge cases",
      decidedAt: "2026-06-02T10:00:00Z",
      decidedBy: "human",
    });
    // Insert EARLIER gate SECOND
    insertGate({
      id: "gate-m1",
      taskId: "task-arch-m1",
      decision: "advance",
      rationale: "initial scope: basic feature only",
      decidedAt: "2026-06-01T10:00:00Z",
      decidedBy: "human",
    });

    const packet = assembleReviewerContextPacket("run-m", "task-eng-m", projectDir);

    assert.equal(
      packet.operatorAsk,
      "final scope: include all edge cases",
      "operatorAsk must be the gate with the LATEST decidedAt, regardless of insertion order",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
