// FG-511: evidence-gated `forge campaign retry` for campaign_system items.
//
// reconcileTerminalOutcome lands ANY non-complete run on blockerKind
// campaign_system, so an overnight transient blip (idle timeout, container
// crash, killed driver) that abandoned a full_feature item's run is — at the
// ITEM level — indistinguishable from a genuine campaign-system fault. Before
// this change retryCampaignItem refused campaign_system outright and reconcile
// demanded ship evidence a never-finished run cannot have: the item was
// campaign-terminal, recoverable only by abandon or re-plan.
//
// retryCampaignItem now probes the underlying run's durable task evidence for
// that one blockerKind, and accepts ONLY when every failed primary task
// classifies transient (auth/infrastructure) through the exact
// failureKindForTask -> classifyFailureKind sequence reconcileTerminalOutcome
// itself uses. Every other branch — no linked run, a run that reached
// 'complete', no failed primary to classify, any non-transient or MIXED
// classification — refuses and names what was missing or non-transient.
//
// The positive test drives the REAL path end to end: real startCampaign, real
// runNext (only the docker exec boundary is stubbed, per the project's
// DockerExecFn injection pattern), a genuinely abandoned run, the REAL
// reconcileTerminalOutcome landing failed/blocked/campaign_system, then retry
// -> resume -> re-drive. Against the unfixed retryCampaignItem it fails at the
// acceptance assertion (campaign_system was refused outright).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import {
  approveCampaign,
  getCampaign,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignStatus,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { getRun, insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { failTask } from "../v2/failure-kind.js";
import type { FailureKind } from "../v2/failure-kind.js";
import { nowIso } from "../util/ids.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, retryCampaignItem } from "./executor.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import type { CampaignItem } from "../types/index.js";

const RUNTIME_NAME = "fg511-test-runtime";
const WORKFLOW_NAME = "fg511-campaign-feature";
const TICKET_ID = "FG-911";
const RETRIED_EVENT = "campaign_item.campaign_system_retried";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

const ENV_KEYS = ["ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME_NAME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME_NAME}
description: FG-511 integration test runtime stub
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

// gate:human — the run parks at awaiting_gate with a live run, which is exactly
// the state a real overnight blip interrupts.
function ensureWorkflow(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-511 campaign_system evidence-gated retry regression test
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
    if (++calls > cap) throw new Error(`FG-511 test safety guard: runNext called ${calls} times without settling`);
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses it");
};

function setupFullFeatureCampaign(): string {
  writeTicket(projectDir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: "FG-511 campaign_system evidence-gated retry",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-511 test: evidence-gated retry" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-511 test" });
  return campaign.id;
}

// A campaign whose single item needs no workflow machinery — the negative tests
// exercise retryCampaignItem's evidence probe, not the drive loop, so their
// fixtures are built directly against the store.
function setupPausedCampaign(): { campaignId: string; item: CampaignItem } {
  writeTicket(projectDir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: "FG-511 probe fixture",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { executionMode: "invoke", agentRole: "engineer" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-511 test" });
  tryTransitionCampaignToRunning(campaign.id);
  updateCampaignStatus(campaign.id, "paused");
  return { campaignId: campaign.id, item: listCampaignItems(campaign.id)[0]! };
}

// Inserts a run in `status` with one failed primary task per entry in
// failureKinds, each carrying a real task.failed event (failTask — the
// production writer failureKindForTask reads back).
function seedRunWithFailedPrimaries(runId: string, status: "active" | "abandoned" | "complete", failureKinds: FailureKind[]): void {
  insertRun({ id: runId, workflow: WORKFLOW_NAME, title: TICKET_ID, status, createdAt: nowIso(), projectDir });
  failureKinds.forEach((kind, i) => {
    const taskId = `${runId}-task-${i}`;
    insertTask({
      id: taskId,
      runId,
      phase: "implement",
      agentRole: "engineer",
      status: "pending",
      taskPackage: { taskId, runId, phase: "implement", role: "engineer", inputs: {}, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    failTask(taskId, { runId, kind, error: `seeded ${kind}` });
  });
}

function parkOnCampaignSystem(item: CampaignItem, runId: string | undefined): void {
  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "campaign_system",
    ...(runId ? { runId } : {}),
    requestedHumanAction: "seeded campaign_system park",
  });
}

function assertItemUnchanged(campaignId: string, expectedRunId: string | undefined): void {
  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "failed", "a refused retry must not mutate the item");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "campaign_system");
  assert.equal(item.runId, expectedRunId, "a refused retry must not clear the run linkage");
  if (expectedRunId) {
    const retried = eventsForRun(expectedRunId).filter((e) => e.eventType === RETRIED_EVENT);
    assert.equal(retried.length, 0, "a refused retry must not record a campaign_system_retried audit event");
  }
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg511-campaign-system-retry-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  ensureWorkflow();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

// ── 1. POSITIVE: the full real path ───────────────────────────────────────────

test("FG-511: an abandoned run with an idle_timeout primary lands campaign_system, retry accepts on that evidence, and resume re-drives", { timeout: 20000 }, async () => {
  const campaignId = setupFullFeatureCampaign();

  const parked = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(parked.stopReason, "paused", "setup: the human gate must park the item");
  const firstRunId = listCampaignItems(campaignId)[0]!.runId!;
  const primaryTaskId = tasksForRun(firstRunId)[0]!.id;

  // The overnight blip: the container idles out and the driver dies, leaving a
  // real failed primary task and a run that never reached 'complete'.
  failTask(primaryTaskId, { runId: firstRunId, kind: "idle_timeout", error: "container idle timeout" });
  updateRunStatus(firstRunId, "abandoned");

  // Real reconcileTerminalOutcome, reached through the real resume/drive path.
  await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });

  const blocked = listCampaignItems(campaignId)[0]!;
  assert.equal(blocked.lifecycleStatus, "failed");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.blockerKind, "campaign_system", "a non-complete run lands campaign_system — the shape FG-511 recovers");
  assert.equal(blocked.runId, firstRunId, "the failed attempt's run must be retained until retry clears it");
  assert.equal(getCampaign(campaignId)!.status, "paused");

  // Pre-fix, this refused: campaign_system was not in RETRYABLE_BLOCKER_KINDS.
  const retried = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(retried.ok, true, `retry must accept provable transient evidence: ${!retried.ok ? retried.reason : ""}`);

  const reset = listCampaignItems(campaignId)[0]!;
  assert.equal(reset.lifecycleStatus, "pending", "retry must reset the item to pending");
  assert.equal(reset.outcome, undefined);
  assert.equal(reset.blockerKind, undefined);
  assert.equal(reset.runId, undefined, "retry must clear the failed attempt's run linkage");
  assert.equal(getCampaign(campaignId)!.status, "paused", "retry must not itself change campaign status");

  const auditEvents = eventsForRun(firstRunId).filter((e) => e.eventType === RETRIED_EVENT);
  assert.equal(auditEvents.length, 1, "acceptance must record exactly one distinct campaign_system_retried audit event");
  const payload = auditEvents[0]!.payload as Record<string, unknown>;
  assert.equal(payload["campaignId"], campaignId);
  assert.equal(payload["itemId"], blocked.id);
  assert.equal(payload["ticketId"], TICKET_ID);
  assert.equal(payload["runId"], firstRunId);
  assert.ok(typeof payload["decidedAt"] === "string" && (payload["decidedAt"] as string).length > 0);
  assert.deepEqual(
    payload["evidence"],
    [{ taskId: primaryTaskId, failureKind: "idle_timeout", classified: "infrastructure" }],
    "the audit event must carry the durable evidence that licensed the retry",
  );

  // The recovery: resume re-dispatches the item on a clean new run.
  await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });

  const reDriven = listCampaignItems(campaignId)[0]!;
  assert.ok(reDriven.runId, "resume must attach a new run to the retried item");
  assert.notEqual(reDriven.runId, firstRunId, "the retried item must re-dispatch on a fresh run, not the abandoned one");
  assert.equal(getRun(reDriven.runId!)!.status, "active");
  assert.equal(reDriven.lifecycleStatus, "awaiting_gate", "the re-driven run parks at its human gate — a clean re-dispatch");
  assert.equal(tasksForRun(reDriven.runId!).length, 1, "the re-dispatch must have created and driven a real task");
});

// ── 2-5. NEGATIVE: fail-closed on every missing / non-transient evidence shape ─

test("FG-511: campaign_system with no linked run is refused naming the missing run evidence — item unchanged", () => {
  const { campaignId, item } = setupPausedCampaign();
  parkOnCampaignSystem(item, undefined);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "no linked run means no durable evidence — retry must refuse");
  if (!result.ok) {
    assert.match(result.reason, /no linked run/i, `reason must name the missing run evidence, got: ${result.reason}`);
    assert.match(result.reason, /re-plan or abandon/, "reason must name the right verb for this shape");
  }
  assertItemUnchanged(campaignId, undefined);
});

test("FG-511: campaign_system whose run is 'complete' (done-audit gap) is refused naming reconcile — item unchanged", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-complete";
  seedRunWithFailedPrimaries(runId, "complete", ["idle_timeout"]);
  parkOnCampaignSystem(item, runId);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "a complete run that landed campaign_system is a done-audit/verdict gap, not a transient blip");
  if (!result.ok) {
    assert.match(result.reason, /completed/i, `reason must name the completed run, got: ${result.reason}`);
    assert.match(result.reason, /forge campaign reconcile/, "reason must name reconcile as the verb for this shape");
  }
  assertItemUnchanged(campaignId, runId);
});

test("FG-511: campaign_system whose run recorded no failed primary is refused naming the missing evidence — item unchanged", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-no-failures";
  seedRunWithFailedPrimaries(runId, "abandoned", []);
  parkOnCampaignSystem(item, runId);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "a driver that died before any task failure recorded leaves ambiguous evidence — refuse");
  if (!result.ok) {
    assert.match(result.reason, /no failed primary task/i, `reason must name the missing evidence, got: ${result.reason}`);
  }
  assertItemUnchanged(campaignId, runId);
});

test("FG-511: campaign_system whose failed primary classifies scope is refused naming the task and kind — item unchanged", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-scope";
  seedRunWithFailedPrimaries(runId, "abandoned", ["model_error"]);
  parkOnCampaignSystem(item, runId);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "a non-transient classification must never be retried behind the campaign_system placeholder");
  if (!result.ok) {
    assert.match(result.reason, new RegExp(`${runId}-task-0`), `reason must name the non-transient task, got: ${result.reason}`);
    assert.match(result.reason, /model_error/, "reason must name the failure kind");
    assert.match(result.reason, /'scope'/, "reason must name the classification");
  }
  assertItemUnchanged(campaignId, runId);
});

test("FG-511: MIXED evidence — one infrastructure and one scope failed primary — is refused (fail-closed, not majority-wins)", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-mixed";
  seedRunWithFailedPrimaries(runId, "abandoned", ["idle_timeout", "gate_rejected"]);
  parkOnCampaignSystem(item, runId);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "acceptance requires EVERY failed primary to classify transient — one scope failure refuses the whole item");
  if (!result.ok) {
    assert.match(result.reason, new RegExp(`${runId}-task-1`), `reason must name the non-transient task, got: ${result.reason}`);
    assert.match(result.reason, /gate_rejected/, "reason must name the non-transient failure kind");
    assert.match(result.reason, /'scope'/, "reason must name the non-transient classification");
  }
  assertItemUnchanged(campaignId, runId);
});

// ── 6. The inconclusive-verdict shape stays refused by the failed/blocked guard ─

test("FG-511: blocked_by_red + campaign_system (inconclusive-verdict park) is still refused by the failed/blocked guard", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-inconclusive";
  // Evidence that WOULD license a retry if the lifecycle guard ever softened.
  seedRunWithFailedPrimaries(runId, "abandoned", ["idle_timeout"]);
  updateCampaignItem(item.id, {
    lifecycleStatus: "blocked_by_red",
    outcome: undefined,
    blockerKind: "campaign_system",
    runId,
    requestedHumanAction: "inconclusive verdict",
  });

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "the inconclusive-verdict shape is not a failed/blocked item — retry must still refuse it");
  if (!result.ok) {
    assert.match(result.reason, /not currently failed/i, `the failed/blocked guard must be what refuses, got: ${result.reason}`);
  }

  const unchanged = listCampaignItems(campaignId)[0]!;
  assert.equal(unchanged.lifecycleStatus, "blocked_by_red", "a refused retry must not mutate the item");
  assert.equal(unchanged.blockerKind, "campaign_system");
  assert.equal(unchanged.runId, runId);
  assert.equal(eventsForRun(runId).filter((e) => e.eventType === RETRIED_EVENT).length, 0);
});

// ── 7. The campaign_system acceptance must not weaken the paused-campaign CAS ──

// updateCampaignItemIfCampaignPaused reads campaigns.status inside its own UPDATE,
// so a concurrent unpause landing between retryCampaignItem's up-front paused check
// and the write makes the write a no-op. Simulated by flipping the campaign to
// 'running' at the moment that statement is prepared — the same interleaving a real
// concurrent `forge campaign resume` produces.
test("FG-511: a concurrent unpause during a campaign_system acceptance refuses, leaves the item untouched, and logs no audit event", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-cas";
  seedRunWithFailedPrimaries(runId, "abandoned", ["idle_timeout"]);
  parkOnCampaignSystem(item, runId);

  let raced = false;
  const racingDb = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        if (!raced && sql.includes("UPDATE campaign_items SET")) {
          raced = true;
          target.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaignId);
        }
        return target.prepare(sql);
      };
    },
  }) as DatabaseInstance;
  setDbForTest(racingDb);

  const result = retryCampaignItem(campaignId, TICKET_ID);
  setDbForTest(db);

  assert.ok(raced, "the race must actually have been injected");
  assert.equal(result.ok, false, "a campaign_system acceptance must still lose the CAS to a concurrent unpause");
  if (!result.ok) assert.match(result.reason, /no longer paused/i);

  const unchanged = listCampaignItems(campaignId)[0]!;
  assert.equal(unchanged.lifecycleStatus, "failed", "the lost CAS must leave the item exactly as it was");
  assert.equal(unchanged.blockerKind, "campaign_system");
  assert.equal(unchanged.runId, runId);
  assert.equal(
    eventsForRun(runId).filter((e) => e.eventType === RETRIED_EVENT).length,
    0,
    "no audit event may be logged for a reset that never landed",
  );
});

// ── Regression: the auth/infrastructure fast path takes no evidence probe ──────

test("FG-511: the auth fast path still accepts with NO run linkage — its blockerKind already IS the classification", () => {
  const { campaignId, item } = setupPausedCampaign();
  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "auth",
    runId: undefined,
    requestedHumanAction: "auth expired",
  });

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, true, "the auth fast path must not be gated on the campaign_system evidence probe");
  assert.equal(listCampaignItems(campaignId)[0]!.lifecycleStatus, "pending");
});

test("FG-511: scope is still refused outright — no evidence probe, no widening beyond campaign_system", () => {
  const { campaignId, item } = setupPausedCampaign();
  const runId = "run-fg511-scope-blocker";
  // Transient underlying evidence must NOT rescue a scope-blocked item: only the
  // campaign_system placeholder earns the probe.
  seedRunWithFailedPrimaries(runId, "abandoned", ["idle_timeout"]);
  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind: "scope",
    runId,
    requestedHumanAction: "reviewer failed the item",
  });

  const result = retryCampaignItem(campaignId, TICKET_ID);
  assert.equal(result.ok, false, "scope stays refused regardless of the underlying run's evidence");
  if (!result.ok) assert.match(result.reason, /which is not retryable/);
  assert.equal(listCampaignItems(campaignId)[0]!.lifecycleStatus, "failed");
  assert.equal(eventsForRun(runId).filter((e) => e.eventType === RETRIED_EVENT).length, 0);
});
