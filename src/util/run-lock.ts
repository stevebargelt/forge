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

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, fstatSync, statSync, ftruncateSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runDir } from "./paths.js";

export type LockInfo = {
  pid: number;
  command: string;
  acquiredAtMs: number;
  acquiredAt: string;
  // FG-584 RF-2: identifies THIS ACQUISITION, not the process. A pid says who is
  // running, never which claim on the lock is current — a holder that went stale
  // and had its lock legitimately stolen is still the same pid, so pid alone
  // cannot tell a renewal that its claim was superseded. Written by
  // acquireRunLock; only ever compared, never interpreted.
  token?: string;
  // Opaque holder identifier the CALLER defines (e.g. a docker container
  // name) — run-lock.ts never interprets it, only records/returns it so a
  // caller-supplied onDeadHolder callback (see acquireFileLockBlocking) can
  // decide whether a dead-pid holder is actually safe to steal from
  // (FG-376 FIX1).
  holderId?: string;
};

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

/** FG-584 RF-2: OUR live claim on a run's lock — the descriptor the O_EXCL create
 *  returned, the inode it names, and the acquisition token stamped into it.
 *
 *  Renewal writes THROUGH THIS DESCRIPTOR, never through the pathname. A thief
 *  unlinks the path and atomically creates a NEW file, so a renewal that lost the
 *  race lands on an inode no other process can reach instead of overwriting the new
 *  holder's record — the write cannot clobber even if the whole check-then-write
 *  interleaves with a takeover. The token then decides the ANSWER: a lock whose
 *  record is not this acquisition's is refused rather than renewed. */
type Claim = { fd: number; ino: number; token: string };
const claims = new Map<string, Claim>();

function dropClaim(runId: string): void {
  const claim = claims.get(runId);
  if (!claim) return;
  claims.delete(runId);
  try { closeSync(claim.fd); } catch { /* already closed */ }
}

/** The lock at `path` is this acquisition's, and the file we hold open IS the file
 *  at that path. Both halves matter: the inode check catches a steal that already
 *  re-created the lock, the token check catches one that re-created it under a pid
 *  indistinguishable from ours. */
function stillOurs(path: string, claim: Claim): boolean {
  try {
    if (statSync(path).ino !== claim.ino) return false;
  } catch {
    return false; // no lock at the path at all — whatever we held is gone
  }
  const held = readLock(path);
  return held !== null && held.token === claim.token;
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
  const token = randomUUID();
  const info: LockInfo = { pid: process.pid, command, acquiredAtMs: nowMs, acquiredAt: new Date(nowMs).toISOString(), token };
  const body = JSON.stringify(info);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic create-if-absent
      writeSync(fd, body);
      // Held open for the lifetime of the claim, so renewal can write to the inode
      // rather than the pathname. releaseRunLock closes it.
      dropClaim(runId);
      claims.set(runId, { fd, ino: fstatSync(fd).ino, token });
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

/** FG-531: read-only liveness probe — the current lock holder iff it is a LIVE
 *  foreign process (pid alive, not stale, not us). Never creates, steals, or
 *  mutates the lock. reconcile's awaiting_red sweep uses this to distinguish "a
 *  forge process is actively driving this run" (skip — the state is presumptively
 *  in-flight) from "nobody is driving it" (the crash-orphan shape it recovers).
 *  Our own pid is NOT a live holder: `forge next` runs reconcile under its own
 *  lock, and that is precisely the recovery pass that must be allowed to sweep. */
export function liveRunLockHolder(
  runId: string,
  opts?: { staleMs?: number; nowMs?: number; isAlive?: (pid: number) => boolean },
): LockInfo | null {
  const held = readLock(lockPath(runId));
  if (!held) return null;
  if (held.pid === process.pid) return null;
  const alive = opts?.isAlive ?? pidAlive;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  if (!alive(held.pid)) return null;
  if (nowMs - held.acquiredAtMs > staleMs) return null;
  return held;
}

/** FG-584: re-stamp OUR lock's acquisition time, if we still hold it.
 *
 *  DEFAULT_STALE_MS is a bound on "held without a sign of life", not on how long a
 *  legitimate operation may take, and without renewal it was the latter. An ordered
 *  fan-out wave is a serialized chain of container dispatches, integrations and
 *  10-minute gates — far longer than the flat wave this lock was sized for — and at
 *  the hour mark a second `forge next` would steal the lock from a live, working
 *  holder while `liveRunLockHolder` simultaneously started answering "nobody is
 *  driving this run", which is what lets reconcile hand the same wave to the second
 *  process. Two ordered waves over one candidate worktree.
 *
 *  Renewal makes the staleness window mean what its comment always claimed: a
 *  holder that has stopped making progress. A crashed holder renews nothing and
 *  goes stale on the same schedule as before (and a dead pid is stolen immediately,
 *  as before).
 *
 *  RF-2: a COMPARE-AND-SET against this acquisition's claim, not a check-then-write
 *  against the pid. Verifying pid and then writing by pathname is not atomic: a
 *  holder that goes stale (suspended process, host sleep) can have its lock
 *  legitimately stolen between the two, and the write then replaces the thief's
 *  record while both processes believe they hold the run — two ordered waves over
 *  one candidate worktree, which is the exact failure renewal exists to prevent.
 *  Writing through the acquisition's own descriptor makes the write unable to
 *  clobber a successor at all, and the token makes a superseded renewal FAIL rather
 *  than silently succeed. */
export function renewRunLock(runId: string, nowMs: number = Date.now()): boolean {
  const claim = claims.get(runId);
  if (!claim) return false; // we never acquired it in this process
  const path = lockPath(runId);
  if (!stillOurs(path, claim)) return false;
  const held = readLock(path);
  if (!held) return false;
  try {
    ftruncateSync(claim.fd, 0);
    writeSync(claim.fd, JSON.stringify({ ...held, acquiredAtMs: nowMs, acquiredAt: new Date(nowMs).toISOString() }), 0);
    return true;
  } catch {
    return false;
  }
}

/** Release the lock if (and only if) WE still hold it — never unlink a holder
 *  that stole it from us. Keyed on the ACQUISITION when we have one (same reason
 *  renewal is), falling back to the pid for a lock this process did not create. */
export function releaseRunLock(runId: string): void {
  const path = lockPath(runId);
  const claim = claims.get(runId);
  const held = readLock(path);
  const ours = held !== null && (claim ? stillOurs(path, claim) : held.pid === process.pid);
  if (ours) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
  dropClaim(runId);
}

/** How often a held lock re-stamps itself. Comfortably inside DEFAULT_STALE_MS even
 *  across the integration gate's 10-minute synchronous ceiling, during which no
 *  timer can fire at all. */
const RENEW_INTERVAL_MS = 5 * 60 * 1000;

/** Run fn while holding the run lock; renew it for as long as we hold it; always
 *  release. */
export async function withRunLock<T>(
  runId: string,
  command: string,
  fn: () => Promise<T> | T,
  opts?: { staleMs?: number; steal?: boolean; renewIntervalMs?: number },
): Promise<T> {
  acquireRunLock(runId, command, opts);
  // unref'd: the heartbeat must never be the reason the process stays alive.
  const heartbeat = setInterval(() => renewRunLock(runId), opts?.renewIntervalMs ?? RENEW_INTERVAL_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseRunLock(runId);
  }
}

// ── Generic blocking file lock (FG-376) ──────────────────────────────────────
// dependency-provisioning.ts uses this to serialize concurrent dependency-cache
// PROVISIONING per lockfile-hash cache key — held only for the lifetime of a
// short-lived install container, never for an agent's full run. Same O_EXCL
// create-if-absent idiom as acquireRunLock above, parameterized by an
// arbitrary lock file path instead of a runId-derived one, and BLOCKING
// (polls) instead of throwing when a live holder is found — a second
// dispatcher for the same cache key should wait out the install rather than
// fail on it.
//
// Unlike acquireRunLock, this does NOT steal a live holder's lock on a time
// threshold. A prior version did (staleMs), and that was unsafe: a slow
// install (large repo, cold network) could outlive the threshold while still
// legitimately in progress, and a second dispatcher would then "steal" the
// lock and run a concurrent `npm ci` into the SAME rw-mounted shared volume —
// exactly the corruption this lock exists to prevent. Only a DEAD holder
// (pid gone — the process that held the lock crashed) is stolen; a live
// holder is always waited out, however long the install takes. Crash-safety
// instead comes from the provisioner container's bounded lifetime (a sane
// install timeout on the docker exec itself) — if the provisioner never
// finishes, its own timeout kills it and the holding process releases the
// lock in its own `finally`, rather than a second process racing to steal it.
//
// FG-376 FIX1: a dead PID alone isn't proof the held work actually stopped —
// the recorded pid is the host orchestrator, but for dependency-cache
// provisioning the real work runs in a separate docker container that can
// outlive an orchestrator crash. `onDeadHolder` gives the caller first
// refusal on a dead-pid holder before it's stolen, so a still-alive
// provisioner container is never raced by a second one. Left generic here —
// this module has no docker knowledge; see dependency-provisioning.ts for the
// container-liveness onDeadHolder implementation.

/** Block until `path` is exclusively ours. A LIVE holder is always waited out
 *  (never time-based stolen — see above). A DEAD holder (pid gone) is stolen
 *  by default — unless `onDeadHolder` is supplied, in which case it decides:
 *  "steal" proceeds (optionally after the callback cleans up whatever the
 *  dead pid left behind), "wait" keeps blocking exactly as if the holder were
 *  still live. Caller's responsibility to mkdir the parent directory first
 *  and to call releaseFileLock(path) when done — always, even on error. */
export async function acquireFileLockBlocking(
  path: string,
  command: string,
  opts?: {
    pollMs?: number;
    nowMs?: () => number;
    isAlive?: (pid: number) => boolean;
    holderId?: string;
    onDeadHolder?: (held: LockInfo) => "steal" | "wait";
  },
): Promise<void> {
  const pollMs = opts?.pollMs ?? 500;
  const alive = opts?.isAlive ?? pidAlive;
  const now = opts?.nowMs ?? (() => Date.now());
  // Default is an immediate steal — correct only when a dead pid IS the whole
  // holder (nothing else outlives it). Any resource class where the real work
  // can outlive the host pid (e.g. FG-376's dependency-cache lock, whose
  // holder is a docker container) MUST pass a liveness-aware onDeadHolder —
  // see acquireDependencyCacheLock in dependency-provisioning.ts.
  const onDeadHolder = opts?.onDeadHolder ?? (() => "steal" as const);

  for (;;) {
    const nowMs = now();
    const info: LockInfo = {
      pid: process.pid,
      command,
      acquiredAtMs: nowMs,
      acquiredAt: new Date(nowMs).toISOString(),
      ...(opts?.holderId !== undefined ? { holderId: opts.holderId } : {}),
    };
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readLock(path);
      if (!held) {
        // Garbled/unreadable lock file — nothing to hand onDeadHolder, so
        // there's no meaningful "wait" to do. Steal, as before this fix.
        try { unlinkSync(path); } catch { /* raced — loop and retry */ }
        continue;
      }
      if (!alive(held.pid) && onDeadHolder(held) === "steal") {
        try { unlinkSync(path); } catch { /* raced — loop and retry */ }
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/** Release `path` if (and only if) we still hold it — mirrors releaseRunLock. */
export function releaseFileLock(path: string): void {
  const held = readLock(path);
  if (held && held.pid === process.pid) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}
