// FG-475 end-to-end integration test.
//
// Reproduces campaign-e89beee993ec's exact wedge: a sequential campaign with a
// full_feature item (FG-425 analog) whose architect step has no on_reject. The
// operator defers the item by rejecting the architect gate (a manual "forge
// gate reject"). Before the fix (src/v2/ready-queue.ts's isRunSettled helper,
// consumed by gate.ts's reject branch and both of runNext.ts's "is the run
// done" checks, plus executor.ts's reconcileTerminalOutcome classifying
// gate_rejected as scope/LOCAL instead of defaulting to campaign_system/SHARED)
// this left the run stuck at status "active" forever with the campaign item
// wedged at lifecycle_status='awaiting_gate' — `forge campaign resume` printed
// ONE "refusing to ship and re-parking" line and then spun forever inside
// driveWorkflowItem's while(true) loop calling runNext() with a permanently
// empty ready queue (zero I/O per call — a real hang, not a fast failure).
//
// This test exercises the REAL driveRemainingItems/resumeCampaign, the REAL
// v2/gate.ts gate() reject, and the REAL v2/runNext.ts runNext() (only the
// docker exec boundary is stubbed, per the project's existing DockerExecFn
// test-injection pattern — see fg381-dispatch.integration.test.ts). It does
// NOT mock computeReadyQueue/isRunSettled/reconcileTerminalOutcome — those are
// exactly the functions under test.
//
// Against the pre-fix tree, the exact same sequence below (startCampaign ->
// gate(reject) -> resumeCampaign) reproduces the infinite drive loop: gate()'s
// reject branch never finalizes the run, so it stays "active"; resumeCampaign
// falls through to driveWorkflowItem, which calls runNextFn every iteration
// forever (ready queue is permanently empty, run.status never changes). A
// bare `while(true)` matching that shape cannot be given a normal test
// timeout and be trusted to fire (a tight microtask loop with zero real I/O
// can starve Node's timer phase — which is exactly why the real incident
// required a manual process-tree kill, not a timeout). So instead of racing a
// timer against the hang, the injected runNextFn counts its own calls and
// throws a clear, fast, deterministic error once the count exceeds what any
// correct single-wave-per-park drive could need. This is test-harness safety,
// not a mock of the fix under test: the real runNext still runs on every
// call that is made.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import { gate } from "../v2/gate.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg475-test-runtime";
const WORKFLOW_NAME = "fg475-campaign-feature";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

const SAVED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
] as const;
const savedEnv: Partial<Record<(typeof SAVED_ENV_KEYS)[number], string>> = {};

// Real runtime YAML so runNext's dispatch machinery (resolveModel, auth
// resolution, buildDockerArgs) resolves cleanly — mirrors
// fg381-dispatch.integration.test.ts's ensureRuntime helper.
function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-475 integration test runtime stub
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

// Real workflow YAML — gate.ts's reject branch loads the workflow BY NAME from
// disk (loadWorkflow(run.workflow, {projectDir})), independent of the campaign
// executor's own (also real, in this test) loadWorkflow call. Writing one real
// file lets both call sites resolve the identical definition. architect has NO
// on_reject — exactly campaign-e89beee993ec's shape (FG-425's architect gate).
function ensureWorkflow(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-475 integration test workflow — architect gate-reject with no on_reject
inputs: []
steps:
  - id: architect
    agent: architect
    gate: human
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds: []
  - id: engineer
    agent: engineer
    gate: auto
    manual: false
    depends_on: [architect]
    runtime: ${RUNTIME_NAME}
    reds: []
`,
  );
}

// FG-925 analog (full_feature, architect gate about to be rejected) declares a
// non-empty `related` so relationToBlocked resolves FG-914 (unrelated) as
// "independent" (continue_allowed even in sequential mode) and FG-930 (whose
// id IS in this list) as "dependent" (hold_dependents) — see policy.ts.
function seedTickets(): void {
  writeTicket(projectDir, {
    id: "FG-925",
    type: "story",
    status: "active",
    title: "FG-925 analog: full_feature item whose architect gate gets rejected",
    related: ["FG-930"],
    body: "## Problem\nNeeds an architecture decision before implementation.\n\n## Goal\nA reviewed architecture plan exists.\n\n## Acceptance Criteria\n- Architect step produces a plan\n",
  });
  writeTicket(projectDir, {
    id: "FG-914",
    type: "story",
    status: "active",
    title: "FG-914 analog: independent pending item",
    body: "## Problem\nUnrelated backlog bookkeeping needs recording.\n\n## Goal\nThe ticket is filed for follow-up.\n\n## Acceptance Criteria\n- Ticket recorded\n",
  });
  writeTicket(projectDir, {
    id: "FG-930",
    type: "story",
    status: "active",
    title: "FG-930 analog: item dependent on FG-925",
    body: "## Problem\nDepends on FG-925's architecture output.\n\n## Goal\nImplement on top of FG-925's plan.\n\n## Acceptance Criteria\n- Builds on FG-925\n",
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg475-campaign-resume-"));
  for (const k of SAVED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime(RUNTIME_NAME);
  ensureWorkflow();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

test(
  "FG-475 integ: campaign resume auto-reconciles a gate-reject-terminal full_feature run in ONE call — no hang, LOCAL blocker (not campaign_system), independent item advances, dependent item held",
  { timeout: 20000 },
  async () => {
    seedTickets();

    const itemOverrides: Record<string, ItemModeOverride> = {
      "FG-925": { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-475 test: full_feature repro" },
      "FG-914": { lane: "ticketing_only", laneRationale: "FG-475 test: independent item" },
    };
    const { campaign } = planCampaign(
      { kind: "list", ticketIds: ["FG-925", "FG-914", "FG-930"], itemOverrides },
      { projectDir, mode: "sequential" }
    );
    approveCampaign(campaign.id, { rationale: "approved for FG-475 repro" });

    const exec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", files_modified: [] }));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    // Wraps the REAL runNext with the dockerExec stub. Never fakes run/task
    // settledness itself — it only guards against the pre-fix scenario where
    // driveWorkflowItem's while(true) would call this forever.
    function makeCappedRunNext(cap: number) {
      let calls = 0;
      return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
        calls++;
        if (calls > cap) {
          throw new Error(
            `FG-475 test safety guard: runNext was called ${calls} times in a single drive without the run ` +
              `reaching a terminal status. This is the pre-fix infinite-hang shape (driveWorkflowItem's ` +
              `while(true) loop spinning on a permanently-empty, never-settling ready queue) — not genuine ` +
              `progress. A fixed campaign resume never needs more than a small, bounded number of runNext ` +
              `calls per item.`
          );
        }
        return runNext({ ...args, dockerExec: exec });
      };
    }

    const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
      throw new Error("opts.dispatch must not be called — full_feature and ticketing_only lanes never use it");
    };

    // ── Setup: dispatch FG-925 through the REAL full_feature path until it
    // parks at the architect human gate — matches the evidence exactly (FG-425's
    // architect gate awaiting human review before the operator's manual reject).
    const setupResult = await startCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });
    assert.equal(setupResult.stopReason, "paused", "setup: campaign must park at the architect human gate");
    assert.equal(setupResult.itemRecords.length, 1, "setup: only FG-925 dispatched so far — FG-914/FG-930 untouched");
    assert.equal(setupResult.itemRecords[0]!.lifecycleStatus, "awaiting_gate");

    const itemsBefore = listCampaignItems(campaign.id);
    const item925Before = itemsBefore.find((i) => i.ticketId === "FG-925")!;
    const item914Before = itemsBefore.find((i) => i.ticketId === "FG-914")!;
    const item930Before = itemsBefore.find((i) => i.ticketId === "FG-930")!;
    assert.equal(item925Before.lifecycleStatus, "awaiting_gate", "setup: FG-925 parked at awaiting_gate — matches evidence exactly");
    assert.equal(item914Before.lifecycleStatus, "pending");
    assert.equal(item930Before.lifecycleStatus, "pending");

    const runId = item925Before.runId!;
    assert.ok(runId, "setup: FG-925 must have a run attached");
    const architectTask = tasksForRun(runId).find((t) => t.agentRole === "architect")!;
    assert.equal(architectTask.status, "awaiting_gate");

    // ── The operator's manual defer: reject the architect gate (a real "forge
    // gate reject"). architect has no on_reject, so this is exactly
    // campaign-e89beee993ec's shape: the ONLY way to drive this run further is
    // now gone, but the campaign item is untouched (still awaiting_gate).
    await gate(architectTask.id, "reject", "operator deferring FG-925 — reworking direction", {});

    // ── The bug: campaign resume must reconcile the wedged item AND advance
    // independent work, all within this ONE call — never hang.
    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });

    // (1) terminates — reaching this line without the safety guard firing
    // already proves no hang; assert the shape explicitly too.
    assert.ok(resumeResult, "resume must return normally, not hang");
    assert.equal(resumeResult.itemRecords.length, 3, "all three items must be evaluated within this single resume call");

    // (2) FG-925's run reached a terminal status and the item is reconciled to
    // a scoped LOCAL blocker — not left at awaiting_gate, not campaign_system.
    const runAfter = getRun(runId)!;
    assert.equal(runAfter.status, "complete", "FG-475: the gate-rejected run must reach a terminal status, not stay active forever");

    const item925After = getCampaignItem(item925Before.id)!;
    assert.equal(item925After.lifecycleStatus, "failed", "FG-475: item must be reconciled off awaiting_gate");
    assert.equal(item925After.outcome, "blocked");
    assert.equal(
      item925After.blockerKind,
      "scope",
      "FG-475: gate_rejected must classify as scope (LOCAL) via classifyFailureKind, never default to campaign_system (SHARED)"
    );

    // (3) the campaign is NOT paused by FG-925's LOCAL blocker alone — proven
    // by FG-914 actually advancing past pending in this SAME resume call.
    const item914After = getCampaignItem(item914Before.id)!;
    assert.equal(
      item914After.lifecycleStatus,
      "complete",
      "FG-475: the independent item must advance past 'pending' in the same resume call — a LOCAL blocker only holds dependents"
    );
    assert.equal(item914After.outcome, "skipped");

    // (5) the dependent item is held (continuePolicy hold_dependents) rather
    // than dispatched — dependency policy is unchanged by this fix.
    const item930After = getCampaignItem(item930Before.id)!;
    assert.equal(item930After.lifecycleStatus, "pending", "FG-475: held items keep pending lifecycle, never dispatched");
    assert.equal(item930After.outcome, "held");
    assert.equal(item930After.continuePolicy, "hold_dependents");
    assert.equal(item930After.runId, undefined, "FG-475: the dependent item must never be dispatched");

    // ── Idempotency: FG-930 is still held, so driveRemainingItems re-pauses the
    // campaign (anyHeld) rather than completing it — `campaign.status` is
    // 'paused' again, meaning a second `forge campaign resume` is a legitimate,
    // commonly-run operator action (re-checking after `campaign show`, or a
    // scripted retry). It must not re-drive the already-terminal FG-925/FG-914
    // items, must not exceed the safety cap, and must leave every item's
    // reconciled state unchanged.
    const campaignAfterFirstResume = getCampaign(campaign.id)!;
    assert.equal(
      campaignAfterFirstResume.status,
      "paused",
      "setup for idempotency check: FG-930 remains held, so the campaign must re-pause (not complete) after the first resume"
    );

    const secondResumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });
    assert.equal(
      secondResumeResult.stopReason,
      "paused",
      "FG-475 idempotency: a second resume call must reach the same stopReason, not error or hang"
    );

    const item925Twice = getCampaignItem(item925Before.id)!;
    assert.equal(item925Twice.lifecycleStatus, "failed", "FG-475 idempotency: already-reconciled item must not be re-driven");
    assert.equal(item925Twice.blockerKind, "scope", "FG-475 idempotency: re-driving must not reclassify the already-reconciled item");

    const item914Twice = getCampaignItem(item914Before.id)!;
    assert.equal(item914Twice.lifecycleStatus, "complete", "FG-475 idempotency: already-complete independent item must not be redispatched");

    const item930Twice = getCampaignItem(item930Before.id)!;
    assert.equal(item930Twice.lifecycleStatus, "pending");
    assert.equal(item930Twice.outcome, "held", "FG-475 idempotency: dependent item must remain held, not dispatched, on re-drive");
  }
);
