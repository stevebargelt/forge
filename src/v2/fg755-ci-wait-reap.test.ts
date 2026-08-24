// FG-755: the reaper for push_actions CI-waits stranded at `no_runs` by a dead waiter.
//
// The immortal-row bug: a `forge ci-wait --kind push_actions` that observes `no_runs`
// (its head-sha never matches an Actions run — e.g. a squash-merge commit) has no
// terminal transition. When its waiter dies, the row stays lifecycle=running, terminal=0,
// with a stale owner FOREVER, rendering as a live "CI state unavailable" row.
//
// The load-bearing properties proven here (both gates required — neither reaps alone):
//   * dead owner (expired lease) + DURABLE no_runs (persisted past the bound) => reaped
//     to the `abandoned` terminal, row PRESERVED with a durable reason, off the live surface.
//   * dead owner ALONE (fresh no_runs, or a non-no_runs observation) => NEVER reaped.
//   * durable no_runs ALONE (live lease) => NEVER reaped.
//   * a fresh probe that no longer reports no_runs is a fail-safe => NOT reaped.
//   * dry-run lists exact identities and mutates NOTHING.
//
// Real store code against a real in-memory SQLite DB (makeInMemoryDb), a stubbed probe,
// and an injected clock — never ~/.forge/forge.db and never the network.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import {
  getCiWait,
  observeCiWait,
  reapCiWait,
  readCiWaits,
  registerCiWait,
  advanceCiWait,
  type CiWaitKind,
} from "../store/ci-waits.js";
import { reapStuckCiWaits, PUSH_ACTIONS_NO_RUNS_DURABLE_MS, type CiWaitProbeOutcome } from "./ci-wait.js";

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

// A fixed "now" so age/lease comparisons are deterministic and clock-free.
const NOW = 1_800_000_000_000;
const now = () => NOW;
const isoAt = (ms: number): string => new Date(ms).toISOString();

const DURABLE_AGE = PUSH_ACTIONS_NO_RUNS_DURABLE_MS + 60_000; // comfortably past the bound
const TRANSIENT_AGE = Math.floor(PUSH_ACTIONS_NO_RUNS_DURABLE_MS / 2); // well within the bound

const noRunsProbe = (): CiWaitProbeOutcome => ({ observation: { state: "no_runs" } });

/** Register a wait, drive it to a given observed_state, and set its lease/owner directly
 *  (independent of any wall clock). `ageMs` places started_at that far before NOW. */
function seedWait(
  id: string,
  {
    kind = "push_actions" as CiWaitKind,
    observed = "no_runs" as "no_runs" | "running",
    ageMs = DURABLE_AGE,
    leaseExpiresAtMs = NOW - 60_000, // dead by default
    owner = "dead-host:4242",
  }: {
    kind?: CiWaitKind;
    observed?: "no_runs" | "running";
    ageMs?: number;
    leaseExpiresAtMs?: number;
    owner?: string;
  } = {},
): void {
  const startedAt = isoAt(NOW - ageMs);
  const ok = registerCiWait({
    id,
    kind,
    remote: { repo: "acme/forge", headSha: `sha-${id}` },
    startedAt,
    owner,
    association: { projectDir: "/repos/forge" },
  });
  assert.equal(ok, true);
  if (observed === "no_runs") observeCiWait(id, { state: "no_runs" }, startedAt);
  else observeCiWait(id, { state: "running", m: 1, n: 3 }, startedAt);
  db.prepare(`UPDATE ci_waits SET lease_expires_at_ms = ?, owner = ? WHERE id = ?`).run(
    leaseExpiresAtMs,
    owner,
    id,
  );
}

describe("FG-755 reapStuckCiWaits — AC1: dead lease + durable no_runs => reaped", () => {
  test("reaps to the `abandoned` terminal with a durable reason, row PRESERVED and off the live surface", () => {
    seedWait("reap-a1");
    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);

    assert.equal(out.reaped.length, 1);
    assert.equal(out.reaped[0]!.id, "reap-a1");
    assert.match(out.reaped[0]!.reason, /no matching CI run found/);

    const wait = getCiWait("reap-a1");
    assert.ok(wait, "the row is PRESERVED — reap terminalizes, it never deletes");
    assert.equal(wait.lifecycleState, "abandoned");
    assert.equal(wait.terminal, true);
    assert.equal(wait.terminalDisposition, "abandoned");
    assert.match(wait.observedReason ?? "", /waiter dead/);

    assert.ok(
      !readCiWaits({ liveOnly: true }).some((w) => w.id === "reap-a1"),
      "a reaped wait leaves the live in-flight surface (CI_WAIT_LIVE_WHERE excludes it)",
    );
  });
});

describe("FG-755 reapStuckCiWaits — AC2: NEITHER condition alone reaps", () => {
  test("dead lease + only TRANSIENT no_runs => NOT reaped (no_runs must be durable)", () => {
    seedWait("reap-transient", { ageMs: TRANSIENT_AGE });
    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(out.reaped.length, 0);
    assert.equal(getCiWait("reap-transient")!.terminal, false, "a young no_runs wait stays live");
    assert.ok(readCiWaits({ liveOnly: true }).some((w) => w.id === "reap-transient"));
  });

  test("LIVE lease + durable no_runs => NOT reaped (a live waiter is still probing it)", () => {
    seedWait("reap-live", { leaseExpiresAtMs: NOW + 60_000 });
    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(out.reaped.length, 0);
    assert.equal(getCiWait("reap-live")!.terminal, false, "a live-lease wait is never reaped");
  });

  test("dead-owner ALONE does not reap — a dead lease over a non-no_runs observation is left alone", () => {
    seedWait("reap-running", { observed: "running" });
    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(out.reaped.length, 0);
    assert.equal(getCiWait("reap-running")!.lifecycleState, "running");
  });

  test("fail-safe: a fresh probe that no longer reports no_runs is NOT reaped (recovery re-observes it)", () => {
    seedWait("reap-nowrunning");
    const runningProbe = (): CiWaitProbeOutcome => ({ observation: { state: "running", m: 0, n: 2 } });
    const out = reapStuckCiWaits({ dryRun: false }, runningProbe, now);
    assert.equal(out.reaped.length, 0, "a wait whose run actually exists now must not be abandoned");
    assert.equal(getCiWait("reap-nowrunning")!.terminal, false);
  });

  test("FG-755 scope: only push_actions is reaped — pr_checks / workflow_dispatch are untouched", () => {
    seedWait("reap-pr", { kind: "pr_checks" });
    seedWait("reap-dispatch", { kind: "workflow_dispatch" });
    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(out.reaped.length, 0);
    assert.equal(getCiWait("reap-pr")!.terminal, false);
    assert.equal(getCiWait("reap-dispatch")!.terminal, false);
  });

  test("FG-590 boundary: a completed_awaiting_advance wait is NEVER reaped", () => {
    // A completed observation drives completed_awaiting_advance (observed_state=completed),
    // which is a legitimate non-terminal state — not the no_runs shape the reaper targets.
    const startedAt = isoAt(NOW - DURABLE_AGE);
    registerCiWait({ id: "reap-caa", kind: "push_actions", remote: { repo: "acme/forge", headSha: "s" }, startedAt, owner: "dead:1" });
    observeCiWait("reap-caa", { state: "completed" }, startedAt);
    db.prepare(`UPDATE ci_waits SET lease_expires_at_ms = ? WHERE id = ?`).run(NOW - 60_000, "reap-caa");
    assert.equal(getCiWait("reap-caa")!.lifecycleState, "completed_awaiting_advance");

    const out = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(out.reaped.length, 0);
    assert.equal(getCiWait("reap-caa")!.lifecycleState, "completed_awaiting_advance");
  });
});

describe("FG-755 reapStuckCiWaits — AC3: dry-run lists identities and mutates nothing", () => {
  test("the 10-immortal-rows shape: dry-run lists all, mutates NOTHING, then a real run reaps all", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `immortal-${i}`);
    for (const id of ids) seedWait(id);

    const liveBefore = readCiWaits({ liveOnly: true }).length;
    assert.equal(liveBefore, 10);

    const dry = reapStuckCiWaits({ dryRun: true }, noRunsProbe, now);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.reaped.length, 10, "dry-run lists every stuck row");
    assert.deepEqual(dry.reaped.map((w) => w.id).sort(), [...ids].sort());
    for (const c of dry.reaped) {
      assert.equal(c.kind, "push_actions");
      assert.equal(c.observedState, "no_runs");
      assert.ok(c.headSha, "the listing carries the head_sha identity");
      assert.ok(c.ageMs >= PUSH_ACTIONS_NO_RUNS_DURABLE_MS);
    }

    // Nothing mutated: every row is still live, still running, still non-terminal.
    assert.equal(readCiWaits({ liveOnly: true }).length, liveBefore, "dry-run mutates nothing");
    for (const id of ids) assert.equal(getCiWait(id)!.terminal, false);

    const real = reapStuckCiWaits({ dryRun: false }, noRunsProbe, now);
    assert.equal(real.reaped.length, 10);
    assert.equal(readCiWaits({ liveOnly: true }).length, 0, "all immortal rows leave the live surface");
    for (const id of ids) {
      const w = getCiWait(id)!;
      assert.equal(w.terminalDisposition, "abandoned");
      assert.ok(w, "rows are PRESERVED, never deleted");
    }
  });
});

describe("FG-755 reapCiWait — the store transition", () => {
  const precond = { requiredObservedState: "no_runs" as const, nowMs: NOW };

  test("records the abandoned terminal AND the durable reason, preserving the row", () => {
    seedWait("store-reap");
    assert.equal(reapCiWait("store-reap", "durable reason here", precond), true);
    const w = getCiWait("store-reap")!;
    assert.equal(w.lifecycleState, "abandoned");
    assert.equal(w.terminal, true);
    assert.equal(w.terminalDisposition, "abandoned");
    assert.equal(w.observedReason, "durable reason here");
  });

  test("refuses a wait already terminal (first disposition wins) and an unknown id", () => {
    seedWait("store-terminal");
    advanceCiWait("store-terminal", "cancelled");
    assert.equal(reapCiWait("store-terminal", "x", precond), false, "a terminal wait is not re-terminalized");
    assert.equal(getCiWait("store-terminal")!.terminalDisposition, "cancelled");
    assert.equal(reapCiWait("no-such-id", "x", precond), false);
  });

  // RF-1 / RF-2: the reaper decides reapability from a snapshot read BEFORE its external
  // probe, then writes. reapCiWait is the write-time compare-and-set that keeps a wait
  // revived in that TOCTOU window from being wrongly abandoned.
  test("CAS refuses when the lease was renewed after the snapshot (a live waiter revived it)", () => {
    seedWait("store-released");
    // A concurrent waiter renews the lease into the future between the snapshot and the write.
    db.prepare(`UPDATE ci_waits SET lease_expires_at_ms = ? WHERE id = ?`).run(NOW + 60_000, "store-released");
    assert.equal(reapCiWait("store-released", "x", precond), false, "a re-leased (live) wait is not reaped");
    assert.equal(getCiWait("store-released")!.terminal, false);
    assert.equal(getCiWait("store-released")!.lifecycleState, "running");
  });

  test("CAS refuses when a run was observed after the snapshot (observed_state no longer no_runs)", () => {
    seedWait("store-nowrunning");
    observeCiWait("store-nowrunning", { state: "running", m: 1, n: 3 }, isoAt(NOW));
    assert.equal(reapCiWait("store-nowrunning", "x", precond), false, "a wait with a fresh run is not reaped");
    assert.equal(getCiWait("store-nowrunning")!.terminal, false);
    assert.equal(getCiWait("store-nowrunning")!.observedState, "running");
  });
});

describe("FG-755 reapStuckCiWaits — TOCTOU: a wait revived during the probe is not reaped", () => {
  // The reaper snapshots the live surface, then probes each wait OUTSIDE the store
  // transition. A probe that revives the wait as a side effect stands in for a concurrent
  // waiter renewing the lease / recording a run in exactly that window (RF-1 supported,
  // RF-2 demonstrated). The write-time CAS in reapCiWait must leave such a wait live.
  test("a lease renewed during the probe leaves the wait live (never reaped)", () => {
    seedWait("race-lease");
    const revivingProbe = (): CiWaitProbeOutcome => {
      // storeNowMs()-relative renewal; the reaper's `now` (NOW) is far enough ahead that a
      // real renewal would still land beyond it, so drive it directly to a future lease.
      db.prepare(`UPDATE ci_waits SET lease_expires_at_ms = ? WHERE id = ?`).run(NOW + 300_000, "race-lease");
      return { observation: { state: "no_runs" } };
    };
    const out = reapStuckCiWaits({ dryRun: false }, revivingProbe, now);
    assert.equal(out.reaped.length, 0, "a wait revived by a lease renewal in the probe window is not reaped");
    assert.equal(getCiWait("race-lease")!.terminal, false);
  });

  test("a run observed during the probe leaves the wait live (never reaped)", () => {
    seedWait("race-observe");
    const revivingProbe = (): CiWaitProbeOutcome => {
      observeCiWait("race-observe", { state: "running", m: 0, n: 2 }, isoAt(NOW));
      return { observation: { state: "no_runs" } };
    };
    const out = reapStuckCiWaits({ dryRun: false }, revivingProbe, now);
    assert.equal(out.reaped.length, 0, "a wait that recorded a running run in the probe window is not reaped");
    assert.equal(getCiWait("race-observe")!.terminal, false);
    assert.equal(getCiWait("race-observe")!.observedState, "running");
  });
});
