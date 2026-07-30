// FG-640: the COMPLETE `review_disposition` condition matrix, driven through the real `gate()`.
//
// fg640-review-disposition-gate.test.ts proves the derivation over hand-built rows;
// fg640-gate-wiring.test.ts proves the wiring for a subset of conditions. Neither proves the
// matrix is COMPLETE at the entry point an operator actually reaches, and that gap is the one
// that rots: a fourteenth condition added to `assessReviewDisposition` with no route through
// `gate()` is a refusal nobody can trigger, and a condition quietly dropped from the enforcement
// path still passes every pure-function test that asserts it in isolation.
//
// So this file is a TABLE, not a pile of tests, and the table is checked against
// `DISPOSITION_GATE_CONDITIONS` itself:
//
//   - every blocking condition has at least one case that reaches it through `gate()`, against a
//     ledger written with the real store accessors;
//   - each case asserts the EXACT set of conditions the refusal names, so a case that starts
//     dragging a second condition along (or that stops isolating the one it is about) reddens;
//   - every explicit NON-blocking allowance has a case that ADVANCES through `gate()` — the
//     widened half of Change 3 is a claim about behavior, so it gets behavioral tests too, and
//     each also asserts the allowance is REPORTED rather than being a silent absence.
//
// The last test is the guard that keeps the file honest: the union of the table's condition ids
// must equal `DISPOSITION_GATE_CONDITIONS` exactly.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import {
  insertReview,
  ingestFindings,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
  updateReview,
  setReviewState,
  findingsForReview,
  reviewsForTask,
  reviewsForRun,
} from "../store/reviews.js";
import { gate } from "./gate.js";
import {
  DISPOSITION_GATE_CONDITIONS,
  assessEvidenceLedGate,
  type DispositionGateAllowance,
  type DispositionGateConditionId,
} from "./review-gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task, ReviewMode } from "../types/index.js";

const SHA = "cand640matrix";
const OLD_SHA = "cand639matrix";
const REVIEW = "review-matrix";
const TASK = "task-build";

const CONTRACT = {
  threat_model: "an evidence-led gate that can be talked past",
  protected_invariants: ["one review_mode per run"],
  acceptance_refs: ["FG-640 AC 18"],
  risk_lenses: ["backend", "security"],
  non_goals: [],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

/** Two evidence-led workflows: one fully migrated, one half-migrated (its red still declares
 *  blocking authority). Both published as one generation so `gate()`'s loader sees them. */
function writeWorkflows(): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  const body = (name: string, authority: string, gateOnVerdict: string) =>
    `name: ${name}
description: test
review_mode: evidence_led
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: ${authority}
        gate_on_verdict: ${gateOnVerdict}
      - agent: red-security
        authority: specialist
        gate_on_verdict: false
`;
  writeFileSync(join(homeDir, "workflows", "wf-el.yml"), body("wf-el", "specialist", "false"));
  writeFileSync(join(homeDir, "workflows", "wf-half.yml"), body("wf-half", "authoritative", "true"));
  publishFlatAsGeneration(homeDir);
}

function seedRun(workflow: string, reviewMode: ReviewMode): Run {
  const run: Run = {
    id: "run-matrix",
    workflow,
    title: "condition matrix",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    reviewMode,
  };
  insertRun(run);
  const task: Task = {
    id: TASK,
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: TASK, runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  return run;
}

function lensOutcome(lens: string, over: Record<string, unknown> = {}): unknown {
  return { lens, role: `red-${lens}`, complete: true, outcome: "pass", authored: true, findings: [], ...over };
}

function checks(over: Array<{ id: string; ok: boolean; detail: string }> = []): unknown[] {
  const base = [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "1 acceptance criterion met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
  return base.map((c) => over.find((o) => o.id === c.id) ?? c);
}

type LedgerOpts = {
  sha?: string;
  reviewMode?: ReviewMode;
  contract?: unknown;
  lensOutcomes?: unknown[];
  trusted?: string | null;
  verified?: boolean;
  shipping?: "green" | "unmet_ac" | "absent";
};

/** A ledger that is settled in every respect the gate reads. Each case breaks exactly one. */
function seedLedger(runId: string, opts: LedgerOpts = {}): void {
  const sha = opts.sha ?? SHA;
  insertReview({
    id: REVIEW,
    runId,
    subjectTaskId: TASK,
    ticketId: "FG-640",
    reviewMode: opts.reviewMode ?? "evidence_led",
    candidateSha: sha,
    contractConfirmedSha: sha,
    ...(opts.trusted === null ? {} : { trustedRemoteSha: opts.trusted ?? sha }),
    contract: opts.contract === undefined ? CONTRACT : opts.contract,
    lensOutcomes: opts.lensOutcomes ?? [lensOutcome("backend"), lensOutcome("security")],
    state: "shipping_review",
  });
  if (opts.verified !== false) {
    recordStageEvidence(REVIEW, "verified_final", { sha, detail: `green CI at ${sha}` });
  }
  if (opts.shipping !== "absent") {
    recordStageEvidence(REVIEW, "shipping", {
      sha,
      detail: "shipping",
      meta: {
        checks:
          opts.shipping === "unmet_ac"
            ? checks([{ id: "acceptance_mapped", ok: false, detail: "AC 18 unproven: the only evidence is a skipped test" }])
            : checks(),
      },
    });
  }
  setReviewState(REVIEW, opts.shipping === "green" || opts.shipping === undefined ? "settled" : "shipping_review");
}

/** Re-record everything a candidate move invalidates, at the NEW sha. Leaves candidate-bound
 *  FINDING evidence stale, which is the only thing the case using it is about. */
function resettle(sha: string): void {
  updateReview(REVIEW, { candidateSha: sha, trustedRemoteSha: sha, contractConfirmedSha: sha });
  recordStageEvidence(REVIEW, "verified_final", { sha, detail: `green CI at ${sha}` });
  recordStageEvidence(REVIEW, "shipping", { sha, detail: "shipping", meta: { checks: checks() } });
}

function authoritativeVerdict(): void {
  insertTask({
    id: "task-red",
    runId: "run-matrix",
    phase: "build",
    agentRole: "red-backend",
    status: "complete",
    taskPackage: { taskId: "task-red", runId: "run-matrix", phase: "build", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertVerdict({
    id: "v-authoritative",
    taskId: TASK,
    redTaskId: "task-red",
    redRole: "red-backend",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: true,
  });
}

function advisoryVerdict(id: string, role: string): void {
  const redTask = `task-${id}`;
  insertTask({
    id: redTask,
    runId: "run-matrix",
    phase: "build",
    agentRole: role,
    status: "complete",
    taskPackage: { taskId: redTask, runId: "run-matrix", phase: "build", role, inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertVerdict({
    id,
    taskId: TASK,
    redTaskId: redTask,
    redRole: role,
    verdict: "fail",
    confidence: 0.9,
    authority: "specialist",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: false,
  });
}

async function refusal(): Promise<string> {
  try {
    await gate(TASK, "advance", undefined, {});
    return "<no refusal>";
  } catch (e) {
    return (e as Error).message;
  }
}

/** The condition ids a refusal actually names, parsed from the rendered refusal an operator
 *  reads — not from the assessment object. The rendering is part of the contract. */
function namedConditions(msg: string): string[] {
  return [...msg.matchAll(/^ {2}- (\w+):/gm)].map((m) => m[1] as string).sort();
}

/** The assessment the gate would have made, read back off the same durable rows. Used only to
 *  assert the non-blocking half, which `gate()` reports by ADVANCING rather than by rendering. */
function allowanceIds(): string[] {
  const task = getTask(TASK)!;
  return assessEvidenceLedGate({
    taskId: TASK,
    reviews: reviewsForTask(TASK),
    runReviews: reviewsForRun(task.runId),
    findingsFor: findingsForReview,
    verdicts: verdictsForTask(TASK),
  })
    .assessment.nonBlocking.map((a) => a.id)
    .sort();
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-matrix-"));
  process.env.FORGE_HOME = homeDir;
  writeWorkflows();
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ── the blocking half: one case per condition, through the real gate() ────────

type BlockingCase = {
  /** The condition(s) this case must produce — EXACTLY, in the rendered refusal. */
  expect: DispositionGateConditionId[];
  title: string;
  detail?: RegExp;
  setup: () => void;
};

const BLOCKING: BlockingCase[] = [
  {
    expect: ["lens_outcome_missing"],
    title: "a selected lens has no reviewer-authored outcome",
    detail: /security \(no_outcome/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { lensOutcomes: [lensOutcome("backend")] });
    },
  },
  {
    expect: ["contract_unreadable"],
    title: "the review contract cannot be parsed, so no lens list can be established",
    detail: /risk_lenses/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { contract: { threat_model: "half a contract" } });
    },
  },
  {
    expect: ["finding_untriaged"],
    title: "a finding nobody has decided about",
    detail: /RF-1/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      ingestFindings(REVIEW, [{ summary: "a defect nobody decided about", severity: "high" }]);
    },
  },
  {
    expect: ["architecture_question_open"],
    title: "an open architecture question awaits the operator conversation",
    detail: /RF-1/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      const [f] = ingestFindings(REVIEW, [{ summary: "this changes the acceptance scope", severity: "high" }]);
      const out = recordDisposition(f!.id, {
        decision: "architecture_question",
        rationale: "the fix would change what the ticket promised",
        operator: false,
      });
      assert.equal(out.ok, true);
    },
  },
  {
    expect: ["rejected_premise_unproven"],
    title: "a rejected_premise whose disproving evidence is bound to a SUPERSEDED candidate",
    detail: new RegExp(`no candidate-bound disproving evidence at ${SHA}`),
    setup: () => {
      seedRun("wf-el", "evidence_led");
      // Decided at the old sha, with real candidate-bound evidence for THAT sha...
      seedLedger("run-matrix", { sha: OLD_SHA });
      const [f] = ingestFindings(REVIEW, [{ summary: "claims the reconcile path drops a write", severity: "high" }]);
      const out = recordDisposition(f!.id, {
        decision: "rejected_premise",
        rationale: "the premise does not hold at this candidate",
        operator: false,
        evidenceKind: "replayed_command",
        evidence: JSON.stringify({ command: "npm run typecheck", output: "no errors" }),
      });
      assert.equal(out.ok, true);
      // ...and then the candidate moves and everything else is re-established at it.
      resettle(SHA);
    },
  },
  {
    expect: ["fix_now_unresolved"],
    title: "a fix_now with no `resolved` recheck evidence at the current candidate",
    detail: /no recheck result/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      const [f] = ingestFindings(REVIEW, [{ summary: "a demonstrated data-loss path", severity: "high", reachability: "demonstrated" }]);
      recordDisposition(f!.id, { decision: "fix_now", rationale: "fix it", operator: false });
    },
  },
  {
    expect: ["fix_now_evidence_insufficient"],
    title: "a fix_now resolution weaker than the finding's original reachability requires",
    detail: /demonstrated resolved by bounded_inspection/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      const [f] = ingestFindings(REVIEW, [{ summary: "a demonstrated data-loss path", severity: "high", reachability: "demonstrated" }]);
      recordDisposition(f!.id, { decision: "fix_now", rationale: "fix it", operator: false });
      recordResolution(f!.id, {
        resolution: "resolved",
        evidenceKind: "bounded_inspection",
        evidence: "read the code and it looks right now",
        resolvedSha: SHA,
      });
    },
  },
  {
    expect: ["verification_absent_or_red"],
    title: "deterministic verification never ran at the final candidate",
    detail: /has not run at the final candidate/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { verified: false });
    },
  },
  {
    expect: ["acceptance_unmet"],
    title: "the shipping review reports an unmet/unproven acceptance criterion (PRD #17)",
    detail: /acceptance_mapped: AC 18 unproven/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { shipping: "unmet_ac" });
    },
  },
  {
    expect: ["acceptance_unmet"],
    title: "no shipping review has run at all — a clean ledger is not evidence the work was done",
    detail: /a ledger with no open findings is not evidence that the work was done/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { shipping: "absent" });
    },
  },
  {
    expect: ["tip_not_trusted"],
    title: "no fetched remote head is recorded, so tip trust is unestablished",
    detail: /fail closed/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { trusted: null });
    },
  },
  {
    expect: ["tip_not_trusted"],
    title: "the reviewed tip is an ANCESTOR of the remote head, not equal to it (FG-514)",
    detail: /is not equal to the fetched remote head/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { trusted: "remoteMoved777" });
    },
  },
  {
    expect: ["review_absent"],
    title: "an evidence-led step whose work has no ledger at all fails closed",
    detail: /an absent ledger is unestablished evidence, not a clean one/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
    },
  },
  {
    expect: ["mixed_authority_model"],
    title: "the step still DECLARES a blocking red, even though every red passed",
    detail: /the step still DECLARES blocking red\(s\) \(red-backend/,
    setup: () => {
      seedRun("wf-half", "evidence_led");
      seedLedger("run-matrix");
    },
  },
  {
    expect: ["mixed_authority_model"],
    title: "a verdict on the task still claims blocking authority under evidence_led",
    detail: /verdict\(s\) still claim blocking authority/,
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      authoritativeVerdict();
    },
  },
  {
    expect: ["review_mode_drift"],
    title: "the run row and its workflow disagree about the authority model",
    detail: /a run's authority model is fixed at creation/,
    setup: () => {
      // The run was created under a legacy workflow; the workflow file was migrated to
      // evidence_led afterwards, under a run already in flight.
      seedRun("wf-el", "legacy_verdict");
      seedLedger("run-matrix", { reviewMode: "legacy_verdict" });
    },
  },
];

for (const c of BLOCKING) {
  test(`FG-640 gate matrix blocks [${c.expect.join("+")}]: ${c.title}`, async () => {
    c.setup();
    const msg = await refusal();
    assert.match(msg, /gate kind 'review_disposition'/, `not the disposition gate: ${msg}`);
    assert.deepEqual(
      namedConditions(msg),
      [...c.expect].sort(),
      `the refusal must name exactly the condition(s) this case breaks — got:\n${msg}`,
    );
    if (c.detail) assert.match(msg, c.detail);
    assert.match(msg, /--force .* is NOT the ordinary settlement path/s);
    assert.equal(getTask(TASK)!.status, "awaiting_gate", "FG-585: no new task status was invented");
  });
}

test("FG-640: every blocking condition the gate defines has a case that reaches it through gate()", () => {
  const exercised = new Set(BLOCKING.flatMap((c) => c.expect));
  assert.deepEqual(
    [...exercised].sort(),
    [...DISPOSITION_GATE_CONDITIONS].sort(),
    "a condition with no enforcement-path case is a refusal nobody can trigger; one in the table but " +
      "not in the gate is a stale case",
  );
});

// ── the non-blocking half: each allowance ADVANCES through the real gate() ────

/** EXHAUSTIVE BY CONSTRUCTION. A `Record` keyed by the allowance union must list every member,
 *  so adding a fourth allowance to `review-gate.ts` makes this literal a type error until it is
 *  named here — and the test below then demands a case for it. */
const DECLARED_ALLOWANCES: Record<DispositionGateAllowance["id"], true> = {
  advisory_red_fail_dispositioned: true,
  settled_disposition: true,
  superseded_verdict: true,
};

type AllowanceCase = {
  id: DispositionGateAllowance["id"];
  title: string;
  setup: () => void;
};

const ALLOWANCES: AllowanceCase[] = [
  {
    id: "advisory_red_fail_dispositioned",
    title: "a raw advisory red `fail` whose findings are dispositioned does not block",
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      const [f] = ingestFindings(REVIEW, [{ summary: "the red-backend fail's finding", severity: "high" }]);
      recordDisposition(f!.id, {
        decision: "accepted_risk",
        rationale: "bounded blast radius, tracked in the ticket",
        operator: true,
      });
      advisoryVerdict("v-advisory-backend", "red-backend");
      advisoryVerdict("v-advisory-security", "red-security");
    },
  },
  {
    id: "settled_disposition",
    title: "settled accepted_risk / deferred / rejected_premise / duplicate do not block",
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix");
      const [a, b, c, d, e] = ingestFindings(REVIEW, [
        { summary: "accepted", severity: "low" },
        { summary: "deferred", severity: "low" },
        { summary: "premise rejected", severity: "high" },
        { summary: "the canonical one", severity: "low" },
        { summary: "a duplicate of the canonical one", severity: "low" },
      ]);
      recordDisposition(a!.id, { decision: "accepted_risk", rationale: "bounded", operator: true });
      recordDisposition(b!.id, {
        decision: "deferred",
        rationale: "survives this review in its own ticket",
        operator: true,
        followupTicketId: "FG-999",
      });
      recordDisposition(c!.id, {
        decision: "rejected_premise",
        rationale: "the premise does not hold",
        operator: false,
        evidenceKind: "replayed_command",
        evidence: JSON.stringify({ command: "npm run typecheck", output: "no errors" }),
      });
      recordDisposition(d!.id, { decision: "accepted_risk", rationale: "bounded", operator: true });
      recordDisposition(e!.id, {
        decision: "duplicate",
        rationale: "same mechanism as the canonical row",
        operator: false,
        duplicateOf: d!.id,
      });
    },
  },
  {
    id: "superseded_verdict",
    title: "a disposition decided against a superseded sha is a decision about the finding, not a claim about this tree",
    setup: () => {
      seedRun("wf-el", "evidence_led");
      seedLedger("run-matrix", { sha: OLD_SHA });
      const [f] = ingestFindings(REVIEW, [{ summary: "decided a candidate ago", severity: "low" }]);
      recordDisposition(f!.id, { decision: "accepted_risk", rationale: "bounded", operator: true });
      resettle(SHA);
    },
  },
];

for (const c of ALLOWANCES) {
  test(`FG-640 gate matrix does NOT block [${c.id}]: ${c.title}`, async () => {
    c.setup();
    // Reported explicitly — the widened half of Change 3 is visible in the same place the
    // narrowed half is, rather than being an absence a reader has to infer.
    assert.ok(
      allowanceIds().includes(c.id),
      `the assessment must REPORT '${c.id}'; got ${JSON.stringify(allowanceIds())}`,
    );
    const result = await gate(TASK, "advance", undefined, {});
    assert.equal(result.task.status, "complete", "the allowance must not block the real gate");
  });
}

test("FG-640: every allowance the gate defines has a case that ADVANCES through gate()", () => {
  assert.deepEqual(
    [...new Set(ALLOWANCES.map((c) => c.id))].sort(),
    Object.keys(DECLARED_ALLOWANCES).sort(),
    "an allowance with no advancing case is a 'we no longer block on this' claim nothing checks",
  );
});
