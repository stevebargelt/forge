// FG-516 structural fix — the parkCampaign boundary, driven through the REAL
// executor. Two acceptance violations closed here:
//
//   Finding A (cross-run dedupe): the campaign-pause dedupe key is campaign+item
//     stable, but `forge campaign retry` CLEARS the item's runId, so a re-park
//     lands on a NEW run. A run-scoped suppression scan finds nothing on the new
//     run and re-pushes. The fix scopes the scan GLOBALLY, so a re-park after a
//     retry stays silent (the event is still recorded, dispatched=false).
//
//   Finding B (notify only on a COMMITTED pause): every running→paused park now
//     goes through parkCampaign, which notifies ONLY when its own CAS committed.
//     A concurrent operator `forge campaign pause` (the documented exemption) that
//     wins the CAS first leaves committed=false, so the stale driver pushes
//     nothing. Driven here on two distinct park shapes — the invoke-lane
//     dispatch-threw park and the gate:human (:849-class) drive-loop park — to
//     prove the boundary holds across variants, not just one site.
//
// Harness mirrors fg516-park-breadth-notify (stub ntfy provider + push counting)
// and executor.integration (invoke-lane dispatch seam).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../store/campaigns.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, retryCampaignItem, setCampaignNotifyEmitterForTest } from "./executor.js";
import { runNext } from "../v2/runNext.js";
import { publishFlatAsGeneration } from "../v2/seed-generation.testkit.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg516-boundary-runtime";
const WORKFLOW_NAME = "fg516-park-boundary";
const TICKET_ID = "FG-919";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let wfPath: string;

const ENV_KEYS = ["ANTHROPIC_API_KEY", "NO_NOTIFY", "FORGE_NOTIFY", "NTFY_URL"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let originalFetch: typeof globalThis.fetch;
let fetchCalls: number;

const dedupeKeyFor = (campaignId: string) => `campaign-pause:${campaignId}:${TICKET_ID}`;

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-516 boundary integration test runtime stub
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

function writeWorkflow(): void {
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-516 park-boundary regression test
inputs: []
steps:
  - id: implement
    agent: engineer
    gate: human
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds: []
`,
  );
  // FG-583: publish the flat workflow + runtime as one complete seed generation —
  // there is no flat dispatch fallback, so the pipeline-lane drive refuses without
  // a published generation. Called after ensureRuntime in beforeEach, so this
  // captures both.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
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
    if (calls > cap) throw new Error(`FG-516 boundary test safety guard: runNext called ${calls} times without settling`);
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called on a full_feature lane");
};

const throwingDispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("FG-516 boundary test: injected dispatch explosion");
};

function seedTicket(): void {
  writeTicket(projectDir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: "FG-919 park-boundary",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
}

// A full_feature (pipeline) campaign — parks land in driveWorkflowItem.
function setupPipelineCampaign(): string {
  seedTicket();
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-516 boundary test" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-516 boundary test" });
  return campaign.id;
}

// An invoke-lane campaign — the dispatch seam lets us throw an infrastructure
// (retryable) failure, the shape finding A needs to exercise `forge campaign retry`.
function setupInvokeCampaign(): string {
  seedTicket();
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { executionMode: "invoke", agentRole: "engineer", laneRationale: "FG-516 boundary test" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-516 boundary test" });
  return campaign.id;
}

function enableStubProvider(): void {
  process.env["NO_NOTIFY"] = "";
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
}

// Milestones across ALL runs (not one run) — finding A is about a key that spans runs.
function allPauseMilestones(): Array<{ runId: string | null; kind: string; dedupeKey: string; dispatched: boolean }> {
  const rows = getDb({ readOnly: true })
    .prepare("SELECT run_id, payload FROM events WHERE event_type = 'orchestrator.milestone' ORDER BY id ASC")
    .all() as { run_id: string | null; payload: string }[];
  return rows
    .map((r) => {
      const p = JSON.parse(r.payload) as { kind: string; dedupeKey?: string; dispatched?: boolean };
      return { runId: r.run_id, kind: p.kind, dedupeKey: p.dedupeKey ?? "", dispatched: p.dispatched === true };
    })
    .filter((m) => m.dedupeKey.startsWith("campaign-pause:"));
}

// The precise "a push went out" signal is a DISPATCHED campaign-pause milestone
// event — NOT raw fetch count. Some park paths also abandon the item's run
// (updateRunStatus → notifyOnRunTransition), which fires its own unrelated
// provider push, so fetchCalls conflates the two. We assert on the milestone.
function dispatchedPushes(campaignId: string): number {
  return allPauseMilestones().filter((m) => m.dedupeKey === dedupeKeyFor(campaignId) && m.dispatched).length;
}

const drainMicrotasks = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg516-boundary-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  originalFetch = globalThis.fetch;
  fetchCalls = 0;
  ensureRuntime(RUNTIME_NAME);
  const forgeHome = process.env.FORGE_HOME!;
  wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeWorkflow();
});

afterEach(() => {
  setCampaignNotifyEmitterForTest(null);
  globalThis.fetch = originalFetch;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

// ── Finding A: cross-run dedupe survives `forge campaign retry` clearing the runId ──
test("FG-516 (finding A): a re-park after retry clears the runId lands on a NEW run and pushes ZERO new times (global dedupe)", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupInvokeCampaign();

  // First park: the invoke dispatch throws → infrastructure (retryable) park on run
  // R1. Fresh dedupe key → a real push.
  const first = await startCampaign(campaignId, { dispatch: throwingDispatch });
  assert.equal(first.stopReason, "paused", "the dispatch-threw park pauses the campaign");
  const item1 = listCampaignItems(campaignId)[0]!;
  assert.equal(item1.blockerKind, "infrastructure", "the dispatch-threw park is a retryable infrastructure blocker");
  const runR1 = item1.runId!;
  await drainMicrotasks();
  assert.equal(dispatchedPushes(campaignId), 1, "the first park pushed exactly once");
  const r1 = allPauseMilestones().filter((m) => m.runId === runR1 && m.dedupeKey === dedupeKeyFor(campaignId));
  assert.equal(r1.length, 1, "one milestone recorded on the first run");
  assert.equal(r1[0]!.dispatched, true, "the first park dispatched (fresh key)");

  // `forge campaign retry` clears the item's runId and resets it to pending — the
  // exact semantics that make a run-scoped dedupe blind on the re-park.
  const retried = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(retried.ok, true, "an infrastructure blocker is retryable");
  assert.equal(listCampaignItems(campaignId)[0]!.runId, undefined, "retry cleared the item's runId");

  // Resume: the item re-dispatches, gets a genuinely NEW run R2, throws again → re-park.
  const resumed = await resumeCampaign(campaignId, { dispatch: throwingDispatch });
  assert.equal(resumed.stopReason, "paused", "the re-park pauses the campaign again");
  const runR2 = listCampaignItems(campaignId)[0]!.runId!;
  assert.notEqual(runR2, runR1, "the re-park landed on a NEW run (retry cleared the old linkage)");
  await drainMicrotasks();

  // Finding A: a run-scoped scan would find nothing on R2 and re-push. Global scope
  // finds R1's dispatched push under the same campaign+item key and suppresses.
  assert.equal(dispatchedPushes(campaignId), 1, "ZERO new pushes across the run boundary — the re-park was globally deduped");
  const r2 = allPauseMilestones().filter((m) => m.runId === runR2 && m.dedupeKey === dedupeKeyFor(campaignId));
  assert.equal(r2.length, 1, "the re-park milestone is still RECORDED on the new run (audit trail intact)");
  assert.equal(r2[0]!.dispatched, false, "but recorded as suppressed, not dispatched — matches the existing dedupe semantics");
});

// ── Finding B, shape 1: the invoke-lane dispatch-threw park (a committed-CAS gate) ──
test("FG-516 (finding B): the invoke-lane dispatch-threw park does NOT push when a concurrent manual pause already won the CAS", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupInvokeCampaign();

  // Simulate the operator's `forge campaign pause` landing first: the dispatch flips
  // the campaign to 'paused' (the exempt manual transition) and THEN throws, so the
  // dispatch-threw park sees a campaign that is no longer 'running'.
  const pauseThenThrow = async (_args: InvokeArgs): Promise<InvokeResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    throw new Error("FG-516 boundary test: injected dispatch explosion after manual pause");
  };

  const result = await startCampaign(campaignId, { dispatch: pauseThenThrow });
  assert.equal(result.stopReason, "paused", "the item still parks; the campaign is paused (from the manual pause)");

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "failed", "the item is still durably parked");
  assert.equal(item.blockerKind, "infrastructure", "with its real blocker recorded");
  assert.equal(getCampaign(campaignId)?.status, "paused");
  await drainMicrotasks();

  assert.equal(
    allPauseMilestones().length,
    0,
    "no campaign-pause milestone recorded — this stale driver committed no transition, so parkCampaign must not notify",
  );
});

// ── Finding B, shape 2: the gate:human (:849-class) drive-loop park ──
test("FG-516 (finding B): the gate:human drive-loop park does NOT push when a concurrent manual pause already won the CAS", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupPipelineCampaign();

  // The drive loop dispatches the pipeline step (it becomes awaiting_gate under a
  // human gate) then, on the next pass, parks at the :849-class gate:human site.
  // Flip the campaign to 'paused' the instant runNext reports the awaiting-gate step,
  // so the campaign is already paused by the time parkCampaign runs its CAS.
  const pauseOnGate = (cap: number) => {
    let calls = 0;
    return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
      calls++;
      if (calls > cap) throw new Error("FG-516 boundary test safety guard: runNext over cap");
      const r = await runNext({ ...args, dockerExec: stubExec });
      if (r.awaitingGate.length > 0) {
        db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
      }
      return r;
    };
  };

  const result = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: pauseOnGate(10) });
  assert.equal(result.stopReason, "paused", "the drive loop still parks the item at the human gate");

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item is durably parked awaiting the human gate");
  assert.equal(getCampaign(campaignId)?.status, "paused");
  await drainMicrotasks();

  assert.equal(
    allPauseMilestones().length,
    0,
    "no campaign-pause milestone — the manual pause won the CAS, so the :849-class park committed nothing and stays silent",
  );
});

// ── Finding B (positive control): with NO concurrent pause, the same gate park DOES push ──
test("FG-516 (finding B, control): the gate:human drive-loop park pushes exactly once when its own CAS commits the pause", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupPipelineCampaign();

  const result = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(result.stopReason, "paused");
  const runId = listCampaignItems(campaignId)[0]!.runId!;
  await drainMicrotasks();

  const m = allPauseMilestones().filter((x) => x.runId === runId && x.dedupeKey === dedupeKeyFor(campaignId));
  assert.equal(m.length, 1, "the gate park recorded one milestone");
  assert.equal(m[0]!.kind, "decision_needed", "a gate:human park is a decision_needed milestone");
  assert.equal(m[0]!.dispatched, true, "and it dispatched — parkCampaign committed the pause itself");
  assert.equal(dispatchedPushes(campaignId), 1, "exactly one campaign-pause push");
});
