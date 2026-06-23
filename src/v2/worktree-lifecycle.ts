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

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findGitRoot } from "../util/git-root.js";
import { WORKTREES_DIR, worktreeDir } from "../util/paths.js";

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

  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best-effort: if the worktree is already gone, ignore.
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
 *  Called by dispatchSingleStep after checkResultPersistence passes, before
 *  markTaskComplete. Returns ok:false on any failure (non-ff, conflict, git
 *  error) — the caller must failTask and retain the worktree for inspection.
 *
 *  Contract: agents are expected to commit their work on the task branch. As a
 *  safety net, this function auto-stages and commits any uncommitted changes in
 *  the worktree before merging. If the agent already committed everything, the
 *  auto-commit is a no-op. If the merge is a clean no-op (no new commits on the
 *  branch), it succeeds silently ("Already up to date.").
 */
export function mergeWorktreeBranch(
  projectDir: string,
  worktreePath: string,
  runId: string,
  taskId: string
): MergeWorktreeBranchResult {
  const branch = worktreeBranchName(runId, taskId);

  // Auto-stage and commit any uncommitted changes. If the agent already
  // committed everything, `git commit` exits non-zero ("nothing to commit")
  // and we catch it. Untracked files (surfaced as diagnostic at createWorktree)
  // are included via `git add .` so new agent-created files are captured.
  try {
    execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `forge: auto-commit task ${taskId} output`], {
      cwd: worktreePath,
      stdio: "ignore",
    });
  } catch {
    // Nothing to commit (agent already committed), or commit failed (e.g. no
    // git identity set). Proceed: the branch tip is whatever the agent committed.
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
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // If git worktree remove fails (e.g., directory exists but was never
    // registered), prune stale entries to keep the repo worktree list clean.
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* fully best-effort */ }
  }
}
