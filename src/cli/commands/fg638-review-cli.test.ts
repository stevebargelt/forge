// FG-638: the operator surfaces over the review ledger.
//
// Asserted on the HUMAN output, not only the JSON: the refusal an operator has to
// act on is the message printed to a terminal, and a JSON-only assertion cannot see
// a human surface that renders the wrong thing (or nothing at all).

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { insertReview, ingestFindings, getFinding } from "../../store/reviews.js";
import { registerReview } from "./review.js";
import { registerShow } from "./show.js";
import type { Run, Task } from "../../types/index.js";

const RUN: Run = {
  id: "run-fg638-cli",
  workflow: "feature",
  title: "review ledger CLI",
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

type Captured = { out: string; err: string };

async function runCli(register: (p: Command) => void, argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  mock.method(console, "log", (...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  mock.method(console, "error", (...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  try {
    const program = new Command();
    register(program);
    await program.parseAsync(argv, { from: "user" });
    return { out: out.join("\n"), err: err.join("\n") };
  } finally {
    mock.restoreAll();
  }
}

function seedReview(): void {
  insertReview({
    id: "review-cli",
    runId: RUN.id,
    subjectTaskId: "task-subject",
    ticketId: "FG-638",
    reviewMode: "evidence_led",
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: "cand111",
    trustedRemoteSha: "rem333",
    contract: { threat_model: "operator_trusted_candidate", risk_lenses: ["wide", "security"] },
    state: "awaiting_disposition",
  });
  ingestFindings("review-cli", [
    {
      summary: "unauthenticated write path",
      severity: "high",
      riskLens: "security",
      reachability: "demonstrated",
      file: "src/store/db.ts",
      line: 42,
      quotedText: "db.exec(sql)",
      invariantRef: "only forge publishes the target branch",
      sources: [
        { redRole: "red-security", verdictId: "verdict-1" },
        { redRole: "red-wide", verdictId: "verdict-2" },
      ],
    },
    { summary: "a routine nit", severity: "low", riskLens: "frontend", reachability: "speculative" },
  ]);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-subject"));
  seedReview();
  process.exitCode = undefined;
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  process.exitCode = undefined;
});

// ─── forge review show ──────────────────────────────────────────────────────

test("FG-638: `forge review show` renders the summary and every findings row for a human", async () => {
  const { out } = await runCli(registerReview, ["review", "show", "review-cli"]);

  assert.match(out, /^Review review-cli$/m);
  assert.match(out, /state:\s+awaiting_disposition/);
  assert.match(out, /review mode:\s+evidence_led/);
  assert.match(out, /ticket:\s+FG-638/);
  assert.match(out, /base sha:\s+base000/);
  assert.match(out, /contract confirmed:\s+conf222/);
  assert.match(out, /candidate sha:\s+cand111/);
  assert.match(out, /trusted remote sha:\s+rem333/);
  assert.match(out, /risk lenses:\s+wide, security/);
  assert.match(out, /dispositions:\s+untriaged 2/);
  assert.match(out, /unsettled findings: 2/);

  assert.match(out, /RF-1 \[high\/security\/demonstrated\] unauthenticated write path/);
  assert.match(out, /anchor: src\/store\/db\.ts:42 "db\.exec\(sql\)"/);
  assert.match(out, /invariant: only forge publishes the target branch/);
  assert.match(out, /sources: red-security \(verdict-1\), red-wide \(verdict-2\)/);
  assert.match(out, /disposition: untriaged/);
  assert.match(out, /RF-2 \[low\/frontend\/speculative\] a routine nit/);
});

test("FG-638: `forge review show --json` carries the same review and findings", async () => {
  const { out } = await runCli(registerReview, ["review", "show", "review-cli", "--json"]);
  const parsed = JSON.parse(out) as {
    review: { id: string; state: string; candidateSha: string };
    findings: { findingRef: string; sources: unknown[] }[];
    countsByDisposition: Record<string, number>;
  };
  assert.equal(parsed.review.id, "review-cli");
  assert.equal(parsed.review.candidateSha, "cand111");
  assert.deepEqual(parsed.findings.map((f) => f.findingRef), ["RF-1", "RF-2"]);
  assert.equal(parsed.findings[0]!.sources.length, 2);
  assert.deepEqual(parsed.countsByDisposition, { untriaged: 2 });
});

// ─── forge review disposition ───────────────────────────────────────────────

test("FG-638: a routine disposition records decided_by orchestrator and prints the decision", async () => {
  const { out } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-2", "fix_now", "--rationale", "small but real",
  ]);
  assert.equal(process.exitCode, undefined);
  assert.match(out, /RF-2 \(review-cli\/RF-2\): fix_now — decided by orchestrator at /);
  assert.match(out, /candidate sha: cand111/);
  assert.match(out, /rationale: small but real/);
  assert.equal(getFinding("review-cli/RF-2")!.decidedBy, "orchestrator");
});

test("FG-638 / PRD #12: an authority-changing accepted_risk WITHOUT --operator refuses, names the requirement, and writes nothing", async () => {
  const { err } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-1", "accepted_risk", "--rationale", "we will live with it",
  ]);

  assert.equal(process.exitCode, 1);
  assert.match(err, /requires operator authority/);
  assert.match(err, /--operator/);
  assert.match(err, /Nothing was written/);

  const f = getFinding("review-cli/RF-1")!;
  assert.equal(f.disposition, "untriaged");
  assert.equal(f.decidedBy, undefined);
  const events = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'review.finding_dispositioned'`)
    .get() as { n: number };
  assert.equal(events.n, 0, "the refusal must not leave an audit event either");
});

test("FG-638: the same accepted_risk WITH --operator persists decided_by operator", async () => {
  const { out } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-1", "accepted_risk",
    "--rationale", "the threat model excludes this", "--operator",
  ]);
  assert.equal(process.exitCode, undefined);
  assert.match(out, /accepted_risk — decided by operator at /);
  assert.equal(getFinding("review-cli/RF-1")!.decidedBy, "operator");
});

test("FG-638 / PRD #25: rejected_premise without candidate-bound evidence is refused at the CLI", async () => {
  const { err } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-2", "rejected_premise", "--rationale", "I disagree",
  ]);
  assert.equal(process.exitCode, 1);
  assert.match(err, /not a rationale alone/);
  assert.equal(getFinding("review-cli/RF-2")!.disposition, "untriaged");
});

test("FG-638 / PRD #13: deferred without a durable destination is refused at the CLI", async () => {
  const { err } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-2", "deferred", "--rationale", "later",
  ]);
  assert.equal(process.exitCode, 1);
  assert.match(err, /durable destination/);
  assert.equal(getFinding("review-cli/RF-2")!.disposition, "untriaged");
});

test("FG-638: duplicate without a canonical id is refused; with one, the canonical absorbs the sources", async () => {
  const refused = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-2", "duplicate", "--rationale", "same as the other",
  ]);
  assert.equal(process.exitCode, 1);
  assert.match(refused.err, /must cite the canonical finding/);
  process.exitCode = undefined;

  const ok = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-2", "duplicate",
    "--rationale", "same anchored mechanism", "--duplicate-of", "RF-1", "--review", "review-cli",
  ]);
  assert.equal(process.exitCode, undefined);
  assert.match(ok.out, /canonical RF-1 now carries 2 source\(s\)/);
  assert.equal(getFinding("review-cli/RF-2")!.duplicateOf, "review-cli/RF-1");
});

test("FG-638: an unknown decision verb is refused before anything is looked up", async () => {
  const { err } = await runCli(registerReview, [
    "review", "disposition", "review-cli/RF-1", "wont_fix", "--rationale", "nope",
  ]);
  assert.equal(process.exitCode, 1);
  assert.match(err, /decision must be one of/);
  assert.equal(getFinding("review-cli/RF-1")!.disposition, "untriaged");
});

// ─── forge show integration ─────────────────────────────────────────────────

test("FG-638: `forge show <run>` names the run's review mode and lists its ledger", async () => {
  const { out } = await runCli(registerShow, ["show", RUN.id]);
  assert.match(out, /review:\s+evidence_led/);
  assert.match(out, /^Review ledger:$/m);
  assert.match(out, /review-cli\s+awaiting_disposition\s+candidate cand111/);
  assert.match(out, /findings: 2 \(untriaged 2\)/);
  assert.match(out, /forge review show review-cli/);
});

test("FG-638: after a never-marked run adopts its first review's mode, both read surfaces agree — human and JSON", async () => {
  // The run is written exactly as a pre-FG-638 binary wrote one: no review_mode, so
  // it reads the column DEFAULT. Its first ledger review marks it, and from then on
  // `forge show` (the run's view) and `forge review show` (the review's view) are two
  // renders of ONE fact rather than two records that can drift apart.
  insertRun({ id: "run-adopting", workflow: "feature", title: "never marked", status: "active", createdAt: "2026-07-30T00:00:00Z" });
  insertTask({
    id: "task-adopting",
    runId: "run-adopting",
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: "task-adopting", runId: "run-adopting", phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertReview({
    id: "review-adopting",
    runId: "run-adopting",
    subjectTaskId: "task-adopting",
    reviewMode: "evidence_led",
    candidateSha: "candadopt",
    state: "awaiting_disposition",
  });

  const runHuman = await runCli(registerShow, ["show", "run-adopting"]);
  assert.match(runHuman.out, /review:\s+evidence_led/, "forge show must report the mode the run ADOPTED, not the default it was created with");
  const reviewHuman = await runCli(registerReview, ["review", "show", "review-adopting"]);
  assert.match(reviewHuman.out, /review mode:\s+evidence_led/);

  const runJson = JSON.parse((await runCli(registerShow, ["show", "run-adopting", "--json"])).out) as {
    run: { reviewMode: string };
    diagnostic: { reviewLedger: { review: { reviewMode: string } }[] };
  };
  const reviewJson = JSON.parse((await runCli(registerReview, ["review", "show", "review-adopting", "--json"])).out) as {
    review: { reviewMode: string };
  };
  assert.deepEqual(
    [runJson.run.reviewMode, runJson.diagnostic.reviewLedger[0]!.review.reviewMode, reviewJson.review.reviewMode],
    ["evidence_led", "evidence_led", "evidence_led"],
    "the run row, the ledger projection inside forge show, and forge review show must all name one review_mode",
  );
});

test("FG-638: `forge show <run> --json` carries the ledger alongside the raw verdict summary", async () => {
  const { out } = await runCli(registerShow, ["show", RUN.id, "--json"]);
  const parsed = JSON.parse(out) as {
    run: { reviewMode: string };
    diagnostic: { reviewLedger: { review: { id: string }; findings: unknown[] }[] };
  };
  assert.equal(parsed.run.reviewMode, "evidence_led");
  assert.equal(parsed.diagnostic.reviewLedger.length, 1);
  assert.equal(parsed.diagnostic.reviewLedger[0]!.review.id, "review-cli");
  assert.equal(parsed.diagnostic.reviewLedger[0]!.findings.length, 2);
});
