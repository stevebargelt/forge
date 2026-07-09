// docker-exec tests: container-name parsing + the authoritative kill path.
// The full executor (spawn + streams + timers) isn't exercised here, but the
// two pieces that make idle-kill correct — finding the right container name and
// issuing `docker kill <name>` — are unit-tested directly.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  containerNameFromArgs,
  killContainer,
  captureContainerCausalEvidence,
  shouldRetainContainer,
  finalizeContainerRetention,
  defaultDockerExec,
} from "./docker-exec.js";

test("containerNameFromArgs: extracts the value after --name", () => {
  assert.equal(
    containerNameFromArgs(["run", "--rm", "--name", "forge-task-abc", "img"]),
    "forge-task-abc",
  );
});

test("containerNameFromArgs: undefined when --name is absent", () => {
  assert.equal(containerNameFromArgs(["run", "--rm", "img"]), undefined);
});

test("containerNameFromArgs: undefined when --name is the last token (no value)", () => {
  assert.equal(containerNameFromArgs(["run", "--name"]), undefined);
});

test("killContainer: runs `docker kill <name>` for the container", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fakeExecFile = ((cmd: string, args: string[], _cb: () => void) => {
    calls.push({ cmd, args });
  }) as unknown as typeof import("node:child_process").execFile;

  killContainer("forge-task-abc", fakeExecFile);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "docker");
  assert.deepEqual(calls[0]!.args, ["kill", "forge-task-abc"]);
});

test("killContainer: no-op when the container name is undefined", () => {
  let called = false;
  const fakeExecFile = (() => {
    called = true;
  }) as unknown as typeof import("node:child_process").execFile;

  killContainer(undefined, fakeExecFile);

  assert.equal(called, false);
});

// ── FG-492: capture-at-close causal evidence ────────────────────────────────

function dockerInspectJson(state: Record<string, unknown>): string {
  return JSON.stringify([{ State: state }]);
}

function fakeExecFileSync(raw: string | (() => string)): typeof import("node:child_process").execFileSync {
  return ((_cmd: string, _args: string[]) => {
    const out = typeof raw === "function" ? raw() : raw;
    return Buffer.from(out);
  }) as unknown as typeof import("node:child_process").execFileSync;
}

test("captureContainerCausalEvidence: undefined containerName → observed-only shape, no docker call", () => {
  let called = false;
  const fake = (() => {
    called = true;
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const evidence = captureContainerCausalEvidence(undefined, fake);
  assert.equal(called, false, "must not shell out when there's no container name");
  assert.equal(evidence.containerExitedEventObserved, true, "attached-exit always observed the process exit");
  assert.equal(evidence.dockerExitCode, undefined);
});

test("captureContainerCausalEvidence: parses exit code, OOMKilled, timing from `docker inspect`", () => {
  const raw = dockerInspectJson({
    StartedAt: "2026-05-30T00:00:00Z",
    FinishedAt: "2026-05-30T00:05:00Z",
    ExitCode: 137,
    OOMKilled: true,
    Error: "",
  });
  const evidence = captureContainerCausalEvidence("forge-task-abc", fakeExecFileSync(raw));
  assert.equal(evidence.containerName, "forge-task-abc");
  assert.equal(evidence.containerExitedEventObserved, true, "capture-at-close is always an attached, confirmed exit");
  assert.equal(evidence.dockerExitCode, 137);
  assert.equal(evidence.oomKilled, true);
  assert.equal(evidence.signal, "SIGKILL", "exit 137 = 128 + SIGKILL(9)");
  assert.equal(evidence.startedAt, "2026-05-30T00:00:00Z");
  assert.equal(evidence.finishedAt, "2026-05-30T00:05:00Z");
});

test("captureContainerCausalEvidence: docker inspect throws (daemon hiccup / already gone) → observed-only shape, never throws", () => {
  const throwingFake = (() => {
    throw new Error("No such object: forge-task-gone");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const evidence = captureContainerCausalEvidence("forge-task-gone", throwingFake);
  assert.equal(evidence.containerName, "forge-task-gone");
  assert.equal(evidence.containerExitedEventObserved, true);
  assert.equal(evidence.dockerExitCode, undefined);
  assert.equal(evidence.oomKilled, undefined);
});

test("captureContainerCausalEvidence: a clean exit (0) records no signal and no OOM", () => {
  const raw = dockerInspectJson({ ExitCode: 0, OOMKilled: false });
  const evidence = captureContainerCausalEvidence("forge-task-clean", fakeExecFileSync(raw));
  assert.equal(evidence.dockerExitCode, 0);
  assert.equal(evidence.oomKilled, false);
  assert.equal(evidence.signal, undefined, "exit 0 is not a signal");
});

// ── FG-492 review: retention decision now keys on TASK outcome, not exit code ──

test("shouldRetainContainer: retains a failed task by default, reaps a succeeded task", () => {
  delete process.env.FORGE_CONTAINER_RETENTION;
  assert.equal(shouldRetainContainer(true), false, "a succeeded task is always reaped");
  assert.equal(shouldRetainContainer(false), true, "a failed task is retained for diagnosis by default");
});

test("shouldRetainContainer: FORGE_CONTAINER_RETENTION=off disables retention entirely, even on failure", () => {
  process.env.FORGE_CONTAINER_RETENTION = "off";
  try {
    assert.equal(shouldRetainContainer(false), false);
    assert.equal(shouldRetainContainer(true), false);
  } finally {
    delete process.env.FORGE_CONTAINER_RETENTION;
  }
});

afterEach(() => {
  delete process.env.FORGE_CONTAINER_RETENTION;
});

test("finalizeContainerRetention: task succeeded → reaps (docker rm -f called)", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fake = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;

  const outcome = finalizeContainerRetention("forge-task-clean", true, fake);
  assert.equal(outcome, "reaped");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "docker", args: ["rm", "-f", "-v", "forge-task-clean"] });
});

test("finalizeContainerRetention: task failed → retained (docker rm never called) by default", () => {
  let called = false;
  const fake = (() => {
    called = true;
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;

  const outcome = finalizeContainerRetention("forge-task-failed", false, fake);
  assert.equal(outcome, "retained");
  assert.equal(called, false, "a retained container must never be reaped");
});

test("finalizeContainerRetention: FORGE_CONTAINER_RETENTION=off reaps even a failed task", () => {
  process.env.FORGE_CONTAINER_RETENTION = "off";
  const calls: string[] = [];
  const fake = ((_cmd: string, args: string[]) => {
    calls.push(args.join(" "));
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;

  const outcome = finalizeContainerRetention("forge-task-failed-off", false, fake);
  assert.equal(outcome, "reaped");
  assert.deepEqual(calls, ["rm -f -v forge-task-failed-off"]);
});

test("finalizeContainerRetention: docker rm throws → 'reap_failed', not confused with 'retained'", () => {
  const throwingFake = (() => {
    throw new Error("docker daemon unreachable");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const outcome = finalizeContainerRetention("forge-task-x", true, throwingFake);
  assert.equal(outcome, "reap_failed");
});

test("finalizeContainerRetention: undefined containerName → retained (nothing to reap), no docker call", () => {
  let called = false;
  const fake = (() => {
    called = true;
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const outcome = finalizeContainerRetention(undefined, true, fake);
  assert.equal(outcome, "retained");
  assert.equal(called, false);
});

// ── FG-492 finding 2: gate capture-at-close/reap for the provisioner ────────
//
// docker-exec.ts is the SHARED executor for both task/reviewer containers
// AND the FG-437 dependency-provisioner container. The provisioner keeps its
// own --rm lifecycle (out of scope for FG-492) and by the time defaultDockerExec's
// close handler runs, the daemon has typically already auto-removed it — a
// `docker inspect`/`docker rm -f` against it is wasted work, not evidence
// gathering. These tests shadow `docker` on PATH with a stub that logs its
// argv, so the assertion holds without a real docker daemon (same technique
// worktree-lifecycle.worktree.test.ts uses for its no-docker-call assertions).

function makeDockerStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-docker-exec-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(
    join(binDir, "docker"),
    `#!/bin/sh\necho "$@" >> "${logPath}"\ncase "$1" in\n  inspect) echo '[{"State":{"ExitCode":0,"OOMKilled":false,"StartedAt":"2026-01-01T00:00:00Z","FinishedAt":"2026-01-01T00:00:01Z"}}]' ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

async function withDockerStub<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const { binDir, logPath } = makeDockerStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    // Must await here — a bare `return fn(logPath)` returns the pending
    // promise without waiting for it, so `finally` (PATH restore + binDir
    // removal) would run before the async docker-exec call inside `fn`
    // actually finishes, deleting the stub out from under it.
    return await fn(logPath);
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("defaultDockerExec: a TASK exec (isProvisionerExec unset) captures evidence at close but never reaps — the caller decides reap/retain once it knows the task outcome", async () => {
  await withDockerStub(async (logPath) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-docker-exec-io-"));
    try {
      const containerName = "forge-task-fg492";
      const exitCode = await defaultDockerExec({
        args: ["run", "-i", "--name", containerName, "img"],
        stdin: undefined,
        stdoutPath: join(dir, "stdout.log"),
        stderrPath: join(dir, "stderr.log"),
        idleTimeoutMs: 60_000,
        // Real callers (invoke.ts / runNext.ts) always pass this — omitting it
        // here would short-circuit `onContainerEvidence?.(captureContainerCausalEvidence(...))`
        // via optional-chaining semantics and skip the inspect call entirely,
        // which would test a shape no production call site actually uses.
        onContainerEvidence: () => {},
      });
      assert.equal(exitCode, 0);
      const calls = readFileSync(logPath, "utf8");
      assert.match(calls, new RegExp(`inspect ${containerName}`), "a task exec must gather causal evidence via docker inspect");
      assert.doesNotMatch(calls, / rm /, "FG-492 review: close-time no longer reaps — even a clean exit may have no result.json, so only the caller (after validating result.json) may reap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("defaultDockerExec: a PROVISIONER exec (isProvisionerExec: true) skips capture-at-close entirely — no inspect, no rm", async () => {
  await withDockerStub(async (logPath) => {
    const dir = mkdtempSync(join(tmpdir(), "forge-docker-exec-io-"));
    try {
      const containerName = "forge-provision-fg492";
      const exitCode = await defaultDockerExec({
        args: ["run", "--rm", "-i", "--name", containerName, "img"],
        stdin: undefined,
        stdoutPath: join(dir, "stdout.log"),
        stderrPath: join(dir, "stderr.log"),
        idleTimeoutMs: 60_000,
        isProvisionerExec: true,
      });
      assert.equal(exitCode, 0);
      const calls = readFileSync(logPath, "utf8");
      assert.doesNotMatch(calls, /inspect/, "a provisioner exec must never docker inspect — FG-437 owns its lifecycle");
      assert.doesNotMatch(calls, / rm /, "a provisioner exec must never docker rm -f — it already ran with --rm");
      assert.match(calls, /^run /, "the provisioner's own `docker run` still happened");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("defaultDockerExec: isProvisionerExec: true still invokes the caller's onContainerEvidence callback ZERO times (never fabricates evidence for a skipped capture)", async () => {
  await withDockerStub(async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-docker-exec-io-"));
    try {
      let evidenceCalls = 0;
      await defaultDockerExec({
        args: ["run", "--rm", "-i", "--name", "forge-provision-fg492b", "img"],
        stdin: undefined,
        stdoutPath: join(dir, "stdout.log"),
        stderrPath: join(dir, "stderr.log"),
        idleTimeoutMs: 60_000,
        isProvisionerExec: true,
        onContainerEvidence: () => { evidenceCalls++; },
      });
      assert.equal(evidenceCalls, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
