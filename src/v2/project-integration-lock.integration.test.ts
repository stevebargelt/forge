// FG-425 integration tests: cross-window mutual exclusion, waiting visibility,
// dead-holder recovery. These use real timers/polling, so they live in the
// integration tier, not unit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { projectIntegrationLockKey, withProjectIntegrationLock } from "./project-integration-lock.js";

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
