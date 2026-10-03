// FG-826: one shared harness for every dashboard integration suite that boots a REAL process
// (`tsx src/server.ts` and the remote-board listener it starts). In agent containers these suites
// used to pend indefinitely: a boot that missed its readiness poll threw, but the children it had
// already spawned were never killed, so they held the test file's event loop open and the runner
// blocked until an operator `docker exec kill`ed them. Every real boot now goes through here:
// a precondition probe BEFORE the spawn, a bounded startup wait that kills the child's whole
// process group on timeout, and an after() sweep that reaps any child a test left behind.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { delimiter, join } from "node:path";

/** Bound on one real boot, from spawn to its ready marker (and readiness probe, when given).
 *  FORGE_REAL_BOOT_STARTUP_TIMEOUT_MS overrides it so the FG-826 regressions run in seconds. */
export const REAL_BOOT_STARTUP_TIMEOUT_MS = Number(process.env.FORGE_REAL_BOOT_STARTUP_TIMEOUT_MS) || 30_000;
/** Bound on one real-boot test, boots included: pass it as the test's `timeout`. */
export const REAL_BOOT_TEST_TIMEOUT_MS = 120_000;
/** SIGTERM grace before a process group is SIGKILLed. */
export const REAL_BOOT_KILL_GRACE_MS = 3_000;
/** What `src/server.ts` prints once its local listener is bound. */
export const DASHBOARD_READY_MARKER = /forge-dashboard listening at /;

/** Every dashboard integration suite that boots a real process. docker/forge-test.sh carries the
 *  same list (it refuses the whole dashboard integration tier in a container by naming these);
 *  real-boot.test.ts fails if the two, or the suites' actual spawn sites, drift apart. */
export const REAL_BOOT_SUITES = [
  "src/fg836-ops-queries-concurrency.integration.test.ts",
  "src/remote/remote-board.e2e.integration.test.ts",
  "src/remote/tailscale/serve-process.integration.test.ts",
] as const;

/** Test-only fault seam for real-boot.integration.test.ts, which runs each real-boot suite with a
 *  prerequisite knocked out: `hide-binary:<name>` (that binary is treated as absent from PATH),
 *  `missing-entry` (every boot entry path is replaced by one that does not exist), `exit-early`
 *  (the boot child exits before its marker), `never-ready`
 *  (the boot spawns a child — with a grandchild — that never prints its ready marker, and names
 *  both pids in FORGE_REAL_BOOT_PID_FILE when set, since its output only surfaces on failure). */
const FAULT = process.env.FORGE_REAL_BOOT_FAULT ?? "";
const NEVER_READY_CHILD =
  "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});" +
  "const line='fg826-never-ready pids '+process.pid+' '+c.pid;console.error(line);" +
  "if(process.env.FORGE_REAL_BOOT_PID_FILE)require('node:fs').appendFileSync(process.env.FORGE_REAL_BOOT_PID_FILE,line+'\\n');" +
  "setInterval(()=>{},1e9)";
const EARLY_EXIT_CHILD = "console.error('fg826 injected child exited early'); process.exit(37)";

const CI_AUTHORITY = "CI (dashboard_integration) is the authority for this suite";
const STDERR_TAIL_LINES = 30;

export function preconditionMissing(what: string): never {
  assert.fail(`FG-826 precondition missing: ${what} — ${CI_AUTHORITY}`);
}

function onPath(binary: string, path: string): boolean {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch { /* not in this dir */ }
  }
  return false;
}

/** Fail fast, by name, when anything a real boot needs is absent — before anything is spawned. */
export async function probeRealBootPreconditions(opts: { files: string[]; binaries?: string[]; path?: string }): Promise<void> {
  const files = FAULT === "missing-entry" ? opts.files.map((file) => `${file}.fg826-absent`) : opts.files;
  for (const file of files) {
    if (!existsSync(file)) preconditionMissing(`boot entry ${file} does not exist`);
  }
  const path = opts.path ?? process.env.PATH ?? "";
  for (const binary of opts.binaries ?? []) {
    if (FAULT === `hide-binary:${binary}` || !onPath(binary, path)) preconditionMissing(`${binary} binary not on PATH`);
  }
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.once("error", () => resolve());
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = probe.listening;
  if (bound) await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!bound) preconditionMissing("no free loopback port (127.0.0.1 refused a listener)");
}

export interface RealBoot {
  label: string;
  child: ChildProcess;
  /** Settles once the child has exited AND its output streams are drained. */
  closed: Promise<void>;
  outputTail(): string;
}

const live = new Set<RealBoot>();

/** Spawn a real-boot child in its OWN process group (so tsx and the node it forks die together)
 *  and register it for the after() sweep. stdout/stderr are kept as a bounded tail for failures. */
export function spawnRealBoot(label: string, command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): RealBoot {
  if (FAULT === "never-ready") [command, args] = [process.execPath, ["-e", NEVER_READY_CHILD]];
  if (FAULT === "exit-early") [command, args] = [process.execPath, ["-e", EARLY_EXIT_CHILD]];
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    if (lines.length > STDERR_TAIL_LINES) lines.splice(0, lines.length - STDERR_TAIL_LINES);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const boot: RealBoot = { label, child, closed, outputTail: () => lines.join("\n") };
  live.add(boot);
  child.once("exit", () => live.delete(boot));
  return boot;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, ms);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** SIGTERM the child's process group, then SIGKILL it if it outlives the grace. Never hangs on an
 *  already-exited child (the old `child.once("exit")` waited forever for one). */
export async function stopRealBoot(boot: RealBoot): Promise<void> {
  if (!exited(boot.child)) {
    signalGroup(boot.child, "SIGTERM");
    if (!(await waitExit(boot.child, REAL_BOOT_KILL_GRACE_MS))) {
      signalGroup(boot.child, "SIGKILL");
      await waitExit(boot.child, REAL_BOOT_KILL_GRACE_MS);
    }
  }
  // The group leader's exit does not prove its forked node child is gone.
  signalGroup(boot.child, "SIGKILL");
  live.delete(boot);
}

/** Register in every real-boot suite: `after(stopAllRealBoots)`. */
export async function stopAllRealBoots(): Promise<void> {
  await Promise.all([...live].map(stopRealBoot));
}

// Last resort if the test process itself is torn down without running after(). A detached group
// does not receive a signal aimed at ours (an interrupted runner, `timeout`), and a signal death
// skips "exit" handlers, so the signals are caught too. SIGTERM goes first: a group may hold a
// nested test process whose own handler must still reap ITS detached children, which an
// immediate SIGKILL would orphan.
const signalAll = (signal: NodeJS.Signals) => { for (const boot of live) signalGroup(boot.child, signal); };
process.once("exit", () => signalAll("SIGTERM"));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(signal, () => {
    signalAll("SIGTERM");
    setTimeout(() => {
      signalAll("SIGKILL");
      process.kill(process.pid, signal);
    }, live.size ? 1_000 : 0);
  });
}

/** Wait until the child prints `readyMarker` (and `probe`, when given, answers true), bounded by
 *  `timeoutMs`. On timeout or an early exit the process group is killed and the test fails with a
 *  named reason plus the child's last output lines. */
export async function awaitBootOrFail(
  boot: RealBoot,
  opts: { readyMarker: RegExp; probe?: () => Promise<boolean>; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? REAL_BOOT_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let seen = opts.readyMarker.test(boot.outputTail());
  const watch = (chunk: Buffer) => { if (opts.readyMarker.test(String(chunk))) seen = true; };
  boot.child.stdout?.on("data", watch);
  boot.child.stderr?.on("data", watch);
  try {
    while (Date.now() < deadline) {
      if (exited(boot.child)) {
        await stopRealBoot(boot);
        await Promise.race([boot.closed, new Promise((resolve) => setTimeout(resolve, REAL_BOOT_KILL_GRACE_MS))]);
        assert.fail(
          `FG-826 real boot failed: ${boot.label} exited (code ${boot.child.exitCode}, signal ${boot.child.signalCode}) before it was ready — ${CI_AUTHORITY}\n--- last child output ---\n${boot.outputTail()}`,
        );
      }
      if (seen && (!opts.probe || (await opts.probe().catch(() => false)))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await stopRealBoot(boot);
    assert.fail(
      `FG-826 real boot timed out: ${boot.label} was not ready within ${timeoutMs}ms (REAL_BOOT_STARTUP_TIMEOUT_MS); its process group was killed — ${CI_AUTHORITY}\n--- last child output ---\n${boot.outputTail()}`,
    );
  } finally {
    boot.child.stdout?.off("data", watch);
    boot.child.stderr?.off("data", watch);
  }
}

/** A fetch-based readiness probe that cannot itself hang on a half-open listener. */
export function httpReady(url: string, accept: (status: number) => boolean = (status) => status >= 200 && status < 300): () => Promise<boolean> {
  return async () => accept((await fetch(url, { signal: AbortSignal.timeout(2_000) })).status);
}

export async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
