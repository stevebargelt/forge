// FG-484: missing AC test — the campaign shape. driveWorkflowItem auto-advances
// awaiting_gate tasks whose step is gate:auto/none with no operator present
// (executor.ts's `if (gateType === "auto" || gateType === "none") { await
// doGate(...) }`). A concurrent `forge cancel` racing in right as that
// auto-advance call goes out must never let the run get resurrected from
// "abandoned" back to "complete" — this drives that race through the REAL
// executor (startCampaign/resumeCampaign/driveWorkflowItem) and the REAL
// v2/gate.ts gate(), injecting the concurrent cancel via the injectable gateFn
// startCampaign/resumeCampaign already support (the same test-injection seam
// fg475-gate-reject-resume.integration.test.ts uses).
//
// v2/runNext.ts's finalizePrimary always completes a gate:auto/none step
// directly — it never leaves one at awaiting_gate — so reaching driveWorkflowItem's
// auto-advance branch for real requires the workflow's gate declaration to read
// "auto" AT DRIVE TIME while the task is still sitting at awaiting_gate from an
// earlier drive. driveWorkflowItem reloads the workflow definition from disk by
// name on every call (doLoadWorkflow), independent of whatever gate type was in
// effect when the task first parked — so this test drives the step to
// awaiting_gate for real under gate:human, then rewrites the on-disk workflow
// step to gate:auto (as an operator editing the workflow between drives would),
// then resumes: the resulting auto-advance-with-no-operator shape is exercised
// through real code.
//
// The concurrent cancel itself is primed as a direct store-layer write
// (updateRunStatus(runId, "abandoned")) rather than the real cli/commands/
// cancel.ts performCancel — deliberately: real cancel always fails the
// still-"awaiting_gate" task BEFORE abandoning the run, and gate()'s own
// `status !== "awaiting_gate"` guard would then refuse the auto-advance call
// outright, before it ever reaches finalizeRunIfDone/completeRun's CAS (see
// src/v2/runNext.integration.test.ts's "realistic" FG-484 gate variant, which proves
// exactly that path — a real cancel makes the CAS itself unreachable for
// gate.ts's call site). Priming the run's abandon directly, with the task left
// untouched at awaiting_gate, is the only way to drive gate()'s auto-advance
// all the way through its internal task-complete write to finalizeRunIfDone,
// which is what actually exercises the CAS this ticket is about — mirroring
// the synthetic/store-level-guard convention runNext.integration.test.ts already uses for
// the same reason (see that file's "(synthetic store-level guard)" test).
// Sanity-checked: this test fails against the pre-fix tree (the run gets
// resurrected to "complete" and a second, spurious completion notification
// fires) and passes once the CAS backstop is in place.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, listCampaignItems } from "../store/campaigns.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import { gate } from "../v2/gate.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg484-test-runtime";
const WORKFLOW_NAME = "fg484-campaign-auto-gate";
const TICKET_ID = "FG-810";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let wfPath: string;

const ENV_KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN", "NTFY_PRIORITY", "NO_NOTIFY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-484 integration test runtime stub
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

function writeWorkflow(gateType: "human" | "auto"): void {
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-484 campaign auto-gate cancel race regression test
inputs: []
steps:
  - id: implement
    agent: engineer
    gate: ${gateType}
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds: []
`,
  );
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg484-campaign-race-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime(RUNTIME_NAME);
  const forgeHome = process.env.FORGE_HOME!;
  wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeWorkflow("human"); // start under a human gate — parks awaiting_gate for real
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

test(
  "FG-484 campaign: driveWorkflowItem auto-advancing a gate:auto step interleaved with a real `forge cancel` abandoning the run must not resurrect it to complete",
  { timeout: 20000 },
  async () => {
    writeTicket(projectDir, {
      id: TICKET_ID,
      type: "story",
      status: "active",
      title: "FG-484 campaign auto-gate cancel race",
      body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
    });
    const itemOverrides: Record<string, ItemModeOverride> = {
      [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-484 test: auto-gate cancel race" },
    };
    const { campaign } = planCampaign(
      { kind: "list", ticketIds: [TICKET_ID], itemOverrides },
      { projectDir, mode: "sequential" }
    );
    approveCampaign(campaign.id, { rationale: "FG-484 test" });

    const exec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
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
          throw new Error(`FG-484 test safety guard: runNext called ${calls} times without settling`);
        }
        return runNext({ ...args, dockerExec: exec });
      };
    }

    const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
      throw new Error("opts.dispatch must not be called — full_feature never uses it");
    };

    // ── Setup: drive the real gate:human step to a genuine awaiting_gate park.
    const setupResult = await startCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });
    assert.equal(setupResult.stopReason, "paused", "setup: must park at the human gate");
    const item = listCampaignItems(campaign.id)[0]!;
    assert.equal(item.lifecycleStatus, "awaiting_gate");
    const runId = item.runId!;
    assert.ok(runId, "setup: the item must have a run attached");
    const task = getTask(tasksForRun(runId)[0]!.id)!;
    assert.equal(task.status, "awaiting_gate");

    // ── An operator flips the step to gate:auto on disk between drives (or,
    // equivalently, any future change that makes this exact step read as
    // auto/none at drive time while a task is still parked awaiting_gate).
    // driveWorkflowItem reloads the workflow fresh on every call, so the next
    // resume sees this task as an unattended auto-advance candidate.
    writeWorkflow("auto");

    // Enable ntfy + mock fetch so "no completion notification fires" is
    // actually provable (under the suite's default NO_NOTIFY=true,
    // notifyOnRunTransition short-circuits either way, silently).
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
    delete process.env["NO_NOTIFY"];
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));

    let cancelled = false;
    const raceGateFn: typeof gate = async (taskId, decision, rationale, opts) => {
      if (!cancelled) {
        cancelled = true;
        // A concurrent `forge cancel` wins the race for the run row right as
        // driveWorkflowItem's unattended auto-advance call goes out — the
        // task is left exactly as it was (still "awaiting_gate"; see the file
        // header for why that's the only way to actually reach gate.ts's
        // finalizeRunIfDone/completeRun CAS here).
        updateRunStatus(runId, "abandoned");
      }
      return gate(taskId, decision, rationale, opts);
    };

    let resumeResult;
    try {
      resumeResult = await resumeCampaign(campaign.id, {
        dispatch: dispatchMustNotBeCalled,
        runNextFn: makeCappedRunNext(10),
        gateFn: raceGateFn,
      });
    } finally {
      fetchMock.mock.restore();
    }
    assert.ok(resumeResult, "resume must return normally, not throw");

    await new Promise((r) => setImmediate(r));

    const run = getRun(runId)!;
    assert.equal(run.status, "abandoned", "FG-484 campaign: the run must stay abandoned, never resurrected to complete");
    assert.equal(getTask(task.id)!.status, "complete", "gate()'s own advance write still completes the task — only the RUN's finalize is disputed by the race");

    const events = eventsForRun(runId).map((e) => e.eventType);
    assert.ok(!events.includes("run.completed"), "FG-484 campaign: no run.completed event may fire for the auto-advance that raced a concurrent abandon");

    // The concurrent cancel's OWN "run abandoned" notification is expected
    // and legitimate. What must never additionally appear is a "complete"
    // notification — that would be the resurrection this test guards against.
    const titles = fetchMock.mock.calls.map(
      (c) => (c.arguments[1] as { headers: Record<string, string> }).headers["Title"],
    );
    assert.ok(!titles.some((t) => t?.includes("[complete]")), `FG-484 campaign: no completion notification may fire, got: ${JSON.stringify(titles)}`);
  },
);
