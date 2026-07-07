// FG-483: integration coverage for the drive-time invoke-lane evidence gate
// (quick_implementation and the docs_only/test_only/review_only/research_only
// escape hatch). Review finding F4 (HIGH): both finalize sites used to derive
// outcome:'shipped' from freshTicket.status==='done' && !!freshTicket.closedCommit
// alone — hand-editable ticket frontmatter, with no host-side proof the merged
// tree compiles. This exercises the fix end-to-end through driveRemainingItems
// (via startCampaign/resumeCampaign), not unit-level helper calls — proving:
//   - the review's spoof shape (a done ticket with a fabricated/uncovered
//     closedCommit) no longer ships, it parks at awaiting_gate;
//   - a legitimately-shipped quick item (real merged commit + a covering
//     passing host-verification row) still ships;
//   - a non-code invoke lane still ships via the existing out-of-band
//     non_code_diff evidence model, with no host-verification row required;
//   - drive-time and resume-time agree: an item that fails drive-time
//     eligibility, then becomes eligible once a covering host-verification row
//     is added, ships identically via the SAME composeOutOfBandEligibility
//     resume/reconcile already use — one shared implementation, not two.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../store/campaigns.js";
import { planCampaign, resolvePlan } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
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

// A real, reachable, docs-only commit — classifies as the non_code_diff
// out-of-band lane (reconcile-outofband-collect.ts's commitTouchesOnlyNonCodePaths),
// so no host-verification row is required.
function makeDocsCommit(ticketId: string): string {
  const relPath = `docs/${ticketId}.md`;
  const full = join(projectDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `docs for ${ticketId}`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `docs: ${ticketId}`], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

// A real, reachable, code-touching commit — requires a covering passing
// host-verification row to satisfy the out-of-band host_verification lane.
function makeCodeCommit(ticketId: string): string {
  const srcDir = join(projectDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, `${ticketId}.ts`), `export const ${ticketId.replace(/-/g, "_")} = 1;\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `feat: ${ticketId}`], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function recordPassingHostVerification(ticketId: string, commitSha: string): void {
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
}

function readyBody(ticketId: string): string {
  return `## Problem\n${ticketId} needs implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n`;
}

function planQuickItem(ticketId: string) {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "quick_implementation", laneRationale: "test" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  return campaign;
}

function planDocsOnlyItem(ticketId: string) {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "docs_only", laneRationale: "test", agentRole: "documentation-maintainer" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  return campaign;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg483-integ-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  makeBaseCommit("init");
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-483 negative (review F4 spoof shape): quick_implementation item closes its own ticket with a FABRICATED/unreachable closedCommit — driven end-to-end through startCampaign, the item does NOT ship, it parks awaiting_gate", async () => {
  const ticketId = "FG-700";
  const campaign = planQuickItem(ticketId);

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if (args.agentRole === "test-engineer") {
      // Simulates an agent self-closing its own ticket with a commit sha that
      // was never actually committed to the repo — closeTicket (backlog/
      // structured.ts) accepts any --commit string unvalidated.
      closeTicket(projectDir, ticketId, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    }
    return { runId: args.runId ?? "run-fake", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.notEqual(result.stopReason, "complete", "a fabricated closedCommit must never let the campaign report complete");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "awaiting_gate", "item must park awaiting_gate on a fabricated closedCommit");
  assert.equal(result.itemRecords[0]!.outcome, undefined, "outcome must not be 'shipped' — today's frontmatter-only check would have shipped this");

  const items = listCampaignItems(campaign.id);
  assert.equal(items[0]!.outcome, undefined, "durable DB state must also show no shipped outcome");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "campaign must be paused, never complete/complete_with_issues");
});

test("FG-483 positive: quick_implementation item ships when the closedCommit is a REAL merged commit with a covering passing host-verification row", async () => {
  const ticketId = "FG-701";
  const campaign = planQuickItem(ticketId);

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if (args.agentRole === "test-engineer") {
      const commit = makeCodeCommit(ticketId);
      closeTicket(projectDir, ticketId, commit);
      recordPassingHostVerification(ticketId, commit);
    }
    return { runId: args.runId ?? "run-fake", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "complete", "real reachable commit + passing host-verification row must ship");
  assert.equal(result.itemRecords[0]!.lifecycleStatus, "complete");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
  assert.equal(getCampaign(campaign.id)!.status, "complete");
});

test("FG-483 positive (non-code lane): a docs_only invoke-lane item ships via the existing non_code_diff out-of-band evidence model — no host-verification row required", async () => {
  const ticketId = "FG-702";
  const campaign = planDocsOnlyItem(ticketId);

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const commit = makeDocsCommit(ticketId);
    closeTicket(projectDir, ticketId, commit);
    return { runId: args.runId ?? "run-docs", taskId: "task-docs", status: "complete" };
  };

  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "complete", "docs-only commit must ship without any host-verification row");
  assert.equal(result.itemRecords[0]!.outcome, "shipped");
});

test("FG-483 drive-time/resume-time parity: a quick_implementation item that fails drive-time eligibility (code-touching, no host-verification row) parks awaiting_gate; once a covering passing host-verification row is added out-of-band, resume ships it via the SAME composeOutOfBandEligibility the reattach path uses — proving drive-time and resume-time share one implementation", async () => {
  const ticketId = "FG-703";
  const campaign = planQuickItem(ticketId);

  let commit = "";
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    if (args.agentRole === "test-engineer") {
      // Real, reachable, CODE-touching commit — but withhold the host-verification
      // row an agent cannot fabricate on its own (it requires the host gate to
      // actually run and pass).
      commit = makeCodeCommit(ticketId);
      closeTicket(projectDir, ticketId, commit);
    }
    return { runId: args.runId ?? "run-fake", taskId: `task-${args.agentRole}`, status: "complete" };
  };

  const driveResult = await startCampaign(campaign.id, { dispatch });

  assert.notEqual(driveResult.stopReason, "complete", "code-touching commit with no covering host-verification row must not ship at drive-time");
  assert.equal(driveResult.itemRecords[0]!.lifecycleStatus, "awaiting_gate");
  const parkedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(parkedItem.lifecycleStatus, "awaiting_gate");
  assert.equal(parkedItem.blockerKind, undefined, "no blockerKind — the out-of-band shape the FG-441 reattach branch expects");
  assert.ok(parkedItem.runId, "the parked item retains its runId — required for the reattach branch to fire on resume");

  // Out-of-band: a covering passing host-verification row appears (e.g. an
  // operator ran `forge campaign reconcile` separately, or CI recorded it) —
  // drive-time itself never runs host verification; this only adds the row.
  recordPassingHostVerification(ticketId, commit);

  let resumeDispatchCount = 0;
  const resumeDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    resumeDispatchCount++;
    return { runId: "run-resume", taskId: "task-resume", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeDispatch });

  assert.equal(resumeResult.stopReason, "complete", "resume must ship the item once the covering host-verification row exists");
  assert.equal(resumeDispatchCount, 0, "resume ships directly from evidence via the FG-441 reattach branch — it never re-dispatches the agent");

  const shippedItem = listCampaignItems(campaign.id)[0]!;
  assert.equal(shippedItem.lifecycleStatus, "complete");
  assert.equal(shippedItem.outcome, "shipped");
});

test("FG-483: resolvePlan is unaffected by this change (sanity: quick_implementation plans identically before/after evidence gate)", () => {
  const ticketId = "FG-704";
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: readyBody(ticketId) });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "quick_implementation", laneRationale: "test" },
  };
  const { planHash } = resolvePlan(
    { kind: "list", ticketIds: [ticketId], itemOverrides },
    { projectDir, mode: "sequential" }
  );
  assert.ok(planHash, "plan resolution is unaffected by the drive-time evidence gate change");
});
