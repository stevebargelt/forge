// FG-425: per-projectDir mutual exclusion for the merge → integration gate →
// finalize window.
//
// FG-357's integration gate runs the project's full test suite on the HOST
// against the shared run.projectDir checkout, after the worktree merge has
// landed on HEAD. Run locking is per-runId, so two runs targeting the same
// projectDir could interleave merges/gates/cleanup against a moving HEAD for
// the full duration of a test-suite run. This module closes that window:
// every merge→gate→finalize critical section in runNext.ts (all four call
// sites — single-step, fanout post-reds, fanout no-reds, fanout re-entry)
// routes through withProjectIntegrationLock, keyed by the CANONICALIZED
// project directory.
//
// Design (architecture pass, notes/fg425-architecture-spec-2026-07-06.json):
// - Third caller of util/run-lock.ts's generic acquireFileLockBlocking — the
//   same cross-process file-lock primitive the dependency-cache provisioning
//   lock uses. A LIVE holder is always waited out (a legitimately slow
//   10-minute gate must never be time-stolen); only a DEAD holder (pid gone)
//   is stolen. Pid-death alone is NOT sufficient evidence that the held WORK
//   stopped: the integration gate's npm child runs in its own process group
//   and can outlive a crashed forge pid — so the gate group is durably
//   recorded in a sidecar next to the lock, and every acquirer reaps and
//   CONFIRMS a residual group before entering (see the gate-ownership
//   section below).
// - Keyed on realpath-canonicalized projectDir so two runs pointed at one
//   repo through different spellings (symlink, trailing slash, relative)
//   still exclude each other. Independent projects hash to independent lock
//   files and proceed fully in parallel.
// - Nests strictly INSIDE the per-runId dispatch lock (acquired by `forge
//   next`), acquired at most once per run per wave, never re-entrant.
// - Deterministic release: try/finally around the critical section — gate
//   pass, gate fail, thrown merge/cleanup errors all release; a crashed
//   holder is released by the next contender's dead-pid steal.

import { mkdirSync, realpathSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { FORGE_HOME } from "../util/paths.js";
import { acquireFileLockBlocking, releaseFileLock, type LockInfo } from "../util/run-lock.js";

const LOCKS_DIR = join(FORGE_HOME, "locks");

// Print a waiting line immediately on first block, then every ~10s — enough
// for an operator watching `forge next` to know it is queued, not hung.
const WAIT_REPORT_MS = 10_000;

export type ProjectLockKey = { lockFilePath: string; canonicalDir: string };

/** Canonicalize a projectDir and derive its lock-file path. realpath resolves
 *  symlinks and trailing-slash/relative spellings to one physical identity;
 *  when the path can't be resolved (deleted mid-run), fall back to
 *  path.resolve so the lock still keys deterministically. */
export function projectIntegrationLockKey(projectDir: string): ProjectLockKey {
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(projectDir);
  } catch {
    canonicalDir = resolve(projectDir);
  }
  const hash = createHash("sha256").update(canonicalDir).digest("hex").slice(0, 16);
  return { lockFilePath: join(LOCKS_DIR, `project-integration-${hash}.lock`), canonicalDir };
}

// ── Gate process-group ownership (FG-425 crash/timeout AC) ──────────────────
// The integration gate's npm child is spawned as its own PROCESS GROUP and
// durably associated with the project lock via a sidecar file next to it:
// `<lock>.gate` = { pgid, runId, recordedAt }. The sidecar exists exactly
// while a gate group MAY be alive, and it must exist BEFORE the group can:
// the gate writes a `pgid: null` PENDING marker before spawning, upgrades it
// to the real pgid once spawn returns, and removes it only once the group is
// CONFIRMED gone (natural exit with no survivors, or a confirmed group kill).
// Recording only after spawn would leave a SIGKILL-sized hole — a live gate
// group with no sidecar, which the next acquirer would merge straight over.
// A forge crash mid-gate therefore always leaves a sidecar behind, and the
// next acquirer of this project's lock reaps the recorded group — confirming
// termination before entering the window — instead of merging under an
// orphaned test runner. An unconfirmable group (still alive after bounded
// TERM→KILL, or unsignalable) fails CLOSED: the acquirer releases the lock and
// throws an actionable operator-visible error naming the pgid, never entering
// silently and never waiting forever. A sidecar with NO usable pgid (the
// pending marker, or a torn/corrupt file) is the same fail-closed path with an
// unknown group: forge cannot reap what it cannot name, so it refuses the
// window and hands the operator the manual check.

export type GateGroupRecord = {
  pgid: number;
  runId?: string;
  recordedAt: string;
  /** Leader-identity token (its `ps lstart` start time), captured at record
   *  time. POSIX reserves a pid while it is the pgid of a live group, so a
   *  MISMATCHED token later proves the original group is entirely dead and
   *  the id was reused — the reaper must not signal the impostor. */
  leaderStartedAt?: string;
};
/** Pre-spawn marker: a gate group may already exist for this project, but its
 *  pgid is not knowable yet (spawn hasn't returned). */
export type GatePendingRecord = { pgid: null; runId?: string; recordedAt: string };
export type GateSidecarRecord = GateGroupRecord | GatePendingRecord;

export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

function gateSidecarPath(lockFilePath: string): string {
  return `${lockFilePath}.gate`;
}

/** The leader's kernel-recorded start time via `ps -p <pid> -o lstart=` —
 *  a non-reusable identity for (pid, start-time). undefined when the process
 *  is unreadable (already gone, or ps failed). Injectable in the reap opts. */
export function leaderStartTimeOf(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000 }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function writeGateSidecar(projectDir: string, pgid: number | null, runId?: string): void {
  const { lockFilePath } = projectIntegrationLockKey(projectDir);
  mkdirSync(LOCKS_DIR, { recursive: true });
  const leaderStartedAt = pgid !== null ? leaderStartTimeOf(pgid) : undefined;
  const rec: GateSidecarRecord = {
    pgid,
    ...(runId !== undefined ? { runId } : {}),
    recordedAt: new Date().toISOString(),
    ...(leaderStartedAt !== undefined ? { leaderStartedAt } : {}),
  } as GateSidecarRecord;
  const path = gateSidecarPath(lockFilePath);
  // rename, so a crash mid-write can never leave a half-written record that a
  // reaper has to guess about.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, path);
}

/** Claim gate ownership BEFORE the process group exists. Must be called before
 *  spawning the gate child — see the fail-closed rationale above. */
export function recordGateSpawnPending(projectDir: string, runId?: string): void {
  writeGateSidecar(projectDir, null, runId);
}

export function recordGateProcessGroup(projectDir: string, pgid: number, runId?: string): void {
  writeGateSidecar(projectDir, pgid, runId);
}

export function clearGateProcessGroup(projectDir: string): void {
  const { lockFilePath } = projectIntegrationLockKey(projectDir);
  try { unlinkSync(gateSidecarPath(lockFilePath)); } catch { /* already gone */ }
}

export function readGateProcessGroup(projectDir: string): GateSidecarRecord | undefined {
  const { lockFilePath } = projectIntegrationLockKey(projectDir);
  return readGateSidecar(gateSidecarPath(lockFilePath));
}

/** `undefined` = no sidecar at all. A sidecar that exists but doesn't parse
 *  into a usable pgid reads as `{ pgid: null }` — an unknown group, not an
 *  absent one. */
function readGateSidecar(path: string): GateSidecarRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const rec = JSON.parse(raw) as GateSidecarRecord;
    if (typeof rec?.pgid === "number") return rec;
    return { pgid: null, ...(typeof rec?.runId === "string" ? { runId: rec.runId } : {}), recordedAt: rec?.recordedAt ?? "" };
  } catch {
    return { pgid: null, recordedAt: "" };
  }
}

/** kill(-pgid, 0) probe: "alive" (signalable), "gone" (ESRCH), or
 *  "unsignalable" (EPERM — exists but not ours; treated as unconfirmable). */
function probeGroup(pgid: number, killFn: KillFn): "alive" | "gone" | "unsignalable" {
  try {
    killFn(-pgid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unsignalable";
  }
}

/** Terminate a gate process group and CONFIRM it is gone: SIGTERM, a grace
 *  window, SIGKILL, then bounded confirmation polling. Never throws — returns
 *  "confirmed" or "unconfirmable". Injectable kill/poll for tests. */
export async function terminateProcessGroup(
  pgid: number,
  opts?: { killFn?: KillFn; pollMs?: number; graceMs?: number; confirmTimeoutMs?: number },
): Promise<"confirmed" | "unconfirmable"> {
  const killFn: KillFn = opts?.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const pollMs = opts?.pollMs ?? 100;
  const graceMs = opts?.graceMs ?? 2_000;
  const confirmTimeoutMs = opts?.confirmTimeoutMs ?? 8_000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const deadlineOf = (ms: number) => Date.now() + ms;

  if (probeGroup(pgid, killFn) === "gone") return "confirmed";

  try { killFn(-pgid, "SIGTERM"); } catch { /* raced to death — probe below decides */ }
  const graceDeadline = deadlineOf(graceMs);
  while (Date.now() < graceDeadline) {
    if (probeGroup(pgid, killFn) === "gone") return "confirmed";
    await sleep(pollMs);
  }

  try { killFn(-pgid, "SIGKILL"); } catch { /* raced to death — probe below decides */ }
  const confirmDeadline = deadlineOf(confirmTimeoutMs);
  while (Date.now() < confirmDeadline) {
    if (probeGroup(pgid, killFn) === "gone") return "confirmed";
    await sleep(pollMs);
  }
  return "unconfirmable";
}

/** Post-acquire residual reap: if a gate sidecar exists for this project, the
 *  previous window may have left a live gate group (forge crash mid-gate, or
 *  an earlier unconfirmable termination). Reap and CONFIRM before entering the
 *  window; on an unconfirmable group, throw the actionable operator error
 *  (caller releases the lock). */
async function reapResidualGateGroup(
  lockFilePath: string,
  canonicalDir: string,
  log: (line: string) => void,
  opts?: { killFn?: KillFn; pollMs?: number; graceMs?: number; confirmTimeoutMs?: number; leaderStartOf?: (pid: number) => string | undefined },
): Promise<void> {
  const sidecarPath = gateSidecarPath(lockFilePath);
  const rec = readGateSidecar(sidecarPath);
  if (rec === undefined) return; // no sidecar — nothing residual
  if (rec.pgid === null) {
    // A gate spawn was in flight (or its record was torn) when the previous
    // holder died: a group MAY be live, and we don't know its pgid, so it
    // cannot be reaped or confirmed. Fail closed rather than merge over it.
    throw new Error(
      `project integration window on ${canonicalDir} is blocked: a previous holder` +
      `${rec.runId ? ` (run ${rec.runId})` : ""} died while starting its integration gate, so the gate's ` +
      `process group was never recorded and cannot be confirmed dead. ` +
      `Check for a stray gate (e.g. \`pgrep -af "npm run test:unit"\`), terminate it if it is running against ${canonicalDir}, ` +
      `then remove ${sidecarPath} and re-run \`forge next\`.`,
    );
  }
  const killFn: KillFn = opts?.killFn ?? ((pid, sig) => process.kill(pid, sig));
  if (probeGroup(rec.pgid, killFn) === "gone") {
    try { unlinkSync(gateSidecarPath(lockFilePath)); } catch { /* gone */ }
    return;
  }
  // The group id is signalable — but is it still the ORIGINAL group? POSIX
  // reserves a pid while it is the pgid of a live group, so the recorded
  // leader-identity token decides:
  //  - token matches the leader's current start time → the original group;
  //    safe to reap.
  //  - token MISMATCHES → the original group is entirely dead (its pgid could
  //    only be reused after every member exited) and a new process/group owns
  //    the id — do NOT signal it; the residual is resolved.
  //  - identity unverifiable (no recorded token, or the leader can't be read
  //    while the group is alive) → fail closed; never kill an unverified group.
  const leaderStartOf = opts?.leaderStartOf ?? leaderStartTimeOf;
  const currentLeaderStart = leaderStartOf(rec.pgid);
  const recordedToken = (rec as GateGroupRecord).leaderStartedAt;
  if (recordedToken !== undefined && currentLeaderStart !== undefined && currentLeaderStart !== recordedToken) {
    try { unlinkSync(gateSidecarPath(lockFilePath)); } catch { /* gone */ }
    log(
      `forge: recorded gate group id ${rec.pgid} on ${canonicalDir} has been REUSED by an unrelated process ` +
      `(leader identity changed) — the original gate group is dead; not signalling the new owner.`,
    );
    return;
  }
  if (recordedToken === undefined || currentLeaderStart === undefined) {
    throw new Error(
      `project integration window on ${canonicalDir} is blocked: a process group answers for recorded gate pgid ${rec.pgid}, ` +
      `but its identity cannot be verified against the original gate ` +
      `(${recordedToken === undefined ? "no leader identity was recorded" : "the group leader is not readable"}). ` +
      `Refusing to signal an unverified group and refusing to enter the window over it. ` +
      `Inspect with \`ps -g ${rec.pgid}\`; if it is the stray gate, terminate it (e.g. \`kill -9 -${rec.pgid}\`), ` +
      `then remove ${sidecarPath} and re-run \`forge next\`.`,
    );
  }
  log(
    `forge: reaping an orphaned integration-gate process group (pgid ${rec.pgid}${rec.runId ? `, run ${rec.runId}` : ""}) ` +
    `left on ${canonicalDir} by a previous window — confirming termination before entering.`,
  );
  const outcome = await terminateProcessGroup(rec.pgid, { ...opts, killFn });
  if (outcome === "unconfirmable") {
    throw new Error(
      `project integration window on ${canonicalDir} is blocked: an orphaned gate process group (pgid ${rec.pgid}) ` +
      `could not be confirmed terminated (still signalable after SIGTERM→SIGKILL, or not ours to signal). ` +
      `Refusing to enter the merge→gate→finalize window over a live orphan. ` +
      `Inspect with \`ps -g ${rec.pgid}\`, terminate it (e.g. \`kill -9 -${rec.pgid}\`), then re-run \`forge next\`.`,
    );
  }
  try { unlinkSync(gateSidecarPath(lockFilePath)); } catch { /* gone */ }
  log(`forge: orphaned gate group ${rec.pgid} confirmed terminated — entering the integration window.`);
}

function describeWait(held: LockInfo, canonicalDir: string, elapsedMs: number): string {
  const holder = held.holderId ? `run ${held.holderId}` : `'${held.command}'`;
  return (
    `forge: waiting for the project integration window on ${canonicalDir} — ` +
    `held by ${holder} (pid ${held.pid}) since ${held.acquiredAt}, ${Math.round(elapsedMs / 1000)}s waited. ` +
    `It releases when that run's merge→gate→finalize window completes; ` +
    `inspect with \`forge show ${held.holderId ?? "<run-id>"}\` or \`forge status\`.`
  );
}

/** Run `fn` while holding this project's integration-window lock.
 *
 *  - `projectDir === undefined` → no lock, `fn` runs directly (the
 *    non-worktree dispatch path has no merge→gate window to protect).
 *  - A LIVE holder is waited out indefinitely, with an operator-visible
 *    waiting line (immediately, then every ~10s) naming the owning run and
 *    project and the supported next action.
 *  - Always released in `finally` — pass, gate fail, and thrown errors alike.
 */
export async function withProjectIntegrationLock<T>(
  projectDir: string | undefined,
  runId: string,
  fn: () => Promise<T> | T,
  opts?: {
    log?: (line: string) => void;
    pollMs?: number;
    isAlive?: (pid: number) => boolean;
    /** Injectable group kill/confirm/identity knobs for the residual-gate reap (tests). */
    reap?: { killFn?: KillFn; pollMs?: number; graceMs?: number; confirmTimeoutMs?: number; leaderStartOf?: (pid: number) => string | undefined };
  },
): Promise<T> {
  if (projectDir === undefined) return await fn();

  const { lockFilePath, canonicalDir } = projectIntegrationLockKey(projectDir);
  mkdirSync(LOCKS_DIR, { recursive: true });
  const log = opts?.log ?? ((line: string) => console.log(line));

  let lastReportMs = -Infinity;
  await acquireFileLockBlocking(lockFilePath, `integration-window ${runId}`, {
    holderId: runId,
    ...(opts?.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    ...(opts?.isAlive !== undefined ? { isAlive: opts.isAlive } : {}),
    onWaiting: (held, elapsedMs) => {
      if (elapsedMs - lastReportMs < WAIT_REPORT_MS) return;
      lastReportMs = elapsedMs;
      log(describeWait(held, canonicalDir, elapsedMs));
    },
  });
  try {
    // FG-425 crash AC: a previous holder may have died mid-gate, leaving its
    // gate process group alive (recorded in the sidecar). Reap and CONFIRM
    // before entering; an unconfirmable orphan throws (fail closed) and the
    // finally below releases the lock.
    await reapResidualGateGroup(lockFilePath, canonicalDir, log, opts?.reap);
    return await fn();
  } finally {
    releaseFileLock(lockFilePath);
  }
}
