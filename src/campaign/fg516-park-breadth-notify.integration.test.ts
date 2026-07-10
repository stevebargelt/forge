// FG-516 (coverage gap — SITE BREADTH + divergent CONTENT): the engineer's
// fg516-campaign-pause-notify suite drives ONE park shape — a gate:human park
// with kind `decision_needed` and NO blockerKind. But 19 running→paused park
// sites were wired with a mix of kinds (`blocked` for wedges, `decision_needed`
// where a human call is owed) and a mix of item context (some carry a
// blockerKind, some carry only a requestedHumanAction). This file pins two MORE
// shapes with genuinely different semantics, driving the REAL executor:
//
//   1. The drive-error park (parkCampaignOnDriveThrow) — a runNext throw parks
//      the item and AWAITS notifyCampaignPause before it RETHROWS. This asserts
//      the milestone is a `blocked` kind carrying the "drive loop threw" guidance.
//   2. The workflow-YAML-missing park — an AWAITED `blocked` park that DOES carry
//      a blockerKind (`campaign_system`). This exercises the "blocker: <kind>"
//      body branch that the gate:human test (no blockerKind) never reaches, so
//      the most-divergent pushed body is pinned.
//
// AWAITED-NOTIFY NOTE: since review round 1 (commit 35053cb) the drive-error and
// startRun-throw parks AWAIT notifyCampaignPause before rethrowing — no longer the
// old fire-and-forget `void notifyCampaignPause(...)`. The CLI
// (renderDriveErrorAndExit) catches the rethrow and calls process.exit(1); because
// the notify is awaited inside the park, the milestone is guaranteed recorded and
// dispatched before control returns to that CLI catch, so process.exit(1) can never
// pre-empt it (the F1 test below proves this WITHOUT any explicit drain). The
// remaining drainMicrotasks() calls in shape 1 are belt-and-suspenders only — they
// no longer gate correctness, since the await already flushed the chain.
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
import { approveCampaign, getCampaign, listCampaignItems, addCampaignItem, updateCampaignItem } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { eventsForRun } from "../store/events.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, driveRemainingItems, setCampaignNotifyEmitterForTest } from "./executor.js";
import type { EmitMilestoneArgs, EmitMilestoneResult } from "../notify/milestone.js";
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

// Let all pending microtasks (the awaited notify chain's dispatch/logEvent) settle.
// A macrotask tick guarantees the microtask queue has fully drained.
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

// ── Shape 1: the drive-error park (parkCampaignOnDriveThrow, awaited notify) ──
test("FG-516: a drive-error park fires a `blocked` milestone carrying the drive-throw guidance (awaited notify before the rethrow)", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // A runNext throw on the very first drive → driveWorkflowItem Step 5 catch →
  // parkCampaignOnDriveThrow → AWAIT notifyCampaignPause(..., "blocked") then a
  // rethrow. This is the item's FIRST park, so the dedupe key is fresh and a real
  // push should fire.
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

  // The park AWAITS the notify before rethrowing, so the dispatch/logEvent are
  // already settled by the time startCampaign rejected above (see the AWAITED-NOTIFY
  // NOTE in the file header). These drains are belt-and-suspenders — the dedicated
  // F1 test below proves the awaited flush WITHOUT any drain.
  await drainMicrotasks();
  await drainMicrotasks();

  const milestones = pauseMilestones(runId);
  assert.equal(milestones.length, 1, "exactly one campaign-pause milestone recorded for the drive-error park");
  const m = milestones[0]!;
  assert.equal(m["kind"], "blocked", "a drive-error wedge is a `blocked` milestone, NOT decision_needed");
  assert.equal(m["dedupeKey"], `campaign-pause:${campaignId}:${TICKET_ID}`, "stable per campaign+item dedupe key");
  assert.equal(m["dispatched"], true, "the push actually went out (awaited notify settled before the rethrow)");
  assert.equal(fetchCalls, 1, "exactly one provider push for the drive-error park");
  assert.match(String(m["title"]), new RegExp(TICKET_ID), "title names the parked ticket");
  assert.match(String(m["body"]), /drive loop threw/, "body carries the drive-error requestedHumanAction guidance");
  assert.match(String(m["body"]), new RegExp(BOOM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "body carries the underlying error message");
  // FG-516 (finding F2): a drive-error park persists no blockerKind (the recoverable
  // reattach marker), but the body must still lead with a composed blocker kind.
  assert.match(String(m["body"]), /blocker: drive_error/, "body leads with the composed drive-error blocker kind");
});

// ── Finding F1: the drive-error park now AWAITS the notify before rethrowing ──
// The production CLI (renderDriveErrorAndExit) calls process.exit(1) the instant
// this rethrow reaches it. With the old fire-and-forget `void notifyCampaignPause`,
// an emitter that yields on a macrotask could be pre-empted by that exit. This
// pins the fix: inject an emitter that yields a FULL macrotask (setImmediate)
// before recording, and assert — WITHOUT any explicit drain — that it has already
// recorded by the time startCampaign's rejection reaches the caller. Under the old
// synchronous rethrow this array would still be empty at the assertion.
test("FG-516 (F1): a drive-error park awaits the full (macrotask-yielding) notify chain before the rethrow reaches the caller", { timeout: 20000 }, async () => {
  const campaignId = setupCampaign();

  const recorded: string[] = [];
  const yieldingEmitter = async (args: EmitMilestoneArgs): Promise<EmitMilestoneResult> => {
    await new Promise<void>((r) => setImmediate(r));
    recorded.push(String(args.dedupeKey));
    return { dispatched: false, decision: { send: false, reason: "test-emitter" }, importance: "high" };
  };
  setCampaignNotifyEmitterForTest(yieldingEmitter);

  const throwingRunNext = async (): Promise<RunNextResult> => {
    throw new Error(BOOM);
  };

  await assert.rejects(
    () => startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: throwingRunNext }),
    /paused after a drive error/,
    "the drive throw still parks and rethrows the enriched next-action error",
  );

  // Deliberately NO drainMicrotasks/macrotask hop here — the await inside the park
  // is what must have flushed the emitter before control returned to us.
  assert.deepEqual(
    recorded,
    [`campaign-pause:${campaignId}:${TICKET_ID}`],
    "the notify (incl. its macrotask hop) settled before the park rethrew — proves the awaited fix, not fire-and-forget",
  );
});

// ── Finding F1 (negative): a manual pause winning the transition suppresses the push ──
// `forge campaign pause` is the one explicit exemption to the automatic running→paused
// transition. If an operator's manual pause commits first, a drive error racing behind
// it finds the campaign ALREADY paused — its own tryTransitionCampaign(running→paused)
// changes nothing. Before the fix the park still fired a fresh unattended-wedge push for
// a pause it did not cause; now the notify is gated on that transition committing, so a
// stale driver that transitioned nothing stays silent. The item is still durably parked
// and the original drive error still rethrows — only the spurious push is suppressed.
test("FG-516 (F1): a drive-error park does NOT push when a concurrent manual pause already won the running→paused transition", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // Simulate the operator's `forge campaign pause` landing first: the injected
  // runNext flips the campaign to 'paused' (the exempt manual transition) and THEN
  // throws, so the drive-error park sees a campaign that is no longer 'running'.
  const pauseThenThrow = async (): Promise<RunNextResult> => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    throw new Error(BOOM);
  };

  await assert.rejects(
    () => startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: pauseThenThrow }),
    /paused after a drive error/,
    "the drive throw still parks the item and rethrows the enriched next-action error",
  );

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "the item is still durably parked at the recoverable shape");
  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign stays paused (from the manual pause)");
  const runId = item.runId!;

  await drainMicrotasks();
  await drainMicrotasks();

  assert.equal(
    pauseMilestones(runId).length,
    0,
    "no campaign-pause milestone recorded — this stale driver committed no transition, so it must not notify",
  );
  assert.equal(fetchCalls, 0, "no provider push for a pause this driver did not cause");
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

// ── Shape 3 (finding F1): the dangling-runId recovery park (running→paused) ──
// A resume reattach where the item's PERSISTED runId no longer resolves parks the
// campaign as recovery_needed. This branch used to call notifyCampaignPause WITHOUT
// the campaign fallback, so notifyCampaignPause rejected the stale runId and emitted
// nothing — a silent wedge — even when another item in the campaign owned a real
// run. This pins the fix: the park pushes, scoped to the campaign fallback run.
test("FG-516 (F1): a recovery park whose persisted runId no longer resolves still pushes, scoped to a campaign fallback run", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // Park the planned item at the human gate so the campaign owns ONE real,
  // resolvable run — the fallback anchor the dangling item scopes its milestone to.
  const started = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(started.stopReason, "paused");
  const anchor = listCampaignItems(campaignId)[0]!;
  const anchorRunId = anchor.runId!;
  assert.ok(getRun(anchorRunId), "the planned item owns a real run to serve as the campaign fallback");

  // A SECOND item that iterates FIRST (lower order) and is parked awaiting_gate
  // WITH a blockerKind — so the resume reattach skips the FG-441/FG-485 evidence
  // probe and reaches the getRun(item.runId) reattach — but whose persisted runId
  // is genuinely dangling (the run row was lost).
  const dangling = addCampaignItem({ campaignId, itemOrder: -1, ticketId: "FG-918" });
  updateCampaignItem(dangling.id, {
    lifecycleStatus: "awaiting_gate",
    blockerKind: "campaign_system",
    requestedHumanAction: "recover the lost run",
    runId: "run-does-not-exist",
  });
  assert.equal(getRun("run-does-not-exist"), undefined, "the item's persisted runId is genuinely dangling");

  fetchCalls = 0; // count only pushes from the resume park below
  const resumed = await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(resumed.stopReason, "recovery_needed", "the dangling-runId item parks the campaign as recovery_needed");

  // Without the campaign fallback, notifyCampaignPause rejects the stale runId and
  // emits nothing (the silent wedge). With the fix, the milestone lands on the
  // campaign fallback run.
  const danglingMilestones = pauseMilestones(anchorRunId).filter(
    (p) => p["dedupeKey"] === `campaign-pause:${campaignId}:FG-918`,
  );
  assert.equal(danglingMilestones.length, 1, "the dangling-runId recovery park pushed exactly one milestone (not silent)");
  const m = danglingMilestones[0]!;
  assert.equal(m["kind"], "blocked", "a recovery wedge is a `blocked` milestone");
  assert.equal(m["dispatched"], true, "the push actually went out, scoped to the campaign fallback run");
  assert.equal(fetchCalls, 1, "exactly one provider push for the dangling-runId recovery park");
  assert.match(String(m["body"]), /blocker: campaign_system/, "body carries the blockerKind detail");
});

// ── Shape 4 (F1 round 2): the in-flight/indeterminate park RECORDS its own context ──
// The executor.ts:1269 park fires for an item whose lifecycle status slipped past
// campaignBlocker (a future TaskStatus value, or a 'running'/'awaiting_red' item that
// reached the drive loop). Unlike Shape 3 — which pre-populates blockerKind +
// requestedHumanAction on the fixture and so never proves the PARK sets them — this
// pins that the park itself persists both fields BEFORE notifying, so an item that
// arrives WITHOUT them still gets a real "blocker: … — …" milestone body, not
// notifyCampaignPause's generic "parked <ticket>" fallback. campaignBlocker shadows
// this branch (in-flight statuses bail to recovery_needed pre-flight), so the test
// drives driveRemainingItems directly with the campaign already 'running'.
test("FG-516 (F1): the in-flight/indeterminate park persists blockerKind + requestedHumanAction itself, so a bare item still gets a context-carrying milestone", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // Park the item at the human gate so it owns ONE real, resolvable run.
  const started = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(started.stopReason, "paused");
  const item = listCampaignItems(campaignId)[0]!;
  const runId = item.runId!;
  assert.ok(getRun(runId), "the item owns a real run to scope its milestone to");

  // Force the item into an in-flight status that campaignBlocker would otherwise
  // catch pre-flight, and strip any context fields — the park must supply them.
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'running', blocker_kind = NULL, requested_human_action = NULL WHERE id = ?").run(item.id);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  const bare = listCampaignItems(campaignId)[0]!;
  assert.equal(bare.lifecycleStatus, "running", "the item is in the in-flight status the park handles");
  assert.equal(bare.blockerKind, undefined, "the item arrives WITHOUT a blockerKind");
  assert.equal(bare.requestedHumanAction, undefined, "the item arrives WITHOUT a requestedHumanAction");

  fetchCalls = 0;
  const camp = getCampaign(campaignId)!;
  const result = await driveRemainingItems(campaignId, {
    dispatch: dispatchMustNotBeCalled,
    projectDir: camp.projectDir!,
    mode: camp.mode,
    runNextFn: makeCappedRunNext(10),
  });
  assert.equal(result.stopReason, "recovery_needed", "the in-flight/indeterminate item parks the campaign as recovery_needed");
  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign is durably paused");

  // The park persisted the two context fields ON the item.
  const parked = listCampaignItems(campaignId)[0]!;
  assert.equal(parked.blockerKind, "campaign_system", "the park recorded a campaign_system blockerKind");
  assert.match(String(parked.requestedHumanAction), /unexpected lifecycle status 'running'/, "the park recorded actionable guidance");

  // And the milestone body carries them — NOT the generic "parked" fallback.
  // Filter to the `blocked` kind: startCampaign's earlier gate park emitted a
  // `decision_needed` milestone under the SAME dedupeKey (same ticket), so the
  // in-flight park's push is the one `blocked` milestone for this item.
  const milestones = pauseMilestones(runId).filter(
    (p) => p["dedupeKey"] === `campaign-pause:${campaignId}:${TICKET_ID}` && p["kind"] === "blocked",
  );
  assert.equal(milestones.length, 1, "the in-flight park pushed exactly one `blocked` milestone (not silent)");
  const m = milestones[0]!;
  assert.match(String(m["body"]), /blocker: campaign_system/, "body leads with the blockerKind detail the park recorded");
  assert.match(String(m["body"]), /unexpected lifecycle status 'running'/, "body carries the requestedHumanAction guidance");
  assert.doesNotMatch(String(m["body"]), /^campaign .* parked/, "body is NOT notifyCampaignPause's generic fallback");
});
