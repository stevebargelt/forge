import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, renewRunLock, liveRunLockHolder, withRunLock, RunBusyError, acquireFileLockBlocking, releaseFileLock } from "./run-lock.js";
import { runDir } from "./paths.js";

let n = 0;
const freshRunId = () => `run-lock-test-${process.pid}-${n++}`;
const lockFile = (runId: string) => join(runDir(runId), ".dispatch.lock");
const ALIVE = () => true;
const DEAD = () => false;

// ── core mutual exclusion (controlled interleaving of two "commands") ──

test("acquireRunLock: second acquire on a held run throws RunBusyError (no double-dispatch)", () => {
  const runId = freshRunId();
  // command A acquires
  assert.equal(acquireRunLock(runId, "next"), true);
  // command B, racing on the same run while A holds it → blocked
  assert.throws(() => acquireRunLock(runId, "next", { isAlive: ALIVE }), RunBusyError);
  releaseRunLock(runId);
});

test("acquireRunLock: release lets the next command acquire", () => {
  const runId = freshRunId();
  acquireRunLock(runId, "next");
  releaseRunLock(runId);
  assert.equal(existsSync(lockFile(runId)), false, "lock file removed on release");
  assert.equal(acquireRunLock(runId, "gate"), true, "re-acquire succeeds after release");
  releaseRunLock(runId);
});

// ── takeover of crashed / stuck holders (ties into crash recovery) ──

test("acquireRunLock: a DEAD holder's lock is stolen", () => {
  const runId = freshRunId();
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(lockFile(runId), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: Date.now(), acquiredAt: "x" }));
  // holder pid is reported dead → stolen
  assert.equal(acquireRunLock(runId, "next", { isAlive: DEAD }), true);
  releaseRunLock(runId);
});

test("acquireRunLock: a STALE live holder is stolen", () => {
  const runId = freshRunId();
  const t0 = 1_000_000_000_000;
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(lockFile(runId), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: t0, acquiredAt: "x" }));
  // alive but acquired 2h ago with a 1h stale window → stolen
  assert.equal(acquireRunLock(runId, "next", { isAlive: ALIVE, nowMs: t0 + 2 * 3600_000, staleMs: 3600_000 }), true);
  releaseRunLock(runId);
});

test("acquireRunLock: a LIVE, fresh holder is NOT stolen without --steal", () => {
  const runId = freshRunId();
  const t0 = 1_000_000_000_000;
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(lockFile(runId), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: t0, acquiredAt: "x" }));
  assert.throws(
    () => acquireRunLock(runId, "next", { isAlive: ALIVE, nowMs: t0 + 60_000, staleMs: 3600_000 }),
    RunBusyError,
  );
});

test("acquireRunLock: steal:true forces takeover of a live, fresh holder (cancel-style override)", () => {
  const runId = freshRunId();
  const t0 = 1_000_000_000_000;
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(lockFile(runId), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: t0, acquiredAt: "x" }));
  assert.equal(acquireRunLock(runId, "cancel", { isAlive: ALIVE, nowMs: t0 + 60_000, steal: true }), true);
  releaseRunLock(runId);
});

// ── release safety + withRunLock ──

test("releaseRunLock: never removes a lock held by someone else (after a steal)", () => {
  const runId = freshRunId();
  mkdirSync(runDir(runId), { recursive: true });
  // a lock owned by a DIFFERENT pid
  writeFileSync(lockFile(runId), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: Date.now(), acquiredAt: "x" }));
  releaseRunLock(runId); // we don't own it → must NOT delete it
  assert.equal(existsSync(lockFile(runId)), true, "another holder's lock left intact");
});

test("withRunLock: releases the lock on success AND on throw", async () => {
  const runId = freshRunId();
  await withRunLock(runId, "next", () => "ok");
  assert.equal(existsSync(lockFile(runId)), false, "released after success");

  await assert.rejects(withRunLock(runId, "next", () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockFile(runId)), false, "released even when fn throws");
});

// ── FG-584: renewal. The staleness window bounds "held without a sign of life",
// and until it was renewed it bounded "held", full stop — so an ordered fan-out
// wave (a serialized chain of dispatches, integrations and 10-minute gates) could
// legitimately outlive it and be TAKEN OVER while still working. Two waves over one
// candidate worktree.

test("renewRunLock: re-stamps OUR lock so a long-running holder is not stolen as stale", () => {
  const runId = freshRunId();
  const t0 = 1_000_000_000_000;
  acquireRunLock(runId, "next", { nowMs: t0 });

  // Two hours of work later, with a 1h stale window: without a renewal, a second
  // process steals it out from under us.
  const stolen = freshRunId();
  acquireRunLock(stolen, "next", { nowMs: t0 });
  assert.equal(
    acquireRunLock(stolen, "next", { isAlive: ALIVE, nowMs: t0 + 2 * 3600_000, staleMs: 3600_000 }),
    true,
    "precondition: an unrenewed live holder IS stolen at the stale threshold",
  );
  releaseRunLock(stolen);

  // The heartbeat kept re-stamping it through those two hours; the last tick landed
  // five minutes ago, so the same holder is still live at the 2h mark.
  const now = t0 + 2 * 3600_000;
  assert.equal(renewRunLock(runId, now - 5 * 60_000), true);
  assert.throws(
    () => acquireRunLock(runId, "next", { isAlive: ALIVE, nowMs: now, staleMs: 3600_000 }),
    RunBusyError,
    "a renewed holder is NOT stale and is not stolen",
  );
  releaseRunLock(runId);

  // The same stamp is what reconcile's liveness probe reads. An ordered wave's
  // stranded-parent resume is guarded on "no live foreign holder", so an unrenewed
  // stamp does not merely permit a takeover — it actively tells the second process
  // that nobody is driving the run.
  const foreign = freshRunId();
  mkdirSync(runDir(foreign), { recursive: true });
  const write = (atMs: number) =>
    writeFileSync(lockFile(foreign), JSON.stringify({ pid: 999999, command: "next", acquiredAtMs: atMs, acquiredAt: "x" }));
  write(t0);
  assert.equal(
    liveRunLockHolder(foreign, { isAlive: ALIVE, nowMs: now, staleMs: 3600_000 }),
    null,
    "an unrenewed 2h-old holder reads as 'nobody is driving this run' — the resume window",
  );
  write(now - 5 * 60_000);
  assert.ok(
    liveRunLockHolder(foreign, { isAlive: ALIVE, nowMs: now, staleMs: 3600_000 }),
    "…and a renewed one keeps reading as live, so the wave is left alone",
  );
});

test("renewRunLock: never re-stamps a lock we do not hold, and reports so", () => {
  const runId = freshRunId();
  mkdirSync(runDir(runId), { recursive: true });
  const foreign = { pid: 999999, command: "next", acquiredAtMs: 1_000, acquiredAt: "x" };
  writeFileSync(lockFile(runId), JSON.stringify(foreign));
  assert.equal(renewRunLock(runId), false, "not ours → refused");
  assert.deepEqual(JSON.parse(readFileSync(lockFile(runId), "utf8")), foreign, "…and left byte-identical");

  const absent = freshRunId();
  assert.equal(renewRunLock(absent), false, "no lock at all → nothing to renew");
});

test("withRunLock: renews while it holds, so a long fn is never taken over mid-flight", async () => {
  const runId = freshRunId();
  const stamps: number[] = [];
  await withRunLock(
    runId,
    "next",
    async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 12));
        stamps.push((JSON.parse(readFileSync(lockFile(runId), "utf8")) as { acquiredAtMs: number }).acquiredAtMs);
      }
    },
    { renewIntervalMs: 5 },
  );
  assert.ok(stamps.length === 3, "the fn observed the lock three times");
  assert.ok(stamps[2]! > stamps[0]!, `the lock's acquisition stamp advanced while held (${stamps.join(", ")})`);
  assert.equal(existsSync(lockFile(runId)), false, "and the heartbeat is torn down with the lock");
});

// ── acquireFileLockBlocking (FG-376): dead-holder theft only, NO stale-time theft ──

const freshLockPath = () => join(runDir(freshRunId()), ".provision-test.lock");

test("acquireFileLockBlocking: a DEAD holder's lock is stolen immediately", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: Date.now(), acquiredAt: "x" }));
  await acquireFileLockBlocking(path, "provision", { isAlive: DEAD });
  releaseFileLock(path);
});

test("acquireFileLockBlocking: a LIVE holder is waited out, never time-based stolen — no matter how old the lock looks", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const t0 = 1_000_000_000_000;
  writeFileSync(path, JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: t0, acquiredAt: "x" }));

  // A holder alive and "acquired" 10 hours ago — far past the old 1h staleMs
  // threshold. The old behavior would have stolen this; the new behavior must
  // keep blocking (proven by racing against a bounded wait below).
  let acquired = false;
  const attempt = acquireFileLockBlocking(path, "provision", {
    isAlive: ALIVE,
    nowMs: () => t0 + 10 * 3600_000,
    pollMs: 10,
  }).then(() => { acquired = true; });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(acquired, false, "a live holder must never be stolen on a time threshold");

  // Release the original (simulated, foreign-pid) holder's lock directly —
  // releaseFileLock refuses to remove a lock owned by another pid, which is
  // exactly the point of this simulation, so unlink it as the "external"
  // holder would on its own exit.
  unlinkSync(path);
  await attempt;
  assert.equal(acquired, true, "acquire proceeds once the live holder's lock is actually released");
  releaseFileLock(path);
});

// ── acquireFileLockBlocking: onDeadHolder / holderId (FG-376 FIX1) ──────────

test("acquireFileLockBlocking: holderId is recorded in the written LockInfo", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  await acquireFileLockBlocking(path, "provision", { holderId: "forge-provision-abc123" });
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.holderId, "forge-provision-abc123");
  releaseFileLock(path);
});

test("acquireFileLockBlocking: a dead pid with no onDeadHolder supplied still steals immediately (default preserves pre-FIX1 behavior)", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: Date.now(), acquiredAt: "x" }));
  await acquireFileLockBlocking(path, "provision", { isAlive: DEAD });
  releaseFileLock(path);
});

test("acquireFileLockBlocking: onDeadHolder is invoked with the held LockInfo (including holderId) only when the pid is actually dead", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: Date.now(), acquiredAt: "x", holderId: "forge-provision-xyz" }),
  );
  let seen: { pid: number; command: string; acquiredAt: string; holderId?: string } | undefined;
  await acquireFileLockBlocking(path, "provision", {
    isAlive: DEAD,
    onDeadHolder: (held) => {
      seen = held;
      return "steal";
    },
  });
  assert.equal(seen?.pid, 999999);
  assert.equal(seen?.command, "provision");
  assert.equal(seen?.holderId, "forge-provision-xyz");
  releaseFileLock(path);
});

test("acquireFileLockBlocking: onDeadHolder returning 'wait' on a dead pid blocks exactly like a live holder — not stolen until it's actually released", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: Date.now(), acquiredAt: "x", holderId: "forge-provision-orphan" }));

  let onDeadHolderCalls = 0;
  let acquired = false;
  const attempt = acquireFileLockBlocking(path, "provision", {
    isAlive: DEAD,
    pollMs: 10,
    onDeadHolder: () => {
      onDeadHolderCalls++;
      return "wait";
    },
  }).then(() => { acquired = true; });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(acquired, false, "'wait' must keep blocking even though the pid is dead");
  assert.ok(onDeadHolderCalls > 0, "onDeadHolder must have been consulted");

  unlinkSync(path); // simulate the orphan's holder eventually being cleaned up
  await attempt;
  assert.equal(acquired, true);
  releaseFileLock(path);
});

test("acquireFileLockBlocking: a LIVE holder never invokes onDeadHolder at all", async () => {
  const path = freshLockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 999999, command: "provision", acquiredAtMs: Date.now(), acquiredAt: "x" }));

  let onDeadHolderCalls = 0;
  let acquired = false;
  const attempt = acquireFileLockBlocking(path, "provision", {
    isAlive: ALIVE,
    pollMs: 10,
    onDeadHolder: () => { onDeadHolderCalls++; return "steal"; },
  }).then(() => { acquired = true; });

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(acquired, false);
  assert.equal(onDeadHolderCalls, 0, "onDeadHolder is a dead-pid-only hook — a live holder must never reach it");

  unlinkSync(path);
  await attempt;
  assert.equal(acquired, true);
  releaseFileLock(path);
});
