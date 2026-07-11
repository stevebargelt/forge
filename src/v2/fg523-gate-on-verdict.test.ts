// FG-523 (F16): gate_on_verdict persisted on verdict rows.
//
// Dispatch blocked on the in-hand red config (authoritative + gate_on_verdict +
// fail); the later gate re-check (aggregateVerdicts) re-derived blocking from
// verdict ROWS, which never recorded the flag. A gate_on_verdict:false
// authoritative fail therefore didn't block dispatch but DID block the gate —
// two sites, two rules. These tests cover the row-level half: the persisted
// flag, the legacy NULL row (fail closed), and the one shared predicate.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import { aggregateVerdicts, verdictBlocksGate } from "./gate.js";
import type { Run, Task, VerdictRow } from "../types/index.js";

const RUN: Run = {
  id: "run-fg523-gov",
  workflow: "test-wf",
  title: "gate_on_verdict persistence",
  status: "active",
  createdAt: "2026-07-11T00:00:00Z",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function stubTask(id: string, role: string): void {
  const t: Task = {
    id,
    runId: RUN.id,
    phase: "review",
    agentRole: role,
    status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "review", role, inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-11T00:00:00Z",
  };
  insertTask(t);
}

function fail(
  id: string,
  authority: VerdictRow["authority"],
  gateOnVerdict: boolean | null | undefined,
): void {
  stubTask(`${id}-red`, "red");
  insertVerdict({
    id,
    taskId: "task-primary",
    redTaskId: `${id}-red`,
    redRole: `red-${id}`,
    verdict: "fail",
    confidence: 0.9,
    authority,
    findings: [{ severity: "high", summary: "s", evidence: "e", hypothesis: "h" }],
    createdAt: "2026-07-11T00:00:01Z",
    ...(gateOnVerdict === undefined ? {} : { gateOnVerdict }),
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  stubTask("task-primary", "engineer");
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-523 F16: gate_on_verdict round-trips through the verdicts table", () => {
  fail("v-true", "authoritative", true);
  fail("v-false", "authoritative", false);

  const rows = verdictsForTask("task-primary");
  assert.equal(rows.find((r) => r.id === "v-true")!.gateOnVerdict, true);
  assert.equal(rows.find((r) => r.id === "v-false")!.gateOnVerdict, false);
});

test("FG-523 F16 legacy: a row written without the column reads back NULL and still blocks (fail closed)", () => {
  // Simulate a pre-migration row: insert bypassing the accessor, exactly as the
  // old INSERT (no gate_on_verdict column) would have.
  stubTask("legacy-red", "red");
  getDb()
    .prepare(
      `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("v-legacy", "task-primary", "legacy-red", "red-legacy", "fail", 0.9, "authoritative", "[]", "2026-07-11T00:00:01Z");

  const row = verdictsForTask("task-primary").find((r) => r.id === "v-legacy")!;
  assert.equal(row.gateOnVerdict, null, "the column is nullable and NOT defaulted — no rewrite of existing rows");
  assert.equal(verdictBlocksGate(row), true, "an unknown flag blocks, exactly as before the column existed");
  assert.equal(aggregateVerdicts([row]).verdict, "fail");
});

test("FG-523 F16: aggregateVerdicts over a MIXED set — only the flag-true authoritative fail blocks", () => {
  fail("v-auth-true", "authoritative", true);
  fail("v-auth-false", "authoritative", false);
  fail("v-specialist", "specialist", true);

  const agg = aggregateVerdicts(verdictsForTask("task-primary"));
  assert.equal(agg.verdict, "fail");
  assert.deepEqual(agg.authoritativeFails.map((v) => v.id), ["v-auth-true"]);
  assert.deepEqual(agg.specialistFails.map((v) => v.id), ["v-specialist"]);
});

test("FG-523 F16: a gate_on_verdict:false authoritative fail alone no longer blocks the gate re-check", () => {
  fail("v-auth-false", "authoritative", false);
  fail("v-specialist", "specialist", true);

  const agg = aggregateVerdicts(verdictsForTask("task-primary"));
  assert.notEqual(agg.verdict, "fail", "dispatch advanced past this fail — the gate must agree");
  assert.deepEqual(agg.authoritativeFails, []);
  assert.deepEqual(agg.specialistFails.map((v) => v.id), ["v-specialist"], "the specialist fail still needs a rationale");
});

test("FG-523 F16: verdictBlocksGate is one rule — pass/inconclusive never block, whatever the flag", () => {
  const base = { authority: "authoritative" as const };
  assert.equal(verdictBlocksGate({ ...base, verdict: "pass", gateOnVerdict: true }), false);
  assert.equal(verdictBlocksGate({ ...base, verdict: "inconclusive", gateOnVerdict: true }), false);
  assert.equal(verdictBlocksGate({ ...base, verdict: "fail", gateOnVerdict: true }), true);
  assert.equal(verdictBlocksGate({ ...base, verdict: "fail", gateOnVerdict: null }), true);
  assert.equal(verdictBlocksGate({ ...base, verdict: "fail" }), true);
  assert.equal(verdictBlocksGate({ ...base, verdict: "fail", gateOnVerdict: false }), false);
  assert.equal(verdictBlocksGate({ authority: "specialist", verdict: "fail", gateOnVerdict: true }), false);
});
