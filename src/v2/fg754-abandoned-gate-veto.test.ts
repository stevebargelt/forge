// FG-754 (AC2, defense in depth): the surviving leak is the HUMAN-GATE path.
// readAwaitingGateTasks feeds `forge status` "Waiting on operator" and the Home
// attention inbox, keying only on t.status='awaiting_gate' + r.status='active' with NO
// campaign awareness — so an abandoned campaign's parked gate task rendered as a live
// operator wait forever. This pins the campaign-status veto on that path:
//
//   - a gate task on an active run whose campaign is ABANDONED yields ZERO operatorWaits;
//   - a NON-campaign gate (no campaign_item on the run) is unaffected;
//   - a PAUSED-campaign gate is unaffected (FG-750 preserved — the veto is strictly
//     scoped to 'abandoned').

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb } from "../store/db.js";
import { deriveCurrentActivity, type StepGateResolver } from "./current-activity.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const TS = "2026-06-30T00:00:00.000Z"; // an aged park, like the live example

let db: DatabaseInstance;

beforeEach(() => {
  db = makeInMemoryDb();
});

afterEach(() => {
  db.close();
});

// Every gate here resolves to a human gate — the path readAwaitingGateTasks feeds.
const humanGate: StepGateResolver = () => "human";
const derive = () => deriveCurrentActivity(db, { now: NOW, resolveStepGate: humanGate });

function addRun(id: string): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, metadata) VALUES (?, 'feature', ?, 'active', ?, '{}')`
  ).run(id, id, TS);
}

function addGateTask(runId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
     VALUES (?, ?, 'gate', 'engineer', 'awaiting_gate', '{}', ?, ?)`
  ).run(`task-${runId}`, runId, TS, TS);
}

function addCampaign(id: string, status: string): void {
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at) VALUES (?, ?, 'list', '{}', 'serial', ?, ?)`
  ).run(id, status, TS, TS);
}

function linkItem(campaignId: string, runId: string): void {
  db.prepare(
    `INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, created_at, updated_at)
     VALUES (?, ?, 0, 'FG-1', ?, 'awaiting_gate', ?, ?)`
  ).run(`item-${runId}`, campaignId, runId, TS, TS);
}

describe("FG-754 AC2 — the human-gate operator-wait path is campaign-aware", () => {
  test("a gate task under an ABANDONED campaign is NOT a live operator wait", () => {
    addRun("run-abandoned");
    addGateTask("run-abandoned");
    addCampaign("camp-abandoned", "abandoned");
    linkItem("camp-abandoned", "run-abandoned");

    assert.equal(derive().operatorWaits.length, 0);
  });

  test("a NON-campaign gate task is unaffected", () => {
    addRun("run-plain");
    addGateTask("run-plain");

    const waits = derive().operatorWaits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.source, "human_gate");
    assert.equal(waits[0]!.runId, "run-plain");
  });

  test("a PAUSED-campaign gate task stays visible (FG-750 preserved)", () => {
    addRun("run-paused");
    addGateTask("run-paused");
    addCampaign("camp-paused", "paused");
    linkItem("camp-paused", "run-paused");

    const waits = derive().operatorWaits;
    assert.equal(waits.length, 1, "the veto is scoped strictly to 'abandoned' — a paused campaign still surfaces");
    assert.equal(waits[0]!.runId, "run-paused");
  });

  test("mixed: only the abandoned-campaign gate is suppressed", () => {
    addRun("run-a");
    addGateTask("run-a");
    addCampaign("camp-a", "abandoned");
    linkItem("camp-a", "run-a");

    addRun("run-b");
    addGateTask("run-b");

    const waits = derive().operatorWaits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.runId, "run-b");
  });
});
