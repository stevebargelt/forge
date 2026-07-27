// FG-566: the durable record of a HOST-side verification readiness assertion.
//
// ONE RECORD PER WORKSPACE, holding the full evidence the assertion was made
// under. Reuse is then a FIELD COMPARISON against that record rather than a
// filename lookup, which is what makes invalidation total: a changed lockfile, a
// changed tree, or a different interpreter/ABI simply fails the comparison, and
// a workspace that was never prepared has no record at all. A moved-base rebuild
// gets a FRESH publicationWorktreeDir path (paths.ts), so it addresses a
// different record and structurally cannot inherit r0's assertion.
//
// KEYSPACE BOUNDARY (non-negotiable, see hostReadinessDir's comment): this module
// reads and writes ~/.forge/host-readiness/ ONLY. It never reads or writes
// ~/.forge/dependency-cache/<lockfileHash>.ready, nor any other FG-376 marker,
// volume or lock. It reuses FG-376's temp-then-rename atomic-marker DISCIPLINE by
// reading it, not its keyspace.
//
// The lock is narrow in the same sense FG-376's is: it covers ONE setup command,
// never a verification run and never an agent's lifetime. Its crash-safety comes
// from host-process liveness (the recorded pid) PLUS a bounded timeout backstop —
// the setup itself is a host process, not a container that can outlive us, so a
// dead pid IS proof the install stopped; the timeout backstop only exists for the
// pathological case of a pid that was recycled onto an unrelated live process.

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { hostReadinessDir } from "../util/paths.js";

/** The fields a readiness assertion is BOUND to. Every one of them is a
 *  correctness key, not a cache optimization:
 *   - workspace   the exact directory the verification will run in;
 *   - treeSha     the candidate identity readiness was asserted for (FG-566:
 *                 "readiness is never inherited by a different candidate");
 *   - lockfileDigest / nodeVersion / abi  the install inputs — a native binding
 *                 built under one ABI loads under that ABI only.
 *  The VERIFICATION COMMAND SET is deliberately absent: it is evidence of what
 *  the assertion covered, never a reuse or invalidation key. */
export type HostReadinessBinding = {
  workspace: string;
  treeSha: string;
  lockfileDigest: string;
  nodeVersion: string;
  abi: string;
};

export type HostReadinessRecord = HostReadinessBinding & {
  /** `preparing` is written BEFORE the setup runs and is what makes a FAILED or
   *  CRASHED preparation distinguishable from a workspace forge never touched.
   *  Without it, a half-installed tree left by a failed `npm ci` would read as
   *  "already provisioned, not forge's to touch" on the next attempt — and the
   *  verification would run against it and blame the code, which is precisely the
   *  defect this module exists to remove. Only `ready` ever satisfies a reuse. */
  state: "preparing" | "ready";
  setupCommand: string;
  coveredCommandSet: string[];
  assertedAt: string;
};

/** The setup ceiling. One `npm ci` on a cold cache, generously bounded — the
 *  same order as FG-376's provisioner idle timeout, kept as its OWN constant
 *  because this one bounds a HOST process, not a docker exec. */
export function hostReadinessSetupTimeoutMs(): number {
  const raw = Number(process.env["FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

/** The lock's bounded backstop, and the bound on how long a second caller waits
 *  for a live holder before reporting `setup_contended`. Both derive from the
 *  setup ceiling so raising the ceiling can never silently make the lock the
 *  thing that fails first. */
export function hostReadinessLockTimeoutMs(): number {
  return hostReadinessSetupTimeoutMs() + 60_000;
}

function recordSlug(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 32);
}

export function readinessRecordPath(workspace: string): string {
  return join(hostReadinessDir(), `${recordSlug(workspace)}.json`);
}

function readinessLockPath(workspace: string): string {
  return join(hostReadinessDir(), `${recordSlug(workspace)}.lock`);
}

export function readReadinessRecord(workspace: string): HostReadinessRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(readinessRecordPath(workspace), "utf8")) as Partial<HostReadinessRecord>;
    if (
      typeof parsed.workspace !== "string" || typeof parsed.treeSha !== "string" ||
      typeof parsed.lockfileDigest !== "string" || typeof parsed.nodeVersion !== "string" ||
      typeof parsed.abi !== "string" || typeof parsed.setupCommand !== "string"
    ) {
      return null;
    }
    return {
      workspace: parsed.workspace,
      treeSha: parsed.treeSha,
      lockfileDigest: parsed.lockfileDigest,
      nodeVersion: parsed.nodeVersion,
      abi: parsed.abi,
      // Fail CLOSED on an unrecognized state: anything that is not an explicit
      // `ready` is treated as an unfinished preparation and re-prepared.
      state: parsed.state === "ready" ? "ready" : "preparing",
      setupCommand: parsed.setupCommand,
      coveredCommandSet: Array.isArray(parsed.coveredCommandSet) ? parsed.coveredCommandSet.filter((c): c is string => typeof c === "string") : [],
      assertedAt: typeof parsed.assertedAt === "string" ? parsed.assertedAt : "",
    };
  } catch {
    return null; // absent, unreadable or torn — "not asserted", which callers already handle
  }
}

/** FG-376's FIX3 discipline, read and reapplied: temp-then-rename, because
 *  rename(2) is atomic. A crash mid-write can never leave a partial record for
 *  readReadinessRecord to misparse as an assertion; worst case the crash lands
 *  before the rename and the workspace simply reads as never-prepared. */
export function writeReadinessRecord(record: HostReadinessRecord): void {
  mkdirSync(hostReadinessDir(), { recursive: true });
  const path = readinessRecordPath(record.workspace);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
}

export function clearReadinessRecord(workspace: string): void {
  try {
    unlinkSync(readinessRecordPath(workspace));
  } catch {
    // never asserted, or already cleared
  }
}

/** True when `record` is a COMPLETED assertion under exactly this binding.
 *  Equality on every field — never a "close enough" or a subset match. */
export function readinessMatches(record: HostReadinessRecord | null, binding: HostReadinessBinding): boolean {
  if (!record || record.state !== "ready") return false;
  return (
    record.workspace === binding.workspace &&
    record.treeSha === binding.treeSha &&
    record.lockfileDigest === binding.lockfileDigest &&
    record.nodeVersion === binding.nodeVersion &&
    record.abi === binding.abi
  );
}

type LockInfo = { pid: number; acquiredAtMs: number; workspace: string };

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → gone. EPERM → exists but not ours, i.e. alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ReadinessLockDeps = {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Bound on how long we wait for a live holder. Defaults to
   *  hostReadinessLockTimeoutMs(); tests shorten it so `setup_contended` is
   *  observable without waiting out a real install ceiling. */
  waitMs?: number;
  pollMs?: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Take the workspace's readiness lock, run `fn`, release. Returns "contended"
 *  WITHOUT running `fn` when a live holder outlasted the bounded wait — the
 *  caller turns that into a `setup_contended` refusal rather than running a
 *  second concurrent setup into the same tree. */
export async function withReadinessLock<T>(
  workspace: string,
  fn: () => Promise<T>,
  deps: ReadinessLockDeps = {},
): Promise<T | "contended"> {
  const alive = deps.isAlive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = deps.waitMs ?? hostReadinessLockTimeoutMs();
  const pollMs = deps.pollMs ?? 250;
  const path = readinessLockPath(workspace);
  mkdirSync(hostReadinessDir(), { recursive: true });

  const startedAt = now();
  for (;;) {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic create-if-absent
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAtMs: now(), workspace } satisfies LockInfo));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let held: LockInfo | null = null;
      try {
        held = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
      } catch {
        held = null;
      }
      const dead = !held || !alive(held.pid);
      const backstopped = held ? now() - held.acquiredAtMs > hostReadinessLockTimeoutMs() : true;
      if (dead || backstopped) {
        try { unlinkSync(path); } catch { /* raced — retry */ }
        continue;
      }
      if (now() - startedAt >= waitMs) return "contended";
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    // Release ONLY if we still hold it — never unlink a holder that took it from us.
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
      if (held.pid === process.pid) unlinkSync(path);
    } catch {
      // already gone, or stolen and rewritten by someone else
    }
  }
}

/** True when the workspace carries an INSTALLED dependency tree. The record alone
 *  is not enough — a record whose node_modules was deleted underneath it would
 *  otherwise read as ready.
 *
 *  NON-EMPTY, not merely present: FG-627 pre-creates EMPTY `<member>/node_modules`
 *  mountpoint directories in every isolated workspace (so the container
 *  provisioner can bind into a read-only project mount). An existence check alone
 *  would read one of those as "already provisioned" and skip the install — the
 *  exact defect FG-566 exists to remove, reintroduced through the adjacent
 *  ticket's mechanics. */
export function workspaceHasNodeModules(workspace: string): boolean {
  const dir = join(workspace, "node_modules");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false; // unreadable — treat as absent rather than assume it is installed
  }
}
