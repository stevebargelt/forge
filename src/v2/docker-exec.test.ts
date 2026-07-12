// docker-exec tests: container-name parsing + the authoritative kill path.
// The full executor (spawn + streams + timers) isn't exercised here, but the
// two pieces that make idle-kill correct — finding the right container name and
// issuing `docker kill <name>` — are unit-tested directly.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  containerNameFromArgs,
  killContainer,
  captureContainerCausalEvidence,
  shouldRetainContainer,
  finalizeContainerRetention,
  defaultDockerExec,
  detachedDockerExec,
  productionDockerExec,
  toDetachedArgs,
  detachedEntryScript,
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

// ── FG-536: detached execution — the pure transformation halves ───────────────

test("FG-536 toDetachedArgs: `run -i` becomes `run -d` in place, entry script interposed right after the image", () => {
  const args = ["run", "-i", "--name", "forge-t1", "-v", "/x:/task", "img:latest", "claude", "-p", "--flag"];
  const out = toDetachedArgs(args, 6);
  assert.deepEqual(out, [
    "run", "-d", "--name", "forge-t1", "-v", "/x:/task", "img:latest",
    "sh", "/task/detached-entry.sh", "claude", "-p", "--flag",
  ]);
  assert.deepEqual(args[1], "-i", "the input argv is not mutated");
});

test("FG-536 toDetachedArgs: no -i flag — -d is inserted after `run` and the image position shifts", () => {
  const args = ["run", "--name", "forge-t2", "img", "cmd"];
  const out = toDetachedArgs(args, 3);
  assert.deepEqual(out, ["run", "-d", "--name", "forge-t2", "img", "sh", "/task/detached-entry.sh", "cmd"]);
});

test("FG-536 toDetachedArgs: every original argv element survives as its own element — nothing is merged into a shell string (FG-497)", () => {
  const bigPrompt = "x".repeat(100_000);
  const args = ["run", "-i", "--name", "forge-t3", "img", "claude", "--append-system-prompt", bigPrompt];
  const out = toDetachedArgs(args, 4);
  assert.ok(out.includes(bigPrompt), "the big arg is still a single, separate argv element");
  assert.equal(out.filter((a) => a.includes("x".repeat(1000))).length, 1, "…and was not merged into any other element");
});

test("FG-536 detachedEntryScript: with stdin the command's fd0 is the mounted payload; without, plain exec", () => {
  assert.equal(detachedEntryScript(true), `#!/bin/sh\nexec "$@" < /task/detached-stdin\n`);
  assert.equal(detachedEntryScript(false), `#!/bin/sh\nexec "$@"\n`);
});

test("FG-536 detachedDockerExec: provisioner execs keep the ATTACHED executor (FG-437 owns that lifecycle)", async () => {
  // The provisioner fallback delegates to defaultDockerExec, whose failure mode
  // for an unavailable docker binary path is a plain resolve(1) after spawn
  // error — reaching that (rather than staging detached-entry files) IS the
  // delegation proof: no detached-entry.sh appears in the task dir.
  const dir = mkdtempSync(join(tmpdir(), "fg536-prov-"));
  try {
    await detachedDockerExec({
      args: ["run", "--rm", "-i", "--name", "forge-provision-x", "img"],
      stdin: undefined,
      stdoutPath: join(dir, "stdout.log"),
      stderrPath: join(dir, "stderr.log"),
      idleTimeoutMs: 1,
      isProvisionerExec: true,
      imageIndex: 5,
    });
    assert.ok(!existsSync(join(dir, "detached-entry.sh")), "no detached staging for a provisioner exec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-536 detachedDockerExec: an absent imageIndex falls back to the attached executor — the boundary is never guessed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg536-noidx-"));
  try {
    await detachedDockerExec({
      args: ["run", "-i", "--name", "forge-noidx", "img"],
      stdin: "payload",
      stdoutPath: join(dir, "stdout.log"),
      stderrPath: join(dir, "stderr.log"),
      idleTimeoutMs: 1,
    });
    assert.ok(!existsSync(join(dir, "detached-entry.sh")), "no detached staging without a known image boundary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FG-536 review: the start signal — a container really exists, or nothing is claimed ──
//
// container.started is the record every rescue path keys on (the container-gone
// sweep, FG-533's pre-container sweep, FG-536's idle bound). It may only be written
// once `docker run -d` has actually started a container, so the callback that emits
// it fires there and nowhere earlier.

/** A docker stub whose `run` succeeds or fails on demand; `wait` reports exit 0. */
function makeRunStub(runExit: number): string {
  const binDir = mkdtempSync(join(tmpdir(), "fg536-start-stub-"));
  writeFileSync(
    join(binDir, "docker"),
    `#!/bin/sh\ncase "$1" in\n  run) exit ${runExit} ;;\n  wait) echo 0 ;;\n  logs) : ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

async function withRunStub<T>(runExit: number, fn: () => Promise<T>): Promise<T> {
  const binDir = makeRunStub(runExit);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("FG-536 detachedDockerExec: onContainerStarted fires exactly once, AFTER `docker run -d` succeeds — the watcher window starts where the container does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg536-started-"));
  try {
    let starts = 0;
    const exitCode = await withRunStub(0, () =>
      detachedDockerExec({
        args: ["run", "-i", "--name", "forge-started", "img", "claude"],
        stdin: "payload",
        stdoutPath: join(dir, "stdout.log"),
        stderrPath: join(dir, "stderr.log"),
        idleTimeoutMs: 60_000,
        imageIndex: 4,
        onContainerStarted: () => { starts++; },
      }),
    );
    assert.equal(exitCode, 0);
    assert.equal(starts, 1, "one start signal for one container");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-536 detachedDockerExec: a FAILED `docker run -d` (bad image, name clash) never signals a start — no container, no start record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg536-nostart-"));
  try {
    let starts = 0;
    const exitCode = await withRunStub(1, () =>
      detachedDockerExec({
        args: ["run", "-i", "--name", "forge-nostart", "img", "claude"],
        stdin: undefined,
        stdoutPath: join(dir, "stdout.log"),
        stderrPath: join(dir, "stderr.log"),
        idleTimeoutMs: 60_000,
        imageIndex: 4,
        onContainerStarted: () => { starts++; },
      }),
    );
    assert.equal(exitCode, 1);
    assert.equal(starts, 0, "docker run -d failed — claiming a start here is the misleading record this callback exists to prevent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// FG-536 review: `forge-<taskId>` is a REUSABLE name — once the container exits,
// a retry can bind it to a different container. Every docker call the watcher half
// makes must therefore address the ID `docker run -d` printed, which the daemon
// never re-binds.
test("FG-536 detachedDockerExec: the watcher, waiter and evidence probe all address the container ID `docker run -d` printed, not the reusable name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg536-id-"));
  const binDir = mkdtempSync(join(tmpdir(), "fg536-id-stub-"));
  const calls = join(dir, "calls.log");
  writeFileSync(
    join(binDir, "docker"),
    `#!/bin/sh\necho "$@" >> ${calls}\ncase "$1" in\n  run) echo sha256-c0ffee ;;\n  wait) echo 0 ;;\n  logs) : ;;\n  inspect) echo '[]' ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    let startedWith: string | undefined;
    await detachedDockerExec({
      args: ["run", "-i", "--name", "forge-idtest", "img", "claude"],
      stdin: undefined,
      stdoutPath: join(dir, "stdout.log"),
      stderrPath: join(dir, "stderr.log"),
      idleTimeoutMs: 60_000,
      imageIndex: 4,
      onContainerStarted: (id) => { startedWith = id; },
    });

    assert.equal(startedWith, "sha256-c0ffee", "the daemon's ID is what the start record gets");
    const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).filter((l) => !l.startsWith("run "));
    assert.ok(logged.length > 0, "the watcher half ran");
    assert.ok(logged.some((l) => l === "logs -f sha256-c0ffee"), `docker logs addressed the ID — saw ${JSON.stringify(logged)}`);
    assert.ok(logged.some((l) => l === "wait sha256-c0ffee"), `docker wait addressed the ID — saw ${JSON.stringify(logged)}`);
    assert.ok(!logged.some((l) => l.includes("forge-idtest")), `no post-start call addressed the reusable NAME — saw ${JSON.stringify(logged)}`);
  } finally {
    process.env.PATH = origPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("FG-536 productionDockerExec: FORGE_DETACHED_EXEC=off routes to the attached executor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg536-off-"));
  const prev = process.env.FORGE_DETACHED_EXEC;
  process.env.FORGE_DETACHED_EXEC = "off";
  try {
    await productionDockerExec({
      args: ["run", "-i", "--name", "forge-off", "img"],
      stdin: "payload",
      stdoutPath: join(dir, "stdout.log"),
      stderrPath: join(dir, "stderr.log"),
      idleTimeoutMs: 1,
      imageIndex: 4,
    });
    assert.ok(!existsSync(join(dir, "detached-entry.sh")), "attached executor stages nothing");
  } finally {
    if (prev === undefined) delete process.env.FORGE_DETACHED_EXEC; else process.env.FORGE_DETACHED_EXEC = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
