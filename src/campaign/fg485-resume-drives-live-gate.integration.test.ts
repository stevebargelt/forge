// FG-485 end-to-end integration test.
//
// Sibling of FG-475: FG-475 fixed the case where a gate REJECT with no
// on_reject left a run permanently stuck (resume spun/wedged). This ticket is
// about a run that is very much alive — the operator decided a human gate
// in-run (`forge gate <task> request-changes` or `forge gate <task> advance`)
// and then ran `forge campaign resume`. Before this fix, executor.ts's
// awaiting_gate reattach branch (the FG-441/FG-460 shape: lifecycleStatus
// 'awaiting_gate', no blockerKind, a runId set) evaluated OUT-OF-BAND SHIP
// ELIGIBILITY first — logging `campaign_item.evidence_reconcile_refused` and
// re-parking the item — even though the run had real dispatchable work
// (a pending gate-replacement primary after request-changes, or a newly-ready
// next phase after advance) that the SAME resume call's driveWorkflowItem path
// could have picked up. The fix reorders the branch to check run liveness
// (computeReadyQueue against the real run/tasks) BEFORE evaluating evidence:
// only a run that's absent, not active, or settled with nothing left to
// dispatch reaches the evidence fallback.
//
// This test exercises the REAL driveRemainingItems/resumeCampaign, the REAL
// v2/gate.ts gate() request-changes/advance, and the REAL v2/runNext.ts
// runNext() (only the docker exec boundary is stubbed, per the project's
// existing DockerExecFn test-injection pattern — see
// fg475-gate-reject-resume.integration.test.ts, which this file's harness
// mirrors). It does NOT mock computeReadyQueue or evaluateInvokeLaneEligibility
// — those are exactly the functions whose ordering is under test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import { gate } from "../v2/gate.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg485-test-runtime";
const WORKFLOW_NAME = "fg485-campaign-feature";

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

// Real runtime YAML so runNext's dispatch machinery resolves cleanly — mirrors
// fg475-gate-reject-resume.integration.test.ts's ensureRuntime helper.
function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-485 integration test runtime stub
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

// Real workflow YAML: architect (gate:human) -> engineer (gate:auto). architect
// has no on_reject — matches FG-481's real shape (architect human gate parking
// the run, decided in-run by the operator).
function ensureWorkflow(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-485 integration test workflow — architect human gate, decided in-run
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

// Real git plumbing for evaluateInvokeLaneEligibility's composeOutOfBandEligibility
// check — mirrors executor.integration.test.ts's gitExec/makeShipCommit helpers.
function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function seedTicket(ticketId: string): void {
  writeTicket(projectDir, {
    id: ticketId,
    type: "story",
    status: "active",
    title: `${ticketId}: FG-485 repro — full_feature item parked at architect human gate`,
    body: "## Problem\nNeeds an architecture decision before implementation.\n\n## Goal\nA reviewed architecture plan exists.\n\n## Acceptance Criteria\n- Architect step produces a plan\n",
  });
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses it");
};

const exec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", files_modified: [] }));
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  return 0;
};

// Wraps the REAL runNext with the dockerExec stub, capped against a runaway
// drive loop — same test-harness-safety pattern as FG-475's test (not a mock
// of anything under test).
function makeCappedRunNext(cap: number) {
  let calls = 0;
  return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    calls++;
    if (calls > cap) {
      throw new Error(
        `FG-485 test safety guard: runNext was called ${calls} times in a single drive. A correct drive never needs more than a small, bounded number of calls per item.`,
      );
    }
    return runNext({ ...args, dockerExec: exec });
  };
}

function refusalEvents(runId: string) {
  return eventsForRun(runId).filter((e) => e.eventType === "campaign_item.evidence_reconcile_refused");
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg485-campaign-resume-"));
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

// Dispatches a fresh single-item full_feature campaign through the REAL
// startCampaign until it parks at the architect human gate. Returns the
// parked architect task so the test can decide the gate in-run.
async function startAndParkAtArchitectGate(ticketId: string) {
  seedTicket(ticketId);
  const itemOverrides: Record<string, ItemModeOverride> = {
    [ticketId]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-485 test: full_feature repro" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved for FG-485 repro" });

  const setupResult = await startCampaign(campaign.id, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
  });
  assert.equal(setupResult.stopReason, "paused", "setup: campaign must park at the architect human gate");
  assert.equal(setupResult.itemRecords[0]!.lifecycleStatus, "awaiting_gate");

  const item = listCampaignItems(campaign.id).find((i) => i.ticketId === ticketId)!;
  assert.equal(item.lifecycleStatus, "awaiting_gate");
  assert.equal(item.blockerKind, undefined, "setup: no blockerKind — this is the FG-441/FG-460/FG-485 manually-driven shape");
  const runId = item.runId!;
  assert.ok(runId, "setup: item must have a run attached");

  const architectTask = tasksForRun(runId).find((t) => t.agentRole === "architect" && t.parentId === undefined)!;
  assert.equal(architectTask.status, "awaiting_gate");

  return { campaign, item, runId, architectTask };
}

test(
  "FG-485 integ: campaign resume dispatches a pending gate-replacement primary (request-changes) and continues driving — no ship-evidence refusal",
  { timeout: 20000 },
  async () => {
    const { campaign, item, runId, architectTask } = await startAndParkAtArchitectGate("FG-481");

    // ── The operator's in-run gate decision: request-changes on the parked
    // architect task. This fails the old task and seeds a fresh PENDING
    // replacement primary in the SAME phase (v2/gate.ts's request-changes
    // branch) — the exact shape campaign resume must pick up and dispatch.
    await gate(architectTask.id, "request-changes", "architect: rework the data model before proceeding", {});

    const tasksAfterGate = tasksForRun(runId);
    const replacement = tasksAfterGate.find((t) => t.phase === "architect" && t.parentId === undefined && t.status === "pending");
    assert.ok(replacement, "setup: request-changes must seed a pending replacement primary");
    assert.notEqual(replacement!.id, architectTask.id, "setup: replacement must be a NEW task, not the failed original");

    // ── The fix under test: campaign resume must dispatch the replacement and
    // continue driving the run within this SAME call, not evaluate ship
    // evidence against a ticket/run that was never going to have any yet.
    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });

    assert.ok(resumeResult, "resume must return normally");
    assert.equal(resumeResult.stopReason, "paused", "architect is gate:human — the run re-parks at the (new) architect gate after executing the replacement");

    // The evidence-refusal path must NEVER have fired for this item/run — this
    // is the exact misleading signal FG-485 reported ("refusing to ship and
    // re-parking" against evidence that could never exist yet).
    assert.deepEqual(
      refusalEvents(runId),
      [],
      "FG-485: campaign_item.evidence_reconcile_refused must not fire when the run has live dispatchable work"
    );

    // The replacement primary was actually picked up and driven — it moved off
    // 'pending' (re-parked at awaiting_gate after executing, since architect is
    // gate:human) rather than sitting untouched, which is what FG-485 reported
    // ("the pending replacement was never dispatched").
    const replacementAfter = tasksForRun(runId).find((t) => t.id === replacement!.id)!;
    assert.equal(replacementAfter.status, "awaiting_gate", "FG-485: the pending replacement must be dispatched and re-parked, not left pending");

    const itemAfter = getCampaignItem(item.id)!;
    assert.equal(itemAfter.lifecycleStatus, "awaiting_gate");
    assert.equal(itemAfter.blockerKind, undefined);
    assert.match(itemAfter.requestedHumanAction ?? "", /architect/);

    const runAfter = getRun(runId)!;
    assert.equal(runAfter.status, "active", "FG-485: the run is still alive, mid-drive — not terminal");
  }
);

test(
  "FG-485 integ: campaign resume drives the next phase after an in-run gate advance — no ship-evidence refusal",
  { timeout: 20000 },
  async () => {
    const { campaign, item, runId, architectTask } = await startAndParkAtArchitectGate("FG-482");

    // ── The operator's in-run gate decision: advance the parked architect
    // task. This marks it complete and (per v2/gate.ts's advance branch) tries
    // to finalize the run — but engineer's ready-queue slot is still open, so
    // the run stays active with a newly-dispatchable next phase and no task
    // row for it yet.
    await gate(architectTask.id, "advance", "architect: plan approved", {});

    const architectAfterGate = tasksForRun(runId).find((t) => t.id === architectTask.id)!;
    assert.equal(architectAfterGate.status, "complete");
    assert.equal(
      tasksForRun(runId).some((t) => t.phase === "engineer"),
      false,
      "setup: engineer has no task row yet — it only becomes ready via computeReadyQueue's deps-met/no-row branch"
    );

    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });
    assert.ok(resumeResult, "resume must return normally");

    // The evidence-refusal path must never fire — resume must drive the next
    // phase instead of re-parking on ship evidence.
    assert.deepEqual(
      refusalEvents(runId),
      [],
      "FG-485: campaign_item.evidence_reconcile_refused must not fire when resume can still drive the next phase"
    );

    // engineer (gate:auto) was actually dispatched and completed — proof the
    // drive loop re-entered and ran computeReadyQueue's newly-ready step,
    // rather than stopping cold at the evidence check.
    const engineerTask = tasksForRun(runId).find((t) => t.phase === "engineer" && t.parentId === undefined);
    assert.ok(engineerTask, "FG-485: engineer must have been dispatched by this resume call");
    assert.equal(engineerTask!.status, "complete", "engineer is gate:auto — it self-advances once dispatched");

    // Both steps settled — the run reached a terminal status in this SAME
    // resume call (whatever the eventual campaign-item classification, the
    // point under test is that driving actually happened).
    const runAfter = getRun(runId)!;
    assert.equal(runAfter.status, "complete", "FG-485: the run must reach a terminal status once both phases settle, all within this resume call");

    const itemAfter = getCampaignItem(item.id)!;
    assert.notEqual(itemAfter.lifecycleStatus, "awaiting_gate", "FG-485: the item must move off awaiting_gate once the run settles — never re-parked on stale evidence");
  }
);

test(
  "FG-485 regression floor: an awaiting_gate item whose run is absent/terminal (no dispatchable work) still reaches the out-of-band evidence fallback and refuses/re-parks exactly as before",
  async () => {
    // Mirrors reconcile.integration.test.ts's setupAwaitingGateManualRunCampaign
    // shape (FG-441/FG-460): lifecycleStatus='awaiting_gate', no blockerKind, a
    // runId set — but with NO row in the runs table, i.e. a run that is not
    // live in any sense a driveWorkflowItem re-entry could use. This is the
    // genuinely manually-driven/out-of-band case the evidence fallback exists
    // for, and it must be completely unaffected by the FG-485 liveness check.
    const ticketId = "FG-483terminal";
    writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
    const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
    approveCampaign(campaign.id, { rationale: "approved" });
    const item = listCampaignItems(campaign.id)[0]!;
    const runId = `run-${item.id}`;
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(runId, item.id);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

    // No evidence seeded at all — ticket is not done, no closedCommit, no
    // host-verification, no authoritative verdict. This must refuse, exactly
    // like the pre-fix behavior for this shape.
    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
    });

    assert.ok(resumeResult, "resume must return normally");
    const refusals = refusalEvents(runId);
    assert.equal(refusals.length, 1, "FG-485: the evidence fallback must still fire exactly once for a genuinely terminal/absent run");

    const itemAfter = getCampaignItem(item.id)!;
    assert.equal(itemAfter.lifecycleStatus, "awaiting_gate", "FG-485: item stays re-parked at awaiting_gate — unchanged fallback behavior");
    assert.notEqual(itemAfter.outcome, "shipped");
  }
);

test(
  "FG-485 Finding 1 regression: an ACTIVE run whose workflow fails to load routes straight to recovery_needed — never the evidence path",
  { timeout: 20000 },
  async () => {
    const { campaign, item, runId } = await startAndParkAtArchitectGate("FG-484loadfail");

    const runBefore = getRun(runId)!;
    assert.equal(runBefore.status, "active", "setup: run must still be active going into resume — this is the liveness probe's active-run branch");

    // Simulates an infra/load failure (corrupt/missing workflow file, etc.) for
    // the SAME run the FG-485 liveness probe just found active. Before the
    // fix, this failure was swallowed inside the probe's try/catch and the
    // item fell through to the out-of-band evidence path, emitting a FALSE
    // evidence_reconcile_refused for a run that was never settled — it was
    // simply failing to load. The fix must route this straight to the same
    // recovery_needed handling the pre-existing loadWorkflow retry uses.
    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
      loadWorkflowFn: () => {
        throw new Error("FG-485 test: simulated workflow load failure");
      },
    });

    assert.ok(resumeResult, "resume must return normally");
    assert.equal(
      resumeResult.stopReason,
      "recovery_needed",
      "FG-485 Finding 1: an ACTIVE run whose workflow fails to load must return recovery_needed"
    );

    assert.deepEqual(
      refusalEvents(runId),
      [],
      "FG-485 Finding 1: campaign_item.evidence_reconcile_refused must never fire for an ACTIVE run that merely failed to load"
    );

    const campaignAfter = getCampaign(campaign.id)!;
    assert.equal(campaignAfter.status, "paused", "FG-485 Finding 1: campaign must transition running->paused on the load failure, same as the pre-existing retry path");

    const itemAfter = getCampaignItem(item.id)!;
    assert.equal(itemAfter.lifecycleStatus, "awaiting_gate", "item must remain parked, untouched by the evidence path");
    assert.notEqual(itemAfter.outcome, "shipped");
  }
);

test(
  "FG-486: an awaiting_gate item on an ACTIVE invoke-family run skips the liveness probe entirely and still reaches the evidence path",
  { timeout: 20000 },
  async () => {
    // Same last-item-pause-boundary shape as executor.integration.test.ts's FG-441 test
    // (CAS lost the race: item ships-eligible but the campaign-running-gated
    // write is a no-op because dispatch already paused the campaign, so the
    // item parks awaiting_gate/no blockerKind with its run left 'active') —
    // but here the run is invoke-family ("invoke"), which has no loadable YAML
    // workflow at all. Before FG-486, resume's liveness probe would still try
    // to doLoadWorkflow this run and misroute the reattach to recovery_needed.
    const ticketId = "FG-486invoke";
    gitExec(["init", "-b", "main"], projectDir);
    // Base commit so the ship commit below has exactly one parent — a root
    // commit is ambiguous and safe-denies in commitTouchesOnlyNonCodePaths
    // (see executor.integration.test.ts's beforeEach, which does the same for makeShipCommit).
    writeFileSync(join(projectDir, "base.txt"), "base");
    gitExec(["add", "."], projectDir);
    gitExec(["commit", "-m", "init"], projectDir);
    writeTicket(projectDir, {
      id: ticketId,
      type: "story",
      status: "active",
      title: `${ticketId}: FG-486 invoke-family reattach repro`,
      body: "## Problem\nNeeds a small reviewed change.\n\n## Goal\nChange is reviewed and shipped.\n\n## Acceptance Criteria\n- Change is reviewed\n",
    });

    const itemOverrides: Record<string, ItemModeOverride> = {
      [ticketId]: { executionMode: "invoke", agentRole: "engineer" },
    };
    const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId], itemOverrides }, { projectDir, mode: "sequential" });
    approveCampaign(campaign.id, { rationale: "approved for FG-486 invoke-family repro" });

    const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
      writeFileSync(join(projectDir, `${ticketId}-ship.md`), `${ticketId} shipped`);
      gitExec(["add", "."], projectDir);
      gitExec(["commit", "-m", `ship ${ticketId}`], projectDir);
      const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
      closeTicket(projectDir, ticketId, commit);
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
    };

    const setupResult = await startCampaign(campaign.id, { dispatch });
    assert.equal(setupResult.stopReason, "paused", "setup: last item completes but campaign is already paused mid-item");

    const item = listCampaignItems(campaign.id).find((i) => i.ticketId === ticketId)!;
    assert.equal(item.lifecycleStatus, "awaiting_gate", "setup: CAS lost the race — item parks awaiting_gate (FG-441 shape)");
    assert.equal(item.blockerKind, undefined);
    const runId = item.runId!;
    const runBefore = getRun(runId)!;
    assert.equal(runBefore.status, "active", "setup: invoke-family runs are never marked terminal on their own — the run stays active");
    assert.equal(runBefore.workflow, "invoke", "setup: this is the invoke-family shape under test, not a pipeline run");

    // The fix under test: resume must never attempt to load a workflow for
    // this run (there is none to load) — it must skip the FG-485 liveness
    // probe entirely and go straight to the FG-441/FG-483 evidence path.
    // loadWorkflowFn throws so any probe attempt would surface as
    // recovery_needed instead of the expected complete.
    const resumeResult = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      loadWorkflowFn: () => {
        throw new Error("FG-486: the liveness probe must never attempt to load a workflow for an invoke-family run");
      },
    });

    assert.equal(
      resumeResult.stopReason,
      "complete",
      "FG-486: invoke-family active run must reach the evidence path directly (no probe) and ship"
    );
    assert.deepEqual(
      refusalEvents(runId),
      [],
      "FG-486: evidence is eligible — the reattach must ship, not refuse"
    );

    const itemAfter = getCampaignItem(item.id)!;
    assert.equal(itemAfter.lifecycleStatus, "complete");
    assert.equal(itemAfter.outcome, "shipped");
  }
);
