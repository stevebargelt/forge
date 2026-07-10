// FG-509 (audit finding N-A): driveWorkflowItem wrapped ONLY its runNextFn call in
// parkCampaignOnDriveThrow. Its three siblings in the same loop — reconcileTerminalOutcome
// and the two auto-advance doGate calls (gate:auto, gate:verdict-pass) — were bare. A throw
// from any of them (illegal transition, DB error) unwound through driveRemainingItems to the
// CLI with NO park: the item stayed as-was, the campaign stayed 'running', and
// `forge campaign resume` then refused with not_paused. That is the FG-490 dead end,
// re-opened on two more edges.
//
// These tests drive the REAL executor (startCampaign/resumeCampaign/driveWorkflowItem) and
// assert the containment invariant at each of the three sites: item parked recoverably at
// awaiting_gate with the drive-error reason, a campaign_item.drive_error event on the run,
// and the campaign row transitioned running→paused. Tests 4 and 5 close the loop the ticket
// is actually about — that a campaign parked this way can be resumed at all — once per park
// shape, because resume reaches the two shapes by different routes: the active-run parks
// (test 4) re-enter the drive loop via the FG-485 liveness probe, while the terminal
// reconciliation park (test 5) has no active run, falls through the out-of-band evidence
// path, and re-runs reconcileTerminalOutcome itself.
//
// The gate:auto and gate:verdict setups use the same seam fg484-auto-gate-cancel-race
// uses: drive the step to a genuine awaiting_gate park under gate:human, then rewrite the
// on-disk workflow (driveWorkflowItem reloads it by name on every call) so the parked task
// reads as an unattended auto-advance candidate on the next drive. The reconcile setup uses
// executor.ts's own done-audit override hook, made to throw from inside
// reconcileTerminalOutcome's real body.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../store/campaigns.js";
import { updateRunStatus } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { eventsForRun, logEvent } from "../store/events.js";
import { nowIso } from "../util/ids.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, setExecutorDoneAuditMapForTest } from "./executor.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";
import { gate } from "../v2/gate.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg509-test-runtime";
const WORKFLOW_NAME = "fg509-campaign-drive-throw";
const TICKET_ID = "FG-909";
const BOOM = "FG-509 test: injected drive-path explosion";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let wfPath: string;

const ENV_KEYS = ["ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-509 integration test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
}

function writeWorkflow(gateType: "human" | "auto" | "verdict"): void {
  const reds =
    gateType === "verdict"
      ? `
      - agent: shipping-reviewer
        authority: authoritative
        gate_on_verdict: true`
      : " []";
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-509 campaign drive-throw containment regression test
inputs: []
steps:
  - id: implement
    agent: engineer
    gate: ${gateType}
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds:${reds}
`,
  );
}

const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", files_modified: [] }));
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  return 0;
};

function makeCappedRunNext(cap: number) {
  let calls = 0;
  return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    calls++;
    if (calls > cap) {
      throw new Error(`FG-509 test safety guard: runNext called ${calls} times without settling`);
    }
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses it");
};

const throwingGateFn: typeof gate = async () => {
  throw new Error(BOOM);
};

function setupCampaign(): string {
  writeTicket(projectDir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: "FG-509 campaign drive-throw containment",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-509 test: drive-throw containment" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-509 test" });
  return campaign.id;
}

// Drives the real gate:human step to a genuine awaiting_gate park and returns the run id.
async function driveToHumanGatePark(campaignId: string): Promise<string> {
  const setupResult = await startCampaign(campaignId, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
  });
  assert.equal(setupResult.stopReason, "paused", "setup: must park at the human gate");
  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate");
  assert.ok(item.runId, "setup: the item must have a run attached");
  return item.runId!;
}

// The containment invariant, asserted positively: the item row carries the recoverable park
// shape (not merely "an error was thrown"), the failure is durably recorded, and the campaign
// is paused rather than stranded at running.
function assertParkedAndPaused(campaignId: string, runId: string): void {
  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item must park recoverably at awaiting_gate");
  assert.equal(item.outcome, undefined, "a contained drive throw is not a terminal outcome");
  assert.equal(item.blockerKind, undefined, "no blockerKind — this is the reattachable shape, not a terminal block");
  assert.equal(item.reason, BOOM, "the item must carry the drive error as its reason");
  assert.ok(
    item.requestedHumanAction?.includes("drive loop threw"),
    `requestedHumanAction must name the drive throw, got: ${item.requestedHumanAction}`,
  );
  assert.ok(item.requestedHumanAction?.includes(BOOM), "requestedHumanAction must carry the underlying error message");

  const events = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(events.includes("campaign_item.drive_error"), `a campaign_item.drive_error event must exist, got: ${JSON.stringify(events)}`);

  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign must transition running→paused, never stay stranded at running");
}

async function assertRejectsWithEnrichedError(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /paused after a drive error/, "the rethrown error must be the enriched next-action guidance");
    assert.match(err.message, new RegExp(BOOM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the original error message must survive");
    assert.ok(err.cause instanceof Error, "the original error must be preserved as `cause`");
    return true;
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg509-drive-throw-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime(RUNTIME_NAME);
  const forgeHome = process.env.FORGE_HOME!;
  wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeWorkflow("human"); // start under a human gate — parks awaiting_gate for real
});

afterEach(() => {
  setExecutorDoneAuditMapForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

test("FG-509: a throwing doGate on the gate:auto auto-advance parks the item and pauses the campaign", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();
  const runId = await driveToHumanGatePark(campaignId);

  // The step now reads as gate:auto at drive time while its task is still parked
  // awaiting_gate — driveWorkflowItem's unattended auto-advance branch.
  writeWorkflow("auto");

  await assertRejectsWithEnrichedError(() =>
    resumeCampaign(campaignId, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
      gateFn: throwingGateFn,
    }),
  );

  assertParkedAndPaused(campaignId, runId);
});

test("FG-509: a throwing doGate on the gate:verdict pass branch parks the item and pauses the campaign", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();
  const runId = await driveToHumanGatePark(campaignId);

  const primaryTaskId = tasksForRun(runId)[0]!.id;
  const redTaskId = `${primaryTaskId}-red`;
  insertTask({
    id: redTaskId,
    runId,
    phase: "implement",
    agentRole: "shipping-reviewer",
    parentId: primaryTaskId,
    status: "complete",
    taskPackage: { taskId: redTaskId, runId, phase: "implement", role: "shipping-reviewer", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });
  insertVerdict({
    id: "fg509-verdict-pass",
    taskId: primaryTaskId,
    redTaskId,
    redRole: "shipping-reviewer",
    verdict: "pass",
    confidence: 0.95,
    authority: "authoritative",
    findings: [],
    createdAt: nowIso(),
  });

  // gate:verdict with an all-pass aggregate — driveWorkflowItem's second auto-advance site.
  writeWorkflow("verdict");

  await assertRejectsWithEnrichedError(() =>
    resumeCampaign(campaignId, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
      gateFn: throwingGateFn,
    }),
  );

  assertParkedAndPaused(campaignId, runId);
});

// executor.ts's done-audit override hook, made to throw from inside
// reconcileTerminalOutcome's real body (the verdict-passed / done-audit branch).
class ThrowingDoneAuditMap extends Map<string, DoneAuditResult> {
  override get(_key: string): DoneAuditResult | undefined {
    throw new Error(BOOM);
  }
}

// Clearing the fault: a real map whose entry is what a clean done-audit of this settled
// run yields. Paired with the authoritative pass verdict below, a reconciliation that
// actually re-runs can only land the item at complete/shipped.
const PASSING_AUDIT: DoneAuditResult = { outcome: "pass", checks: [], gaps: [], requestedAction: null };

// Settles the run to 'complete' with an authoritative pass verdict recorded, so the next
// pass of the drive loop takes the terminal branch and reconcileTerminalOutcome reaches
// the done-audit lookup — where the injected fault throws. Returns the run id.
async function driveToReconcileThrowPark(campaignId: string): Promise<string> {
  setExecutorDoneAuditMapForTest(new ThrowingDoneAuditMap());

  let settled = false;
  const settlingRunNext = async ({ runId }: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (!settled) {
      settled = true;
      const primaryTaskId = tasksForRun(runId)[0]?.id;
      logEvent("verdict.received", {
        runId,
        ...(primaryTaskId ? { taskId: primaryTaskId } : {}),
        payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" },
      });
      updateRunStatus(runId, "complete");
    }
    return { dispatchedSteps: [], completedSteps: [], awaitingGate: [], failedSteps: [], runStatus: "complete" };
  };

  await assertRejectsWithEnrichedError(() =>
    startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: settlingRunNext }),
  );

  return listCampaignItems(campaignId)[0]!.runId!;
}

test("FG-509: a throwing reconcileTerminalOutcome parks the item and pauses the campaign", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();
  const runId = await driveToReconcileThrowPark(campaignId);
  assertParkedAndPaused(campaignId, runId);
});

test("FG-509: resume after a drive-throw park re-attaches and re-drives — no not_paused refusal", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();
  const runId = await driveToHumanGatePark(campaignId);
  writeWorkflow("auto");

  await assertRejectsWithEnrichedError(() =>
    resumeCampaign(campaignId, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
      gateFn: throwingGateFn,
    }),
  );
  assertParkedAndPaused(campaignId, runId);

  // The whole point of parking recoverably: the operator fixes the underlying issue and
  // resumes. Pre-fix, the campaign was still 'running' here and campaignBlocker refused
  // this call outright with not_paused — a dead end reachable only by DB surgery.
  let gateCalls = 0;
  const benignGateFn: typeof gate = async (taskId, decision, rationale, opts) => {
    gateCalls++;
    return gate(taskId, decision, rationale, opts);
  };

  const resumed = await resumeCampaign(campaignId, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
    gateFn: benignGateFn,
  });

  assert.notEqual(resumed.stopReason, "not_paused", "resume must not refuse a drive-throw-parked campaign");
  assert.ok(gateCalls > 0, "resume must actually re-enter the drive loop and reach the auto-advance gate");
  assert.equal(tasksForRun(runId)[0]!.status, "complete", "the benign gate advance must have landed for real");
});

// The reconcileTerminalOutcome park is a DISTINCT resume shape from the three active-run
// sites above: there is no active run and nothing to re-dispatch, so the liveness probe
// finds no dispatchable work and resume falls through to the out-of-band evidence path
// (which refuses — the ticket is still active) before re-entering driveWorkflowItem's
// terminal branch. That re-entry is the recovery: it retries the SAME reconciliation.
test("FG-509: resume after a reconcile-throw park re-runs reconcileTerminalOutcome once the fault is cleared", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();
  const runId = await driveToReconcileThrowPark(campaignId);
  assertParkedAndPaused(campaignId, runId);

  // Resuming with the fault still present re-parks on the identical error — the reason
  // `campaign resume` docs say to clear the fault first.
  await assertRejectsWithEnrichedError(() =>
    resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) }),
  );
  assertParkedAndPaused(campaignId, runId);

  setExecutorDoneAuditMapForTest(new Map([[TICKET_ID, PASSING_AUDIT]]));

  const resumed = await resumeCampaign(campaignId, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
  });

  assert.notEqual(resumed.stopReason, "not_paused", "resume must not refuse a reconcile-throw-parked campaign");

  // The item must leave the parked drive-error shape at the terminal outcome its evidence
  // dictates — an authoritative pass plus a passing done-audit is exactly 'shipped'. Only a
  // real re-run of reconcileTerminalOutcome can produce it; the park never writes an outcome.
  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "complete", "reconcileTerminalOutcome must have re-run and terminalized the item");
  assert.equal(item.outcome, "shipped", "an authoritative pass + passing done-audit reconciles to shipped");
  assert.equal(item.blockerKind, undefined, "the cleanly reconciled item carries no blocker");
  assert.notEqual(getCampaign(campaignId)?.status, "paused", "the campaign must not be left parked after a clean reconcile");
});
