// FG-516 (coverage gap — SITE BREADTH + divergent CONTENT): the engineer's
// fg516-campaign-pause-notify suite drives ONE park shape — a gate:human park
// with kind `decision_needed` and NO blockerKind. But 19 running→paused park
// sites were wired with a mix of kinds (`blocked` for wedges, `decision_needed`
// where a human call is owed) and a mix of item context (some carry a
// blockerKind, some carry only a requestedHumanAction). This file pins two MORE
// shapes with genuinely different semantics, driving the REAL executor:
//
//   1. The drive-error park (parkCampaignOnDriveThrow) — a runNext throw parks
//      the item and fires `void notifyCampaignPause(...)`, FIRE-AND-FORGET, from
//      a synchronous never-returning function that then RETHROWS. This asserts
//      the milestone is a `blocked` kind carrying the "drive loop threw" guidance.
//   2. The workflow-YAML-missing park — an AWAITED `blocked` park that DOES carry
//      a blockerKind (`campaign_system`). This exercises the "blocker: <kind>"
//      body branch that the gate:human test (no blockerKind) never reaches, so
//      the most-divergent pushed body is pinned.
//
// FIRE-AND-FORGET NOTE (observation, NOT a confirmed defect): the drive-error and
// startRun-throw parks call `void notifyCampaignPause(...)` (unawaited) and then
// rethrow synchronously; the CLI (renderDriveErrorAndExit) catches that rethrow
// and calls process.exit(1). In the CURRENT code the notify's dispatch/logEvent
// microtasks drain during rejection propagation — before control returns to the
// CLI catch — so the push is NOT lost today (verified: the milestone is already
// recorded at the synchronous rejection point, no explicit drain required). It is
// a latent fragility: the flush relies on incidental microtask ordering, not on
// an await, so a future change that adds an await hop to the dispatch chain could
// let process.exit(1) pre-empt it. This test drains explicitly only to be robust
// to that ordering, and asserts the wiring records/dispatches the right milestone.
//
// Setup mirrors fg509 (drive-throw seams) + fg516 (stub-provider push counting).

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
import { startCampaign, setCampaignNotifyEmitterForTest } from "./executor.js";
import { runNext } from "../v2/runNext.js";
import type { DockerExecFn, RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

const RUNTIME_NAME = "fg516-breadth-runtime";
const WORKFLOW_NAME = "fg516-park-breadth-notify";
const TICKET_ID = "FG-917";
const BOOM = "FG-516 breadth test: injected runNext explosion";

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
description: FG-516 breadth integration test runtime stub
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
description: FG-516 park-breadth notify regression test
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
    if (calls > cap) throw new Error(`FG-516 breadth test safety guard: runNext called ${calls} times without settling`);
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
    title: "FG-917 park-breadth notify",
    body: "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n",
  });
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-516 breadth test" },
  };
  const { campaign } = planCampaign({ kind: "list", ticketIds: [TICKET_ID], itemOverrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "FG-516 breadth test" });
  return campaign.id;
}

// Stub ntfy provider (no real network) so an emit actually "dispatches"; count
// the pushes so a real dispatch vs a deduped/suppressed record is provable.
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

// Let all pending microtasks (the fire-and-forget notify chain) settle. A macrotask
// tick guarantees the microtask queue has fully drained.
const drainMicrotasks = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg516-breadth-"));
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

// ── Shape 1: the drive-error park (parkCampaignOnDriveThrow, fire-and-forget) ──
test("FG-516: a drive-error park fires a `blocked` milestone carrying the drive-throw guidance (fire-and-forget, records after the queue drains)", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // A runNext throw on the very first drive → driveWorkflowItem Step 5 catch →
  // parkCampaignOnDriveThrow → `void notifyCampaignPause(..., "blocked")` then a
  // synchronous rethrow. This is the item's FIRST park, so the dedupe key is
  // fresh and a real push should fire.
  const throwingRunNext = async (): Promise<RunNextResult> => {
    throw new Error(BOOM);
  };

  await assert.rejects(
    () => startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: throwingRunNext }),
    /paused after a drive error/,
    "the drive throw parks and rethrows the enriched next-action error",
  );

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item is durably parked at the recoverable shape");
  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign is durably paused");
  const runId = item.runId!;

  // The notify is fire-and-forget from a synchronous throw path. Drain the queue
  // so the async dispatch/logEvent are guaranteed settled regardless of microtask
  // interleaving (see the FIRE-AND-FORGET NOTE in the file header).
  await drainMicrotasks();
  await drainMicrotasks();

  const milestones = pauseMilestones(runId);
  assert.equal(milestones.length, 1, "exactly one campaign-pause milestone recorded for the drive-error park");
  const m = milestones[0]!;
  assert.equal(m["kind"], "blocked", "a drive-error wedge is a `blocked` milestone, NOT decision_needed");
  assert.equal(m["dedupeKey"], `campaign-pause:${campaignId}:${TICKET_ID}`, "stable per campaign+item dedupe key");
  assert.equal(m["dispatched"], true, "the push actually went out once the fire-and-forget settled");
  assert.equal(fetchCalls, 1, "exactly one provider push for the drive-error park");
  assert.match(String(m["title"]), new RegExp(TICKET_ID), "title names the parked ticket");
  assert.match(String(m["body"]), /drive loop threw/, "body carries the drive-error requestedHumanAction guidance");
  assert.match(String(m["body"]), new RegExp(BOOM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "body carries the underlying error message");
});

// ── Shape 2: the workflow-YAML-missing park (AWAITED, carries a blockerKind) ──
test("FG-516: a workflow-YAML-missing park fires a `blocked` milestone whose body carries BOTH the blockerKind and the requestedHumanAction", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  const missing = "workflow YAML missing or invalid for FG-516 breadth test";
  // doLoadWorkflow throws at drive time → the full_feature load-fail park:
  // blockerKind `campaign_system`, awaited notifyCampaignPause(..., "blocked").
  const result = await startCampaign(campaignId, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
    loadWorkflowFn: () => {
      throw new Error(missing);
    },
  });
  assert.equal(result.stopReason, "paused", "the load-fail park pauses the campaign");

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "campaign_system", "the YAML-missing park carries a campaign_system blockerKind");
  const runId = item.runId!;

  const milestones = pauseMilestones(runId);
  assert.equal(milestones.length, 1, "exactly one campaign-pause milestone recorded");
  const m = milestones[0]!;
  assert.equal(m["kind"], "blocked", "a YAML-missing wedge is a `blocked` milestone");
  assert.equal(m["dispatched"], true, "the push went out (awaited path, fresh dedupe key)");
  assert.equal(fetchCalls, 1, "exactly one provider push");
  // The divergent body branch the gate:human test never reaches: a "blocker: <kind>"
  // prefix joined with the requestedHumanAction.
  assert.match(String(m["body"]), /blocker: campaign_system/, "body leads with the blockerKind detail");
  assert.match(String(m["body"]), /workflow YAML missing or invalid/, "body carries the requestedHumanAction guidance");
});
