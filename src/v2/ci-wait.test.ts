// FG-731 (Step 2a + 3): the CI-wait engine — arm/adopt, gh-probe parsing, the
// block-wait loop's single terminal emit, and reconcile re-observation recovery.
//
// The `gh` boundary is ALWAYS stubbed (a canned GhExec) — no test touches the network.
// Real store code against a real in-memory SQLite DB.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "../store/publications.js";
import { getCiWait, readCiWaits, renewCiWaitLease, type CiWait } from "../store/ci-waits.js";
import {
  armCiWait,
  probeCiWait,
  stepCiWait,
  runCiWaitLoop,
  reconcileCiWaits,
  type GhExec,
  type CiWaitProbe,
  type CiWaitProbeOutcome,
} from "./ci-wait.js";

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

const OWNER = "host:123";

function armPr(): ReturnType<typeof armCiWait> {
  return armCiWait({
    kind: "pr_checks",
    remote: { repo: "acme/forge", prNumber: 42 },
    owner: OWNER,
    leaseMs: 60000,
    association: { projectDir: "/repos/forge", ticketId: "FG-731" },
  });
}

/** A canned gh reader keyed on the first two argv words. */
function stubGh(map: Record<string, GhExec>): GhExec {
  return (args, cwd) => {
    const key = `${args[0]} ${args[1]}`;
    const fn = map[key];
    if (!fn) return { ok: false, notFound: true, reason: `no stub for '${key}'` };
    return fn(args, cwd);
  };
}

describe("FG-731 probeCiWait — gh parsing per kind + observed-state distinction", () => {
  test("pr_checks: a mixed rollup is running (m/n); a full rollup is completed", () => {
    const wait = { kind: "pr_checks", repo: "acme/forge", prNumber: 42, projectDir: null } as CiWait;
    const running = probeCiWait(
      wait,
      stubGh({
        "pr view": () => ({ ok: true, stdout: JSON.stringify({ state: "OPEN", url: "u", statusCheckRollup: [{ status: "COMPLETED" }, { status: "IN_PROGRESS" }] }) }),
      }),
    );
    assert.deepEqual(running.observation, { state: "running", m: 1, n: 2 });
    assert.equal(running.resolved?.url, "u");

    const done = probeCiWait(
      wait,
      stubGh({ "pr view": () => ({ ok: true, stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: [{ status: "COMPLETED" }] }) }) }),
    );
    assert.equal(done.observation.state, "completed");
  });

  test("pr_checks: an empty rollup is no_runs, NOT unavailable and NOT a fake success", () => {
    const wait = { kind: "pr_checks", repo: "acme/forge", prNumber: 42, projectDir: null } as CiWait;
    const out = probeCiWait(wait, stubGh({ "pr view": () => ({ ok: true, stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: [] }) }) }));
    assert.equal(out.observation.state, "no_runs");
    assert.notEqual(out.observation.state, "unavailable");
  });

  test("pr_checks: a gh failure is unavailable (with reason) — distinct from no_runs", () => {
    const wait = { kind: "pr_checks", repo: "acme/forge", prNumber: 42, projectDir: null } as CiWait;
    const out = probeCiWait(wait, stubGh({ "pr view": () => ({ ok: false, notFound: false, reason: "HTTP 503" }) }));
    assert.equal(out.observation.state, "unavailable");
    assert.equal(out.observation.state === "unavailable" ? out.observation.reason : null, "HTTP 503");
    assert.notEqual(out.gone, true);
  });

  test("pr_checks: a MERGED/CLOSED PR is a resolvable-gone remote (→ abandoned)", () => {
    const wait = { kind: "pr_checks", repo: "acme/forge", prNumber: 42, projectDir: null } as CiWait;
    const out = probeCiWait(wait, stubGh({ "pr view": () => ({ ok: true, stdout: JSON.stringify({ state: "MERGED", statusCheckRollup: [] }) }) }));
    assert.equal(out.gone, true);
  });

  test("pr_checks: gh not-found is a gone remote, not unavailable", () => {
    const wait = { kind: "pr_checks", repo: "acme/forge", prNumber: 42, projectDir: null } as CiWait;
    const out = probeCiWait(wait, stubGh({ "pr view": () => ({ ok: false, notFound: true, reason: "Could not resolve to a PullRequest" }) }));
    assert.equal(out.gone, true);
  });

  test("push_actions with a known run id: completed vs running(m/n) from jobs", () => {
    const wait = { kind: "push_actions", repo: "acme/forge", actionsRunId: "99", projectDir: null } as CiWait;
    const running = probeCiWait(
      wait,
      stubGh({ "run view": () => ({ ok: true, stdout: JSON.stringify({ status: "in_progress", url: "ru", jobs: [{ status: "completed" }, { status: "in_progress" }] }) }) }),
    );
    assert.deepEqual(running.observation, { state: "running", m: 1, n: 2 });
    const done = probeCiWait(wait, stubGh({ "run view": () => ({ ok: true, stdout: JSON.stringify({ status: "completed", jobs: [] }) }) }));
    assert.equal(done.observation.state, "completed");
  });

  test("workflow_dispatch resolves its run id on the FIRST observation (run id unknown at trigger)", () => {
    const wait = { kind: "workflow_dispatch", repo: "acme/forge", actionsRunId: null, workflowFile: "timings.yml", dispatchRef: "main", projectDir: null } as CiWait;
    const out = probeCiWait(
      wait,
      stubGh({ "run list": () => ({ ok: true, stdout: JSON.stringify([{ databaseId: 555, status: "in_progress", url: "wu", headBranch: "main", event: "workflow_dispatch" }]) }) }),
    );
    assert.equal(out.resolved?.actionsRunId, "555");
    assert.equal(out.resolved?.url, "wu");
    assert.equal(out.observation.state, "running");
  });

  test("workflow_dispatch: no matching run yet is no_runs (nothing started), not unavailable", () => {
    const wait = { kind: "workflow_dispatch", repo: "acme/forge", actionsRunId: null, workflowFile: "timings.yml", dispatchRef: "main", projectDir: null } as CiWait;
    const out = probeCiWait(wait, stubGh({ "run list": () => ({ ok: true, stdout: JSON.stringify([]) }) }));
    assert.equal(out.observation.state, "no_runs");
  });
});

describe("FG-731 armCiWait — register-before-poll + adopt-on-duplicate", () => {
  test("arm registers a durable row that EXISTS before any probe runs", () => {
    let probedBeforeRow = false;
    const armed = armPr();
    assert.ok(getCiWait(armed.id), "the record must exist the instant the wait is armed");
    // Prove the FIRST probe sees an already-registered row.
    const probe: CiWaitProbe = (w) => {
      probedBeforeRow = getCiWait(w.id) !== undefined;
      return { observation: { state: "running", m: 0, n: 1 } };
    };
    stepCiWait(armed.id, probe);
    assert.equal(probedBeforeRow, true);
  });

  test("a second arm for the same live remote identity ADOPTS — no duplicate row", () => {
    const first = armPr();
    const second = armPr();
    assert.equal(second.adopted, true);
    assert.equal(second.id, first.id);
    const live = readCiWaits({ liveOnly: true }).filter((w) => w.prNumber === 42);
    assert.equal(live.length, 1, "adopt must not register a duplicate");
  });
});

describe("FG-731 the block-wait loop — single terminal outcome by re-observation", () => {
  const loopDeps = (probe: CiWaitProbe, over: Partial<Parameters<typeof runCiWaitLoop>[1]> = {}) => ({
    probe,
    owner: OWNER,
    leaseMs: 60000,
    intervalMs: 0,
    timeoutMs: Infinity,
    sleep: async () => {},
    now: () => 0,
    ...over,
  });

  test("running… then completed → exactly one completed_awaiting_advance outcome", async () => {
    const armed = armPr();
    let n = 0;
    const probe: CiWaitProbe = () => (n++ < 2 ? { observation: { state: "running", m: 1, n: 3 } } : { observation: { state: "completed" } });
    const outcome = await runCiWaitLoop(armed, loopDeps(probe));
    assert.equal(outcome.kind, "completed_awaiting_advance");
    assert.equal(getCiWait(armed.id)?.lifecycleState, "completed_awaiting_advance");
    assert.equal(getCiWait(armed.id)?.terminal, false, "completed_awaiting_advance is NON-terminal — an advance is owed");
  });

  test("gh not-found → abandoned terminal (a distinct disposition, not left running)", async () => {
    const armed = armPr();
    const probe: CiWaitProbe = () => ({ observation: { state: "no_runs" }, gone: true });
    const outcome = await runCiWaitLoop(armed, loopDeps(probe));
    assert.equal(outcome.kind, "abandoned");
    const row = getCiWait(armed.id);
    assert.equal(row?.terminal, true);
    assert.equal(row?.terminalDisposition, "abandoned");
  });

  test("a WAITER timeout leaves the record LIVE (terminal comes from gh, not the waiter)", async () => {
    const armed = armPr();
    const probe: CiWaitProbe = () => ({ observation: { state: "running", m: 0, n: 2 } });
    // deadline already passed → one probe, then timeout.
    const outcome = await runCiWaitLoop(armed, loopDeps(probe, { timeoutMs: 0, now: () => 1000 }));
    assert.equal(outcome.kind, "timeout");
    assert.equal(getCiWait(armed.id)?.terminal, false, "a timed-out waiter must NOT terminalize the wait");
  });

  test("an aborted signal → cancelled outcome, record stays live", async () => {
    const armed = armPr();
    const controller = new AbortController();
    controller.abort();
    const probe: CiWaitProbe = () => ({ observation: { state: "running" } });
    const outcome = await runCiWaitLoop(armed, loopDeps(probe, { signal: controller.signal }));
    assert.equal(outcome.kind, "cancelled");
    assert.equal(getCiWait(armed.id)?.terminal, false);
  });
});

describe("FG-731 reconcileCiWaits — re-observation recovery (Step 3)", () => {
  function expireLease(id: string): void {
    // The wait was armed with a 60s lease against the store clock; jump the clock
    // past it so the waiter is presumed dead.
    setPublicationClockOffsetForTest(120000);
    void id;
  }

  test("an expired-lease non-terminal wait is re-observed to completed_awaiting_advance", () => {
    const armed = armPr();
    expireLease(armed.id);
    const probe: CiWaitProbe = () => ({ observation: { state: "completed" } });
    const changes = reconcileCiWaits(probe, storeNowMs);
    assert.equal(getCiWait(armed.id)?.lifecycleState, "completed_awaiting_advance");
    assert.ok(changes.some((c) => c.id === armed.id && c.to === "completed_awaiting_advance"));
  });

  test("an expired lease ALONE does NOT terminalize — a still-running gh keeps it live", () => {
    const armed = armPr();
    expireLease(armed.id);
    const probe: CiWaitProbe = () => ({ observation: { state: "running", m: 1, n: 4 } });
    reconcileCiWaits(probe, storeNowMs);
    const row = getCiWait(armed.id);
    assert.equal(row?.terminal, false, "lease expiry is not terminal authority — the run is still real on GitHub");
    assert.equal(row?.lifecycleState, "running");
    assert.equal(row?.observedState, "running");
  });

  test("recovery abandons a gone remote (gh not-found on re-observation)", () => {
    const armed = armPr();
    expireLease(armed.id);
    const probe: CiWaitProbe = () => ({ observation: { state: "no_runs" }, gone: true });
    reconcileCiWaits(probe, storeNowMs);
    assert.equal(getCiWait(armed.id)?.terminalDisposition, "abandoned");
  });

  test("a wait with a LIVE (unexpired) lease is skipped — its waiter owns the poll", () => {
    const armed = armPr();
    renewCiWaitLease(armed.id, OWNER, 600000); // fresh 10-min lease
    let probed = false;
    const probe: CiWaitProbe = () => {
      probed = true;
      return { observation: { state: "completed" } };
    };
    reconcileCiWaits(probe, storeNowMs);
    assert.equal(probed, false, "a live-lease wait must not be double-probed by recovery");
    assert.equal(getCiWait(armed.id)?.lifecycleState, "registered");
  });

  test("recovery reaps NOTHING — a completed_awaiting_advance row stays on the live surface (FG-590 boundary)", () => {
    const armed = armPr();
    expireLease(armed.id);
    reconcileCiWaits(() => ({ observation: { state: "completed" } }) as CiWaitProbeOutcome, storeNowMs);
    const live = readCiWaits({ liveOnly: true });
    assert.ok(live.some((w) => w.id === armed.id), "completed_awaiting_advance is a legitimate non-terminal state, not a leak");
  });
});
