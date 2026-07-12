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
//   is stolen. The held work — merge, host gate subprocess, cleanup — runs in
//   the holding forge process itself, so pid-death is the right steal
//   evidence here (unlike docker provisioning, nothing survives the pid by
//   design; the pre-existing integration-gate child-process caveat is
//   unchanged by this lock).
// - Keyed on realpath-canonicalized projectDir so two runs pointed at one
//   repo through different spellings (symlink, trailing slash, relative)
//   still exclude each other. Independent projects hash to independent lock
//   files and proceed fully in parallel.
// - Nests strictly INSIDE the per-runId dispatch lock (acquired by `forge
//   next`), acquired at most once per run per wave, never re-entrant.
// - Deterministic release: try/finally around the critical section — gate
//   pass, gate fail, thrown merge/cleanup errors all release; a crashed
//   holder is released by the next contender's dead-pid steal.

import { mkdirSync, realpathSync } from "node:fs";
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
  opts?: { log?: (line: string) => void; pollMs?: number; isAlive?: (pid: number) => boolean },
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
    return await fn();
  } finally {
    releaseFileLock(lockFilePath);
  }
}
