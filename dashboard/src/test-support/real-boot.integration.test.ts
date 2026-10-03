// FG-826 AC4: a missing-prerequisite run of each real-boot suite exits within the bound with a
// named reason, and leaves no child behind. In agent containers these suites used to pend
// indefinitely (a failed boot leaked children that held the runner open); here every suite is
// actually run, as its own `node --test` process, with one prerequisite knocked out.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REAL_BOOT_SUITES,
  REAL_BOOT_TEST_TIMEOUT_MS,
  awaitBootOrFail,
  probeRealBootPreconditions,
  spawnRealBoot,
  stopAllRealBoots,
  stopRealBoot,
  type RealBoot,
} from "./real-boot.js";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxCli = resolve(dashboardRoot, "..", "node_modules", "tsx", "dist", "cli.mjs");
const scratch = mkdtempSync(join(tmpdir(), "fg826-real-boot-"));
const STARTUP_BOUND_MS = 3_000;
const STARTUP_SLACK_MS = 10_000;

after(async () => {
  await stopAllRealBoots();
  rmSync(scratch, { recursive: true, force: true });
});

// A killed grandchild is reparented to the container's PID 1, which may never reap it: a zombie
// still answers kill(pid, 0), so on Linux the process state decides.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z";
  } catch {
    return existsSync("/proc") ? false : true;
  }
}

async function eventuallyDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

function startSuite(suite: string, fault: string, startupBoundMs = STARTUP_BOUND_MS, extraEnv: Record<string, string> = {}): { run: RealBoot; output: () => string } {
  // A nested `node --test` that inherits NODE_TEST_CONTEXT reports to this runner instead of
  // running the suite as its own top-level run.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  // Through the harness itself, so an interrupted regression reaps the nested run's group too.
  const run = spawnRealBoot(`${suite} (${fault})`, process.execPath, [tsxCli, "--test", suite], {
    cwd: dashboardRoot,
    env: { ...env, ...extraEnv, FORGE_REAL_BOOT_FAULT: fault, FORGE_REAL_BOOT_STARTUP_TIMEOUT_MS: String(startupBoundMs) },
  });
  let output = "";
  run.child.stdout?.on("data", (chunk) => { output += String(chunk); });
  run.child.stderr?.on("data", (chunk) => { output += String(chunk); });
  return { run, output: () => output };
}

async function runSuite(suite: string, fault: string): Promise<{ code: number | null; output: string; elapsed: number }> {
  const started = Date.now();
  const { run, output } = startSuite(suite, fault);
  // The regression must not itself be able to hang: past the per-test bound the run's process
  // group is killed and the case fails on `code`.
  const guard = setTimeout(() => void stopRealBoot(run), REAL_BOOT_TEST_TIMEOUT_MS);
  await run.closed;
  clearTimeout(guard);
  return { code: run.child.exitCode, output: output(), elapsed: Date.now() - started };
}

const cases: Array<{ suite: string; fault: string; reason: RegExp }> = [
  { suite: "src/remote/tailscale/serve-process.integration.test.ts", fault: "hide-binary:tailscale", reason: /FG-826 precondition missing: tailscale binary not on PATH — CI \(dashboard_integration\) is the authority for this suite/ },
  ...REAL_BOOT_SUITES.flatMap((suite) => [
    { suite, fault: "missing-entry", reason: /FG-826 precondition missing: boot entry \S+\.fg826-absent does not exist — CI \(dashboard_integration\) is the authority/ },
    { suite, fault: "never-ready", reason: new RegExp(`FG-826 real boot timed out: .* was not ready within ${STARTUP_BOUND_MS}ms \\(REAL_BOOT_STARTUP_TIMEOUT_MS\\); its process group was killed`) },
    { suite, fault: "exit-early", reason: /FG-826 real boot failed: .* exited \(code 37, signal null\) before it was ready[\s\S]*fg826 injected child exited early/ },
  ]),
];

for (const { suite, fault, reason } of cases) {
  test(`FG-826 AC4: ${suite} with ${fault} fails fast with its named reason`, { timeout: REAL_BOOT_TEST_TIMEOUT_MS + 10_000 }, async () => {
    const run = await runSuite(suite, fault);
    assert.equal(run.code, 1, `the suite must FAIL (not pass, skip, or be killed at the bound):\n${run.output}`);
    assert.ok(run.elapsed < STARTUP_BOUND_MS + STARTUP_SLACK_MS, `took ${run.elapsed}ms; exceeded startup bound plus slack`);
    assert.match(run.output, reason);
    assert.doesNotMatch(run.output, /ℹ skipped [1-9]|ℹ todo [1-9]/, "a missing prerequisite must never pend or skip");
    for (const [, parent, grandchild] of run.output.matchAll(/fg826-never-ready pids (\d+) (\d+)/g)) {
      assert.ok((await eventuallyDead(Number(parent))) && (await eventuallyDead(Number(grandchild))), `never-ready child ${parent}/${grandchild} outlived the suite`);
    }
  });
}

test("FG-826: the probe names a tailscale binary that is genuinely absent from PATH", async () => {
  const bin = join(scratch, "bin-without-tailscale");
  mkdirSync(bin, { recursive: true });
  await assert.rejects(
    probeRealBootPreconditions({ files: [tsxCli], binaries: ["tailscale"], path: bin }),
    /FG-826 precondition missing: tailscale binary not on PATH — CI \(dashboard_integration\) is the authority for this suite/,
  );
  writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tailscale"), 0o755);
  await probeRealBootPreconditions({ files: [tsxCli], binaries: ["tailscale"], path: bin });
});

test("FG-826: the probe names a boot entry that does not exist", async () => {
  const entry = join(dashboardRoot, "src", "no-such-server.ts");
  await assert.rejects(probeRealBootPreconditions({ files: [tsxCli, entry] }), new RegExp(`FG-826 precondition missing: boot entry ${entry} does not exist`));
});

test("FG-826: a child that never prints its marker is failed within the bound and its whole group killed", async () => {
  const boot = spawnRealBoot("never-ready fixture", process.execPath, [
    "-e",
    "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});console.error('fixture-pids '+process.pid+' '+c.pid);console.error('last-words');setInterval(()=>{},1e9)",
  ], { cwd: scratch, env: process.env });
  const started = Date.now();
  const error = await awaitBootOrFail(boot, { readyMarker: /never printed/, timeoutMs: 1_500 }).then(() => undefined, (err: Error) => err);
  assert.ok(error, "awaitBootOrFail must fail");
  assert.ok(Date.now() - started < 1_500 + 8_000, "failed within the bound plus kill grace");
  assert.match(error.message, /FG-826 real boot timed out: never-ready fixture was not ready within 1500ms/);
  assert.match(error.message, /last-words/, "the failure carries the child's last output lines");
  const [, parent, grandchild] = error.message.match(/fixture-pids (\d+) (\d+)/) ?? [];
  assert.ok(parent && grandchild);
  assert.ok((await eventuallyDead(Number(parent))) && (await eventuallyDead(Number(grandchild))), "the grandchild died with its process group");
});

test("FG-826: a child that exits before its marker fails at once with the exit named", async () => {
  const boot = spawnRealBoot("crashing fixture", process.execPath, ["-e", "console.error('boom: native module'); process.exit(7)"], { cwd: scratch, env: process.env });
  const started = Date.now();
  await assert.rejects(
    awaitBootOrFail(boot, { readyMarker: /never printed/, timeoutMs: 30_000 }),
    /FG-826 real boot failed: crashing fixture exited \(code 7, signal null\) before it was ready[\s\S]*boom: native module/,
  );
  assert.ok(Date.now() - started < 10_000, "an exited child is not waited out to the bound");
});

test("FG-826 AC2: interrupting a real-boot suite mid-boot (as `timeout` or Ctrl-C does) leaves no child behind", { timeout: REAL_BOOT_TEST_TIMEOUT_MS }, async () => {
  const pidFile = join(scratch, "interrupted-boot.pids");
  const { run, output } = startSuite("src/remote/remote-board.e2e.integration.test.ts", "never-ready", 60_000, { FORGE_REAL_BOOT_PID_FILE: pidFile });
  const deadline = Date.now() + 60_000;
  const readPids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").match(/fg826-never-ready pids (\d+) (\d+)/) : null);
  let pids: RegExpMatchArray | null = null;
  while (!(pids = readPids()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(pids, `the suite never reached its boot:\n${output()}`);
  assert.ok(alive(Number(pids[1])) && alive(Number(pids[2])), "non-vacuous: the boot child is running when the suite is interrupted");
  process.kill(-run.child.pid!, "SIGTERM");
  await run.closed;
  assert.ok((await eventuallyDead(Number(pids[1]))) && (await eventuallyDead(Number(pids[2]))), `boot child ${pids[1]}/${pids[2]} outlived the interrupted suite`);
});
