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
import { getRun, insertRun } from "../store/runs.js";
import { eventsForRun } from "../store/events.js";
import { planCampaign } from "./planner.js";
import type { ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, driveRemainingItems, setCampaignNotifyEmitterForTest } from "./executor.js";
import type { EmitMilestoneArgs, EmitMilestoneResult } from "../notify/milestone.js";
import { runNext } from "../v2/runNext.js";
import { publishFlatAsGeneration } from "../v2/seed-generation.testkit.js";
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
  // FG-583: publish the flat workflow + runtime as one complete seed generation —
  // there is no flat dispatch fallback, so the drive-error/gate park shapes refuse
  // dispatch without a published generation. Called after ensureRuntime in
  // beforeEach, so this captures both. (The workflow-YAML-missing test injects a
  // throwing loadWorkflowFn and still fails closed as asserted.)
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

// ── Shape 2: the workflow-YAML-missing case now FAILS CLOSED (round 6) — no park, no notify ──
// FG-564 (FIX round 6): a full_feature workflow-resolution failure is routed through the SAME
// shared prepareCampaignItemDispatch fail-closed authority the recover advance uses. It THROWS
// BEFORE any reservation — no run is minted, the item stays pending, and the campaign stays
// recoverable — identical to the recover caller. The pre-round-6 synthetic-run park (which fired
// a `blocked` milestone) is gone, so this case records NO pause milestone/push: the CLI's
// top-level handler (renderDriveErrorAndExit) renders the propagated error instead. The
// "blocker: <kind>" + requestedHumanAction body composition is still exercised by the surviving
// park shapes (the no-progress/human-gate body-only labels below).
test("FG-564 (FIX round 6): a workflow-YAML-missing full_feature drive FAILS CLOSED — throws before any reservation, mints no run, leaves the item pending, records NO pause milestone", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  const missing = "workflow YAML missing or invalid for FG-516 breadth test";
  await assert.rejects(
    () =>
      startCampaign(campaignId, {
        dispatch: dispatchMustNotBeCalled,
        runNextFn: makeCappedRunNext(10),
        loadWorkflowFn: () => {
          throw new Error(missing);
        },
      }),
    new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the workflow-resolution failure propagates from the shared authority (fail closed, before any reservation)",
  );

  const item = listCampaignItems(campaignId)[0]!;
  assert.equal(item.lifecycleStatus, "pending", "the item stays pending — no reservation was entered");
  assert.equal(item.outcome, undefined, "no terminal outcome was applied");
  assert.equal(item.runId, undefined, "no run was minted or linked — identical fail-closed behavior to the recover advance");

  await drainMicrotasks();
  await drainMicrotasks();

  assert.equal(fetchCalls, 0, "no provider push — the fail-closed case does not park, so it does not notify");
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

// ── Shape 3b (F1 round 2): the dangling-runId park RECORDS its own context ──
// The real gate-then-lost-run shape Shape 3 masks: a NORMAL human-gate item is
// parked awaiting_gate with NO persisted blockerKind (the FG-441 reattach marker),
// so the resume reattach runs the FG-441/FG-485 evidence probe — which, with a
// dangling run and no ship evidence, refuses and falls through to the
// getRun(item.runId) reattach whose run row is absent. Unlike Shape 3 — which
// pre-seeds blockerKind: "campaign_system" and so never proves the PARK sets it —
// this pins that the `!runForItem` park itself persists blockerKind +
// requestedHumanAction BEFORE notifying, so the milestone body carries a real
// "blocker: … — …" instead of notifyCampaignPause's generic "parked <ticket>".
test("FG-516 (F1): a dangling-runId park on a bare human-gate item persists blockerKind + requestedHumanAction itself, so it still gets a context-carrying milestone", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // Park the planned item at the human gate so the campaign owns ONE real,
  // resolvable run — the fallback anchor the dangling item scopes its milestone to.
  const started = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(started.stopReason, "paused");
  const anchor = listCampaignItems(campaignId)[0]!;
  const anchorRunId = anchor.runId!;
  assert.ok(getRun(anchorRunId), "the planned item owns a real run to serve as the campaign fallback");

  // A SECOND item that iterates FIRST (lower order), parked awaiting_gate as a
  // NORMAL human-gate item — NO blockerKind, NO context fields — whose persisted
  // runId is genuinely dangling. The evidence probe fires (no blockerKind), finds
  // no ship evidence, refuses, and falls through to the dangling-run reattach.
  const dangling = addCampaignItem({ campaignId, itemOrder: -1, ticketId: "FG-920" });
  updateCampaignItem(dangling.id, {
    lifecycleStatus: "awaiting_gate",
    runId: "run-does-not-exist",
  });
  const seeded = listCampaignItems(campaignId).find((i) => i.id === dangling.id)!;
  assert.equal(seeded.blockerKind, undefined, "the item arrives WITHOUT a blockerKind (a normal human-gate item)");
  assert.equal(seeded.requestedHumanAction, undefined, "the item arrives WITHOUT a requestedHumanAction");
  assert.equal(getRun("run-does-not-exist"), undefined, "the item's persisted runId is genuinely dangling");

  fetchCalls = 0; // count only pushes from the resume park below
  const resumed = await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(resumed.stopReason, "recovery_needed", "the dangling-runId item parks the campaign as recovery_needed");

  // The park persisted the two context fields ON the item — Shape 3 could not
  // prove this because it pre-seeded them.
  const parked = listCampaignItems(campaignId).find((i) => i.id === dangling.id)!;
  assert.equal(parked.blockerKind, "campaign_system", "the park recorded a campaign_system blockerKind");
  assert.match(String(parked.requestedHumanAction), /no longer resolves/, "the park recorded actionable guidance naming the lost run");

  // And the milestone body carries them — NOT the generic "parked" fallback.
  const milestones = pauseMilestones(anchorRunId).filter(
    (p) => p["dedupeKey"] === `campaign-pause:${campaignId}:FG-920` && p["kind"] === "blocked",
  );
  assert.equal(milestones.length, 1, "the dangling-runId park pushed exactly one `blocked` milestone (not silent)");
  const dm = milestones[0]!;
  assert.equal(dm["dispatched"], true, "the push went out, scoped to the campaign fallback run");
  assert.equal(fetchCalls, 1, "exactly one provider push for the dangling-runId recovery park");
  assert.match(String(dm["body"]), /blocker: campaign_system/, "body leads with the blockerKind detail the park recorded");
  assert.doesNotMatch(String(dm["body"]), /^campaign .* parked/, "body is NOT notifyCampaignPause's generic fallback");
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

// ── Shape 5: the no-runId resume-reattach park RECORDS its own context ──
// A parked workflow item (awaiting_gate/blocked_by_red) whose runId is unset reaches
// the resume reattach's `!item.runId` branch. Like Shape 4 — but for the resume path,
// not the in-flight/indeterminate one — this pins that the park itself persists
// blockerKind + requestedHumanAction BEFORE notifying, so an item that arrives WITHOUT
// them still gets a real "blocker: … — …" milestone body scoped to a campaign
// fallback run, not notifyCampaignPause's generic "parked <ticket>" fallback.
test("FG-516: the no-runId resume-reattach park persists blockerKind + requestedHumanAction itself, so a bare item still gets a context-carrying milestone", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign();

  // Park the planned item at the human gate so the campaign owns ONE real,
  // resolvable run — the fallback anchor the no-runId item scopes its milestone to.
  const started = await startCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(started.stopReason, "paused");
  const anchor = listCampaignItems(campaignId)[0]!;
  const anchorRunId = anchor.runId!;
  assert.ok(getRun(anchorRunId), "the planned item owns a real run to serve as the campaign fallback");

  // A SECOND item that iterates FIRST (lower order), parked awaiting_gate with NO
  // runId and WITHOUT any context fields — the park must supply them.
  const bare = addCampaignItem({ campaignId, itemOrder: -1, ticketId: "FG-919" });
  updateCampaignItem(bare.id, { lifecycleStatus: "awaiting_gate" });
  const seeded = listCampaignItems(campaignId).find((i) => i.id === bare.id)!;
  assert.equal(seeded.runId, undefined, "the item has no run of its own");
  assert.equal(seeded.blockerKind, undefined, "the item arrives WITHOUT a blockerKind");
  assert.equal(seeded.requestedHumanAction, undefined, "the item arrives WITHOUT a requestedHumanAction");

  fetchCalls = 0; // count only pushes from the resume park below
  const resumed = await resumeCampaign(campaignId, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });
  assert.equal(resumed.stopReason, "recovery_needed", "the no-runId item parks the campaign as recovery_needed");

  // The park persisted the two context fields ON the item.
  const parked = listCampaignItems(campaignId).find((i) => i.id === bare.id)!;
  assert.equal(parked.blockerKind, "campaign_system", "the park recorded a campaign_system blockerKind");
  assert.match(String(parked.requestedHumanAction), /no run to reattach|no runId/, "the park recorded actionable guidance naming the missing run");

  // And the milestone body carries them — scoped to the campaign fallback run,
  // NOT the generic "parked" fallback.
  const milestones = pauseMilestones(anchorRunId).filter(
    (p) => p["dedupeKey"] === `campaign-pause:${campaignId}:FG-919` && p["kind"] === "blocked",
  );
  assert.equal(milestones.length, 1, "the no-runId park pushed exactly one `blocked` milestone (not silent)");
  const bm = milestones[0]!;
  assert.equal(bm["dispatched"], true, "the push went out, scoped to the campaign fallback run");
  assert.equal(fetchCalls, 1, "exactly one provider push for the no-runId recovery park");
  assert.match(String(bm["body"]), /blocker: campaign_system/, "body leads with the blockerKind detail the park recorded");
  assert.doesNotMatch(String(bm["body"]), /^campaign .* parked/, "body is NOT notifyCampaignPause's generic fallback");
});

// ── Shape 6 (F1 round 2): the startRun-throw park with a FAILED synthetic run row ──
// A thrown startRun links the item to a best-effort synthetic 'abandoned' run row
// for traceability — but that insert is best-effort and CAN fail (its catch in the
// startRun-throw path is there precisely because it can). When it does, the item
// has NO run of its own, so parkCampaignOnStartRunThrow used to call the boundary
// WITHOUT a campaign fallback run: notifyCampaignPause rejected the dangling runId
// and emitted nothing — a silent unattended park — even though an EARLIER item in
// the campaign owned a real run. This pins the fix: the park now supplies
// pickCampaignFallbackRunId, so the milestone lands on that fallback run, carrying
// the startRun-threw drive-error context. Distinct from the zero-runs-anywhere
// exemption (FG-517): here a valid campaign run exists to scope to.
test("FG-516 (F1): a startRun-throw park whose synthetic run row failed to persist still pushes, scoped to a campaign fallback run", { timeout: 20000 }, async () => {
  enableStubProvider();
  const campaignId = setupCampaign(); // the planned FG-917 item is the one whose startRun throws

  // An EARLIER-created but LATER-ordered campaign item that owns a real, resolvable
  // run — the campaign fallback anchor. It sits pending AFTER the failing item, so
  // the drive loop never reaches it (the startRun throw rethrows first).
  const anchorRunId = "run-fg516-startrun-anchor";
  insertRun({
    id: anchorRunId,
    workflow: WORKFLOW_NAME,
    title: "FG-922",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    metadata: { campaignId, ticketId: "FG-922" },
    projectDir,
  });
  const anchor = addCampaignItem({ campaignId, itemOrder: 100, ticketId: "FG-922" });
  updateCampaignItem(anchor.id, { runId: anchorRunId });
  assert.ok(getRun(anchorRunId), "the anchor item owns a real run to serve as the campaign fallback");

  // Force the best-effort synthetic run insert to FAIL so the failing item genuinely
  // has no run of its own — the exact shape the fix protects. A BEFORE INSERT trigger
  // aborts any 'abandoned' run insert (the synthetic row's status); the real anchor
  // run above was inserted 'active' before the trigger existed, so it is untouched.
  db.exec(
    "CREATE TRIGGER fg516_fail_synthetic_run BEFORE INSERT ON runs WHEN NEW.status = 'abandoned' BEGIN SELECT RAISE(ABORT, 'FG-516 test: simulated synthetic run persistence failure'); END;",
  );

  const throwingStartRun = (): { runId: string } => {
    throw new Error(`startRun exploded dispatching ${TICKET_ID}`);
  };

  fetchCalls = 0;
  await assert.rejects(
    () =>
      startCampaign(campaignId, {
        dispatch: dispatchMustNotBeCalled,
        startRunFn: throwingStartRun,
        runNextFn: makeCappedRunNext(10),
      }),
    /paused after a drive error/,
    "the startRun throw parks the item and rethrows the enriched next-action error",
  );

  const failing = listCampaignItems(campaignId).find((i) => i.ticketId === TICKET_ID)!;
  assert.equal(failing.lifecycleStatus, "failed", "the startRun-throw item parks directly at its terminal shape");
  assert.equal(failing.blockerKind, "infrastructure", "a startRun dispatch-time failure classifies as infrastructure");
  assert.ok(!failing.runId || !getRun(failing.runId), "the failing item has NO resolvable run of its own (synthetic insert aborted)");
  assert.equal(getCampaign(campaignId)?.status, "paused", "the campaign is durably paused");

  // Without the campaign fallback, notifyCampaignPause rejects the dangling runId and
  // emits nothing (the silent wedge). With the fix, the milestone lands on the
  // campaign fallback run.
  const milestones = pauseMilestones(anchorRunId).filter(
    (p) => p["dedupeKey"] === `campaign-pause:${campaignId}:${TICKET_ID}`,
  );
  assert.equal(milestones.length, 1, "the startRun-throw park pushed exactly one milestone (not silent)");
  const m = milestones[0]!;
  assert.equal(m["kind"], "blocked", "a startRun-throw wedge is a `blocked` milestone");
  assert.equal(m["dispatched"], true, "the push actually went out, scoped to the campaign fallback run");
  assert.equal(fetchCalls, 1, "exactly one provider push for the startRun-throw park");
  assert.match(String(m["body"]), /startRun threw/, "body carries the startRun-throw requestedHumanAction guidance");
  assert.match(String(m["body"]), /blocker: infrastructure/, "body leads with the infrastructure blockerKind the park recorded");
});
