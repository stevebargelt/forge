// FG-516 (coverage gap — the CONTRACT BOUNDARY the ticket names): `forge ops
// check` pushes one milestone per new incident in LIVE mode, but `--json` "stays
// read-only." The engineer's ops.test.ts calls the notifyLiveIncidents helper
// directly — it never proves the two things the ticket actually promises:
//
//   1. --json READ-ONLY: driving the REAL registered `ops check --json` action
//      over live incidents pushes/records NOTHING, while the SAME incidents
//      through the LIVE action DO push. This is a negative (absence) assertion on
//      the events store — the read-only contract boundary, exercised through the
//      real commander action rather than the helper.
//   2. DEDUPE ACROSS INVOCATIONS: the engineer's re-run dedupe test calls the
//      helper twice within one process. This drives the REAL `ops check` action
//      TWICE over the same standing incidents (two independent command
//      invocations against the shared event log — as two separate `ops check`
//      runs would be) and proves ONE push total.
//
// Both invoke the registered commander action in-process (no child process — unit
// tier safe). Provider mocking mirrors ops.test.ts: FORGE_NOTIFY=ntfy + NTFY_URL +
// a stubbed global fetch, NO_NOTIFY cleared so a push actually fires; fetch calls
// count the real pushes.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { eventsForRun } from "../../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../../types/index.js";
import { registerOps } from "./ops.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z" };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

const NOTIFY_ENV_KEYS = ["NO_NOTIFY", "FORGE_NOTIFY", "NTFY_URL"] as const;

// Run `fn` with a stubbed ntfy provider active; `fetchCalls()` counts real pushes.
// console.log is silenced so the action's report rendering doesn't spam the suite.
function withStubProvider(fn: (fetchCalls: () => number) => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let calls = 0;
  process.env["NO_NOTIFY"] = "";
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
  console.log = () => {};
  return (async () => {
    try {
      await fn(() => calls);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
      for (const k of NOTIFY_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k] as string;
      }
    }
  })();
}

// Invoke the REAL registered `ops check` action in-process. `--all` scopes
// host-wide so the synthetic incidents (which have no project_dir) are found —
// matching the existing tests' argument-less runOpsCheck().
async function runOpsCheckAction(...extra: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride(); // never let commander call process.exit in-test
  registerOps(program);
  await program.parseAsync(["ops", "check", "--all", ...extra], { from: "user" });
}

function opsMilestoneEvents(runId: string) {
  return eventsForRun(runId)
    .filter((e) => e.eventType === "orchestrator.milestone")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => typeof p["dedupeKey"] === "string" && (p["dedupeKey"] as string).startsWith("ops-incident:"));
}
function dispatchedOpsMilestones(runId: string): number {
  return opsMilestoneEvents(runId).filter((p) => p["dispatched"] === true).length;
}

test("FG-516: `ops check --json` records/pushes NOTHING (read-only), while the same incidents through the live action DO push", async () => {
  insertRun(mkRun("run-orphan-json", "complete"));
  insertTask(mkTask("t-orphan-json", "run-orphan-json", "pending")); // retry_orphan

  await withStubProvider(async (fetchCalls) => {
    // --json path: read-only. No push, no milestone event recorded at all.
    await runOpsCheckAction("--json");
    assert.equal(fetchCalls(), 0, "--json must not push");
    assert.equal(opsMilestoneEvents("run-orphan-json").length, 0, "--json must not record any ops milestone event (read-only contract)");

    // The SAME standing incident through the LIVE action DOES push — proving the
    // absence above is the --json boundary, not a detection miss.
    await runOpsCheckAction();
    assert.equal(fetchCalls(), 1, "the live path pushes the incident the --json path ignored");
    assert.equal(dispatchedOpsMilestones("run-orphan-json"), 1, "the live path records a dispatched milestone");
  });
});

test("FG-516: two independent `ops check` action invocations over the same standing incidents push exactly once (dedupe across invocations)", async () => {
  insertRun(mkRun("run-orphan-twice", "complete"));
  insertTask(mkTask("t-orphan-twice", "run-orphan-twice", "pending"));
  insertRun(mkRun("run-stuck-twice", "active"));
  insertTask(mkTask("t-stuck-twice", "run-stuck-twice", "failed")); // stuck_run

  await withStubProvider(async (fetchCalls) => {
    // First `ops check` — both incidents are new, both push.
    await runOpsCheckAction();
    assert.equal(fetchCalls(), 2, "first invocation pushes both new incidents");

    // Second, independent `ops check` over the identical standing incidents. The
    // incident-identity dedupe key + emitMilestone's persistent, event-log-backed
    // dedupe must suppress every re-push.
    await runOpsCheckAction();
    assert.equal(fetchCalls(), 2, "the second invocation pushes nothing for the same standing incidents");
    assert.equal(dispatchedOpsMilestones("run-orphan-twice"), 1, "exactly one dispatched milestone for the orphan incident");
    assert.equal(dispatchedOpsMilestones("run-stuck-twice"), 1, "exactly one dispatched milestone for the stuck incident");
  });
});
