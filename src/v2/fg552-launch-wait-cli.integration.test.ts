// FG-552 verify (integration): the `forge launch wait` primitive over the REAL
// CLI boundary — real `forge launch run` under a real tmux owner, the real
// atomic exit record, real fs.watch + reconcile, real process signals. These
// close the gaps the engineer's own suite leaves: it asserts only `--json` shape
// and drives the wait loop through an INJECTED harness (unit). Here every case
// runs the actual `bin/forge` entry (node --import forge-loader.mjs src/cli/index.ts,
// byte-for-byte what bin/forge exec's), and the assertions cover the HUMAN render
// path, real SIGINT cancellation + the wait.log audit, timeout NON-alteration, the
// signal-range terminated_unattributed disposition, and owner_gone via real
// reconciliation — none of which the committed tests exercise at the boundary.
//
// Requires tmux (present on ubuntu-latest, where the integration tier runs).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const loader = resolve(here, "..", "..", "bin", "forge-loader.mjs");

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const started: string[] = [];

/** Exec the REAL forge CLI exactly as bin/forge does: one node process, tsx
 *  loaded in-process via --import forge-loader.mjs, then src/cli/index.ts. */
function forge(args: string[], env: NodeJS.ProcessEnv = process.env) {
  // FG-552 defensive bound: a blocking `forge launch wait` whose disposition never
  // arrives (the e2da08d signal-record regression hung CI 40+ min) is killed here
  // so the test FAILS FAST instead of wedging the suite. Far above every
  // legitimate blocking wait here; does NOT change the production wait default.
  return spawnSync("node", ["--import", loader, entry, ...args], { encoding: "utf8", env, timeout: 60_000, killSignal: "SIGKILL" });
}

/** Chain an extra ESM loader hook after tsx — used to make better-sqlite3
 *  unresolvable for the F33 native-free-observer contrast. */
function forgeWithSabotage(register: string, args: string[]) {
  return spawnSync("node", ["--import", loader, "--import", register, entry, ...args], { encoding: "utf8", env: process.env });
}

/** Start a launch through the REAL `forge launch run` CLI and return its meta. */
function launchRun(command: string[], name: string): { id: string; tmuxSession: string; ownerPid: number | null; logPath: string } {
  const res = forge(["launch", "run", "--json", "--name", name, "--", ...command]);
  assert.equal(res.status, 0, `forge launch run failed: ${res.stderr}`);
  const meta = JSON.parse(res.stdout) as { id: string; tmuxSession: string; ownerPid: number | null; logPath: string };
  started.push(meta.id);
  return meta;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const exitFile = (id: string) => join(LAUNCHES_DIR, id, "exit");

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

after(() => {
  for (const id of started) {
    try { execFileSync("tmux", ["kill-session", "-t", `forge-${id}`], { stdio: "ignore" }); } catch { /* gone */ }
  }
});

test("FG-552 CLI: forge launch wait reports a clean exit as exited_ok in BOTH json and HUMAN output (the human render path the engineer's --json-only suite never exercises)", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "sleep 0.4; exit 0"], "cliok");
  // Observe the completed launch. We deliberately let the exit record LAND FIRST so
  // this test reads a STABLE terminal disposition — the blocking behaviour itself is
  // proven by the --timeout test below, and settling this on a launch that completes
  // mid-read would collide with the readLaunch exit/pane read-atomicity race (see the
  // finding in the verify result). The observation disposition is what we assert here.
  await waitFor("the exit record", () => existsSync(exitFile(meta.id)));

  const jsonRes = forge(["launch", "wait", meta.id, "--json"]);
  assert.equal(jsonRes.status, 0, `wait should exit 0 on a terminal observation: ${jsonRes.stderr}`);
  const obs = JSON.parse(jsonRes.stdout) as { kind: string; status: { state: string; code?: number } };
  assert.equal(obs.kind, "terminal");
  assert.deepEqual(obs.status, { state: "exited_ok", code: 0 });

  // HUMAN output, rendered without --json
  const humanRes = forge(["launch", "wait", meta.id]);
  assert.equal(humanRes.status, 0);
  assert.match(humanRes.stdout, /is terminal — exited 0/, "human render states the terminal disposition via the single status vocabulary");
  assert.doesNotMatch(humanRes.stdout, /^\{/, "human output is not JSON");
});

test("FG-552 CLI: an ordinary non-zero exit reads exited_error and the WAITER still exits 0 — the launch's code is DATA, in human output too", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "exit 7"], "clierr");
  await waitFor("the exit record", () => existsSync(exitFile(meta.id)));

  const res = forge(["launch", "wait", meta.id]);
  assert.equal(res.status, 0, "the WAITER succeeds — a launch failing is a completion, not a waiter error");
  assert.match(res.stdout, /is terminal — exited 7/, "the launch's non-zero code is carried as data in the observation");
});

test("FG-552 CLI: a DELIBERATE signal-range exit code (143) reads terminated_unattributed — never inferred as killed-by-signal — and wait exits 0 (classifyExit's 128<code<165 branch over the real boundary)", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "exit 143"], "clisig");
  await waitFor("the exit record", () => existsSync(exitFile(meta.id)));

  // Precondition: the recorder wrote a code, NOT a signal — the whole point of the
  // node runner is that a deliberate 143 is {code:143,signal:null}, never confused
  // with WIFSIGNALED.
  assert.deepEqual(JSON.parse(readFileSync(exitFile(meta.id), "utf8")), { code: 143, signal: null });

  const res = forge(["launch", "wait", meta.id, "--json"]);
  assert.equal(res.status, 0, "a terminal observation is a success regardless of the launch's own code");
  const obs = JSON.parse(res.stdout) as { kind: string; status: { state: string; code?: number } };
  assert.equal(obs.kind, "terminal");
  assert.deepEqual(obs.status, { state: "terminated_unattributed", code: 143 }, "a signal-range code with no signal evidence stays unattributed");
});

test("FG-552 CLI: an unknown launch id is DISTINCT from a known launch whose status is 'unknown' — different exit codes AND different human messages, side by side over the real CLI", async () => {
  if (!hasTmux) return;

  // A real known launch whose derived status is 'unknown': start it, then kill the
  // tmux server with no exit record ever written (the host-reboot shape, OQ-5).
  const meta = launchRun(["sh", "-c", "sleep 15"], "cliknown");
  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" });
  assert.ok(!existsSync(exitFile(meta.id)), "precondition: no exit record");

  const known = forge(["launch", "wait", meta.id, "--timeout", "10"]);
  assert.equal(known.status, 0, "a KNOWN launch that is terminally 'unknown' is a SUCCESSFUL observation (exit 0)");
  assert.match(known.stdout, /is terminal — unknown \(no exit record, owner gone/, "known-unknown renders as a terminal disposition");

  const unknown = forge(["launch", "wait", "launch-does-not-exist-000000"]);
  assert.equal(unknown.status, 1, "an UNKNOWN launch id is a refusal (exit 1), not a terminal observation");
  assert.match(unknown.stderr, /no such launch 'launch-does-not-exist-000000' — unknown launch id \(DISTINCT/, "the refusal names itself distinct from a known-unknown status");

  // The two must not be conflatable: different exit codes, and the refusal text is
  // nowhere in the terminal observation.
  assert.notEqual(known.status, unknown.status);
  assert.doesNotMatch(known.stdout, /no such launch/, "the known-unknown observation never says 'no such launch'");
});

test("FG-552 CLI: --timeout on a still-running launch yields wait_timeout (exit 124) AND leaves the launch UNALTERED — the tmux session survives and its status is still running", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "sleep 30"], "clitmo");

  const res = forge(["launch", "wait", meta.id, "--json", "--timeout", "1"]);
  assert.equal(res.status, 124, "a waiter timeout has its own exit code, distinct from every launch disposition");
  const obs = JSON.parse(res.stdout) as { kind: string; lastObserved: { state: string } };
  assert.equal(obs.kind, "wait_timeout");
  assert.equal(obs.lastObserved.state, "running", "the last observed state is reported honestly, never a fabricated terminal");

  // NON-alteration: the waiter timing out must not have touched the work.
  const sessionAlive = spawnSync("tmux", ["has-session", "-t", meta.tmuxSession]).status === 0;
  assert.ok(sessionAlive, "the tmux-owned launch survives a waiter timeout untouched");
  const show = forge(["launch", "show", meta.id, "--json"]);
  assert.equal(show.status, 0);
  const view = JSON.parse(show.stdout) as { status: { state: string } };
  assert.equal(view.status.state, "running", "the launch is still running after the waiter gave up — the waiter owns none of the work");

  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" });
});

test("FG-552 CLI (OQ-4): SIGINT cancels the WAITER only — it exits wait_cancelled (130), the launch is STILL running afterward, and a wait.log audit line is written", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "sleep 30"], "clicancel");

  // Spawn the real blocking wait as a child so we can interrupt it with a real
  // SIGINT — the engineer only exercises cancellation through the injected harness.
  const child = spawn("node", ["--import", loader, entry, "launch", "wait", meta.id, "--json"], { env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  // Give the process time to boot, read the running record, and ARM its SIGINT
  // handler (onCancel registers process.once('SIGINT')). Only then is the signal a
  // waiter-cancellation rather than the default kill.
  await new Promise((r) => setTimeout(r, 3000));
  child.kill("SIGINT");

  // FG-552 defensive bound: if the SIGINT handler ever fails to arm/settle, do not
  // wait on child exit forever — SIGKILL it after a bound so the assertion below
  // fails fast (exit.code !== 130) instead of hanging the suite.
  const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const exit = await new Promise<{ code: number | null; signal: string | null }>((res) =>
    child.on("exit", (code, signal) => res({ code, signal })),
  );
  clearTimeout(guard);

  assert.equal(exit.code, 130, `the waiter exits 130 via its own handler (stdout=${stdout} stderr=${stderr})`);
  const obs = JSON.parse(stdout) as { kind: string; lastObserved: { state: string } };
  assert.equal(obs.kind, "wait_cancelled");
  assert.equal(obs.lastObserved.state, "running", "the last observed launch state is honestly running — the waiter never fabricates a terminal");

  // The tmux-owned WORK is untouched: session alive and status still running.
  const sessionAlive = spawnSync("tmux", ["has-session", "-t", meta.tmuxSession]).status === 0;
  assert.ok(sessionAlive, "OQ-4: cancelling the waiter must NOT touch the tmux-owned launch");
  const show = forge(["launch", "show", meta.id, "--json"]);
  const view = JSON.parse(show.stdout) as { status: { state: string } };
  assert.equal(view.status.state, "running", "the underlying launch survived the waiter's cancellation");

  // The audit: a wait.log line records the waiter's own lifecycle, distinct from
  // any work-level cancellation.
  const auditPath = join(LAUNCHES_DIR, meta.id, "wait.log");
  await waitFor("the wait.log audit line", () => existsSync(auditPath));
  const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string });
  assert.ok(audit.some((a) => a.event === "wait_cancelled"), `wait.log records the cancelled waiter: ${JSON.stringify(audit)}`);

  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" });
});

test("FG-552 CLI (F33): the minimal observer resolves+reports under a broken better-sqlite3, while a store-loading launch subcommand (forge launch show) dies under the same sabotage — the fast-path contrast", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "sleep 0.4; exit 0"], "clif33");
  // Let the exit record land first so the observation is a STABLE exited_ok — this
  // test's claim is the NATIVE-FREE observer path, not the completion-during-read
  // timing (which the readLaunch atomicity finding covers separately).
  await waitFor("the exit record", () => existsSync(exitFile(meta.id)));

  const hookDir = mkdtempSync(join(tmpdir(), "fg552-sabotage-"));
  writeFileSync(
    join(hookDir, "hooks.mjs"),
    `export async function resolve(s,c,n){if(s==="better-sqlite3")throw new Error("SABOTAGED: better-sqlite3 cannot load");return n(s,c);}`,
  );
  const register = join(hookDir, "register.mjs");
  writeFileSync(register, `import{register}from"node:module";register("./hooks.mjs",import.meta.url);`);

  try {
    // The observer is dispatched BEFORE node-preflight and the eager registry, so
    // its graph is node:fs + launch.js only. It observes the atomic exit record and
    // reports — all with no native binding.
    const wait = forgeWithSabotage(register, ["launch", "wait", meta.id, "--json"]);
    assert.equal(wait.status, 0, `wait must observe under a broken native binding: ${wait.stderr}`);
    assert.doesNotMatch(`${wait.stdout}${wait.stderr}`, /SABOTAGED/, "the observer never touched the sabotaged binding");
    const obs = JSON.parse(wait.stdout) as { kind: string; status: { state: string } };
    assert.equal(obs.kind, "terminal");
    assert.equal(obs.status.state, "exited_ok");
    // Even the advisory audit succeeds — it is a native-free filesystem line.
    assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "wait.log")), "the wait.log audit is written without the store");

    // The sharp contrast: `forge launch show` is ALSO a `launch` subcommand, but it
    // is NOT the fast-pathed observer — it goes through the eager registry → store →
    // better-sqlite3, so it dies. This proves the observer's survival is the fast
    // path, not merely that the word 'launch' avoids the binding.
    const show = forgeWithSabotage(register, ["launch", "show", meta.id, "--json"]);
    assert.notEqual(show.status, 0, "forge launch show loads the registry → the sabotaged binding must break it");
    assert.match(`${show.stdout}${show.stderr}`, /SABOTAGED/, "show died on the sabotaged native binding — the registry really was reached");
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
  }
});

test("FG-552 CLI (F34): a launch whose OWNER dies DURING the wait (dead pane, live session, no exit record) is observed as owner_gone via the mandatory reconcile tick — the transition produces NO fs event, so a watch-only observer would hang", async () => {
  if (!hasTmux) return;
  const meta = launchRun(["sh", "-c", "sleep 30"], "cliownergone");
  assert.ok(meta.ownerPid && meta.ownerPid > 0, "precondition: an owner pid was recorded");

  // Start the blocking wait FIRST, on a still-running launch. Then, once it is
  // blocking, kill the pane's wrapper (the owner) hard — before it can write its
  // last-act exit record. remain-on-exit keeps the session alive holding a DEAD
  // pane: the owner_gone evidence. This transition happens with NO filesystem
  // change, so fs.watch cannot fire for it — ONLY the reconcile tick, re-reading
  // tmux liveness on its interval, can turn it into a terminal observation.
  // A generous --timeout bounds the failure mode: WITH reconciliation the tick
  // observes owner_gone in ~2s, well under it; WITHOUT reconciliation (a watch-only
  // observer) nothing ever fires for this fs-event-less transition and the wait
  // would run to the timeout — which is exactly how a regression surfaces here.
  const child = spawn("node", ["--import", loader, entry, "launch", "wait", meta.id, "--json", "--timeout", "20"], { env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  await new Promise((r) => setTimeout(r, 2500)); // let it boot, read running, and block
  execFileSync("kill", ["-9", String(meta.ownerPid)]);
  assert.ok(!existsSync(exitFile(meta.id)), "precondition: the killed owner never wrote an exit record");

  const exit = await new Promise<{ code: number | null }>((res) => child.on("exit", (code) => res({ code })));
  assert.equal(exit.code, 0, `owner_gone is a TERMINAL disposition — a successful observation, not a hang/timeout (stderr=${stderr})`);
  const obs = JSON.parse(stdout) as { kind: string; status: { state: string } };
  assert.equal(obs.kind, "terminal");
  assert.equal(obs.status.state, "owner_gone", "the reconcile tick observed the dead-pane/live-session evidence mid-wait, never fabricating an exit");

  execFileSync("tmux", ["kill-session", "-t", meta.tmuxSession], { stdio: "ignore" });
});
