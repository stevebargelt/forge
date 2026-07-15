// FG-535: the durable launch path for long-running forge commands.
//
// An interactive orchestrator harness (Claude Code) is a proven-hostile owner
// for long-running work: its background-task registry SIGTERMs registered
// children on internal sweeps (si_pid-captured, FG-535), and an attached
// `docker run` forwards that straight into the agent container (exit 143).
// `forge launch` moves ownership to a tmux server instead: the submitting Bash
// call returns immediately, the tmux-owned process survives the submitter's
// turn/session lifecycle, and everything about the launch is persisted under
// ~/.forge/launches/<id>/ so any later session can read what happened:
//
//   meta.json  — command argv, tmux session name, launcher + owner pids, start
//                time, log path
//   exit       — {"code": <n>|null, "signal": "SIGTERM"|null}, written by the
//                wrapper the moment the command finishes. The wrapper is a node
//                runner, so `signal` is the OS's WIFSIGNALED verdict — NOT a
//                guess from a 143-shaped exit code. A command that deliberately
//                returns 143 records {code:143, signal:null} and is never
//                confused with one the kernel killed.
//   out.log    — combined stdout+stderr of the command
//
// Status is DERIVED at read time, never stored: exit record ⇒ finished (ok /
// error / signaled); no exit record + live tmux session ⇒ running; no exit
// record + no session ⇒ unknown (e.g. host reboot took the tmux server).
//
// ATTRIBUTION (FG-535 AC: "do not infer the sender from exit 143 alone"): even
// a WIFSIGNALED record proves only THAT a signal landed, never WHO sent it —
// nothing here captures si_pid. So a signaled launch reports the signal with
// sender "unrecorded", and a signal-range exit code with no signal evidence
// stays `terminated_unattributed`. Neither is ever upgraded to a claim that
// something external killed the command.
//
// The tmux server is the OWNER; this module never keeps a process attached.
// Forge run/task ids are extracted from the log opportunistically ("when
// available") — the command may not be a forge command at all.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_HOME } from "../util/paths.js";
import { readReleaseManifest } from "./release.js";

export const LAUNCHES_DIR = join(FORGE_HOME, "launches");

// FG-569 (R1): the release identity of the SUBMITTING forge CLI, derived from
// the CLI's OWN release manifest. `release` carries the manifest id, the commit,
// and the release dir; `dev` is the explicit unversioned marker for a CLI NOT
// running from a release (bin/forge) — releaseId is null, never a manufactured
// id and never omitted-as-if-release.
export type ControlRelease =
  | { kind: "release"; releaseId: string; commit: string; path: string }
  | { kind: "dev"; releaseId: null };

// FG-569 (R1): the SUBMITTING forge CLI's OWN runtime, captured INSIDE the CLI
// process at launch submission — process.execPath / process.versions.modules /
// process.version, plus its release identity. This is a DISTINCT runtime from the
// exit recorder (R2, RecorderRuntime): the recorder can run under a different
// interpreter, so R1 is NEVER inferred from R2. Captured once, at submission,
// because the CLI process is gone by the time anyone inspects the launch.
export type ControlRuntime = {
  execPath: string;
  abi: string;
  nodeVersion: string;
  release: ControlRelease;
};

export type LaunchMeta = {
  id: string;
  command: string[];
  tmuxSession: string;
  // Who submitted the launch (the forge CLI process — long gone by the time
  // anyone reads this) and who OWNS the work: the tmux pane's process, i.e. the
  // wrapper running the command. The owner pid is what a later session inspects
  // (`ps -p`, `lsof`) or attributes a signal to; null only if tmux could not
  // report it, which is never inferred into a claim about the owner.
  launcherPid: number;
  ownerPid: number | null;
  startedAt: string;
  logPath: string;
  cwd: string;
  // FG-569 (R1): the submitting CLI's own runtime + release identity, captured at
  // submission and persisted here. Optional so a launch record written before
  // FG-569 still loads — its absence surfaces as "not recorded", never inferred.
  control?: ControlRuntime;
};

export type LaunchStatus =
  | { state: "running" }
  | { state: "exited_ok"; code: 0 }
  | { state: "exited_error"; code: number }
  // Durable WIFSIGNALED evidence: the OS reported the command died on a signal.
  // The SENDER is not recorded (no SA_SIGINFO here), so attribution stays open.
  | { state: "signaled"; signal: string; sender: "unrecorded" }
  // A signal-range exit code with NO signal evidence — could equally be a
  // command that deliberately returned 143. Terminal, but origin undeterminable.
  | { state: "terminated_unattributed"; code: number }
  // The OWNER (the tmux pane's wrapper process) is gone without its last-act
  // exit record: live session, dead pane, no exit file. Durable evidence that
  // the wrapper never completed — but deliberately an INDETERMINATE claim:
  // the wrapper may have been killed (the FG-535 launcher/parent-termination
  // case) OR exited on an unhandled I/O failure writing its record. Cause and
  // sender are both unrecorded, so neither is ever asserted.
  | { state: "owner_gone"; cause: "unrecorded"; sender: "unrecorded" }
  // No exit record and no live session — the owner itself is gone without
  // evidence (host reboot, tmux server killed). Never guessed further.
  | { state: "unknown" };

/** What the wrapper writes to the exit file. `signal` is the kernel's verdict,
 *  not an inference from `code`; exactly one of the two is set. */
export type ExitRecord = { code: number | null; signal: string | null };

// FG-569 (R2): the exit recorder (this launch's OWN launch-time process) is a
// distinct runtime from the forge CLI (R1) that submitted the launch — it can
// run under a different interpreter (buildWrapperCommand takes a `node`). So its
// execPath/ABI are captured from INSIDE the recorder (process.execPath /
// process.versions.modules), NEVER copied from the CLI's values. releaseId is
// the TRUSTED, manifest-derived id baked into the recorder wrapper — never the
// recorder's ambient FORGE_RELEASE_ID, which a caller could forge.
export type RecorderRuntime = {
  execPath: string;
  abi: string;
  nodeVersion: string;
  releaseId: string | null;
};

export type LaunchView = LaunchMeta & {
  status: LaunchStatus;
  forgeIds: { runIds: string[]; taskIds: string[] };
  // R2 provenance, present once the recorder has written it (its first act).
  recorder?: RecorderRuntime;
};

export function classifyExit(rec: ExitRecord): LaunchStatus {
  if (rec.signal) return { state: "signaled", signal: rec.signal, sender: "unrecorded" };
  if (rec.code === null) return { state: "unknown" };
  if (rec.code === 0) return { state: "exited_ok", code: 0 };
  if (rec.code > 128 && rec.code < 165) return { state: "terminated_unattributed", code: rec.code };
  return { state: "exited_error", code: rec.code };
}

/** Tolerate an exit file written by an older wrapper (a bare number, no signal
 *  evidence) — a signal-range code from that shape can only be unattributed. */
export function parseExitRecord(raw: string): ExitRecord | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^-?\d+$/.test(text)) return { code: Number(text), signal: null };
  try {
    const parsed = JSON.parse(text) as Partial<ExitRecord>;
    const code = typeof parsed.code === "number" ? parsed.code : null;
    const signal = typeof parsed.signal === "string" ? parsed.signal : null;
    return { code, signal };
  } catch {
    return undefined;
  }
}

/** POSIX single-quote escaping: safe to embed in a sh -c '<...>' string. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// FG-569 (R2): the TRUSTED release id — derived from the running forge's OWN
// release manifest (the forge-release.json that ships INSIDE a built release),
// found by walking up from THIS module's location. NEVER read from process.env:
// a dev caller can set FORGE_RELEASE_ID to any value, so the ambient env cannot
// distinguish a genuine release entry from a poisoned dev launch. Non-null IFF
// forge is genuinely running from a release, and equal to that release's
// manifest id; a dev launch is ALWAYS null regardless of any caller-supplied
// FORGE_RELEASE_ID.
function trustedReleaseId(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return readReleaseManifest(here)?.manifest.id ?? null;
}

// FG-569 (R1): capture the SUBMITTING forge CLI's OWN runtime — its execPath,
// ABI, and node version are read from THIS process (the CLI), never from the
// recorder (R2). The release identity comes from the CLI's OWN release manifest,
// walked up from this module's location — the SAME trusted source as
// trustedReleaseId, so a dev CLI (bin/forge, no manifest) is an explicit `dev`
// marker with releaseId null rather than a manufactured or omitted identity.
function collectControlRuntime(): ControlRuntime {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = readReleaseManifest(here);
  const release: ControlRelease = found
    ? { kind: "release", releaseId: found.manifest.id, commit: found.manifest.commit, path: found.releaseDir }
    : { kind: "dev", releaseId: null };
  return {
    execPath: process.execPath,
    abi: process.versions.modules,
    nodeVersion: process.version,
    release,
  };
}

// A shell wrapper could only ever report `$?`, which folds "killed by SIGTERM"
// and "deliberately returned 143" into the same 143 — the exact inference
// FG-535's AC forbids. This node runner asks the OS instead: spawnSync reports
// `signal` (WIFSIGNALED) separately from `status`, so the two cases stay
// distinguishable in the durable record forever.
// FG-569 (R2): the recorder's FIRST act is to write its OWN runtime — evaluated
// here, inside the recorder process — to `rt`. execPath/ABI are the recorder's,
// so a recorder running under a different interpreter than the CLI records a
// different value; nothing is ever copied in from the launching CLI. The
// releaseId is BAKED IN by buildWrapperCommand as a JSON literal (below), NOT
// read from process.env — a poisoned FORGE_RELEASE_ID in the ambient environment
// therefore has ZERO effect on the recorded provenance.
function exitRecorderScript(releaseIdLiteral: string): string {
  return [
    `const{spawnSync}=require("child_process"),fs=require("fs");`,
    `const[e,l,rt,...a]=process.argv.slice(1);`,
    `fs.writeFileSync(rt,JSON.stringify({execPath:process.execPath,abi:process.versions.modules,nodeVersion:process.version,releaseId:${releaseIdLiteral}}));`,
    `const fd=fs.openSync(l,"a");`,
    `const r=spawnSync(a[0],a.slice(1),{stdio:["ignore",fd,fd]});`,
    `if(r.error)fs.writeSync(fd,String(r.error.message)+"\\n");`,
    `fs.writeFileSync(e,JSON.stringify({code:r.error?127:r.status,signal:r.signal??null}));`,
  ].join("");
}

/** The command the tmux pane runs: the recorder writes its own R2 runtime, then
 *  runs the target with stdout+stderr to the log, then writes the terminal exit
 *  record. The exit write is the LAST act, so an exit file existing is proof the
 *  command itself finished (not the wrapper being torn down).
 *
 *  FG-569 (R2): `releaseId` is the TRUSTED, manifest-derived id (or null). It is
 *  string-interpolated into the recorder script as a JSON literal, so the recorded
 *  release identity has NO ambient-env dependency. */
export function buildWrapperCommand(argv: string[], logPath: string, exitPath: string, runtimePath: string, node = process.execPath, releaseId: string | null = null): string {
  const script = exitRecorderScript(JSON.stringify(releaseId));
  const parts = [node, "-e", script, exitPath, logPath, runtimePath, ...argv];
  return parts.map(shellQuote).join(" ");
}

/** Parse the R2 runtime record the recorder wrote. Returns undefined if absent
 *  or malformed — R2 is never guessed. */
export function parseRecorderRuntime(raw: string): RecorderRuntime | undefined {
  try {
    const p = JSON.parse(raw) as Partial<RecorderRuntime>;
    if (typeof p.execPath !== "string" || typeof p.abi !== "string" || typeof p.nodeVersion !== "string") return undefined;
    return { execPath: p.execPath, abi: p.abi, nodeVersion: p.nodeVersion, releaseId: typeof p.releaseId === "string" ? p.releaseId : null };
  } catch {
    return undefined;
  }
}

/** Forge run/task ids, opportunistically, from whatever the command logged. */
export function extractForgeIds(log: string): { runIds: string[]; taskIds: string[] } {
  const uniq = (re: RegExp): string[] => [...new Set(log.match(re) ?? [])];
  return {
    runIds: uniq(/\brun-[a-z0-9][a-z0-9-]*/g),
    taskIds: uniq(/\btask-[a-z0-9][a-z0-9-]*/g),
  };
}

function launchDir(id: string): string {
  // Every path under LAUNCHES_DIR is derived here; ids come from operator
  // input (show/rm) as well as startLaunch, so the traversal guard lives at
  // the single chokepoint rather than per caller.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error(`forge launch: invalid launch id '${id}'`);
  return join(LAUNCHES_DIR, id);
}

function slugOf(argv: string[]): string {
  return argv.slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cmd";
}

export type TmuxRunner = (args: string[]) => string | void;

export function defaultTmux(args: string[]): string {
  return execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

/** The pid of the tmux pane's process — the wrapper that owns the command, and
 *  the only process identity worth persisting for later attribution. */
function ownerPidOf(session: string, tmux: TmuxRunner): number | null {
  let out: string | void;
  try {
    out = tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_pid}"]);
  } catch {
    return null;
  }
  const pid = Number(String(out ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function tmuxSessionAlive(session: string, tmux: TmuxRunner): boolean {
  try {
    tmux(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

/** Whether the session's pane is DEAD (remain-on-exit retained it after its
 *  process ended). With remain-on-exit on, `has-session` alone proves nothing
 *  about the wrapper: a killed wrapper leaves a live session holding a dead
 *  pane. Returns null when tmux can't answer — never guessed. */
function paneDead(session: string, tmux: TmuxRunner): boolean | null {
  try {
    const out = tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_dead}"]);
    const v = String(out ?? "").trim();
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

/** Start a command under a durable tmux owner. Returns the persisted record.
 *  Throws (before anything is written) if tmux is unavailable. */
export function startLaunch(argv: string[], opts: { name?: string; cwd?: string; tmux?: TmuxRunner; now?: Date } = {}): LaunchMeta {
  if (argv.length === 0) throw new Error("forge launch run: no command given");
  const tmux = opts.tmux ?? defaultTmux;
  try {
    tmux(["-V"]);
  } catch {
    throw new Error("forge launch requires tmux — install it (brew install tmux / apt install tmux) and retry");
  }

  const now = opts.now ?? new Date();
  const rand = Math.random().toString(36).slice(2, 8);
  // The name becomes a directory segment under LAUNCHES_DIR and a tmux session
  // name — slugify it through the SAME charset as the auto-derived slug so a
  // crafted --name (path separators, "..") can never escape the launches dir.
  const name = opts.name === undefined ? slugOf(argv) : slugOf([opts.name]);
  const id = `launch-${name}-${rand}`;
  const session = `forge-${id}`;
  const dir = launchDir(id);
  mkdirSync(dir, { recursive: true });

  const meta: LaunchMeta = {
    id,
    command: argv,
    tmuxSession: session,
    launcherPid: process.pid,
    ownerPid: null,
    startedAt: now.toISOString(),
    logPath: join(dir, "out.log"),
    cwd: opts.cwd ?? process.cwd(),
    // FG-569 (R1): captured here, in the submitting CLI, INDEPENDENTLY of the
    // recorder (R2) — the CLI is gone by the time anyone inspects this launch.
    control: collectControlRuntime(),
  };
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const wrapped = buildWrapperCommand(argv, meta.logPath, join(dir, "exit"), join(dir, "runtime.json"), process.execPath, trustedReleaseId());
  try {
    // Order matters. Starting the target command AS the session command races
    // it against `set-option`: a command that finishes first destroys the
    // session (remain-on-exit is not on yet), set-option then fails, and the
    // catch below would delete the record of a command that actually RAN.
    // So the session is born holding an inert pane (`cat` blocks on the tty and
    // never exits on its own), remain-on-exit is set while nothing can race it,
    // and only then does respawn-pane hand the pane to the real command.
    //
    // FG-569 (R2): the release identity is NOT forwarded through the tmux session
    // env. It is derived from forge's OWN release manifest (trustedReleaseId) and
    // baked into the recorder wrapper as a JSON literal, so the recorded id cannot
    // be forged by a caller-supplied FORGE_RELEASE_ID and does not depend on tmux
    // propagating any client env var into the session.
    tmux(["new-session", "-d", "-s", session, "-c", meta.cwd, "cat"]);
    tmux(["set-option", "-w", "-t", `${session}:`, "remain-on-exit", "on"]);
    tmux(["respawn-pane", "-k", "-t", `${session}:`, wrapped]);
  } catch (e) {
    // new-session may already have succeeded (set-option or respawn-pane is
    // what failed). Deleting the record alone would strand that session — an
    // untracked pane no `forge launch` command can see or remove. Kill it
    // first, so the failed start leaves nothing behind either way.
    if (tmuxSessionAlive(session, tmux)) {
      try { tmux(["kill-session", "-t", session]); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`forge launch: tmux failed to start the session — ${(e as Error).message}`);
  }

  // Only knowable once the pane holds the real command, so the record is
  // rewritten rather than written once — an owner pid queried before
  // respawn-pane would name the inert bootstrap pane instead.
  meta.ownerPid = ownerPidOf(session, tmux);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

export function readLaunch(id: string, tmux: TmuxRunner = defaultTmux): LaunchView | undefined {
  const dir = launchDir(id);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return undefined;
  let meta: LaunchMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as LaunchMeta;
  } catch {
    return undefined;
  }

  let status: LaunchStatus;
  const exitPath = join(dir, "exit");
  if (existsSync(exitPath)) {
    const rec = parseExitRecord(readFileSync(exitPath, "utf8"));
    status = rec ? classifyExit(rec) : { state: "unknown" };
  } else if (!tmuxSessionAlive(meta.tmuxSession, tmux)) {
    status = { state: "unknown" };
  } else {
    // The session is alive, but with remain-on-exit that is not proof the
    // wrapper is: a wrapper killed before its last-act exit write leaves a
    // live session holding a DEAD pane and no exit record. That combination
    // is the durable evidence for "the owner was terminated" (the wrapper
    // writes the exit record even for a signaled child — only the wrapper
    // itself dying can produce a dead pane with no record). A pane tmux can't
    // classify stays running (fail-safe: rm keeps refusing without --force).
    const dead = paneDead(meta.tmuxSession, tmux);
    status = dead === true ? { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } : { state: "running" };
  }

  let log = "";
  try {
    log = readFileSync(meta.logPath, "utf8");
  } catch { /* not written yet */ }

  let recorder: RecorderRuntime | undefined;
  const rtPath = join(dir, "runtime.json");
  if (existsSync(rtPath)) {
    try { recorder = parseRecorderRuntime(readFileSync(rtPath, "utf8")); } catch { /* not readable yet */ }
  }

  return { ...meta, status, forgeIds: extractForgeIds(log), ...(recorder ? { recorder } : {}) };
}

export function listLaunches(tmux: TmuxRunner = defaultTmux): LaunchView[] {
  if (!existsSync(LAUNCHES_DIR)) return [];
  const out: LaunchView[] = [];
  for (const entry of readdirSync(LAUNCHES_DIR)) {
    // Stray entries (.DS_Store, editor droppings) fail the id guard — skip them.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(entry)) continue;
    const v = readLaunch(entry, tmux);
    if (v) out.push(v);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Remove a finished launch's record and its tmux remains. Refuses a running
 *  launch unless forced — removal must never be the thing that kills work. */
export function removeLaunch(id: string, opts: { force?: boolean; tmux?: TmuxRunner } = {}): void {
  const tmux = opts.tmux ?? defaultTmux;
  const view = readLaunch(id, tmux);
  if (!view) throw new Error(`forge launch: no such launch '${id}'`);
  if (view.status.state === "running" && !opts.force) {
    throw new Error(`forge launch: '${id}' is still running (tmux session ${view.tmuxSession}) — pass --force to kill and remove it`);
  }
  if (tmuxSessionAlive(view.tmuxSession, tmux)) {
    try { tmux(["kill-session", "-t", view.tmuxSession]); } catch { /* already gone */ }
  }
  rmSync(launchDir(id), { recursive: true, force: true });
}
