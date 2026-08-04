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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
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

/** FG-664: idle timeout for the short-lived dependency PROBE container. The probe
 *  walks the mounted roots and executes nothing, so it is a small fraction of an
 *  install; a probe that produces no output for this long is hung, not working.
 *
 *  This is an IDLE budget and the probe is written to make it one: it emits
 *  rate-limited progress on stderr while it scans (see DEPENDENCY_PROBE_SCRIPT).
 *  A probe that printed nothing until its final write would be running against a
 *  total-runtime budget instead, and a slow scan of a large dependency graph
 *  would be killed as `probe_failed` — a refusal that is FINAL, so every
 *  read-only dispatch on that project would be blocked with no repair path. */
export const DEPENDENCY_PROBE_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2m

/** FG-664: idle timeout for ONE load container — a single `process.dlopen` of a
 *  single artifact, which prints nothing at all when it works. So this one IS a
 *  total-silence budget, deliberately: there is no progress to report, and a load
 *  that has not exited by now is a driver that hangs on load, which is unloadable
 *  in the only sense that matters here. It covers container start as well as the
 *  dlopen, which is why it is the probe's 2m rather than the 60s the in-probe
 *  load child carried before the load moved into its own container — the cost of
 *  the extra margin is paid only by an environment that is already broken, and
 *  the cost of being too tight is a refusal of a dispatch that would have run. */
export const DEPENDENCY_LOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2m

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

/** FG-627, widened by FG-628: create the mountpoint DIRECTORY for every volume
 *  the plan for this tree will mount, inside the tree itself.
 *
 *  The provisioner mounts the project READ-ONLY and mounts each dependency
 *  volume at a path INSIDE it (buildProvisionerDockerArgs); so does every
 *  reviewer/red, at `:ro`. Docker has to create the mountpoint before it can
 *  bind there, and it cannot mkdir on a read-only rootfs — so a missing
 *  `<member>/node_modules` in the source tree kills the container before
 *  anything runs.
 *
 *  This is NOT confined to isolated workspaces. A main checkout only happens to
 *  carry the ROOT member's directory: a root-only install leaves every other
 *  workspace member's absent, and `node_modules` is gitignored so no fresh tree
 *  carries any of them — not `git clone --shared`, not `git worktree add`, and
 *  not an FG-425 publication candidate, which is the tree the reds actually
 *  review under worktree mode. FG-628 measured all three failing. Callers
 *  therefore establish the precondition against the tree that will actually be
 *  bound, at the point the read-only mount is decided (runNext.ts's
 *  runContainer); worktree-lifecycle.ts's two calls are now two more callers of
 *  this one mechanism rather than the only ones. The alternative is relaxing
 *  the read-only mount, which no caller may do.
 *
 *  The mountpoints are derived from planDependencyVolumes itself, with the tree
 *  standing in for the container path, so the set can never drift from what the
 *  spawn path actually mounts. An empty directory is not something git will
 *  report as a change (`status --porcelain`, and `--ignored` too), so this
 *  leaves even an operator's own live checkout clean for capture and the
 *  reaper. It is NOT beyond git's reach: `git clean -fdX` explicitly targets
 *  ignored paths and will remove an empty `<member>/node_modules` like any
 *  other. That is harmless — the next dispatch recreates the mountpoint.
 *
 *  Containment (FG-628 review): every mountpoint must genuinely land inside
 *  `workspacePath`. The member paths come from the tree's own package.json
 *  `workspaces`, so a member directory that is a SYMLINK out of the checkout
 *  would otherwise be followed and `mkdirSync` would create `node_modules`
 *  somewhere forge never intended to write — which breaks the whole safety
 *  argument above at its root. isSafeWorkspacePath is lexical and cannot see
 *  this: the escape happens through a symlink at an intermediate component, not
 *  through the text of the entry. So each mountpoint's deepest EXISTING
 *  ancestor is resolved through symlinks and required to be inside the resolved
 *  workspace root; only then is the rest created beneath it.
 *
 *  An escape REFUSES the whole tree (throws) rather than skipping the offending
 *  member. A per-member skip cannot stay consistent with the mount decision:
 *  spawn.ts derives what it binds from the same plan, so a skipped member's
 *  volume would still be mounted at a path with no mountpoint — the original
 *  container_crash, silently. Throwing is this function's established failure
 *  signal (mkdirSync already throws on a read-only/permission-denied checkout),
 *  and the caller that owns the mount decision — runNext.ts's
 *  projectTreeIsMountable — already converts it into "mount no dependency
 *  volume at all" plus a `container.dependency_mountpoints_unavailable` event.
 *  So the refusal degrades the dispatch instead of failing it, and the skip is
 *  observable on the run timeline.
 *
 *  Returns the created paths; empty when the project has no lockfile, i.e. no
 *  plan and nothing to mount. */
export function createDependencyMountpoints(workspacePath: string): string[] {
  let plan: DependencyVolumePlan;
  try {
    plan = planDependencyVolumes(workspacePath, workspacePath);
  } catch {
    return [];
  }
  const root = realpathSync.native(workspacePath);
  const created: string[] = [];
  for (const path of plan.volumes.map((v) => v.containerPath)) {
    const anchor = deepestExistingAncestor(path);
    if (!isInsideTree(root, anchor)) {
      throw new Error(
        `dependency-provisioning: refusing to create mountpoint ${path} — it resolves to ${anchor}, outside ${root}`,
      );
    }
    // mkdir -p racing itself is a no-op, and every component above `anchor` is
    // real (it came back from realpath), so the components created below it are
    // real directories inside the tree, not a followed symlink.
    mkdirSync(path, { recursive: true });
    created.push(path);
  }
  return created;
}

/** The deepest ancestor of `path` (or `path` itself) that exists, fully
 *  resolved through symlinks. The normal case is that the mountpoint does not
 *  exist yet at all, so containment has to be decided against whatever part of
 *  the chain IS on disk. */
function deepestExistingAncestor(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync.native(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current; // filesystem root — nothing left to resolve
      current = parent;
    }
  }
}

/** Componentwise containment of two already-resolved absolute paths. A string
 *  prefix test would count `/a/bc` as inside `/a/b`; `relative` cannot. */
function isInsideTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
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

export function dependencyCacheDir(): string {
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
 *  instead of re-installing.
 *
 *  This is a claim ABOUT THE PAST and it stays one: the marker lives under
 *  ~/.forge and the volumes live in docker, so a `docker volume prune`, a
 *  `docker volume rm`, or a Docker Desktop factory reset empties the cache
 *  without touching the marker. Verifying the volume here would mean a container
 *  probe on every dispatch to answer a question that is almost always yes; the
 *  cheap alternative is to let the ONE mechanism that already looks inside the
 *  container disprove it — see resolveDependencyEnvironment, which invalidates a
 *  marker its probe proves wrong and re-provisions once. */
export function isDependencyCacheReady(cacheKey: string): boolean {
  return existsSync(readyMarkerPath(cacheKey));
}

/** The marker's own VALUE, or undefined when the key is not marked ready. The
 *  identity of one successful install, not merely "some install succeeded" —
 *  which is what lets a repairer tell the marker it disproved from a newer one a
 *  concurrent dispatch wrote while it was blocked on the lock. */
export function readDependencyCacheMarker(cacheKey: string): string | undefined {
  try {
    return readFileSync(readyMarkerPath(cacheKey), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Drop a ready marker that has been DISPROVEN. Callers must hold the cache-key
 *  lock (repairDisprovenDependencyCache below is the only one), and must
 *  re-provision before anything reads the cache again — a key with no marker is
 *  the ordinary "needs provisioning" state, which every caller already handles. */
export function invalidateDependencyCacheMarker(cacheKey: string): void {
  rmSync(readyMarkerPath(cacheKey), { force: true });
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
 *  already handle.
 *
 *  The random suffix makes each marker DISTINGUISHABLE from every other, which
 *  readDependencyCacheMarker's callers depend on: a timestamp alone can repeat
 *  when two installs land in the same millisecond, and then a repairer cannot
 *  tell "the marker I disproved" from "the replacement someone else just
 *  wrote". */
export function markDependencyCacheReady(cacheKey: string): void {
  mkdirSync(dependencyCacheDir(), { recursive: true });
  const path = readyMarkerPath(cacheKey);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${new Date().toISOString()} ${randomBytes(8).toString("hex")}`);
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
  // Test-only seam for the blocked waiter's poll interval, in the same spirit.
  // Production leaves it at run-lock.ts's default (500ms), which is right for a
  // waiter whose holder is running `npm ci`; a test proving the contention is
  // real should not have to spend half a second on a real clock to do it.
  pollMs?: number;
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
    ...(opts?.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
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

export type RepairDependencyCacheResult =
  /** THIS call invalidated the disproven marker and re-provisioned the cache. */
  | { outcome: "repaired" }
  /** Another dispatch had already replaced the disproven marker by the time this
   *  one took the lock — its install is not the one that was disproved, so it is
   *  re-probed rather than torn down and installed again. */
  | { outcome: "already_repaired" }
  | { outcome: "failed"; error: string };

/** Repair a cache key whose ready marker has been DISPROVEN — the probe found the
 *  install root EMPTY inside a container for a key marked ready (a pruned volume,
 *  a `docker volume rm`, a Docker Desktop factory reset: the volumes are docker
 *  objects, the markers are files under ~/.forge, and only one of the two gets
 *  wiped). Without this the marker keeps asserting a readiness nothing can
 *  deliver, the provisioner is never re-run, and every read-only dispatch on the
 *  host is refused forever — the reuse-only closed loop, reopened by a lie about
 *  the past instead of by nothing having provisioned.
 *
 *  The whole repair happens under the SAME per-cache-key lock the ordinary
 *  install takes, so FG-376's guarantees are unchanged rather than special-cased:
 *  exactly one provisioner per cache key, no marker on a failed install, and a
 *  dead lock holder is still distrusted (acquireDependencyCacheLock's
 *  onDeadHolder). `disprovenMarker` is what makes the concurrent case exact — two
 *  dispatches that both probe the same stale cache both arrive here, and the one
 *  that loses the race finds a marker it never disproved and provisions nothing.
 *
 *  ONE attempt. The caller decides what to do with the outcome; this never
 *  loops. */
export async function repairDisprovenDependencyCache(
  cacheKey: string,
  disprovenMarker: string,
  runProvisioner: () => Promise<{ exitCode: number; stderrTail: string }>,
  opts?: DependencyCacheLockOpts,
): Promise<RepairDependencyCacheResult> {
  const release = await acquireDependencyCacheLock(cacheKey, opts);
  try {
    const current = readDependencyCacheMarker(cacheKey);
    if (current !== undefined && current !== disprovenMarker) return { outcome: "already_repaired" };

    // The marker goes FIRST: a crash between here and a successful install must
    // leave no marker at all, never a surviving one that outlived its disproof.
    try {
      invalidateDependencyCacheMarker(cacheKey);
    } catch (e) {
      return {
        outcome: "failed",
        error:
          `the disproven ready marker for cache key ${cacheKey} could not be invalidated ` +
          `(${(e as Error).message}) — the cache cannot be re-provisioned while it still claims to be ready`,
      };
    }

    const { exitCode, stderrTail } = await runProvisioner();
    if (exitCode !== 0) {
      return {
        outcome: "failed",
        error:
          `re-provisioning cache key ${cacheKey} after invalidating its disproven ready marker failed ` +
          `(provisioner exit ${exitCode})` + (stderrTail ? ` — ${stderrTail}` : ""),
      };
    }
    markDependencyCacheReady(cacheKey);
    return { outcome: "repaired" };
  } finally {
    release();
  }
}

// ── FG-664: the ONE host-side answer to "can this dispatch execute the
//    project's dependencies?" ───────────────────────────────────────────────
//
// A read-only reviewer/rechecker sees the HOST's node_modules through the
// `/project:ro` bind. On darwin those are darwin-arm64 bindings and a linux
// container cannot dlopen them, so the project's real native driver
// (better-sqlite3, here) fails to load. The lane's response to that was to
// improvise a `node:sqlite`-backed shim and run the regression suite against a
// DIFFERENT SQLite implementation, then report the engine-difference failures
// as the finding still being present (FG-662, review-6b9e07e48cc6). Blue agents
// never hit it: they get a writable shadow volume and install in-container.
//
// The remedy has to be HOST-SIDE and PRE-DISPATCH. Agents have passwordless root
// (spawn.ts:128), so nothing running inside the agent's container can enforce
// anything, and engine-difference failures emit genuine `not ok` lines that are
// textually indistinguishable from real regressions — no output inspection can
// authenticate the engine that produced them. So Forge answers the question
// itself, before the agent container exists, with its OWN short-lived probe
// container running a fixed command.
//
// This function stays docker-agnostic, exactly like provisionDependencyCache
// above: the caller supplies the two container invocations (spawn.ts's
// prepareDependencyEnvironmentForDispatch) and this module owns the eligibility
// gates, the cache key, the lock, the marker and the attestation.
//
// FG-376 IS REFINED, NOT WEAKENED. "Reviewers never provision" becomes "reviewer
// CONTAINERS never install and never race an install; the HOST may provision,
// under the existing per-cache-key lock, before a read-only reviewer starts."
// The install still happens in the separate short-lived provisioner container
// with the unchanged exactly-once/no-marker-on-failure/distrust-a-dead-holder
// semantics; the reviewer still mounts `:ro` and still never writes.

/** One mounted package that ships a compiled `.node` artifact — or that declares
 *  a native build and ships none. `loaded` is the whole point: it is the EXIT
 *  STATUS of a Forge-owned container that did nothing but `process.dlopen` this
 *  artifact, not an inference from the file's existence and not a claim the
 *  loaded code made about itself. */
export type DependencyEnginePackage = {
  name: string;
  version: string;
  /** The compiled artifact the probe found inside the mounted volume. */
  artifact?: string;
  /** What the container's resolver returned for the package entry point. */
  resolvedPath?: string;
  loaded: boolean;
  error?: string;
};

/** What a dispatch had to REPAIR before it could attest anything. Present only
 *  when this dispatch found the cache key marked ready and its install root empty
 *  in the container — so the operator reads that the marker was a lie and that
 *  Forge re-provisioned, instead of inferring it from a dispatch that took
 *  minutes longer than the last one. */
export type DependencyCacheRepairRecord = {
  /** The install root the probe found EMPTY — the fact that disproved the marker. */
  disprovenRoot: string;
  /** The ready-marker value that was invalidated. */
  invalidatedMarker: string;
  /** Whether this dispatch ran the re-provisioner, or another dispatch had
   *  already repaired the key by the time this one reached the lock. */
  reprovisionedBy: "this_dispatch" | "concurrent_dispatch";
};

/** ENGINE IDENTITY, attested by a Forge-owned container. Recorded in the task
 *  manifest and in the review's recheck stage evidence — ONE fact in two places,
 *  so a later reader can tell which engine a verdict was produced against. */
export type DependencyEnvironmentReceipt = {
  /** The lockfile hash: the dependency-cache key whose volumes were mounted. */
  cacheKey: string;
  /** The image the probe ran — the same image the reviewer container will run. */
  probeImage: string;
  /** `process.version` inside the probe container. */
  nodeVersion: string;
  /** `process.versions.modules` inside the probe container — the NODE ABI the
   *  mounted bindings had to match to load at all. */
  abi: string;
  packages: DependencyEnginePackage[];
  /** Absent on the ordinary path — a healthy ready cache is reused untouched. */
  staleCacheRepaired?: DependencyCacheRepairRecord;
};

/** One native package as the TIMELINE records it: the identity, and the
 *  host-observed verdict on whether it loaded. No path field — see
 *  dependencyEnvironmentResolvedPayload. */
export type DependencyEnvironmentEventPackage = { name: string; version: string; loaded: boolean };

export type DependencyEnvironmentResolvedPayload = {
  stage: "environment_resolution";
  cacheKey: string;
  probeImage: string;
  nodeVersion: string;
  abi: string;
  packages: DependencyEnvironmentEventPackage[];
};

/** FG-664 AC3: what a SUCCESSFUL resolution puts on the task timeline, from the
 *  receipt the manifest records. `stage` matches the refusal event's grain, so one
 *  vocabulary covers both outcomes of one decision.
 *
 *  Built by NAMING each field rather than by spreading the receipt. The receipt's
 *  `artifact`, `resolvedPath` and `staleCacheRepaired.disprovenRoot` are paths, and
 *  the events table is read far from the dispatch that wrote it — naming the fields
 *  means a path (or anything else) added to the receipt later cannot reach the
 *  ledger by default. */
export function dependencyEnvironmentResolvedPayload(
  receipt: DependencyEnvironmentReceipt,
): DependencyEnvironmentResolvedPayload {
  return {
    stage: "environment_resolution",
    cacheKey: receipt.cacheKey,
    probeImage: receipt.probeImage,
    nodeVersion: receipt.nodeVersion,
    abi: receipt.abi,
    packages: receipt.packages.map((p) => ({ name: p.name, version: p.version, loaded: p.loaded })),
  };
}

/** What the probe container printed, as the caller captured it. */
export type DependencyProbeRun = { exitCode: number; stdout: string; stderrTail: string };

/** Why a read-only dispatch was refused. Every one of these is reported to the
 *  caller as the EXISTING `verification_environment_unavailable` FailureKind —
 *  this is the diagnostic grain underneath it, not new vocabulary. */
export type DependencyEnvironmentRefusal =
  | "mountpoints_unavailable"
  | "provisioning_failed"
  | "probe_failed"
  | "probe_unparseable"
  | "dependencies_absent"
  | "driver_unloadable"
  /** FG-678: the project DECLARES dependencies but ships no supported lockfile,
   *  so there is no key to bind an environment to. Unlike the refusals above,
   *  this one is decided host-side before any container: it is the difference
   *  between "this project has nothing to provision" and "this project has
   *  something to provision and no reproducible way to name it". */
  | "lockfile_absent";

export type DependencyEnvironmentOutcome =
  /** The real dependencies are mounted and the probe LOADED every native package
   *  the project declares a dependency on (see declaredDependencyNames). */
  | { outcome: "ready"; receipt: DependencyEnvironmentReceipt }
  /** Not a refusal: this configuration never had the hazard, and its pre-existing
   *  behaviour is unchanged (non-darwin, FORGE_NO_NM_SHADOW=1, a project that
   *  declares no dependencies at all, a runtime that mounts no project). */
  | { outcome: "not_applicable"; reason: string }
  | { outcome: "refused"; reason: DependencyEnvironmentRefusal; detail: string };

export type ResolveDependencyEnvironmentArgs = {
  /** The tree that will ACTUALLY be bound at the container's project path — the
   *  worktree/clone when there is one, never a path the agent could have written. */
  repoRoot: string;
  /** The image the probe ran, for the receipt. */
  image: string;
  /** Runs the FG-376 provisioner container. Called at most once, only while
   *  holding the cache-key lock, and only when the key is not already ready. */
  runProvisioner: () => Promise<{ exitCode: number; stderrTail: string }>;
  /** Runs Forge's OWN probe container over the reviewer's exact mount shape.
   *  The `nonce` is generated here and must reach the probe container; a report
   *  that does not carry it back is not this dispatch's report. `declared` is the
   *  set whose ABSENCE the probe is asked to check (undefined when the project's
   *  manifests could not be read). */
  runProbe: (nonce: string, declared?: readonly string[]) => Promise<DependencyProbeRun>;
  /** Runs ONE load container: dlopen a single artifact the probe found, in the
   *  same mount shape. The EXIT STATUS is the verdict — this is the one fact
   *  about a native package that dependency code must not be able to author, so
   *  it is observed by the host rather than reported from inside. */
  runLoad: (artifact: string, index: number) => Promise<{ exitCode: number; stderrTail: string }>;
  lockOpts?: DependencyCacheLockOpts;
  /** Test seam ONLY, mirroring the isContainerAlive/killContainer pattern above:
   *  the darwin gate is the whole reason this mechanism exists, and the unit tier
   *  runs on linux. Production callers never set it. */
  platform?: string;
};

/** One mounted package the probe SAW. It carries no `loaded` field on purpose:
 *  the probe container runs no dependency code, so it has nothing to say about
 *  whether an artifact loads. That verdict comes from a load container's exit
 *  status, observed by the host (see resolveDependencyEnvironment). */
export type DependencyProbeCandidate = {
  name: string;
  version: string;
  /** The compiled artifact selected for THIS platform, or absent when the
   *  package declares a native build and the cache holds no artifact for it. */
  artifact?: string;
  resolvedPath?: string;
  /** Why there is nothing to load — set only when `artifact` is absent. */
  unavailable?: string;
};

/** The probe's JSON, as this module reads it back. Deliberately narrow: the
 *  probe is Forge's own fixed command, so anything that does not parse into
 *  this shape is a refusal rather than something to interpret. */
export type DependencyProbeReport = {
  /** The value Forge generated for THIS dispatch and handed only to the probe
   *  container. See parseDependencyProbeOutput. */
  nonce: string;
  node: string;
  abi: string;
  /** Per mounted node_modules root: how many entries the container saw. The
   *  install root being EMPTY is the case a ready marker cannot rule out — a
   *  pruned volume leaves the marker behind — and it is exactly the state that
   *  reads as "no native packages, nothing to check". */
  roots: Array<{ path: string; entries: number; installRoot: boolean }>;
  packages: DependencyProbeCandidate[];
  /** Declared packages whose directory is in NO mounted root. An incomplete
   *  cache the emptiness test above cannot see: it inspects only the install
   *  root, and a populated-but-incomplete root passes it. */
  missing: string[];
};

/** Read the probe's report out of its stdout, or say why there isn't one.
 *
 *  An entrypoint warning ahead of the report (the FG-608 backlog-authority
 *  notice, say) must not defeat the read, so non-JSON lines are skipped. But
 *  EXACTLY ONE report-shaped line is required: "last one wins" is a rule an
 *  attacker only has to write AFTER the genuine line to beat, and a stream
 *  carrying two reports is a contaminated stream, not a choice to make. The
 *  nonce then binds the surviving report to the dispatch that minted it, so a
 *  replayed or hand-planted line reads as no report at all. */
export function readDependencyProbeReport(
  stdout: string,
  expectedNonce: string,
): { report: DependencyProbeReport } | { refusal: string } {
  const candidates: Array<Partial<DependencyProbeReport>> = [];
  for (const line of stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"))) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const r = value as Partial<DependencyProbeReport>;
    if (typeof r.node !== "string" || typeof r.abi !== "string") continue;
    if (!Array.isArray(r.packages) || !Array.isArray(r.roots) || !Array.isArray(r.missing)) continue;
    candidates.push(r);
  }
  if (candidates.length === 0) return { refusal: "printed no readable report" };
  if (candidates.length > 1) {
    return {
      refusal:
        `printed ${candidates.length} report-shaped lines — only the probe container writes that stream, so a ` +
        `second report means the stream was contaminated and neither line is an attestation`,
    };
  }
  const r = candidates[0] as Partial<DependencyProbeReport>;
  if (r.nonce !== expectedNonce) return { refusal: "printed a report that does not carry this dispatch's probe nonce" };
  return {
    report: {
      nonce: r.nonce,
      node: r.node as string,
      abi: r.abi as string,
      roots: r.roots as DependencyProbeReport["roots"],
      packages: r.packages as DependencyProbeCandidate[],
      missing: r.missing as string[],
    },
  };
}

/** readDependencyProbeReport, for callers that only need the report or nothing. */
export function parseDependencyProbeOutput(stdout: string, expectedNonce: string): DependencyProbeReport | undefined {
  const read = readDependencyProbeReport(stdout, expectedNonce);
  return "report" in read ? read.report : undefined;
}

/** The native packages whose failure to load REFUSES a read-only dispatch: the
 *  ones the project itself declares a direct dependency on, across the repo root
 *  and every workspace member.
 *
 *  This is the answer to "can this container load the drivers this project
 *  actually needs". The probe reports every mounted package that ships a `.node`
 *  — including platform-specific optional packages npm installed as transitive
 *  detail (`@img/sharp-linux-arm64` and friends). Those are recorded as observed
 *  facts, but they are not what the reviewer's verdict depends on, and treating
 *  every one of them as load-bearing is what turned this gate into a permanent
 *  refusal.
 *
 *  Returns undefined when no manifest could be read at all — a project whose own
 *  package.json is unreadable gets the fail-closed reading (every native package
 *  is required), because there is then no basis for narrowing. */
export function declaredDependencyNames(repoRoot: string): Set<string> | undefined {
  const manifests = readDependencyManifests(repoRoot);
  if (manifests.length === 0) return undefined;
  const names = new Set<string>();
  for (const m of manifests) for (const name of m.names) names.add(name);
  return names;
}

/** One READABLE package.json under the repo root, and the direct dependencies it
 *  declares. `path` is the manifest that declared them — the fact
 *  declaredDependencyNames drops when it unions the names together, and the one
 *  a `lockfile_absent` refusal has to name so the operator knows which manifest
 *  put the project on the refusing side. */
export type DependencyManifest = { path: string; names: string[] };

/** Every readable manifest across the repo root and its workspace members, in
 *  workspaceMembers order. An empty array means NO manifest could be read at all
 *  — the same fact declaredDependencyNames reports as undefined. */
export function readDependencyManifests(repoRoot: string): DependencyManifest[] {
  const manifests: DependencyManifest[] = [];
  for (const member of workspaceMembers(repoRoot)) {
    const pkgPath = join(repoRoot, member.relPath, "package.json");
    let pkg: { dependencies?: unknown; devDependencies?: unknown };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
    } catch {
      continue;
    }
    const names = new Set<string>();
    for (const block of [pkg.dependencies, pkg.devDependencies]) {
      if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
    }
    manifests.push({ path: pkgPath, names: [...names] });
  }
  return manifests;
}

export async function resolveDependencyEnvironment(
  args: ResolveDependencyEnvironmentArgs,
): Promise<DependencyEnvironmentOutcome> {
  const platform = args.platform ?? process.platform;
  if (platform !== "darwin") {
    // On linux the host's modules are already the right platform, so the
    // substitution hazard does not arise and nothing about this dispatch changes.
    return { outcome: "not_applicable", reason: `host platform is ${platform}, not darwin` };
  }
  if (process.env.FORGE_NO_NM_SHADOW === "1") {
    return { outcome: "not_applicable", reason: "FORGE_NO_NM_SHADOW=1 (the operator escape hatch)" };
  }
  // FG-678: three outcomes, not two. A missing lockfile used to mean one thing —
  // "nothing to provision" — and it covers two projects that need opposite
  // answers: one that declares no dependencies (there is genuinely nothing to
  // bind, and it must dispatch exactly as it always did), and one that declares
  // dependencies it cannot key (there IS something to bind and no reproducible
  // name for it). Telling the second one it has no dependencies is the falsehood
  // that let an agent be handed an empty workspace and left to improvise.
  //
  // Deliberately BELOW the darwin and FORGE_NO_NM_SHADOW short-circuits: both are
  // "this host never had the hazard", and a refusal above them would fail
  // dispatches on every linux host and defeat the operator's escape hatch.
  const cacheKey = safeLockfileHash(args.repoRoot);
  if (cacheKey === undefined) {
    // A manifest that will not parse is not a manifest that declares
    // dependencies — there is no basis for reading one out of it, so this stays
    // on the pre-existing not-applicable side rather than refusing on a guess.
    let manifests: DependencyManifest[];
    try {
      manifests = readDependencyManifests(args.repoRoot);
    } catch {
      manifests = [];
    }
    const declaring = manifests.filter((m) => m.names.length > 0);
    if (declaring.length === 0) {
      return {
        outcome: "not_applicable",
        reason:
          manifests.length === 0
            ? `no readable package.json at ${args.repoRoot}, and no package-lock.json`
            : `no package-lock.json at ${args.repoRoot}, and its manifest(s) declare no dependencies`,
      };
    }
    const first = declaring[0] as DependencyManifest;
    const sample = first.names.slice(0, 3).join(", ");
    return {
      outcome: "refused",
      reason: "lockfile_absent",
      detail:
        `${first.path} declares ${first.names.length} dependenc${first.names.length === 1 ? "y" : "ies"} ` +
        `(${sample}${first.names.length > 3 ? ", …" : ""})` +
        (declaring.length > 1 ? `, as do ${declaring.length - 1} other workspace manifest(s)` : "") +
        `, but ${args.repoRoot} ships no package-lock.json — the only lockfile Forge supports. A dependency ` +
        `environment is keyed by lockfile content, so there is nothing to bind this project's declared ` +
        `dependencies to and no way to give two dispatches the same one. Commit a package-lock.json (npm ` +
        `install --package-lock-only) so the dispatch is reproducible.`,
    };
  }

  // FG-627/FG-628: every dependency volume binds at a path INSIDE a read-only
  // project mount, and docker cannot mkdir a mountpoint on a read-only rootfs.
  // On the rw path a failure here degrades to "mount nothing"; on a read-only
  // dispatch that degradation IS the defect, so it refuses.
  try {
    createDependencyMountpoints(args.repoRoot);
  } catch (e) {
    return {
      outcome: "refused",
      reason: "mountpoints_unavailable",
      detail:
        `the dependency mountpoints could not be created in ${args.repoRoot} (${(e as Error).message}), so the ` +
        `lockfile-keyed volumes cannot be bound into a read-only project mount`,
    };
  }

  // Read BEFORE provisioning, because it is what the probe below gets to
  // disprove: a marker that was already there when this dispatch started is a
  // claim about an install nobody in this dispatch watched succeed.
  const markerBeforeDispatch = readDependencyCacheMarker(cacheKey);

  let provision: ProvisionDependencyCacheResult;
  try {
    provision = await provisionDependencyCache(cacheKey, args.runProvisioner, args.lockOpts);
  } catch (e) {
    // The caller's provisioner threw before/instead of exiting — a host-side
    // mount-plan refusal (FG-559's assertWorktreeGitMountPlanned) reaches here.
    return { outcome: "refused", reason: "provisioning_failed", detail: (e as Error).message };
  }
  if (provision.outcome === "failed") {
    return { outcome: "refused", reason: "provisioning_failed", detail: provision.error };
  }

  // The refusal is scoped to the drivers the PROJECT declares it depends on. A
  // transitive platform package that does not load is recorded in the receipt
  // and left there: it is not what the reviewer's verdict runs against, and
  // refusing on it refuses everything (see declaredDependencyNames). The probe
  // gets the same set, because "is this declared package even here" is a
  // question only something inside the mount shape can answer.
  const declared = declaredDependencyNames(args.repoRoot);

  /** One probe container: mint a nonce, run it, and read back the report it
   *  alone could have printed. A refusal here is final — the probe is Forge's own
   *  fixed command, so a probe that will not run or will not attest is not
   *  something a re-provision could fix. */
  const attest = async (): Promise<
    { report: DependencyProbeReport } | { refused: Extract<DependencyEnvironmentOutcome, { outcome: "refused" }> }
  > => {
    // Minted here, per probe, and handed to nothing but the probe container.
    const nonce = createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 32);
    let probe: DependencyProbeRun;
    try {
      probe = await args.runProbe(nonce, declared === undefined ? undefined : [...declared]);
    } catch (e) {
      return { refused: { outcome: "refused", reason: "probe_failed", detail: (e as Error).message } };
    }
    if (probe.exitCode !== 0) {
      return {
        refused: {
          outcome: "refused",
          reason: "probe_failed",
          detail:
            `the dependency probe container exited ${probe.exitCode}` +
            (probe.stderrTail ? ` — ${probe.stderrTail}` : ""),
        },
      };
    }
    const parsed = readDependencyProbeReport(probe.stdout, nonce);
    if ("refusal" in parsed) {
      return {
        refused: {
          outcome: "refused",
          reason: "probe_unparseable",
          detail:
            `the dependency probe container exited 0 but ${parsed.refusal} — nothing attests which engine this ` +
            `dispatch would run against` +
            (probe.stderrTail ? ` (stderr: ${probe.stderrTail})` : ""),
        },
      };
    }
    return { report: parsed.report };
  };

  // A ready marker says the INSTALL succeeded once; it cannot say the volume
  // still holds it (`forge dependency-cache prune`, a `docker volume rm`, a
  // Docker Desktop factory reset — the volumes are docker objects and the markers
  // are files under ~/.forge, so one can be wiped without the other). An empty
  // install root would otherwise sail through as "no native packages found,
  // nothing failed to load" — green for the wrong reason.
  //
  // And the refusal alone is not enough: nothing else invalidates that marker, so
  // a disproven cache would refuse every later dispatch on this host too,
  // forever, with the only escape being an operator who knows to delete a file
  // under ~/.forge by hand. A disproof REPAIRS — exactly once, under the existing
  // per-cache-key lock — and only a cache that is still empty (or whose drivers
  // still will not load) after that is refused.
  let repaired: DependencyCacheRepairRecord | undefined;
  let report: DependencyProbeReport;
  for (;;) {
    const attested = await attest();
    if ("refused" in attested) return attested.refused;
    // Two shapes of the SAME disproof: the install root holds nothing, or a
    // package the project declares is in no mounted root at all. The second is
    // what the emptiness test cannot see — it never inspects a workspace
    // member's volume, and a populated-but-incomplete root passes it.
    const emptyRoot = attested.report.roots.find((r) => r.installRoot && r.entries === 0);
    const missing = attested.report.missing;
    const disproof =
      emptyRoot !== undefined
        ? { where: emptyRoot.path, what: `${emptyRoot.path} probed EMPTY` }
        : missing.length > 0
          ? { where: missing.join(", "), what: `the declared package(s) ${missing.join(", ")} are in NO mounted root` }
          : undefined;
    if (disproof === undefined) {
      report = attested.report;
      break;
    }
    if (repaired !== undefined) {
      return {
        outcome: "refused",
        reason: "dependencies_absent",
        detail:
          `cache key ${cacheKey} was marked ready, ${disproof.what}, and the disproven marker was invalidated and ` +
          `the cache re-provisioned — the same is STILL true inside the container, so the dispatch is refused ` +
          `rather than re-provisioned again`,
      };
    }
    if (markerBeforeDispatch === undefined) {
      // Nothing to disprove: this dispatch's own install is what produced the
      // incomplete cache, so re-running it would just produce the same one.
      return {
        outcome: "refused",
        reason: "dependencies_absent",
        detail:
          `cache key ${cacheKey} was provisioned for this dispatch but ${disproof.what} inside the container — the ` +
          `mounted volumes do not carry the project's dependency graph, so nothing the dispatch runs would execute ` +
          `the project's real code`,
      };
    }

    console.error(
      `forge: dependency cache ${cacheKey} is marked ready but ${disproof.what} in the container — ` +
        "invalidating the disproven marker and re-provisioning once before this dispatch is decided",
    );
    let repair: RepairDependencyCacheResult;
    try {
      repair = await repairDisprovenDependencyCache(
        cacheKey,
        markerBeforeDispatch,
        args.runProvisioner,
        args.lockOpts,
      );
    } catch (e) {
      repair = { outcome: "failed", error: (e as Error).message };
    }
    if (repair.outcome === "failed") {
      return { outcome: "refused", reason: "provisioning_failed", detail: repair.error };
    }
    repaired = {
      disprovenRoot: disproof.where,
      invalidatedMarker: markerBeforeDispatch,
      reprovisionedBy: repair.outcome === "repaired" ? "this_dispatch" : "concurrent_dispatch",
    };
  }

  // THE VERDICTS. One load container per artifact the probe found, and `loaded`
  // is the exit status THIS HOST observed — never something the loaded code
  // printed, and never a fact one package's artifact can author about another's.
  const packages: DependencyEnginePackage[] = [];
  for (const [index, candidate] of report.packages.entries()) {
    const common = {
      name: candidate.name,
      version: candidate.version,
      ...(candidate.resolvedPath !== undefined ? { resolvedPath: candidate.resolvedPath } : {}),
    };
    if (candidate.artifact === undefined) {
      packages.push({ ...common, loaded: false, error: candidate.unavailable ?? "no compiled artifact was found" });
      continue;
    }
    let load: { exitCode: number; stderrTail: string };
    try {
      load = await args.runLoad(candidate.artifact, index);
    } catch (e) {
      return { outcome: "refused", reason: "probe_failed", detail: (e as Error).message };
    }
    packages.push({
      ...common,
      artifact: candidate.artifact,
      loaded: load.exitCode === 0,
      ...(load.exitCode === 0 ? {} : { error: loaderError(load.exitCode, load.stderrTail) }),
    });
  }

  const unloadable = packages.filter((p) => !p.loaded && (declared === undefined || declared.has(p.name)));
  if (unloadable.length > 0) {
    return {
      outcome: "refused",
      reason: "driver_unloadable",
      detail:
        `the project's real native package(s) ${unloadable.map((p) => p.name).join(", ")} could not be loaded in ` +
        `the reviewer's mount shape (node ${report.node}, ABI ${report.abi}): ` +
        unloadable.map((p) => `${p.name}: ${p.error ?? "no error recorded"}`).join(" | "),
    };
  }

  return {
    outcome: "ready",
    receipt: {
      cacheKey,
      probeImage: args.image,
      nodeVersion: report.node,
      abi: report.abi,
      packages,
      ...(repaired ? { staleCacheRepaired: repaired } : {}),
    },
  };
}

// node prints a version footer after a fatal throw, so the LAST line of a failed
// load's stderr is "Node.js vX" rather than the diagnosis. Prefer the first line
// that names an error; the tail is the fallback for a container that died
// without one.
function loaderError(exitCode: number, stderrTail: string): string {
  const lines = stderrTail.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines[0] ?? `the load container exited ${exitCode}`;
}

/** Best-effort removal of every dependency volume a worktree could have
 *  created. NOT called from per-task/worktree disposal (FIX3 — a shared cache
 *  volume must not be torn down just because ONE task using it finished; other
 *  tasks may still reference the same cache key). Still not wired to any
 *  per-task disposal path — cache volumes are intentionally retained
 *  (`forge-deps-*` accumulate on disk across runs) rather than auto-pruned;
 *  the operator-triggered global prune is pruneDependencyCache below
 *  (FG-434), which is a different shape (host-wide, not per-worktree). Tries
 *  both the regular task-worktree path and the fan-out integration-worktree
 *  path for (runId, taskId), since callers pass parentTaskId as `taskId` when
 *  pruning an integration worktree's volumes. Tolerates a missing worktree
 *  dir, a missing lockfile (nothing to compute), and an already-absent volume
 *  (docker volume rm exits non-zero; swallowed) — never throws. */
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

// ── FG-434: operator-triggered global prune ──────────────────────────────────
// removeDependencyVolumes above is per-worktree (derives names from a
// worktree's lockfile) — the wrong shape for "clear everything accumulated on
// this host". pruneDependencyCache instead enumerates every forge-deps-*
// volume docker knows about, plus every marker/lock under dependencyCacheDir,
// with no worktree/run/task in scope at all.

export type VolumeRemovalOutcome = "removed" | "in_use" | "error";

export type PruneDependencyCacheOpts = {
  dryRun?: boolean;
};

/** Test seams mirroring the isContainerAlive/killContainer pattern above — no
 *  real docker or ~/.forge required to exercise pruneDependencyCache. */
export type PruneDependencyCacheDeps = {
  listVolumeNames?: () => string[];
  removeVolume?: (name: string) => VolumeRemovalOutcome;
  listMarkerFiles?: () => string[];
  removeMarkerFile?: (path: string) => void;
};

export type PruneDependencyCacheResult = {
  volumesRemoved: string[];
  volumesSkippedInUse: string[];
  volumesError: string[];
  markersRemoved: string[];
  dryRun: boolean;
};

function dockerListDependencyVolumeNames(): string[] {
  try {
    const out = execFileSync("docker", ["volume", "ls", "-q", "--filter", "name=forge-deps-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // docker unavailable / errored — best-effort, never throw
  }
}

function dockerRemoveVolume(name: string): VolumeRemovalOutcome {
  try {
    execFileSync("docker", ["volume", "rm", name], { stdio: ["ignore", "ignore", "pipe"] });
    return "removed";
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string } | undefined)?.stderr?.toString() ?? "";
    // docker's own wording for "refuses to remove a volume in use by any
    // container, running or stopped": `Error response from daemon: remove
    // <name>: volume is in use - [<containerId>...]`.
    if (/volume is in use/i.test(stderr)) return "in_use";
    return "error"; // NOT confirmed gone — reported separately from in_use
  }
}

function listDependencyCacheMarkerFiles(): string[] {
  const dir = dependencyCacheDir();
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ready") || f.endsWith(".lock"))
      .map((f) => join(dir, f));
  } catch {
    return []; // no cache dir yet — nothing to prune
  }
}

/** Volume names are `forge-deps-<hash>-<slug>` (dependencyVolumeName above);
 *  the hash is pure hex (no dashes), so the first dash-delimited segment
 *  after the prefix is always the cache key, regardless of what's in slug. */
function cacheKeyFromVolumeName(name: string): string {
  return name.replace(/^forge-deps-/, "").split("-")[0]!;
}

function cacheKeyFromMarkerPath(path: string): string {
  return basename(path).replace(/\.(ready|lock)$/, "");
}

/** Global, operator-triggered prune of every forge-deps-* dependency-cache
 *  volume and .ready/.lock marker on this host (FG-434) — the explicit prune
 *  the FIX3 comment on removeDependencyVolumes above defers. Never throws:
 *  a docker or fs failure just drops that entry from the result instead of
 *  aborting the whole prune.
 *
 *  A volume docker reports as in-use is left alone (skipped, not an error) —
 *  and so is its marker/lock, since "in use" means some container, and
 *  therefore plausibly a live provisioner, still references that cache key.
 *  A volume that errors for any other reason is treated the same way as
 *  in-use for marker purposes: unconfirmed, so left alone rather than force-
 *  removed. Only cache keys with no surviving in-use/errored volume have
 *  their marker/lock cleared. --dry-run performs no removal at all — every
 *  enumerated volume/marker is reported as a removal candidate. */
export function pruneDependencyCache(
  opts?: PruneDependencyCacheOpts,
  deps?: PruneDependencyCacheDeps,
): PruneDependencyCacheResult {
  const dryRun = opts?.dryRun ?? false;
  const listVolumes = deps?.listVolumeNames ?? dockerListDependencyVolumeNames;
  const removeVolume = deps?.removeVolume ?? dockerRemoveVolume;
  const listMarkers = deps?.listMarkerFiles ?? listDependencyCacheMarkerFiles;
  const removeMarker = deps?.removeMarkerFile ?? ((path: string) => rmSync(path, { force: true }));

  const volumesRemoved: string[] = [];
  const volumesSkippedInUse: string[] = [];
  const volumesError: string[] = [];
  const unsafeCacheKeys = new Set<string>();

  let volumeNames: string[];
  try {
    volumeNames = listVolumes();
  } catch {
    volumeNames = []; // best-effort — an enumeration failure prunes nothing, never throws
  }

  for (const name of volumeNames) {
    if (dryRun) {
      volumesRemoved.push(name); // candidate only — nothing actually removed
      continue;
    }
    let outcome: VolumeRemovalOutcome;
    try {
      outcome = removeVolume(name);
    } catch {
      outcome = "error"; // best-effort — an unexpected throw is just an unconfirmed removal
    }
    if (outcome === "removed") {
      volumesRemoved.push(name);
    } else if (outcome === "in_use") {
      volumesSkippedInUse.push(name);
      unsafeCacheKeys.add(cacheKeyFromVolumeName(name));
    } else {
      volumesError.push(name);
      unsafeCacheKeys.add(cacheKeyFromVolumeName(name));
    }
  }

  let markerPaths: string[];
  try {
    markerPaths = listMarkers();
  } catch {
    markerPaths = []; // best-effort — an enumeration failure clears no markers, never throws
  }

  const markersRemoved: string[] = [];
  for (const path of markerPaths) {
    if (unsafeCacheKeys.has(cacheKeyFromMarkerPath(path))) continue; // leave — cache key still in use/unconfirmed
    if (!dryRun) {
      try {
        removeMarker(path);
      } catch {
        continue; // best-effort — leave it out of markersRemoved rather than throw
      }
    }
    markersRemoved.push(path); // reported whether removed or (dry-run) a candidate
  }

  return { volumesRemoved, volumesSkippedInUse, volumesError, markersRemoved, dryRun };
}
