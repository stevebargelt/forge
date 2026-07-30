// FG-638 (evidence-led review, Change 1): the durable review ledger.
//
// What these tests hold:
//   - rows carry current state, events carry how it got there, and EVERY state
//     transition writes one;
//   - Forge assigns stable RF-n ids and a model-supplied id is never honored —
//     it survives only as provenance;
//   - the persistence CAPABILITY the narrowed AC names: many sources on one
//     finding without loss, and two distinct findings with distinct ids.
//     Normalization/dedup POLICY is FG-639 and is deliberately absent;
//   - every per-value disposition precondition, each proven by a refusal that
//     writes NOTHING.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun, getRun, runReviewMode } from "./runs.js";
import { insertTask } from "./tasks.js";
import { eventsForRun } from "./events.js";
import {
  insertReview,
  getReview,
  reviewsForRun,
  reviewsForTask,
  setReviewState,
  updateReview,
  ingestFindings,
  findingsForReview,
  getFinding,
  lookupFinding,
  recordDisposition,
  acceptedRiskNeedsOperator,
  summarizeReview,
  REVIEW_STATES,
} from "./reviews.js";
import type { Run, Task } from "../types/index.js";

const RUN: Run = {
  id: "run-fg638",
  workflow: "feature",
  title: "review ledger",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function task(id: string): Task {
  return {
    id,
    runId: RUN.id,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
}

// candidateSha is nullable rather than optional on purpose: passing `undefined` to a
// defaulted parameter re-selects the default, which would silently give the
// "no candidate" case a candidate.
function newReview(id = "review-1", candidateSha: string | null = "cand111"): string {
  insertReview({
    id,
    runId: RUN.id,
    subjectTaskId: "task-subject",
    ticketId: "FG-638",
    reviewMode: "evidence_led",
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: candidateSha ?? undefined,
    trustedRemoteSha: "rem333",
    contract: { threat_model: "operator_trusted_candidate", risk_lenses: ["wide", "security"] },
    state: "awaiting_disposition",
  });
  return id;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-subject"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── review_mode ────────────────────────────────────────────────────────────

test("FG-638: exactly one review_mode per run — an evidence-led run round-trips", () => {
  assert.equal(getRun(RUN.id)!.reviewMode, "evidence_led");
  assert.equal(runReviewMode(RUN.id), "evidence_led");
});

test("FG-638: a legacy run with no reviews row resolves unambiguously to legacy_verdict", () => {
  // Exactly how a pre-FG-638 binary writes a run: the INSERT does not name
  // review_mode at all, so the column's DEFAULT is the whole answer.
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-legacy", "feature", "legacy", "active", "2026-01-01T00:00:00Z");

  assert.equal(reviewsForRun("run-legacy").length, 0, "precondition: the legacy run has no ledger row");
  assert.equal(runReviewMode("run-legacy"), "legacy_verdict");
  assert.equal(getRun("run-legacy")!.reviewMode, "legacy_verdict");
});

test("FG-638: review_mode is copied onto the review for read surfaces", () => {
  newReview();
  assert.equal(getReview("review-1")!.reviewMode, "evidence_led");
  assert.equal(
    getReview("review-1")!.reviewMode,
    getRun(RUN.id)!.reviewMode,
    "the review's mode is a DENORMALIZED COPY of the run's, never an independent answer",
  );
});

/** Everything a mode conflict could damage, raw. A refusal must move none of it. */
function authoritySnapshot(): unknown {
  const d = getDb();
  return {
    runs: d.prepare(`SELECT * FROM runs ORDER BY id`).all(),
    reviews: d.prepare(`SELECT * FROM reviews ORDER BY id`).all(),
    events: d.prepare(`SELECT * FROM events ORDER BY id`).all(),
  };
}

test("FG-638: a never-marked run ADOPTS its first review's mode — run row and review copy move together", () => {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-adopts", "feature", "unmarked", "active", "2026-01-01T00:00:00Z");
  assert.equal(getRun("run-adopts")!.reviewMode, "legacy_verdict", "precondition: the run carries the column DEFAULT");

  insertReview({ id: "review-adopts", runId: "run-adopts", reviewMode: "evidence_led", state: "confirming_contract" });

  assert.equal(getRun("run-adopts")!.reviewMode, "evidence_led", "the RUN row is the authority-model truth and must have moved");
  assert.equal(getReview("review-adopts")!.reviewMode, "evidence_led");
  assert.equal(runReviewMode("run-adopts"), "evidence_led");

  const created = eventsForRun("run-adopts").filter((e) => e.eventType === "review.created");
  assert.equal(created.length, 1);
  assert.equal(
    (created[0]!.payload as { runReviewModeAdopted: boolean }).runReviewModeAdopted,
    true,
    "the adoption is auditable — a run silently changing authority model is exactly what the ledger exists to prevent",
  );
});

test("FG-638: a review whose mode conflicts with its run is REFUSED by name, and writes nothing", () => {
  // The run was marked evidence_led at creation; a legacy_verdict review on it would
  // make "which authority model settles this run" a question with two answers.
  const before = authoritySnapshot();
  assert.throws(
    () => insertReview({ id: "review-conflict", runId: RUN.id, reviewMode: "legacy_verdict" }),
    (e: Error) => {
      assert.match(e.message, new RegExp(RUN.id), "the refusal must name the run");
      assert.match(e.message, /is evidence_led/, "the refusal must name the run's mode");
      assert.match(e.message, /cannot be legacy_verdict/, "the refusal must name the attempted mode");
      assert.match(e.message, /Nothing was written/);
      return true;
    },
  );
  assert.deepEqual(authoritySnapshot(), before, "a refused review must leave runs, reviews and events byte-identical");
  assert.equal(getReview("review-conflict"), undefined);
});

test("FG-638: adoption happens ONCE — the second review may not re-mark the run", () => {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-once", "feature", "unmarked", "active", "2026-01-01T00:00:00Z");
  insertReview({ id: "review-once-1", runId: "run-once", reviewMode: "evidence_led" });

  const before = authoritySnapshot();
  assert.throws(
    () => insertReview({ id: "review-once-2", runId: "run-once", reviewMode: "legacy_review_loop" }),
    /run-once is evidence_led/,
  );
  assert.deepEqual(authoritySnapshot(), before);

  // A SECOND review agreeing with the adopted mode is ordinary and permitted.
  insertReview({ id: "review-once-3", runId: "run-once", reviewMode: "evidence_led" });
  assert.equal(reviewsForRun("run-once").length, 2);
  assert.equal(getRun("run-once")!.reviewMode, "evidence_led");
});

test("FG-638: a run that already owns a legacy_verdict review refuses an evidence_led one", () => {
  // The run still reads the DEFAULT, so "never marked" cannot be decided from the
  // column alone — an existing review is the other half of the answer.
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-legacy-ledger", "feature", "legacy", "active", "2026-01-01T00:00:00Z");
  insertReview({ id: "review-legacy-1", runId: "run-legacy-ledger", reviewMode: "legacy_verdict" });
  assert.equal(getRun("run-legacy-ledger")!.reviewMode, "legacy_verdict");

  const before = authoritySnapshot();
  assert.throws(
    () => insertReview({ id: "review-legacy-2", runId: "run-legacy-ledger", reviewMode: "evidence_led" }),
    /run-legacy-ledger is legacy_verdict/,
  );
  assert.deepEqual(authoritySnapshot(), before);
});

test("FG-638: adoption is ATOMIC with the review insert — a failed insert leaves the run unmarked", () => {
  // The run row is written BEFORE the review row, so "both rows or neither" is a claim
  // about the transaction, not about statement order. Forced by re-using an id that
  // already exists: the run UPDATE lands, then the INSERT violates the primary key.
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("run-atomic", "feature", "unmarked", "active", "2026-01-01T00:00:00Z");
  insertReview({ id: "review-taken", reviewMode: "evidence_led" }); // no run — takes the id only

  const before = authoritySnapshot();
  assert.throws(() => insertReview({ id: "review-taken", runId: "run-atomic", reviewMode: "evidence_led" }));
  assert.equal(getRun("run-atomic")!.reviewMode, "legacy_verdict", "the run must not keep a mode whose review never landed");
  assert.deepEqual(authoritySnapshot(), before);
});

test("FG-638: a review with no owning run is unconstrained — there is no run to disagree with", () => {
  insertReview({ id: "review-orphan", reviewMode: "evidence_led" });
  assert.equal(getReview("review-orphan")!.reviewMode, "evidence_led");
  assert.equal(getReview("review-orphan")!.runId, undefined);
});

// ─── lifecycle + events ─────────────────────────────────────────────────────

test("FG-638: creating a review emits review.created and links run/task/ticket", () => {
  newReview();
  const r = getReview("review-1")!;
  assert.equal(r.runId, RUN.id);
  assert.equal(r.subjectTaskId, "task-subject");
  assert.equal(r.ticketId, "FG-638");
  assert.equal(r.baseSha, "base000");
  assert.equal(r.contractConfirmedSha, "conf222");
  assert.equal(r.candidateSha, "cand111");
  assert.equal(r.trustedRemoteSha, "rem333");
  assert.deepEqual(reviewsForTask("task-subject").map((x) => x.id), ["review-1"]);

  const created = eventsForRun(RUN.id).filter((e) => e.eventType === "review.created");
  assert.equal(created.length, 1);
  assert.deepEqual((created[0]!.payload as { reviewId: string }).reviewId, "review-1");
});

test("FG-638: every state transition emits an event carrying from/to", () => {
  newReview();
  for (const s of ["discovering", "fixing", "verifying", "settled"] as const) setReviewState("review-1", s);

  const transitions = eventsForRun(RUN.id)
    .filter((e) => e.eventType === "review.state_changed")
    .map((e) => {
      const p = e.payload as { from: string; to: string };
      return [p.from, p.to];
    });
  assert.deepEqual(transitions, [
    ["awaiting_disposition", "discovering"],
    ["discovering", "fixing"],
    ["fixing", "verifying"],
    ["verifying", "settled"],
  ]);
  assert.equal(getReview("review-1")!.state, "settled");
  assert.ok(getReview("review-1")!.settledAt !== undefined, "reaching settled stamps settled_at");
});

test("FG-638: all 11 review states persist", () => {
  newReview();
  for (const state of REVIEW_STATES) {
    setReviewState("review-1", state);
    assert.equal(getReview("review-1")!.state, state);
  }
  assert.equal(REVIEW_STATES.length, 11);
});

test("FG-638: the four SHAs are independently updatable and none overwrites another", () => {
  newReview();
  updateReview("review-1", { candidateSha: "cand999" });
  const r = getReview("review-1")!;
  assert.equal(r.candidateSha, "cand999");
  assert.equal(r.baseSha, "base000");
  assert.equal(r.contractConfirmedSha, "conf222");
  assert.equal(r.trustedRemoteSha, "rem333");
});

// ─── ingestion ──────────────────────────────────────────────────────────────

test("FG-638: ingestion assigns stable RF-n ids and never honors a model-supplied id", () => {
  newReview();
  const [a, b] = ingestFindings("review-1", [
    { summary: "first", modelFindingId: "SEC-001" },
    { summary: "second", modelFindingId: "SEC-001" },
  ]);

  assert.equal(a!.findingRef, "RF-1");
  assert.equal(b!.findingRef, "RF-2");
  assert.equal(a!.id, "review-1/RF-1");
  assert.equal(b!.id, "review-1/RF-2");
  assert.notEqual(a!.id, b!.id, "two observations claiming the same model id still get distinct forge ids");

  // The model's own id survives ONLY as provenance.
  assert.deepEqual(a!.sources, [{ modelFindingId: "SEC-001" }]);
  assert.equal(getFinding("SEC-001"), undefined, "a model-supplied id is never an addressable identity");
});

test("FG-638: ordinals continue across ingestion rounds", () => {
  newReview();
  ingestFindings("review-1", [{ summary: "first" }]);
  const [second] = ingestFindings("review-1", [{ summary: "late arrival" }]);
  assert.equal(second!.findingRef, "RF-2");
  assert.deepEqual(findingsForReview("review-1").map((f) => f.findingRef), ["RF-1", "RF-2"]);
});

test("FG-638 capability (a): ONE finding holds multiple reviewer sources without loss", () => {
  newReview();
  const [f] = ingestFindings("review-1", [
    {
      summary: "the same anchored mechanism, seen by two reviewers",
      file: "src/store/db.ts",
      line: 42,
      sources: [
        { redRole: "red-security", redTaskId: "task-red-sec", verdictId: "verdict-1", authority: "specialist" },
        { redRole: "red-wide", redTaskId: "task-red-wide", verdictId: "verdict-2", authority: "specialist" },
      ],
    },
  ]);
  const stored = getFinding(f!.id)!;
  assert.equal(stored.sources.length, 2);
  assert.deepEqual(stored.sources.map((s) => s.verdictId), ["verdict-1", "verdict-2"]);
  assert.deepEqual(stored.sources.map((s) => s.redRole), ["red-security", "red-wide"]);
});

test("FG-638 capability (b): two distinct findings stay two rows with distinct stable ids", () => {
  newReview();
  const findings = ingestFindings("review-1", [
    { summary: "unbounded read", invariantRef: "candidate tree equals gated tree" },
    { summary: "unbounded read", invariantRef: "only forge publishes the target branch" },
  ]);
  assert.equal(findings.length, 2);
  assert.equal(new Set(findings.map((f) => f.id)).size, 2);
  assert.equal(findingsForReview("review-1").length, 2);
});

test("FG-638: raw verdict rows are untouched provenance — ingestion adds, never rewrites", () => {
  newReview();
  insertTask({ ...task("task-red"), agentRole: "red-security", phase: "red" });
  getDb()
    .prepare(
      `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("verdict-raw", "task-subject", "task-red", "red-security", "fail", 0.9, "specialist", '[{"summary":"raw"}]', "2026-07-30T00:00:00Z");

  const before = getDb().prepare(`SELECT * FROM verdicts WHERE id = 'verdict-raw'`).get();
  ingestFindings("review-1", [{ summary: "raw", sources: [{ verdictId: "verdict-raw" }] }]);
  const after = getDb().prepare(`SELECT * FROM verdicts WHERE id = 'verdict-raw'`).get();
  assert.deepEqual(after, before, "the immutable provenance row must be byte-identical after ingestion");
});

test("FG-638: ingestion emits one event per finding naming the forge id and the model id", () => {
  newReview();
  ingestFindings("review-1", [{ summary: "one", modelFindingId: "MODEL-9" }, { summary: "two" }]);
  const ingested = eventsForRun(RUN.id).filter((e) => e.eventType === "review.finding_ingested");
  assert.equal(ingested.length, 2);
  assert.deepEqual(
    ingested.map((e) => {
      const p = e.payload as { findingRef: string; modelSuppliedId: string | null };
      return [p.findingRef, p.modelSuppliedId];
    }),
    [["RF-1", "MODEL-9"], ["RF-2", null]],
  );
});

// ─── disposition preconditions ──────────────────────────────────────────────

function ingestOne(extra: Record<string, unknown> = {}): string {
  const [f] = ingestFindings("review-1", [{ summary: "a finding", ...extra }]);
  return f!.id;
}

function unchanged(id: string): void {
  const f = getFinding(id)!;
  assert.equal(f.disposition, "untriaged", "a refused disposition must leave the row untriaged");
  assert.equal(f.dispositionRationale, undefined);
  assert.equal(f.decidedBy, undefined);
  assert.equal(f.decidedAt, undefined);
  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.finding_dispositioned").length,
    0,
    "a refusal writes no event either",
  );
}

test("FG-638: fix_now records disposition, decided_by orchestrator, and the candidate sha", () => {
  newReview();
  const id = ingestOne();
  const out = recordDisposition(id, { decision: "fix_now", rationale: "real defect", operator: false });
  assert.equal(out.ok, true);
  const f = getFinding(id)!;
  assert.equal(f.disposition, "fix_now");
  assert.equal(f.decidedBy, "orchestrator");
  assert.equal(f.decidedCandidateSha, "cand111");
  assert.equal(f.dispositionRationale, "real defect");
  assert.equal(f.resolution, undefined, "disposition is not resolution — deciding to fix proves nothing");

  const events = eventsForRun(RUN.id).filter((e) => e.eventType === "review.finding_dispositioned");
  assert.equal(events.length, 1);
  const p = events[0]!.payload as { decidedBy: string; disposition: string; candidateSha: string };
  assert.deepEqual([p.disposition, p.decidedBy, p.candidateSha], ["fix_now", "orchestrator", "cand111"]);
});

test("FG-638: every disposition needs a rationale", () => {
  newReview();
  const id = ingestOne();
  const out = recordDisposition(id, { decision: "fix_now", rationale: "   ", operator: false });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /--rationale/);
  unchanged(id);
});

test("FG-638 / PRD #12: a threat-model-changing accepted_risk is refused without --operator, and writes nothing", () => {
  newReview();
  const id = ingestOne({ riskLens: "security", severity: "high" });
  assert.equal(acceptedRiskNeedsOperator(getFinding(id)!), true);

  const out = recordDisposition(id, { decision: "accepted_risk", rationale: "we accept it", operator: false });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /requires operator authority/);
  assert.match((out as { refusal: string }).refusal, /Nothing was written/);
  unchanged(id);
});

test("FG-638: a finding citing a protected invariant or acceptance criterion also needs operator authority", () => {
  newReview();
  const byInvariant = ingestOne({ invariantRef: "only forge publishes the target branch" });
  const byCriterion = ingestOne({ acceptanceRef: "FG-638 AC 4" });
  const byIntegrity = ingestOne({ findingType: "data_integrity" });
  const routine = ingestOne({ riskLens: "frontend", severity: "low" });

  assert.equal(acceptedRiskNeedsOperator(getFinding(byInvariant)!), true);
  assert.equal(acceptedRiskNeedsOperator(getFinding(byCriterion)!), true);
  assert.equal(acceptedRiskNeedsOperator(getFinding(byIntegrity)!), true);
  assert.equal(acceptedRiskNeedsOperator(getFinding(routine)!), false);

  assert.equal(recordDisposition(routine, { decision: "accepted_risk", rationale: "cosmetic", operator: false }).ok, true);
  assert.equal(getFinding(routine)!.decidedBy, "orchestrator");
});

test("FG-638: an authority-requiring accepted_risk with --operator persists decided_by operator + rationale + event", () => {
  newReview();
  const id = ingestOne({ riskLens: "security" });
  const out = recordDisposition(id, {
    decision: "accepted_risk",
    rationale: "threat model explicitly excludes a malicious operator",
    operator: true,
  });
  assert.equal(out.ok, true);
  const f = getFinding(id)!;
  assert.equal(f.decidedBy, "operator");
  assert.equal(f.dispositionRationale, "threat model explicitly excludes a malicious operator");

  const p = eventsForRun(RUN.id).find((e) => e.eventType === "review.finding_dispositioned")!.payload as {
    decidedBy: string;
    rationale: string;
  };
  assert.equal(p.decidedBy, "operator");
  assert.equal(p.rationale, "threat model explicitly excludes a malicious operator");
});

test("FG-638 / PRD #13: deferred without a durable destination is refused", () => {
  newReview();
  const id = ingestOne();
  const out = recordDisposition(id, { decision: "deferred", rationale: "later", operator: false });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /durable destination/);
  unchanged(id);
});

test("FG-638 / PRD #13: deferred to an UNKNOWN ticket needs operator authorization; to a known one it does not", () => {
  newReview();
  getDb()
    .prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, imported_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("pk-test", "FG-700", "story", "active", "an existing durable destination", "2026-07-30T00:00:00Z");

  const unknown = ingestOne();
  const refused = recordDisposition(unknown, {
    decision: "deferred",
    rationale: "later",
    operator: false,
    followupTicketId: "FG-999",
  });
  assert.equal(refused.ok, false);
  assert.match((refused as { refusal: string }).refusal, /not a ticket this store knows/);
  unchanged(unknown);

  const known = ingestOne();
  const ok = recordDisposition(known, {
    decision: "deferred",
    rationale: "tracked",
    operator: false,
    followupTicketId: "FG-700",
  });
  assert.equal(ok.ok, true);
  assert.equal(getFinding(known)!.followupTicketId, "FG-700");

  const authorized = ingestOne();
  assert.equal(
    recordDisposition(authorized, {
      decision: "deferred",
      rationale: "new ticket authorized at the CLI",
      operator: true,
      followupTicketId: "FG-1000",
    }).ok,
    true,
  );
  assert.equal(getFinding(authorized)!.decidedBy, "operator");
});

test("FG-638 / PRD #25: rejected_premise without candidate-bound disproving evidence cannot settle", () => {
  newReview();
  const id = ingestOne();

  const noEvidence = recordDisposition(id, {
    decision: "rejected_premise",
    rationale: "I read the code and disagree",
    operator: false,
  });
  assert.equal(noEvidence.ok, false);
  assert.match((noEvidence as { refusal: string }).refusal, /not a rationale alone/);
  unchanged(id);

  const badKind = recordDisposition(id, {
    decision: "rejected_premise",
    rationale: "disproved",
    operator: false,
    evidence: "I looked at it",
    evidenceKind: "vibes",
  });
  assert.equal(badKind.ok, false);
  assert.match((badKind as { refusal: string }).refusal, /--evidence-kind must be one of/);
  unchanged(id);

  // Structurally incomplete: a replay that names the command but not what it printed
  // is a claim that it was run, not proof of what it showed.
  const halfShaped = recordDisposition(id, {
    decision: "rejected_premise",
    rationale: "disproved",
    operator: false,
    evidence: JSON.stringify({ command: "node --test src/store/x.test.ts" }),
    evidenceKind: "replayed_command",
  });
  assert.equal(halfShaped.ok, false);
  assert.match((halfShaped as { refusal: string }).refusal, /missing or empty: output/);
  unchanged(id);

  const ok = recordDisposition(id, {
    decision: "rejected_premise",
    rationale: "the premise is disproved",
    operator: false,
    evidence: JSON.stringify({ command: "node --test src/store/x.test.ts", output: "12/12 pass" }),
    evidenceKind: "replayed_command",
  });
  assert.equal(ok.ok, true);
  const evidence = JSON.parse(getFinding(id)!.dispositionEvidence!) as {
    kind: string;
    candidateSha: string;
    detail: { command: string; output: string };
  };
  assert.equal(evidence.kind, "replayed_command");
  assert.equal(evidence.candidateSha, "cand111", "the evidence is BOUND to the candidate it was gathered against");
  assert.deepEqual(
    evidence.detail,
    { command: "node --test src/store/x.test.ts", output: "12/12 pass" },
    "the payload is stored STRUCTURED — a reader never re-parses free text to find what was run",
  );
});

test("FG-638: rejected_premise is refused when the review has no candidate to bind evidence to", () => {
  newReview("review-nosha", null);
  const [f] = ingestFindings("review-nosha", [{ summary: "unbindable" }]);
  const out = recordDisposition(f!.id, {
    decision: "rejected_premise",
    rationale: "disproved",
    operator: false,
    evidence: "ran it",
    evidenceKind: "replayed_command",
  });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /no candidate sha to bind it to/);
});

test("FG-638: duplicate without a canonical finding id is refused", () => {
  newReview();
  const id = ingestOne();
  const out = recordDisposition(id, { decision: "duplicate", rationale: "same thing", operator: false });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /must cite the canonical finding/);
  unchanged(id);

  const missing = recordDisposition(id, {
    decision: "duplicate",
    rationale: "same thing",
    operator: false,
    duplicateOf: "RF-404",
  });
  assert.equal(missing.ok, false);
  assert.match((missing as { refusal: string }).refusal, /no finding matches/);
  unchanged(id);
});

test("FG-638: the canonical finding absorbs the duplicate's sources as provenance", () => {
  newReview();
  const [canonical, dup] = ingestFindings("review-1", [
    { summary: "unsafe write", sources: [{ redRole: "red-wide", verdictId: "verdict-1" }] },
    { summary: "unsafe write, restated", sources: [{ redRole: "red-security", verdictId: "verdict-2" }] },
  ]);

  const out = recordDisposition(dup!.id, {
    decision: "duplicate",
    rationale: "same anchored mechanism as RF-1",
    operator: false,
    duplicateOf: "RF-1",
  });
  assert.equal(out.ok, true);

  assert.equal(getFinding(dup!.id)!.duplicateOf, canonical!.id);
  const merged = getFinding(canonical!.id)!.sources;
  assert.equal(merged.length, 2, "closing a duplicate must not lose a reviewer");
  assert.deepEqual(merged.map((s) => s.verdictId).sort(), ["verdict-1", "verdict-2"]);
});

test("FG-638: a finding cannot duplicate itself", () => {
  newReview();
  const [f] = ingestFindings("review-1", [{ summary: "lonely" }]);
  const out = recordDisposition(f!.id, {
    decision: "duplicate",
    rationale: "circular",
    operator: false,
    duplicateOf: "RF-1",
  });
  assert.equal(out.ok, false);
  assert.match((out as { refusal: string }).refusal, /cannot duplicate itself/);
});

test("FG-638: architecture_question is recordable and leaves the review unsettled", () => {
  newReview();
  const id = ingestOne();
  assert.equal(
    recordDisposition(id, { decision: "architecture_question", rationale: "changes the acceptance scope", operator: false }).ok,
    true,
  );
  const r = getReview("review-1")!;
  assert.equal(r.state, "awaiting_disposition");
  assert.equal(r.settledAt, undefined);
  assert.equal(summarizeReview("review-1")!.unsettledCount, 1, "an architecture question still counts as unsettled");
});

// ─── lookup + read projection ───────────────────────────────────────────────

test("FG-638: a bare RF-n that matches two reviews reports the ambiguity instead of guessing", () => {
  newReview("review-a");
  newReview("review-b");
  ingestFindings("review-a", [{ summary: "a" }]);
  ingestFindings("review-b", [{ summary: "b" }]);

  const ambiguous = lookupFinding("RF-1");
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(lookupFinding("RF-1", { reviewId: "review-b" }).kind, "found");
  assert.equal(lookupFinding("review-a/RF-1").kind, "found");
  assert.equal(lookupFinding("RF-9").kind, "not_found");
});

test("FG-638: summarizeReview projects lenses and counts by disposition and resolution", () => {
  newReview();
  ingestFindings("review-1", [{ summary: "one" }, { summary: "two" }, { summary: "three" }]);
  recordDisposition("review-1/RF-1", { decision: "fix_now", rationale: "fix", operator: false });
  recordDisposition("review-1/RF-2", { decision: "fix_now", rationale: "fix", operator: false });

  const s = summarizeReview("review-1")!;
  assert.deepEqual(s.riskLenses, ["wide", "security"]);
  assert.deepEqual(s.countsByDisposition, { fix_now: 2, untriaged: 1 });
  assert.deepEqual(s.countsByResolution, { unresolved: 3 });
  // Untriaged RF-3 AND both fix_now findings, whose fixes are not proven resolved.
  assert.equal(s.unsettledCount, 3);
  assert.equal(summarizeReview("review-absent"), undefined);
});
