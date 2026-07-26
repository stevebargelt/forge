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

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findGitRoot } from "../util/git-root.js";
import { WORKTREES_DIR, worktreeDir, integrationWorktreeDir } from "../util/paths.js";

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

/** `git worktree remove` that survives a LOCKED worktree (FG-356).
 *
 *  A single `--force` still refuses a worktree git considers locked, so any tool
 *  that adopts and locks one (Supacode does this under its tracked repo roots)
 *  wedges every cleanup path here permanently. Unlock first — "not locked" is an
 *  expected no-op, not an error — then use the double-force form, which is what
 *  git actually requires for a locked tree.
 *
 *  Best-effort and never throws: an already-gone worktree is a no-op. Returns
 *  whether the directory is gone afterwards, so a caller that needs PROOF of
 *  removal (the reaper below) can tell a real removal from a silent failure. */
export function forceRemoveWorktree(projectDir: string, worktreePath: string): boolean {
  try {
    execFileSync("git", ["worktree", "unlock", worktreePath], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Already unlocked (or not a registered worktree) — nothing to undo.
  }
  try {
    execFileSync("git", ["worktree", "remove", "--force", "--force", worktreePath], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best-effort: if the worktree is already gone, ignore.
  }
  return !existsSync(worktreePath);
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

  forceRemoveWorktree(projectDir, worktreePath);

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
 *  Called by dispatchSingleStep after checkResultPersistence passes, before
 *  markTaskComplete. Returns ok:false on any failure (non-ff, conflict, git
 *  error) — the caller must failTask and retain the worktree for inspection.
 *
 *  Contract: agents are expected to commit their work on the task branch. As a
 *  safety net, this function auto-stages and commits any uncommitted changes in
 *  the worktree before merging. If the worktree has no changes, the commit is
 *  skipped entirely. If the commit fails with changes present (hook, missing
 *  identity, lock file), ok:false is returned — the caller must retain the
 *  worktree. If the merge is a clean no-op, it succeeds silently.
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
  if (!forceRemoveWorktree(projectDir, path)) {
    // Removal failed (e.g., directory exists but was never registered) — prune
    // stale entries to keep the repo worktree list clean.
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* fully best-effort */ }
  }
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
//   • PRIVATE `--shared` CLONE — mutating agents, being built in FG-621. NOT a
//     registered worktree: `git worktree remove` does not apply to it and
//     `git worktree list` never shows it. Reaping one is a directory removal plus
//     disposal of its private refs, and its alternates point back into the parent
//     object store — so it must not be removed while the parent is mid-`gc`.
//     FG-621 owns that; this reaper's clone branch is an EXPLICIT, TESTED no-op.
//
// The substrate is read off the workspace itself rather than a column, so it is
// right for both the trees forge creates today and the clones FG-621 will add. It
// doubles as the safety catch that matters most: a main checkout (the operator's
// live source) has a `.git` DIRECTORY, so it can never classify as a linked
// worktree and can never be removed here.
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
  /** FG-621's substrate; reaping it is not implemented here (see the header). */
  | "private_clone_substrate"
  /** A directory we cannot identify as either substrate — never guessed at. */
  | "unknown_substrate"
  /** git refused the removal even after unlock + double force. */
  | "removal_failed";

export type WorkspaceReapOutcome =
  | { action: "absent"; branch: string }
  | { action: "reaped"; substrate: "linked_worktree"; branch: string; branchRemoved: boolean }
  | {
      action: "retained";
      substrate: WorkspaceSubstrate;
      branch: string;
      reason: WorkspaceRetainReason;
      details: string[];
    };

/** `git status --porcelain --ignored` inside the workspace. undefined when git
 *  could not answer at all — indistinguishable from "there may be work here", so
 *  callers treat it as unsafe rather than clean.
 *
 *  `--ignored` because an agent's output frequently lands on paths the project
 *  ignores (build artifacts, scratch dirs, logs). Those files exist nowhere but
 *  this workspace, so a tracked-clean tree holding only ignored output is NOT
 *  proof of capture — probing without it would force-remove unrecovered work. */
function uncommittedFiles(workspacePath: string): string[] | undefined {
  try {
    return execFileSync("git", ["status", "--porcelain", "--ignored"], {
      cwd: workspacePath,
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

/** Dispose of a task's workspace and its branch — but ONLY once the work inside
 *  is provably captured. Never throws; reaping an already-gone workspace is a
 *  no-op, so repeated calls are safe.
 *
 *  Safe means all of: the substrate is a linked worktree, the tree is clean (no
 *  uncommitted, untracked or ignored files), and every commit the task's branch/HEAD
 *  points at is reachable from projectDir's HEAD. Anything else — including
 *  anything git declines to answer — is RETAINED with the reason, so the caller
 *  can record where the work still lives. */
export function reapTaskWorkspace(
  workspacePath: string,
  runId: string,
  taskId: string,
  projectDir: string
): WorkspaceReapOutcome {
  const branch = worktreeBranchName(runId, taskId);
  const substrate = classifyWorkspace(workspacePath);

  if (substrate === "absent") return { action: "absent", branch };
  if (substrate === "private_clone") {
    // FG-621 owns clone reaping (see the header): a clone is not a registered
    // worktree, and its removal has to sequence against the parent's object
    // store. Explicit no-op — never a silent fall-through.
    return { action: "retained", substrate, branch, reason: "private_clone_substrate", details: [] };
  }
  if (substrate === "unknown") {
    return { action: "retained", substrate, branch, reason: "unknown_substrate", details: [] };
  }

  const dirty = uncommittedFiles(workspacePath);
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
  const uncaptured = tips.filter((c) => !isAncestorOfHead(projectDir, c));
  if (tips.length === 0 || uncaptured.length > 0) {
    return {
      action: "retained",
      substrate,
      branch,
      reason: "unmerged_commits",
      details: tips.length === 0 ? ["the workspace's history could not be resolved"] : uncaptured,
    };
  }

  if (!forceRemoveWorktree(projectDir, workspacePath)) {
    return { action: "retained", substrate, branch, reason: "removal_failed", details: [] };
  }

  // -d, not -D: the branch is provably merged into HEAD by the check above, so
  // git's own merged-only guard should agree. It is a second opinion on the one
  // irreversible step, and a disagreement leaves the ref rather than forcing it.
  let branchRemoved = false;
  try {
    execFileSync("git", ["branch", "-d", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    branchRemoved = true;
  } catch {
    branchRemoved = resolveCommit(projectDir, branch) === undefined;
  }
  return { action: "reaped", substrate, branch, branchRemoved };
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
 *  Same no-discard contract as mergeWorktreeBranch (FG-352): auto-stages and
 *  commits any uncommitted changes in the child worktree before merging.
 *  Changes present + commit fails => ok:false (caller retains child worktree).
 *  Uses --no-ff so each child gets an explicit merge commit on the integration branch.
 *
 *  Call in child INDEX order for deterministic history. */
export function mergeChildIntoIntegration(
  integrationWorktreePath: string,
  runId: string,
  childTaskId: string,
  childWorktreePath: string
): MergeWorktreeBranchResult {
  const branch = worktreeBranchName(runId, childTaskId);

  let statusOut = "";
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

  if (statusOut.trim().length > 0) {
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
