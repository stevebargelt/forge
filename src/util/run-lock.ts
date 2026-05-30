// AWN-2: per-run advisory lock to serialize MUTATING lifecycle commands on a
// single run (forge next / gate / retry). Cross-process: two `forge next`
// invocations on the same run must not both dispatch it.
//
// File-based (atomic O_EXCL create of <runDir>/.dispatch.lock) rather than a DB
// lock: it needs no schema migration (machine-wide blast radius), and a file
// lock can be held across `forge next`'s multi-minute agent spawn without
// holding a SQLite write lock the whole time. A holder that died (pid gone) or
// is implausibly old has its lock stolen — so a crashed forge process never
// wedges a run, dovetailing with the AWN-1 crash-recovery model.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./paths.js";

export type LockInfo = { pid: number; command: string; acquiredAtMs: number; acquiredAt: string };

export class RunBusyError extends Error {
  constructor(public runId: string, public holder: LockInfo) {
    super(`run ${runId} is busy — held by '${holder.command}' (pid ${holder.pid}) since ${holder.acquiredAt}`);
    this.name = "RunBusyError";
  }
}

// A LIVE holder this old is presumed stuck and stealable. `forge next` holds the
// lock across a multi-minute agent spawn, so this is generous. Dead holders
// (pid gone) are stolen immediately regardless of age.
const DEFAULT_STALE_MS = 60 * 60 * 1000; // 1h

function lockPath(runId: string): string {
  return join(runDir(runId), ".dispatch.lock");
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/** Acquire the run's lock. Returns true on success. Throws RunBusyError if a
 *  live, non-stale holder owns it (unless opts.steal forces a takeover). Dead or
 *  stale holders are stolen. Injectable clock/liveness for tests. */
export function acquireRunLock(
  runId: string,
  command: string,
  opts?: { staleMs?: number; steal?: boolean; nowMs?: number; isAlive?: (pid: number) => boolean },
): boolean {
  const path = lockPath(runId);
  mkdirSync(runDir(runId), { recursive: true });
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  const alive = opts?.isAlive ?? pidAlive;
  const info: LockInfo = { pid: process.pid, command, acquiredAtMs: nowMs, acquiredAt: new Date(nowMs).toISOString() };
  const body = JSON.stringify(info);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic create-if-absent
      writeSync(fd, body);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readLock(path);
      const dead = !held || !alive(held.pid);
      const stale = held ? nowMs - held.acquiredAtMs > staleMs : true;
      if (opts?.steal || dead || stale) {
        try { unlinkSync(path); } catch { /* raced — loop and retry */ }
        continue;
      }
      throw new RunBusyError(runId, held!); // live, non-stale holder
    }
  }
  // A racer beat us to the re-create after we stole; report whoever holds it.
  const held = readLock(path);
  if (held) throw new RunBusyError(runId, held);
  return false;
}

/** Release the lock if (and only if) WE still hold it — never unlink a holder
 *  that stole it from us. */
export function releaseRunLock(runId: string): void {
  const held = readLock(lockPath(runId));
  if (held && held.pid === process.pid) {
    try { unlinkSync(lockPath(runId)); } catch { /* already gone */ }
  }
}

/** Run fn while holding the run lock; always release. */
export async function withRunLock<T>(
  runId: string,
  command: string,
  fn: () => Promise<T> | T,
  opts?: { staleMs?: number; steal?: boolean },
): Promise<T> {
  acquireRunLock(runId, command, opts);
  try {
    return await fn();
  } finally {
    releaseRunLock(runId);
  }
}
