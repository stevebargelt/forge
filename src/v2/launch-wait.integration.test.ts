// FG-552: the blocking `forge launch wait` primitive over the REAL boundary —
// real tmux ownership, real fs.watch/reconcile, real atomic exit-record rename,
// and the F33 minimal-observer guarantee (the observer resolves with no native
// binding). A stub cannot prove these: only a real tmux-owned command that really
// finishes, and a real sabotaged better-sqlite3, exercise what this slice turns on.
//
// Requires tmux (present on ubuntu-latest, where the extended tier runs).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR, startLaunch } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const loader = resolve(here, "..", "..", "bin", "forge-loader.mjs");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const started: string[] = [];

/** Run the real forge CLI via tsx, exactly as bin/forge does in-process. */
function forge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { encoding: "utf8", env: process.env });
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

test("FG-552 F4 (real): the exit record is committed ATOMICALLY — complete JSON, no .tmp remnant ever left behind", async () => {
  if (!hasTmux) return;
  const meta = startLaunch(["true"], { name: "atomicexit" });
  started.push(meta.id);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const dir = join(LAUNCHES_DIR, meta.id);
  const remnants = readdirSync(dir).filter((e) => e.startsWith("exit.tmp"));
  assert.deepEqual(remnants, [], "the temp file was renamed into place, never left behind");
  // A complete, parseable record — never a truncated fragment.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "exit"), "utf8")), { code: 0, signal: null });
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
