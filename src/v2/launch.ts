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
//   meta.json  — command argv, tmux session name, start time, log path
//   out.log    — combined stdout+stderr of the command
//   exit       — the command's numeric exit code, written by the wrapper the
//                moment the command finishes (rc > 128 ⇒ terminated by signal
//                rc-128, the durable evidence for "externally terminated")
//
// Status is DERIVED at read time, never stored: exit file ⇒ finished (ok /
// error / externally_terminated); no exit file + live tmux session ⇒ running;
// no exit file + no session ⇒ unknown (e.g. host reboot took the tmux server —
// attribution is preserved as unknown rather than guessed, per FG-535's AC).
//
// The tmux server is the OWNER; this module never keeps a process attached.
// Forge run/task ids are extracted from the log opportunistically ("when
// available") — the command may not be a forge command at all.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_HOME } from "../util/paths.js";

export const LAUNCHES_DIR = join(FORGE_HOME, "launches");

export type LaunchMeta = {
  id: string;
  command: string[];
  tmuxSession: string;
  startedAt: string;
  logPath: string;
  cwd: string;
};

export type LaunchStatus =
  | { state: "running" }
  | { state: "exited_ok"; code: 0 }
  | { state: "exited_error"; code: number }
  // The durable-evidence classification FG-535 asks for: the command was
  // terminated by a signal (rc > 128). The signal name is derived, the raw
  // code kept as the primary record.
  | { state: "externally_terminated"; code: number; signal: string }
  // No exit record and no live session — the owner itself is gone without
  // evidence (host reboot, tmux server killed). Never guessed further.
  | { state: "unknown" };

export type LaunchView = LaunchMeta & {
  status: LaunchStatus;
  forgeIds: { runIds: string[]; taskIds: string[] };
};

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
};

export function classifyExitCode(code: number): LaunchStatus {
  if (code === 0) return { state: "exited_ok", code: 0 };
  if (code > 128 && code < 165) {
    const sig = code - 128;
    return { state: "externally_terminated", code, signal: SIGNAL_NAMES[sig] ?? `signal ${sig}` };
  }
  return { state: "exited_error", code };
}

/** POSIX single-quote escaping: safe to embed in a sh -c '<...>' string. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The command the tmux session runs: the target command with stdout+stderr
 *  redirected to the log, then its exit code written to the exit file. The
 *  exit write is the LAST thing the wrapper does, so an exit file existing is
 *  proof the command itself finished (not the wrapper being torn down). */
export function buildWrapperCommand(argv: string[], logPath: string, exitPath: string): string {
  const cmd = argv.map(shellQuote).join(" ");
  return `${cmd} > ${shellQuote(logPath)} 2>&1; echo $? > ${shellQuote(exitPath)}`;
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
  return join(LAUNCHES_DIR, id);
}

function slugOf(argv: string[]): string {
  return argv.slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cmd";
}

export type TmuxRunner = (args: string[]) => void;

export function defaultTmux(args: string[]): void {
  execFileSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function tmuxSessionAlive(session: string, tmux: TmuxRunner): boolean {
  try {
    tmux(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
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
  const id = `launch-${opts.name ?? slugOf(argv)}-${rand}`;
  const session = `forge-${id}`;
  const dir = launchDir(id);
  mkdirSync(dir, { recursive: true });

  const meta: LaunchMeta = {
    id,
    command: argv,
    tmuxSession: session,
    startedAt: now.toISOString(),
    logPath: join(dir, "out.log"),
    cwd: opts.cwd ?? process.cwd(),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  const wrapped = buildWrapperCommand(argv, meta.logPath, join(dir, "exit"));
  try {
    tmux(["new-session", "-d", "-s", session, "-c", meta.cwd, wrapped]);
    // remain-on-exit keeps the (dead) pane inspectable via tmux until the
    // operator removes the launch — the exit file is the durable record, this
    // is the debugging convenience on top.
    tmux(["set-option", "-t", session, "remain-on-exit", "on"]);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`forge launch: tmux failed to start the session — ${(e as Error).message}`);
  }
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
    const raw = readFileSync(exitPath, "utf8").trim();
    const code = Number(raw);
    status = Number.isInteger(code) ? classifyExitCode(code) : { state: "unknown" };
  } else {
    status = tmuxSessionAlive(meta.tmuxSession, tmux) ? { state: "running" } : { state: "unknown" };
  }

  let log = "";
  try {
    log = readFileSync(meta.logPath, "utf8");
  } catch { /* not written yet */ }

  return { ...meta, status, forgeIds: extractForgeIds(log) };
}

export function listLaunches(tmux: TmuxRunner = defaultTmux): LaunchView[] {
  if (!existsSync(LAUNCHES_DIR)) return [];
  const out: LaunchView[] = [];
  for (const entry of readdirSync(LAUNCHES_DIR)) {
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
