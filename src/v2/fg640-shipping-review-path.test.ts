// FG-640 / PRD #17: a shipping review cannot pass with an unmet or unproven acceptance
// criterion, EVEN WHEN THE LEDGER HAS NO OPEN FINDINGS — proved along the real shipping path.
//
// The pure-function half is already covered twice: `assessShippingReview` downgrades a `met`
// claim whose only evidence is a skipped test (review-run.test.ts), and
// `assessReviewDisposition` blocks on a shipping record whose `acceptance_mapped` check is
// false (fg640-review-disposition-gate.test.ts). Neither joins the two, and the join is the
// scenario: the ONLY thing that connects an unproven AC to a withheld gate is that Stage 9
// refuses and therefore RECORDS NOTHING, leaving `acceptance_unmet` derivable from the absence
// of a shipping record at the candidate. A change that made the shipping stage record its
// assessment unconditionally would keep both existing suites green and let #17 through.
//
// So this file drives the REAL coordinator (`runNextStage`, every container and git effect
// injected through the existing `CoordinatorDeps` seam) from a fresh review all the way to
// Stage 9, and then asks the REAL `gate()` what it thinks. Nothing about the ledger is
// hand-written: the findings, the stage records and the trusted remote head are all whatever the
// stages actually wrote.
//
// Also here, because they only exist on this path:
//   - a free-form finding raised DURING the shipping review holds the gate as an ordinary
//     untriaged finding, and lateness confers no authority to settle it (FG-640 duty 6 / the
//     late-findings rule);
//   - an untrusted tip records no remote head, so the gate stays blocked on `tip_not_trusted`
//     rather than on a head the review never matched.

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
  findingsForReview,
  getReview,
  insertReview,
  markDocsDispatchDelivered,
  openDocsDispatch,
  recordDisposition,
} from "../store/reviews.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { fakeReviewDiff } from "./review-diff.testkit.js";
import { gate } from "./gate.js";
import type { AcClaim } from "./review-evidence.js";
import type { TipTrustState } from "./review-shipping.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task } from "../types/index.js";

const RUN_ID = "run-ship";
const REVIEW = "review-ship";
const TASK = "task-build";
const SHA = "candship1";
const AC_TEST = "the disposition gate withholds on an unproven acceptance criterion";
const EXECUTED = `ok 1 - ${AC_TEST}`;
const SKIPPED = `ok 1 - ${AC_TEST} # SKIP no fixture in this lane`;

const CONTRACT = {
  threat_model: "a clean ledger standing in for evidence that the work was done",
  protected_invariants: ["a clean ledger is not a proof"],
  acceptance_refs: ["FG-640 AC 17"],
  risk_lenses: ["backend"],
  non_goals: [],
  lens_scopes: { backend: ["src/v2/review-gate.ts"] },
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function writeWorkflow(): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", "wf-ship.yml"),
    `name: wf-ship
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
`,
  );
  publishFlatAsGeneration(homeDir);
}

type ShippingOverrides = {
  /** The acceptance claim the shipping reviewer maps. Defaults to a met-on-executed-evidence one. */
  acceptance?: AcClaim[];
  tipTrust?: TipTrustState;
  newFindings?: { summary: string }[];
};

/** Every side effect injected, exactly as review-run.test.ts does. Discovery finds NOTHING, so
 *  the ledger reaches Stage 9 with zero findings — which is the whole point of #17. */
/** FG-655: the durable docs-dispatch binding a stubbed `dispatchDocs` must create, exactly as
 *  the real wiring does — the row exists before the dispatch, and the host-minted task
 *  identity is written onto it. The re-entry short-circuit reads this row, so a stub that
 *  returned a binding the store does not hold would be a stub that cannot be re-entered. */
function docsBinding(reviewId: string, candidateSha: string, taskId = "task-docs-1") {
  const opened = openDocsDispatch(reviewId, candidateSha);
  return markDocsDispatchDelivered(opened.id, { taskId });
}

function deps(over: ShippingOverrides = {}): CoordinatorDeps {
  return {
    headSha: () => SHA,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    // FG-689 AC2: the rendered path is the one CONTRACT's backend scope owns. The fixture used
    // to name `src/v2/gate.ts` while the scope named `src/v2/review-gate.ts`, which nothing
    // compared until the coverage check existed.
    reviewDiff: fakeReviewDiff(["src/v2/review-gate.ts"]),
    // FG-689 RF-1: an explicit ZERO dispatch envelope — this harness is not exercising the
    // composed-input reserve, and an ABSENT measurement refuses by design.
    measureLensEnvelope: () => 0,
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx) => ({
      lens: ctx.lens,
      role: ctx.role,
      dispatched: true,
      taskId: `task-${ctx.lens}`,
      result: { outcome: "pass", findings: [] },
    }),
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: () => ({ ok: true, taskId: "task-fixer", result: {} }),
    // FG-649: Stage 5 owns the fix-cycle commit. This path has no findings, so it is never
    // reached — a no-change commit at the one sha this fixture has is the only honest stub.
    commitFixCycle: () => ({ kind: "no_change", sha: SHA }),
    // FG-655: the docs stage binds its dispatch durably and commits what the agent DECLARED.
    // This fixture's docs agent declares nothing and leaves a clean tree — the legitimate
    // no-op, which records candidate-unchanged.
    dispatchDocs: ({ review, candidateSha }) => ({ ok: true, binding: docsBinding(review.id, candidateSha) }),
    docsDelivery: ({ binding }) => ({ kind: "delivered", taskId: binding.taskId ?? "task-docs", docsUpdated: [] }),
    commitDocsCycle: () => ({ kind: "no_change", sha: SHA }),
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: "task-recheck",
      result: { review_id: ctx.review.id, candidate_sha: ctx.candidateSha, rechecked: [], new_findings: [] },
    }),
    shippingInput: ({ candidateSha }) => ({
      verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
      acceptance: over.acceptance ?? [
        {
          ref: "FG-640 AC 17",
          verdict: "met",
          evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
        },
      ],
      tipTrust: over.tipTrust ?? { kind: "trusted", reviewedSha: candidateSha, remoteSha: candidateSha },
      identity: { continuous: true, detail: "identity continuous" },
      contractCoverage: {
        confirmedSha: getReview(REVIEW)?.contractConfirmedSha ?? candidateSha,
        finalSha: candidateSha,
        postConfirmationPaths: [],
        deltaReviewed: true,
      },
      docsCloseout: { assessed: true, gaps: [], detail: "the ticket requires no doc update" },
      ...(over.newFindings !== undefined ? { newFindings: over.newFindings } : {}),
    }),
  };
}

/** Drive stages until Stage 9 has been ATTEMPTED, and return its outcome. Every earlier stage
 *  must advance — a review that stalls before shipping proves nothing about shipping. */
async function driveToShipping(d: CoordinatorDeps): Promise<{ status: string; message: string }> {
  for (let i = 0; i < 12; i++) {
    const outcome = await runNextStage(REVIEW, d);
    if (outcome.transition.kind === "shipping_review") return { status: outcome.status, message: outcome.message };
    assert.equal(
      outcome.status,
      "advanced",
      `stage ${outcome.transition.kind} did not advance on the way to shipping: ${outcome.message}`,
    );
  }
  assert.fail("never reached the shipping review");
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
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-ship-"));
  process.env.FORGE_HOME = homeDir;
  writeWorkflow();
  db = makeInMemoryDb();
  prev = setDbForTest(db);

  const run: Run = {
    id: RUN_ID,
    workflow: "wf-ship",
    title: "shipping path",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    reviewMode: "evidence_led",
  };
  insertRun(run);
  const task: Task = {
    id: TASK,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: TASK, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  insertReview({
    id: REVIEW,
    runId: RUN_ID,
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    baseSha: "base000",
    candidateSha: SHA,
    contract: CONTRACT,
    state: "confirming_contract",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ── the reference run: everything proven, the gate advances with no --force ──

test("FG-640 / PRD #18: the real shipping path settles the ledger and the gate advances with NO --force", async () => {
  const outcome = await driveToShipping(deps());
  assert.equal(outcome.status, "advanced", outcome.message);
  assert.equal(getReview(REVIEW)!.state, "settled");

  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

// ── #17: an unproven AC blocks a ledger with no open findings at all ─────────

test("FG-640 / PRD #17: an AC whose only evidence is a SKIPPED test blocks the gate on a clean ledger", async () => {
  const outcome = await driveToShipping(
    deps({
      acceptance: [
        {
          ref: "FG-640 AC 17",
          verdict: "met",
          evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: SKIPPED },
        },
      ],
    }),
  );
  assert.equal(outcome.status, "refused", "the shipping review must refuse an unproven acceptance criterion");
  assert.match(outcome.message, /acceptance_mapped: 1 acceptance criteria are unmet\/unproven/);
  assert.match(
    outcome.message,
    /SKIPPED in the cited runner output — a skipped test is never evidence/,
    "the criterion is unproven because the cited test SKIPPED, not because the name was absent",
  );

  // THE PRECONDITION OF THE SCENARIO: nothing is open in the ledger. Discovery found nothing,
  // so there is no finding to disposition and no fix to recheck.
  assert.deepEqual(findingsForReview(REVIEW), [], "the ledger has no open findings");
  assert.equal(getReview(REVIEW)!.stageEvidence?.shipping, undefined, "a refused stage records nothing");

  const msg = await refusal();
  assert.match(msg, /gate kind 'review_disposition'/);
  assert.match(msg, /acceptance_unmet/);
  assert.match(msg, /a ledger with no open findings is not evidence that the work was done/);
  assert.equal(getTask(TASK)!.status, "awaiting_gate");
});

test("FG-640 / PRD #17: an AC claimed UNMET blocks the same way — the claim itself is enough", async () => {
  const outcome = await driveToShipping(
    deps({ acceptance: [{ ref: "FG-640 AC 17", verdict: "unmet", evidence: undefined }] }),
  );
  assert.equal(outcome.status, "refused");
  assert.match(await refusal(), /acceptance_unmet/);
});

test("FG-640 / PRD #17: mapping NO acceptance criteria at all is not a clean answer either", async () => {
  const outcome = await driveToShipping(deps({ acceptance: [] }));
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /no acceptance criteria were mapped/);
  assert.match(await refusal(), /acceptance_unmet/);
});

test("FG-640 / PRD #17: once the AC is proven on EXECUTED evidence the same review advances", async () => {
  // Same review, same stages, one thing changed: the evidence now records an execution. Proves
  // the block was the acceptance mapping and not some other unsettled corner.
  const skipped = await driveToShipping(
    deps({
      acceptance: [
        {
          ref: "FG-640 AC 17",
          verdict: "met",
          evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: SKIPPED },
        },
      ],
    }),
  );
  assert.equal(skipped.status, "refused");
  assert.match(await refusal(), /acceptance_unmet/);

  const proven = await driveToShipping(deps());
  assert.equal(proven.status, "advanced", proven.message);
  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

// ── a late free-form finding is an ORDINARY finding ─────────────────────────

test("FG-640: a free-form finding raised during the shipping review holds the gate as an untriaged finding", async () => {
  const outcome = await driveToShipping(
    deps({ newFindings: [{ summary: "the migration note contradicts the rendered block" }] }),
  );
  assert.equal(outcome.status, "refused");

  const ingested = findingsForReview(REVIEW);
  assert.equal(ingested.length, 1, "the late finding entered the ledger rather than only being reported");
  assert.equal(ingested[0]!.disposition, "untriaged");
  assert.equal(ingested[0]!.findingType, "shipping_review_late");

  const msg = await refusal();
  assert.match(msg, /finding_untriaged/);
  assert.match(msg, new RegExp(ingested[0]!.findingRef));
});

test("FG-640: lateness confers no authority — dispositioning the late finding settles it like any other", async () => {
  await driveToShipping(deps({ newFindings: [{ summary: "the migration note contradicts the rendered block" }] }));
  const [late] = findingsForReview(REVIEW);
  const out = recordDisposition(late!.id, {
    decision: "accepted_risk",
    rationale: "the note is accurate; the reviewer misread the rendered block",
    operator: true,
  });
  assert.equal(out.ok, true, out.ok ? "" : out.refusal);

  // The shipping review re-runs and, with the finding settled and no NEW free-form finding,
  // records its evidence — then the gate advances.
  const again = await driveToShipping(deps());
  assert.equal(again.status, "advanced", again.message);
  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

// ── tip trust is persisted by this stage, and only when it is equality ───────

test("FG-640: an untrusted tip records no remote head, so the gate stays blocked on tip_not_trusted", async () => {
  const outcome = await driveToShipping(
    deps({ tipTrust: { kind: "remote_ahead", reviewedSha: SHA, remoteSha: "remoteMoved9", detail: "remote is ahead" } }),
  );
  assert.equal(outcome.status, "refused");
  assert.equal(getReview(REVIEW)!.trustedRemoteSha, undefined, "the column never carries a head the review did not match");

  const msg = await refusal();
  assert.match(msg, /tip_not_trusted/);
  assert.match(msg, /no fetched remote head is recorded/);
});
