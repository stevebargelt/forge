// FG-576 step 7 — THE ONE READ-ONLY READER OF CODEX CLI'S OWN SESSION STATE, and the
// post-spawn identity correlation it feeds.
//
// WHY CORRELATION EXISTS AT ALL. Claude Code accepts `--session-id`, so Forge MINTS a
// new session's identity before spawn and the receipt owns it. codex (0.144.1) has no
// such flag: it names its own session and writes it into its own rollout file after it
// starts. So the strongest honest binding Forge can make is a CORRELATION — "one new
// Codex session appeared in this project after this spawn" — and the receipt records
// exactly that word, with what the correlation was based on (AC9).
//
// AND WHERE CORRELATION MUST REFUSE TO GUESS. Two Codex sessions started in one project
// inside the window produce TWO new rollout files and no way to tell which one this
// launch spawned. That resolves to `ambiguous`, never to "the newest one" — the same
// recency guess FG-448 removed from the Claude reader, where it could surface one
// session's LIVE CONTROL CREDENTIAL as another's. Here it would bind a receipt (and
// therefore a later `--resume`) to somebody else's session.
//
// D8, NON-NEGOTIABLE: every path in this file READS. Nothing here writes into the
// operator's Codex home, and CODEX_HOME is never set, redirected or even read as a
// Forge seam — the read root resolves through FORGE_CODEX_DIR (the same seam
// src/util/creds.ts already uses for auth.json), so a test points Forge at a
// disposable root without touching the operator's real one (AC13).
//
// Every function answers a failure — a missing dir, an unreadable file, malformed
// JSON, a half-written line — with "no answer", never with a throw and never with a
// guess. Codex's rollout format is undocumented provider-internal state; a reader that
// could throw would turn a codex version bump into a broken `forge orchestrator`.

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordOrchestratorSessionIdentity, type SessionIdentityStrength } from "../store/orchestrator-receipts.js";
import { isSafeSessionIdentifier } from "./adapter.js";

export type CodexStateOptions = {
  /** Overrides the read root for a direct call. A real launch passes nothing and
   *  resolves through the documented FORGE_CODEX_DIR seam. */
  codexDir?: string | undefined;
};

/** Codex CLI's own state root, READ-ONLY. `FORGE_CODEX_DIR` is Forge's read seam and
 *  is deliberately NOT `CODEX_HOME`: pointing the CHILD at a different Codex home
 *  would move the operator's sessions, credentials and config out from under them,
 *  which D8 forbids outright. Forge redirects only where IT reads. */
export function codexStateDir(opts: CodexStateOptions = {}): string {
  return opts.codexDir ?? process.env["FORGE_CODEX_DIR"] ?? join(homedir(), ".codex");
}

export function codexSessionsDir(opts: CodexStateOptions = {}): string {
  return join(codexStateDir(opts), "sessions");
}

export type CodexSessionRecord = {
  sessionId: string;
  path: string;
  mtimeMs: number;
  /** The project the session itself declares. null when the file names none, in which
   *  case it is never attributed to a project — fail closed. */
  cwd: string | null;
};

/** codex writes `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Matched on the
 *  name rather than on the directory shape, so a build that changes the date layout
 *  still reads — and a file that is not a rollout is never mistaken for one. */
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const ROLLOUT_ID_IN_NAME = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** How deep the sessions tree is walked. Codex's own layout is three levels
 *  (year/month/day); the bound exists so an operator symlink loop cannot turn a
 *  telemetry read into an unbounded traversal. */
const MAX_WALK_DEPTH = 5;

/** Every Codex session Forge can see, newest last. Never throws. */
export function listCodexSessions(opts: CodexStateOptions = {}): CodexSessionRecord[] {
  const out: CodexSessionRecord[] = [];
  walk(codexSessionsDir(opts), 0, out);
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function walk(dir: string, depth: number, out: CodexSessionRecord[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !ROLLOUT_FILE.test(entry.name)) continue;
    const record = readSessionRecord(path);
    if (record) out.push(record);
  }
}

function readSessionRecord(path: string): CodexSessionRecord | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const meta = readSessionMeta(path);
  const sessionId = meta.sessionId ?? ROLLOUT_ID_IN_NAME.exec(path)?.[1] ?? null;
  if (sessionId === null || !isSafeSessionIdentifier(sessionId)) return null;
  return { sessionId, path, mtimeMs, cwd: meta.cwd };
}

/** The session id and project a rollout file declares. Reads a bounded prefix: the
 *  metadata entry is the first line, and reading a multi-megabyte transcript to answer
 *  two fields is not worth doing. */
function readSessionMeta(path: string): { sessionId: string | null; cwd: string | null } {
  const head = readPrefix(path, 16 * 1024);
  if (head === null) return { sessionId: null, cwd: null };
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated final line is normal on a bounded read
    }
    if (typeof entry !== "object" || entry === null) continue;
    const top = entry as Record<string, unknown>;
    const payload = typeof top["payload"] === "object" && top["payload"] !== null ? (top["payload"] as Record<string, unknown>) : {};
    const sessionId = firstString(top["id"], top["session_id"], top["sessionId"], payload["id"], payload["session_id"]);
    const cwd = firstString(top["cwd"], payload["cwd"]);
    if (sessionId !== null || cwd !== null) return { sessionId, cwd };
  }
  return { sessionId: null, cwd: null };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function readPrefix(path: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    if (len === 0) return "";
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, Math.max(0, read)).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The correlation itself
// ---------------------------------------------------------------------------

export type CodexCorrelation = {
  providerSessionId: string | null;
  strength: SessionIdentityStrength;
  /** What the strength is BASED ON, in the operator's terms. Recorded verbatim on the
   *  receipt, because "correlated" without its basis is not a checkable claim. */
  basis: string;
};

export type CorrelationInput = {
  sessions: readonly CodexSessionRecord[];
  projectDir: string;
  /** Session ids that already existed when the child was confirmed spawned. */
  baseline: ReadonlySet<string>;
};

/**
 * Bind a Codex session to this launch, or say honestly that nothing can be bound.
 *
 * The candidate set is deliberately narrow: a session that did NOT exist at spawn AND
 * that declares THIS project as its cwd. A rollout file naming no project is never
 * attributed to one — fail closed — because "it appeared while we were watching" is
 * exactly the recency guess this whole module exists to refuse.
 *
 *   0 candidates  → `unknown`    nothing appeared; Forge binds nothing.
 *   1 candidate   → `correlated` the strongest binding codex allows (AC9).
 *   2+ candidates → `ambiguous`  two sessions in one project inside the window. The
 *                                ids are recorded in the basis so an operator can
 *                                resolve it by hand; Forge does not choose one.
 */
export function correlateCodexSession(input: CorrelationInput): CodexCorrelation {
  const candidates = input.sessions.filter((s) => !input.baseline.has(s.sessionId) && s.cwd === input.projectDir);

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      providerSessionId: only.sessionId,
      strength: "correlated",
      basis:
        `exactly one new Codex session appeared in ${input.projectDir} after this launch was spawned ` +
        `(${only.path}). Codex CLI cannot be told its session id, so this binding is CORRELATED, not asserted.`,
    };
  }

  if (candidates.length > 1) {
    return {
      providerSessionId: null,
      strength: "ambiguous",
      basis:
        `${candidates.length} new Codex sessions appeared in ${input.projectDir} inside this launch's correlation ` +
        `window (${candidates.map((c) => c.sessionId).join(", ")}), so which one this launch spawned cannot be ` +
        `established. Forge records the ambiguity rather than guessing — a guessed binding would attribute a ` +
        `later resume or usage read to somebody else's session.`,
    };
  }

  return {
    providerSessionId: null,
    strength: "unknown",
    basis:
      `no new Codex session was observed in ${input.projectDir} inside this launch's correlation window, so no ` +
      `provider session identity was bound. Codex CLI cannot be told its session id and Forge attributes nothing ` +
      `by recency.`,
  };
}

// ---------------------------------------------------------------------------
// The watcher that runs for the life of the correlation window
// ---------------------------------------------------------------------------

export type CodexCorrelationBinding = {
  receiptId: string;
  projectDir: string;
};

export type CodexCorrelationOptions = CodexStateOptions & {
  pollMs?: number | undefined;
  /** How long two sessions started in one project count as OVERLAPPING. The decision
   *  is taken when the window closes rather than on the first sighting, so a second
   *  session that starts a moment later still degrades the binding to `ambiguous`
   *  instead of arriving after Forge already committed to a guess. */
  windowMs?: number | undefined;
  /** Test seam: where the correlation is recorded. Defaults to the receipt store. */
  record?: ((receiptId: string, identity: CodexCorrelation) => void) | undefined;
  onResolved?: ((correlation: CodexCorrelation) => void) | undefined;
  now?: (() => number) | undefined;
};

export type CodexCorrelationWatch = {
  /** Evaluate once, synchronously. Returns the correlation when the window has closed
   *  (or been closed early by an unambiguous refusal to guess), else null. */
  tick(): CodexCorrelation | null;
  stop(): void;
};

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_WINDOW_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Watch for the session this launch spawned and record it against the receipt.
 *
 * It records ONCE, when the window closes — not on the first sighting. That ordering
 * is the AC9 property: a second session started in the same project a moment after the
 * first must degrade the binding to `ambiguous`, and it cannot do that if Forge has
 * already committed to the first thing it saw.
 *
 * The timer is unref'd, and every write is guarded: this is telemetry about the
 * session, and telemetry must never keep the launcher alive past it or fail it. A
 * receipt that has already closed simply refuses the write (the store enforces that a
 * closed receipt takes no identity), and that refusal is swallowed here.
 */
export function startCodexSessionCorrelation(
  binding: CodexCorrelationBinding,
  opts: CodexCorrelationOptions = {},
): CodexCorrelationWatch {
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.windowMs ?? envInt("FORGE_CODEX_CORRELATION_WINDOW_MS", DEFAULT_WINDOW_MS);
  const pollMs = opts.pollMs ?? envInt("FORGE_CODEX_CORRELATION_POLL_MS", DEFAULT_POLL_MS);
  const record = opts.record ?? defaultRecord;

  const startedAt = now();
  const baseline = new Set(safeList(opts).map((s) => s.sessionId));
  let stopped = false;

  const tick = (): CodexCorrelation | null => {
    if (stopped) return null;
    if (now() - startedAt < windowMs) return null;
    const correlation = correlateCodexSession({
      sessions: safeList(opts),
      projectDir: binding.projectDir,
      baseline,
    });
    stop();
    try {
      record(binding.receiptId, correlation);
    } catch {
      /* a closed receipt takes no identity, and telemetry never fails a session */
    }
    opts.onResolved?.(correlation);
    return correlation;
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { tick, stop };
}

function safeList(opts: CodexStateOptions): CodexSessionRecord[] {
  try {
    return listCodexSessions(opts);
  } catch {
    return [];
  }
}

function defaultRecord(receiptId: string, correlation: CodexCorrelation): void {
  recordOrchestratorSessionIdentity(receiptId, {
    providerSessionId: correlation.providerSessionId,
    strength: correlation.strength,
    basis: correlation.basis,
  });
}
