import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, withRunLock, RunBusyError, acquireFileLockBlocking, releaseFileLock } from "./run-lock.js";
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
