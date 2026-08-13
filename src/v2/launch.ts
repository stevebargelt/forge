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
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_HOME } from "../util/paths.js";
import { checkAbi } from "../cli/node-abi.js";
import { readReleaseManifest } from "./release.js";

// FG-679: THE DURABLE OBSERVATION IS DELIBERATELY NOT WRITTEN FROM THIS MODULE.
//
// FG-552 (F33) makes this module's transitive import graph load-bearing: `forge
// launch wait` is dispatched before the command registry precisely so the observer
// still observes and reports when better-sqlite3 cannot load under the running
// interpreter, and src/cli/commands/launch-wait.ts states the rule outright — "do
// not add an import that reaches the store". A static store import here reddens
// that suite, and rightly: it would make the ONE command whose job is to report a
// terminal disposition fail on a broken native binding.
//
// So the observation write and the opportunistic promoter live in
// src/store/launch-observations.ts, which imports FROM this module (LAUNCHES_DIR,
// isLaunchId, parseExitRecord, classifyExit) rather than the other way round. Both
// submission sites — `forge launch run` (src/cli/commands/launch.ts) and the
// campaign drive-item launcher — already load the registry, so coverage is
// identical and the fast path stays native-free.

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

// FG-614: the LAUNCHER's own condition, probed at submission — the long-lived tmux
// server's working directory. The server outlives every session, so once that
// directory is deleted (a test fixture leaked into it, a removed worktree) every
// session it forks starts in a dead directory and any process that reads its cwd at
// startup — node does, at bootstrap — dies before executing a line. `missing` is
// asserted ONLY on positive evidence (a path was resolved AND it does not exist);
// anything we could not read is `unprobed` with the reason, never guessed into a
// claim about the operator's tmux server. `sessions`/`livePanes` are the COST of the
// remedy (`tmux kill-server`), counted only when the condition is real.
export type TmuxServerCwd =
  | { state: "ok"; path: string }
  | { state: "missing"; path: string; sessions?: number; livePanes?: number }
  | { state: "no_server" }
  | { state: "unprobed"; reason: string };

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
  // FG-552: set only on the FIRST (pre-tmux) publish and cleared on the republish
  // once respawn-pane has established ownership. While true the tmux session may not
  // exist yet, so its absence is startup-in-progress — NOT owner loss — AS LONG AS the
  // SUBMITTING launcher (launcherPid) is still alive: then the classifier reads
  // `running`, never a terminal `unknown`. But `starting` is BOUNDED to that
  // independently-observable launcher liveness — if the launcher DIED mid-startup and
  // no live session / exit record exists, the record is reconciled to a terminal
  // disposition rather than reported `running` forever. See startLaunch / readLaunch.
  starting?: boolean;
  // FG-614: the tmux server's own working directory as probed AT SUBMISSION. Recorded
  // so a later reader can name the LAUNCHER's condition instead of blaming the child;
  // optional so a record written before FG-614 still loads.
  tmuxServerCwd?: TmuxServerCwd;
  // FG-626: the per-invocation FORGE_-prefixed environment forwarded into the launched
  // workload, and any FORGE_ var deliberately dropped (with the reason). Recorded so an
  // operator can audit what env-gated behavior the workload actually ran under, and so a
  // drop is warnable by name. Ordinary env-gate values (FORGE_WORKTREES,
  // FORGE_CI_POLL_SECONDS, …) are recorded because the audit needs to distinguish =1 from
  // =0 and 30 from 3000. RF-3: a FORGE_ NAME can carry credential material anyway
  // (FORGE_AWS_CREDS_FOR_TEST, FORGE_CREDS_REFRESH, an injected FORGE_TOKEN), so a
  // credential-bearing value is REDACTED at the point of recording — the NAME is still
  // recorded (the gate is shown armed) but its value never lands in this world-readable
  // record. The workload still receives the real value; redaction is audit-surface only.
  // Optional so a record written before FG-626 still loads.
  forwardedEnv?: ForgeEnvForwarding;
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

// FG-555 (R3/R4): the LAUNCHED WORKLOAD's execution environment — the OTHER side
// of the launch boundary from R1/R2 (forge's own two runtimes). `forge launch run`
// is an argv launcher: the recorder wraps the submitted argv and spawns argv[0]
// DIRECTLY (see exitRecorderScript's spawnSync(a0, …)); it NEVER synthesizes a
// shell. A caller may still intentionally supply one. So argv is a *string* and
// these two records are its honest resolution:
//
//   R3 — the launched top-level executable (argv[0]) resolved to a real path,
//        AS RESOLVED AT SPAWN TIME. captured = argv[0] was already a path;
//        derived = a bare name resolved on PATH; unresolved = not found (recorded
//        as fact, never guessed). Resolved INSIDE the recorder, in the environment
//        the command actually ran under — tmux interposes its own shell env, so
//        resolving argv[0] in the submitting CLI would give a plausible-but-wrong
//        answer (fg553-slice1-architecture.md C2).
//   R4 — whether a DIFFERENT Node than R3's argv[0] gets resolved at runtime, by a
//        shell (bash -lc <chain>), a script's shebang (`./x.sh`, `bash ./x.sh`), or a
//        Node-shebang launcher (`npm`, `npx`, `forge`, `vitest`, `tsx`, …). That
//        resolution happens at runtime, against whatever PATH `exec` builds AFTER the
//        recorder spawned argv[0] — Forge cannot know it, so R4 DEFAULTS to UNKNOWABLE.
//        It is `not_applicable` ONLY when the effective argv[0] is a TERMINAL Node
//        interpreter (basename node/nodejs): then the interpreter IS argv[0] and R3
//        fully captures the runtime. We do NOT enumerate launchers (that space is
//        unbounded); R4 is NEVER implied to be covered by argv.
export type WorkloadTopLevel =
  | { kind: "captured"; argv0: string; execPath: string }
  | { kind: "derived"; argv0: string; execPath: string }
  | { kind: "unresolved"; argv0: string };

export type WorkloadNestedShell =
  | { kind: "not_applicable"; reason: string }
  | { kind: "unknowable"; shell: string; reason: string };

// FG-555: the EFFECTIVE Node interpreter the workload actually ran under — the
// effective argv[0] (after skipping env/exec-prefixes), PROBED for its ABI/version
// at spawn time. Present only when that effective argv[0] is a Node interpreter
// (basename node/nodejs) that could be probed — including behind an `env` prefix
// (`env FOO=bar node …`), where the top-level executable is `env` but the runtime is
// the node behind it; absent otherwise (a non-node workload's runtime is the same
// unknowable class as R4 — never guessed). This is what lets `forge launch show`
// diagnose whether a direct `node` workload actually used the compatible toolchain.
export type WorkloadInterpreter = { execPath: string; abi: string; nodeVersion: string };

// FG-555: R3/R4 plus the launched workload's RUNTIME provenance:
//   profile     — the launch-environment contract that was pinned for this
//                 workload (pinned PATH + required ABI). Absent when the launch
//                 inherited the ambient env (no --require-control-toolchain).
//   interpreter — the effective Node interpreter runtime (see WorkloadInterpreter).
export type WorkloadProvenance = {
  r3: WorkloadTopLevel;
  r4: WorkloadNestedShell;
  profile?: LaunchProfile;
  interpreter?: WorkloadInterpreter;
};

export type LaunchView = LaunchMeta & {
  status: LaunchStatus;
  forgeIds: { runIds: string[]; taskIds: string[] };
  // R2 provenance, present once the recorder has written it (its first act).
  recorder?: RecorderRuntime;
  // FG-555: R3/R4 provenance, written by the recorder at spawn time. Absent for a
  // launch that predates FG-555 — surfaced as "not recorded", never inferred.
  workload?: WorkloadProvenance;
  // FG-552 (BD-7): set ONLY when `status` is `running` BECAUSE a PRESENT exit
  // record is unreadable/invalid THIS read (not because the command genuinely
  // runs — a genuinely-running launch has NO exit file yet). `status` still reads
  // `running` so every SINGLE read remains an invitation to bounded retry (F11);
  // this field surfaces the reconciled disposition a BOUNDED waiter wakes on if the
  // record never becomes readable. A present-but-unreadable record is bounded-retry,
  // never terminal on a single read: this field is set ONLY when there is INDEPENDENT
  // TERMINAL OWNER evidence — no session -> unknown, dead pane -> owner_gone (PRD:
  // "only terminal after independent terminal owner evidence"). A CONFIRMED-LIVE owner
  // is NOT terminal evidence, so it leaves this UNSET: the launch stays `running`,
  // bounded ONLY by the waiter's own --timeout (-> wait_timeout, never a fabricated
  // launch terminal). If the owner LATER dies, reconcile arms the bound then. Never a
  // second status vocabulary: `terminal` is drawn from the existing LaunchStatus set (BD-10).
  pendingUnreadableExit?: { terminal: LaunchStatus };
  // FG-614: a FORGE-authored explanation of why this launch failed, written by the
  // launcher itself (the cwd guard) rather than captured from the child. Present only
  // when forge has something to say that the child's stderr cannot: `forge launch show`
  // renders it above the log tail so the cause is named, not inferred from a trace.
  diagnosis?: string;
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
  if (/^-?\d+$/.test(text)) {
    // FG-552: a digit string that overflows precision (Number(text) is Infinity or
    // a rounded-away-from-integer value) is corrupt, not authoritative terminal
    // evidence — treat it as unreadable and fall through to bounded owner-evidence
    // retry, exactly like the schema-invalid JSON shapes below, rather than
    // promoting Infinity/precision-lost bytes to exited_error.
    const code = Number(text);
    if (!Number.isSafeInteger(code)) return undefined;
    return { code, signal: null };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ExitRecord>;
    const hasCode = typeof parsed.code === "number" && Number.isSafeInteger(parsed.code);
    const hasSignal = typeof parsed.signal === "string" && parsed.signal !== "";
    // FG-552 (BD-7/F11): the ExitRecord contract is "exactly one of code|signal is
    // set" — an INTEGER numeric code XOR a non-empty string signal. The wrapper
    // ALWAYS writes exactly one. Any other shape is SCHEMA-INVALID, not authoritative
    // terminal evidence: BOTH set (`{"code":0,"signal":"SIGTERM"}`) is contradictory;
    // NEITHER (`{}`, `{"code":"bad"}`, `{"code":null,"signal":null}`) is empty/torn;
    // an empty-string signal (`{"signal":""}`) or a non-integer code is not evidence.
    // Accepting any of these would classify a controller-advancing terminal on corrupt
    // bytes. Instead return undefined so it is treated as an unreadable/not-yet-terminal
    // record and falls through to bounded owner-evidence retry, exactly like an
    // empty/half-written file. `hasCode === hasSignal` is true iff NOT exactly one holds.
    if (hasCode === hasSignal) return undefined;
    return { code: hasCode ? (parsed.code as number) : null, signal: hasSignal ? (parsed.signal as string) : null };
  } catch {
    return undefined;
  }
}

/** POSIX single-quote escaping: safe to embed in a sh -c '<...>' string. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// FG-626: a per-invocation FORGE_-prefixed variable forwarded into the launched
// workload's environment, or one deliberately NOT forwarded (with the reason it
// was dropped). Recorded on the launch so an operator can audit after the fact
// exactly what env-gated behavior the workload actually ran under, and so a drop
// can be WARNED about by name — never silently lost.
export type ForwardedEnvVar = { name: string; value: string; redacted?: boolean };
export type DroppedEnvVar = { name: string; reason: string };
export type ForgeEnvForwarding = { forwarded: ForwardedEnvVar[]; dropped: DroppedEnvVar[] };

// RF-3: the marker a credential-bearing forwarded value is replaced with in the durable
// launch record and in `forge launch show`. It is not a value a caller could set (the
// workload still gets the real value), so it is unambiguously "redacted", not literal.
export const REDACTED_ENV_VALUE = "«redacted»";

// RF-3: name segments that mark a FORGE_ variable as carrying secret material. Redaction
// is a property of the NAME, decided here, NOT a scan of the value — an ordinary gate
// (FORGE_WORKTREES, FORGE_CI_POLL_SECONDS) keeps its recorded value, while a credential
// name (FORGE_AWS_CREDS_FOR_TEST, FORGE_CREDS_REFRESH, an injected FORGE_TOKEN) does not.
// Segments are deliberately specific (ACCESS_KEY/API_KEY, not a bare KEY) so a benign gate
// is never redacted into uselessness.
const SECRET_ENV_NAME_SEGMENTS: readonly string[] = [
  "CRED", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PASSPHRASE",
  "PRIVATE_KEY", "ACCESS_KEY", "API_KEY", "APIKEY",
];

/** RF-3: does this variable NAME mark it as credential-bearing? A name-based property,
 *  applied at the point of recording — never a scan of the value. */
export function isSecretForgeEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV_NAME_SEGMENTS.some((seg) => upper.includes(seg));
}

/** RF-3: the launch-record view of a forwarding plan — every forwarded NAME preserved,
 *  but a credential-bearing value replaced with the redaction marker so it never lands in
 *  meta.json or in `forge launch show`. PURE; does NOT alter what the workload receives
 *  (that path reads the un-redacted plan). Dropped entries are audit reasons, not values,
 *  and pass through unchanged. */
export function redactForwardedEnvForRecord(forwarding: ForgeEnvForwarding): ForgeEnvForwarding {
  return {
    forwarded: forwarding.forwarded.map((v) =>
      isSecretForgeEnvName(v.name) ? { name: v.name, value: REDACTED_ENV_VALUE, redacted: true } : v,
    ),
    dropped: forwarding.dropped,
  };
}

// FG-626: FORGE_-prefixed variables that must NEVER be forwarded from the caller's
// per-invocation env into the launched workload, each mapped to the reason so the
// operator can be told by name. A drop here is a WARN, not a silent loss.
const FORWARD_EXCLUDED: ReadonlyMap<string, string> = new Map([
  // FG-569 (R2): the release identity is derived from forge's OWN release manifest
  // (trustedReleaseId), NEVER read from ambient or forwarded env — a caller can set
  // FORGE_RELEASE_ID to any value, so it cannot distinguish a genuine release from a
  // poisoned dev launch. Forwarding it into the workload would reopen exactly the
  // channel FG-569 closed, so it is dropped and the operator is told it was.
  ["FORGE_RELEASE_ID", "the release identity is derived from forge's own release manifest (FG-569), never forwarded from caller env"],
]);

/** FG-626: decide which per-invocation FORGE_-prefixed variables are forwarded into a
 *  launched workload and which are dropped (with a reason). PURE — reads only the env
 *  it is handed. Only FORGE_-prefixed names are considered at all: PATH, TMUX,
 *  TMUX_TMPDIR and auth vars are not FORGE_-prefixed and so are never swept along
 *  (constraint 3 — whole-env forwarding is a strictly larger blast radius than this
 *  needs). A name in FORWARD_EXCLUDED, or a value that cannot survive the tmux session
 *  environment intact (a newline — `new-session -e` carries one VAR=VALUE argv element),
 *  is DROPPED rather than forwarded — so it is warned about, never silently lost. */
export function planForgeEnvForwarding(env: NodeJS.ProcessEnv): ForgeEnvForwarding {
  const forwarded: ForwardedEnvVar[] = [];
  const dropped: DroppedEnvVar[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("FORGE_")) continue;
    const value = env[name];
    if (value === undefined) continue;
    const excludedReason = FORWARD_EXCLUDED.get(name);
    if (excludedReason !== undefined) {
      dropped.push({ name, reason: excludedReason });
      continue;
    }
    if (value.includes("\n")) {
      dropped.push({ name, reason: "the value contains a newline, which cannot be carried through the tmux session environment intact" });
      continue;
    }
    forwarded.push({ name, value });
  }
  return { forwarded, dropped };
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
function exitRecorderScript(releaseIdLiteral: string, profileLiteral: string): string {
  return [
    `const{spawnSync}=require("child_process"),fs=require("fs"),pth=require("path");`,
    `const[e,l,rt,...a]=process.argv.slice(1);`,
    `fs.writeFileSync(rt,JSON.stringify({execPath:process.execPath,abi:process.versions.modules,nodeVersion:process.version,releaseId:${releaseIdLiteral}}));`,
    // FG-555 (R3/R4): resolve argv[0] and classify a nested shell HERE, in the
    // recorder — the environment the command actually runs under (mirrors the pure
    // deriveWorkloadProvenance; kept in lockstep with it). Written BEFORE spawn so
    // R3 is recorded even if the spawn itself fails.
    `const a0=a[0]||"";let r3;`,
    `if(a0.indexOf("/")>=0){r3={kind:"captured",argv0:a0,execPath:a0};}`,
    // An EMPTY PATH component denotes the launch cwd (execvp semantics); spawnSync
    // honors it, so the recorded effective executable must too — never skip it.
    `else{let f;for(const d of (process.env.PATH||"").split(":")){const c=pth.join(d||process.cwd(),a0);try{fs.accessSync(c,fs.constants.X_OK);f=c;break;}catch(_){}}r3=f?{kind:"derived",argv0:a0,execPath:f}:{kind:"unresolved",argv0:a0};}`,
    // R4 on the EFFECTIVE command: skip recognized exec-prefixes (env/nice/…) and the
    // NAME=VALUE assignments an `env` prefix applies — but NOT a bare leading VAR=VAL
    // (argv[0] itself), which a direct spawn runs literally (ENOENT). Kept in lockstep
    // with effectiveCommand/deriveWorkloadProvenance so `env … bash -lc …` records
    // unknowable, never a false not_applicable.
    `const PFX={env:1,nice:1,nohup:1,time:1,stdbuf:1,setsid:1,timeout:1},ASG=/^[A-Za-z_][A-Za-z0-9_]*=/;`,
    `let ci=0,up=false;`,
    `while(ci<a.length){var pn=pth.basename(a[ci]);if(!PFX[pn])break;ci++;if(pn==="env"){while(ci<a.length){var tk=a[ci];if(tk==="--"){ci++;break;}if(ASG.test(tk)){ci++;continue;}if(tk[0]==="-"){up=true;break;}break;}}else{while(ci<a.length&&a[ci][0]==="-"){var op=a[ci];ci++;if((pn==="nice"&&op==="-n")||(pn==="stdbuf"&&/^-[ioe]$/.test(op))||(pn==="timeout"&&(op==="-s"||op==="-k"))||(pn==="time"&&(op==="-o"||op==="-f"))){if(ci<a.length)ci++;}}if(pn==="timeout"&&ci<a.length)ci++;}}`,
    // R4 INVERTED (mirrors deriveWorkloadProvenance): default unknowable; not_applicable
    // ONLY when the effective argv[0] is a terminal Node interpreter (node/nodejs).
    `const eff=a.slice(ci),sh=pth.basename(eff[0]||"");`,
    `let r4;if(sh==="node"||sh==="nodejs"){r4={kind:"not_applicable",reason:"the effective argv[0] is a terminal Node interpreter (node/nodejs) — it IS the runtime (R3 captures it); nothing resolves a different Node later"};}else{var nst=["sh","bash","dash","zsh","ksh","ash"].indexOf(sh)>=0&&eff.slice(1).some(function(x){return /^-[a-z]*c$/.test(x);});var rsn=nst?"a nested shell resolves node/npm/forge at runtime against whatever PATH it builds — not knowable at launch time (BD-14 R4)":up?"an env/wrapper form the launcher cannot fully parse could still resolve an arbitrary runtime — a hidden shell cannot be ruled out (BD-14 R4)":"the effective argv[0] is not a terminal Node interpreter — a later shebang/PATH resolution (a shell, a script, or a Node-shebang launcher) may select a different Node that is not knowable at launch time (BD-14 R4)";r4={kind:"unknowable",shell:sh||"(none)",reason:rsn};}`,
    // FG-555 (workload runtime): probe the EFFECTIVE interpreter — the effective
    // argv[0] (eff[0], after skipping env/exec-prefixes), when it IS a Node interpreter
    // (basename node/nodejs) — for its ABI/version, so `forge launch show` can diagnose
    // whether the workload actually ran the compatible toolchain. Resolved the SAME way
    // as R3, so a `node` behind `env FOO=bar node …` is probed even though R3 is `env`.
    // Bounded to node/nodejs (a non-node runtime is the same unknowable class as R4);
    // kept in lockstep with deriveWorkloadProvenance's effective-interpreter probe.
    `let itp,eip="";if(sh==="node"||sh==="nodejs"){const e0=eff[0];if(e0.indexOf("/")>=0){eip=e0;}else{for(const d of (process.env.PATH||"").split(":")){const c=pth.join(d||process.cwd(),e0);try{fs.accessSync(c,fs.constants.X_OK);eip=c;break;}catch(_){}}}}`,
    `if(eip){try{const pr=spawnSync(eip,["-p","process.versions.modules+' '+process.version"],{encoding:"utf8"});if(pr.status===0&&pr.stdout){const pp=pr.stdout.trim().split(" ");if(pp.length===2)itp={execPath:eip,abi:pp[0],nodeVersion:pp[1]};}}catch(_){}}`,
    // The pinned launch profile (or null) is baked in as a JSON literal — the SAME
    // trusted, ambient-env-independent channel as releaseId (R2) — so the recorded
    // contract is exactly what startLaunch declared, never re-derived here.
    `fs.writeFileSync(pth.join(pth.dirname(rt),"workload.json"),JSON.stringify({r3:r3,r4:r4,profile:${profileLiteral},interpreter:itp}));`,
    `const fd=fs.openSync(l,"a");`,
    `const r=spawnSync(a0,a.slice(1),{stdio:["ignore",fd,fd]});`,
    `if(r.error)fs.writeSync(fd,String(r.error.message)+"\\n");`,
    // FG-552 (BD-4/F4): commit the terminal exit record ATOMICALLY — write a
    // sibling temp, then rename it into place. rename(2) is atomic on one
    // filesystem, so a consumer never observes partially-written JSON as a
    // terminal result; the file appears complete or not at all.
    `const et=e+".tmp."+process.pid;fs.writeFileSync(et,JSON.stringify({code:r.error?127:r.status,signal:r.signal??null}));fs.renameSync(et,e);`,
  ].join("");
}

/** FG-614: the exit code the cwd guard records when it cannot enter the recorded
 *  working directory. The command never ran, so this is FORGE's disposition, not the
 *  command's — `diagnosis.txt` (written beside it) is what names the cause, and
 *  `forge launch show` renders it. */
export const LAUNCH_CWD_UNAVAILABLE_EXIT = 78;

/** FG-614: the cwd guard's script. A CONSTANT — it takes the four paths it needs as
 *  positional parameters and the recorder argv as the rest, so no caller data is ever
 *  interpolated into it. That is deliberate: the guard has to be shell-quoted into the
 *  single string tmux runs, and interpolating quoted paths would mean quoting a second
 *  time, which turns every recorder token into `'\''`-escaped noise — unreadable in
 *  `forge launch show`, and unparseable to anything reading the pane command.
 *
 *  Node reads its cwd during bootstrap (`uv_cwd`), so a `node -e …` handed a dead
 *  inherited cwd dies before executing a line — a chdir INSIDE the recorder can never
 *  run. `tmux new-session -c <dir>` is not a substitute either: it was verified by hand
 *  during the FG-614 incident not to rescue the condition. So the chdir happens here, in
 *  a shell (which starts fine with a deleted cwd), and only then is the recorder exec'd.
 *  `exec` keeps the pane pid the recorder's, exactly as before this guard existed.
 *
 *  On failure the guard is the LAST writer: it commits a terminal exit record with the
 *  same temp+rename atomicity as the recorder (FG-552 BD-4) and leaves a diagnosis file
 *  naming the cause, so the launch reads as a named forge refusal instead of an owner
 *  that vanished. No single quotes and no backticks appear in the script or its message:
 *  the script travels inside single quotes, so an apostrophe would be escaped to `'\''`
 *  and make the pane command an operator reads in `forge launch show` much harder to
 *  follow; and the message is expanded inside double quotes, where a backtick would be
 *  command substitution. */
const CWD_GUARD_SCRIPT = [
  `d=$1; l=$2; e=$3; g=$4; shift 4;`,
  `cd "$d" 2>/dev/null && exec "$@";`,
  `m="forge launch: the command was NOT started — forge could not enter the working directory it recorded for this launch.`,
  `\\n  recorded cwd: $d`,
  `\\n  cause: chdir into that directory failed. It was removed between submission and start (a temp/fixture directory, a deleted git worktree, an unmounted volume).`,
  `\\n  this is not a fault of the launched command: nothing of it ran.`,
  `\\n  remedy: relaunch from a directory that still exists.`,
  `\\n  if EVERY launch fails this way, the condition is instead that the tmux server itself is stuck in a deleted working directory. Remedy: tmux kill-server — that terminates every existing tmux session and any live process inside them, so check tmux list-sessions first.";`,
  `printf "%b\\n" "$m" >> "$l" 2>/dev/null;`,
  `printf "%b\\n" "$m" > "$g" 2>/dev/null;`,
  `printf %s "{\\"code\\":${LAUNCH_CWD_UNAVAILABLE_EXIT},\\"signal\\":null}" > "$e.tmp.cwd" && mv "$e.tmp.cwd" "$e";`,
  `exit ${LAUNCH_CWD_UNAVAILABLE_EXIT}`,
].join("");

function cwdGuardedCommand(cwd: string, logPath: string, exitPath: string, recorderArgv: string[]): string {
  const diagPath = join(dirname(exitPath), "diagnosis.txt");
  const parts = ["/bin/sh", "-c", CWD_GUARD_SCRIPT, "forge-launch-cwd-guard", cwd, logPath, exitPath, diagPath, ...recorderArgv];
  return parts.map(shellQuote).join(" ");
}

/** The command the tmux pane runs: the recorder writes its own R2 runtime, then
 *  runs the target with stdout+stderr to the log, then writes the terminal exit
 *  record. The exit write is the LAST act, so an exit file existing is proof the
 *  command itself finished (not the wrapper being torn down).
 *
 *  FG-569 (R2): `releaseId` is the TRUSTED, manifest-derived id (or null). It is
 *  string-interpolated into the recorder script as a JSON literal, so the recorded
 *  release identity has NO ambient-env dependency.
 *
 *  FG-614: `cwd`, when given, wraps the recorder in the cwd guard above so the launch
 *  starts in the directory forge RECORDED rather than whatever it inherited. */
export function buildWrapperCommand(argv: string[], logPath: string, exitPath: string, runtimePath: string, node = process.execPath, releaseId: string | null = null, profile: LaunchProfile | null = null, cwd: string | null = null): string {
  const script = exitRecorderScript(JSON.stringify(releaseId), JSON.stringify(profile));
  const recorderArgv = [node, "-e", script, exitPath, logPath, runtimePath, ...argv];
  if (cwd === null) return recorderArgv.map(shellQuote).join(" ");
  return cwdGuardedCommand(cwd, logPath, exitPath, recorderArgv);
}

/** Parse the R2 runtime record the recorder wrote. Returns undefined if absent
 *  or malformed — R2 is never guessed. */
export function parseRecorderRuntime(raw: string): RecorderRuntime | undefined {
  try {
    const p = JSON.parse(raw) as Partial<RecorderRuntime>;
    if (typeof p.execPath !== "string" || typeof p.abi !== "string" || typeof p.nodeVersion !== "string") return undefined;
    // FG-569 (R2): releaseId must be string | null. A present-but-wrong-typed value
    // (e.g. the number 42) is a MALFORMED record — OMIT the whole record rather than
    // coercing it to a null-release recorder, which would GUESS a provenance the bytes
    // never stated. Absent is the dev shape (no id) and still defaults to null.
    if (p.releaseId != null && typeof p.releaseId !== "string") return undefined;
    return { execPath: p.execPath, abi: p.abi, nodeVersion: p.nodeVersion, releaseId: typeof p.releaseId === "string" ? p.releaseId : null };
  } catch {
    return undefined;
  }
}

// ── FG-555: launched-workload provenance (R3/R4) + the environment contract ──

const NESTED_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);

// FG-555: the bounded, well-known set of exec-prefixes that run a following
// command WITHOUT choosing its runtime — as long as they do not mutate PATH. We
// skip them (and any leading `VAR=VAL` assignments) to find the EFFECTIVE argv[0]
// both the fail-closed toolchain guard and the R4 nested-shell classifier reason
// about. `env` is the one that can mutate PATH (via its own `NAME=VALUE` args), so
// it is parsed specifically; the rest only carry options. Anything NOT in this set
// is treated as the effective command and judged on its own — we never pass an
// unrecognized wrapper through (fail closed).
const EXEC_PREFIXES = new Set(["env", "nice", "nohup", "time", "stdbuf", "setsid", "timeout"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Skip recognized non-PATH-mutating exec-prefixes (`env`/`nice`/…), and the
 *  `NAME=VALUE` assignments an `env` prefix applies, to reach the EFFECTIVE
 *  command. A BARE leading `VAR=VAL` (argv[0] itself) is NOT skipped: the recorder
 *  spawns argv[0] DIRECTLY (no shell), so a bare assignment is never applied — it
 *  becomes a literal executable name (ENOENT). Skipping it would let the guard
 *  reason about a "real" command a direct spawn never reaches; the effective
 *  argv[0] IS the assignment, and the caller judges it as such (refuse). A
 *  `VAR=VAL` is only an applied assignment when it FOLLOWS `env`. `pathMutated`
 *  flags an `env PATH=…` assignment that defeats the pin. `unprovable` flags an
 *  exec-prefix form we cannot safely skip (an `env` option like `-i` that clears
 *  the environment) — the caller then fails closed: refuse (guard) or prefer
 *  `unknowable` (R4), never wave through a form we could not parse. */
function effectiveCommand(argv: string[]): { argv: string[]; pathMutated: boolean; unprovable: boolean } {
  let i = 0;
  let pathMutated = false;
  while (i < argv.length) {
    const name = basename(argv[i]!);
    if (!EXEC_PREFIXES.has(name)) break;
    i++;
    if (name === "env") {
      // env [OPTION]... [NAME=VALUE]... [COMMAND...]
      while (i < argv.length) {
        const tok = argv[i]!;
        if (tok === "--") { i++; break; }
        if (ASSIGNMENT.test(tok)) {
          if (tok.startsWith("PATH=")) pathMutated = true;
          i++;
          continue;
        }
        // An env OPTION (-i clears the env, -u unsets, -S splits): we will not
        // reason about what it does to the environment — fail closed.
        if (tok.startsWith("-")) return { argv: argv.slice(i), pathMutated, unprovable: true };
        break;
      }
    } else {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        const op = argv[i]!;
        i++;
        const consumesArg =
          (name === "nice" && op === "-n") ||
          (name === "stdbuf" && /^-[ioe]$/.test(op)) ||
          (name === "timeout" && (op === "-s" || op === "-k")) ||
          (name === "time" && (op === "-o" || op === "-f"));
        if (consumesArg && i < argv.length) i++;
      }
      if (name === "timeout" && i < argv.length) i++; // the DURATION operand
    }
  }
  return { argv: argv.slice(i), pathMutated, unprovable: false };
}

export type PathResolver = (name: string, path: string | undefined) => string | undefined;

/** which(1)-style resolution: the first executable named `name` on `path`. A name
 *  already containing a separator is not a PATH lookup — it IS the path. */
function resolveOnPath(name: string, path: string | undefined): string | undefined {
  if (name === "") return undefined;
  if (name.includes("/")) return name;
  for (const dir of (path ?? "").split(":")) {
    // An empty PATH component denotes the launch cwd (execvp semantics) — kept in
    // lockstep with the recorder, which resolves the same effective executable.
    const candidate = join(dir === "" ? process.cwd() : dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** The pure reference for the recorder's R3/R4 derivation (exitRecorderScript
 *  mirrors this inline, in-process, at spawn time). R3 resolves argv[0] against
 *  `path`; R4 classifies whether argv[0] is a nested shell whose later command
 *  resolution is unknowable. */
export type InterpreterProber = (execPath: string) => WorkloadInterpreter | undefined;

export function deriveWorkloadProvenance(
  argv: string[],
  opts: { path?: string; resolve?: PathResolver; profile?: LaunchProfile; probeInterpreter?: InterpreterProber } = {},
): WorkloadProvenance {
  const resolve = opts.resolve ?? resolveOnPath;
  const argv0 = argv[0] ?? "";

  let r3: WorkloadTopLevel;
  if (argv0.includes("/")) {
    r3 = { kind: "captured", argv0, execPath: argv0 };
  } else {
    const found = resolve(argv0, opts.path);
    r3 = found ? { kind: "derived", argv0, execPath: found } : { kind: "unresolved", argv0 };
  }

  // R4 (INVERTED, mirroring the fail-closed refusal side): the DEFAULT is
  // `unknowable`. We reserve `not_applicable` for the ONE provable case — the
  // effective argv[0] is a TERMINAL Node interpreter (basename node/nodejs), so the
  // interpreter IS argv[0] and R3 fully captures the runtime; nothing resolves a
  // different Node later. EVERYTHING else is unknowable: any shell (with or without
  // `-c`), any script (`bash ./x.sh`, `./x.sh`), any launcher whose shebang/PATH
  // lookup selects Node AFTER argv[0] is spawned (`npm`, `npx`, `forge`, `vitest`,
  // `tsx`, or any unrecognized command), and any wrapper form we could not fully
  // parse (unprovable). Enumerating launchers is unwinnable — a false `not_applicable`
  // implies "argv is the full resolution" when a later shebang/PATH resolution may
  // select an ABI-incompatible Node. When in any doubt: unknowable, never not_applicable.
  const eff = effectiveCommand(argv);
  const effName = basename(eff.argv[0] ?? "");
  let r4: WorkloadNestedShell;
  if (effName === "node" || effName === "nodejs") {
    r4 = { kind: "not_applicable", reason: "the effective argv[0] is a terminal Node interpreter (node/nodejs) — it IS the runtime (R3 captures it); nothing resolves a different Node later" };
  } else {
    const nested = NESTED_SHELLS.has(effName) && eff.argv.slice(1).some((a) => /^-[a-z]*c$/.test(a));
    const reason = nested
      ? "a nested shell resolves node/npm/forge at runtime against whatever PATH it builds — not knowable at launch time (BD-14 R4)"
      : eff.unprovable
        ? "an env/wrapper form the launcher cannot fully parse could still resolve an arbitrary runtime — a hidden shell cannot be ruled out (BD-14 R4)"
        : "the effective argv[0] is not a terminal Node interpreter — a later shebang/PATH resolution (a shell, a script, or a Node-shebang launcher) may select a different Node that is not knowable at launch time (BD-14 R4)";
    r4 = { kind: "unknowable", shell: effName || "(none)", reason };
  }

  const result: WorkloadProvenance = { r3, r4 };
  if (opts.profile) result.profile = opts.profile;
  // Probe the EFFECTIVE interpreter — the one that actually executes — when it is a
  // terminal Node interpreter (R4 not_applicable). This is the effective argv[0]
  // AFTER skipping env/exec-prefixes, resolved the SAME way R3 resolves argv0. For a
  // top-level `env FOO=bar node …` R3 is `env`, but the runtime that runs is the node
  // behind it; probing R3 would leave a supported, allowed launch with no interpreter
  // ABI/version recorded. Bounded to node/nodejs on purpose (a non-node runtime is the
  // same unknowable class as R4).
  if (opts.probeInterpreter && (effName === "node" || effName === "nodejs")) {
    const effArgv0 = eff.argv[0]!;
    const effPath = effArgv0.includes("/") ? effArgv0 : resolve(effArgv0, opts.path);
    if (effPath) {
      const itp = opts.probeInterpreter(effPath);
      if (itp) result.interpreter = itp;
    }
  }
  return result;
}

function validR3(v: unknown): WorkloadTopLevel | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.argv0 !== "string") return undefined;
  if (r.kind === "unresolved") return { kind: "unresolved", argv0: r.argv0 };
  if ((r.kind === "captured" || r.kind === "derived") && typeof r.execPath === "string") {
    return { kind: r.kind, argv0: r.argv0, execPath: r.execPath };
  }
  return undefined;
}

function validR4(v: unknown): WorkloadNestedShell | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.reason !== "string") return undefined;
  if (r.kind === "not_applicable") return { kind: "not_applicable", reason: r.reason };
  if (r.kind === "unknowable" && typeof r.shell === "string") return { kind: "unknowable", shell: r.shell, reason: r.reason };
  return undefined;
}

function validProfile(v: unknown): LaunchProfile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.path !== "string" || typeof r.requireAbi !== "string") return undefined;
  return { path: r.path, requireAbi: r.requireAbi, ...(typeof r.label === "string" ? { label: r.label } : {}) };
}

function validInterpreter(v: unknown): WorkloadInterpreter | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.execPath !== "string" || typeof r.abi !== "string" || typeof r.nodeVersion !== "string") return undefined;
  return { execPath: r.execPath, abi: r.abi, nodeVersion: r.nodeVersion };
}

/** Parse the R3/R4 record the recorder wrote. Returns undefined if the CORE R3/R4
 *  is absent or malformed — provenance is never guessed (mirrors parseRecorderRuntime).
 *  The optional profile/interpreter are supplementary: a malformed one is omitted
 *  (never guessed), but does not invalidate the core record. */
export function parseWorkloadProvenance(raw: string): WorkloadProvenance | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { r3, r4, profile, interpreter } = parsed as { r3?: unknown; r4?: unknown; profile?: unknown; interpreter?: unknown };
  const okR3 = validR3(r3);
  const okR4 = validR4(r4);
  if (!okR3 || !okR4) return undefined;
  const result: WorkloadProvenance = { r3: okR3, r4: okR4 };
  const okProfile = validProfile(profile);
  if (okProfile) result.profile = okProfile;
  const okItp = validInterpreter(interpreter);
  if (okItp) result.interpreter = okItp;
  return result;
}

// FG-555: the execution-environment CONTRACT a Forge-owned unattended caller
// declares INSTEAD of inheriting an ambient login-shell PATH. It pins the
// workload's PATH to forge's OWN control-runtime node dir (front of PATH) and
// names the ABI the workload must run under. This is the SMALLEST mechanism that
// satisfies BD-14's "a workload that requires a shell declares it and gets a
// contract; it does not inherit one accidentally" — a direct argv plus a pinned
// PATH, NEVER a silent rewrite of arbitrary operator argv.
export type LaunchProfile = { path: string; requireAbi: string; label?: string };

/** The control-runtime launch environment: the SAME node the forge CLI itself
 *  runs under, pinned at the FRONT of PATH, and the control ABI as the required
 *  toolchain. A Forge-owned unattended verification submits with this so it
 *  resolves the control toolchain by contract, never an ambient login shell's. */
export function controlRuntimeProfile(opts: { label?: string } = {}): LaunchProfile {
  // Prepend UNCONDITIONALLY: the control node dir must resolve FIRST even when it
  // already appears later in PATH behind an incompatible node — that shadowing is
  // exactly the reproduction. A duplicate dir entry is harmless (first wins).
  const nodeDir = dirname(process.execPath);
  const existing = process.env.PATH ?? "";
  return {
    path: [nodeDir, existing].filter((p) => p !== "").join(":"),
    requireAbi: process.versions.modules,
    ...(opts.label ? { label: opts.label } : {}),
  };
}

export type AbiProber = (nodeExec: string) => string | undefined;

/** Probe an interpreter's ABI by asking it to PRINT its own — it exits after one
 *  expression. This NEVER rebuilds or replaces any native dependency (FG-555: no
 *  shared-native-dep remediation); it only reads the toolchain's identity. */
function defaultAbiProbe(nodeExec: string): string | undefined {
  try {
    return execFileSync(nodeExec, ["-p", "process.versions.modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export type NodeVersionProber = (nodeExec: string) => string | undefined;

/** Probe a launched interpreter's Node VERSION (e.g. `v23.1.0`) the same read-only
 *  way as its ABI. Feeds checkAbi so a refusal names the version of the interpreter
 *  that would actually run, not the control process's — the two can differ under the
 *  pinned-PATH contract. Undefined when unreadable; the caller renders "(unknown)"
 *  rather than falling back to the control version. */
function defaultNodeVersionProbe(nodeExec: string): string | undefined {
  try {
    return execFileSync(nodeExec, ["-p", "process.version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** Build the ONE named, actionable refusal (FG-555). Every refusal path uses this
 *  single shape: it names WHY compatibility cannot be proven (the effective argv[0]
 *  and the category), states the pinned PATH, and gives the fix. `detail` carries a
 *  category-specific line (e.g. checkAbi's ABI diagnosis) when there is one. */
function toolchainRefusal(profile: LaunchProfile, effectiveArgv0: string, category: string, detail?: string): { ok: false; message: string } {
  return {
    ok: false,
    message:
      `forge launch: refusing to run — the --require-control-toolchain contract runs a command ONLY when it can ` +
      `PROVE the command executes forge's pinned control toolchain, and this one is not provable.\n` +
      `  reason: ${category}\n` +
      `  effective argv[0]: ${effectiveArgv0 || "(none)"}\n` +
      (detail ? `  detail: ${detail}\n` : "") +
      `  contract: ${profile.label ? `${profile.label} — ` : ""}pinned PATH = ${profile.path}\n` +
      `  fix: submit the verification as a direct \`forge …\` / \`npm …\` / \`node …\` command on the pinned ` +
      `toolchain, without a shell or env/PATH wrapper.`,
  };
}

/** Refuse-before-execute (FG-555). The OPERATOR-DECIDED contract (the FG-555
 *  pinned-PATH-trust decision, Option A — this is the intended shape, not a gap):
 *  the pinned control PATH (`new-session -e PATH=<control-node-dir>:<orig>`) IS the
 *  protection. Under `--require-control-toolchain` the contract runs a command BEFORE
 *  any tmux session exists ONLY for an ALLOWED effective argv[0], and refuses the rest
 *  with ONE named message. After skipping leading `VAR=VAL` assignments that do NOT
 *  mutate PATH and a bounded set of non-PATH-mutating exec-prefixes (see
 *  effectiveCommand), the EFFECTIVE argv[0] is judged:
 *
 *  ALLOW (`ok: true`) — a control tool resolved BY NAME on the pinned PATH, or a
 *  matching-ABI Node interpreter:
 *    - `node`/`nodejs` (by name OR an explicit path) — probed for its ABI (reusing
 *      FG-570's checkAbi) and allowed IFF it equals the required ABI. That is the
 *      executable the recorder spawns DIRECTLY, so a wrong-ABI interpreter cannot slip
 *      through.
 *    - `forge`/`npm`/`npx` resolved BY NAME on the pinned PATH — allowed WHEREVER they
 *      resolve on the pinned PATH (NOT restricted to dirname(process.execPath)). This is
 *      the operator-blessed pinned-PATH trust: a name-resolved control tool runs under
 *      the control node because the pin places the control node FIRST, so the tool's
 *      `#!/usr/bin/env node` shebang resolves the control node. This un-breaks the
 *      documented primary caller `forge launch run --require-control-toolchain -- forge
 *      review-loop …`, where forge is a shim outside the node bin dir.
 *
 *  REFUSE (`ok: false`, ONE named message) — the clearly-unsafe explicit cases:
 *    - a leading assignment that mutates PATH (`env PATH=…`) — it defeats the pin;
 *    - a login shell (`bash -lc`, `zsh --login`, any shell with `-l`/`--login`) — it
 *      re-sources profile scripts that reset PATH AFTER the pin;
 *    - a wrong-ABI directly-named interpreter (the FG-560545e case);
 *    - any OTHER shell (even non-login: `bash -c`, `sh -c`), script, explicit-path
 *      control tool, or wrapper/unknown binary that is NOT a name-resolved control
 *      tool — the contract cannot place it in the trusted set, so it fails closed.
 *
 *  R4 recording is INDEPENDENT of this ALLOW decision: a name-resolved forge/npm STILL
 *  records R4=unknowable (its shebang resolves node later) — being ALLOWED under the flag
 *  and being RECORDED unknowable are both correct. Probe-only — NEVER rebuilds a native dep. */
export function assertProfileToolchain(profile: LaunchProfile, argv: string[], opts: { resolve?: PathResolver; probeAbi?: AbiProber; probeNodeVersion?: NodeVersionProber } = {}): { ok: true } | { ok: false; message: string } {
  const resolve = opts.resolve ?? resolveOnPath;
  const probe = opts.probeAbi ?? defaultAbiProbe;
  const probeVersion = opts.probeNodeVersion ?? defaultNodeVersionProbe;

  const eff = effectiveCommand(argv);
  const a0 = eff.argv[0] ?? "";
  const name = basename(a0);
  const byName = a0 !== "" && !a0.includes("/");

  if (eff.pathMutated) {
    return toolchainRefusal(profile, a0, "a leading assignment mutates PATH (e.g. `env PATH=…`), which defeats the pinned toolchain");
  }
  if (eff.unprovable || a0 === "") {
    return toolchainRefusal(profile, a0, "an env/wrapper form the contract cannot parse — it could resolve an arbitrary runtime");
  }
  // A bare `VAR=VAL` as the effective argv[0]: the recorder spawns argv[0] DIRECTLY, so
  // a bare assignment is never applied (no shell) — it is a literal executable name that
  // ENOENTs. It is not a name-resolved control tool, so the contract cannot prove what
  // (if anything) runs — refuse. `env FOO=bar node …` stays valid: `env` IS the effective
  // prefix and applies the assignment (handled above), so this never fires for it.
  if (ASSIGNMENT.test(a0)) {
    return toolchainRefusal(profile, a0, "argv[0] is a bare `VAR=VAL` assignment — a direct spawn runs it literally as the executable name (ENOENT); an environment assignment is only applied by a shell or an `env` prefix, neither of which is present here");
  }
  if (NESTED_SHELLS.has(name)) {
    return toolchainRefusal(profile, a0, "argv[0] is a shell (login or not), which can rebuild PATH and resolve an arbitrary runtime — not a name-resolved control tool the pin can be trusted for");
  }

  if (name === "node" || name === "nodejs") {
    const resolved = resolve(a0, profile.path);
    if (!resolved) {
      return toolchainRefusal(profile, a0, "argv[0] is a Node interpreter that does not resolve on the pinned PATH — its runtime cannot be proven");
    }
    // Name the probed interpreter's OWN version in the refusal — it is a different
    // interpreter than this control process, so its Node version must be read from it,
    // never assumed to be process.versions.node (which would pair the control version
    // with the launched ABI and misdiagnose the mismatch).
    const r = checkAbi(probe(resolved) ?? "", profile.requireAbi, probeVersion(resolved) ?? "(unknown)");
    if (r.ok) return { ok: true };
    // The recorder spawns argv[0] DIRECTLY, so THIS interpreter — not the pinned
    // PATH — is what runs; its ABI does not match, so the workload would fail deep
    // inside the suite (opaque ERR_DLOPEN_FAILED) instead of here.
    return toolchainRefusal(profile, a0, "argv[0] is a Node interpreter whose ABI does not match the required ABI", r.message);
  }

  // Pinned-PATH trust: a control tool resolved BY NAME on the pinned PATH runs under
  // the control node because the pin puts the control node first. Allowed wherever it
  // resolves on the pinned PATH — NOT restricted to the node bin dir. An explicit-path
  // forge/npm/npx is NOT name-resolved (PATH order does not govern it), so it falls
  // through to the fail-closed refusal below.
  if (byName && (name === "forge" || name === "npm" || name === "npx")) {
    const resolved = resolve(a0, profile.path);
    if (resolved) return { ok: true };
    return toolchainRefusal(
      profile,
      a0,
      "argv[0] is a control tool that does not resolve on the pinned PATH — the pin cannot place the control node before something that is not there",
      "did not resolve on the pinned PATH",
    );
  }

  return toolchainRefusal(profile, a0, "argv[0] is not a name-resolved control tool (forge/npm/npx/node) — a shell, script, explicit-path wrapper, or unknown binary the contract cannot prove runs the control toolchain");
}

/** Forge run/task ids, opportunistically, from whatever the command logged.
 *
 *  QUARANTINED (FG-679 / BD-15). This is INFERENCE from raw LOG TEXT and it
 *  AUTHORIZES NOTHING. It stays published on `LaunchView` for compatibility and
 *  human diagnostics only. It must NEVER decide which run, task, or project a
 *  launch is placed under: FG-492 records that long-lived agent processes carry
 *  conversation text in their argv and logs, which false-matches unrelated role and
 *  ticket names — that is precisely how a launch gets attributed to a run it has
 *  nothing to do with. Placement is authorized ONLY by the explicit submission-time
 *  metadata recorded in `launch_observations.association_kind`, and
 *  src/v2/current-activity.ts neither imports nor consults this function. */
export function extractForgeIds(log: string): { runIds: string[]; taskIds: string[] } {
  const uniq = (re: RegExp): string[] => [...new Set(log.match(re) ?? [])];
  return {
    runIds: uniq(/\brun-[a-z0-9][a-z0-9-]*/g),
    taskIds: uniq(/\btask-[a-z0-9][a-z0-9-]*/g),
  };
}

/** Publish a record atomically: write a sibling temp file, then rename it into
 *  place. rename(2) is atomic on a single filesystem, so a concurrent reader sees
 *  either the previous bytes or the complete new bytes — never a truncated record.
 *  FG-552 (BD-4): closes both non-atomic defects — a consumer must never observe
 *  partially-written JSON as a terminal result, and a reader arriving during meta
 *  publication must never see a running launch as "no such launch". */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// FG-535 AC / FG-552: the ONE human rendering of the canonical status vocabulary.
// Lives here beside classifyExit so `forge launch show/list` and `forge launch
// wait` render from a SINGLE source — no second status vocabulary (BD-10). Never
// infers a signal sender from a 143-shaped code.
export function statusLine(s: LaunchStatus): string {
  switch (s.state) {
    case "running": return "running";
    case "exited_ok": return "exited 0";
    case "exited_error": return `exited ${s.code}`;
    case "signaled": return `terminated by ${s.signal} (signal sender not recorded — origin unknown)`;
    case "terminated_unattributed": return `exited ${s.code} (signal-range code, no signal evidence — origin unknown)`;
    case "owner_gone": return "owner gone without an exit record (wrapper killed, or failed before recording — cause and sender not recorded)";
    case "unknown": return "unknown (no exit record, owner gone — e.g. host reboot)";
  }
}

/** The launch-id charset. A launch is addressed by IDENTITY, never by path: an id
 *  that matches this contains no separator and no `..`, so it can only ever name a
 *  direct child of LAUNCHES_DIR (BD-10). Exported so a second consumer — the
 *  dashboard's identity-addressed launch endpoints — validates against THIS
 *  definition rather than a hand-copied regex that could drift looser. */
export function isLaunchId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(id);
}

function launchDir(id: string): string {
  // Every path under LAUNCHES_DIR is derived here; ids come from operator
  // input (show/rm) as well as startLaunch, so the traversal guard lives at
  // the single chokepoint rather than per caller.
  if (!isLaunchId(id)) throw new Error(`forge launch: invalid launch id '${id}'`);
  return join(LAUNCHES_DIR, id);
}

function slugOf(argv: string[]): string {
  return argv.slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cmd";
}

export type TmuxRunner = (args: string[]) => string | void;

export function defaultTmux(args: string[]): string {
  return execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// ── FG-614: naming the bricked-tmux-server condition instead of leaking uv_cwd ──

/** Read a live process's working directory — the `lsof -a -p <pid> -d cwd` an operator
 *  had to run BY HAND to diagnose the FG-614 incident. Linux answers from procfs
 *  (a deleted directory reads back with a ` (deleted)` suffix, which is stripped so the
 *  caller judges existence itself); darwin asks lsof. Any other platform, or any
 *  failure, is `undefined` — the caller then reports `unprobed`, never a guess. */
function readProcCwd(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const link = readlinkSync(`/proc/${pid}/cwd`);
      return link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : link;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
      // -F n emits one field per line, each prefixed by its identifier; `n` is the name.
      const name = out.split("\n").find((l) => l.startsWith("n") && l.length > 1);
      return name?.slice(1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** What `tmux kill-server` would cost: how many sessions exist and how many still hold
 *  a live process. Undefined when tmux cannot answer — the diagnosis then states the
 *  cost qualitatively rather than inventing a count. */
export function tmuxSessionCost(tmux: TmuxRunner = defaultTmux): { sessions: number; livePanes: number } | undefined {
  let out: string | void;
  try {
    out = tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_dead}"]);
  } catch {
    return undefined;
  }
  const lines = String(out ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return undefined;
  const sessions = new Set<string>();
  let livePanes = 0;
  for (const line of lines) {
    const [name, dead] = line.split(" ");
    if (name === undefined || name === "") return undefined; // not the format we asked for
    sessions.add(name);
    if (dead === "0") livePanes++;
  }
  return { sessions: sessions.size, livePanes };
}

/** Probe the LAUNCHER's own condition: does the long-lived tmux server's working
 *  directory still exist? Cheap — one `display-message` against the existing server,
 *  and the session count only when the answer is bad. Never starts a server: with no
 *  server running `display-message` fails and tmux says so in stderr, which is
 *  `no_server` (the next `new-session` will start one from forge's own, verified cwd). */
export function probeTmuxServerCwd(opts: { tmux?: TmuxRunner } = {}): TmuxServerCwd {
  const tmux = opts.tmux ?? defaultTmux;
  let out: string | void;
  try {
    out = tmux(["display-message", "-p", "#{pid}"]);
  } catch (e) {
    // A failed `display-message` is TWO different facts and only one of them is an
    // observation: tmux reached the socket and reported nothing listening (`no_server`,
    // a real reading of the host), or forge could not ASK at all — tmux not on PATH, an
    // unreadable socket directory, a broken TMUX_TMPDIR. Claiming `no_server` for the
    // second is the FG-614 mistake in miniature: an opaque failure attributed to
    // something forge never verified.
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    if (/no server running/.test(stderr) || /error connecting to .*\(No such file or directory\)/.test(stderr)) {
      return { state: "no_server" };
    }
    const detail = stderr !== "" ? stderr : (e as Error).message;
    return { state: "unprobed", reason: `could not run \`tmux display-message -p '#{pid}'\`: ${detail}` };
  }
  const pid = Number(String(out ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unprobed", reason: "tmux did not report a server pid" };
  const path = readProcCwd(pid);
  if (path === undefined || path === "") {
    return { state: "unprobed", reason: `could not read the working directory of tmux server pid ${pid} on ${process.platform}` };
  }
  if (existsSync(path)) return { state: "ok", path };
  const cost = tmuxSessionCost(tmux);
  return { state: "missing", path, ...(cost ? cost : {}) };
}

/** The ONE named rendering of the bricked-server condition (FG-614). It names the
 *  cause, states that forge no longer depends on it, gives the remedy, and states what
 *  the remedy COSTS — because the remedy kills live work and is therefore the
 *  operator's call, never forge's. */
export function tmuxServerCwdDiagnosis(probe: { path: string; sessions?: number; livePanes?: number }): string {
  const cost = probe.sessions === undefined
    ? `\`tmux kill-server\` kills EVERY tmux session on this host and any live process inside them. Forge could not count them — check \`tmux list-sessions\` first.`
    : `\`tmux kill-server\` kills ${probe.sessions} tmux session(s), ${probe.livePanes ?? 0} of which still hold a live process — those processes die with the server. Check \`tmux list-sessions\` first.`;
  return [
    `forge launch: the tmux server's own working directory no longer exists.`,
    `  tmux server cwd: ${probe.path} (deleted)`,
    `  cause: the long-lived tmux server inherited this directory and it has since been removed. The server outlives every session, so sessions it forks start in a dead directory and any process that reads its working directory at startup — node does, during bootstrap — dies with ENOENT/uv_cwd before executing a line. This is the LAUNCHER's condition, not a fault of any launched command.`,
    `  this launch is unaffected: forge enters the directory it recorded for the launch before the command starts, so the server's cwd is irrelevant to it.`,
    `  remedy (the operator's call — forge will NOT restart your tmux server): ${cost}`,
  ].join("\n");
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

/** Whether the SUBMITTING forge CLI (meta.launcherPid) is still alive. The launcher
 *  pid is the independently-observable transition that BOUNDS the `starting` startup
 *  window (FG-552): a `starting` record whose launcher is alive is genuinely
 *  mid-startup; one whose launcher is gone is a launcher-crash orphan to reconcile.
 *  Mirrors the codebase's pidAlive idiom (run-lock): kill(pid,0) proves existence.
 *  ONLY a definitive ESRCH (no such process) counts as dead — any other error (EPERM:
 *  exists but not ours; anything unqueryable) is treated as ALIVE, so an uncertain
 *  liveness never fabricates a terminal disposition. */
function launcherAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Mint a launch id WITHOUT starting anything, so a caller that must make the
 *  identity durable BEFORE the physical launch (FG-591's claim stamp) can hand the
 *  same id to startLaunch. The format is startLaunch's own, derived here so there is
 *  one producer of it rather than two that can drift. */
export function allocateLaunchId(name: string): string {
  return `launch-${slugOf([name])}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a command under a durable tmux owner. Returns the persisted record.
 *  Throws (before anything is written) if tmux is unavailable.
 *
 *  `opts.id` pre-assigns the launch identity (allocateLaunchId). It exists for the
 *  callers whose durable pointer to this container must be committed BEFORE the
 *  container can exist; supplying an id that is already taken is refused rather than
 *  allowed to clobber another launch's record. */
export function startLaunch(argv: string[], opts: { id?: string; name?: string; cwd?: string; tmux?: TmuxRunner; now?: Date; profile?: LaunchProfile; env?: NodeJS.ProcessEnv } = {}): LaunchMeta {
  if (argv.length === 0) throw new Error("forge launch run: no command given");
  // FG-555: refuse-before-execute. When a Forge-owned caller declares the
  // execution-environment contract, assert the toolchain BEFORE anything is
  // written or any tmux session is created — a named, actionable mismatch here
  // instead of hundreds of downstream ERR_DLOPEN_FAILED the controller must
  // reverse-engineer (the Node 23/ABI 131 vs Node 24/ABI 137 reproduction).
  if (opts.profile) {
    const gate = assertProfileToolchain(opts.profile, argv);
    if (!gate.ok) throw new Error(gate.message);
  }
  const tmux = opts.tmux ?? defaultTmux;
  try {
    tmux(["-V"]);
  } catch {
    throw new Error("forge launch requires tmux — install it (brew install tmux / apt install tmux) and retry");
  }

  // FG-614: the launch OWNS its working directory — the wrapper chdir's into it rather
  // than inheriting whatever the tmux server had. So it must be a directory that
  // exists, verified BEFORE anything is written: a launch that cannot establish its
  // recorded cwd is refused here, by name, instead of dying inside the pane as an
  // ENOENT/uv_cwd trace that reads as if the launched command were at fault.
  // process.cwd() itself THROWS when this process's directory has been deleted (uv_cwd) —
  // the same ENOENT the incident surfaced, just one layer up. Name it here rather than
  // letting the raw libuv message stand as the whole explanation.
  let cwd: string;
  if (opts.cwd !== undefined) {
    cwd = opts.cwd;
  } else {
    try {
      cwd = process.cwd();
    } catch (e) {
      throw new Error(
        `forge launch: refusing to launch — THIS forge process's own working directory no longer exists, so there is no directory to record for the launch (${(e as Error).message}).\n` +
          `  cause: the directory this shell is sitting in was deleted underneath it.\n` +
          `  fix: cd to a directory that exists (\`cd "$PWD"\` will not work — the directory is gone) and retry.`,
      );
    }
  }
  if (!existsSync(cwd)) {
    throw new Error(
      `forge launch: refusing to launch — the working directory recorded for this launch does not exist: ${cwd}\n` +
        `  every launch is started IN this directory (forge does not inherit the tmux server's cwd), so it must exist at submission.\n` +
        `  fix: relaunch from a directory that exists, or pass a cwd that does.`,
    );
  }

  // FG-614: probe the LAUNCHER's own condition before creating anything. The launch
  // proceeds either way (the wrapper's chdir makes the server's cwd irrelevant), but
  // the fact is recorded so `forge launch show` can name it, the CLI can warn, and a
  // tmux failure below can be attributed to it instead of surfacing raw.
  const serverCwd = probeTmuxServerCwd({ tmux });

  const now = opts.now ?? new Date();
  const rand = Math.random().toString(36).slice(2, 8);
  // The name becomes a directory segment under LAUNCHES_DIR and a tmux session
  // name — slugify it through the SAME charset as the auto-derived slug so a
  // crafted --name (path separators, "..") can never escape the launches dir.
  const name = opts.name === undefined ? slugOf(argv) : slugOf([opts.name]);
  const id = opts.id ?? `launch-${name}-${rand}`;
  const session = `forge-${id}`;
  const dir = launchDir(id);
  if (opts.id !== undefined && existsSync(dir)) {
    throw new Error(`forge launch: refusing to launch — the pre-assigned launch id '${id}' already has a record at ${dir}`);
  }
  mkdirSync(dir, { recursive: true });

  // FG-626: decide the per-invocation FORGE_ env to forward BEFORE the record is
  // published, so the forwarded/dropped set is part of the durable launch record from
  // its first write and a drop can be warned about by the caller. `forwardedEnv` carries
  // the REAL values — the workload receives these (the `-e` args below). RF-3: the durable
  // record instead stores the redacted view, so a credential-bearing FORGE_ value
  // (FORGE_AWS_CREDS_FOR_TEST, an injected FORGE_TOKEN) never lands in meta.json or in
  // `forge launch show`, while its name and ordinary gate values are still recorded.
  const forwardedEnv = planForgeEnvForwarding(opts.env ?? process.env);
  const recordedForwardedEnv = redactForwardedEnvForRecord(forwardedEnv);

  const meta: LaunchMeta = {
    id,
    command: argv,
    tmuxSession: session,
    launcherPid: process.pid,
    ownerPid: null,
    startedAt: now.toISOString(),
    logPath: join(dir, "out.log"),
    cwd,
    tmuxServerCwd: serverCwd,
    forwardedEnv: recordedForwardedEnv,
    // FG-569 (R1): captured here, in the submitting CLI, INDEPENDENTLY of the
    // recorder (R2) — the CLI is gone by the time anyone inspects this launch.
    control: collectControlRuntime(),
  };
  // FG-552 (BD-4/F32): meta must be DISCOVERABLE before the command can run, or a
  // directory-discovering reader (listLaunches walks LAUNCHES_DIR, readLaunch maps
  // an absent meta.json to undefined) sees a RUNNING launch as "no such launch"
  // during initial publication. The publish window is real: mkdirSync already made
  // this dir discoverable, and respawn-pane below starts the command. So publish
  // the meta record atomically HERE, before any tmux session exists — the only
  // window a reader can then see is dir-created-but-command-not-yet-running, which
  // is honestly absent (the id has not been returned and nothing runs). The
  // ownerPid is not knowable until respawn-pane, so the record is republished once
  // more below with it. Both writes are temp+rename (writeJsonAtomic), so the
  // second write has NO truncate window — the concern that made the old code
  // single-write no longer applies now that publication is atomic (BD-4). The
  // tmux-failure path rmSyncs the whole dir, taking this record with it.
  //
  // The record is marked `starting` here and un-marked on the republish below. The
  // tmux session does not exist until new-session runs, so between these two writes
  // a directory-discovering reader that consulted owner evidence would see no
  // session and classify this launch terminal `unknown` — a waiter would then
  // advance BEFORE respawn-pane starts the work. `starting` tells the reader that
  // an absent session is startup-in-progress, so it reads `running` instead.
  const metaPath = join(dir, "meta.json");
  writeJsonAtomic(metaPath, { ...meta, starting: true });

  const wrapped = buildWrapperCommand(argv, meta.logPath, join(dir, "exit"), join(dir, "runtime.json"), process.execPath, trustedReleaseId(), opts.profile ?? null, meta.cwd);
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
    // FG-555: when the caller declared the contract, pin the session PATH to the
    // contract's (control-node-first) PATH via `new-session -e`, so the recorder
    // and workload resolve the contracted toolchain — never an ambient login
    // shell's PATH. Absent a profile, the session inherits the launcher env as
    // before.
    //
    // FG-626: forward the per-invocation FORGE_-prefixed variables through the SAME
    // `new-session -e` channel — the mandated dispatch path (`forge launch run`) must
    // carry the env-gated behaviors forge exists to gate (FORGE_WORKTREES, FORGE_CI_*,
    // …), which a tmux session otherwise silently drops (it inherits only what the tmux
    // SERVER had when it first started, never this invocation's env). The PATH pin is
    // appended LAST so it WINS over any forwarded variable (tmux applies -e left to
    // right): the FG-555 contract's pinned PATH must never be clobbered. Forwarded vars
    // are FORGE_-prefixed and PATH is not, so they cannot collide today — appending the
    // pin last is the belt-and-suspenders guarantee that a future forwarded PATH-like
    // name still cannot defeat the contract.
    const forwardedEnvArgs = forwardedEnv.forwarded.flatMap((v) => ["-e", `${v.name}=${v.value}`]);
    const pathPin = opts.profile ? ["-e", `PATH=${opts.profile.path}`] : [];
    const sessionEnv = [...forwardedEnvArgs, ...pathPin];
    tmux(["new-session", "-d", "-s", session, "-c", meta.cwd, ...sessionEnv, "cat"]);
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
    // FG-614: if the server's cwd is gone, THAT is the diagnosis the operator needs —
    // attach it rather than letting a raw tmux/node message stand as the whole story.
    const named = serverCwd.state === "missing" ? `\n\n${tmuxServerCwdDiagnosis(serverCwd)}` : "";
    throw new Error(`forge launch: tmux failed to start the session — ${(e as Error).message}${named}`);
  }

  // Only knowable once the pane holds the real command, so the record is
  // republished (atomically) with it — an owner pid queried before respawn-pane
  // would name the inert bootstrap pane instead. This is the second atomic write;
  // a concurrent reader sees the pre-run record or this one, never a torn/absent
  // state (F32). `meta` carries no `starting` flag (it was set only on the spread
  // written above), so this republish clears it: ownership is now established, and
  // an absent session hereafter IS terminal owner loss, classified normally.
  meta.ownerPid = ownerPidOf(session, tmux);
  writeJsonAtomic(metaPath, meta);
  return meta;
}

export function readLaunch(id: string, tmux: TmuxRunner = defaultTmux, isLauncherAlive: (pid: number) => boolean = launcherAlive): LaunchView | undefined {
  const dir = launchDir(id);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return undefined;
  let meta: LaunchMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as LaunchMeta;
  } catch {
    return undefined;
  }

  // FG-552 (BD-4/BD-7/F11): an empty, unparseable, or otherwise unreadable exit
  // record is NEVER terminal on its own — it is the write window BD-4 closes, so
  // it is an invitation to bounded retry, not a disposition. The read is honest
  // about THREE distinct outcomes, because they must NOT be conflated:
  //   record     — a PARSEABLE exit record: authoritative (classifyExit).
  //   absent      — no exit file at all (ENOENT): no record was written, so it is
  //                the ONLY outcome that may fall through to a terminal OWNER
  //                verdict (owner_gone / unknown) when owner evidence is terminal.
  //   unreadable  — a file EXISTS but its bytes cannot be consumed this read
  //                (empty/half-written, schema-invalid, or an EIO/EACCES/torn read).
  //                A record IS being committed; a transient read/parse failure that
  //                straddles the owner/session ending must not advance a controller
  //                on indeterminate terminal evidence. This ALWAYS reads `running`
  //                (bounded retry) — even when owner evidence is terminal — so the
  //                wait's reconcile re-reads (a transient failure clears next tick)
  //                and only its own timeout bounds a persistently-corrupt record.
  // The old reader collapsed absent/unreadable/invalid into one `undefined` and,
  // once owner evidence went terminal, published unknown/owner_gone after a single
  // reread — stranding a launch whose valid record a retry would have read (F11).
  type ExitRead =
    | { kind: "record"; rec: ExitRecord }
    | { kind: "absent" }
    | { kind: "unreadable" };
  let status: LaunchStatus;
  let pendingUnreadableExit: { terminal: LaunchStatus } | undefined;
  const exitPath = join(dir, "exit");
  const readExit = (): ExitRead => {
    let raw: string;
    try {
      raw = readFileSync(exitPath, "utf8");
    } catch (e) {
      // ENOENT is genuinely absent (no record yet); ANY other read error means a
      // file is there we transiently could not consume — unreadable, not absent.
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
    }
    const rec = parseExitRecord(raw);
    return rec ? { kind: "record", rec } : { kind: "unreadable" };
  };
  let ex = readExit();
  if (ex.kind === "record") {
    status = classifyExit(ex.rec);
  } else if (meta.starting && isLauncherAlive(meta.launcherPid)) {
    // FG-552: the launch is in its startup window — meta.json was published before
    // the tmux session exists (F32) and has not yet been republished with ownership,
    // AND the SUBMITTING launcher is still alive, so it is genuinely mid-startup. An
    // absent session here is startup-in-progress, NOT owner loss, so consulting owner
    // evidence would wrongly classify a just-created launch terminal `unknown` and let
    // a concurrent waiter advance before respawn-pane runs the work. It is `running`
    // until ownership is established (the flag is cleared) — this preserves the round-1
    // F32 fix.
    //
    // The guard is BOUNDED to launcher liveness (launcherPid — the independently
    // observable transition the finding asked for): a `starting` record whose launcher
    // has DIED (crashed after respawn-pane succeeded but before the second publish
    // cleared the flag, then a pane/wrapper that died before writing `exit`) is NOT
    // mid-startup — it is a launcher-crash orphan. It falls through to the owner-evidence
    // reconciliation below, so with no live session / no exit record it terminals
    // (unknown / owner_gone) instead of reporting `running` forever, and a bounded waiter
    // WAKES on it. A valid exit record (handled above) and a live session (handled below)
    // are real owner/exit evidence that always win over the stale `starting` marker.
    status = { state: "running" };
  } else {
    // No authoritative record on the first read — consult owner evidence. BUT a
    // launch that COMPLETES mid-read writes its atomic exit record IMMEDIATELY
    // before its pane dies / its session ends, so a terminal owner verdict
    // derived here can STRADDLE that completion: the exit read above ran before
    // the write, the owner probe after the pane went dead. Both terminal owner
    // verdicts (no session -> unknown, dead pane -> owner_gone) are the
    // INDETERMINATE "the wrapper never completed" dispositions, so before
    // concluding either we RE-READ the exit record once — a wrapper that just
    // died wrote it moments ago. We conclude indeterminate ONLY if the record
    // is STILL absent; otherwise the now-present record is authoritative
    // (classifyExit). This closes the read-atomicity race that mis-terminaled a
    // launch which in fact exited 0 as owner_gone (FG-552 CORE invariant).
    const sessionAlive = tmuxSessionAlive(meta.tmuxSession, tmux);
    // With remain-on-exit, a live session is not proof the wrapper is: a wrapper
    // killed before its last-act exit write leaves a live session holding a DEAD
    // pane and no exit record — the durable evidence for "the owner was
    // terminated". A pane tmux can't classify stays running (fail-safe: rm keeps
    // refusing without --force).
    const dead = sessionAlive ? paneDead(meta.tmuxSession, tmux) : null;
    const ownerTerminal = !sessionAlive || dead === true;
    if (ownerTerminal) ex = readExit(); // recheck AFTER the owner probe closed the straddle window
    if (ex.kind === "record") {
      status = classifyExit(ex.rec);
    } else if (ex.kind === "unreadable") {
      // F11: a PRESENT but unreadable/invalid record is bounded retry, NEVER a
      // terminal disposition on a SINGLE read — even when owner evidence is
      // terminal. status stays `running` so this read is an invitation to retry.
      // BD-7 / PRD ("only terminal after independent terminal owner evidence"): that
      // retry is BOUNDED only when there is INDEPENDENT TERMINAL OWNER evidence — no
      // session -> unknown (owner gone via reboot, 1a), dead pane -> owner_gone (owner
      // terminated, 1a). In those cases pendingUnreadableExit names the reconciled
      // disposition a bounded waiter wakes on if the record stays unreadable past its
      // bound, so a straddled completion never blocks forever.
      // A CONFIRMED-LIVE owner is NOT terminal evidence: with temp+rename a present
      // exit record is never torn, so a corrupt record next to a LIVE pane is spurious
      // and the tmux-owned command is demonstrably still running. Fabricating a
      // terminal `unknown` here would advance a controller over a still-running
      // command — the exact FALSE COMPLETION FG-552 exists to prevent. So a live owner
      // + unreadable record leaves pendingUnreadableExit UNSET: the launch stays
      // `running`, bounded ONLY by the waiter's own --timeout (which yields
      // `wait_timeout` — an explicit disposition, never a fabricated launch terminal;
      // --timeout 0 waiting indefinitely on a genuinely-running command is correct by
      // design). If the owner LATER dies, reconcile re-reads, owner evidence goes
      // terminal, and the bound arms then.
      status = { state: "running" };
      if (!sessionAlive) {
        pendingUnreadableExit = { terminal: { state: "unknown" } };
      } else if (dead === true) {
        pendingUnreadableExit = { terminal: { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } };
      }
    } else if (!sessionAlive) {
      status = { state: "unknown" };
    } else if (dead === true) {
      status = { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" };
    } else {
      status = { state: "running" };
    }
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

  // FG-555: R3/R4, written by the recorder at spawn time. Absent for a pre-FG-555
  // launch or before the recorder ran — surfaced as "not recorded", never guessed.
  let workload: WorkloadProvenance | undefined;
  const wlPath = join(dir, "workload.json");
  if (existsSync(wlPath)) {
    try { workload = parseWorkloadProvenance(readFileSync(wlPath, "utf8")); } catch { /* not readable yet */ }
  }

  // FG-614: forge's own explanation, written by the cwd guard when the command never
  // started. Read as text (it is prose for an operator, not a parsed record).
  let diagnosis: string | undefined;
  try {
    const text = readFileSync(join(dir, "diagnosis.txt"), "utf8").trim();
    if (text !== "") diagnosis = text;
  } catch { /* nothing to say */ }

  return { ...meta, status, forgeIds: extractForgeIds(log), ...(recorder ? { recorder } : {}), ...(workload ? { workload } : {}), ...(pendingUnreadableExit ? { pendingUnreadableExit } : {}), ...(diagnosis ? { diagnosis } : {}) };
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

// ── FG-552: the blocking completion primitive (`forge launch wait`) ──

/** A generous default waiter timeout. A timeout is an explicit `wait_timeout`
 *  result (never a fabricated launch terminal state), so the default is bounded
 *  but long enough not to fire on any real long-running forge command. */
export const DEFAULT_WAIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** FG-552 (BD-7): the bound on a PERSISTENTLY unreadable/invalid exit record whose
 *  OWNER has already gone terminal. It is DISTINCT from the waiter `--timeout` (which
 *  yields `wait_timeout`, not a launch disposition): a record that stays unreadable
 *  this long AFTER independent terminal owner evidence becomes a terminal launch
 *  COMPLETION (owner_gone/unknown) the waiter wakes on, so a straddled completion
 *  never blocks forever even with `--timeout 0`. Generous — far longer than any
 *  transient torn/EIO read needs to clear across reconcile ticks — but FINITE. A
 *  persistently-corrupt record with a CONFIRMED-LIVE owner is NOT bounded here: the
 *  command is still running, so only the waiter's `--timeout` bounds it (a
 *  wait_timeout, never a fabricated launch terminal). Failure is a disposition, not
 *  silence. */
export const DEFAULT_INVALID_BOUND_MS = 60 * 1000;

/** A launch is terminal in EVERY state except `running`. The six terminal
 *  dispositions (exit 0, ordinary non-zero, OS signal, signal-range code, owner
 *  gone, unknown) all wake a waiter; only a still-running launch keeps it blocked.
 *  Reuses the one canonical status vocabulary — there is no second one (BD-10). */
export function isTerminalStatus(s: LaunchStatus): boolean {
  return s.state !== "running";
}

export type WaitOutcome =
  | { kind: "terminal"; view: LaunchView }
  | { kind: "unknown_launch"; id: string }
  | { kind: "wait_timeout"; id: string; lastObserved: LaunchStatus }
  | { kind: "wait_cancelled"; id: string; lastObserved: LaunchStatus };

/** The observation surface the blocking wait needs, injected so the loop is
 *  testable without real timers, fs.watch, or process signals. `read` is the one
 *  canonical reader (readLaunch); the rest are plumbing. Each installer returns
 *  its own teardown. */
export interface WaitHarness {
  read(): LaunchView | undefined;
  installWatcher(onEvent: () => void): () => void;
  startReconcile(onTick: () => void): () => void;
  startTimeout(onFire: () => void): () => void;
  onCancel(onCancel: () => void): () => void;
  // BD-7: a bounded timer ARMED by the waiter the first read it observes a
  // `pendingUnreadableExit`, and DISARMED the moment the record clears (becomes a
  // real record or genuinely-running). If it fires while the record is STILL
  // unreadable, the waiter wakes on the reconciled terminal disposition rather than
  // retrying forever. Returns its own teardown (idempotent).
  startInvalidBound(onFire: () => void): () => void;
}

/** Canonical blocking wait: return exactly one observation once the launch is
 *  terminal (or the waiter times out / is cancelled).
 *
 *  BD-6 (subscribe race): read the authoritative record, install the watcher,
 *  reread IMMEDIATELY — either read observes an already-terminal launch, so no
 *  check-then-subscribe gap can strand a completed launch (F1/F2).
 *
 *  F34 (mandatory reconciliation): `owner_gone` and `unknown` produce NO
 *  filesystem artifact, so fs.watch alone structurally cannot observe them — the
 *  reconcile tick re-reads owner evidence (tmux liveness / dead pane) on a bounded
 *  interval. A watch-only harness (startReconcile a no-op) is OBSERVED FAILING to
 *  see those two dispositions. This bounded internal re-read is NOT a fixed-estimate
 *  model wake; the waiter owns none of the work (BD-8). */
export async function waitForLaunchTerminal(id: string, harness: WaitHarness): Promise<WaitOutcome> {
  const first = harness.read();
  if (!first) return { kind: "unknown_launch", id };
  if (isTerminalStatus(first.status)) return { kind: "terminal", view: first };

  return await new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    let last: LaunchStatus = first.status;
    const cleanups: Array<() => void> = [];
    // BD-7: teardown for the currently-armed invalid-record bound (undefined when
    // no unreadable record is pending). Armed on the first pending observation,
    // disarmed when the record clears, so a transient unreadable read never trips a
    // terminal wake (F11) — only a PERSISTENTLY unreadable one, past the bound.
    let disarmInvalidBound: (() => void) | undefined;
    const settle = (o: WaitOutcome): void => {
      if (settled) return; // emit EXACTLY ONE observation even if events race
      settled = true;
      for (const c of cleanups) { try { c(); } catch { /* best-effort teardown */ } }
      resolve(o);
    };
    // BD-7: the bound expired while the exit record was still unreadable. Re-read
    // once: a record that became readable in the meantime is authoritative; a
    // launch that reached a terminal owner disposition wakes on that; otherwise the
    // record is persistently unreadable AND owner evidence went terminal, so we wake
    // on its reconciled disposition (owner_gone/unknown) — a completion, not silence.
    // A live owner never arms this bound (readLaunch leaves pendingUnreadableExit
    // unset), so we never fabricate a terminal over a still-running command.
    const wakeOnPersistentInvalid = (): void => {
      if (settled) return;
      const v = harness.read();
      if (!v) return;
      if (isTerminalStatus(v.status)) { settle({ kind: "terminal", view: v }); return; }
      if (v.pendingUnreadableExit) {
        const { pendingUnreadableExit, ...rest } = v;
        settle({ kind: "terminal", view: { ...rest, status: pendingUnreadableExit.terminal } });
      }
      // else the record cleared to genuinely-running between disarm and fire — leave
      // blocked; only a real terminal disposition wakes a genuinely-running launch.
    };
    const check = (): void => {
      if (settled) return;
      const v = harness.read();
      if (!v) return; // record transiently gone — not terminal on its own (BD-7)
      last = v.status;
      if (isTerminalStatus(v.status)) { settle({ kind: "terminal", view: v }); return; }
      if (v.pendingUnreadableExit) {
        // A PRESENT-but-unreadable record: arm the bound once so persistence wakes.
        if (!disarmInvalidBound) disarmInvalidBound = harness.startInvalidBound(wakeOnPersistentInvalid);
      } else if (disarmInvalidBound) {
        // The record cleared (readable, or genuinely-running) — cancel the bound so
        // a transient never trips a terminal wake (F11 transient).
        disarmInvalidBound();
        disarmInvalidBound = undefined;
      }
    };
    cleanups.push(harness.installWatcher(check));
    cleanups.push(harness.startReconcile(check));
    cleanups.push(harness.startTimeout(() => settle({ kind: "wait_timeout", id, lastObserved: last })));
    cleanups.push(harness.onCancel(() => settle({ kind: "wait_cancelled", id, lastObserved: last })));
    cleanups.push(() => { if (disarmInvalidBound) { disarmInvalidBound(); disarmInvalidBound = undefined; } });
    check(); // reread immediately after installing the watcher (BD-6)
  });
}

/** FG-552 (finding-1): the wait observer's view of a launch whose meta.json is
 *  PRESENT but unreadable/unparseable this read. It is a KNOWN launch (the record
 *  file exists), so the waiter must block-and-retry rather than refuse it as an
 *  unknown id. `status` stays `running` — an invitation to retry (F11) — and
 *  pendingUnreadableExit bounds it to a terminal `unknown` ("outcome could not be
 *  determined") if the meta never becomes readable. The meta fields live in the file
 *  we could not read, so they are left EMPTY, never invented — only `id` and `status`
 *  drive the observation the waiter renders. */
function unreadableMetaWaitView(id: string): LaunchView {
  return {
    id,
    command: [],
    tmuxSession: "",
    launcherPid: 0,
    ownerPid: null,
    startedAt: "",
    logPath: "",
    cwd: "",
    status: { state: "running" },
    forgeIds: { runIds: [], taskIds: [] },
    pendingUnreadableExit: { terminal: { state: "unknown" } },
  };
}

/** The real harness: node:fs.watch for the ordinary atomic-exit-record rename, a
 *  bounded interval for the reconciled-only dispositions (owner_gone / unknown),
 *  and SIGINT/SIGTERM as waiter cancellation. OQ-4: cancelling the WAITER only
 *  interrupts THIS process — it emits `wait_cancelled` and NEVER touches the
 *  tmux-owned work. This is a plain blocking wait (watch + reread), never a
 *  fixed-estimate model poll. */
export function realWaitHarness(
  id: string,
  opts: { tmux?: TmuxRunner; reconcileMs?: number; timeoutMs?: number; invalidBoundMs?: number; isLauncherAlive?: (pid: number) => boolean } = {},
): WaitHarness {
  const tmux = opts.tmux ?? defaultTmux;
  const dir = launchDir(id); // validates the id shape at the chokepoint
  const metaPath = join(dir, "meta.json");
  const reconcileMs = opts.reconcileMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const invalidBoundMs = opts.invalidBoundMs ?? DEFAULT_INVALID_BOUND_MS;
  return {
    read: () => {
      const v = readLaunch(id, tmux, opts.isLauncherAlive ?? launcherAlive);
      if (v) return v;
      // FG-552 (finding-1): readLaunch returns undefined for BOTH a genuinely-absent
      // record (ENOENT — an unknown launch id) AND a meta.json that is PRESENT but
      // unparseable/unreadable THIS read. The record-reader rule forbids collapsing
      // the two: an unparseable record is retryable, never terminal, so a KNOWN launch
      // whose meta is transiently unreadable must NOT be refused as "no such launch"
      // (exit 1) — that is the required unknown-id vs status-unknown distinction. When
      // the record file is present, surface it as running + a pending `unknown`
      // disposition, reusing the exact bounded-retry machinery the exit record uses: a
      // transient clears and reclassifies (F11), a persistently-corrupt meta wakes as
      // terminal `unknown` past the bound. Genuinely absent stays undefined ->
      // unknown_launch.
      return existsSync(metaPath) ? unreadableMetaWaitView(id) : undefined;
    },
    installWatcher: (onEvent) => {
      let w: FSWatcher | undefined;
      try { w = watch(dir, () => onEvent()); } catch { /* dir unwatchable; reconcile still covers it */ }
      return () => { try { w?.close(); } catch { /* already closed */ } };
    },
    startReconcile: (onTick) => {
      const t = setInterval(onTick, reconcileMs);
      return () => clearInterval(t);
    },
    startTimeout: (onFire) => {
      if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return () => { /* no timeout */ };
      const t = setTimeout(onFire, timeoutMs);
      return () => clearTimeout(t);
    },
    startInvalidBound: (onFire) => {
      // BD-7: the bound is finite by construction (production default is finite), so
      // a persistently-invalid record ALWAYS wakes — independent of `--timeout`. A
      // non-finite override degrades to a no-op rather than arming a bad timer.
      if (!(invalidBoundMs > 0) || !Number.isFinite(invalidBoundMs)) return () => { /* no bound */ };
      const t = setTimeout(onFire, invalidBoundMs);
      return () => clearTimeout(t);
    },
    onCancel: (cb) => {
      const h = (): void => cb();
      process.once("SIGINT", h);
      process.once("SIGTERM", h);
      return () => { process.off("SIGINT", h); process.off("SIGTERM", h); };
    },
  };
}
