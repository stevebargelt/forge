// FG-351: Worktree lifecycle foundation — create/remove, platform/non-git/dirty
// gates, branch naming, and untracked-file diagnostics.
//
// Task branch identity is DETERMINISTIC: forge/<runId>/<taskId>. No DB column
// needed; any call site can derive the branch name from the task/run metadata.
//
// FG-352: removeWorktreeIfSafe removes on two conditions: EPHEMERAL test mode,
// or provenMerged=true (the merge-back succeeded, so discarding the worktree is
// safe). Never removes an unmerged worktree outside EPHEMERAL test mode.
//
// Kill switch: FORGE_NO_WORKTREES=1 disables worktree mode entirely (makes
// isWorktreeModeEnabled() return false regardless of FORGE_WORKTREES). Use it to
// revert to the shared bind-mount without changing FORGE_WORKTREES. The gates in
// preflightWorktreeGate are unconditional — they are never bypassed by
// FORGE_NO_WORKTREES; the kill switch works at the feature-enable level so the
// caller never reaches the gate.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { findGitRoot } from "../util/git-root.js";
import { WORKTREES_DIR, cloneDir, worktreeDir, integrationWorktreeDir } from "../util/paths.js";

// ── Branch naming ─────────────────────────────────────────────────────────────

/** Deterministic branch name for a task worktree. Derived from task metadata;
 *  never stored — any caller can re-derive it. */
export function worktreeBranchName(runId: string, taskId: string): string {
  return `forge/${runId}/${taskId}`;
}

// ── Feature gate ──────────────────────────────────────────────────────────────

/** Worktree mode is behind an explicit env gate until FG-352 (merge-back) and
 *  FG-354 (persistence-check) make the full path safe.
 *
 *  FORGE_NO_WORKTREES=1 is a KILL SWITCH that disables worktree mode entirely,
 *  regardless of FORGE_WORKTREES. When this returns false, callers must skip
 *  preflightWorktreeGate, createWorktree, and setTaskWorktreePath — the default
 *  bind-mount path is preserved exactly as it was before FG-351. */
export function isWorktreeModeEnabled(): boolean {
  if (process.env.FORGE_NO_WORKTREES === "1") return false;
  return process.env.FORGE_WORKTREES === "1";
}

// ── Preflight gate ────────────────────────────────────────────────────────────

/** Run ALL gate checks BEFORE any state mutation. Throws on any violation.
 *
 * Gates (in order):
 *   1. Platform: macOS only (Linux hard-fail; linux support is FG-358).
 *   2. Git: projectDir must be inside a git repo (findGitRoot two-step).
 *   3. Dirty: tracked tree must be clean unless FORGE_WORKTREE_IGNORE_DIRTY=1.
 *
 * These gates are unconditional — FORGE_NO_WORKTREES does NOT bypass them.
 * The kill switch works at the isWorktreeModeEnabled() level: when it returns
 * false, the caller skips this function entirely and preflightWorktreeGate is
 * never reached.
 */
export function preflightWorktreeGate(projectDir: string): void {
  // 1. Platform gate — Linux is hard-fail; worktree node_modules issues
  //    surface as confusing agent failures (FG-358 tracks Linux support).
  if (process.platform === "linux") {
    throw new Error(
      "worktree mode is not supported on Linux (node_modules bind-mount gap; see FG-358). " +
        "Set FORGE_NO_WORKTREES=1 to disable worktree mode entirely and revert to the shared bind-mount."
    );
  }

  // 2. Non-git gate — worktrees require a git repo.
  const root = findGitRoot(projectDir);
  if (!existsSync(join(root, ".git"))) {
    throw new Error(
      `worktree mode requires a git repository; ${projectDir} is not inside one. ` +
        "Set FORGE_NO_WORKTREES=1 to disable worktree mode entirely and revert to the shared bind-mount."
    );
  }

  // 3. Dirty-state gate — a dirty tracked tree makes the worktree stale by
  //    construction (the agent sees a committed snapshot, not the working tree).
  if (process.env.FORGE_WORKTREE_IGNORE_DIRTY !== "1") {
    try {
      execFileSync("git", ["diff", "--quiet", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      throw new Error(
        `worktree mode requires a clean tracked tree in ${root}. ` +
          "Commit or stash your changes, or set FORGE_WORKTREE_IGNORE_DIRTY=1 to bypass."
      );
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** What a forceRemoveWorktree call actually established.
 *
 *  The two facts come apart exactly when `git worktree remove` FAILS and the
 *  directory is gone anyway — a race, a partially-completed removal (git unlinks
 *  the working tree before its registration, so a failure at the second step
 *  leaves the first done), or a tree something else already deleted. Path
 *  absence alone is therefore NOT proof that git completed the removal, and a
 *  caller that needs that proof must read `gitRemoved`. */
export type ForceRemoveWorktreeResult = {
  /** `git worktree remove` exited 0: git unlinked the tree AND cleared its
   *  `$GIT_DIR/worktrees` registration itself. */
  gitRemoved: boolean;
  /** The path is gone once this returns — however that came about. */
  pathAbsent: boolean;
};

/** `git worktree remove` that survives a LOCKED worktree (FG-356).
 *
 *  A single `--force` still refuses a worktree git considers locked, so any tool
 *  that adopts and locks one (Supacode does this under its tracked repo roots)
 *  wedges every cleanup path here permanently. Unlock first — "not locked" is an
 *  expected no-op, not an error — then use the double-force form, which is what
 *  git actually requires for a locked tree.
 *
 *  Registration hygiene is handled HERE rather than at each call site: when the
 *  removal does not cleanly succeed, the `$GIT_DIR/worktrees` entry can outlive
 *  the directory, and a stale entry breaks later worktree operations on the
 *  parent. `git worktree prune` is the remedy git provides, and it only ever
 *  drops entries whose working tree is already missing — so a removal that
 *  genuinely failed with the tree still on disk keeps its registration, and
 *  pruning never widens what gets disposed of.
 *
 *  Best-effort and never throws: an already-gone worktree is a no-op. */
export function forceRemoveWorktree(
  projectDir: string,
  worktreePath: string
): ForceRemoveWorktreeResult {
  try {
    execFileSync("git", ["worktree", "unlock", worktreePath], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Already unlocked (or not a registered worktree) — nothing to undo.
  }

  let gitRemoved = true;
  try {
    execFileSync("git", ["worktree", "remove", "--force", "--force", worktreePath], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best-effort: if the worktree is already gone, ignore.
    gitRemoved = false;
  }

  if (!gitRemoved) {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* fully best-effort */ }
  }

  return { gitRemoved, pathAbsent: !existsSync(worktreePath) };
}

export type CreateWorktreeResult = {
  worktreePath: string;
  /** Untracked/ignored files in the source tree NOT copied into the worktree.
   *  Git worktrees carry committed/tracked content only. Surface this list to
   *  the operator/dashboard so the limitation is visible (FG-351 diagnostic). */
  untrackedFiles: string[];
};

/** Create a task-scoped git worktree and a named task branch.
 *
 *  - worktreePath lives under WORKTREES_DIR/runId/taskId (always inside Docker
 *    Desktop's macOS file-sharing allowlist).
 *  - git commands use `cwd: projectDir` (the resolved repo root) — NEVER
 *    process.cwd() or a project subdir.
 *  - Returns the worktree path and a diagnostic list of untracked host files.
 *
 *  Advisory: while FORGE_WORKTREES=1, the FG-354 persistence-check scans
 *  args.projectDir (the main checkout), not the worktree. It may false-fail
 *  until FG-354 lands. This warning is emitted once per worktree creation so
 *  operators running worktree mode are not surprised by the limitation.
 */
export function createWorktree(
  projectDir: string,
  runId: string,
  taskId: string
): CreateWorktreeResult {
  const worktreePath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);

  // FG-354 seam: persistence-check currently scans args.projectDir (main
  // checkout) and will false-fail for worktree runs until FG-354 adapts it.
  // Emit a visible advisory so operators running opt-in worktree mode are aware.
  console.warn(
    `[forge:worktrees] ADVISORY: Creating worktree at ${worktreePath} (branch ${branch}). ` +
      "FG-354 persistence-check scans the main checkout, not the worktree — it may " +
      "false-fail until FG-354 lands. This is expected in worktree mode (FG-351)."
  );

  // Ensure the parent directory exists under WORKTREES_DIR.
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });

  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Collect untracked/ignored files for the operator diagnostic.
  let untrackedFiles: string[] = [];
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    untrackedFiles = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Non-fatal: diagnostic best-effort only.
  }

  return { worktreePath, untrackedFiles };
}

// ── FG-621: the private clone substrate (MUTATING agents) ─────────────────────
//
// A linked worktree isolates the WORKING TREE, not the repository: every worktree
// of a repo shares one `objects/`, one ref namespace and one packed-refs, so an
// agent handed write access to any of them has write access to the parent's
// history and to every sibling worktree's basis. A mutating agent instead gets its
// own REPOSITORY — `git clone --shared` at the recorded base SHA — with its own
// refs, index and object overlay, and the parent's object store reachable only
// through `objects/info/alternates` (mounted read-only into the container; that
// mount is what makes the parent structurally unwritable, not git).
//
// The agent may commit freely there. Those commits are untrusted checkpoints and
// transport artifacts: Forge alone constructs the candidate, runs the
// authoritative gates and moves the target ref (FG-345).

/** The forge identity every host-side commit in a task workspace is made under.
 *  A clone inherits no user config, so the safety commit MUST carry one. */
const FORGE_IDENTITY = ["-c", "user.name=forge", "-c", "user.email=forge@local"];

/** The identity a MUTATING AGENT's own commits carry inside its private clone.
 *
 *  "The agent may commit freely there" is not a property of the substrate — it is
 *  a property something has to SUPPLY. A linked worktree shared the source repo's
 *  LOCAL config, so an agent silently borrowed whatever identity the operator's
 *  checkout carried. A clone inherits none of it, the agent image sets none, and
 *  the container has no global file: on this substrate a bare `git commit` dies
 *  with "Author identity unknown" before it writes anything. The substrate that
 *  took the identity away hands it back, written LOCAL into the clone at creation
 *  — not exported at container spawn — so it holds for every reader of that
 *  workspace (the container, the host, a later `forge show`) rather than only
 *  inside one container's env.
 *
 *  DELIBERATELY NOT FORGE_IDENTITY. Agent commits are untrusted checkpoints Forge
 *  may squash; the safety commit is Forge's own authoritative record of what the
 *  agent left behind. One identity for both would make them indistinguishable in
 *  the captured history AND would let a dropped `-c` on the safety commit pass
 *  unnoticed. `-c` outranks local config, so the safety commit still overrides
 *  this and still has to carry its own. */
export const AGENT_IDENTITY = { name: "forge-agent", email: "agent@forge.local" } as const;

/** The create-only refusal, NAMED so the caller can tell it apart from every
 *  other setup failure. It must never be followed by cleanup: the directory it
 *  names is one an agent may already have written to, and deleting it would
 *  destroy the very work the refusal exists to protect. */
export class TaskCloneExistsError extends Error {
  readonly reason = "task_clone_exists" as const;
  constructor(public readonly clonePath: string) {
    super(
      `private clone ${clonePath} already exists — a task workspace identity must be fresh (FG-621). ` +
        "Refusing to reuse a workspace an agent may already have written to; inspect or remove it deliberately."
    );
    this.name = "TaskCloneExistsError";
  }
}

/** The other create-only refusal: the task's PARENT-SIDE anchor ref already
 *  exists. Distinct from TaskCloneExistsError because the thing it protects is
 *  different — a ref, not a directory — and because it is the failure most likely
 *  to reach the setup-cleanup path: a prior attempt that captured work left its
 *  tip on exactly this ref. Like its sibling it must never be followed by
 *  cleanup; disposing of that ref would destroy the prior attempt's only durable
 *  record of the work. */
export class TaskCloneAnchorExistsError extends Error {
  readonly reason = "task_clone_anchor_exists" as const;
  constructor(public readonly branch: string, public readonly sha: string) {
    super(
      `parent-side ref ${branch} already exists at ${sha} — a task workspace identity must be fresh (FG-621). ` +
        "Refusing to reuse or dispose of a ref this attempt did not create; it may hold a prior attempt's " +
        "captured work. Inspect it, then delete it deliberately if it is genuinely stale."
    );
    this.name = "TaskCloneAnchorExistsError";
  }
}

export type CreateTaskCloneResult = {
  clonePath: string;
  /** The deterministic private task branch, checked out at baseSha. */
  branch: string;
  /** The commit the clone was created at — echoed back so the caller records the
   *  value that was actually realized, never the one it merely asked for. */
  baseSha: string;
  /** Untracked/ignored files in the SOURCE tree that the clone does not carry.
   *  Same operator diagnostic createWorktree emits, for the same reason. */
  untrackedFiles: string[];
};

/** Provision a mutating task's private writable repository at `baseSha`.
 *
 *  CREATE-ONLY. An existing directory at this identity is refused, never reused
 *  and never force-deleted — the same posture createCandidateWorktree takes
 *  (integration-publisher.ts): a workspace an agent has already written to is
 *  evidence, and silently reusing one would hand a retry the previous attempt's
 *  half-finished state as if it were a clean base.
 *
 *  The base is ASSERTED, not assumed: the checkout is verified to sit on exactly
 *  the requested commit before the path is returned, so a caller can record
 *  base_sha knowing it describes the tree the agent will actually see. */
export function createTaskClone(
  projectDir: string,
  runId: string,
  taskId: string,
  baseSha: string
): CreateTaskCloneResult {
  const clonePath = cloneDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);

  if (existsSync(clonePath)) throw new TaskCloneExistsError(clonePath);

  // Both create-only refusals are decided BEFORE anything is created, so that by
  // the time any on-disk or ref state exists, everything this attempt finds
  // belongs to this attempt. That is what makes cleanupFailedCloneSetup's
  // disposal safe: it can only ever be aimed at state this attempt made.
  const existingAnchor = resolveCommit(projectDir, branch);
  if (existingAnchor !== undefined) throw new TaskCloneAnchorExistsError(branch, existingAnchor);

  mkdirSync(dirname(clonePath), { recursive: true });

  // --no-checkout: the default clone would materialize the parent's HEAD only to
  // have the checkout below replace it. One checkout, at the recorded base.
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", projectDir, clonePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // AC 1's precondition, written before the agent can reach the workspace: a
  // clone inherits no local config, so without this the agent's first commit
  // fails on identity alone. See AGENT_IDENTITY.
  for (const [key, value] of [["user.name", AGENT_IDENTITY.name], ["user.email", AGENT_IDENTITY.email]] as const) {
    execFileSync("git", ["config", "--local", key, value], {
      cwd: clonePath,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  execFileSync("git", ["checkout", "--quiet", "-b", branch, baseSha], {
    cwd: clonePath,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const head = resolveCommit(clonePath, "HEAD");
  if (head !== baseSha) {
    throw new Error(
      `private clone ${clonePath} was created at ${head ?? "an unresolvable commit"}, not at the recorded base ${baseSha}`
    );
  }

  // Anchor the task's branch in the PARENT's ref namespace at the base, before
  // the agent runs. Three jobs, none of which the clone's own refs can do:
  //   • it pins baseSha against a parent `gc`, whose object store the clone's
  //     alternates point into — an unreferenced base is a collectable base;
  //   • it makes the task's identity present in the repository the operator and
  //     `forge show` read, from dispatch rather than only after capture;
  //   • it turns capture's fetch into a fast-forward of a ref that already
  //     exists, rather than a creation, so a partial capture is still a ref
  //     movement the reaper can reason about.
  // The agent cannot touch it: the parent's refs are not in its container.
  execFileSync("git", ["branch", branch, baseSha], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let untrackedFiles: string[] = [];
  try {
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    untrackedFiles = out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // Non-fatal: diagnostic best-effort only.
  }

  return { clonePath, branch, baseSha, untrackedFiles };
}

/** Best-effort removal of a partially-created clone after a FAILED setup. The
 *  agent never ran, so there is no output to preserve — the clone-substrate
 *  counterpart of cleanupFailedWorktreeSetup.
 *
 *  NEVER call this on a TaskCloneExistsError or a TaskCloneAnchorExistsError:
 *  both refused to touch state precisely because a previous attempt may own it,
 *  and the ref case is the one that matters most — force-deleting a ref this
 *  attempt did not create destroys the ONLY durable record of the previous
 *  attempt's captured work. createTaskClone decides both refusals before it
 *  creates anything, so anything this function finds was made by the attempt that
 *  is now failing. */
export function cleanupFailedCloneSetup(projectDir: string, runId: string, taskId: string): void {
  const path = cloneDir(runId, taskId);
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort: a clone we cannot remove is retained, which is the safe side.
    }
  }
  // The parent-side anchor this setup created. `-D` is safe here for the same
  // reason the whole function is: the agent never ran, and the ref did not exist
  // when this attempt started, so it can only be pointing at the base this
  // attempt created it at.
  try {
    execFileSync("git", ["branch", "-D", worktreeBranchName(runId, taskId)], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best-effort: the branch may never have been created.
  }
}

/** WHY a capture failed. None of these is a merge conflict — nothing has been
 *  merged yet at capture time, and the parent's target branch is not involved —
 *  which is why the caller reports them all as `capture_failed` rather than
 *  borrowing FG-352's kind for a different event. */
export type CaptureFailureCause =
  /** The clone is not on the task's deterministic branch. */
  | "wrong_branch"
  /** `git status` in the clone could not be read, so what is uncaptured is unknown. */
  | "status_unreadable"
  /** The Forge safety commit of remaining tracked/untracked state failed. */
  | "safety_commit_failed"
  /** The clone's own branch tip did not resolve after the safety commit. */
  | "tip_unresolvable"
  /** The parent REJECTED the fetch of the clone's branch. */
  | "fetch_rejected"
  /** The fetched parent ref does not equal the resolved clone tip. */
  | "verification_mismatch";

export type CaptureTaskCloneResult =
  | {
      ok: true;
      branch: string;
      /** The commit now reachable from BOTH the clone's branch tip and the parent
       *  ref of the same name. Verified equal — this is the captured candidate. */
      commit: string;
      /** True when Forge had to safety-commit remaining dirty state. */
      safetyCommitted: boolean;
    }
  | { ok: false; cause: CaptureFailureCause; error: string };

/** THE CAPTURE ORDERING (FG-621 AC 3 / AC 5) — a contract, not an implementation
 *  detail. Exactly, and in this order:
 *
 *    1. safety-commit remaining clone state, TRACKED AND UNTRACKED, in the clone;
 *    2. resolve the resulting clone branch tip;
 *    3. fetch that branch into the PARENT's ref namespace under the same
 *       deterministic name — a real durable ref, never FETCH_HEAD, because it is
 *       simultaneously the gc anchor, the publisher's input and the reaper's
 *       reachability input;
 *    4. verify the fetched parent ref EQUALS the resolved clone tip;
 *    5. (caller) hand that ref to the publisher;
 *    6. (caller) perform NO later clone-side commit.
 *
 *  Step 6 is what the omitted `CandidateSource.worktreePath` enforces at the
 *  publisher boundary. The clone and the parent are DIFFERENT REPOSITORIES: a
 *  post-fetch commit in the clone advances only the clone's ref and would be
 *  silently absent from the candidate — which for a linked worktree, where the
 *  tree and the branch share one ref namespace, is harmless.
 *
 *  Any failure returns ok:false and the caller RETAINS the clone. Nothing here
 *  removes anything. */
export function captureTaskClone(
  projectDir: string,
  clonePath: string,
  runId: string,
  taskId: string
): CaptureTaskCloneResult {
  const branch = worktreeBranchName(runId, taskId);

  // The safety commit lands on whatever HEAD is, so a clone that is not on its
  // own task branch cannot be captured under that name — fail loudly rather than
  // publish a branch that is missing the agent's actual work.
  const ref = checkedOutRef(clonePath);
  if (ref !== `refs/heads/${branch}`) {
    return {
      ok: false,
      cause: "wrong_branch",
      error:
        `private clone ${clonePath} is checked out on ${ref ?? "a detached HEAD"}, not on refs/heads/${branch} — ` +
        "refusing to capture work under a branch name that does not describe it",
    };
  }

  let safetyCommitted = false;
  let statusOut = "";
  try {
    statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: clonePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    return {
      ok: false,
      cause: "status_unreadable",
      error: `git status in private clone ${clonePath} failed: ${String(e)}`,
    };
  }

  if (statusOut.trim().length > 0) {
    // `add -A` from the repo root stages tracked modifications, deletions AND
    // untracked files — AC 3 requires all three, and untracked output is the half
    // that exists nowhere else.
    try {
      execFileSync("git", ["add", "-A"], { cwd: clonePath, stdio: "ignore" });
      execFileSync(
        "git",
        [...FORGE_IDENTITY, "commit", "-m", `forge: safety-commit task ${taskId} output`],
        { cwd: clonePath, stdio: ["ignore", "ignore", "pipe"] }
      );
      safetyCommitted = true;
    } catch (e) {
      const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
      return {
        ok: false,
        cause: "safety_commit_failed",
        error: `safety-commit of task ${taskId} output failed: ${stderr || String(e)}`,
      };
    }
  }

  const tip = resolveCommit(clonePath, branch);
  if (tip === undefined) {
    return {
      ok: false,
      cause: "tip_unresolvable",
      error: `could not resolve ${branch} in private clone ${clonePath}`,
    };
  }

  try {
    execFileSync("git", ["fetch", "--quiet", clonePath, `${branch}:refs/heads/${branch}`], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    return {
      ok: false,
      cause: "fetch_rejected",
      error: `fetching ${branch} from private clone ${clonePath} into ${projectDir} failed: ${stderr || String(e)}`,
    };
  }

  const fetched = resolveCommit(projectDir, `refs/heads/${branch}`);
  if (fetched !== tip) {
    return {
      ok: false,
      cause: "verification_mismatch",
      error:
        `capture verification failed: ${projectDir} records ${branch} at ${fetched ?? "no commit"} but the private ` +
        `clone's tip is ${tip}. Retaining the clone — publishing the parent ref would publish a stale tree.`,
    };
  }

  return { ok: true, branch, commit: tip, safetyCommitted };
}

/** Remove a task worktree and its branch when doing so is SAFE.
 *
 *  Safe to remove under two conditions:
 *    1. Ephemeral/test mode (FORGE_WORKTREES_EPHEMERAL=1) — no real output at risk.
 *    2. provenMerged=true (FG-352) — merge-back succeeded; projectDir has the changes.
 *
 *  No-discard invariant: never remove an unmerged worktree outside EPHEMERAL mode.
 *  Callers must NOT pass provenMerged=true unless the merge already succeeded.
 *
 *  Silently skips if the path is absent (idempotent).
 *
 *  @param projectDir - resolved git repo root. All git commands run with this as
 *    cwd — never process.cwd(). Callers (reconcile.ts) must supply run.projectDir.
 *    If projectDir is not available (run was created without it), skip this call.
 *  @param provenMerged - set true only after a successful mergeWorktreeBranch call.
 */
export function removeWorktreeIfSafe(
  worktreePath: string,
  runId: string,
  taskId: string,
  projectDir: string,
  provenMerged = false
): void {
  // Only remove in ephemeral test mode OR after a proven merge-back (FG-352).
  if (process.env.FORGE_WORKTREES_EPHEMERAL !== "1" && !provenMerged) return;

  if (!existsSync(worktreePath)) return;

  const branch = worktreeBranchName(runId, taskId);

  // FIX3 (FG-376 review): dependency-cache volumes are SHARED by cache key
  // (lockfile hash), not owned by this worktree — a volume this task's install
  // populated may still be the one another concurrent/later task is reusing
  // (dependency-provisioning.ts FIX2). Individual worktree disposal must never
  // remove it; that used to tear a shared volume down as soon as ANY one task
  // using it finished. Cache pruning is now a deliberate, separate operation —
  // see dependency-provisioning.ts:removeDependencyVolumes for the explicit
  // prune entry point (not auto-invoked from here).

  // FG-621: a private clone is not a REGISTERED worktree — `git worktree remove`
  // has nothing to act on and `git worktree list` never shows it; the directory
  // IS the repository. Disposal is therefore a directory removal, and it is
  // gated on the one proof a main checkout cannot forge: the workspace's
  // alternates resolve to the parent's object store (see cloneOwnershipMismatch).
  // A clone that fails it is left exactly where it is for reapTaskWorkspace to
  // classify and RECORD — this inline path never retains silently by deleting.
  if (classifyWorkspace(worktreePath) === "private_clone") {
    if (cloneOwnershipMismatch(worktreePath, projectDir, branch).length > 0) return;
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      return;
    }
  } else {
    forceRemoveWorktree(projectDir, worktreePath);
  }

  try {
    // Force-delete (-D) is safe here: FORGE_WORKTREES_EPHEMERAL=1 is the
    // explicit "test/discardable output" opt-in, and -d would always fail on
    // unmerged task branches pre-FG-352, leaking stale refs each ephemeral run.
    // Production path (EPHEMERAL unset) never reaches this call.
    execFileSync("git", ["branch", "-D", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best-effort: branch may already be gone.
  }
}

// ── Merge-back ────────────────────────────────────────────────────────────────

export type MergeWorktreeBranchResult =
  | { ok: true }
  | { ok: false; error: string };

/** Merge the task worktree branch into run.projectDir using fast-forward-only.
 *
 *  DEAD CODE, deliberately kept: FG-425 routed every merge through
 *  publishIntegration, and fg425-publisher-scope.test.ts asserts runNext.ts calls
 *  neither this nor mergeIntegrationBranchToHead. Wiring it back in would
 *  reintroduce a merge-then-gate site against the publish target. It is NOT the
 *  FG-621 merge-back re-plumbing either — that is captureTaskClone's fetch.
 *
 *  The commit contract, per SUBSTRATE (FG-621 corrects the older text here, which
 *  described one path as if it covered both):
 *
 *    • PRIVATE CLONE (mutating agents, the shipped path). The agent commits its
 *      own work on its own branch, in its own repository — that is the primary
 *      capture, and FG-345 restores it deliberately. Forge's host-side commit is
 *      the SAFETY NET for whatever is still dirty at exit (captureTaskClone step
 *      1), and it runs BEFORE the branch is fetched into the parent. Nothing
 *      commits into the clone afterwards.
 *    • LINKED WORKTREE (non-mutating/red agents, FG-559's substrate). The agent
 *      cannot commit at all — the parent's ref namespace is read-only to it — so
 *      the host auto-commit below IS the primary capture, not a net.
 *
 *  Behaviour if it is ever called: auto-stages and commits any uncommitted
 *  changes in the worktree before merging. No changes => the commit is skipped.
 *  A commit that FAILS with changes present (hook, missing identity, lock file)
 *  returns ok:false — the caller must retain the worktree. A clean no-op merge
 *  succeeds silently.
 */
export function mergeWorktreeBranch(
  projectDir: string,
  worktreePath: string,
  runId: string,
  taskId: string
): MergeWorktreeBranchResult {
  const branch = worktreeBranchName(runId, taskId);

  // Check for uncommitted changes before attempting auto-commit.
  // We must distinguish "nothing to commit" (safe to proceed) from "commit
  // failed with changes present" (agent output would be lost — must return
  // ok:false so the caller retains the worktree instead of discarding it).
  let statusOut = "";
  try {
    statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    return {
      ok: false,
      error: `git status in worktree ${worktreePath} failed: ${String(e)}`,
    };
  }

  if (statusOut.trim().length > 0) {
    // Worktree has uncommitted changes — auto-stage and commit. Untracked files
    // are captured via `git add .` (surfaced as a diagnostic at createWorktree).
    try {
      execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=forge", "-c", "user.email=forge@local", "commit", "-m", `forge: auto-commit task ${taskId} output`],
        { cwd: worktreePath, stdio: ["ignore", "ignore", "pipe"] }
      );
    } catch (e) {
      const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
      return {
        ok: false,
        error: `auto-commit of task ${taskId} output failed: ${stderr || String(e)}`,
      };
    }
  }

  try {
    execFileSync("git", ["merge", "--ff-only", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    return {
      ok: false,
      error: `git merge --ff-only ${branch} failed: ${stderr || String(e)}`,
    };
  }
}

/** Unconditional best-effort cleanup after a FAILED worktree SETUP (gate check
 *  or createWorktree threw before the agent started). Not gated by EPHEMERAL:
 *  since the agent never ran, there is no output to preserve — always safe to
 *  remove any partially-created directory or git worktree registration.
 *  Silently skips if nothing was created (idempotent). */
export function cleanupFailedWorktreeSetup(
  projectDir: string,
  runId: string,
  taskId: string
): void {
  const path = worktreeDir(runId, taskId);
  if (!existsSync(path)) return;
  // FIX3 (FG-376 review): no dependency-volume cleanup here — see
  // removeWorktreeIfSafe above for why a shared cache volume must not be
  // removed at individual worktree disposal.
  // forceRemoveWorktree prunes the registration itself when the removal does not
  // cleanly succeed, so there is nothing left to do here.
  forceRemoveWorktree(projectDir, path);
}

// ── FG-356: the orphan workspace reaper ───────────────────────────────────────
//
// removeWorktreeIfSafe above is the DISPATCH-path disposal: it fires inline on a
// step that merged cleanly, and it is a deliberate no-op otherwise. Nothing swept
// the workspace of a task whose forge process DIED — the crash lane
// (fg530-crash-worktree.worktree.test.ts) demonstrated the leak precisely: a kill
// between the terminal status write and the cleanup call leaves a merged-and-done
// tree that no later pass ever looks at. This is the reaper for that, driven off
// the recorded workspace path on the Task row (never a filesystem scan).
//
// Two substrates, because FG-345 decided the workspace follows capability:
//   • LINKED WORKTREE — non-mutating agents. Removed with `git worktree remove`.
//   • PRIVATE `--shared` CLONE — mutating agents (FG-621). NOT a registered
//     worktree: `git worktree remove` does not apply to it and `git worktree
//     list` never shows it. Reaping one is a directory removal — the directory IS
//     the repository, and its private refs go with it — and because its
//     alternates point back into the parent object store, it must not be removed
//     while the parent is mid-`gc` (that is a DEFERRAL, not a retain).
//
// The substrate is read off the workspace itself rather than a column, so it is
// right for both substrates forge creates. But classification ALONE cannot make
// the clone branch safe: a main checkout (the operator's live source) also has a
// `.git` DIRECTORY, so it classifies as a clone too. What keeps it out of reach
// is the ownership proof FG-621 added on that branch — the workspace's
// `objects/info/alternates` must resolve to the parent's object store, which is
// the one property a main checkout cannot forge (no repository is ever its own
// alternate). Layout, branch name and remote are all imitable; that is not.
//
// REMOVAL MUST BE PROVABLY SAFE, not best-effort (FG-345's recovery half). A
// crashed task whose output was never captured is RETAINED and its path + branch
// recorded as durable evidence; the reaper exists to stop leaks, the retain
// contract exists to stop discards, and where they disagree the retain wins.

export type WorkspaceSubstrate = "linked_worktree" | "private_clone" | "absent" | "unknown";

/** Which substrate the recorded workspace path holds. A linked worktree's `.git`
 *  is a FILE pointing at the parent's `.git/worktrees/<name>`; a clone's (and a
 *  main checkout's) is a DIRECTORY. */
export function classifyWorkspace(workspacePath: string): WorkspaceSubstrate {
  const dotGit = join(workspacePath, ".git");
  let isDir: boolean;
  try {
    isDir = statSync(dotGit).isDirectory();
  } catch {
    return existsSync(workspacePath) ? "unknown" : "absent";
  }
  if (isDir) return "private_clone";
  try {
    return readFileSync(dotGit, "utf8").startsWith("gitdir:") ? "linked_worktree" : "unknown";
  } catch {
    return "unknown";
  }
}

export type WorkspaceRetainReason =
  /** Uncommitted, untracked or ignored files in the tree — work that exists
   *  nowhere else. */
  | "uncommitted_work"
  /** The task's commits are not reachable from the project's HEAD — never captured. */
  | "unmerged_commits"
  /** The workspace has at least one checked-out submodule. Forge never creates
   *  one (`git worktree add` leaves every gitlink uninitialized and empty), so
   *  this is a workspace shape the reaper was not built to prove capture for. */
  | "submodules_present"
  /** RETAINED FOR CONTRACT COMPATIBILITY, no longer produced by the proven path.
   *  Before FG-621 every private clone was retained under this reason because
   *  clone reaping was unimplemented. It stays in the union — and in
   *  docs/SCHEMA-CONTRACT.md, docs/concepts.md and docs/invariants.md — because
   *  the enum is a published surface and historical events still carry the value.
   *  A clone forge cannot prove it owns now retains as `workspace_not_owned`. */
  | "private_clone_substrate"
  /** A directory we cannot identify as either substrate — never guessed at. */
  | "unknown_substrate"
  /** Not THIS task's workspace. For a linked worktree: another repository, or a
   *  branch other than the task's deterministic one. For a private clone
   *  (FG-621): its `objects/info/alternates` does not resolve to the parent's
   *  object store — which is also how the operator's live source checkout, and
   *  any ordinary clone, stay structurally out of reach. */
  | "workspace_not_owned"
  /** FG-621: the task's recorded publication receipt names a `remote:` target, so
   *  projectDir's HEAD is not a capture proxy for it, and nothing else proved the
   *  clone's commits captured. An EXPLICIT, NAMED retain — never a silent
   *  forever-retain that looks like an unimplemented path. */
  | "remote_target_uncaptured"
  /** git refused the removal even after unlock + double force. */
  | "removal_failed";

/** FG-621: why a disposal was POSTPONED rather than refused. A deferral is not a
 *  disposition — nothing is reaped and nothing is retained, and the next pass
 *  asks again. It is still RECORDED (see WorkspaceReapOutcome's `deferred`). */
export type WorkspaceDeferReason =
  /** `gc.pid` is present in the parent's common git dir: git is repacking the
   *  very object store this clone's alternates point into. Transient by
   *  definition, so disposal waits for the next pass rather than racing it. */
  | "parent_repacking";

/** How a reaped workspace actually went away. `git_removed` is git completing the
 *  removal; `path_vanished` is git DECLINING it while the tree turned out to be
 *  gone anyway — the stale registration is pruned, and the difference is recorded
 *  rather than reported as a clean removal. */
export type WorkspaceRemovalDisposition = "git_removed" | "path_vanished";

export type WorkspaceReapOutcome =
  | { action: "absent"; branch: string }
  /** The workspace was already gone, but its branch had outlived it — a prior
   *  pass removed the tree and lost the `git branch -d`. The ref is gone now. */
  | { action: "branch_reaped"; branch: string }
  | {
      action: "reaped";
      substrate: "linked_worktree" | "private_clone";
      branch: string;
      branchRemoved: boolean;
      removal: WorkspaceRemovalDisposition;
    }
  | {
      action: "retained";
      substrate: WorkspaceSubstrate;
      branch: string;
      reason: WorkspaceRetainReason;
      details: string[];
    }
  /** FG-621: try again next pass. NOT a disposition — the workspace was neither
   *  reaped nor retained, so a reader must not render it as either, and a later
   *  pass still has to settle it.
   *
   *  It is recorded all the same, as its OWN event type
   *  (`task.workspace_reap_deferred`, reconcile.ts) rather than as a retention:
   *  a deferral that never resolves would otherwise be indistinguishable from a
   *  workspace nothing ever looked at. Once per (task, reason) — the same rule
   *  the retentions use — so a second pass that defers again logs nothing, which
   *  is what keeps the timeline un-flooded and the crash-lane fixpoint intact. */
  | {
      action: "deferred";
      substrate: WorkspaceSubstrate;
      branch: string;
      reason: WorkspaceDeferReason;
      details: string[];
    };

/** FG-621: what Forge has RECORDED about a task's publication, handed to the
 *  reaper by its caller so this module stays free of the store.
 *
 *  `isAncestorOfHead` asks reachability from `projectDir` HEAD, which is a proxy
 *  — and a `remote:<remote>#<branch>` target never advances local HEAD at all, so
 *  on that target every clone would fail the capture proof and be retained
 *  forever. The receipts are the authority: a candidate SHA the publisher
 *  recorded as PUBLISHED is Forge-owned state, and a clone commit reachable from
 *  one is captured whatever HEAD says. */
export type CaptureAuthority = {
  /** Candidate/published SHAs from this task's publication receipts. Reachability
   *  from ANY of them is proof of capture. */
  anchors: string[];
  /** The target descriptor of the newest receipt, e.g. `local:main` or
   *  `remote:origin#main`. Names the remote case in the retain reason. */
  target?: string | undefined;
};

/** `git status --porcelain --ignored` in one working tree. undefined when git
 *  could not answer at all — indistinguishable from "there may be work here", so
 *  callers treat it as unsafe rather than clean.
 *
 *  `--ignored` because an agent's output frequently lands on paths the project
 *  ignores (build artifacts, scratch dirs, logs). Those files exist nowhere but
 *  this workspace, so a tracked-clean tree holding only ignored output is NOT
 *  proof of capture — probing without it would force-remove unrecovered work. */
function statusPorcelainIgnored(treePath: string): string[] | undefined {
  try {
    return execFileSync("git", ["status", "--porcelain", "--ignored"], {
      cwd: treePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Checked-out submodules of a working tree, as paths relative to it. `git
 *  submodule status` marks an uninitialized entry with a leading `-`: its
 *  directory is empty, which is the only shape `git worktree add` ever produces
 *  (it never runs `submodule update --init`). undefined when git could not
 *  answer. Read as a yes/no question — any checked-out submodule retains. */
function checkedOutSubmodules(treePath: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["submodule", "status", "--recursive"], {
      cwd: treePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths: string[] = [];
    for (const line of out.split("\n")) {
      if (!line || line.startsWith("-")) continue;
      // "<marker><sha> <path>[ (<describe>)]" — the describe suffix is optional
      // and the path may contain spaces, so take everything between them.
      const m = /^.[0-9a-f]+ (.*?)(?: \([^)]*\))?$/.exec(line);
      if (m?.[1]) paths.push(m[1]);
    }
    return paths;
  } catch {
    return undefined;
  }
}

function resolveCommit(cwd: string, rev: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The repository a working tree belongs to, as an absolute resolved path to its
 *  shared `.git` dir. A linked worktree reports its PARENT's — which is what
 *  makes it the ownership test. undefined when git could not answer. */
function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? realpathSync(resolve(cwd, out)) : undefined;
  } catch {
    return undefined;
  }
}

/** The ref a working tree has checked out, e.g. `refs/heads/forge/<run>/<task>`.
 *  undefined on a detached HEAD or when git could not answer. */
function checkedOutRef(cwd: string): string | undefined {
  try {
    return (
      execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Why the recorded path is not this task's workspace — empty when it is.
 *
 *  The capture checks all ask "is the work here safe to lose?", and a workspace
 *  that was never this task's answers YES trivially: another clean worktree of
 *  the SAME repository is clean, and its HEAD is already reachable from HEAD, so
 *  a stale or misassigned worktree_path passes every one of them and the reaper
 *  deletes a tree it was never asked about — then deletes the task's branch on
 *  top of it. Ownership is checked from the workspace itself (its repository and
 *  its checked-out branch), never inferred from the path. */
function ownershipMismatch(workspacePath: string, projectDir: string, branch: string): string[] {
  const details: string[] = [];

  const workspaceRepo = gitCommonDir(workspacePath);
  const projectRepo = gitCommonDir(projectDir);
  if (workspaceRepo === undefined || projectRepo === undefined || workspaceRepo !== projectRepo) {
    details.push(
      `workspace belongs to ${workspaceRepo ?? "an unreadable repository"}, not to ${projectRepo ?? "an unreadable repository"}`
    );
  }

  const ref = checkedOutRef(workspacePath);
  if (ref !== `refs/heads/${branch}`) {
    details.push(`workspace is checked out on ${ref ?? "a detached HEAD"}, not on refs/heads/${branch}`);
  }

  return details;
}

/** The object stores a repository borrows, as absolute realpaths. Empty when the
 *  file is absent (an ordinary repo), undefined when it exists but cannot be read
 *  — which is NOT the same thing and must not be read as "no alternates". */
function alternateObjectStores(commonGitDir: string): string[] | undefined {
  const file = join(commonGitDir, "objects", "info", "alternates");
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    try {
      entries.push(realpathSync(resolve(commonGitDir, "objects", entry)));
    } catch {
      // An alternate that does not resolve cannot match the parent's object
      // store, so record it verbatim and let the comparison below refuse it.
      entries.push(entry);
    }
  }
  return entries;
}

/** FG-621: why the recorded path is not this task's PRIVATE CLONE — empty when it
 *  is. The clone counterpart of ownershipMismatch, and it INVERTS: a `--shared`
 *  clone is a different repository from the parent by construction, so equal
 *  git-common-dirs is the disproof, not the proof.
 *
 *  The alternates file is the one property a main checkout cannot forge.
 *  Classification cannot tell a private clone from the operator's live source —
 *  both have a `.git` DIRECTORY — and layout, branch name and remote are all
 *  imitable. But a `--shared` clone's `objects/info/alternates` resolves to the
 *  PARENT's object store, and no repository is ever its own alternate. That
 *  check, not the substrate, is what keeps the FG-607 live-source incident and
 *  every ordinary clone structurally out of reach on this path. */
function cloneOwnershipMismatch(workspacePath: string, projectDir: string, branch: string): string[] {
  const details: string[] = [];

  // The alternates prove the workspace is a clone of THIS repository; the
  // checked-out branch is what makes it THIS TASK's. Without the second half, a
  // stale or misassigned workspace_path naming a sibling task's clone would pass
  // the ownership test, and — if that sibling's work happened to be captured and
  // its tree clean — be disposed of under the wrong task's name.
  const ref = checkedOutRef(workspacePath);
  if (ref !== `refs/heads/${branch}`) {
    details.push(`workspace is checked out on ${ref ?? "a detached HEAD"}, not on refs/heads/${branch}`);
  }

  const workspaceRepo = gitCommonDir(workspacePath);
  const projectRepo = gitCommonDir(projectDir);
  if (workspaceRepo === undefined || projectRepo === undefined) {
    details.push(
      `could not resolve the git directory of ${workspaceRepo === undefined ? workspacePath : projectDir}`
    );
    return details;
  }
  if (workspaceRepo === projectRepo) {
    details.push(
      `workspace shares ${projectRepo} with the project — a private clone never does, so this is the live source ` +
        "checkout or one of its worktrees, not a task workspace"
    );
    return details;
  }

  const alternates = alternateObjectStores(workspaceRepo);
  if (alternates === undefined) {
    details.push(`${join(workspaceRepo, "objects", "info", "alternates")} exists but could not be read`);
    return details;
  }
  let parentObjects: string;
  try {
    parentObjects = realpathSync(join(projectRepo, "objects"));
  } catch {
    details.push(`the project's object store ${join(projectRepo, "objects")} could not be resolved`);
    return details;
  }
  if (alternates.length !== 1 || alternates[0] !== parentObjects) {
    details.push(
      `workspace alternates ${alternates.length === 0 ? "(none)" : alternates.join(", ")} do not resolve to the ` +
        `project's object store ${parentObjects}`
    );
  }
  return details;
}

/** How long a `gc.pid` may sit before forge stops believing it. git's own gc
 *  uses 12 hours as the point past which a lock file is presumed abandoned
 *  (builtin/gc.c), so forge uses the same bound rather than inventing one. */
const GC_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Is git ACTUALLY repacking the parent's object store right now?
 *
 *  A `--shared` clone's alternates point into the very store a repack rewrites,
 *  so a live gc is a reason to wait. But the EXISTENCE of `gc.pid` is not the
 *  same question: git leaves the file behind when a gc is killed, and a stale one
 *  is forever. Testing existence alone therefore turns one abandoned lock into a
 *  permanent, silent forever-deferral for every clone in the project — un-reaped
 *  AND un-reported. So the same two things git itself checks are checked here:
 *  the lock's age, and (when it names THIS host) whether its process is alive.
 *  A lock naming another host cannot be probed and is believed until it expires. */
function parentIsRepacking(projectDir: string): boolean {
  const common = gitCommonDir(projectDir);
  if (common === undefined) return false;
  const lock = join(common, "gc.pid");
  const st = statSync(lock, { throwIfNoEntry: false });
  if (!st) return false;
  if (Date.now() - st.mtimeMs > GC_LOCK_MAX_AGE_MS) return false;

  // git writes "<pid> <hostname>".
  let contents: string;
  try {
    contents = readFileSync(lock, "utf8");
  } catch {
    return true;
  }
  const [pidText, host] = contents.trim().split(/\s+/, 2);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (host !== hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: the gc that wrote this is gone. EPERM: it exists and belongs to
    // another user — alive either way.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isAncestorOf(projectDir: string, commit: string, anchor: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, anchor], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isAncestorOfHead(projectDir: string, commit: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Dispose of a task branch on THE SAME PROOF that authorized the reap.
 *
 *  `git branch -d` asks one question — "is this merged into HEAD?" — and FG-621
 *  widened the capture proof past it: a clone published to a `remote:` target is
 *  proven captured by a recorded publication receipt while HEAD never moves. Left
 *  on `-d` alone the tree is reaped and the ref is stranded with no retry, which
 *  is exactly the ref-stranding FG-356 fixed and this must not regress.
 *
 *  So: `-d` first, because where git can answer it is the better second opinion.
 *  Only when git declines AND the surviving tip is reachable from Forge-owned
 *  state — the same `captured` predicate the reap itself required — is the ref
 *  forced. A tip nothing proves captured is never forced, ever. */
function disposeCapturedBranch(
  projectDir: string,
  branch: string,
  captured: (commit: string) => boolean
): boolean {
  if (deleteMergedBranch(projectDir, branch)) return true;
  const tip = resolveCommit(projectDir, branch);
  if (tip === undefined) return true;
  if (!captured(tip)) return false;
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Fall through — the ref's existence is what decides, not git's exit code.
  }
  return resolveCommit(projectDir, branch) === undefined;
}

/** `git branch -d` — the merged-only form, never `-D`. True once the ref is
 *  gone; a branch git declines to delete because it is not merged stays, and is
 *  never forced. Deliberately a second opinion on the one irreversible step. */
function deleteMergedBranch(projectDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["branch", "-d", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return resolveCommit(projectDir, branch) === undefined;
  }
}

/** Dispose of a task's workspace and its branch — but ONLY once the work inside
 *  is provably captured. Never throws; reaping an already-gone workspace is a
 *  no-op, so repeated calls are safe.
 *
 *  Safe means all of: the workspace is one of the two substrates forge creates and
 *  is THIS task's, it holds no checked-out submodule, the tree is clean (no
 *  uncommitted, untracked or ignored files), and every commit its branch/HEAD
 *  points at is reachable from Forge-owned state. Anything else — including
 *  anything git declines to answer — is RETAINED with the reason, so the caller
 *  can record where the work still lives.
 *
 *  What "THIS task's" and "Forge-owned state" mean depends on the substrate:
 *
 *    • LINKED WORKTREE — ownership is projectDir's own repository plus the task's
 *      deterministic branch checked out (ownershipMismatch), and it is proved
 *      LAST, because where both would refuse, the capture reasons name the exact
 *      commits or files at stake.
 *    • PRIVATE CLONE — ownership INVERTS (a `--shared` clone's git-common-dir
 *      differs from the parent's by construction) and is proved FIRST via the
 *      alternates target (cloneOwnershipMismatch). Its capture set is THREE
 *      de-duplicated tips, because a clone is a full repository whose branch can
 *      hold commits its HEAD is not on.
 *
 *  Reachability is asked of projectDir's HEAD OR of `authority.anchors` — the
 *  SHAs the publisher recorded for this task. HEAD alone is only a proxy, and a
 *  `remote:` target never advances it. */
export function reapTaskWorkspace(
  workspacePath: string,
  runId: string,
  taskId: string,
  projectDir: string,
  authority: CaptureAuthority = { anchors: [] }
): WorkspaceReapOutcome {
  const branch = worktreeBranchName(runId, taskId);
  const substrate = classifyWorkspace(workspacePath);

  /** Forge-owned state can reach this commit: it is an ancestor of projectDir's
   *  HEAD, or of a SHA the publisher recorded as published for this task. */
  const captured = (commit: string): boolean =>
    isAncestorOfHead(projectDir, commit) ||
    authority.anchors.some((anchor) => isAncestorOf(projectDir, commit, anchor));

  if (substrate === "absent") {
    // The tree can be gone while the branch is not: the deletion below runs
    // AFTER the removal, so a transient failure there leaves the ref behind and
    // every later pass used to return here without ever retrying it — stranding
    // a forge/<runId>/<taskId> ref permanently.
    //
    // The retry runs on the SAME warrant the first pass did — `captured`, not
    // `git branch -d`'s merged-into-HEAD question. A clone published to a
    // `remote:` target is proven captured by a RECEIPT anchor while HEAD never
    // moves, so a merged-only retry refuses that ref on every later pass and
    // strands it exactly as permanently as never retrying at all. Scoped to this
    // task's own deterministic branch, and a tip nothing proves captured is still
    // never forced: it survives untouched and records nothing.
    if (resolveCommit(projectDir, branch) === undefined) return { action: "absent", branch };
    return disposeCapturedBranch(projectDir, branch, captured)
      ? { action: "branch_reaped", branch }
      : { action: "absent", branch };
  }
  if (substrate === "private_clone") {
    // OWNERSHIP FIRST on this branch — the opposite order from the linked-worktree
    // path below, and deliberately so. There, ownership runs last because the
    // capture reasons are the better evidence. Here it must run FIRST: every
    // capture check asks "is the work here safe to lose?", and the operator's live
    // source checkout answers yes trivially (it is clean, and its HEAD is
    // reachable from its own HEAD). The alternates proof is the ONLY thing that
    // separates a task's private clone from it, from an ordinary clone, and from
    // another repository entirely.
    const notOurs = cloneOwnershipMismatch(workspacePath, projectDir, branch);
    if (notOurs.length > 0) {
      return { action: "retained", substrate, branch, reason: "workspace_not_owned", details: notOurs };
    }

    const submodules = checkedOutSubmodules(workspacePath);
    if (submodules === undefined || submodules.length > 0) {
      return {
        action: "retained",
        substrate,
        branch,
        reason: "submodules_present",
        details: submodules ?? ["git submodule status could not be read in the workspace"],
      };
    }

    const dirty = statusPorcelainIgnored(workspacePath);
    if (dirty === undefined || dirty.length > 0) {
      return {
        action: "retained",
        substrate,
        branch,
        reason: "uncommitted_work",
        details: dirty ?? ["git status could not be read in the workspace"],
      };
    }

    // THREE tips, de-duplicated. A clone is a FULL repository, so its branch can
    // hold commits its HEAD is not sitting on — reading only HEAD (plus the
    // parent-side ref) would miss them and reap work nothing else has.
    const tips = [
      resolveCommit(projectDir, branch),
      resolveCommit(workspacePath, "HEAD"),
      resolveCommit(workspacePath, branch),
    ].filter((c): c is string => c !== undefined);
    const uniqueTips = [...new Set(tips)];
    const uncaptured = uniqueTips.filter((c) => !captured(c));
    if (uniqueTips.length === 0 || uncaptured.length > 0) {
      // A `remote:` target never advances projectDir's HEAD, so when the receipts
      // are what should have proved capture and did not, say THAT rather than
      // leaving an operator to read a HEAD-relative "unmerged" verdict about a
      // branch that was never going to reach HEAD.
      const remoteTarget = authority.target?.startsWith("remote:") === true;
      return {
        action: "retained",
        substrate,
        branch,
        reason: remoteTarget ? "remote_target_uncaptured" : "unmerged_commits",
        details:
          uniqueTips.length === 0
            ? ["the private clone's history could not be resolved"]
            : remoteTarget
              ? [...uncaptured, `publish target ${authority.target}`]
              : uncaptured,
      };
    }

    // `gc.pid` in the parent's common git dir means git is repacking the very
    // object store this clone's alternates point into. TRANSIENT — so this is a
    // deferral, not a disposition: nothing is reaped or retained and the next
    // pass asks again (the caller still records the deferral itself, under its
    // own event type). Checked here, immediately before the irreversible step, so a clone
    // that would have been retained for a real reason still reports that reason.
    if (parentIsRepacking(projectDir)) {
      return {
        action: "deferred",
        substrate,
        branch,
        reason: "parent_repacking",
        details: ["the parent repository is running gc; disposal waits for the next pass"],
      };
    }

    try {
      rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Fall through to the existence check — a partial removal is still a
      // removal_failed, and the directory is what decides.
    }
    if (existsSync(workspacePath)) {
      return { action: "retained", substrate, branch, reason: "removal_failed", details: [] };
    }
    return {
      action: "reaped",
      substrate,
      branch,
      // Same proof, both halves of the disposal. The tree above was removed
      // because `captured` reached every tip; the ref goes on that same warrant,
      // so a clone proven captured by a publication receipt does not leave its
      // parent-side ref behind (FG-356's ref-stranding, on the new substrate).
      branchRemoved: disposeCapturedBranch(projectDir, branch, captured),
      // The directory IS the repository, so there is no `git worktree remove` to
      // succeed or decline: rmSync either left the path gone or it did not.
      removal: "git_removed",
    };
  }
  if (substrate === "unknown") {
    return { action: "retained", substrate, branch, reason: "unknown_substrate", details: [] };
  }

  // A checked-out submodule is not a shape this reaper proves capture for: the
  // superproject's status does not recurse, so a submodule holding the only copy
  // of an agent's output reports clean at the top level. Rather than probe each
  // one, retain the whole workspace — forge's own worktrees never reach here,
  // since `git worktree add` leaves every gitlink uninitialized and empty.
  const submodules = checkedOutSubmodules(workspacePath);
  if (submodules === undefined || submodules.length > 0) {
    return {
      action: "retained",
      substrate,
      branch,
      reason: "submodules_present",
      details: submodules ?? ["git submodule status could not be read in the workspace"],
    };
  }

  const dirty = statusPorcelainIgnored(workspacePath);
  if (dirty === undefined || dirty.length > 0) {
    return {
      action: "retained",
      substrate,
      branch,
      reason: "uncommitted_work",
      details: dirty ?? ["git status could not be read in the workspace"],
    };
  }

  const tips = [resolveCommit(projectDir, branch), resolveCommit(workspacePath, "HEAD")].filter(
    (c): c is string => c !== undefined
  );
  const uncaptured = tips.filter((c) => !captured(c));
  if (tips.length === 0 || uncaptured.length > 0) {
    return {
      action: "retained",
      substrate,
      branch,
      reason: "unmerged_commits",
      details: tips.length === 0 ? ["the workspace's history could not be resolved"] : uncaptured,
    };
  }

  // Last gate before the irreversible step, and deliberately after the capture
  // checks: where both would refuse, the capture reasons name the exact commits
  // or files at stake, which is the more useful evidence for an operator.
  const notOurs = ownershipMismatch(workspacePath, projectDir, branch);
  if (notOurs.length > 0) {
    return { action: "retained", substrate, branch, reason: "workspace_not_owned", details: notOurs };
  }

  // Path absence is what decides whether there is still a workspace to retain;
  // git's own verdict is what decides how the disposal is REPORTED. A removal
  // git declined whose tree was gone anyway is a real disposal — retaining a
  // directory that does not exist would name a place the work is not — but it is
  // not a clean `git worktree remove`, so it is not recorded as one.
  const removal = forceRemoveWorktree(projectDir, workspacePath);
  if (!removal.pathAbsent) {
    return { action: "retained", substrate, branch, reason: "removal_failed", details: [] };
  }

  return {
    action: "reaped",
    substrate,
    branch,
    branchRemoved: deleteMergedBranch(projectDir, branch),
    removal: removal.gitRemoved ? "git_removed" : "path_vanished",
  };
}

// ── FG-353 Integration worktree helpers ───────────────────────────────────────

/** Deterministic integration branch name for a fan-out step.
 *  Pattern: forge/<runId>/<parentTaskId>/integration. */
export function integrationBranchName(runId: string, parentTaskId: string): string {
  return `forge/${runId}/${parentTaskId}/integration`;
}

/** Check if the integration branch already exists in the repo. Used for
 *  re-entry detection in dispatchFanoutStep. */
export function integrationBranchExists(
  projectDir: string,
  runId: string,
  parentTaskId: string
): boolean {
  const branch = integrationBranchName(runId, parentTaskId);
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Create the integration worktree for a fan-out step.
 *
 *  Prune-then-create for retry safety: if a stale integration branch/worktree
 *  exists (from an aborted prior attempt), force-remove it unconditionally —
 *  a stale integration worktree is always from an aborted prior attempt and
 *  never has agent output to preserve (unlike child worktrees). */
export function createIntegrationWorktree(
  projectDir: string,
  runId: string,
  parentTaskId: string
): { integrationPath: string } {
  const integrationPath = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);

  if (integrationBranchExists(projectDir, runId, parentTaskId)) {
    forceRemoveWorktree(projectDir, integrationPath);
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* best-effort */ }
  }

  mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });

  execFileSync("git", ["worktree", "add", integrationPath, "-b", branch], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  return { integrationPath };
}

/** Merge a single child task branch into the integration worktree.
 *
 *  Uses --no-ff so each child gets an explicit merge commit on the integration
 *  branch. Call in child INDEX order for deterministic history.
 *
 *  `childWorktreePath` is OPTIONAL, and omitting it is the FG-621 clone path.
 *  When it is given, this keeps FG-352's no-discard contract for a LINKED
 *  worktree: auto-stage and commit anything uncommitted before merging, and treat
 *  a commit that fails with changes present as fatal (the caller retains the
 *  worktree). When it is ABSENT, the child's work was already captured — Forge
 *  safety-committed the clone and fetched its branch into this repository's ref
 *  namespace — and committing into the clone HERE would advance only the clone's
 *  own ref, leaving the already-fetched branch (and therefore the candidate)
 *  silently stale. Not passing a path is what makes that structural rather than a
 *  convention: this function can only mutate a workspace it was told about. */
export function mergeChildIntoIntegration(
  integrationWorktreePath: string,
  runId: string,
  childTaskId: string,
  childWorktreePath?: string
): MergeWorktreeBranchResult {
  const branch = worktreeBranchName(runId, childTaskId);

  let statusOut = "";
  if (childWorktreePath !== undefined) {
    try {
      statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd: childWorktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      return {
        ok: false,
        error: `git status in child worktree ${childWorktreePath} failed: ${String(e)}`,
      };
    }
  }

  if (childWorktreePath !== undefined && statusOut.trim().length > 0) {
    try {
      execFileSync(
        "git",
        ["-c", "user.name=forge", "-c", "user.email=forge@local", "add", "."],
        { cwd: childWorktreePath, stdio: "ignore" }
      );
      execFileSync(
        "git",
        [
          "-c", "user.name=forge", "-c", "user.email=forge@local",
          "commit", "-m", `forge: auto-commit task ${childTaskId} output`,
        ],
        { cwd: childWorktreePath, stdio: ["ignore", "ignore", "pipe"] }
      );
    } catch (e) {
      const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
      return {
        ok: false,
        error: `auto-commit of child task ${childTaskId} output failed: ${stderr || String(e)}`,
      };
    }
  }

  try {
    execFileSync(
      "git",
      [
        "-c", "user.name=forge", "-c", "user.email=forge@local",
        "merge", "--no-ff", branch,
      ],
      { cwd: integrationWorktreePath, stdio: ["ignore", "ignore", "pipe"] }
    );
    return { ok: true };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    // Abort the failed merge so the integration worktree is not left in MERGING
    // state. The branch and worktree are retained for inspection via reflog.
    try {
      execFileSync("git", ["merge", "--abort"], {
        cwd: integrationWorktreePath,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* best-effort: abort may not be needed if merge failed before starting */ }
    return {
      ok: false,
      error: `git merge --no-ff ${branch} into integration failed: ${stderr || String(e)}`,
    };
  }
}

/** Merge the integration branch into run.projectDir HEAD using fast-forward-only.
 *
 *  Safe to use --ff-only: the integration branch was created from HEAD and only
 *  received committed --no-ff merges, making it a strict forward descendant. */
export function mergeIntegrationBranchToHead(
  projectDir: string,
  runId: string,
  parentTaskId: string
): MergeWorktreeBranchResult {
  const branch = integrationBranchName(runId, parentTaskId);
  try {
    execFileSync("git", ["merge", "--ff-only", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    return {
      ok: false,
      error: `git merge --ff-only ${branch} into HEAD failed: ${stderr || String(e)}`,
    };
  }
}

/** Unconditional best-effort cleanup of the integration worktree and branch.
 *  Not EPHEMERAL-gated — called only after a proven HEAD merge.
 *  Mirrors cleanupFailedWorktreeSetup semantics. */
export function cleanupIntegrationWorktree(
  projectDir: string,
  runId: string,
  parentTaskId: string
): void {
  const path = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);
  // FIX3 (FG-376 review): no dependency-volume cleanup here — see
  // removeWorktreeIfSafe above for why a shared cache volume must not be
  // removed at individual worktree disposal.
  forceRemoveWorktree(projectDir, path);
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch { /* best-effort */ }
}
