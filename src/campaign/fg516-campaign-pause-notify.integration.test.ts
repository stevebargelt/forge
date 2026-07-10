// FG-516: an UNATTENDED campaign park (drive error, blocker, gate) must push a
// milestone so an overnight campaign that wedges tells the operator instead of
// sitting silent until someone looks. These tests drive the REAL executor
// (startCampaign/resumeCampaign → driveWorkflowItem) to a genuine gate:human park
// and assert the notification wiring end-to-end: exactly one push per park with
// the right kind/title/dedupe key, the park still succeeds when the emitter
// throws, a re-park of the same item is deduped (no second push), and NO_NOTIFY
// suppresses the push entirely.
//
// The gate:human setup mirrors fg509's — drive the step to a real awaiting_gate
// park. Provider mocking mirrors milestone.test.ts: FORGE_NOTIFY=ntfy + NTFY_URL
// + a stubbed global fetch, with NO_NOTIFY cleared so a push actually fires.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, listCampaignItems } from "../store/campaigns.js";
import { eventsForRun } from "../store/events.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, setCampaignNotifyEmitterForTest } from "./executor.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg516-test-runtime";
const WORKFLOW_NAME = "fg516-campaign-pause-notify";
const TICKET_ID = "FG-916";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let wfPath: string;

const ENV_KEYS = ["ANTHROPIC_API_KEY", "NO_NOTIFY", "FORGE_NOTIFY", "NTFY_URL"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let originalFetch: typeof globalThis.fetch;
let fetchCalls: number;

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-516 integration test runtime stub
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
description: FG-516 campaign pause-notify regression test
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
    calls++;
    if (calls > cap) throw new Error(`FG-516 test safety guard: runNext called ${calls} times without settling`);
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses it");
};

function setupCampaign(): string {
  writeTicket(projectDir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: "FG-916 campaign pause notify",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-516 test: pause notify" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-516 test" });
  return campaign.id;
}

// Turn on a stubbed ntfy provider (no real network) so an emit actually
// "dispatches"; count the pushes so a second (deduped) park is provable.
function enableStubProvider(): void {
  process.env["NO_NOTIFY"] = "";
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
}

function pauseMilestones(runId: string) {
  return eventsForRun(runId)
    .filter((e) => e.eventType === "orchestrator.milestone")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => typeof p["dedupeKey"] === "string" && (p["dedupeKey"] as string).startsWith("campaign-pause:"));
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg516-pause-notify-"));
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

test("FG-516: a gate:human park fires exactly one milestone with the right kind, title and dedupe key", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  const result = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(result.stopReason, "paused", "the campaign must park at the human gate");

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate");
  const runId = item.runId!;

  const milestones = pauseMilestones(runId);
  assert.equal(milestones.length, 1, "exactly one campaign-pause milestone recorded");
  const m = milestones[0]!;
  assert.equal(m["kind"], "decision_needed", "a human gate awaits an operator call → decision_needed");
  assert.equal(m["dedupeKey"], `campaign-pause:${campaignId}:${TICKET_ID}`, "stable per campaign+item dedupe key");
  assert.equal(m["dispatched"], true, "the push actually went out (stub provider)");
  assert.match(String(m["title"]), new RegExp(TICKET_ID), "title names the parked ticket");
  assert.match(String(m["body"]), /Human gate required/, "body carries the park's requestedHumanAction guidance");
  // FG-516 (finding F2): a gate:human park persists no blockerKind (the reconcile
  // marker), but the body must still lead with a composed blocker kind per the docs.
  assert.match(String(m["body"]), /blocker: human_gate/, "body leads with the composed gate blocker kind");
});

test("FG-516: re-parking the same campaign+item after resume does not push a second time (dedupe)", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  const runId = listCampaignItems(campaignId)[0]!.runId!;
  assert.equal(pauseMilestones(runId).filter((p) => p["dispatched"] === true).length, 1, "first park pushes once");

  // Resume with the gate still unadvanced — the item re-parks at the same
  // gate:human site on the same run. The stable dedupe key + emitMilestone's
  // run-scoped, persistent dedupe must suppress the second push.
  const resumed = await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(resumed.stopReason, "paused", "resume re-parks at the same human gate");

  const all = pauseMilestones(runId);
  assert.equal(all.length, 2, "the re-park recorded a second campaign-pause milestone (audit)");
  assert.equal(all.filter((p) => p["dispatched"] === true).length, 1, "but only the first was pushed — the re-park was deduped");
});

test("FG-516: the park still succeeds when the milestone emitter throws", { timeout: 20000 }, async () => {
  enableStubProvider();
  setCampaignNotifyEmitterForTest(async () => {
    throw new Error("FG-516 test: injected emitter explosion");
  });
  const campaignId = setupCampaign();

  // A notify failure must never break the park — the pause is the safety-critical half.
  let result: Awaited<ReturnType<typeof startCampaign>> | undefined;
  await assert.doesNotReject(async () => {
    result = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  });

  assert.equal(result!.stopReason, "paused", "the park still lands despite the emitter throw");
  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item is durably parked");
  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign is durably paused");
});

test("FG-516: NO_NOTIFY suppresses the push from the park path", { timeout: 20000 }, async () => {
  // Provider configured, but NO_NOTIFY set — the suite-quieting switch must win.
  process.env["NO_NOTIFY"] = "true";
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;

  const campaignId = setupCampaign();
  const result = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(result.stopReason, "paused");

  const runId = listCampaignItems(campaignId)[0]!.runId!;
  assert.equal(fetchCalls, 0, "NO_NOTIFY → no provider push attempted");
  const milestones = pauseMilestones(runId);
  assert.equal(milestones.length, 1, "the milestone is still recorded (audit), just not dispatched");
  assert.equal(milestones[0]!["dispatched"], false, "not dispatched under NO_NOTIFY");
});
