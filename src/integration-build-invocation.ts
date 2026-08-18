// FG-728 / review-0eddd03dd805 RF-1: the per-invocation identity the build
// preload keys its lock + ready sentinel on.
//
// The preload coordinates "exactly one build per `node --test` invocation" via a
// lock dir + ready file in the OS tmpdir, shared by every subprocess of the
// invocation. Those subprocesses share a parent (the test runner), so the parent
// process names the invocation. Keying on process.ppid ALONE is unsafe: the
// markers are created but never removed and live in the OS tmpdir, so once the OS
// reuses that parent PID a LATER invocation finds the pre-existing ready sentinel,
// takes the follower path, and skips the build — running against a STALE tree.
// That violates the "never reuse a stale tree" invariant (CI runners are fresh, so
// it only bites a dev host re-running the tier).
//
// The fix pins the identity to the parent's PID *and its start time*: a recycled
// PID belongs to a process that started later, so its start token differs and the
// stale markers never match — a fresh invocation always rebuilds. All subprocesses
// of one invocation share the same live parent, so they still agree on one
// identity and coordinate exactly as before. This logic is pure and unit-tested;
// the preload itself cannot be imported under test (it esbuilds the whole src tree
// on import), which is why the identity derivation lives here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** The parent process's start time as an opaque token that changes whenever a
 *  reused PID names a different process. Empty string only if the platform
 *  exposes no cheap way to read it — the caller then degrades to PID-only keying,
 *  which is no worse than the pre-fix behavior. */
export function parentStartToken(ppid: number): string {
  // Linux fast path: /proc/<ppid>/stat field 22 is starttime (clock ticks since
  // boot). The comm field (2) may contain spaces and ')', so the stable parse is
  // to take the fields AFTER the final ')': field 3 (state) becomes index 0, so
  // starttime (field 22) is index 19.
  try {
    const fields = readFileSync(`/proc/${ppid}/stat`, "utf8");
    const after = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
    const starttime = after[19];
    if (starttime && /^\d+$/.test(starttime)) return `j${starttime}`;
  } catch {
    // not Linux, or /proc unreadable — fall through to ps
  }
  // macOS / BSD: `ps -o lstart=` prints the process's start timestamp.
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return `t${out.replace(/\s+/g, "-")}`;
  } catch {
    // no ps / unsupported flags — PID-only keying below
  }
  return "";
}

/** The invocation identity every subprocess of one `node --test` process agrees
 *  on. Folds in the parent start token so a recycled parent PID cannot collide
 *  with a prior invocation's persisted markers. */
export function invocationId(ppid: number, startToken: string): string {
  return startToken ? `${ppid}-${startToken}` : `${ppid}`;
}

export type InvocationMarkers = { lockDir: string; ready: string };

/** The lock dir + ready sentinel paths (in the OS tmpdir) for an invocation id. */
export function invocationMarkers(id: string): InvocationMarkers {
  return {
    lockDir: resolve(tmpdir(), `forge-integration-build.${id}.lock`),
    ready: resolve(tmpdir(), `forge-integration-build.${id}.ready`),
  };
}
