// FG-640: an absent lens clears by exactly three routes, and dispositioning is not one of them.
//
// The ticket, the orchestrator seed and `assessDiscoveryCompleteness`'s own doc comment all state
// the same rule: "An absent lens is cleared only by retrying it, amending the contract through its
// approving authority, or an authorized risk acceptance that NAMES the missing evidence — never by
// dispositioning some other finding."
//
// That is a claim about the GATE, not about a helper, so it is tested at the gate. The negative
// half matters more than the positive: `lens_outcome_missing` and `finding_untriaged` are separate
// conditions, and the failure mode the rule exists to prevent is a review that looks settled
// because someone decided the findings a *different* lens produced.
//
// THE THIRD ROUTE IS NOT MECHANISED, and this file pins that rather than papering over it. There
// is no writer that records an authorized acceptance against a NAMED LENS — `recordDisposition`
// only ever decides a finding, and `assessDiscoveryCompleteness` reads `lensOutcomes` alone. So an
// operator who accepts the missing evidence today clears the gate with `forge gate --force
// --rationale`, which is the human override the refusal explicitly calls "NOT the ordinary
// settlement path". The last two tests below are that behavior, written down: if a
// lens-acceptance writer ever lands, the `accepted_risk` test is the one that must change.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import {
  insertReview,
  ingestFindings,
  recordDisposition,
  recordStageEvidence,
  updateReview,
  setReviewState,
} from "../store/reviews.js";
import { gate } from "./gate.js";
import { confirmContract, validateReviewContract } from "./review-contract.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task } from "../types/index.js";

const SHA = "cand640lens";
const REVIEW = "review-lens";
const TASK = "task-build";

const CONTRACT = {
  threat_model: "an unreviewed surface that reads clean",
  protected_invariants: ["discovery is complete or it is incomplete"],
  acceptance_refs: ["FG-640 AC 21"],
  risk_lenses: ["backend", "security"],
  non_goals: [],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function writeWorkflow(): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", "wf-el.yml"),
    `name: wf-el
description: test
review_mode: evidence_led
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: specialist
        gate_on_verdict: false
      - agent: red-security
        authority: specialist
        gate_on_verdict: false
`,
  );
  publishFlatAsGeneration(homeDir);
}

function authored(lens: string): unknown {
  return { lens, role: `red-${lens}`, complete: true, outcome: "pass", authored: true, findings: [] };
}

const CRASHED_SECURITY = {
  lens: "security",
  role: "red-security",
  complete: false,
  reason: "crashed",
  detail: "the security lens did not produce a review (container_crash)",
};

function checks(): unknown[] {
  return [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "1 acceptance criterion met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
}

/** Settled in every respect EXCEPT that the security lens crashed. */
function seedWorldWithCrashedLens(): void {
  const run: Run = {
    id: "run-lens",
    workflow: "wf-el",
    title: "absent lens",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    reviewMode: "evidence_led",
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
  insertReview({
    id: REVIEW,
    runId: run.id,
    subjectTaskId: TASK,
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    lensOutcomes: [authored("backend"), CRASHED_SECURITY],
    state: "discovering",
  });
  recordStageEvidence(REVIEW, "verified_final", { sha: SHA, detail: `green CI at ${SHA}` });
  recordStageEvidence(REVIEW, "shipping", { sha: SHA, detail: "shipping", meta: { checks: checks() } });
  setReviewState(REVIEW, "shipping_review");
}

async function refusal(): Promise<string> {
  try {
    await gate(TASK, "advance", undefined, {});
    return "<no refusal>";
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-lens-"));
  process.env.FORGE_HOME = homeDir;
  writeWorkflow();
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  seedWorldWithCrashedLens();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

test("FG-640 / PRD #21: the crashed lens is the ONLY thing blocking — the rest of the ledger is settled", async () => {
  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(crashed/);
  // If any other condition were also open, the tests below could clear the lens and still see a
  // refusal, and "dispositioning does not clear it" would pass for the wrong reason.
  assert.deepEqual([...msg.matchAll(/^ {2}- (\w+):/gm)].map((m) => m[1]), ["lens_outcome_missing"]);
});

// ── the route that must NOT clear it ─────────────────────────────────────────

test("FG-640: dispositioning findings the OTHER lens produced never clears the absent lens", async () => {
  const findings = ingestFindings(REVIEW, [
    { summary: "the backend lens found a race", severity: "high", riskLens: "backend" },
    { summary: "the backend lens found a leak", severity: "medium", riskLens: "backend" },
  ]);
  for (const f of findings) {
    const out = recordDisposition(f.id, {
      decision: "accepted_risk",
      rationale: "bounded blast radius, tracked in the ticket",
      operator: true,
    });
    assert.equal(out.ok, true);
  }

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/, "settling every OTHER finding says nothing about the lens that never ran");
  assert.doesNotMatch(msg, /finding_untriaged/, "the dispositions DID settle the findings — that half worked");
  assert.equal(getTask(TASK)!.status, "awaiting_gate");
});

test("FG-640: an accepted_risk finding that NAMES the missing lens still does not clear it today", async () => {
  // The rule's third route — "an authorized risk acceptance that NAMES the missing evidence" — has
  // no writer: `recordDisposition` decides FINDINGS, and completeness is derived from
  // `lensOutcomes` alone. So even the most explicit possible acceptance leaves the gate blocked,
  // and `--force` is what an operator is actually left with. Pinned, not asserted as correct.
  const [f] = ingestFindings(REVIEW, [
    {
      summary: "the security lens crashed and its evidence is accepted as missing for this candidate",
      severity: "unknown",
      riskLens: "security",
      findingType: "lens_missing_evidence",
    },
  ]);
  const out = recordDisposition(f!.id, {
    decision: "accepted_risk",
    rationale: "the security surface is untouched by this diff; accepting the missing security lens evidence",
    operator: true,
  });
  assert.equal(out.ok, true, "the acceptance itself is recordable — it just is not a lens outcome");

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(crashed/);

  // And the only route left is the explicit human override the refusal names.
  const forced = await gate(TASK, "advance", "operator accepts the missing security lens evidence", { force: true });
  assert.equal(forced.task.status, "complete");
});

// ── route 1: retry the lens ──────────────────────────────────────────────────

test("FG-640: RETRYING the lens clears it — a reviewer-authored outcome is what was owed", async () => {
  updateReview(REVIEW, { lensOutcomes: [authored("backend"), authored("security")] });
  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640: a retry that came back SYNTHESIZED does not clear it — forge did not author it", async () => {
  updateReview(REVIEW, {
    lensOutcomes: [
      authored("backend"),
      CRASHED_SECURITY,
      {
        lens: "security",
        role: "red-security",
        complete: false,
        reason: "synthesized",
        detail: "forge synthesized this verdict, no reviewer authored it",
      },
    ],
  });
  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(synthesized/, "the LATEST attempt is what the refusal reports");
});

test("FG-640: a retry that came back INCONCLUSIVE clears the lens but lands as a finding to disposition", async () => {
  // PRD #22's first half, reached from the crash: an authored inconclusive IS a completed outcome.
  updateReview(REVIEW, {
    lensOutcomes: [
      authored("backend"),
      {
        lens: "security",
        role: "red-security",
        complete: true,
        outcome: "inconclusive",
        authored: true,
        inconclusiveReason: "could not reach the auth path from the diff",
        findings: [],
      },
    ],
  });
  ingestFindings(REVIEW, [
    { summary: "security lens returned inconclusive: could not reach the auth path", findingType: "lens_inconclusive" },
  ]);

  const msg = await refusal();
  assert.doesNotMatch(msg, /lens_outcome_missing/, "the lens is no longer absent");
  assert.match(msg, /finding_untriaged/, "but the inconclusive is evidence that must be dispositioned by name");
});

// ── route 2: amend the contract through its approving authority ──────────────

test("FG-640: AMENDING the contract to drop the lens clears it — the panel is what the contract selects", async () => {
  const amended = { ...CONTRACT, risk_lenses: ["backend"] };
  updateReview(REVIEW, { contract: amended });
  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640: the COORDINATOR cannot make that amendment — a removal returns to the approving authority", () => {
  // The amendment above is legitimate only because an approving authority made it. The
  // coordinator's own confirmation path refuses the identical change, which is what keeps
  // "amend the contract" from collapsing into "the coordinator narrows its own review".
  const approved = validateReviewContract(CONTRACT);
  assert.equal(approved.ok, true);
  const confirmation = confirmContract(approved.ok ? approved.contract : (undefined as never), {
    contract: { ...CONTRACT, risk_lenses: ["backend"] },
    candidateSha: SHA,
    changedPaths: ["src/v2/gate.ts"],
  });
  assert.equal(confirmation.kind, "needs_approving_authority");
  if (confirmation.kind === "needs_approving_authority") {
    assert.deepEqual(confirmation.removedLenses, ["security"]);
    assert.match(confirmation.refusal, /the coordinator may only ADD lenses/);
    assert.match(confirmation.refusal, /Nothing was written/);
  }
});

test("FG-640: an amendment that drops the lens but also rewrites the threat model is still refused", () => {
  const approved = validateReviewContract(CONTRACT);
  assert.equal(approved.ok, true);
  const confirmation = confirmContract(approved.ok ? approved.contract : (undefined as never), {
    contract: { ...CONTRACT, risk_lenses: ["backend"], threat_model: "nothing much, really" },
    candidateSha: SHA,
  });
  assert.equal(confirmation.kind, "needs_approving_authority");
  if (confirmation.kind === "needs_approving_authority") {
    assert.deepEqual(confirmation.changedFields, ["threat_model"]);
  }
});
