// FG-376: dependency-provisioning.ts unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDir, integrationWorktreeDir } from "../util/paths.js";
import {
  DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE,
  lockfileHash,
  safeLockfileHash,
  isSafeWorkspacePath,
  workspaceMembers,
  dependencyVolumeName,
  planDependencyVolumes,
  removeDependencyVolumes,
  isDependencyCacheReady,
  markDependencyCacheReady,
  acquireDependencyCacheLock,
  provisionDependencyCache,
  provisionerContainerName,
} from "./dependency-provisioning.js";

function makeRepo(opts: { lockContent?: string; workspaces?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-deps-"));
  if (opts.workspaces) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", workspaces: opts.workspaces }));
  }
  if (opts.lockContent !== undefined) {
    writeFileSync(join(dir, "package-lock.json"), opts.lockContent);
  }
  return dir;
}

test("DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE is a stable sentinel", () => {
  assert.equal(DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, 123);
});

test("lockfileHash: throws when no package-lock.json is present", () => {
  const dir = makeRepo();
  assert.throws(() => lockfileHash(dir), /no package-lock\.json/);
});

test("lockfileHash: deterministic for identical content, differs across content", () => {
  const dirA = makeRepo({ lockContent: '{"a":1}' });
  const dirB = makeRepo({ lockContent: '{"a":1}' });
  const dirC = makeRepo({ lockContent: '{"a":2}' });
  assert.equal(lockfileHash(dirA), lockfileHash(dirB));
  assert.notEqual(lockfileHash(dirA), lockfileHash(dirC));
});

test("workspaceMembers: repo root only when no package.json", () => {
  const dir = makeRepo({ lockContent: "{}" });
  assert.deepEqual(workspaceMembers(dir), [{ relPath: "" }]);
});

test("workspaceMembers: includes non-glob workspaces entries, skips globs", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: ["dashboard", "packages/*"] });
  assert.deepEqual(workspaceMembers(dir), [{ relPath: "" }, { relPath: "dashboard" }]);
});

test("dependencyVolumeName: deterministic per (hash, relPath); root vs member differ", () => {
  const root = dependencyVolumeName("abc123", "");
  const member = dependencyVolumeName("abc123", "dashboard");
  assert.notEqual(root, member);
  assert.equal(dependencyVolumeName("abc123", ""), root);
  assert.match(root, /^forge-deps-abc123-root$/);
  assert.match(member, /^forge-deps-abc123-dashboard$/);
});

test("dependencyVolumeName: sanitizes path separators in relPath", () => {
  const name = dependencyVolumeName("h", "packages/foo");
  assert.doesNotMatch(name, /\//);
});

test("planDependencyVolumes: one volume per workspace member, all sharing the lockfile hash", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: ["dashboard"] });
  const plan = planDependencyVolumes(dir, "/project");
  assert.equal(plan.installRoot, "/project");
  assert.equal(plan.lockfileHash, lockfileHash(dir));
  assert.equal(plan.volumes.length, 2);
  const root = plan.volumes.find((v) => v.relPath === "");
  const dash = plan.volumes.find((v) => v.relPath === "dashboard");
  assert.equal(root?.containerPath, "/project/node_modules");
  assert.equal(dash?.containerPath, "/project/dashboard/node_modules");
  assert.notEqual(root?.name, dash?.name);
});

test("planDependencyVolumes: throws for a repo with no lockfile (caller falls back)", () => {
  const dir = makeRepo();
  assert.throws(() => planDependencyVolumes(dir, "/project"));
});

test("planDependencyVolumes: same lockfile content across two dirs yields identical volume names (cross-task reuse)", () => {
  const dirA = makeRepo({ lockContent: '{"x":1}' });
  const dirB = makeRepo({ lockContent: '{"x":1}' });
  const planA = planDependencyVolumes(dirA, "/project");
  const planB = planDependencyVolumes(dirB, "/project");
  assert.equal(planA.volumes[0]!.name, planB.volumes[0]!.name);
});

test("removeDependencyVolumes: never throws when neither worktree path exists", () => {
  assert.doesNotThrow(() => removeDependencyVolumes("run-nope", "task-nope"));
});

test("removeDependencyVolumes: never throws when the worktree exists but has no lockfile", () => {
  const runId = "run-fg376-nolock";
  const taskId = "task-fg376-nolock";
  const path = worktreeDir(runId, taskId);
  mkdirSync(path, { recursive: true });
  try {
    assert.doesNotThrow(() => removeDependencyVolumes(runId, taskId));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("removeDependencyVolumes: never throws when a real lockfile is present (docker call best-effort)", () => {
  const runId = "run-fg376-lock";
  const taskId = "task-fg376-lock";
  const path = worktreeDir(runId, taskId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package-lock.json"), "{}");
  try {
    assert.doesNotThrow(() => removeDependencyVolumes(runId, taskId));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("removeDependencyVolumes: also checks the integration-worktree path for the same (runId, taskId)", () => {
  const runId = "run-fg376-integ";
  const parentTaskId = "task-fg376-parent";
  const path = integrationWorktreeDir(runId, parentTaskId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package-lock.json"), "{}");
  try {
    assert.doesNotThrow(() => removeDependencyVolumes(runId, parentTaskId));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

// ── safeLockfileHash ──────────────────────────────────────────────────────────

test("safeLockfileHash: returns the hash when a lockfile is present, undefined otherwise", () => {
  const withLock = makeRepo({ lockContent: '{"x":1}' });
  const withoutLock = makeRepo();
  assert.equal(safeLockfileHash(withLock), lockfileHash(withLock));
  assert.equal(safeLockfileHash(withoutLock), undefined);
});

// ── FIX5: workspace path safety ───────────────────────────────────────────────

test("isSafeWorkspacePath: accepts simple relative paths", () => {
  assert.equal(isSafeWorkspacePath("dashboard"), true);
  assert.equal(isSafeWorkspacePath("packages/foo"), true);
});

test("isSafeWorkspacePath: rejects absolute paths, traversal, and empty/whitespace entries", () => {
  assert.equal(isSafeWorkspacePath("/etc/passwd"), false);
  assert.equal(isSafeWorkspacePath("../../etc"), false);
  assert.equal(isSafeWorkspacePath(".."), false);
  assert.equal(isSafeWorkspacePath(""), false);
  assert.equal(isSafeWorkspacePath("   "), false);
  assert.equal(isSafeWorkspacePath("dashboard/../../etc"), false, "traversal that only surfaces after normalization must also be rejected");
  assert.equal(isSafeWorkspacePath(" dashboard"), false, "leading/trailing whitespace is rejected outright, not trimmed-and-accepted");
});

test("isSafeWorkspacePath: rejects dot-segment / root-equivalent entries ('.', './', 'a/./..', 'a/../.') — must not duplicate the implicit root member", () => {
  assert.equal(isSafeWorkspacePath("."), false);
  assert.equal(isSafeWorkspacePath("./"), false);
  assert.equal(isSafeWorkspacePath("a/./.."), false);
  assert.equal(isSafeWorkspacePath("a/../."), false);
  // Still accepted: a real relative path strictly under the tree.
  assert.equal(isSafeWorkspacePath("dashboard"), true);
});

test("workspaceMembers: a root-equivalent workspaces entry never duplicates the implicit root member", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: [".", "./", "a/./..", "dashboard"] });
  const members = workspaceMembers(dir);
  assert.deepEqual(members, [{ relPath: "" }, { relPath: "dashboard" }], "root-equivalent entries must be excluded, not added as a second '' member");
});

test("workspaceMembers: rejects a traversal workspaces entry — never becomes a mount-target member", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: ["../../etc", "dashboard"] });
  const members = workspaceMembers(dir);
  assert.deepEqual(members, [{ relPath: "" }, { relPath: "dashboard" }]);
  assert.ok(!members.some((m) => m.relPath.includes("..")));
});

test("workspaceMembers: rejects an absolute-path workspaces entry", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: ["/etc/passwd", "dashboard"] });
  const members = workspaceMembers(dir);
  assert.deepEqual(members, [{ relPath: "" }, { relPath: "dashboard" }]);
});

test("planDependencyVolumes: a rejected workspaces entry never produces a mount/volume containerPath", () => {
  const dir = makeRepo({ lockContent: "{}", workspaces: ["../../etc", "/etc/passwd"] });
  const plan = planDependencyVolumes(dir, "/project");
  assert.equal(plan.volumes.length, 1, "only the root member survives");
  assert.ok(!plan.volumes.some((v) => v.containerPath.includes("etc")));
});

// ── FIX2: host-side lock + ready marker per cache key ─────────────────────────

test("isDependencyCacheReady / markDependencyCacheReady: round-trip", () => {
  const key = "fix2-roundtrip-key";
  assert.equal(isDependencyCacheReady(key), false);
  markDependencyCacheReady(key);
  assert.equal(isDependencyCacheReady(key), true);
});

test("acquireDependencyCacheLock: serializes two concurrent acquires for the same cache key — the second only proceeds after the first releases", async () => {
  const key = "fix2-serialize-key";
  const order: string[] = [];

  const release1 = await acquireDependencyCacheLock(key);
  order.push("first-acquired");

  // Second acquire must block — race it against a delayed release of the first.
  const secondAcquire = acquireDependencyCacheLock(key).then((release2) => {
    order.push("second-acquired");
    release2();
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ["first-acquired"], "second acquire must still be blocked while the first holds the lock");

  order.push("first-released");
  release1();
  await secondAcquire;

  assert.deepEqual(order, ["first-acquired", "first-released", "second-acquired"]);
});

test("FIX2: a failed provisioner leaves no ready marker — a later attempt re-provisions", async () => {
  const key = "fix2-failure-no-marker-key";
  assert.equal(isDependencyCacheReady(key), false);

  // First attempt: acquires the lock, sees no marker (needs to provision),
  // "installs" but FAILS — never calls markDependencyCacheReady — then releases.
  const release1 = await acquireDependencyCacheLock(key);
  const firstNeedsInstall = !isDependencyCacheReady(key);
  assert.equal(firstNeedsInstall, true);
  // Simulated container exit 123 (DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE): no mark.
  release1();

  assert.equal(isDependencyCacheReady(key), false, "a failed provisioner must leave no ready marker");

  // Second attempt re-provisions (sees the same "needs install" state).
  const release2 = await acquireDependencyCacheLock(key);
  const secondNeedsInstall = !isDependencyCacheReady(key);
  assert.equal(secondNeedsInstall, true, "next attempt must re-provision, not wrongly reuse");
  markDependencyCacheReady(key); // this attempt succeeds
  release2();

  assert.equal(isDependencyCacheReady(key), true);
});

// ── provisionDependencyCache: the full short-provisioner orchestration ────────
// Replaces the old whole-run lock: this owns the lock for ONLY the duration of
// the caller-supplied `runProvisioner` — never for whatever the caller does
// with the result afterward (i.e. spawning the real agent container).

test("provisionDependencyCache (a): a missing marker runs the provisioner exactly once and marks the cache ready on success", async () => {
  const key = "provision-a-" + Math.random().toString(36).slice(2);
  let calls = 0;
  const result = await provisionDependencyCache(key, async () => {
    calls++;
    return { exitCode: 0, stderrTail: "" };
  });
  assert.deepEqual(result, { outcome: "ready" });
  assert.equal(calls, 1, "the provisioner must run exactly once");
  assert.equal(isDependencyCacheReady(key), true);
});

test("provisionDependencyCache (b): an already-ready marker never runs the provisioner and never takes the lock", async () => {
  const key = "provision-b-" + Math.random().toString(36).slice(2);
  markDependencyCacheReady(key);
  let calls = 0;
  const result = await provisionDependencyCache(key, async () => {
    calls++;
    return { exitCode: 0, stderrTail: "" };
  });
  assert.deepEqual(result, { outcome: "ready" });
  assert.equal(calls, 0, "an already-ready cache must never invoke the provisioner");
});

test("provisionDependencyCache (c): concurrent calls for the same key — exactly one provisions, the other reuses the marker (no double-install)", async () => {
  const key = "provision-c-" + Math.random().toString(36).slice(2);
  let calls = 0;
  let resolveFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((r) => { resolveFirst = r; });

  const first = provisionDependencyCache(key, async () => {
    calls++;
    await firstGate; // hold the lock open until the test releases it below
    return { exitCode: 0, stderrTail: "" };
  });

  // Give the first call a moment to acquire the lock and enter its provisioner.
  await new Promise((r) => setTimeout(r, 20));
  const second = provisionDependencyCache(key, async () => {
    calls++;
    return { exitCode: 0, stderrTail: "" };
  });

  resolveFirst!();
  const [r1, r2] = await Promise.all([first, second]);

  assert.deepEqual(r1, { outcome: "ready" });
  assert.deepEqual(r2, { outcome: "ready" });
  assert.equal(calls, 1, "the second (concurrent) dispatch must reuse the marker, never provision a second time");
});

test("provisionDependencyCache (d): a failed provisioner leaves no marker, releases the lock, and reports a verification_environment_unavailable-shaped error; the next call re-provisions", async () => {
  const key = "provision-d-" + Math.random().toString(36).slice(2);

  const firstCalls: number[] = [];
  const first = await provisionDependencyCache(key, async () => {
    firstCalls.push(1);
    return { exitCode: 123, stderrTail: "npm ci failed: EACCES" };
  });
  assert.equal(first.outcome, "failed");
  if (first.outcome === "failed") {
    assert.match(first.error, /verification_environment_unavailable/);
    assert.match(first.error, /npm ci failed: EACCES/);
    assert.match(first.error, /exit 123/);
  }
  assert.equal(isDependencyCacheReady(key), false, "a failed provisioner must leave no ready marker");

  // A later dispatch for the same key must re-attempt provisioning, not treat
  // the earlier failure as somehow settling the key.
  let secondCalls = 0;
  const second = await provisionDependencyCache(key, async () => {
    secondCalls++;
    return { exitCode: 0, stderrTail: "" };
  });
  assert.equal(secondCalls, 1, "the next dispatch must re-provision after a failed attempt");
  assert.deepEqual(second, { outcome: "ready" });
  assert.equal(isDependencyCacheReady(key), true);
});

// ── FIX1 (FG-376 round 3): dead orchestrator pid ≠ dead provisioner container ──
// acquireDependencyCacheLock/provisionDependencyCache no longer trust a dead
// pid alone — a dead-pid lock is only stolen once the recorded provisioner
// container (LockInfo.holderId, set to provisionerContainerName(cacheKey)) is
// confirmed gone. No real docker is used here: isContainerAlive/killContainer
// are injected fakes, matching the "injectable docker-inspect seam for
// tests" requirement.

function cacheLockPathForTest(cacheKey: string): string {
  return join(process.env.FORGE_HOME!, "dependency-cache", `${cacheKey}.lock`);
}

// Deterministic pid-liveness fakes — same convention as run-lock.test.ts:
// never rely on a real OS pid (999999 is "almost certainly dead" but not
// guaranteed), always inject.
const DEAD = () => false;
const ALIVE = () => true;

function writeDeadOrchestratorLock(cacheKey: string): void {
  mkdirSync(join(process.env.FORGE_HOME!, "dependency-cache"), { recursive: true });
  writeFileSync(
    cacheLockPathForTest(cacheKey),
    JSON.stringify({
      pid: 999999, // guaranteed-dead pid — the crashed host orchestrator
      command: `dependency-cache:${cacheKey}`,
      acquiredAtMs: Date.now(),
      acquiredAt: new Date().toISOString(),
      holderId: provisionerContainerName(cacheKey),
    }),
  );
}

test("FIX1 (a): a dead-pid lock whose provisioner container is still ALIVE is not stolen into a concurrent second provisioner — the orphan is killed first, then stolen", async () => {
  const key = "fix1-alive-container-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  let containerRunning = true;
  const killed: string[] = [];
  const aliveChecks: string[] = [];

  const release = await acquireDependencyCacheLock(key, {
    isAlive: DEAD,
    isContainerAlive: (id) => { aliveChecks.push(id); return containerRunning; },
    killContainer: (id) => { killed.push(id); containerRunning = false; return "killed"; },
  });

  assert.deepEqual(aliveChecks, [provisionerContainerName(key)], "must check liveness of the exact container recorded in the lock");
  assert.deepEqual(killed, [provisionerContainerName(key)], "an alive orphan must be killed before the lock is stolen — never silently raced");
  assert.equal(containerRunning, false, "by the time we hold the lock, the orphan is confirmed dead — no window for a concurrent second provisioner");
  release();
});

test("FIX1 (a): the kill-then-steal path never lets two provisioners hold the lock for the same key at once", async () => {
  const key = "fix1-no-concurrent-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  let holders = 0;
  let maxConcurrentHolders = 0;
  let containerRunning = true;

  const provision = await provisionDependencyCache(
    key,
    async () => {
      holders++;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, holders);
      await new Promise((r) => setTimeout(r, 20));
      holders--;
      return { exitCode: 0, stderrTail: "" };
    },
    {
      isAlive: DEAD,
      isContainerAlive: () => containerRunning,
      killContainer: () => { containerRunning = false; return "killed"; },
    },
  );

  assert.equal(maxConcurrentHolders, 1, "no two provisioners for the same cache key ever run concurrently, including after a simulated orchestrator crash");
  assert.deepEqual(provision, { outcome: "ready" });
});

test("FIX1 (b): a dead-pid lock whose provisioner container is GONE is stolen and reprovisions, with no kill call", async () => {
  const key = "fix1-gone-container-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  const killed: string[] = [];
  let provisionerCalls = 0;

  const result = await provisionDependencyCache(
    key,
    async () => { provisionerCalls++; return { exitCode: 0, stderrTail: "" }; },
    {
      isAlive: DEAD,
      isContainerAlive: () => false, // the orphan container already exited/was reaped
      killContainer: (id) => { killed.push(id); return "killed"; },
    },
  );

  assert.equal(killed.length, 0, "a container that's already gone needs no kill call");
  assert.equal(provisionerCalls, 1, "safe to steal + reprovision once the container is confirmed gone");
  assert.deepEqual(result, { outcome: "ready" });
  assert.equal(isDependencyCacheReady(key), true);
});

test("FIX1 (c): a LIVE holder pid is still waited out — isContainerAlive/killContainer are never consulted (unchanged pre-FIX1 behavior)", async () => {
  const key = "fix1-live-pid-" + Math.random().toString(36).slice(2);
  mkdirSync(join(process.env.FORGE_HOME!, "dependency-cache"), { recursive: true });
  writeFileSync(
    cacheLockPathForTest(key),
    JSON.stringify({
      pid: process.pid, // this test process — genuinely alive
      command: `dependency-cache:${key}`,
      acquiredAtMs: Date.now(),
      acquiredAt: new Date().toISOString(),
      holderId: provisionerContainerName(key),
    }),
  );

  let aliveCalls = 0;
  let killCalls = 0;
  let acquired = false;
  const attempt = acquireDependencyCacheLock(key, {
    isAlive: ALIVE,
    isContainerAlive: () => { aliveCalls++; return true; },
    killContainer: () => { killCalls++; return "killed"; },
  }).then((release) => { acquired = true; release(); });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(acquired, false, "a live pid holder must still be waited out, exactly as before FIX1");
  assert.equal(aliveCalls, 0, "the container-liveness seam is a dead-pid-only hook — a live pid must never reach it");
  assert.equal(killCalls, 0);

  // Simulate the live holder finishing and releasing on its own.
  rmSync(cacheLockPathForTest(key), { force: true });
  await attempt;
  assert.equal(acquired, true);
});

// ── FIX (kill-then-steal must not swallow all errors) ───────────────────────
// dockerKillContainer/onDeadHolder used to collapse EVERY execFileSync
// failure into the same outcome as success, so a genuine kill failure (daemon
// hiccup, permission error) was indistinguishable from a confirmed kill and
// the caller stole the lock anyway — starting a SECOND provisioner while the
// orphan might still be alive and installing. killContainer now returns a
// discriminated 'killed' | 'not_found' | 'error', and onDeadHolder only
// treats 'killed'/'not_found' as confirmed gone.

test("FIX (kill-then-steal): an UNCONFIRMED kill ('error') is never treated as confirmed-gone — no steal, no second provisioner, until the container is later confirmed gone", async () => {
  const key = "fix-kill-error-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  let containerRunning = true;
  const killAttempts: string[] = [];
  let provisionerStarts = 0;
  let maxConcurrentProvisioners = 0;
  let activeProvisioners = 0;

  const provisionPromise = provisionDependencyCache(
    key,
    async () => {
      activeProvisioners++;
      provisionerStarts++;
      maxConcurrentProvisioners = Math.max(maxConcurrentProvisioners, activeProvisioners);
      await new Promise((r) => setTimeout(r, 20));
      activeProvisioners--;
      return { exitCode: 0, stderrTail: "" };
    },
    {
      isAlive: DEAD,
      isContainerAlive: () => containerRunning,
      killContainer: (id) => {
        killAttempts.push(id);
        // Still-alive orphan → the kill genuinely fails (e.g. docker daemon
        // hiccup) rather than succeeding or reporting not-found.
        return "error";
      },
    },
  );

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(provisionerStarts, 0, "an unconfirmed kill must never let a second provisioner start for this cache key");
  assert.ok(killAttempts.length > 0, "the kill must have been attempted");
  assert.ok(killAttempts.every((id) => id === provisionerContainerName(key)), "must only ever attempt to kill the exact recorded orphan");

  // A later pass (or the orphan itself exiting) confirms the container is
  // actually gone now — only then is the steal safe.
  containerRunning = false;
  const result = await provisionPromise;

  assert.equal(provisionerStarts, 1, "exactly one provisioner ever ran for this cache key");
  assert.equal(maxConcurrentProvisioners, 1, "no two provisioners for the same cache key ever ran concurrently, including across the unconfirmed-kill window");
  assert.deepEqual(result, { outcome: "ready" });
});

test("FIX (kill-then-steal): kill() reporting 'not_found' (container vanished between the inspect and the kill) still confirms gone and steals", async () => {
  const key = "fix-kill-not-found-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  const killAttempts: string[] = [];
  let provisionerCalls = 0;

  const result = await provisionDependencyCache(
    key,
    async () => { provisionerCalls++; return { exitCode: 0, stderrTail: "" }; },
    {
      isAlive: DEAD,
      isContainerAlive: () => true, // inspect says running (about to race)
      killContainer: (id) => { killAttempts.push(id); return "not_found"; }, // ...but it's already gone by the time we act
    },
  );

  assert.equal(killAttempts.length, 1, "the kill must have been attempted since isContainerAlive reported running");
  assert.equal(provisionerCalls, 1, "'not_found' is CONFIRMED GONE — safe to steal + reprovision, exactly like an explicit 'killed'");
  assert.deepEqual(result, { outcome: "ready" });
  assert.equal(isDependencyCacheReady(key), true);
});

// ── LOW#2: re-provision after a kill covers every plan volume, not just root ─

test("LOW#2: after a kill-then-steal reprovision, the caller-supplied plan (as spawn.ts would build it) still covers every workspace-member volume, not just the repo root", async () => {
  const key = "low2-workspace-coverage-" + Math.random().toString(36).slice(2);
  writeDeadOrchestratorLock(key);

  const repo = makeRepo({ lockContent: '{"lockfileVersion":3}', workspaces: ["dashboard"] });
  const plan = planDependencyVolumes(repo, "/project");
  assert.equal(plan.volumes.length, 2, "test setup: expected a root volume + one workspace-member volume");
  assert.ok(plan.volumes.some((v) => v.relPath === ""), "test setup: expected the repo-root volume in the plan");
  assert.ok(plan.volumes.some((v) => v.relPath === "dashboard"), "test setup: expected the workspace-member volume in the plan");

  let containerRunning = true;
  const installedVolumeNames: string[] = [];

  const result = await provisionDependencyCache(
    key,
    // Mirrors what runNext.ts's provisioner callback does: it always installs
    // the FULL plan (buildProvisionerDockerArgs mounts every plan.volumes
    // entry rw in the SAME npm ci run), never just the root volume.
    async () => {
      for (const v of plan.volumes) installedVolumeNames.push(v.name);
      return { exitCode: 0, stderrTail: "" };
    },
    {
      isAlive: DEAD,
      isContainerAlive: () => containerRunning,
      killContainer: (id) => { containerRunning = false; return "killed"; },
    },
  );

  assert.deepEqual(result, { outcome: "ready" });
  assert.equal(installedVolumeNames.length, 2, "the reprovision after the kill must cover every plan volume, not only the repo root");
  assert.ok(
    plan.volumes.every((v) => installedVolumeNames.includes(v.name)),
    `expected every plan volume (root + workspace members) to be reinstalled, got: ${JSON.stringify(installedVolumeNames)}`,
  );
});

// ── FIX3 (FG-376 round 3): ready marker written via temp-then-rename ────────

test("FIX3: markDependencyCacheReady writes via <path>.tmp then rename — a crash between them leaves no ready marker", () => {
  const key = "fix3-atomic-" + Math.random().toString(36).slice(2);
  const markerDir = join(process.env.FORGE_HOME!, "dependency-cache");
  const markerPath = join(markerDir, `${key}.ready`);
  const tmpPath = `${markerPath}.tmp`;

  assert.equal(isDependencyCacheReady(key), false);

  // Simulate a crash that landed AFTER the temp write but BEFORE the rename —
  // exactly the window FIX3 closes. A partial/torn temp file must never be
  // mistaken for the real marker.
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(tmpPath, "2020-01-01T00:00:00.000Z");
  assert.ok(existsSync(tmpPath), "test setup: temp file exists");
  assert.equal(isDependencyCacheReady(key), false, "a lone .tmp file must never be read as the ready marker");

  // The next dispatch sees "not ready" and (re)provisions, then calls the
  // real function, which must complete the rename atomically.
  markDependencyCacheReady(key);
  assert.equal(isDependencyCacheReady(key), true);
  assert.equal(readFileSync(markerPath, "utf8").length > 0, true);
});

test("FIX3: markDependencyCacheReady leaves no leftover .tmp file after a successful write", () => {
  const key = "fix3-no-leftover-" + Math.random().toString(36).slice(2);
  const tmpPath = join(process.env.FORGE_HOME!, "dependency-cache", `${key}.ready.tmp`);
  markDependencyCacheReady(key);
  assert.equal(isDependencyCacheReady(key), true);
  assert.equal(existsSync(tmpPath), false, "rename must consume the temp file, not copy it");
});
