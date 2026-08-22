// FG-750: Sequential campaigns must continue independent items when one item parks
// for operator input.
//
// A sequential Campaign Runner runs one item at a time — but "sequential" is NOT an
// implicit dependency chain. When an item reaches an item-local operator gate/park, the
// controller parks ONLY that item (and its true dependency descendants) and continues
// with the next INDEPENDENT eligible item in approved order. A dependency is inferred
// ONLY from an explicit ticket `related[]` edge — never from order, position, release-plan
// prose, or an earlier item being incomplete.
//
// These tests drive the in-process invoke lane (the same path the whole campaign suite
// uses): an item whose ticket is left unshipped parks at awaiting_gate with no blockerKind
// (an item-scoped operator park — the invoke-lane analog of a human gate); a shipped item
// (a real, reachable, non_code_diff commit) completes. AC1..AC7 from the ticket.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import { assembleCampaignReport, assembleCampaignShow } from "./report.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

// Force every list item onto the single-invoke escape-hatch lane (no real workflow /
// docker), so an unshipped item parks at awaiting_gate and a shipped one completes.
function planInvokeCampaign(ticketIds: string[]) {
  const overrides = Object.fromEntries(
    ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }]),
  );
  return _planCampaign(
    { kind: "list", ticketIds, itemOverrides: overrides } as PlannerInput,
    { projectDir, mode: "sequential" as PlanMode },
  );
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

// A real, reachable, non-code commit — satisfies the invoke lane's non_code_diff
// out-of-band eligibility with no host-verification row, so the item ships.
function shipTicket(ticketId: string): void {
  const label = ticketId.replace(/[^A-Za-z0-9_-]/g, "_");
  writeFileSync(join(projectDir, `${label}-ship.md`), `${ticketId} shipped`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `ship ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  closeTicket(projectDir, ticketId, commit);
}

function story(id: string, related?: string[]): void {
  writeTicket(projectDir, {
    id,
    type: "story",
    status: "active",
    title: `${id} story`,
    ...(related ? { related } : {}),
    body: `## Problem\n${id} needs work.\n\n## Goal\nComplete ${id}.\n\n## Acceptance Criteria\n- ${id} done\n`,
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg750-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// A dispatch that ships every ticket in `shipSet` and leaves the rest unshipped (→ the
// unshipped ones park item-scoped). Records every ticket it was called for, plus a
// snapshot of campaign+item state at call time (for the "both visible" assertion).
function makeDispatch(shipSet: Set<string>, campaignIdRef: { id?: string }, log: string[], snapshots: Record<string, string>) {
  return async (args: InvokeArgs): Promise<InvokeResult> => {
    const ticketId = args.runTitle ?? "";
    log.push(ticketId);
    if (campaignIdRef.id) {
      const c = getCampaign(campaignIdRef.id);
      const items = listCampaignItems(campaignIdRef.id)
        .map((i) => `${i.ticketId}:${i.lifecycleStatus}`)
        .join(",");
      snapshots[ticketId] = `campaign=${c?.status};items=${items}`;
    }
    if (shipSet.has(ticketId)) shipTicket(ticketId);
    return { runId: args.runId ?? `run-${ticketId}`, taskId: "task-fake", status: "complete" };
  };
}

// ── AC1 ────────────────────────────────────────────────────────────────────────
// A reaches an item-local operator gate, B is independent, C explicitly depends on A.
// Forge parks A, dispatches B WITHOUT another operator/model turn, leaves C dependency-blocked.
test("AC1: park A (item-local gate), dispatch independent B, hold C (depends on A)", async () => {
  story("FG-A");                 // A: no related — will park unshipped
  story("FG-B");                 // B: independent (no related edge to A)
  story("FG-C", ["FG-A"]);        // C: explicitly depends on A
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B", "FG-C"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const snapshots: Record<string, string> = {};
  const ref = { id: campaign.id };
  const result = await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-B"]), ref, log, snapshots) });

  // A parks item-scoped; the campaign continued and drove B; C never dispatched.
  assert.deepEqual(log, ["FG-A", "FG-B"], "A parked then B dispatched — no extra operator/model turn, C never dispatched");

  const a = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-A")!.id)!;
  const b = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-B")!.id)!;
  const c = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-C")!.id)!;

  assert.equal(a.lifecycleStatus, "awaiting_gate", "A parked waiting on the operator");
  assert.equal(b.lifecycleStatus, "complete", "independent B advanced past A's park");
  assert.equal(b.outcome, "shipped");
  assert.equal(c.lifecycleStatus, "pending", "C is held, never dispatched");
  assert.equal(c.outcome, "held");
  assert.equal(c.blockerKind, "dependency");
  assert.match(c.reason ?? "", /FG-A/, "C's hold names the parked item it depends on");
  assert.equal(c.runId, undefined, "the dependency-blocked item never gets a run");

  // No eligible work remains (A parked, C held) → campaign paused with a named action.
  assert.equal(result.stopReason, "paused");
  assert.equal(getCampaign(campaign.id)!.status, "paused");
  assert.ok(a.requestedHumanAction, "the parked item retains its operator question / resume action");
});

// ── AC2 ────────────────────────────────────────────────────────────────────────
// No implicit dependency is inferred from sequential order, position, prose, or an
// earlier item being incomplete. B has NO related edge and comes AFTER a parked A — it
// still runs.
test("AC2: order/position/incompleteness never imply a dependency — independent later item runs", async () => {
  story("FG-A");   // parks unshipped, no related metadata at all
  story("FG-B");   // later in order, no related metadata — independent
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const ref = { id: campaign.id };
  await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-B"]), ref, log, {}) });

  const b = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-B")!.id)!;
  assert.equal(b.lifecycleStatus, "complete", "B has no explicit dependency on A — being later & A incomplete must not hold it");
  assert.equal(b.outcome, "shipped", "B shipped rather than being held on an inferred (order-based) dependency");
});

// ── AC3 ────────────────────────────────────────────────────────────────────────
// A campaign-scoped hard stop, and an all-blocked case, both stop dispatch with a named reason.
test("AC3a: a campaign-scoped (shared) blocker halts the whole campaign — later item not driven", async () => {
  story("FG-A");
  story("FG-B");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  // A's dispatch THROWS → dispatch_threw → infrastructure (a SHARED blocker) → campaign-scoped.
  const log: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    log.push(args.runTitle ?? "");
    throw new Error("simulated shared infrastructure failure");
  };
  const result = await startCampaign(campaign.id, { dispatch });

  assert.equal(result.stopReason, "paused", "a shared blocker parks the whole campaign");
  assert.deepEqual(log, ["FG-A"], "the campaign-scoped stop halts dispatch — B is never driven");
  const a = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-A")!.id)!;
  const b = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-B")!.id)!;
  assert.equal(a.blockerKind, "infrastructure", "the shared blocker is named");
  assert.ok(a.requestedHumanAction, "the stop names why it halted");
  assert.equal(b.lifecycleStatus, "pending", "B stays pending — the campaign-scoped stop reached it before dispatch");
});

test("AC3b: all remaining items blocked on the parked item → campaign stops, naming why", async () => {
  story("FG-A");            // parks unshipped
  story("FG-C", ["FG-A"]);  // the only other item depends on A
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-C"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const ref = { id: campaign.id };
  const result = await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(), ref, log, {}) });

  assert.deepEqual(log, ["FG-A"], "only A dispatched — its sole dependent C is held, so no eligible work remains");
  const a = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-A")!.id)!;
  const c = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-C")!.id)!;
  assert.equal(result.stopReason, "paused");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "no eligible item remains → campaign paused, not completed");
  assert.equal(a.lifecycleStatus, "awaiting_gate", "the parked item is retained");
  assert.equal(c.outcome, "held", "the dependent is held");
  assert.ok(a.requestedHumanAction && c.requestedHumanAction, "both retained items name their operator action");
});

// ── AC4 ────────────────────────────────────────────────────────────────────────
// Resolving the parked item's question resumes THAT item in place — no blind
// regeneration, no duplicate execution.
test("AC4: resolving the parked item resumes it in place — no duplicate run, dependent then unblocks", async () => {
  story("FG-A");
  story("FG-B");
  story("FG-C", ["FG-A"]);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B", "FG-C"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const ref = { id: campaign.id };
  await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-B"]), ref, log, {}) });

  const aId = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-A")!.id;
  const aParked = getCampaignItem(aId)!;
  assert.equal(aParked.lifecycleStatus, "awaiting_gate");
  const aRunBefore = aParked.runId;
  assert.ok(aRunBefore, "A has a run attached while parked");

  // Operator resolves A's question: the work is now genuinely delivered (a real ship
  // commit). Resume must reconcile A IN PLACE off its existing run — never re-dispatch it.
  shipTicket("FG-A");
  const resumeLog: string[] = [];
  const resumeRef = { id: campaign.id };
  // A is reconciled in place (never re-dispatched); C, once unblocked, is driven fresh and ships.
  const resumeResult = await resumeCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-C"]), resumeRef, resumeLog, {}) });

  const aAfter = getCampaignItem(aId)!;
  assert.equal(aAfter.lifecycleStatus, "complete", "A resumed in place and shipped");
  assert.equal(aAfter.outcome, "shipped");
  assert.equal(aAfter.runId, aRunBefore, "A reused its ORIGINAL run — no blind regeneration");
  assert.equal(resumeLog.includes("FG-A"), false, "A was NOT re-dispatched — its evidence was reconciled in place");

  const c = getCampaignItem(listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-C")!.id)!;
  assert.equal(c.lifecycleStatus, "complete", "C unblocked once its dependency A completed");
  assert.equal(resumeResult.stopReason, "complete", "all items settled — campaign completes");
  assert.equal(getCampaign(campaign.id)!.status, "complete");
});

// ── AC5 ────────────────────────────────────────────────────────────────────────
// Campaign status remains running while independent work proceeds; both the
// waiting-on-operator item and the later running item are observable simultaneously.
test("AC5: campaign stays running while B runs — parked A and running B are both visible at once", async () => {
  story("FG-A");
  story("FG-B");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const snapshots: Record<string, string> = {};
  const ref = { id: campaign.id };
  let showWhileBStarts: ReturnType<typeof assembleCampaignShow> | undefined;
  let reportWhileBStarts: ReturnType<typeof assembleCampaignReport> | undefined;
  const baseDispatch = makeDispatch(new Set(["FG-B"]), ref, log, snapshots);
  await startCampaign(campaign.id, {
    dispatch: async (args) => {
      // The dispatch reservation has made B running and A has already committed its
      // item-local park. Read the two shared reporting projections at that exact
      // durable point, before B's fake dispatch ships it.
      if (args.runTitle === "FG-B") {
        showWhileBStarts = assembleCampaignShow(campaign.id);
        reportWhileBStarts = assembleCampaignReport(campaign.id);
      }
      return baseDispatch(args);
    },
  });

  // The snapshot taken at the moment B's dispatch runs proves both facts held together:
  // the campaign was RUNNING, A was already parked (awaiting_gate), and B was running.
  const atB = snapshots["FG-B"];
  assert.ok(atB, "B was dispatched, so a snapshot was captured");
  assert.match(atB, /campaign=running/, "campaign is RUNNING while the later independent item is dispatched");
  assert.match(atB, /FG-A:awaiting_gate/, "the parked item is simultaneously visible as waiting-on-operator");
  assert.match(atB, /FG-B:running/, "the later independent item is simultaneously visible as running");

  assert.equal(showWhileBStarts?.status, "running", "campaign show retains the running campaign state");
  assert.equal(showWhileBStarts?.nextAction, "running", "the shared show derivation does not mislabel the item-local park as recovery");
  assert.equal(showWhileBStarts?.items.find((item) => item.ticketId === "FG-A")?.lifecycleStatus, "awaiting_gate");
  assert.equal(showWhileBStarts?.items.find((item) => item.ticketId === "FG-B")?.lifecycleStatus, "running");
  assert.equal(reportWhileBStarts?.safetyToContinue, "running", "the shared report/current-activity safety derivation remains running");
  assert.equal(reportWhileBStarts?.nextOperatorAction, "campaign is running — monitor progress");
});

// ── AC6 ────────────────────────────────────────────────────────────────────────
// Crash/restart between parking A and dispatching B recovers without duplicating either
// item. Modeled as an unresolved re-drive: a resume that finds A still parked must
// reattach (never re-run) and must not re-execute the already-shipped independent item.
test("AC6: restart with the parked item unresolved re-drives nothing twice", async () => {
  story("FG-A");
  story("FG-B");
  story("FG-C", ["FG-A"]);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-A", "FG-B", "FG-C"]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const ref = { id: campaign.id };
  await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-B"]), ref, log, {}) });

  const itemsAfterStart = listCampaignItems(campaign.id);
  const aRun = itemsAfterStart.find((i) => i.ticketId === "FG-A")!.runId;
  const bRun = itemsAfterStart.find((i) => i.ticketId === "FG-B")!.runId;
  const runCountBefore = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;

  // Simulate a restart: resume WITHOUT the operator resolving A. Nothing new should run.
  const resumeLog: string[] = [];
  const resumeRef = { id: campaign.id };
  await resumeCampaign(campaign.id, { dispatch: makeDispatch(new Set(["FG-B"]), resumeRef, resumeLog, {}) });

  assert.equal(resumeLog.includes("FG-A"), false, "A must not be re-dispatched on restart");
  assert.equal(resumeLog.includes("FG-B"), false, "the already-shipped independent item must not be re-executed");

  const itemsAfterResume = listCampaignItems(campaign.id);
  assert.equal(itemsAfterResume.find((i) => i.ticketId === "FG-A")!.runId, aRun, "A keeps its original run — no duplicate");
  assert.equal(itemsAfterResume.find((i) => i.ticketId === "FG-B")!.runId, bRun, "B keeps its original run — no duplicate");
  const runCountAfter = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  assert.equal(runCountAfter, runCountBefore, "no new run rows were created on restart");
});

// ── AC7 ────────────────────────────────────────────────────────────────────────
// The FG-744 overnight shape: one item parks for an architecture decision while many
// later approved INDEPENDENT items remain. The unattended window must not be wasted —
// every independent item ships; only the parked item (and any true dependent) waits.
test("AC7: FG-744 overnight shape — one park does not strand the many independent items", async () => {
  const later = ["FG-201", "FG-202", "FG-203", "FG-204", "FG-205"];
  story("FG-200");                 // the item that parks for an architecture decision
  for (const id of later) story(id); // all independent, no related edges to FG-200
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);

  const { campaign } = planInvokeCampaign(["FG-200", ...later]);
  approveCampaign(campaign.id, { rationale: "approved" });

  const log: string[] = [];
  const ref = { id: campaign.id };
  // Ship every later item; leave FG-200 unshipped so it parks.
  const result = await startCampaign(campaign.id, { dispatch: makeDispatch(new Set(later), ref, log, {}) });

  const items = listCampaignItems(campaign.id);
  const parked = items.find((i) => i.ticketId === "FG-200")!;
  assert.equal(parked.lifecycleStatus, "awaiting_gate", "the architecture-decision item parked");

  for (const id of later) {
    const it = items.find((i) => i.ticketId === id)!;
    assert.equal(it.lifecycleStatus, "complete", `${id} advanced during the unattended window (not stranded behind FG-200)`);
    assert.equal(it.outcome, "shipped", `${id} shipped`);
  }
  assert.deepEqual(log, ["FG-200", ...later], "the controller drove FG-200 then every independent later item, in approved order");
  assert.equal(result.stopReason, "paused", "the campaign parks only for the still-unresolved FG-200");
  assert.equal(getCampaign(campaign.id)!.status, "paused");
});
