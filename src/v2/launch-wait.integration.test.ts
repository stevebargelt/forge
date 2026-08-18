// FG-552: the blocking `forge launch wait` primitive over the REAL boundary —
// real tmux ownership, real fs.watch/reconcile, real atomic exit-record rename,
// and the F33 minimal-observer guarantee (the observer resolves with no native
// binding). A stub cannot prove these: only a real tmux-owned command that really
// finishes, and a real sabotaged better-sqlite3, exercise what this slice turns on.
//
// Requires tmux (present on ubuntu-latest, where the extended tier runs).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR, realWaitHarness, shellQuote, startLaunch, waitForLaunchTerminal, type LaunchStatus, type LaunchView, type WaitOutcome } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";
const loader = resolve(here, "..", "..", "bin", "forge-loader.mjs");

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const started: string[] = [];

/** Run the real forge CLI via tsx, exactly as bin/forge does in-process. */
function forge(args: string[]) {
  // FG-552 defensive bound: a blocking `forge launch wait` on a launch whose
  // disposition never arrives (the e2da08d signal-record regression hung CI 40+
  // min) is killed here so the test FAILS FAST instead of wedging the suite. The
  // bound is far above every legitimate blocking wait in this file (<= --timeout
  // 10s) and does NOT touch the production wait default.
  return spawnSync(tsx, [entry, ...args], { encoding: "utf8", env: process.env, timeout: 60_000, killSignal: "SIGKILL" });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Drive the REAL blocking wait over the REAL tmux/fs boundary with NO waiter
 *  timeout (timeoutMs: Infinity) — so the ONLY thing that can wake it is the launch
 *  reaching a terminal disposition, or the BD-7 invalid-record bound. `invalidBoundMs`
 *  is shortened so the blocking waits stay fast; a test-level safety timer FAILS the
 *  test (never hangs the suite) if the wait ever blocks past it — the observable proof
 *  that a broken bound would block forever. */
async function waitNoTimeout(id: string, invalidBoundMs: number, safetyMs = 25_000): Promise<WaitOutcome> {
  let timer: ReturnType<typeof setTimeout>;
  const safety = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`BD-7 FAIL: waitForLaunchTerminal (no --timeout) did not settle within ${safetyMs}ms — a persistently-invalid record blocked forever`)), safetyMs);
  });
  try {
    return await Promise.race([waitForLaunchTerminal(id, realWaitHarness(id, { invalidBoundMs, timeoutMs: Infinity })), safety]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Run forge with an EXTRA ESM loader hook chained after tsx, used to make
 *  better-sqlite3 unresolvable for the F33 test. Mirrors bin/forge's exec line
 *  (node --import forge-loader.mjs <entry>), plus --import <register> so the
 *  sabotage hook is registered after tsx and intercepts the native import. */
function forgeWithSabotage(register: string, args: string[]) {
  return spawnSync("node", ["--import", loader, "--import", register, entry, ...args], { encoding: "utf8", env: process.env });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

after(() => {
  for (const id of started) {
    try { execFileSync("tmux", ["kill-session", "-t", `forge-${id}`], { stdio: "ignore" }); } catch { /* gone */ }
  }
});

test("FG-552 F5 (real): forge launch wait BLOCKS on a running launch, then observes exited_ok with exit status 0 — the launch's own code is DATA", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["sh", "-c", "sleep 0.6; exit 0"], { name: "waitok" });
  started.push(meta.id);

  // The wait is started while the command is still running — it must block on the
  // real fs.watch/reconcile until the atomic exit record lands, not return early.
  const t0 = Date.now();
  const res = forge(["launch", "wait", meta.id, "--json"]);
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 0, `wait should exit 0 on a terminal observation: ${res.stderr}`);
  const obs = JSON.parse(res.stdout) as { kind: string; status: { state: string; code?: number } };
  assert.equal(obs.kind, "terminal");
  assert.deepEqual(obs.status, { state: "exited_ok", code: 0 });
  assert.ok(elapsed > 300, `wait blocked until completion (elapsed ${elapsed}ms)`);
});

test("FG-552 F6 (real): an ordinary non-zero exit reads exited_error — failure is a completion, not still-running", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["sh", "-c", "exit 7"], { name: "waiterr" });
  started.push(meta.id);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const res = forge(["launch", "wait", meta.id, "--json"]);
  assert.equal(res.status, 0, "the WAITER succeeds — the launch's exit code is data");
  const obs = JSON.parse(res.stdout) as { kind: string; status: { state: string; code?: number } };
  assert.deepEqual(obs.status, { state: "exited_error", code: 7 });
});

test("FG-552 F7 (real): an OS-signalled tmux-owned workload is recorded WIFSIGNALED (signal, no code) ATOMICALLY, and forge launch wait unblocks with the signal and an UNRECORDED sender", async () => {
  if (!hasTmux) return;
  const pidDir = mkdtempSync(join(tmpdir(), "fg552-f7-"));
  const pidFile = join(pidDir, "workload.pid");
  try {
    // The workload publishes its OWN pid, then becomes `sleep` at that SAME pid via
    // exec — so the pid we signal IS the process the recorder's spawnSync is waiting
    // on. No process-tree walking and no argv matching (FG-492): a deterministic
    // handle on the real, OS-owned child the recorder observes.
    const meta = startLaunch(["sh", "-c", `echo $$ > ${shellQuote(pidFile)}; exec sleep 600`], { name: "signalled" });
    started.push(meta.id);

    await waitFor("the workload to publish its pid", () => {
      try { return readFileSync(pidFile, "utf8").trim().length > 0; } catch { return false; }
    });
    const workloadPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(workloadPid) && workloadPid > 0, "the workload published a real pid");

    // OS-signal the REAL workload. The recorder's spawnSync returns the kernel's
    // WIFSIGNALED verdict (signal SIGKILL, status null) — NOT a 143-shaped code — and
    // commits {code:null, signal:"SIGKILL"} atomically (temp file + rename) as its
    // last act. This is the production signal-recording path the stubbed F7 unit test
    // cannot exercise.
    process.kill(workloadPid, "SIGKILL");

    await waitFor("the atomic signal exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    const dir = join(LAUNCHES_DIR, meta.id);
    assert.deepEqual(readdirSync(dir).filter((e) => e.startsWith("exit.tmp")), [], "atomic rename left no temp remnant");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "exit"), "utf8")), { code: null, signal: "SIGKILL" },
      "the recorder committed the OS WIFSIGNALED verdict — signal, no numeric code");

    // The wait primitive unblocks from the REAL completion with signal evidence and
    // NO sender attribution — the sender is never inferred (a signal proves a signal
    // landed, not who sent it).
    const res = forge(["launch", "wait", meta.id, "--json"]);
    assert.equal(res.status, 0, `wait observes the signaled terminal disposition: ${res.stderr}`);
    const obs = JSON.parse(res.stdout) as { kind: string; status: { state: string; signal?: string; sender?: string } };
    assert.equal(obs.kind, "terminal");
    assert.deepEqual(obs.status, { state: "signaled", signal: "SIGKILL", sender: "unrecorded" });
  } finally {
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("FG-552 F4 (real): the exit record is PUBLISHED ATOMICALLY — a reader CONCURRENT with the write never observes a partial `exit`, only absent-or-complete; a bare non-atomic write IS observably torn (the RED baseline the atomic temp+rename fixes)", async () => {
  if (!hasTmux) return;

  // First: the real production launch's exit write leaves no remnant and a complete
  // record (the property the observer depends on end-to-end).
  const meta = startLaunch(["true"], { name: "atomicexit" });
  started.push(meta.id);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const dir = join(LAUNCHES_DIR, meta.id);
  assert.deepEqual(readdirSync(dir).filter((e) => e.startsWith("exit.tmp")), [], "atomic rename left no temp remnant");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "exit"), "utf8")), { code: 0, signal: null });

  // Now the interleave the OLD F4 test never exercised. The pre-atomic writer was a
  // bare write to `exit`; the shipped one writes a sibling temp then renames it into
  // place (launch.ts exitRecorderScript). We drive BOTH strategies in a CHILD process
  // (writeFileSync blocks the event loop, so a same-process reader could never land
  // mid-write) and explicitly hold the writer after its first half. This makes the
  // RED baseline a real, cross-filesystem state rather than hoping one write tears.
  //   atomic  → `exit` is NEVER seen at a partial size — absent, then complete-via-rename;
  //   bare    → `exit` IS seen partial (torn) — the RED baseline. If this ever stops
  //             holding the payload is too small; it is what makes the atomic assert non-trivial.
  const workDir = mkdtempSync(join(tmpdir(), "fg552-f4-"));
  try {
    const padBytes = 1024;

    // The child writes half the payload, announces that state, then writes the rest.
    // A bare writer therefore exposes a deterministic partial `exit`; an atomic writer
    // exposes that same partial state only at its private temp path.
    async function observeWrite(strategy: "atomic" | "bare"): Promise<{ sawPartial: boolean; final: unknown }> {
      const exitPath = join(workDir, `exit-${strategy}`);
      const tmpPath = `${exitPath}.tmp`;
      const readyPath = `${exitPath}.ready`;
      rmSync(exitPath, { force: true });
      rmSync(tmpPath, { force: true });
      rmSync(readyPath, { force: true });
      // `node -e <script> A B C` exposes A as argv[1], B as argv[2], C as argv[3].
      const script =
        strategy === "atomic"
          ? `const fs=require("fs");const b=JSON.stringify({code:0,signal:null,pad:"x".repeat(${padBytes})});const h=fs.openSync(process.argv[1],"w");fs.writeSync(h,b.slice(0,b.length/2));fs.writeFileSync(process.argv[3],"ready");setTimeout(()=>{fs.writeSync(h,b.slice(b.length/2));fs.closeSync(h);fs.renameSync(process.argv[1],process.argv[2]);},100);`
          : `const fs=require("fs");const b=JSON.stringify({code:0,signal:null,pad:"x".repeat(${padBytes})});const h=fs.openSync(process.argv[2],"w");fs.writeSync(h,b.slice(0,b.length/2));fs.writeFileSync(process.argv[3],"ready");setTimeout(()=>{fs.writeSync(h,b.slice(b.length/2));fs.closeSync(h);},100);`;
      const full = Buffer.byteLength(JSON.stringify({ code: 0, signal: null, pad: "x".repeat(padBytes) }));
      const child = spawn(process.execPath, ["-e", script, tmpPath, exitPath, readyPath], { stdio: "ignore" });
      let sawPartial = false;
      let done = false;
      child.on("exit", () => { done = true; });
      await waitFor("the deliberately held half-write", () => existsSync(readyPath));
      try {
        const size = statSync(exitPath).size;
        sawPartial = size > 0 && size < full;
      } catch { /* ENOENT — the atomic strategy only exposes its temp file here */ }
      while (!done) {
        await new Promise((r) => setImmediate(r));
      }
      const final = existsSync(exitPath) ? (JSON.parse(readFileSync(exitPath, "utf8")) as unknown) : undefined;
      return { sawPartial, final };
    }

    const atomic = await observeWrite("atomic");
    assert.equal(atomic.sawPartial, false, "ATOMIC: a concurrent reader NEVER observes `exit` partially written — the temp+rename publishes it whole");
    const atomicFinal = atomic.final as { code: number; signal: null; pad: string };
    assert.equal(atomicFinal.code, 0, "ATOMIC: the finally-observed `exit` is the complete, parseable record");
    assert.equal(atomicFinal.signal, null);
    assert.equal(atomicFinal.pad.length, padBytes, "ATOMIC: the complete record — never a truncated fragment");

    const bare = await observeWrite("bare");
    assert.equal(bare.sawPartial, true, "RED baseline: a bare non-atomic writeFileSync IS observably torn — `exit` is seen present-but-partial mid-write (this is what the atomic write fixes)");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("FG-552 BD-7 (real / 1a): a PRESENT-but-invalid exit record with a GONE owner wakes waitForLaunchTerminal to a TERMINAL disposition (unknown) — NOT `running` forever, WITHOUT any waiter --timeout", async () => {
  if (!hasTmux) return;
  // A live launch, an invalid exit record present, then the owner GONE (session
  // killed). Pre-BD-7 the reader collapsed this to `running` forever (an unreadable
  // record blocked EVERY owner-terminal verdict), so a no-timeout wait hung. BD-7:
  // after a bounded retry the gone owner decides — terminal `unknown` — a wake, not
  // silence. Driven over the REAL boundary (real tmux + real fs + real readLaunch).
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "bd7-gone" });
  started.push(meta.id);
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{}"); // schema-invalid, unreadable
  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" }); // owner gone: no session

  const o = await waitNoTimeout(meta.id, 800);
  assert.equal(o.kind, "terminal", "BD-7 1a: an unreadable record + gone owner reaches a terminal disposition, never a hang");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "unknown" }, "the gone owner (no session) decides: terminal unknown");
});

test("FG-552 BD-7 (real / 1b): a PERSISTENTLY-invalid exit record with a LIVE owner is NEVER promoted to a terminal — the invalid bound never arms, only --timeout bounds it", async () => {
  if (!hasTmux) return;
  // The BD-7 policy (PRD: "only terminal after independent terminal owner evidence"):
  // a confirmed-live owner is NOT terminal evidence. With temp+rename a present exit
  // record is never torn, so a corrupt record next to a LIVE pane is spurious and the
  // tmux-owned command is demonstrably still running. It must NOT be fabricated into a
  // terminal `unknown` — that is the exact FALSE COMPLETION FG-552 prevents. So
  // readLaunch surfaces no pending disposition, the invalid-record bound never arms,
  // and ONLY the waiter's own --timeout bounds the wait (a wait_timeout, never a launch
  // terminal). Driven over the REAL boundary (real tmux + real fs + real readLaunch).
  // The invalid bound is set SHORTER than --timeout: were the live-owner path to wrongly
  // arm it, it would fire first as a terminal — so a wait_timeout here also proves it
  // never armed. A bounded safety timer guarantees the test never hangs.
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "bd7-live" });
  started.push(meta.id);
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":null,"signal":null}`); // invalid; owner stays alive

  const harness = realWaitHarness(meta.id, { timeoutMs: 2000, invalidBoundMs: 400, reconcileMs: 200 });
  const safety = delay(20_000).then(() => { throw new Error("BD-7 1b FAIL: the live-owner wait never settled on its --timeout"); });
  const o = await Promise.race([waitForLaunchTerminal(meta.id, harness), safety]);
  assert.equal(o.kind, "wait_timeout", "BD-7 1b: a live owner + persistently-invalid record bounds on --timeout, NEVER a fabricated terminal from the invalid bound");
  assert.deepEqual((o as { lastObserved: LaunchStatus }).lastObserved, { state: "running" }, "the launch was observed still running the whole time — the live-owned command is not terminaled");
});

test("FG-552 BD-7 (real / F11 transient — regression): an invalid record that becomes READABLE within the bound classifies NORMALLY (exited_ok), never a premature terminal", async () => {
  if (!hasTmux) return;
  // The reconciliation with F11: a TRANSIENT unreadable record must NOT be prematurely
  // terminaled. Start the wait with a LONG bound (60s, so it cannot fire during the
  // test) on a launch whose exit record is momentarily invalid, then replace it with a
  // valid record — the waiter must wake on the TRUE classification, never the pending
  // reconciled disposition.
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "bd7-transient" });
  started.push(meta.id);
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{}"); // transiently unreadable

  const harness = realWaitHarness(meta.id, { invalidBoundMs: 60_000, timeoutMs: Infinity });
  const p = waitForLaunchTerminal(meta.id, harness);
  await delay(500); // WELL within the 60s bound
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":0,"signal":null}`); // becomes readable

  const safety = delay(20_000).then(() => { throw new Error("F11 transient FAIL: the readable record was never classified"); });
  const o = await Promise.race([p, safety]);
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_ok", code: 0 },
    "the record became readable within the bound → classified normally, NEVER the pending unknown (F11 preserved)");
});

test("FG-552: an already-terminal launch returns immediately (no blocking)", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["true"], { name: "already" });
  started.push(meta.id);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const t0 = Date.now();
  const res = forge(["launch", "wait", meta.id, "--json"]);
  assert.equal(res.status, 0);
  assert.ok(Date.now() - t0 < 8000, "an already-terminal launch is observed without a long block");
});

test("FG-552: an unknown launch id is refused DISTINCTLY (exit 1) from a known launch whose status is unknown", async () => {
  if (!hasTmux) return;
  const res = forge(["launch", "wait", "launch-does-not-exist-000000", "--json"]);
  assert.equal(res.status, 1, "an unknown id is a refusal, not a terminal observation");
  const obs = JSON.parse(res.stdout) as { kind: string };
  assert.equal(obs.kind, "unknown_launch");
});

test("FG-552: --timeout yields an explicit wait_timeout (exit 124), NEVER a fabricated launch terminal state", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["sh", "-c", "sleep 30"], { name: "waittmo" });
  started.push(meta.id);

  const res = forge(["launch", "wait", meta.id, "--json", "--timeout", "1"]);
  assert.equal(res.status, 124, "a waiter timeout has its own exit code");
  const obs = JSON.parse(res.stdout) as { kind: string; lastObserved: { state: string } };
  assert.equal(obs.kind, "wait_timeout");
  assert.equal(obs.lastObserved.state, "running", "the last observed state is reported honestly, not fabricated terminal");
});

test("FG-552 F10 (real / OQ-5): a launch whose tmux server is gone with no exit record reconciles to unknown — the safe default, observed via the reconcile tick", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["sh", "-c", "sleep 30"], { name: "reboot" });
  started.push(meta.id);
  // Simulate a host reboot: kill the tmux server holding the launch, no exit
  // record ever written. This produces NO filesystem artifact — only the
  // reconcile tick, re-reading tmux liveness, can observe it.
  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" });
  assert.ok(!existsSync(join(LAUNCHES_DIR, meta.id, "exit")), "precondition: no exit record");

  const res = forge(["launch", "wait", meta.id, "--json", "--timeout", "10"]);
  assert.equal(res.status, 0, "unknown is a terminal disposition — a successful observation");
  const obs = JSON.parse(res.stdout) as { kind: string; status: { state: string } };
  assert.equal(obs.kind, "terminal");
  assert.equal(obs.status.state, "unknown");
});

test("FG-552 F33 (real): the minimal observer resolves with NO native binding — forge launch wait observes+reports when better-sqlite3 cannot load, while a registry-loading command (forge status) dies under the same sabotage", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["true"], { name: "f33" });
  started.push(meta.id);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  // An ESM loader hook (chained after tsx) that makes better-sqlite3 unresolvable
  // — the ABI-incompatible / absent-binding failure mode reproduced
  // deterministically. Any import path that reaches the native binding dies here.
  const hookDir = mkdtempSync(join(tmpdir(), "fg552-sabotage-"));
  writeFileSync(
    join(hookDir, "hooks.mjs"),
    `export async function resolve(s,c,n){if(s==="better-sqlite3")throw new Error("SABOTAGED: better-sqlite3 cannot load");return n(s,c);}`,
  );
  const register = join(hookDir, "register.mjs");
  writeFileSync(register, `import{register}from"node:module";register("./hooks.mjs",import.meta.url);`);

  try {
    // The observer path: dispatched BEFORE node-preflight and the command
    // registry, its graph is node:fs + launch.js only — it never imports the
    // native binding, so it still observes + reports.
    const wait = forgeWithSabotage(register, ["launch", "wait", meta.id, "--json"]);
    assert.equal(wait.status, 0, `wait must observe under a broken native binding: ${wait.stderr}`);
    assert.doesNotMatch(`${wait.stdout}${wait.stderr}`, /SABOTAGED/, "the observer never touched the sabotaged binding");
    const obs = JSON.parse(wait.stdout) as { kind: string; status: { state: string } };
    assert.equal(obs.kind, "terminal");
    assert.equal(obs.status.state, "exited_ok");

    // The control: a command that loads the registry (→ store → better-sqlite3)
    // DIES under the same sabotage, proving the binding really is unresolvable and
    // that the observer's survival is the fast path, not an inert hook. (`forge
    // launch list` — also a launch subcommand, but NOT the fast-pathed observer —
    // dies the same way, which is exactly why the observer needed the fast path.)
    const status = forgeWithSabotage(register, ["status", "--json"]);
    assert.notEqual(status.status, 0, "forge status loads the registry → the sabotaged binding must break it");
    assert.match(`${status.stdout}${status.stderr}`, /SABOTAGED/, "status died on the sabotaged native binding");
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
  }
});
