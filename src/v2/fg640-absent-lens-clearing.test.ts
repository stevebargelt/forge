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
// THE THIRD ROUTE IS `forge review accept-lens`, and the distinction it has to hold is between
// accepting a LENS's missing evidence and dispositioning a FINDING. `recordDisposition` decides
// findings and can never clear a lens — not even an `accepted_risk` whose text names the missing
// lens by hand. `recordLensAcceptance` writes an operator-authorized record against the NAMED
// lens, naming what was not reviewed, bound to the confirmed candidate, and
// `assessDiscoveryCompleteness` consults it. Both halves are tested here: the route that clears
// the lens, and the routes that must never be able to.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import {
  insertReview,
  getReview,
  ingestFindings,
  lensAcceptancesOf,
  recordDisposition,
  recordLensAcceptance,
  recordStageEvidence,
  summarizeReview,
  updateReview,
  setReviewState,
} from "../store/reviews.js";
import { renderReview } from "../cli/commands/review.js";
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
  lens_scopes: { backend: ["src/v2/review-discovery.ts"], security: ["src/store/reviews.ts"] },
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

test("FG-640: an accepted_risk FINDING that names the missing lens still does not clear it — a disposition decides findings", async () => {
  // The distinction the third route has to hold. Even the most explicit possible finding-level
  // acceptance is a decision about a FINDING; the lens it talks about is still a lens no
  // reviewer looked through, so completeness is unmoved.
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
  assert.equal(out.ok, true, "the disposition itself is recordable — it just is not a lens acceptance");

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(crashed/);
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
  const amended = { ...CONTRACT, risk_lenses: ["backend"], lens_scopes: { backend: CONTRACT.lens_scopes.backend } };
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
    contract: { ...CONTRACT, risk_lenses: ["backend"], lens_scopes: { backend: CONTRACT.lens_scopes.backend } },
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

// ── route 3: an authorized acceptance that NAMES the missing evidence ────────

function acceptSecurity(over: Partial<Parameters<typeof recordLensAcceptance>[1]> = {}) {
  return recordLensAcceptance(REVIEW, {
    lens: "security",
    missingEvidence: "no security review of the new auth-path guard at src/v2/gate.ts:158",
    rationale: "the diff is confined to gate wiring; the auth path is unchanged and covered by FG-638's tests",
    operator: true,
    ...over,
  });
}

test("FG-640: an operator ACCEPTANCE against the named lens clears it — the step advances with no --force", async () => {
  const out = acceptSecurity();
  assert.equal(out.ok, true, out.ok ? "" : out.refusal);

  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640: the acceptance requires OPERATOR authority — it narrows the coverage the contract states", async () => {
  const out = acceptSecurity({ operator: false });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.refusal, /requires operator authority/);
    assert.match(out.refusal, /Nothing was written/);
  }
  assert.match(await refusal(), /lens_outcome_missing/, "a refused acceptance leaves the gate exactly as it was");
});

test("FG-640: an acceptance that does not NAME the missing evidence is refused — that is what --force already is", async () => {
  const unnamed = acceptSecurity({ missingEvidence: "   " });
  assert.equal(unnamed.ok, false);
  if (!unnamed.ok) assert.match(unnamed.refusal, /must NAME the missing evidence/);

  const unreasoned = acceptSecurity({ rationale: "" });
  assert.equal(unreasoned.ok, false);
  if (!unreasoned.ok) assert.match(unreasoned.refusal, /must record why/);

  assert.match(await refusal(), /lens_outcome_missing/);
});

test("FG-640: a lens the contract never selected has no missing evidence to accept", () => {
  const out = recordLensAcceptance(REVIEW, {
    lens: "frontend",
    missingEvidence: "no frontend review",
    rationale: "there is no UI in this diff",
    operator: true,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.refusal, /not a lens this review's contract selected \(backend, security\)/);
});

test("FG-640: accepting one lens says nothing about another — the acceptance is per NAMED lens", async () => {
  updateReview(REVIEW, {
    lensOutcomes: [
      { lens: "backend", role: "red-backend", complete: false, reason: "crashed", detail: "the backend lens did not produce a review (container_crash)" },
      CRASHED_SECURITY,
    ],
  });
  assert.equal(acceptSecurity().ok, true);

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /backend \(crashed/);
  assert.doesNotMatch(msg, /security \(crashed/, "the accepted lens is cleared; the other one is not");
});

test("FG-640: an acceptance recorded against a SUPERSEDED candidate does not clear the lens", async () => {
  assert.equal(acceptSecurity().ok, true);
  // The contract is re-confirmed at a new candidate: the outcomes recorded at the old one are
  // history, and so is an acceptance that stood in for one of them.
  updateReview(REVIEW, { contractConfirmedSha: "cand640lens2", candidateSha: "cand640lens2" });

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /an authorized acceptance of this lens exists at cand640lens/);
  assert.match(msg, /accept it again at the current candidate or retry the lens/);
});

test("FG-640: an acceptance is bound to the CONFIRMED candidate — a confirmation that lands at another sha does not clear it", async () => {
  // The other direction of the same binding, and the one the removed `?? candidateSha`
  // fallback used to blur: the acceptance was recorded at confirmation sha X, and the
  // confirmation later lands at Y while the candidate row still reads X. Reading anything but
  // the confirmed sha here would clear a lens against a confirmation that no longer stands.
  assert.equal(acceptSecurity().ok, true);
  updateReview(REVIEW, { contractConfirmedSha: "cand640lens-Y" });

  const msg = await refusal();
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /an authorized acceptance of this lens exists at cand640lens,/);
});

test("FG-640: an acceptance BEFORE contract confirmation is refused by name — there is no confirmed candidate to bind to", () => {
  // The same review, one stage earlier: a candidate exists, but the contract has not been
  // confirmed against the final diff, so no lens has yet been dispatched at any sha. An
  // acceptance here would stand in for a discovery outcome nobody could have owed.
  insertReview({
    id: "review-unconfirmed",
    runId: "run-lens",
    subjectTaskId: TASK,
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    candidateSha: SHA,
    contract: CONTRACT,
    state: "confirming_contract",
  });
  const out = recordLensAcceptance("review-unconfirmed", {
    lens: "security",
    missingEvidence: "no security review of the new auth-path guard",
    rationale: "accepting early",
    operator: true,
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.refusal, /no CONFIRMED candidate to bind the acceptance to/);
    assert.match(out.refusal, /Nothing was written/);
  }
  assert.deepEqual(lensAcceptancesOf(getReview("review-unconfirmed")!), []);
});

test("FG-640: the acceptance is on the operator's read surfaces and in the audit trail", () => {
  assert.equal(acceptSecurity().ok, true);

  const summary = summarizeReview(REVIEW)!;
  assert.equal(summary.lensAcceptances.length, 1);
  assert.equal(summary.lensAcceptances[0]!.lens, "security");
  assert.equal(summary.lensAcceptances[0]!.acceptedBy, "operator");

  const human = renderReview(summary);
  assert.match(human, /lens accepted:\s+security — missing evidence: no security review of the new auth-path guard/);
  assert.match(human, /rationale: the diff is confined to gate wiring/);
  assert.match(human, /candidate cand640lens/);

  const event = getDb()
    .prepare(`SELECT payload FROM events WHERE event_type = 'review.lens_accepted'`)
    .get() as { payload: string } | undefined;
  assert.ok(event, "an acceptance is part of the append-only half of the ledger, not only a row");
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  assert.equal(payload.lens, "security");
  assert.equal(payload.acceptedBy, "operator");
  assert.equal(payload.candidateSha, SHA);
  assert.match(String(payload.missingEvidence), /auth-path guard/);
});

test("FG-640: a re-dispatched discovery does not erase the acceptance", () => {
  // `runDiscovery` rewrites lensOutcomes wholesale on every retry. An operator decision must
  // survive a retry that crashed again, or the third route would quietly need re-doing.
  assert.equal(acceptSecurity().ok, true);
  const outcomes = [authored("backend"), CRASHED_SECURITY];
  updateReview(REVIEW, { lensOutcomes: [...lensAcceptancesOf(getReview(REVIEW)!), ...outcomes] });

  assert.equal(lensAcceptancesOf(getReview(REVIEW)!).length, 1);
});

test("FG-640: an amendment that drops the lens but also rewrites the threat model is still refused", () => {
  const approved = validateReviewContract(CONTRACT);
  assert.equal(approved.ok, true);
  const confirmation = confirmContract(approved.ok ? approved.contract : (undefined as never), {
    contract: {
      ...CONTRACT,
      risk_lenses: ["backend"],
      lens_scopes: { backend: CONTRACT.lens_scopes.backend },
      threat_model: "nothing much, really",
    },
    candidateSha: SHA,
  });
  assert.equal(confirmation.kind, "needs_approving_authority");
  if (confirmation.kind === "needs_approving_authority") {
    assert.deepEqual(confirmation.changedFields, ["threat_model"]);
  }
});
