// FG-565 (G4) — F21 sub-clause: a landed candidate for a CANCELLED task is
// SURFACED to the operator as a standing fact, not a silent no-op.
//
// ── The gap this closes ──────────────────────────────────────────────────────
// The FG-565 closeout evidence ledger (docs/plans/fg565-closeout-evidence-ledger.md,
// F21 row) found that the cancel-path sub-clause "cancelled never resurrected YET
// landed candidate surfaced" had no clearly matching assertion. The existing
// fg484-auto-gate-cancel-race.integration.test.ts proves ONLY the negative half —
// that a run racing a concurrent `forge cancel` is never RESURRECTED to complete
// (the finalize CAS backstop). It does NOT prove the positive half: that when a
// cancelled item's work actually LANDED on the target, that landed candidate is
// surfaced to the operator rather than silently dropped or blindly re-dispatched.
// This file adds exactly that missing assertion, at the correct seam.
//
// ── The cancel → campaign_system transition is DRIVEN, not hand-set ──────────
// The campaign_system item state under test is PRODUCED by the REAL cancel path,
// never constructed with raw SQL. A real invoke-lane item is driven through
// `startCampaign` with a dispatch whose task fails with FailureKind "cancelled"
// (failTask, src/v2/failure-kind.js). The production finalize
// (executor.ts:finalizeInvokeDispatch) then reads that failure kind back
// (failureKindForTask) and classifies it via the REAL policy path
// (classifyFailureKind, policy.ts:52 -> "campaign_system"), calling the real
// updateCampaignItem to park the item failed/blocked/campaign_system with its run
// linked. So the state these operator surfaces read is the genuine durable shape a
// `forge cancel`-classified item lands in — not a synthetic blocker label.
//
// ── The two operator surfaces (traced BEFORE writing any assertion) ──────────
// A campaign_system item that turns out to be delivered out-of-band is surfaced by
// two READ-ONLY operator surfaces, both gated on the single shared ship-eligibility
// test executor.ts:evaluateCampaignSystemShipEligibility:
//   (a) report.ts:campaignSystemCompletableHint -> assembleCampaignShow /
//       assembleCampaignReport / renderCampaignReportHuman render
//       "campaign-system-recoverable … delivered out-of-band … forge campaign
//       reconcile" as a STANDING fact, with no operator action required.
//   (b) executor.ts:probeCampaignSystemRetryEvidence — when an operator TRIES to
//       `forge campaign retry` a cancelled-but-landed item, it is REFUSED with
//       "provably delivered … run forge campaign reconcile", i.e. the landed
//       candidate is named to the operator rather than being silently re-dispatched.
//
// ── This is NOT the fg484 seam ───────────────────────────────────────────────
// fg484 exercises the finalize CAS race (not-resurrected). The correct seam for
// "landed candidate surfaced" is the campaign_system ship-eligibility surface above.
// No edit is made to fg484-auto-gate-cancel-race.integration.test.ts.
//
// ── RED baseline: the in-file NEGATIVE CONTROL ───────────────────────────────
// The defect this guards against is a "silent no-op": a ship-eligibility gate that
// returned not-eligible for a landed cancelled item would make both operator
// surfaces stop naming the landed candidate (show would drop the reconcile pointer;
// retry would refuse for the WRONG reason). The NEGATIVE CONTROL below drives the
// IDENTICAL real cancel path but never lands the candidate — it reddens exactly the
// same assertions, proving they are non-vacuous: the surface fires ONLY when the
// candidate actually landed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { insertTask } from "../store/tasks.js";
import { failTask } from "../v2/failure-kind.js";
import { nowIso } from "../util/ids.js";
import { classifyFailureKind } from "./policy.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { retryCampaignItem, startCampaign } from "./executor.js";
import { assembleCampaignShow, assembleCampaignReport, renderCampaignReportHuman } from "./report.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function makeBaseCommit(label: string): void {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
}

function commitDocsFile(relPath: string, content: string, message: string): string {
  const full = join(projectDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", message], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function readyBody(ticketId: string): string {
  return `## Problem\n${ticketId} needs a docs change.\n\n## Goal\nDeliver it.\n\n## Acceptance Criteria\n- Done\n`;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg565-f21-cancel-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// The REAL cancel dispatch: the driven invoke-lane task fails with FailureKind
// "cancelled" (the durable evidence a `forge cancel` classification leaves), and the
// dispatch reports status:'failed' so the production finalize reads that kind back
// and classifies it. NOTHING here hand-sets the campaign item — the transition to
// campaign_system is produced by executor.ts:finalizeInvokeDispatch downstream.
function cancellingDispatch(): (args: InvokeArgs) => Promise<InvokeResult> {
  return async (args) => {
    const runId = args.runId!;
    const taskId = `${runId}-task-0`;
    insertTask({
      id: taskId,
      runId,
      phase: "task",
      agentRole: args.agentRole,
      status: "pending",
      taskPackage: { taskId, runId, phase: "task", role: args.agentRole, inputs: {}, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    // The durable cancel evidence: task.failed { failure_kind: "cancelled" }.
    failTask(taskId, { runId, kind: "cancelled", error: "operator cancelled the run" });
    return { runId, taskId, status: "failed", error: "operator cancelled the run" };
  };
}

// Drive a single docs-lane item to the campaign_system blocker THROUGH the real
// production cancel path: plan + approve, then startCampaign with the cancelling
// dispatch. The finalize path (finalizeInvokeDispatch) does failureKindForTask ->
// classifyFailureKind("cancelled") -> "campaign_system" -> updateCampaignItem, so the
// item lands failed/blocked/campaign_system with its run linked and the campaign paused.
async function driveCancelledCampaign(ticketId: string): Promise<{ campaignId: string; itemId: string; runId: string }> {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;

  const result = await startCampaign(campaign.id, { dispatch: cancellingDispatch() });
  assert.notEqual(result.stopReason, "complete", "a cancelled item must not ship");

  // Assert the state was PRODUCED by the real cancel path, not hand-set.
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "failed", "the real cancel drive left the item failed");
  assert.equal(item.outcome, "blocked", "the real cancel drive left the item blocked");
  assert.equal(item.blockerKind, "campaign_system", "the cancel path (classifyFailureKind) produced the campaign_system blocker");
  assert.ok(item.runId, "the driven run is linked to the item");
  assert.equal(getCampaign(campaign.id)?.status, "paused", "a shared campaign_system blocker paused the campaign");
  return { campaignId: campaign.id, itemId, runId: item.runId! };
}

// Trace anchor: the ONE routing fact that puts a cancelled item onto the
// campaign_system evidence surface these operator surfaces read from.
test("F21 trace: a cancelled task classifies as the campaign_system blocker (policy.ts:52)", () => {
  assert.equal(
    classifyFailureKind("cancelled"),
    "campaign_system",
    "the cancel path must route into the campaign_system evidence surface — else these surfaces would never see a cancelled item",
  );
});

test(
  "F21: a landed candidate for a CANCELLED task is surfaced to the operator as a standing fact (not a silent no-op)",
  async () => {
    const ticketId = "FG-820";
    const { campaignId, itemId, runId } = await driveCancelledCampaign(ticketId);

    // The cancelled item's work nonetheless LANDED: the ticket is closed with its
    // closing commit reachable on the base branch (docs-lane delivery needs no
    // host verification) — a genuine landed candidate.
    makeBaseCommit(`base-${ticketId}`);
    const commit = commitDocsFile(`docs/${ticketId}.md`, `docs for ${ticketId}`, `docs: ${ticketId}`);
    closeTicket(projectDir, ticketId, commit);

    const beforeItem = getCampaignItem(itemId)!;
    const runStatusBefore = (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;

    // ── Surface (a): the read-only show/report standing fact — no operator
    //    action required. The landed candidate is NAMED and pointed at reconcile.
    const show = assembleCampaignShow(campaignId)!;
    assert.equal(
      show.items[0]!.campaignSystemEligible,
      true,
      "the landed candidate for the cancelled item must be surfaced as recoverable",
    );
    assert.ok(
      show.nextAction.includes("forge campaign reconcile"),
      `the cancelled item's landed candidate must point the operator at reconcile, got: ${show.nextAction}`,
    );
    assert.ok(
      show.nextAction.includes("delivered out-of-band"),
      `the standing fact must name that the work already landed, got: ${show.nextAction}`,
    );

    const report = assembleCampaignReport(campaignId)!;
    assert.equal(report.items[0]!.campaignSystemEligible, true);
    const human = renderCampaignReportHuman(report);
    assert.ok(
      human.some((l) => l.includes("campaign-system-recoverable")),
      `the human report must render the landed-candidate reconcile hint, got: ${human.filter((l) => l.includes("campaign-system")).join(" | ")}`,
    );

    // ── Surface (b): when the operator TRIES to retry (re-dispatch) the cancelled
    //    item, the landed candidate is named and the retry is refused — proving
    //    the landed candidate is not silently dropped/re-dispatched.
    const retried = retryCampaignItem(campaignId, ticketId);
    assert.equal(retried.ok, false, "a cancelled item whose candidate landed must never be blindly re-dispatched");
    if (!retried.ok) {
      assert.match(retried.reason, /provably delivered/i, "the refusal must name the landed candidate as the reason");
      assert.match(retried.reason, new RegExp(`forge campaign reconcile ${campaignId}`), "and point at reconcile");
    }

    // ── Distinct from fg484 (not-resurrected CAS): these are READ-ONLY standing
    //    surfaces — surfacing the landed candidate mutates nothing. (fg484 owns the
    //    finalize-race guarantee; this test owns the positive landed-candidate fact.)
    assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "surfacing the landed candidate must not mutate the item row");
    const runStatusAfter = (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
    assert.equal(runStatusAfter, runStatusBefore, "the read-only surface never mutates the cancelled run — it is not resurrected");
  },
);

// NEGATIVE CONTROL — proves the positive assertions above are non-vacuous and serves
// as the RED baseline: an identically-cancelled item (driven through the SAME real
// cancel path) whose work did NOT land must NOT surface a landed candidate. If the
// ship-eligibility gate were a silent no-op (always not-eligible), the positive test's
// surfaces would look exactly like this — so this is the shape that reddens them.
test(
  "F21 control: a cancelled task with NO landed candidate is NOT surfaced as recoverable (surface is keyed on the candidate landing)",
  async () => {
    const ticketId = "FG-821";
    const { campaignId } = await driveCancelledCampaign(ticketId);

    // Base branch only — the ticket is never closed and nothing reached the target,
    // so there is no landed candidate to surface.
    makeBaseCommit(`base-${ticketId}`);

    const show = assembleCampaignShow(campaignId)!;
    assert.equal(
      show.items[0]!.campaignSystemEligible,
      false,
      "with nothing landed there is no candidate to surface as recoverable",
    );
    assert.ok(
      !show.nextAction.includes("delivered out-of-band"),
      `no landed-candidate standing fact may appear, got: ${show.nextAction}`,
    );

    const human = renderCampaignReportHuman(assembleCampaignReport(campaignId)!);
    assert.ok(
      !human.some((l) => l.includes("campaign-system-recoverable")),
      "the human report must NOT render a landed-candidate hint when nothing landed",
    );

    // And the retry refusal names the CANCEL classification, NOT "provably
    // delivered" — the two refusal reasons are distinct, confirming the positive
    // test's "provably delivered" surface is specifically the landed-candidate one.
    const retried = retryCampaignItem(campaignId, ticketId);
    assert.equal(retried.ok, false, "a non-transient cancelled failure is still not retryable");
    if (!retried.ok) {
      assert.match(retried.reason, /cancelled/i, "the refusal must name the cancel classification when nothing landed");
      assert.ok(!/provably delivered/i.test(retried.reason), "and must NOT claim delivery when nothing landed");
    }
  },
);
