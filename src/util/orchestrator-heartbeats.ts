// #153 / FG-576: the orchestrator liveness namespace, ~/.forge/orchestrators/.
//
// TWO writers share ONE directory (FG-576 D12 — no second directory) and ONE
// canonical session identity:
//
//   <session-id>.json           the Claude Code session hook
//                               (scripts/claude-hooks/orchestrator-heartbeat)
//                               { sessionId, projectDir, startedAt, lastSeen }
//   <session-id>.launcher.json  the Forge launcher (`forge orchestrator` /
//                               `forge claude`), for BOTH providers
//
// The two files make TWO DIFFERENT CLAIMS and are never conflated:
//
//   PROCESS liveness  — launcher-owned, available for every provider. A pid PLUS
//                       a process-start fence (src/util/process-identity.ts).
//                       This is the ONLY thing that answers live / not-live.
//   INTERACTION       — provider-hook-owned, Claude only today. "a turn ended at
//                       T". It is evidence of ACTIVITY, not of a running process,
//                       and its absence renders as `unknown` — which can never
//                       upgrade anything to healthy (FG-576 AC7).
//
// The 15-minute staleness window belongs to the INTERACTION claim alone. A
// suspended laptop leaves a 40-minute-old turn timestamp behind a process that
// is still very much alive; finalizing that session would be a lie (D14).
//
// Records are merged per canonical sessionId, so a launcher record and a hook
// record for one session count ONCE (D12 / FG-689 D11 — see src/util/projects.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureProcessIdentity,
  classifyProcessIdentity,
  coerceProcessIdentity,
  systemProcessProbe,
  type ProcessIdentity,
  type ProcessLiveness,
  type ProcessProbe,
} from "./process-identity.js";

export type { ProcessIdentity, ProcessLiveness, ProcessProbe } from "./process-identity.js";

export type RecordSource = "launcher" | "provider-hook";

/** Provider-hook turn evidence. `unknown` means the provider supplies no hook. */
export type InteractionState = "recent" | "stale" | "unknown";

export type SessionState =
  /** Launcher process fence proves the owning launcher is running. */
  | "live"
  /** No usable fence, but recent provider interaction evidence (legacy/foreign-host record). */
  | "live-unfenced"
  /** D17: the LAUNCHER identity is provably gone. The child's disposition is NOT asserted. */
  | "orphaned"
  /** No launcher record and the interaction evidence has gone stale. */
  | "stale"
  /** A launcher record we cannot judge, with no interaction evidence either. */
  | "unknown";

/** AC7: `healthy` requires POSITIVE interaction evidence. Absence is `unknown`, never healthy. */
export type SessionHealth = "healthy" | "stale" | "unknown";

export type OrchestratorSession = {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  /** Legacy field: the interaction timestamp when there is one, else launcher bookkeeping. */
  lastSeen: string;
  isLive: boolean;
  state: SessionState;
  processLiveness: ProcessLiveness;
  interaction: InteractionState;
  interactionLastSeen?: string;
  health: SessionHealth;
  /** True only when the session is PROVABLY over. A live fence never finalizes (D14). */
  finalizable: boolean;
  sources: RecordSource[];
  files: string[];
  provider?: string;
  runtime?: string;
  adapter?: string;
  receiptId?: string;
};

/** Back-compat alias for the pre-FG-576 name. */
export type Heartbeat = OrchestratorSession;

// Claude Code fires the Stop hook after every assistant turn, so an active
// session touches its hook file frequently. 15 minutes gives slack for a turn
// the operator is reading carefully. This window governs the INTERACTION claim
// ONLY — never the process fence.
const STALE_AFTER_MS = 15 * 60 * 1000;

const LAUNCHER_SUFFIX = ".launcher.json";
const LAUNCHER_KIND = "forge-launcher-orchestrator";

export type LoadOptions = {
  now?: number;                  // injected for tests
  gcStale?: boolean;             // delete dead provider-hook files after read (default false)
  staleAfterMs?: number;
  heartbeatsDir?: string;        // override for tests
  processProbe?: ProcessProbe;   // override for tests
};

export type WriteOptions = {
  heartbeatsDir?: string;
  now?: number;
  processProbe?: ProcessProbe;
};

export class HeartbeatWriteError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeartbeatWriteError";
    this.path = path;
  }
}

export type LauncherHeartbeatInput = {
  sessionId: string;
  projectDir: string;
  provider: string;
  runtime: string;
  adapter: string;
  receiptId?: string;
  startedAt?: string;
  /** Defaults to a fence for THIS process — the launcher, per D17. */
  identity?: ProcessIdentity;
};

type LauncherRecord = {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  refreshedAt: string;
  provider: string;
  runtime: string;
  adapter: string;
  receiptId?: string;
  process?: ProcessIdentity;
};

type HookRecord = {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  lastSeen: string;
};

// ---------------------------------------------------------------------------
// Writing (launcher-owned)
// ---------------------------------------------------------------------------

/**
 * Persist the launcher's liveness record. Throws HeartbeatWriteError rather than
 * swallowing: an orchestrator whose liveness cannot be recorded must be able to
 * refuse, not launch silently unrecorded (D11's shape, applied to this record).
 */
export function writeLauncherHeartbeat(input: LauncherHeartbeatInput, opts: WriteOptions = {}): string {
  const dir = requireHeartbeatsDir(opts.heartbeatsDir);
  const file = launcherFileName(input.sessionId);
  const path = join(dir, file);
  const probe = opts.processProbe ?? systemProcessProbe;
  const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const record: LauncherRecord = {
    sessionId: input.sessionId,
    projectDir: input.projectDir,
    startedAt: input.startedAt ?? stamp,
    refreshedAt: stamp,
    provider: input.provider,
    runtime: input.runtime,
    adapter: input.adapter,
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
    process: input.identity ?? captureProcessIdentity(process.pid, probe),
  };
  writeRecordAtomically(dir, path, record);
  return path;
}

/**
 * Touch the launcher record. This is BOOKKEEPING, not a liveness claim — nothing
 * in this module derives live/not-live from `refreshedAt`, precisely so a
 * launcher that stops refreshing (suspend) is not mistaken for a dead one.
 */
export function refreshLauncherHeartbeat(sessionId: string, opts: WriteOptions = {}): boolean {
  const dir = requireHeartbeatsDir(opts.heartbeatsDir);
  const path = join(dir, launcherFileName(sessionId));
  const existing = readLauncherRecord(path);
  if (!existing) return false;
  writeRecordAtomically(dir, path, {
    ...existing,
    refreshedAt: new Date(opts.now ?? Date.now()).toISOString(),
  });
  return true;
}

/** Close-out on a clean exit. Removes only the LAUNCHER's own file. */
export function closeLauncherHeartbeat(sessionId: string, opts: WriteOptions = {}): void {
  const dir = opts.heartbeatsDir ?? defaultHeartbeatsDir();
  if (!dir) return;
  tryUnlink(join(dir, launcherFileName(sessionId)));
}

function launcherFileName(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new HeartbeatWriteError(
      `refusing to write an orchestrator liveness record for an unsafe session id: ${JSON.stringify(sessionId)}`,
      "",
    );
  }
  return `${sessionId}${LAUNCHER_SUFFIX}`;
}

function requireHeartbeatsDir(override?: string): string {
  const dir = override ?? defaultHeartbeatsDir();
  if (!dir) {
    throw new HeartbeatWriteError(
      "cannot locate the orchestrator liveness directory: neither FORGE_ORCHESTRATORS_DIR nor HOME is set. " +
        "Set HOME (or FORGE_ORCHESTRATORS_DIR) and retry.",
      "",
    );
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new HeartbeatWriteError(
      `cannot create the orchestrator liveness directory ${dir}: ${errText(err)}. ` +
        "Fix the directory permissions and retry.",
      dir,
      { cause: err },
    );
  }
  return dir;
}

// Temp suffix deliberately does NOT end in .json, so a reader mid-write never
// sees a partial record.
function writeRecordAtomically(dir: string, path: string, record: LauncherRecord): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ kind: LAUNCHER_KIND, version: 1, ...record }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    tryUnlink(tmp);
    throw new HeartbeatWriteError(
      `cannot write the orchestrator liveness record ${path}: ${errText(err)}. ` +
        `Check that ${dir} is writable, then retry.`,
      path,
      { cause: err },
    );
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One entry per CANONICAL SESSION, not per file. A launcher record and a
 * provider-hook record naming the same sessionId merge into one session, which
 * is what keeps `liveSessions` at 1 for a session with two writers (D12).
 */
export function loadHeartbeats(opts: LoadOptions = {}): OrchestratorSession[] {
  const dir = opts.heartbeatsDir ?? defaultHeartbeatsDir();
  if (!dir || !existsSync(dir)) return [];
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? STALE_AFTER_MS;
  const probe = opts.processProbe ?? systemProcessProbe;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  entries.sort();

  const launchers = new Map<string, { record: LauncherRecord; path: string }>();
  const hooks = new Map<string, { record: HookRecord; path: string }>();

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
    if (name.endsWith(LAUNCHER_SUFFIX)) {
      const record = coerceLauncher(parsed);
      if (!record) {
        if (opts.gcStale) tryUnlink(path);
        continue;
      }
      launchers.set(record.sessionId, { record, path });
      continue;
    }
    const record = coerceHook(parsed);
    if (!record) {
      if (opts.gcStale) tryUnlink(path);
      continue;
    }
    hooks.set(record.sessionId, { record, path });
  }

  const sessionIds = [...new Set([...launchers.keys(), ...hooks.keys()])].sort();
  const out: OrchestratorSession[] = [];
  for (const sessionId of sessionIds) {
    const launcher = launchers.get(sessionId);
    const hook = hooks.get(sessionId);
    const session = classifySession(sessionId, launcher?.record, hook?.record, {
      now,
      staleAfter,
      probe,
      files: [launcher?.path, hook?.path].filter((p): p is string => typeof p === "string"),
    });
    if (opts.gcStale && session.finalizable && !launcher) {
      // Only provider-hook leftovers are garbage-collected here. A launcher
      // record is launcher-owned state that operator surfaces must be able to
      // render as `orphaned` (D15/D17) — silently deleting it would erase the
      // very evidence that a launcher died.
      for (const path of session.files) tryUnlink(path);
      continue;
    }
    out.push(session);
  }
  return out;
}

type ClassifyContext = {
  now: number;
  staleAfter: number;
  probe: ProcessProbe;
  files: string[];
};

function classifySession(
  sessionId: string,
  launcher: LauncherRecord | undefined,
  hook: HookRecord | undefined,
  ctx: ClassifyContext,
): OrchestratorSession {
  const processLiveness: ProcessLiveness = launcher
    ? classifyProcessIdentity(launcher.process, ctx.probe)
    : "unknown";

  let interaction: InteractionState = "unknown";
  if (hook) {
    const lastSeenMs = Date.parse(hook.lastSeen);
    const age = Number.isFinite(lastSeenMs) ? ctx.now - lastSeenMs : Infinity;
    interaction = age >= 0 && age < ctx.staleAfter ? "recent" : "stale";
  }

  let state: SessionState;
  if (processLiveness === "alive") state = "live";
  else if (processLiveness === "dead") state = "orphaned";
  else if (interaction === "recent") state = "live-unfenced";
  else state = launcher ? "unknown" : "stale";

  // AC7: health is a claim about INTERACTION. No hook evidence => `unknown`,
  // and `unknown` is never promoted to `healthy` by anything else on the record.
  const health: SessionHealth =
    interaction === "unknown" ? "unknown" : interaction === "recent" && processLiveness !== "dead" ? "healthy" : "stale";

  const sources: RecordSource[] = [];
  if (launcher) sources.push("launcher");
  if (hook) sources.push("provider-hook");

  const startedAt = hook?.startedAt ?? launcher?.startedAt ?? "";
  const lastSeen = hook?.lastSeen ?? launcher?.refreshedAt ?? startedAt;

  return {
    sessionId,
    projectDir: launcher?.projectDir ?? hook?.projectDir ?? "",
    startedAt,
    lastSeen,
    isLive: state === "live" || state === "live-unfenced",
    state,
    processLiveness,
    interaction,
    ...(hook ? { interactionLastSeen: hook.lastSeen } : {}),
    health,
    // Only a proven end finalizes. `unknown` and `live*` never do — that is the
    // suspended-laptop case D14 forbids finalizing.
    finalizable: state === "orphaned" || state === "stale",
    sources,
    files: ctx.files,
    ...(launcher?.provider ? { provider: launcher.provider } : {}),
    ...(launcher?.runtime ? { runtime: launcher.runtime } : {}),
    ...(launcher?.adapter ? { adapter: launcher.adapter } : {}),
    ...(launcher?.receiptId ? { receiptId: launcher.receiptId } : {}),
  };
}

/** Returns the set of projectDirs with at least one currently-live session. */
export function liveProjectDirs(opts: LoadOptions = {}): Set<string> {
  const set = new Set<string>();
  for (const session of loadHeartbeats(opts)) {
    if (session.isLive && session.projectDir) set.add(session.projectDir);
  }
  return set;
}

/** Live sessions, deduped on canonical session identity. One session, one entry. */
export function liveOrchestratorSessions(opts: LoadOptions = {}): OrchestratorSession[] {
  return loadHeartbeats(opts).filter((session) => session.isLive);
}

/** Single session by canonical identity; undefined when nothing is recorded. */
export function findOrchestratorSession(
  sessionId: string,
  opts: LoadOptions = {},
): OrchestratorSession | undefined {
  return loadHeartbeats(opts).find((session) => session.sessionId === sessionId);
}

function readLauncherRecord(path: string): LauncherRecord | undefined {
  try {
    return coerceLauncher(JSON.parse(readFileSync(path, "utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
}

function coerceLauncher(v: unknown): LauncherRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o["kind"] !== LAUNCHER_KIND) return null;
  const sessionId = o["sessionId"];
  const projectDir = o["projectDir"];
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof projectDir !== "string") return null;
  const str = (key: string, fallback = ""): string => (typeof o[key] === "string" ? (o[key] as string) : fallback);
  const receiptId = o["receiptId"];
  const identity = coerceProcessIdentity(o["process"]);
  return {
    sessionId,
    projectDir,
    startedAt: str("startedAt"),
    refreshedAt: str("refreshedAt", str("startedAt")),
    provider: str("provider"),
    runtime: str("runtime"),
    adapter: str("adapter"),
    ...(typeof receiptId === "string" && receiptId ? { receiptId } : {}),
    ...(identity ? { process: identity } : {}),
  };
}

function coerceHook(v: unknown): HookRecord | null {
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

// $HOME, not FORGE_HOME: scripts/claude-hooks/orchestrator-heartbeat writes to
// "$HOME/.forge/orchestrators" unconditionally, and the launcher must land in
// the SAME namespace (D12). FORGE_ORCHESTRATORS_DIR is the explicit isolation
// seam for tests and for anyone who relocates both writers together.
function defaultHeartbeatsDir(): string | undefined {
  const override = process.env["FORGE_ORCHESTRATORS_DIR"];
  if (override) return override;
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
