import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, withRunLock, RunBusyError } from "./run-lock.js";
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
