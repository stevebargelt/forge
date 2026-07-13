// FG-425 integration tests: cross-window mutual exclusion, waiting visibility,
// dead-holder recovery. These use real timers/polling, so they live in the
// integration tier, not unit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  projectIntegrationLockKey, withProjectIntegrationLock,
  recordGateProcessGroup, clearGateProcessGroup, readGateProcessGroup,
} from "./project-integration-lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("FG-425: two concurrent windows on ONE project never overlap — stressed", async () => {
  const dir = tmp("forge-fg425-mx-");
  try {
    // Stress the interleaving: many rounds of two racing critical sections.
    // Any overlap (second enters before first exits) is a hard failure.
    for (let round = 0; round < 25; round++) {
      let inside = 0;
      let maxInside = 0;
      const critical = (runId: string, holdMs: number) => () =>
        (async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await sleep(holdMs);
          inside--;
          return runId;
        })();

      const [a, b] = await Promise.all([
        withProjectIntegrationLock(dir, "run-a", critical("run-a", 15), { pollMs: 5 }),
        withProjectIntegrationLock(dir, "run-b", critical("run-b", 15), { pollMs: 5 }),
      ]);
      assert.equal(a, "run-a");
      assert.equal(b, "run-b");
      assert.equal(maxInside, 1, `round ${round}: both runs were inside the protected window at once`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-425: DIFFERENT projects run their windows in parallel (no global serialization)", async () => {
  const dirA = tmp("forge-fg425-par-a-");
  const dirB = tmp("forge-fg425-par-b-");
  try {
    let overlapped = false;
    let insideA = false;
    let insideB = false;
    await Promise.all([
      withProjectIntegrationLock(dirA, "run-a", async () => {
        insideA = true;
        await sleep(150);
        if (insideB) overlapped = true;
        insideA = false;
      }, { pollMs: 5 }),
      withProjectIntegrationLock(dirB, "run-b", async () => {
        insideB = true;
        await sleep(150);
        if (insideA) overlapped = true;
        insideB = false;
      }, { pollMs: 5 }),
    ]);
    assert.equal(overlapped, true, "independent projectDirs must proceed concurrently — a global lock would serialize them");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("FG-425: while waiting, the operator sees WHO holds the window (owning run, pid, project, next action)", async () => {
  const dir = tmp("forge-fg425-wait-");
  const { canonicalDir } = projectIntegrationLockKey(dir);
  const lines: string[] = [];
  try {
    let release!: () => void;
    const releaseGate = new Promise<void>((r) => { release = r; });

    const holder = withProjectIntegrationLock(dir, "run-holder", async () => {
      await releaseGate;
    }, { pollMs: 5 });
    await sleep(30); // let the holder acquire first

    const waiter = withProjectIntegrationLock(dir, "run-waiter", async () => "done", {
      pollMs: 5,
      log: (l) => { lines.push(l); if (lines.length === 1) release(); },
    });

    assert.equal(await waiter, "done");
    await holder;

    assert.ok(lines.length >= 1, "a waiting line is emitted");
    const line = lines[0]!;
    assert.match(line, /run run-holder/, "names the owning run");
    assert.match(line, /pid \d+/);
    assert.ok(line.includes(canonicalDir), "names the project");
    assert.match(line, /forge show/, "offers a supported next action");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-425: a DEAD holder's lock is stolen (evidence-based: pid liveness, not elapsed time)", async () => {
  const dir = tmp("forge-fg425-dead-");
  const { lockFilePath } = projectIntegrationLockKey(dir);
  try {
    mkdirSync(dirname(lockFilePath), { recursive: true });
    // A lock file whose recorded pid provably cannot be alive. Recorded as
    // acquired JUST NOW — freshness must not protect a dead holder.
    writeFileSync(lockFilePath, JSON.stringify({
      pid: 2 ** 30, command: "integration-window run-dead",
      acquiredAtMs: Date.now(), acquiredAt: new Date().toISOString(), holderId: "run-dead",
    }));

    const out = await withProjectIntegrationLock(dir, "run-live", async () => "recovered", { pollMs: 5 });
    assert.equal(out, "recovered", "a crashed holder never wedges the project permanently");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-425: a LIVE holder is waited out, never time-stolen", async () => {
  const dir = tmp("forge-fg425-live-");
  const { lockFilePath } = projectIntegrationLockKey(dir);
  try {
    mkdirSync(dirname(lockFilePath), { recursive: true });
    // A live-pid holder recorded as acquired LONG ago — an elapsed-time steal
    // policy would take it; the evidence-based policy must wait.
    writeFileSync(lockFilePath, JSON.stringify({
      pid: process.pid, command: "integration-window run-slow",
      acquiredAtMs: Date.now() - 2 * 60 * 60 * 1000, acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      holderId: "run-slow",
    }));

    let entered = false;
    const attempt = withProjectIntegrationLock(dir, "run-second", async () => { entered = true; }, {
      pollMs: 5,
      // The holder pid (this process) IS alive; declare it so explicitly.
      isAlive: () => true,
    });
    await sleep(120);
    assert.equal(entered, false, "a live holder — however old — must never be raced");

    // Simulate the slow holder finishing: its release unblocks the waiter.
    rmSync(lockFilePath, { force: true });
    await attempt;
    assert.equal(entered, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FG-425 gate process-group ownership (crash/timeout AC) ───────────────────

function pidAliveProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  assert.ok(cond(), `timed out waiting for: ${what}`);
}

/** test:unit that writes ITS OWN pid and a forked DESCENDANT's pid to files,
 *  then holds for `holdMs` — a realistic multi-process test runner. */
function writeGateProject(dir: string, pidDir: string, holdMs: number): void {
  const script =
    `node -e "const f=require('fs');const cp=require('child_process');` +
    `f.writeFileSync('${pidDir}/gate.pid',String(process.pid));` +
    `const d=cp.spawn(process.execPath,['-e','setTimeout(()=>{}, ${holdMs})'],{stdio:'ignore'});` +
    `f.writeFileSync('${pidDir}/descendant.pid',String(d.pid));` +
    `setTimeout(()=>{}, ${holdMs})"`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fg425-gate-fixture", private: true, scripts: { "test:unit": script },
  }));
}

test("FG-425 ownership: gate TIMEOUT terminates the whole process group — descendant included — confirmed before returning; sidecar cleared", async () => {
  const dir = tmp("forge-fg425-own-timeout-");
  const pidDir = tmp("forge-fg425-own-pids-");
  const savedTimeout = process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS;
  try {
    writeGateProject(dir, pidDir, 30_000);
    process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS = "1200";

    const { runIntegrationGate } = await import("./integration-gate.js");
    const result = await runIntegrationGate(dir, { runId: "run-timeout-test" });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.timedOut, true);
      assert.equal(result.groupTerminationConfirmed, true, "the group must be CONFIRMED gone before the gate returns");
    }
    const gatePid = Number(readFileSync(join(pidDir, "gate.pid"), "utf8"));
    const descendantPid = Number(readFileSync(join(pidDir, "descendant.pid"), "utf8"));
    assert.equal(pidAliveProbe(gatePid), false, "the gate script itself must be dead");
    assert.equal(pidAliveProbe(descendantPid), false, "the forked DESCENDANT must be dead too — group kill, not child kill");
    assert.equal(readGateProcessGroup(dir), undefined, "sidecar cleared on confirmed termination");
  } finally {
    if (savedTimeout === undefined) delete process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS;
    else process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS = savedTimeout;
    rmSync(dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("FG-425 ownership: SIGKILL of the forge lock holder mid-gate — the next acquirer reaps the surviving gate group, confirms, then enters", async () => {
  const dir = tmp("forge-fg425-own-crash-");
  const pidDir = tmp("forge-fg425-own-crash-pids-");
  const scratch = tmp("forge-fg425-own-crash-scratch-");
  try {
    writeGateProject(dir, pidDir, 30_000);

    // Holder driver: a REAL separate forge-code process that takes the project
    // lock and runs the gate. Parent SIGKILLs it mid-gate.
    const repoRoot = process.cwd();
    const driver = join(scratch, "holder.mjs");
    writeFileSync(driver, `
import { pathToFileURL } from "node:url";
const { withProjectIntegrationLock } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/project-integration-lock.ts"))}).href);
const { runIntegrationGate } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/integration-gate.ts"))}).href);
await withProjectIntegrationLock(${JSON.stringify(dir)}, "run-orphaned-holder", async () => {
  await runIntegrationGate(${JSON.stringify(dir)}, { runId: "run-orphaned-holder" });
});
`);
    const { spawn } = await import("node:child_process");
    const holder = spawn(process.execPath, ["--import", "tsx", driver], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let holderErr = "";
    holder.stderr.on("data", (d) => { holderErr += String(d); });

    // Wait until the gate's own script is running (pid file written), then
    // SIGKILL the forge holder — the detached gate group survives it.
    await waitFor(() => existsSync(join(pidDir, "gate.pid")), 20_000, `gate started (holder stderr: ${holderErr})`);
    const gatePid = Number(readFileSync(join(pidDir, "gate.pid"), "utf8"));
    holder.kill("SIGKILL");
    await new Promise<void>((r) => holder.on("close", () => r()));
    assert.equal(pidAliveProbe(gatePid), true, "sanity: the orphaned gate group must survive the holder's SIGKILL");
    assert.notEqual(readGateProcessGroup(dir), undefined, "sanity: the sidecar records the orphaned group");

    // Contender: acquires the lock (dead-holder steal), MUST reap + confirm
    // the orphan before entering the window.
    const lines: string[] = [];
    let entered = false;
    await withProjectIntegrationLock(dir, "run-contender", async () => {
      entered = true;
      assert.equal(pidAliveProbe(gatePid), false, "the orphaned gate group must be dead BEFORE the window is entered");
    }, { pollMs: 25, log: (l) => lines.push(l), reap: { pollMs: 25 } });

    assert.equal(entered, true);
    assert.equal(readGateProcessGroup(dir), undefined, "sidecar cleared after confirmed reap");
    assert.ok(lines.some((l) => /reaping an orphaned integration-gate process group/.test(l)), `operator sees the reap: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => /confirmed terminated/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("FG-425 ownership: an UNCONFIRMABLE orphan fails CLOSED — actionable error, lock released, sidecar retained, no silent entry and no infinite wait", async () => {
  const dir = tmp("forge-fg425-own-unconf-");
  try {
    const { lockFilePath } = projectIntegrationLockKey(dir);
    // A sidecar pointing at a group our injected killFn reports as immortal.
    recordGateProcessGroup(dir, 424242, "run-ghost");

    let entered = false;
    await assert.rejects(
      withProjectIntegrationLock(dir, "run-contender", async () => { entered = true; }, {
        pollMs: 10,
        log: () => { /* silence the reap lines */ },
        reap: { killFn: () => { /* signals swallowed — group never dies */ }, pollMs: 10, graceMs: 30, confirmTimeoutMs: 60 },
      }),
      (e: Error) => /could not be confirmed terminated/.test(e.message)
        && /424242/.test(e.message)
        && /kill -9 -424242/.test(e.message),
      "the error must be actionable: names the pgid and the manual cleanup command",
    );
    assert.equal(entered, false, "the window must never be entered over a possibly-live orphan");
    assert.equal(existsSync(lockFilePath), false, "the lock is released on the fail-closed path — no permanent lock");
    assert.notEqual(readGateProcessGroup(dir), undefined, "the sidecar is retained so the orphan stays visible to the next attempt");
  } finally {
    clearGateProcessGroup(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
