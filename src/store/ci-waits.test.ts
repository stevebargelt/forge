// FG-731 (Step 1): the durable ci_waits store.
//
// The load-bearing properties proven here:
//   * register-before-poll — the row EXISTS before any observation.
//   * the two independent axes stay independent — lifecycle_state decides liveness,
//     observed_state carries the last-observed CI aggregate, and `no_runs` never
//     collapses into `unavailable`.
//   * TERMINAL AUTHORITY IS REMOTE — an expired lease does NOT terminalize the wait
//     (the OPPOSITE of a launch's owner_gone). Terminal is reached only via advance.
//
// Real store code against a real in-memory SQLite DB (makeInMemoryDb) — never
// ~/.forge/forge.db. A separate aged-shape file proves fresh-vs-migrated parity.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "./publications.js";
import {
  advanceCiWait,
  getCiWait,
  isCiWaitLive,
  isTerminalCiWaitState,
  observeCiWait,
  readCiWaitLease,
  readCiWaits,
  registerCiWait,
  renewCiWaitLease,
  CI_WAIT_KIND_VALUES,
} from "./ci-waits.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const T0 = "2026-08-18T10:00:00.000Z";
const T1 = "2026-08-18T10:01:00.000Z";
const T2 = "2026-08-18T10:02:00.000Z";

function registerPush(id: string, overrides: Record<string, unknown> = {}): void {
  const ok = registerCiWait({
    id,
    kind: "push_actions",
    remote: { repo: "acme/forge", actionsRunId: "7788" },
    url: "https://github.com/acme/forge/actions/runs/7788",
    startedAt: T0,
    association: { runId: "run-abc", ticketId: "FG-731", projectDir: "/repos/forge" },
    ...overrides,
  });
  assert.equal(ok, true);
}

describe("FG-731 ci_waits — register-before-poll", () => {
  test("the register INSERT is a durable row that EXISTS before any observation", () => {
    registerPush("ciwait-a1");
    const wait = getCiWait("ciwait-a1");
    assert.ok(wait, "the row must exist immediately after register, before any gh call");
    assert.equal(wait.lifecycleState, "registered");
    assert.equal(wait.terminal, false);
    assert.equal(wait.observedState, null, "a register-before-poll row has looked at nothing yet");
    assert.equal(wait.observedAt, null);
    assert.equal(wait.repo, "acme/forge");
    assert.equal(wait.actionsRunId, "7788");
    assert.equal(wait.runId, "run-abc");
    assert.equal(wait.ticketId, "FG-731");
    assert.equal(wait.projectDir, "/repos/forge");
  });

  test("a registered (non-terminal) wait is LIVE independent of any observation freshness", () => {
    registerPush("ciwait-a2");
    assert.equal(isCiWaitLive(getCiWait("ciwait-a2")!), true);
  });

  test("register stores the workflow_dispatch REQUEST with no run id yet (filled on first observation)", () => {
    const ok = registerCiWait({
      id: "ciwait-dispatch",
      kind: "workflow_dispatch",
      remote: {
        repo: "acme/forge",
        workflowFile: "measure-integration-timings.yml",
        dispatchRef: "main",
        dispatchInputs: { shard: "3" },
      },
      startedAt: T0,
      association: { ticketId: "FG-704" },
    });
    assert.equal(ok, true);
    const wait = getCiWait("ciwait-dispatch")!;
    assert.equal(wait.kind, "workflow_dispatch");
    assert.equal(wait.actionsRunId, null, "run id is unknown at trigger time");
    assert.equal(wait.url, null);
    assert.equal(wait.workflowFile, "measure-integration-timings.yml");
    assert.equal(wait.dispatchRef, "main");
    assert.equal(wait.dispatchInputs, JSON.stringify({ shard: "3" }));
  });

  test("re-registering the same id does not clobber an already-progressed row", () => {
    registerPush("ciwait-a3");
    observeCiWait("ciwait-a3", { state: "running", m: 2, n: 5 }, T1);
    registerPush("ciwait-a3");
    assert.equal(getCiWait("ciwait-a3")!.lifecycleState, "running", "ON CONFLICT DO NOTHING");
  });
});

describe("FG-731 ci_waits — observation transitions", () => {
  test("registered -> running on the first successful observation, with m/n counts", () => {
    registerPush("ciwait-b1");
    assert.equal(observeCiWait("ciwait-b1", { state: "running", m: 1, n: 4 }, T1), true);
    const wait = getCiWait("ciwait-b1")!;
    assert.equal(wait.lifecycleState, "running");
    assert.equal(wait.terminal, false);
    assert.equal(wait.observedState, "running");
    assert.equal(wait.observedM, 1);
    assert.equal(wait.observedN, 4);
    assert.equal(wait.observedAt, T1);
  });

  test("observing `completed` -> completed_awaiting_advance (a REAL non-terminal state, not a leak)", () => {
    registerPush("ciwait-b2");
    observeCiWait("ciwait-b2", { state: "running", m: 3, n: 4 }, T1);
    assert.equal(observeCiWait("ciwait-b2", { state: "completed" }, T2), true);
    const wait = getCiWait("ciwait-b2")!;
    assert.equal(wait.lifecycleState, "completed_awaiting_advance");
    assert.equal(wait.terminal, false, "an advance is owed — completed_awaiting_advance is NOT terminal");
    assert.equal(isCiWaitLive(wait), true);
    assert.equal(wait.observedState, "completed");
  });

  test("workflow_dispatch fills the run id and url on first observation", () => {
    registerCiWait({
      id: "ciwait-b3",
      kind: "workflow_dispatch",
      remote: { repo: "acme/forge", workflowFile: "wf.yml", dispatchRef: "main" },
      startedAt: T0,
    });
    observeCiWait(
      "ciwait-b3",
      { state: "running", m: 0, n: 1 },
      T1,
      { actionsRunId: "9910", url: "https://github.com/acme/forge/actions/runs/9910" },
    );
    const wait = getCiWait("ciwait-b3")!;
    assert.equal(wait.actionsRunId, "9910");
    assert.equal(wait.url, "https://github.com/acme/forge/actions/runs/9910");
  });

  test("observe never creates a row for an unregistered id (no fabrication)", () => {
    assert.equal(observeCiWait("ciwait-nope", { state: "running" }, T1), false);
    assert.equal(getCiWait("ciwait-nope"), undefined);
  });

  test("`no_runs` and `unavailable` are DISTINCT — neither collapses into the other", () => {
    registerPush("ciwait-noruns");
    observeCiWait("ciwait-noruns", { state: "no_runs" }, T1);
    const noRuns = getCiWait("ciwait-noruns")!;
    assert.equal(noRuns.observedState, "no_runs");
    assert.equal(noRuns.observedReason, null);

    registerPush("ciwait-unavail");
    observeCiWait("ciwait-unavail", { state: "unavailable", reason: "gh exited 1" }, T1);
    const unavail = getCiWait("ciwait-unavail")!;
    assert.equal(unavail.observedState, "unavailable");
    assert.equal(unavail.observedReason, "gh exited 1");

    assert.notEqual(noRuns.observedState, unavail.observedState);
  });
});

describe("FG-731 ci_waits — terminal dispositions (advance/cancel/abandon)", () => {
  test("completed_awaiting_advance -> advanced is terminal", () => {
    registerPush("ciwait-c1");
    observeCiWait("ciwait-c1", { state: "completed" }, T1);
    assert.equal(advanceCiWait("ciwait-c1", "advanced"), true);
    const wait = getCiWait("ciwait-c1")!;
    assert.equal(wait.lifecycleState, "advanced");
    assert.equal(wait.terminal, true);
    assert.equal(wait.terminalDisposition, "advanced");
    assert.equal(isCiWaitLive(wait), false);
  });

  test("`advanced` is REFUSED before the run is observed terminal", () => {
    registerPush("ciwait-c2");
    observeCiWait("ciwait-c2", { state: "running", m: 1, n: 4 }, T1);
    assert.equal(advanceCiWait("ciwait-c2", "advanced"), false, "you cannot advance past a still-running wait");
    assert.equal(getCiWait("ciwait-c2")!.terminal, false);
  });

  test("cancelled fires from any non-terminal state and leaves the live surface", () => {
    registerPush("ciwait-c3");
    observeCiWait("ciwait-c3", { state: "running", m: 1, n: 4 }, T1);
    assert.equal(advanceCiWait("ciwait-c3", "cancelled"), true);
    assert.equal(getCiWait("ciwait-c3")!.terminalDisposition, "cancelled");
  });

  test("abandoned fires from a bare registered wait (a resolvable-not-found remote)", () => {
    registerPush("ciwait-c4");
    assert.equal(advanceCiWait("ciwait-c4", "abandoned"), true);
    const wait = getCiWait("ciwait-c4")!;
    assert.equal(wait.lifecycleState, "abandoned");
    assert.equal(wait.terminal, true);
  });

  test("the first disposition wins — a terminal wait is not re-terminalized or resurrected", () => {
    registerPush("ciwait-c5");
    advanceCiWait("ciwait-c5", "cancelled");
    assert.equal(advanceCiWait("ciwait-c5", "abandoned"), false);
    assert.equal(observeCiWait("ciwait-c5", { state: "running" }, T2), false, "observe never resurrects a terminal wait");
    assert.equal(getCiWait("ciwait-c5")!.terminalDisposition, "cancelled");
  });
});

describe("FG-731 ci_waits — the lease is NOT terminal authority", () => {
  test("renew/read round-trips the owner and epoch-ms expiry", () => {
    registerPush("ciwait-d1");
    const before = storeNowMs();
    assert.equal(renewCiWaitLease("ciwait-d1", "orchestrator@host", 30_000), true);
    const lease = readCiWaitLease("ciwait-d1")!;
    assert.equal(lease.owner, "orchestrator@host");
    assert.ok(lease.leaseExpiresAtMs! >= before + 30_000);
  });

  test("an EXPIRED lease does NOT terminalize the wait — terminal is reachable ONLY via observation/advance", () => {
    registerPush("ciwait-d2");
    renewCiWaitLease("ciwait-d2", "dead-waiter", 1_000);
    observeCiWait("ciwait-d2", { state: "running", m: 1, n: 3 }, T1);

    // Age the STORE clock a full hour past the lease — the waiter is provably gone.
    setPublicationClockOffsetForTest(3_600_000);
    const lease = readCiWaitLease("ciwait-d2")!;
    assert.ok(lease.leaseExpiresAtMs! < storeNowMs(), "the lease is genuinely expired");

    // The wait is STILL live: the CI run is real on GitHub regardless of the waiter.
    const wait = getCiWait("ciwait-d2")!;
    assert.equal(wait.terminal, false, "an expired lease is the OPPOSITE of a launch's owner_gone — never terminal here");
    assert.equal(isCiWaitLive(wait), true);
    assert.equal(wait.lifecycleState, "running");
    // It is still adoptable/observable, and re-observation is what would eventually
    // terminalize it (Step 3), never the lease.
    assert.equal(readCiWaits({ liveOnly: true }).some((w) => w.id === "ciwait-d2"), true);
  });
});

describe("FG-731 ci_waits — reads and vocabulary", () => {
  test("readCiWaits returns newest-first and liveOnly excludes terminal rows", () => {
    registerPush("ciwait-e1", { startedAt: T0 });
    registerPush("ciwait-e2", { startedAt: T2 });
    advanceCiWait("ciwait-e1", "cancelled");

    const all = readCiWaits();
    assert.deepEqual(all.map((w) => w.id), ["ciwait-e2", "ciwait-e1"], "newest started_at first");

    const live = readCiWaits({ liveOnly: true });
    assert.deepEqual(live.map((w) => w.id), ["ciwait-e2"]);
  });

  test("the kind vocabulary is exactly the three FG-731 wait kinds", () => {
    assert.deepEqual([...CI_WAIT_KIND_VALUES].sort(), ["pr_checks", "push_actions", "workflow_dispatch"]);
  });

  test("isTerminalCiWaitState: only advanced/cancelled/abandoned are terminal", () => {
    assert.equal(isTerminalCiWaitState("registered"), false);
    assert.equal(isTerminalCiWaitState("running"), false);
    assert.equal(isTerminalCiWaitState("completed_awaiting_advance"), false);
    assert.equal(isTerminalCiWaitState("advanced"), true);
    assert.equal(isTerminalCiWaitState("cancelled"), true);
    assert.equal(isTerminalCiWaitState("abandoned"), true);
    assert.equal(isTerminalCiWaitState("some_future_state"), false, "an unknown state stays non-terminal — never silently dropped");
  });
});
