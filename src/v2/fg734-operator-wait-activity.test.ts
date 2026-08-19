// FG-734: `waiting_on_operator` as a first-class DERIVED Current Activity status — Forge
// telling the operator it has INTENTIONALLY STOPPED and is waiting on a human decision,
// with the actionable reason. What is pinned here:
//
//   DERIVED, NEVER INFERRED (AC4). An operator wait exists ONLY where a DURABLE record
//   says so — a task parked at a `human` gate, or a campaign item that recorded a
//   `requested_human_action`. Free-form prose ("I need your decision") with no such
//   record creates nothing. No new table, no schema change.
//
//   HUMAN GATE ONLY (AC1). `awaiting_gate` is written for BOTH human and verdict gates;
//   only a `human` step is the operator's to decide. A verdict/auto/none gate is the
//   orchestrator's call and is NOT surfaced.
//
//   AUTONOMOUS HARD STOP (AC3). A campaign item that stopped itself and named the
//   authority it needs carries its stop category + reason + requested action.
//
//   RE-DERIVED LIVE (AC5). Advance/reject/cancel/terminal → the source record leaves the
//   live state and the wait clears with no stale row.
//
//   DE-DUPLICATION (AC6) + ALONGSIDE ACTIVE WORK (AC7). A human gate and a campaign stop
//   for the SAME run are ONE wait; and a live wait coexists with running agents rather
//   than flattening the workspace to idle.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb } from "../store/db.js";
import {
  OPERATOR_WAIT_LABEL,
  OPERATOR_WAIT_GATE_ACTION,
  deriveCurrentActivity,
  renderCurrentActivityLines,
  type StepGateResolver,
} from "./current-activity.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const PROJECT = "/repos/forge";
const OTHER_PROJECT = "/repos/other";
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

let db: DatabaseInstance;

beforeEach(() => {
  db = makeInMemoryDb();
});

afterEach(() => {
  db.close();
});

function addRun(seed: { id: string; workflow?: string; status?: string; projectDir?: string | null; ticketId?: string | null }): void {
  db.prepare(`
    INSERT INTO runs (id, workflow, title, status, created_at, metadata, project_dir)
    VALUES (@id, @workflow, @title, @status, @createdAt, @metadata, @projectDir)
  `).run({
    id: seed.id,
    workflow: seed.workflow ?? "feature",
    title: `run ${seed.id}`,
    status: seed.status ?? "active",
    createdAt: ago(600_000),
    metadata: seed.ticketId ? JSON.stringify({ ticketId: seed.ticketId }) : null,
    projectDir: seed.projectDir === undefined ? PROJECT : seed.projectDir,
  });
}

function addTask(seed: {
  id: string;
  runId: string;
  phase?: string;
  agentRole?: string;
  status?: string;
  startedAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
    VALUES (@id, @runId, @phase, @agentRole, @status, '{}', @createdAt, @startedAt)
  `).run({
    id: seed.id,
    runId: seed.runId,
    phase: seed.phase ?? "plan",
    agentRole: seed.agentRole ?? "engineer",
    status: seed.status ?? "awaiting_gate",
    createdAt: ago(300_000),
    startedAt: seed.startedAt === undefined ? ago(120_000) : seed.startedAt,
  });
}

function addCampaign(seed: { id: string; projectDir?: string | null }): void {
  db.prepare(`
    INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
    VALUES (@id, 'running', 'list', '{}', 'sequential', @ts, @ts, @projectDir)
  `).run({ id: seed.id, ts: ago(600_000), projectDir: seed.projectDir === undefined ? PROJECT : seed.projectDir });
}

function addCampaignItem(seed: {
  id: string;
  campaignId: string;
  ticketId: string;
  runId?: string | null;
  lifecycleStatus?: string;
  blockerKind?: string | null;
  reason?: string | null;
  requestedHumanAction?: string | null;
  updatedAt?: string;
}): void {
  db.prepare(`
    INSERT INTO campaign_items (
      id, campaign_id, item_order, ticket_id, run_id, lifecycle_status,
      blocker_kind, reason, requested_human_action, created_at, updated_at
    ) VALUES (
      @id, @campaignId, 1, @ticketId, @runId, @lifecycleStatus,
      @blockerKind, @reason, @requestedHumanAction, @createdAt, @updatedAt
    )
  `).run({
    id: seed.id,
    campaignId: seed.campaignId,
    ticketId: seed.ticketId,
    runId: seed.runId ?? null,
    lifecycleStatus: seed.lifecycleStatus ?? "awaiting_gate",
    blockerKind: seed.blockerKind ?? null,
    reason: seed.reason ?? null,
    requestedHumanAction: seed.requestedHumanAction ?? null,
    createdAt: ago(300_000),
    updatedAt: seed.updatedAt ?? ago(90_000),
  });
}

// A hermetic gate resolver: the workflow file is never touched, so a test declares the
// gate of each step id directly. Anything unlisted resolves `auto` (the schema default).
function gates(map: Record<string, "human" | "verdict" | "auto" | "none">): StepGateResolver {
  return (_workflow, _projectDir, stepId) => map[stepId] ?? "auto";
}

const derive = (
  resolveStepGate: StepGateResolver,
  scope?: { runId?: string; projectDirs?: readonly string[] },
) => deriveCurrentActivity(db, { now: NOW, scope, resolveStepGate });

// ─────────────────────────── AC1 — pending human gate ──────────────────────────────

describe("FG-734 AC1 — a run parked at a durable human gate is a waiting_on_operator entry", () => {
  test("human-gated awaiting_gate task surfaces with identity, reason, and requested action", () => {
    addRun({ id: "run-1", ticketId: "FG-100" });
    addTask({ id: "task-1", runId: "run-1", phase: "plan", agentRole: "architect", status: "awaiting_gate" });

    const activity = derive(gates({ plan: "human" }));
    assert.equal(activity.operatorWaits.length, 1);
    const w = activity.operatorWaits[0]!;
    assert.equal(w.kind, "waiting_on_operator");
    assert.equal(w.source, "human_gate");
    assert.equal(w.runId, "run-1");
    assert.equal(w.taskId, "task-1");
    assert.equal(w.ticketId, "FG-100");
    assert.equal(w.requestedAction, OPERATOR_WAIT_GATE_ACTION);
    assert.equal(w.statusLabel, OPERATOR_WAIT_LABEL);
    assert.match(w.reason, /plan/);
    assert.equal(w.startedAt, ago(120_000));
  });

  test("a VERDICT gate at awaiting_gate is the orchestrator's call — NOT an operator wait", () => {
    addRun({ id: "run-2", ticketId: "FG-101" });
    addTask({ id: "task-2", runId: "run-2", phase: "build", status: "awaiting_gate" });

    assert.equal(derive(gates({ build: "verdict" })).operatorWaits.length, 0);
    assert.equal(derive(gates({ build: "auto" })).operatorWaits.length, 0);
  });

  test("a task on a terminal run is not surfaced", () => {
    addRun({ id: "run-3", status: "abandoned" });
    addTask({ id: "task-3", runId: "run-3", phase: "plan", status: "awaiting_gate" });
    assert.equal(derive(gates({ plan: "human" })).operatorWaits.length, 0);
  });
});

// ───────────────────────── AC3 — autonomous hard stop ──────────────────────────────

describe("FG-734 AC3 — a campaign hard stop requiring operator authority surfaces the stop", () => {
  test("a parked campaign item with a requested_human_action carries category + reason + action", () => {
    addCampaign({ id: "camp-1" });
    addCampaignItem({
      id: "item-1",
      campaignId: "camp-1",
      ticketId: "FG-200",
      runId: "run-x",
      lifecycleStatus: "blocked_by_red",
      blockerKind: "human_decision",
      reason: "authoritative reviewer blocked the build",
      requestedHumanAction: "resolve the reviewer block then resume",
    });

    const activity = derive(gates({}));
    assert.equal(activity.operatorWaits.length, 1);
    const w = activity.operatorWaits[0]!;
    assert.equal(w.source, "campaign_hard_stop");
    assert.equal(w.ticketId, "FG-200");
    assert.equal(w.campaignId, "camp-1");
    assert.equal(w.itemId, "item-1");
    assert.equal(w.blockerKind, "human_decision");
    assert.equal(w.reason, "authoritative reviewer blocked the build");
    assert.equal(w.requestedAction, "resolve the reviewer block then resume");
  });

  test("an item with NO requested_human_action, or a terminal/advanced one, is not a stop", () => {
    addCampaign({ id: "camp-2" });
    addCampaignItem({ id: "item-2", campaignId: "camp-2", ticketId: "FG-201", lifecycleStatus: "blocked_by_red", reason: "x" });
    addCampaignItem({ id: "item-3", campaignId: "camp-2", ticketId: "FG-202", lifecycleStatus: "complete", requestedHumanAction: "already resolved" });
    addCampaignItem({ id: "item-4", campaignId: "camp-2", ticketId: "FG-203", lifecycleStatus: "running", requestedHumanAction: "stale" });
    assert.equal(derive(gates({})).operatorWaits.length, 0);
  });
});

// ─────────────────────────── AC4 — prose-only negative ─────────────────────────────

describe("FG-734 AC4 — free-form prose with no durable record creates nothing", () => {
  test("a running task whose result text asks for a decision is NOT an operator wait", () => {
    addRun({ id: "run-4" });
    // status 'running' — no awaiting_gate, no campaign stop. The derivation reads only
    // durable state, so there is no prose channel through which this could appear.
    addTask({ id: "task-4", runId: "run-4", phase: "build", status: "running" });
    assert.equal(derive(gates({ build: "human" })).operatorWaits.length, 0);
  });
});

// ─────────────────────────────── AC5 — resolution ──────────────────────────────────

describe("FG-734 AC5 — the wait clears the instant its source leaves the live state", () => {
  test("advancing the gate (task no longer awaiting_gate) removes the wait", () => {
    addRun({ id: "run-5", ticketId: "FG-300" });
    addTask({ id: "task-5", runId: "run-5", phase: "plan", status: "awaiting_gate" });
    assert.equal(derive(gates({ plan: "human" })).operatorWaits.length, 1);

    db.prepare(`UPDATE tasks SET status = 'complete' WHERE id = 'task-5'`).run();
    assert.equal(derive(gates({ plan: "human" })).operatorWaits.length, 0);
  });

  test("a campaign item advancing to complete removes its hard stop", () => {
    addCampaign({ id: "camp-5" });
    addCampaignItem({ id: "item-5", campaignId: "camp-5", ticketId: "FG-301", lifecycleStatus: "awaiting_gate", requestedHumanAction: "advance" });
    assert.equal(derive(gates({})).operatorWaits.length, 1);

    db.prepare(`UPDATE campaign_items SET lifecycle_status = 'complete', requested_human_action = NULL WHERE id = 'item-5'`).run();
    assert.equal(derive(gates({})).operatorWaits.length, 0);
  });
});

// ──────────────────── AC6 — multiple waits, de-duplicated by run ───────────────────

describe("FG-734 AC6 — simultaneous waits are counted without duplication", () => {
  test("two human gates + one unrelated campaign stop → three distinct entries", () => {
    addRun({ id: "run-a", ticketId: "FG-400" });
    addTask({ id: "task-a", runId: "run-a", phase: "plan", status: "awaiting_gate" });
    addRun({ id: "run-b", ticketId: "FG-401" });
    addTask({ id: "task-b", runId: "run-b", phase: "docs", status: "awaiting_gate" });
    addCampaign({ id: "camp-a" });
    addCampaignItem({ id: "item-a", campaignId: "camp-a", ticketId: "FG-402", runId: "run-c", lifecycleStatus: "blocked_by_red", requestedHumanAction: "resolve" });

    const waits = derive(gates({ plan: "human", docs: "human" })).operatorWaits;
    assert.equal(waits.length, 3);
    assert.equal(new Set(waits.map((w) => w.waitKey)).size, 3);
  });

  test("a human gate AND a campaign stop for the SAME run collapse to one entry (the gate wins)", () => {
    addRun({ id: "run-dup", ticketId: "FG-500" });
    addTask({ id: "task-dup", runId: "run-dup", phase: "plan", status: "awaiting_gate" });
    addCampaign({ id: "camp-dup" });
    addCampaignItem({ id: "item-dup", campaignId: "camp-dup", ticketId: "FG-500", runId: "run-dup", lifecycleStatus: "awaiting_gate", requestedHumanAction: "advance" });

    const waits = derive(gates({ plan: "human" })).operatorWaits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.source, "human_gate");
    assert.equal(waits[0]!.taskId, "task-dup");
  });
});

// ──────────────── AC7 — coexists with active work, does not flatten to idle ─────────

describe("FG-734 AC7 — a live operator wait stays visible ALONGSIDE running agents", () => {
  test("a running agent and a human gate are both present", () => {
    addRun({ id: "run-live", ticketId: "FG-600" });
    addTask({ id: "task-run", runId: "run-live", phase: "build", agentRole: "engineer", status: "running" });
    addRun({ id: "run-gate", ticketId: "FG-601" });
    addTask({ id: "task-gate", runId: "run-gate", phase: "plan", status: "awaiting_gate" });

    const activity = derive(gates({ plan: "human" }));
    assert.ok(activity.agents.some((a) => a.taskId === "task-run"), "running agent present");
    assert.equal(activity.operatorWaits.length, 1, "operator wait present alongside it");
  });
});

// ─────────────────────────── scope + render ────────────────────────────────────────

describe("FG-734 — scope and rendering", () => {
  test("project scope excludes waits from another project", () => {
    addRun({ id: "run-here", projectDir: PROJECT, ticketId: "FG-700" });
    addTask({ id: "task-here", runId: "run-here", phase: "plan", status: "awaiting_gate" });
    addRun({ id: "run-there", projectDir: OTHER_PROJECT, ticketId: "FG-701" });
    addTask({ id: "task-there", runId: "run-there", phase: "plan", status: "awaiting_gate" });

    const scoped = derive(gates({ plan: "human" }), { projectDirs: [PROJECT] });
    assert.equal(scoped.operatorWaits.length, 1);
    assert.equal(scoped.operatorWaits[0]!.runId, "run-here");
  });

  test("run scope pins to exactly one run", () => {
    addRun({ id: "run-one", ticketId: "FG-702" });
    addTask({ id: "task-one", runId: "run-one", phase: "plan", status: "awaiting_gate" });
    addRun({ id: "run-two", ticketId: "FG-703" });
    addTask({ id: "task-two", runId: "run-two", phase: "plan", status: "awaiting_gate" });

    const scoped = derive(gates({ plan: "human" }), { runId: "run-one" });
    assert.equal(scoped.operatorWaits.length, 1);
    assert.equal(scoped.operatorWaits[0]!.runId, "run-one");
  });

  test("the human line names the wait; an empty set renders the parenthesised absence", () => {
    addRun({ id: "run-r", ticketId: "FG-800" });
    addTask({ id: "task-r", runId: "run-r", phase: "plan", status: "awaiting_gate" });
    const lines = renderCurrentActivityLines(derive(gates({ plan: "human" })));
    assert.ok(lines.includes("  Waiting on operator"), "section heading present");
    assert.ok(lines.some((l) => l.includes(OPERATOR_WAIT_LABEL) && l.includes("FG-800")), "row names the ticket");

    const emptyLines = renderCurrentActivityLines(derive(gates({})));
    assert.ok(emptyLines.includes("    (nothing waiting on operator)"), "empty absence rendered");
  });
});
