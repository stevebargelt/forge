// FG-576 step 8 / FG-448 — THE ONE FAIL-CLOSED READER OF CLAUDE CODE'S INTERNAL
// SESSION STATE, and the session-scoped home of the remote-control credential.
//
// Claude Code's per-session transcript (`<state>/projects/<path-hash>/<session-id>.jsonl`)
// is an undocumented internal format that may change between builds. Everything that
// parses it lives HERE, and every function in this file answers a failure — a missing
// file, an unreadable one, malformed JSON, a truncated write — with "no answer", never
// with a throw and never with a guess. A launcher whose telemetry reader could throw
// would turn a Claude Code version bump into a broken `forge orchestrator`.
//
// TWO THINGS THIS MODULE REPLACES, both of them defects rather than tidy-ups:
//
//   1. LOOK-UP BY SESSION ID, NOT BY RECENCY. The previous reader took the most
//      recently MODIFIED .jsonl under the project's path-hash directory. With two
//      sessions open on one project, "newest" is whichever wrote last — so the usage
//      of session A could be attributed to session B, and, far worse, session B's
//      LIVE CONTROL CREDENTIAL could be surfaced as session A's. Here the transcript
//      is addressed by the session id the receipt ASSERTED. When Forge asserted no
//      identity (a `--continue` launch, whose conversation Claude picks itself), the
//      answer is nothing at all — an honest gap, never the newest neighbour.
//
//   2. AN ENV SEAM INSTEAD OF A HARDCODED homedir(). The old reader resolved
//      `~/.claude` from homedir(), which meant any test that read Claude session
//      state had to mutate the operator's real HOME. AC13 forbids that outright, so
//      the root resolves through claudeStateDir() (src/util/paths.ts) — this is a
//      precondition of testing the feature at all, not a cleanup.
//
// THE REMOTE-CONTROL URL IS A LIVE CONTROL CREDENTIAL. Anyone holding it can drive
// the session. So it is EPHEMERAL SESSION-SCOPED STATE, held against the receipt for
// the life of the session and no longer:
//
//   * it is written to a Forge-owned file keyed by the canonical session identity,
//     never into the store, never into project metadata, never into any durable
//     projection;
//   * a read re-checks the OWNING RECEIPT and refuses (and removes the file) the
//     moment that receipt is no longer claiming a running session, so a launcher
//     killed mid-session — which never gets to run its close-out — cannot leave a
//     usable credential behind;
//   * close-out removes it unconditionally, including on spawn failure.
//
// Whether it may ever be SERVED, and under what bind, is step 11's decision. This
// module only makes it available to be asked for.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeStateDir, orchestratorRemoteControlDir } from "../util/paths.js";
import {
  extractUsageFromTranscript,
  insertUsageRows,
  usageModelMismatches,
  type UsageModelMismatch,
} from "../store/model-calls.js";
import { getOrchestratorReceipt, type SessionIdentityStrength } from "../store/orchestrator-receipts.js";
import { isSafeSessionIdentifier } from "./adapter.js";

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

export type ClaudeStateOptions = {
  /** Overrides the env seam for a direct call. The adapter passes nothing, so a
   *  real launch always resolves through claudeStateDir()'s documented precedence. */
  stateDir?: string | undefined;
  /** Overrides where the ephemeral remote-control credential is held. */
  remoteControlDir?: string | undefined;
};

function stateRoot(opts: ClaudeStateOptions = {}): string {
  return opts.stateDir ?? claudeStateDir();
}

function credentialRoot(opts: ClaudeStateOptions = {}): string {
  return opts.remoteControlDir ?? orchestratorRemoteControlDir();
}

/** Claude Code's per-project transcript directory: the absolute project path with
 *  every `/` replaced by `-`. Derived rather than searched, so the directory a
 *  lookup reads is a function of the project the receipt records. */
export function claudeProjectStateDir(projectDir: string, opts: ClaudeStateOptions = {}): string {
  return join(stateRoot(opts), "projects", projectDir.replace(/\//g, "-"));
}

/** The transcript path a session id maps to. May not exist — see findClaudeTranscript. */
export function claudeTranscriptPath(projectDir: string, sessionId: string, opts: ClaudeStateOptions = {}): string {
  return join(claudeProjectStateDir(projectDir, opts), `${sessionId}.jsonl`);
}

/**
 * The transcript for ONE session, addressed by identity.
 *
 * The derived path is authoritative. The fallback sweep exists because the
 * path-hash rule is Claude Code's, not Forge's, and has varied across builds — but
 * it is a sweep for a file NAMED BY THIS SESSION ID (a UUID Forge minted), and it
 * is accepted only when the transcript itself declares the same project dir. That
 * is deliberately not "find something plausible": there is no ordering, no recency
 * and no cross-project acceptance anywhere in it.
 */
export function findClaudeTranscript(
  projectDir: string,
  sessionId: string,
  opts: ClaudeStateOptions = {},
): string | null {
  if (!isSafeSessionIdentifier(sessionId)) return null;

  const exact = claudeTranscriptPath(projectDir, sessionId, opts);
  if (isReadableFile(exact)) return exact;

  const projectsDir = join(stateRoot(opts), "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const name of entries.sort()) {
    const candidate = join(projectsDir, name, `${sessionId}.jsonl`);
    if (!isReadableFile(candidate)) continue;
    if (transcriptDeclaresProject(candidate, projectDir)) return candidate;
  }
  return null;
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when the transcript's own entries name `projectDir` as their cwd. Reads a
 *  bounded prefix: the cwd appears on the first entries, and an unbounded read of a
 *  multi-megabyte transcript to answer a yes/no is not worth doing. */
function transcriptDeclaresProject(path: string, projectDir: string): boolean {
  const head = readPrefix(path, 64 * 1024);
  if (head === null) return false;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated final line is normal on a bounded read
    }
    if (typeof entry !== "object" || entry === null) continue;
    const cwd = (entry as Record<string, unknown>)["cwd"];
    if (typeof cwd === "string" && cwd === projectDir) return true;
  }
  return false;
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
// The remote-control URL, extracted from provider-internal state
// ---------------------------------------------------------------------------

/** `/remote-control` prints e.g. https://claude.ai/code/session_01BR4kQAYSdYZSvB8tt4tBHN.
 *  Anchored on the literal host and path so nothing else in a transcript — a URL the
 *  operator pasted, a tool result — can be mistaken for one. Non-global on purpose:
 *  a global regex would carry lastIndex across calls. */
const REMOTE_CONTROL_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]{4,}/;

/** The URL in a block of transcript text, or null. Exported for the parser's own
 *  tests — nothing else should be reading provider-internal bytes. */
export function findRemoteControlUrlInText(text: string): string | null {
  return REMOTE_CONTROL_URL.exec(text)?.[0] ?? null;
}

const SCAN_CHUNK_BYTES = 256 * 1024;
/** Enough to carry a URL split across a chunk boundary. */
const SCAN_CARRY_BYTES = 512;

export type TranscriptScanner = {
  /** Scan whatever has been appended since the last call. Null means "nothing found
   *  yet", which is indistinguishable — deliberately — from "not readable". */
  scan(): string | null;
};

/** An incremental scanner over one transcript. Incremental because a live session's
 *  transcript grows for hours and re-reading it whole on every poll would make an
 *  optional convenience the most expensive thing the launcher does. */
export function createTranscriptScanner(path: string): TranscriptScanner {
  let offset = 0;
  let carry = "";

  return {
    scan(): string | null {
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        if (size < offset) {
          // Truncated or replaced under us. Start over rather than read garbage.
          offset = 0;
          carry = "";
        }
        while (offset < size) {
          const len = Math.min(SCAN_CHUNK_BYTES, size - offset);
          const buf = Buffer.allocUnsafe(len);
          const read = readSync(fd, buf, 0, len, offset);
          if (read <= 0) break;
          offset += read;
          const text = carry + buf.subarray(0, read).toString("utf8");
          const hit = findRemoteControlUrlInText(text);
          if (hit) return hit;
          carry = text.slice(-SCAN_CARRY_BYTES);
        }
        return null;
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
    },
  };
}

// ---------------------------------------------------------------------------
// The ephemeral credential store
// ---------------------------------------------------------------------------

export type RemoteControlLink = {
  /** The canonical Forge session identity — the same key the receipt and the
   *  launcher-owned liveness record use, so all three join on one value. */
  sessionKey: string;
  /** The receipt this credential belongs to. A read that cannot confirm this receipt
   *  is still claiming a running session yields nothing. */
  receiptId: string;
  projectDir: string;
  url: string;
  capturedAt: string;
};

const LINK_KIND = "forge-orchestrator-remote-control";

function linkPath(sessionKey: string, opts: ClaudeStateOptions): string | null {
  if (!isSafeSessionIdentifier(sessionKey)) return null;
  return join(credentialRoot(opts), `${sessionKey}.json`);
}

/**
 * Hold the credential against the receipt. Returns false rather than throwing: a
 * link that cannot be written costs the operator a dashboard convenience, and no
 * convenience is worth failing a live interactive session over.
 */
export function stashRemoteControlLink(link: RemoteControlLink, opts: ClaudeStateOptions = {}): boolean {
  const path = linkPath(link.sessionKey, opts);
  if (path === null) return false;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(credentialRoot(opts), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ kind: LINK_KIND, version: 1, ...link }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    return false;
  }
}

/**
 * The credential for a session, or nothing.
 *
 * "Or nothing" covers every failure and every doubt: no file, an unparseable one,
 * a store that cannot be read, a receipt that no longer exists, and — the case
 * FG-448 names explicitly — a receipt that has ENDED. A launcher killed with
 * SIGKILL never runs its close-out, so the file alone cannot be trusted to
 * disappear; the receipt is re-checked on every read and the stale file is removed
 * when it is found. A stale credential surfaced as live is exactly the failure this
 * whole ticket exists to close.
 */
export function readRemoteControlLink(sessionKey: string, opts: ClaudeStateOptions = {}): RemoteControlLink | undefined {
  const path = linkPath(sessionKey, opts);
  if (path === null) return undefined;

  let link: RemoteControlLink | undefined;
  try {
    link = coerceLink(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
  if (!link) return undefined;

  let stillRunning: boolean;
  try {
    const receipt = getOrchestratorReceipt(link.receiptId);
    if (!receipt) {
      // The receipt is gone; nothing owns this credential any more.
      tryUnlink(path);
      return undefined;
    }
    stillRunning = receipt.claimsRunning && !receipt.terminal;
  } catch {
    // An unreadable store is not evidence the session ended — but it is not
    // evidence it is live either, and this value is only ever handed out on
    // positive evidence.
    return undefined;
  }
  if (!stillRunning) {
    tryUnlink(path);
    return undefined;
  }
  return link;
}

/** Every live credential for ONE project. Project-scoped by construction: there is
 *  no listing that spans projects, because a cross-project projection is precisely
 *  how a credential for project A ends up in a payload assembled for project B. */
export function remoteControlLinksForProject(
  projectDir: string,
  opts: ClaudeStateOptions = {},
): RemoteControlLink[] {
  let entries: string[];
  try {
    entries = readdirSync(credentialRoot(opts));
  } catch {
    return [];
  }
  const out: RemoteControlLink[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    const link = readRemoteControlLink(name.slice(0, -".json".length), opts);
    if (link && link.projectDir === projectDir) out.push(link);
  }
  return out;
}

/** Close-out. Idempotent, and never throws — it runs on the exit path. */
export function clearRemoteControlLink(sessionKey: string, opts: ClaudeStateOptions = {}): void {
  const path = linkPath(sessionKey, opts);
  if (path !== null) tryUnlink(path);
}

function coerceLink(v: unknown): RemoteControlLink | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o["kind"] !== LINK_KIND) return undefined;
  const { sessionKey, receiptId, projectDir, url, capturedAt } = o;
  if (typeof sessionKey !== "string" || !sessionKey) return undefined;
  if (typeof receiptId !== "string" || !receiptId) return undefined;
  if (typeof projectDir !== "string") return undefined;
  if (typeof url !== "string" || findRemoteControlUrlInText(url) !== url) return undefined;
  return {
    sessionKey,
    receiptId,
    projectDir,
    url,
    capturedAt: typeof capturedAt === "string" ? capturedAt : "",
  };
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Capture, for the life of the session
// ---------------------------------------------------------------------------

/** What the receipt knows about the session being watched. `identityStrength` is
 *  the gate: capture happens only for an identity Forge ASSERTED. */
export type ClaudeSessionBinding = {
  projectDir: string;
  sessionKey: string;
  receiptId: string;
  providerSessionId: string | null;
  identityStrength: SessionIdentityStrength;
};

export type RemoteControlCaptureOptions = ClaudeStateOptions & {
  pollMs?: number | undefined;
  onCapture?: ((link: RemoteControlLink) => void) | undefined;
  now?: (() => Date) | undefined;
};

export type RemoteControlCapture = {
  /** Scan once, synchronously. Returns the URL if this call captured it. */
  tick(): string | null;
  stop(): void;
};

const DEFAULT_POLL_MS = 5_000;

/**
 * Watch the session's own transcript for its remote-control URL and hold the first
 * one found against the receipt.
 *
 * Polling rather than capturing once at spawn, because the URL does not exist at
 * spawn: `remoteControlAtStartup` may be off and the operator may run
 * `/remote-control` at any point. FG-448 makes capture REQUIRED behavior — a live
 * session whose URL is available and is not captured is a defect — so a single
 * early look would be an implementation that mostly does not work.
 *
 * The timer is unref'd: this is telemetry, and telemetry never keeps the launcher
 * alive past the session it describes.
 */
export function startRemoteControlCapture(
  binding: ClaudeSessionBinding,
  opts: RemoteControlCaptureOptions = {},
): RemoteControlCapture {
  const sessionId = binding.identityStrength === "asserted" ? binding.providerSessionId : null;
  if (!sessionId) {
    // No Forge-asserted identity (a --continue launch). There is no session whose
    // transcript we may claim, and the newest neighbour is NOT it. No link, no
    // failure — the receipt already records the gap as a limitation.
    return { tick: () => null, stop: () => {} };
  }

  const now = opts.now ?? (() => new Date());
  let scanner: TranscriptScanner | null = null;
  let scannedPath: string | null = null;
  let stopped = false;

  const tick = (): string | null => {
    if (stopped) return null;
    try {
      if (scannedPath === null || !isReadableFile(scannedPath)) {
        scannedPath = findClaudeTranscript(binding.projectDir, sessionId, opts);
        scanner = scannedPath === null ? null : createTranscriptScanner(scannedPath);
      }
      if (!scanner) return null;
      const url = scanner.scan();
      if (!url) return null;

      const link: RemoteControlLink = {
        sessionKey: binding.sessionKey,
        receiptId: binding.receiptId,
        projectDir: binding.projectDir,
        url,
        capturedAt: now().toISOString(),
      };
      if (!stashRemoteControlLink(link, opts)) return null;
      stop();
      opts.onCapture?.(link);
      return url;
    } catch {
      // Provider-internal state is fragile by construction: fail closed.
      return null;
    }
  };

  const timer = setInterval(tick, opts.pollMs ?? DEFAULT_POLL_MS);
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  // One immediate look, so a session that already has a URL (a resume, or
  // remoteControlAtStartup) does not wait a whole poll interval for it.
  tick();

  return { tick, stop };
}

// ---------------------------------------------------------------------------
// Post-session usage, bound to the receipt (AC12)
// ---------------------------------------------------------------------------

export type ClaudeUsageCapture = {
  transcriptPath: string | null;
  rowCount: number;
  /** Recorded verbatim from the provider and REPORTED. The rows keep the provider's
   *  own model value; nothing here rewrites history to agree with the receipt. */
  mismatches: UsageModelMismatch[];
  /** Why nothing was captured, when that is a known and honest gap rather than a
   *  failure. Null when usage was captured. */
  skipped: string | null;
  error: string | null;
};

/**
 * Bind a finished session's usage to its receipt.
 *
 * Every gap is NAMED rather than papered over: no asserted identity, no transcript,
 * no instrumentation task. In particular, rows are NOT inserted when there is no
 * task to bind them to — unbound usage rows are worse than none, because they look
 * like accounted-for work while belonging to nothing.
 *
 * Never throws. Post-session telemetry that could change the exit code the operator
 * sees would be a worse bug than losing the telemetry.
 */
export function captureClaudeOrchestratorUsage(
  binding: ClaudeSessionBinding & { taskId: string | null; expectedModel: string | null; alias?: string | null },
  opts: ClaudeStateOptions = {},
): ClaudeUsageCapture {
  const empty = (skipped: string | null, error: string | null = null): ClaudeUsageCapture => ({
    transcriptPath: null,
    rowCount: 0,
    mismatches: [],
    skipped,
    error,
  });

  const sessionId = binding.identityStrength === "asserted" ? binding.providerSessionId : null;
  if (!sessionId) {
    return empty(
      "no Forge-asserted session identity, so this session's transcript cannot be identified and its usage is " +
        "not captured. Nothing was attributed by recency.",
    );
  }
  if (!binding.taskId) {
    return empty(
      "no orchestrator task was recorded for this launch, so there is nothing for usage rows to bind to and none " +
        "were written.",
    );
  }

  let transcriptPath: string | null;
  try {
    transcriptPath = findClaudeTranscript(binding.projectDir, sessionId, opts);
  } catch {
    transcriptPath = null;
  }
  if (transcriptPath === null) {
    return empty(`no Claude Code transcript was found for session ${sessionId}, so no usage was captured.`);
  }

  try {
    const rows = extractUsageFromTranscript(transcriptPath, {
      taskId: binding.taskId,
      ...(binding.alias ? { alias: binding.alias } : {}),
      // Defense in depth behind the filename: an entry that names a DIFFERENT
      // session is not this session's usage, whatever file it was found in.
      sessionId,
    });
    const mismatches = usageModelMismatches(rows, binding.expectedModel);
    if (rows.length === 0) {
      return { transcriptPath, rowCount: 0, mismatches, skipped: null, error: null };
    }
    insertUsageRows(rows);
    return { transcriptPath, rowCount: rows.length, mismatches, skipped: null, error: null };
  } catch (e) {
    return { transcriptPath, rowCount: 0, mismatches: [], skipped: null, error: (e as Error).message };
  }
}
