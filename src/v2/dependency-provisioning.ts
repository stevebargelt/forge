// FG-376: agent worktree dependency parity.
//
// Gives engineer/test-engineer/Shipping-Reviewer containers a REAL node_modules
// graph inside their disposable worktree, instead of the empty/shadowed mount
// that made full-repo `npm test` / `npm run typecheck` unreliable in a
// container. Volumes are keyed by a hash of the repo-root package-lock.json,
// NOT by run/task id — so two tasks that see the same lockfile (e.g. an
// engineer and the Shipping Reviewer verifying the same commit) can reuse the
// same already-installed volume instead of each paying for a fresh install.
// A lockfile edit changes the hash, which changes the volume name, which
// naturally invalidates any stale install rather than silently reusing it.
//
// Scope (see FG-376 non-goals): macOS-first. workspaces entries are read
// verbatim from package.json — glob patterns are not expanded in this cut.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { worktreeDir, integrationWorktreeDir } from "../util/paths.js";
import { acquireFileLockBlocking, releaseFileLock, type LockInfo } from "../util/run-lock.js";

/** Exit code the container entrypoint uses when dependency installation fails
 *  before exec'ing the agent command. Recognized by invoke.ts/runNext.ts's
 *  container-exit handlers ahead of the generic container_crash branch, so a
 *  broken install is reported as `verification_environment_unavailable`
 *  instead of being misread as a test failure or a generic crash. */
export const DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE = 123;

/** Idle timeout for the short-lived provisioner container's docker exec (no
 *  stdout/stderr for this long ⇒ the install is presumed hung and the
 *  container is killed). This is the "sane install timeout" that provides
 *  crash-safety for the provisioning lock in place of stealing a live
 *  holder's lock (see run-lock.ts) — a hung provisioner gets killed, its
 *  caller releases the lock, and the next dispatch re-attempts. */
export const DEPENDENCY_PROVISIONER_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10m

export type WorkspaceMember = {
  /** Relative path from repo root; "" for the repo root itself. */
  relPath: string;
};

/** Hash package-lock.json content — the single source of truth for "has the
 *  dependency graph changed". Throws if the repo has no npm lockfile (non-npm
 *  project, or a bare test fixture dir) — callers treat that as "no
 *  provisioning plan for this project" and fall back accordingly. */
export function lockfileHash(repoRoot: string): string {
  const lockPath = join(repoRoot, "package-lock.json");
  if (!existsSync(lockPath)) {
    throw new Error(`dependency-provisioning: no package-lock.json at ${repoRoot}`);
  }
  return createHash("sha256").update(readFileSync(lockPath)).digest("hex").slice(0, 16);
}

/** lockfileHash, or undefined when the repo has no package-lock.json. Lets
 *  callers (runNext.ts) decide "is there a dependency-cache plan for this repo
 *  at all" from just a repoRoot, without needing the container mount path
 *  planDependencyVolumes requires. Also THE cache key used by the FIX2
 *  lock/ready-marker (see dependencyCacheDir below). */
export function safeLockfileHash(repoRoot: string): string | undefined {
  try {
    return lockfileHash(repoRoot);
  } catch {
    return undefined;
  }
}

/** FIX5 (FG-376 review): package.json `workspaces` entries are repo content —
 *  a crafted entry must never reach a docker volume mount destination or the
 *  entrypoint's `sudo chown` target list. Accept ONLY a normalized relative
 *  path that stays inside the project subtree: reject absolute paths, `..`
 *  traversal (including via a normalized "dir/../../etc"), and empty/
 *  whitespace entries. */
export function isSafeWorkspacePath(relPath: string): boolean {
  if (relPath.trim().length === 0 || relPath.trim() !== relPath) return false;
  if (isAbsolute(relPath)) return false;
  const normalized = normalize(relPath);
  if (isAbsolute(normalized)) return false;
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return false;
  // A workspace entry that normalizes to the project root itself ('.', './',
  // 'a/./..', 'a/../.') is not a distinct member — it would mount at the same
  // container path as the implicit root member (see workspaceMembers below),
  // silently duplicating it. Must stay strictly UNDER the project tree.
  if (normalized === "." || normalized === `.${sep}`) return false;
  return true;
}

/** Every workspace member that needs its own node_modules volume: the repo
 *  root plus each non-glob entry in package.json's `workspaces` array. */
export function workspaceMembers(repoRoot: string): WorkspaceMember[] {
  const members: WorkspaceMember[] = [{ relPath: "" }];
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return members;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
  for (const w of workspaces) {
    if (typeof w !== "string" || w.includes("*")) continue; // globs unsupported in this first cut
    if (!isSafeWorkspacePath(w)) {
      // FIX5: exclude with a logged diagnostic rather than silently passing an
      // unvalidated path through to a mount destination or chown target.
      console.error(
        `forge: dependency-provisioning: rejecting unsafe workspaces entry "${w}" in ${pkgPath} ` +
          "(must be a relative path that stays inside the project)",
      );
      continue;
    }
    members.push({ relPath: w });
  }
  return members;
}

/** Derive a stable docker volume name from a lockfile hash + workspace member
 *  path. Same (hash, relPath) always yields the same name — the basis for
 *  cross-task reuse when the lockfile hasn't changed. */
export function dependencyVolumeName(hash: string, relPath: string): string {
  const slug = relPath ? relPath.replace(/[^a-zA-Z0-9._-]+/g, "-") : "root";
  return `forge-deps-${hash}-${slug}`;
}

export type DependencyVolume = { name: string; relPath: string; containerPath: string };

export type DependencyVolumePlan = {
  volumes: DependencyVolume[];
  lockfileHash: string;
  /** Repo-root container path — FORGE_NM_INSTALL_ROOT for the entrypoint. */
  installRoot: string;
};

/** Compute the full set of dependency volumes for a project: one per
 *  workspace member, all keyed off the same repo-root lockfile hash so they
 *  invalidate together. Throws if repoRoot has no package-lock.json — callers
 *  treat that as "no plan" (e.g. spawn.ts falls back to the legacy anonymous
 *  shadow volume for non-npm projects / bare test fixtures). */
export function planDependencyVolumes(repoRoot: string, projectContainerPath: string): DependencyVolumePlan {
  const hash = lockfileHash(repoRoot);
  const volumes = workspaceMembers(repoRoot).map((m) => ({
    name: dependencyVolumeName(hash, m.relPath),
    relPath: m.relPath,
    containerPath: m.relPath ? `${projectContainerPath}/${m.relPath}/node_modules` : `${projectContainerPath}/node_modules`,
  }));
  return { volumes, lockfileHash: hash, installRoot: projectContainerPath };
}

function volumeNamesForRepoRoot(repoRoot: string): string[] {
  const hash = lockfileHash(repoRoot);
  return workspaceMembers(repoRoot).map((m) => dependencyVolumeName(hash, m.relPath));
}

// ── Host-side lock + ready marker per cache key ──────────────────────────────
// The cache key IS the lockfile hash: every workspace-member volume for a
// given lockfile is populated by ONE npm ci/install command (run once, from
// the plan's installRoot, inside a dedicated short-lived provisioner
// container — see docker/agent-entrypoint.sh and spawn.ts's
// buildProvisionerDockerArgs), so all of a plan's volumes become ready
// together. One lock + one marker per hash is therefore the correct grain —
// not one per volume.
//
// The lock is scoped to that provisioner container ONLY — never to the agent
// container's run. A prior version acquired this lock before deciding whether
// to install and held it across the entire agent container's execution
// (potentially many minutes of agent reasoning, not just the ~seconds/minutes
// of `npm ci`). That serialized unrelated concurrent work for no reason, and
// combined with a stale-lock steal it could let a second dispatcher install
// into the SAME rw volume while the first was still using it. See
// provisionDependencyCache below for the current, narrowly-scoped flow.

function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(process.env.HOME ?? "/", ".forge");
}

function dependencyCacheDir(): string {
  return join(forgeHome(), "dependency-cache");
}

function cacheLockPath(cacheKey: string): string {
  return join(dependencyCacheDir(), `${cacheKey}.lock`);
}

function readyMarkerPath(cacheKey: string): string {
  return join(dependencyCacheDir(), `${cacheKey}.ready`);
}

/** True once a provisioner has successfully installed the dependency plan for
 *  this cache key (lockfile hash) — callers reuse the populated volume(s)
 *  instead of re-installing. */
export function isDependencyCacheReady(cacheKey: string): boolean {
  return existsSync(readyMarkerPath(cacheKey));
}

/** Record that cacheKey's volume(s) are fully installed. Callers must call
 *  this ONLY after a provisioning container exits 0, while still holding the
 *  lock returned by acquireDependencyCacheLock — never on a failed install
 *  (DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE), so a failed provisioner leaves
 *  no marker and a later attempt re-provisions.
 *
 *  FIX3 (FG-376 round 3): write via temp-then-rename, not a direct
 *  writeFileSync. rename(2) is atomic, so a crash mid-write can never leave a
 *  partial/torn marker file for isDependencyCacheReady to misread as ready —
 *  worst case the crash lands before the rename and the marker simply doesn't
 *  exist yet, which is exactly the "needs (re)provisioning" state callers
 *  already handle. */
export function markDependencyCacheReady(cacheKey: string): void {
  mkdirSync(dependencyCacheDir(), { recursive: true });
  const path = readyMarkerPath(cacheKey);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, new Date().toISOString());
  renameSync(tmp, path);
}

// ── FIX1 (FG-376 round 3): dead-orchestrator-pid ≠ dead provisioner ──────────
// acquireFileLockBlocking records process.pid — the HOST orchestrator — as
// the holder, but the actual `npm ci` runs in a separate, short-lived
// forge-provision-<cacheKey> docker container that can outlive an
// orchestrator crash. A dead orchestrator pid used to be enough to steal the
// lock; that let a second dispatch start a CONCURRENT provisioner writing the
// same rw dependency volume the first (still-running) one was writing —
// exactly the corruption this lock exists to prevent. onDeadHolder below
// closes that: before stealing a dead-pid lock, check whether the recorded
// provisioner container is still alive, and if so kill it first (a dead
// orchestrator will never clean up its own container) so the steal can never
// race a live install. Real docker calls are the default; tests inject fakes
// so no real docker is required to exercise this.

export type ContainerLivenessProbe = (containerId: string) => boolean;

function dockerContainerAlive(containerId: string): boolean {
  try {
    const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", containerId], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim() === "true";
  } catch {
    return false; // not found / docker unavailable → treat as gone, safe to steal
  }
}

/** Outcome of a kill-then-steal container-kill attempt, discriminated so the
 *  caller (onDeadHolder below) can tell a CONFIRMED-gone container ('killed'
 *  or 'not_found') from one that's merely unconfirmed ('error' — docker
 *  daemon hiccup, permission error, timeout, or any other failure). A prior
 *  version swallowed every execFileSync failure the same way, so a genuine
 *  kill failure was indistinguishable from success and the caller stole the
 *  lock anyway — reopening the concurrent-write corruption window this lock
 *  exists to prevent. */
export type ContainerKillResult = "killed" | "not_found" | "error";

function dockerKillContainer(containerId: string): ContainerKillResult {
  try {
    execFileSync("docker", ["rm", "-f", containerId], { stdio: ["ignore", "ignore", "pipe"] });
    return "killed";
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string } | undefined)?.stderr?.toString() ?? "";
    if (/no such container/i.test(stderr)) return "not_found";
    return "error"; // NOT confirmed gone — the caller must not treat this as safe to steal
  }
}

/** Deterministic provisioner container name for a cache key — the SAME name
 *  buildProvisionerDockerArgs (spawn.ts) gives the actual `docker run`, so a
 *  would-be lock stealer can identify/kill the exact orphaned container
 *  recorded in LockInfo.holderId. Keyed by cache key (not taskId): that
 *  matches the lock's own grain (one provisioner per lockfile hash, see
 *  above) and means dependency-provisioning.ts never needs a taskId to know
 *  what to check. */
export function provisionerContainerName(cacheKey: string): string {
  return `forge-provision-${cacheKey}`;
}

export type DependencyCacheLockOpts = {
  isContainerAlive?: ContainerLivenessProbe;
  killContainer?: (containerId: string) => ContainerKillResult;
  // Test-only seam for the recorded holder PID's own liveness (independent of
  // the container check above) — mirrors acquireFileLockBlocking's isAlive.
  // Real callers never set this; production always uses the real pid check.
  isAlive?: (pid: number) => boolean;
};

/** Block until this task is the sole holder of cacheKey's provisioning lock.
 *  A second dispatch for the same cache key blocks here until the first
 *  either marks the cache ready (success, then releases) or releases without
 *  a marker (failure) — at which point the second re-checks
 *  isDependencyCacheReady itself and decides whether it must provision too.
 *  Returns a release function the caller MUST call exactly once, on every
 *  exit path (success or failure), before this task's container-spawn logic
 *  returns. Host-side only; the container itself never takes this lock. */
export async function acquireDependencyCacheLock(cacheKey: string, opts?: DependencyCacheLockOpts): Promise<() => void> {
  mkdirSync(dependencyCacheDir(), { recursive: true });
  const path = cacheLockPath(cacheKey);
  const containerAlive = opts?.isContainerAlive ?? dockerContainerAlive;
  const kill = opts?.killContainer ?? dockerKillContainer;
  // LOW#3: acquireFileLockBlocking's own default onDeadHolder (no callback
  // supplied) is an immediate steal — see run-lock.ts. That default is unsafe
  // for THIS lock, whose real work runs in a docker container that can
  // outlive the host pid, so onDeadHolder is ALWAYS supplied below; never
  // remove it or make it conditional.
  await acquireFileLockBlocking(path, `dependency-cache:${cacheKey}`, {
    ...(opts?.isAlive ? { isAlive: opts.isAlive } : {}),
    holderId: provisionerContainerName(cacheKey),
    onDeadHolder: (held: LockInfo) => {
      const containerId = held.holderId;
      // No recorded container (a lock written before this fix, or by a
      // caller that never set holderId) — nothing to check against, fall
      // back to the pre-FIX1 behavior of stealing a dead-pid holder outright.
      if (!containerId) return "steal";
      if (!containerAlive(containerId)) return "steal"; // confirmed already gone
      const result = kill(containerId);
      // 'killed' or 'not_found' (the container vanished between the inspect
      // above and this kill call) are both CONFIRMED GONE — safe to steal.
      // Anything else ('error': daemon hiccup, permission error, timeout,
      // ambiguous) is NOT confirmed gone — stealing here could start a
      // second provisioner while the orphan is still alive and installing.
      // "wait" re-enters this same onDeadHolder on the next poll cycle (the
      // pid stays dead), so a transient failure retries the kill rather than
      // giving up; a still-genuinely-alive orphan is simply waited out until
      // it finishes or a later pass confirms it's gone.
      if (result === "killed" || result === "not_found") return "steal";
      return "wait";
    },
  });
  return () => releaseFileLock(path);
}

export type ProvisionDependencyCacheResult =
  | { outcome: "ready" }
  | { outcome: "failed"; error: string };

/** The full provisioning decision for one cache key, in one call: check the
 *  ready marker, and only if it's missing, acquire the short-lived lock, deal
 *  with the double-check-after-acquire race (another dispatch may have
 *  finished provisioning while this call was blocked on the lock), run the
 *  caller-supplied provisioner, and mark-or-not based on its exit code —
 *  always releasing the lock before returning.
 *
 *  `runProvisioner` is the caller's job (spawn.ts's buildProvisionerDockerArgs
 *  + a docker exec call) — this function stays docker-agnostic, matching the
 *  existing split where dependency-provisioning.ts owns locks/volumes/markers
 *  and spawn.ts/runNext.ts own the actual container invocation. Called AT
 *  MOST once, and only while holding the lock, so a provisioner never runs
 *  concurrently with another provisioner for the same cache key.
 *
 *  This is the ONLY place the lock is held — for the duration of one
 *  provisioner container, not the agent's run that follows. Callers must
 *  never mount the shared volume(s) read-write for anything other than the
 *  container `runProvisioner` spawns. */
export async function provisionDependencyCache(
  cacheKey: string,
  runProvisioner: () => Promise<{ exitCode: number; stderrTail: string }>,
  opts?: DependencyCacheLockOpts,
): Promise<ProvisionDependencyCacheResult> {
  if (isDependencyCacheReady(cacheKey)) return { outcome: "ready" };

  const release = await acquireDependencyCacheLock(cacheKey, opts);
  try {
    // Re-check: another dispatch may have provisioned and released while we
    // were blocked waiting for the lock — the whole point of the marker.
    if (isDependencyCacheReady(cacheKey)) return { outcome: "ready" };

    const { exitCode, stderrTail } = await runProvisioner();
    if (exitCode === 0) {
      markDependencyCacheReady(cacheKey);
      return { outcome: "ready" };
    }
    return {
      outcome: "failed",
      error:
        `verification_environment_unavailable: dependency install failed (provisioner exit ${exitCode})` +
        (stderrTail ? ` — ${stderrTail}` : ""),
    };
  } finally {
    release();
  }
}

/** Best-effort removal of every dependency volume a worktree could have
 *  created. NOT called from per-task/worktree disposal (FIX3 — a shared cache
 *  volume must not be torn down just because ONE task using it finished; other
 *  tasks may still reference the same cache key). NOT wired to any
 *  operator-accessible caller today — cache volumes are intentionally
 *  retained (`forge-deps-*` accumulate on disk across runs) rather than
 *  auto-pruned; an explicit `forge` prune command is tracked separately in
 *  FG-434, not part of this change. Tries both the regular task-worktree path
 *  and the fan-out integration-worktree path for (runId, taskId), since
 *  callers pass parentTaskId as `taskId` when pruning an integration
 *  worktree's volumes. Tolerates a missing worktree dir, a missing lockfile
 *  (nothing to compute), and an already-absent volume (docker volume rm exits
 *  non-zero; swallowed) — never throws. */
export function removeDependencyVolumes(runId: string, taskId: string): void {
  for (const repoRoot of [worktreeDir(runId, taskId), integrationWorktreeDir(runId, taskId)]) {
    let names: string[];
    try {
      names = volumeNamesForRepoRoot(repoRoot);
    } catch {
      continue; // worktree gone, or no lockfile there — nothing deterministic to remove
    }
    for (const name of names) {
      try {
        execFileSync("docker", ["volume", "rm", name], { stdio: "ignore" });
      } catch {
        // already absent, or still referenced elsewhere — best-effort
      }
    }
  }
}
