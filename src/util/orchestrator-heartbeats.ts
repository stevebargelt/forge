// #153: Reads orchestrator session heartbeats from ~/.forge/orchestrators/.
//
// Heartbeats are written by the Claude Code session hook
// (scripts/claude-hooks/orchestrator-heartbeat), one JSON file per session:
//   { sessionId, projectDir, startedAt, lastSeen }
//
// The hook deletes the file on SessionEnd, so under normal exits there's
// nothing to clean up. Crashes or kill -9 leave a stale file behind — we
// treat any file whose lastSeen is older than STALE_AFTER_MS as dead, and
// optionally garbage-collect on read.

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type Heartbeat = {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  lastSeen: string;
  isLive: boolean;
};

// Heartbeats older than this are considered dead. Claude Code fires the Stop
// hook after every assistant turn, so an active session should be touching
// the file frequently. 15 minutes gives us slack for a turn the user is
// reading carefully or thinking about, without showing zombies for an hour
// after a crash.
const STALE_AFTER_MS = 15 * 60 * 1000;

export type LoadOptions = {
  now?: number;                  // injected for tests
  gcStale?: boolean;             // delete stale files after read (default false)
  staleAfterMs?: number;
  heartbeatsDir?: string;        // override for tests
};

export function loadHeartbeats(opts: LoadOptions = {}): Heartbeat[] {
  const dir = opts.heartbeatsDir ?? defaultHeartbeatsDir();
  if (!dir || !existsSync(dir)) return [];
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? STALE_AFTER_MS;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: Heartbeat[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Stale/partial write or hand-edited garbage. Optionally GC, then skip.
      if (opts.gcStale) tryUnlink(path);
      continue;
    }
    const hb = coerce(parsed);
    if (!hb) {
      if (opts.gcStale) tryUnlink(path);
      continue;
    }
    const lastSeenMs = Date.parse(hb.lastSeen);
    const age = Number.isFinite(lastSeenMs) ? now - lastSeenMs : Infinity;
    const isLive = age >= 0 && age < staleAfter;
    if (!isLive && opts.gcStale) {
      tryUnlink(path);
      continue;
    }
    out.push({ ...hb, isLive });
  }
  return out;
}

// Returns the set of projectDirs with at least one currently-live session.
export function liveProjectDirs(opts: LoadOptions = {}): Set<string> {
  const set = new Set<string>();
  for (const hb of loadHeartbeats(opts)) {
    if (hb.isLive) set.add(hb.projectDir);
  }
  return set;
}

function coerce(v: unknown): { sessionId: string; projectDir: string; startedAt: string; lastSeen: string } | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o["sessionId"] !== "string" ||
    typeof o["projectDir"] !== "string" ||
    typeof o["startedAt"] !== "string" ||
    typeof o["lastSeen"] !== "string"
  ) return null;
  return {
    sessionId: o["sessionId"],
    projectDir: o["projectDir"],
    startedAt: o["startedAt"],
    lastSeen: o["lastSeen"],
  };
}

function tryUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* race; ignore */ }
}

function defaultHeartbeatsDir(): string | undefined {
  const home = process.env["HOME"];
  if (!home) return undefined;
  return join(home, ".forge", "orchestrators");
}

// Treat a file as suspicious if it claims a recent lastSeen but the file's
// mtime is much older — that means the lastSeen was hand-edited rather than
// updated by the hook. Currently unused but exported in case the dashboard
// wants to flag it. Kept here so we have one source of truth.
export function isMtimeConsistent(path: string, lastSeen: string, toleranceMs = 5_000): boolean {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const lastSeenMs = Date.parse(lastSeen);
    if (!Number.isFinite(lastSeenMs)) return false;
    return Math.abs(mtimeMs - lastSeenMs) < toleranceMs;
  } catch {
    return false;
  }
}
