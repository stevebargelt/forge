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
//
// FG-345: isolation is the DEFAULT, not an opt-in. See isWorktreeModeEnabled().

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { findGitRoot } from "../util/git-root.js";
// FG-693 (step 11): the ONE filesystem-identity contract. This module holds
// forge's most destructive operations — it removes whole working trees — so
// every path comparison here is the ACTING class: it acts only on a PROVEN
// identity and refuses on anything less. See src/util/path-identity.ts.
import { compareIdentity, describeIdentity, identify, provenPhysical } from "../util/path-identity.js";
import { createDependencyMountpoints } from "./dependency-provisioning.js";
import { provisionWorkspaceCommitMsgHook } from "../util/commit-msg-hook.js";
import { WORKTREES_DIR, cloneDir, worktreeDir, integrationWorktreeDir } from "../util/paths.js";

// ── Branch naming ─────────────────────────────────────────────────────────────

/** Deterministic branch name for a task worktree. Derived from task metadata;
 *  never stored — any caller can re-derive it. */
export function worktreeBranchName(runId: string, taskId: string): string {
  return `forge/${runId}/${taskId}`;
}

// ── Feature gate ──────────────────────────────────────────────────────────────

/** FG-345: workspace isolation is ON by default. Resolution order:
 *
 *    1. FORGE_NO_WORKTREES=1  → off. The legacy escape hatch; highest precedence.
 *    2. FORGE_WORKTREES set   → honored explicitly ("1" on, anything else off).
 *    3. neither set           → the PLATFORM default: on for darwin, off elsewhere.
 *
 *  Rule 3 is platform-aware rather than a bare `true` because preflightWorktreeGate
 *  hard-fails on Linux and that gate is permanent by design (DEC-004: the
 *  orchestrator runs on a macOS host; "Linux" in these gates means the agent
 *  CONTAINER). A bare `true` would arm worktree mode on a Linux host and then throw
 *  on every dispatch. A non-darwin host therefore keeps the shared bind-mount path
 *  exactly as it behaved before this change. An explicit FORGE_WORKTREES=1 still
 *  force-enables everywhere — and still hits the Linux gate loudly, which is the
 *  documented behavior and unchanged.
 *
 *  Rule 2 honors an explicit OFF ("0"), which is what lets `src/test-setup.ts` pin
 *  the suite to a host-independent value while a test that assigns "1" still wins.
 *
 *  THE WORKSPACE CONTRACT (FG-345 operator decision, 2026-07-28). A task workspace
 *  is committed tracked content at the recorded base SHA, plus inputs explicitly
 *  supplied through Forge's own provisioning or environment mechanisms. Ambient
 *  local checkout state — uncommitted, untracked, ignored — is intentionally NOT
 *  inherited; that is the contract, not a gap in it. FORGE_NO_WORKTREES=1 is the
 *  supported escape for a workflow that needs the shared checkout.
 *
 *  When this returns false, callers must skip preflightWorktreeGate, createWorktree,
 *  and setTaskWorktreePath — the bind-mount path is preserved exactly as it was
 *  before FG-351. */
export function isWorktreeModeEnabled(): boolean {
  if (process.env.FORGE_NO_WORKTREES === "1") return false;
  const explicit = process.env.FORGE_WORKTREES;
  if (explicit !== undefined) return explicit === "1";
  return process.platform === "darwin";
}

// ── Preflight gate ────────────────────────────────────────────────────────────

/** Run ALL gate checks BEFORE any state mutation. Throws on any violation.
 *
 * Gates (in order):
 *   1. Platform: macOS only. The Linux hard-fail is PERMANENT by design, not
 *      pending work — see the gate below.
 *   2. Git: projectDir must be inside a git repo (findGitRoot two-step).
 *   3. Dirty: tracked tree must be clean unless FORGE_WORKTREE_IGNORE_DIRTY=1.
 *
 * These gates are unconditional — FORGE_NO_WORKTREES does NOT bypass them.
 * The kill switch works at the isWorktreeModeEnabled() level: when it returns
 * false, the caller skips this function entirely and preflightWorktreeGate is
 * never reached.
 *
 * Gate 3 is where the FG-345 workspace contract bites: the agent gets the
 * committed snapshot at the recorded base SHA, so a dirty tracked tree makes the
 * workspace stale by construction. Ambient uncommitted/untracked/ignored state is
 * not inherited, by decision — see isWorktreeModeEnabled() for the full contract.
 */
export function preflightWorktreeGate(projectDir: string): void {
  // 1. Platform gate — Linux is hard-fail, PERMANENTLY. Forge's orchestrator runs
  //    on a macOS host (DEC-004) and "Linux" here can only mean the agent
  //    container, so a Linux HOST is out of scope rather than unfinished: FG-358
  //    was closed out-of-scope in 6c0a1a6 and nothing succeeds it. The platform
  //    default in isWorktreeModeEnabled() resolves OFF on non-darwin, so a Linux
  //    host never reaches this gate by accident — arriving here means someone set
  //    FORGE_WORKTREES=1 explicitly, and that should fail loudly.
  if (process.platform === "linux") {
    throw new Error(
      "worktree mode is not supported on Linux (node_modules bind-mount gap). Linux hosts are " +
        "permanently out of scope — forge's orchestrator is macOS-only. " +
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

// ── FG-693: the identity precondition on every removal ────────────────────────

/** Why this workspace path may NOT be removed — empty when removal is
 *  identity-safe. The FIRST question asked on every disposal path in this
 *  module, before any of the git-level ownership or capture proofs.
 *
 *  WHAT IT ADDS that the ownership proofs do not. Those proofs ask git about the
 *  workspace: which repository it belongs to, which branch it has checked out,
 *  whose object store it borrows. Every one of them takes the recorded path at
 *  face value as a NAME. None of them asks the prior question — is the tree
 *  about to be deleted the very tree forge is deleting it FROM? A recorded
 *  worktree path that is another spelling of run.projectDir (a symlinked parent,
 *  a system directory exposed under two prefixes, a relative spelling, a
 *  trailing separator) names the operator's live source checkout, and the answer
 *  is decided by the SPELLINGS, not by the trees.
 *
 *  In practice the clone branch's alternates proof already refuses the exact
 *  same-string case (a repository is never its own alternate — FG-621). This
 *  guard is deliberately EARLIER, BROADER and NOT git-dependent: it holds on the
 *  linked-worktree branch too, it holds when git cannot answer at all, and it
 *  holds for a spelling the alternates proof would have had to resolve
 *  correctly in order to refuse. Defence in depth on the one irreversible step,
 *  which is what "the most destructive consumers" earns.
 *
 *  ACTING class, so INDETERMINATE REFUSES: a path the filesystem will not answer
 *  for is not proof of a separate tree, and the cost of the two mistakes is not
 *  symmetric — refusing leaks a directory a later pass can still reap, while
 *  proceeding can delete an operator's working tree with no way back. */
function notProvenDistinctFromProject(workspacePath: string, projectDir: string): string[] {
  const workspace = identify(workspacePath);
  const project = identify(projectDir);
  switch (compareIdentity(workspace, project)) {
    case "different":
      return [];
    case "same":
      return [
        `workspace ${workspace.asWritten} and the project directory ${project.asWritten} are ONE tree ` +
          `(${describeIdentity(workspace)}) spelled two different ways — removing it would delete the project checkout itself`,
      ];
    default: {
      const details: string[] = [];
      if (workspace.kind !== "resolved") details.push(`workspace path ${describeIdentity(workspace)}`);
      if (project.kind !== "resolved") details.push(`project directory ${describeIdentity(project)}`);
      return [
        `could not prove the workspace is a different tree from the project directory (${details.join("; ")}) — ` +
          "an unproven identity never authorizes a removal",
      ];
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
  /** FG-693: present only when a tree that IS THERE was left in place because its
   *  identity could not be proven distinct from projectDir. Absent on every
   *  ordinary outcome, INCLUDING the already-gone one: nothing was refused there,
   *  because there was no tree to refuse. A caller whose own next step is
   *  destructive (a branch or ref deletion that only the removal justifies) must
   *  take the SAME decision from it — see cleanupIntegrationWorktree. */
  declined?: string[];
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
 *  Best-effort and never throws: an already-gone worktree is a no-op.
 *
 *  FG-693: the identity precondition lives HERE, on the primitive, not at each
 *  call site. It was applied at the task-worktree disposals and missed at all
 *  three integration-worktree ones (create-retry, re-materialization, post-merge
 *  cleanup), which is the failure mode a per-call-site guard has: the next
 *  destructive consumer added is the one nobody remembers to guard. `git worktree
 *  remove --force --force` on a path that is another spelling of projectDir
 *  deletes the operator's checkout whenever that checkout is itself a linked
 *  worktree (git only refuses the MAIN one), so an unproven match must abstain. */
export function forceRemoveWorktree(
  projectDir: string,
  worktreePath: string
): ForceRemoveWorktreeResult {
  const notDistinct = notProvenDistinctFromProject(worktreePath, projectDir);
  if (notDistinct.length > 0) {
    // A path the filesystem will not answer for has NO TREE to delete, so nothing
    // is refused there and the registration hygiene below is still owed — `git
    // worktree prune` only ever drops entries whose working tree is already
    // missing, so it can neither delete a tree nor widen what is disposed of.
    if (identify(worktreePath).kind !== "resolved") {
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: projectDir,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch { /* fully best-effort */ }
      return { gitRemoved: false, pathAbsent: !existsSync(worktreePath) };
    }
    return { gitRemoved: false, pathAbsent: false, declined: notDistinct };
  }

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
 */
export function createWorktree(
  projectDir: string,
  runId: string,
  taskId: string
): CreateWorktreeResult {
  const worktreePath = worktreeDir(runId, taskId);
  const branch = worktreeBranchName(runId, taskId);

  // Ensure the parent directory exists under WORKTREES_DIR.
  mkdirSync(join(WORKTREES_DIR, runId), { recursive: true });

  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  createDependencyMountpoints(worktreePath);

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
  // FG-685: the OTHER thing a fresh clone inherits none of — the source repo's
  // hooks. Installed at the same moment, and for the same reason, as the identity
  // above: the substrate that took it away is what has to hand it back, before
  // the container can reach the workspace. Provisioning then PROVES the hook will
  // run (self-contained regular file, executable, bundled bytes, at a hooks
  // directory pinned in the clone's OWN config so the pin travels with the
  // workspace across the container mount instead of depending on the image's git
  // configuration); anything else refuses the clone by a named error rather than
  // yielding a workspace whose guard silently never fires.
  //
  // THREAT MODEL (FG-685 D4), so nobody later reads more into this than it is:
  // it defends against the DEFAULT attribution behavior of a COOPERATING agent —
  // exactly the FG-610 failure, where a Co-Authored-By trailer reached the
  // publish HEAD and the remedy (a history rewrite) orphaned the pipeline's
  // task-branch lineage. It defends against nothing adversarial: `git commit
  // --no-verify` bypasses it (the hook's own text says so) and the agent is root
  // in its own container. This is a LAYERED MITIGATION, not a kernel-enforced
  // boundary — the read-only parent-object mount is a boundary; this is not, and
  // must never be described or relied on as one.
  provisionWorkspaceCommitMsgHook(clonePath);

  execFileSync("git", ["checkout", "--quiet", "-b", branch, baseSha], {
    cwd: clonePath,
    stdio: ["ignore", "ignore", "pipe"],
  });

  createDependencyMountpoints(clonePath);

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
  // FG-693: same precondition as cleanupFailedWorktreeSetup — an unconditional
  // rmSync must first prove the path is not the project checkout under another
  // spelling. A clone forge cannot prove distinct is left in place; the safe side.
  //
  // ONE decision, governing BOTH halves. The workspace removal and the anchor
  // deletion rest on the identical premise — that everything this function finds
  // was made by the attempt that is now failing — and that premise is false exactly
  // when `path` is not the clone. Refusing the removal while force-deleting the
  // branch anyway would preserve the redirected checkout and destroy the task's only
  // durable parent-side record, which is the worse half of the pair to get wrong.
  // createTaskClone writes the anchor LAST, after the clone directory exists, so a
  // path that does not resolve at all had no anchor to leak either.
  if (notProvenDistinctFromProject(path, projectDir).length > 0) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort: a clone we cannot remove is retained, which is the safe side.
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
      // FG-685 D2: --no-verify. Forge is a CO-TENANT of the clone it hooked in
      // createTaskClone, and the constraint governs AGENT-authored messages;
      // this one is a Forge-authored fixed string. Running it through a shell
      // script would convert any hook failure — a userland regex quirk, a
      // missing interpreter, an agent that replaced the hook — into
      // safety_commit_failed, which aborts capture BEFORE the branch is fetched
      // into the parent and therefore loses the agent's work outright.
      execFileSync(
        "git",
        [...FORGE_IDENTITY, "commit", "--no-verify", "-m", `forge: safety-commit task ${taskId} output`],
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

/** What removeWorktreeIfSafe actually did, and — when it declined — why.
 *
 *  FG-693 widened this from `void`. The dispatch-path disposal had exactly one
 *  observable behaviour (the directory is gone, or it is not) and several silent
 *  early returns that were indistinguishable from each other, so a refusal driven
 *  by an identity it could not prove would have looked identical to the ordinary
 *  "not eligible yet" no-op. A declining destructive path must say why it
 *  declined. Existing callers ignore the value and are unaffected. */
export type WorktreeRemovalOutcome = {
  /** True only when this call left the workspace directory gone. */
  readonly removed: boolean;
  readonly reason:
    | "removed"
    /** Neither EPHEMERAL mode nor a proven merge-back — the no-discard invariant. */
    | "not_eligible"
    | "absent"
    /** FG-693: the workspace could not be proven to be a different tree from
     *  projectDir. Either it IS the project checkout under another spelling, or
     *  the filesystem would not answer for one of the two. */
    | "identity_not_proven_distinct"
    /** The clone's alternates do not resolve to the project's object store. */
    | "workspace_not_owned"
    | "removal_failed";
  readonly details: string[];
};

/** Remove a task worktree and its branch when doing so is SAFE.
 *
 *  Safe to remove under two conditions:
 *    1. Ephemeral/test mode (FORGE_WORKTREES_EPHEMERAL=1) — no real output at risk.
 *    2. provenMerged=true (FG-352) — merge-back succeeded; projectDir has the changes.
 *
 *  No-discard invariant: never remove an unmerged worktree outside EPHEMERAL mode.
 *  Callers must NOT pass provenMerged=true unless the merge already succeeded.
 *
 *  FG-693: and never remove a workspace that is not PROVEN to be a different tree
 *  from projectDir — see notProvenDistinctFromProject.
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
): WorktreeRemovalOutcome {
  // Only remove in ephemeral test mode OR after a proven merge-back (FG-352).
  if (process.env.FORGE_WORKTREES_EPHEMERAL !== "1" && !provenMerged) {
    return { removed: false, reason: "not_eligible", details: [] };
  }

  if (!existsSync(worktreePath)) return { removed: false, reason: "absent", details: [] };

  // FG-693: FIRST, and before anything reads git. The two proofs below both take
  // the recorded path as a name; this is the one that asks whether the name is
  // the project checkout wearing another spelling.
  const notDistinct = notProvenDistinctFromProject(worktreePath, projectDir);
  if (notDistinct.length > 0) {
    return { removed: false, reason: "identity_not_proven_distinct", details: notDistinct };
  }

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
    const notOurs = cloneOwnershipMismatch(worktreePath, projectDir, branch);
    if (notOurs.length > 0) return { removed: false, reason: "workspace_not_owned", details: notOurs };
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      return { removed: false, reason: "removal_failed", details: [] };
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

  // The directory is what decides — `git worktree remove` can decline while the
  // tree turns out to be gone anyway, and vice versa.
  return existsSync(worktreePath)
    ? { removed: false, reason: "removal_failed", details: [] }
    : { removed: true, reason: "removed", details: [] };
}

// ── Merge-back ────────────────────────────────────────────────────────────────

export type MergeWorktreeBranchResult =
  | { ok: true }
  /** FG-584 (AC8/D2): `conflictPaths` carries the paths git left in the UNMERGED
   *  index, read BEFORE the merge is aborted (aborting clears them). Present only
   *  for a genuine textual conflict — an auto-commit or plumbing failure has no
   *  conflicting paths and omits the field rather than reporting an empty set as
   *  if it had looked and found none. */
  | { ok: false; error: string; conflictPaths?: string[] };

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
  // FG-693: "the agent never ran, so there is nothing to preserve" is an argument
  // about the WORKSPACE. It says nothing if the path does not name the workspace
  // — a WORKTREES_DIR reached through a symlinked parent that lands in the
  // project checkout would make this an unconditional rm of the operator's tree.
  // Cheap to prove, and this path is deliberately un-gated otherwise.
  if (notProvenDistinctFromProject(path, projectDir).length > 0) return;
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
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  // FG-693: the PROVEN physical path or nothing. This value is compared for
  // equality by both ownership proofs below, so a lexical guess in its place
  // would let two spellings of one git dir read as different repositories —
  // and, worse, let an unresolvable one read as a resolved path.
  return out ? (provenPhysical(resolve(cwd, out)) ?? undefined) : undefined;
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
    // FG-693: an alternate that does not resolve has no proven identity, so it
    // cannot match the parent's object store. Record the spelling VERBATIM and
    // let the comparison below refuse it — the one place a raw spelling appears
    // here, and it is on the side that is guaranteed to fail the check.
    entries.push(provenPhysical(resolve(commonGitDir, "objects", entry)) ?? entry);
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
  const parentObjects = provenPhysical(join(projectRepo, "objects"));
  if (parentObjects === null) {
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
 *  Safe means all of: the workspace is PROVEN to be a different tree from
 *  projectDir (FG-693 — asked first, and of the filesystem rather than of git),
 *  it is one of the two substrates forge creates and
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

  // FG-693: the identity precondition, ahead of every substrate branch and ahead
  // of every git-level proof. Deliberately NOT inside the two ownership helpers:
  // they answer "whose repository is this?" from git, which is a question about a
  // path that has already been accepted as naming some OTHER tree. This asks
  // whether it names THIS one. Reported as `workspace_not_owned` — the existing
  // reason for "not THIS task's workspace", so the published retain-reason enum
  // (docs/SCHEMA-CONTRACT.md, and every historical event carrying these values)
  // is untouched — with details that name the identity failure specifically.
  const notDistinct = notProvenDistinctFromProject(workspacePath, projectDir);
  if (notDistinct.length > 0) {
    return { action: "retained", substrate, branch, reason: "workspace_not_owned", details: notDistinct };
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

/** The integration branch's current tip, or undefined if the branch does not
 *  exist. FG-584: the ORDERED fan-out's candidate is this branch, built up as
 *  items land, so its tip is the base the next dependency group is provisioned
 *  from — and it is read back off the ref rather than carried in memory, so the
 *  same answer is available to any process before and after a crash. */
export function integrationBranchTip(
  projectDir: string,
  runId: string,
  parentTaskId: string
): string | undefined {
  return resolveCommit(projectDir, integrationBranchName(runId, parentTaskId));
}

/** A captured task branch's tip in THIS repository's ref namespace, or undefined
 *  if it does not resolve. FG-584: this is the exact commit a prerequisite's
 *  integration has to be proven against — never the child's self-reported
 *  completion (AC3). */
export function capturedBranchTip(
  projectDir: string,
  runId: string,
  taskId: string
): string | undefined {
  return resolveCommit(projectDir, worktreeBranchName(runId, taskId));
}

/** FG-584 (AC3): is `commit` durably contained in `ref`'s history?
 *
 *  THE READINESS PREDICATE, and deliberately nothing more than git ancestry. It
 *  is self-verifying (the object graph IS the evidence), needs no new table, and
 *  gives the same answer to any process before and after a crash — which is what
 *  lets ordered dispatch be resumed rather than replayed. A child row that says
 *  `complete` proves only that a container exited; this proves the work is in the
 *  tree the dependent will receive.
 *
 *  Unresolvable arguments answer `false`. "I could not prove it is integrated" and
 *  "it is not integrated" must land in the same place here: the failure mode this
 *  guards is dispatching a dependent onto a base that lacks its prerequisite. */
export function isCommitIntegrated(projectDir: string, commit: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
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
 *  never has agent output to preserve (unlike child worktrees).
 *
 *  FG-584: `baseSha` pins the branch's starting commit. Omitted, the branch is cut
 *  from the repository's checked-out HEAD, which is the pre-FG-584 behavior and
 *  stays byte-for-byte what an unordered wave gets. The ORDERED path passes the
 *  base it RESOLVED (resolveTaskBaseSha's recorded receipt) so the candidate and
 *  the wave's first group start from provably the same commit — a candidate cut
 *  from HEAD while the recorded base said otherwise would silently publish work
 *  built on a different tree than the one the workers saw. */
export function createIntegrationWorktree(
  projectDir: string,
  runId: string,
  parentTaskId: string,
  baseSha?: string
): { integrationPath: string } {
  const integrationPath = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);

  if (integrationBranchExists(projectDir, runId, parentTaskId)) {
    // FG-693: the prune and the branch deletion are ONE decision. "A stale
    // integration worktree is always from an aborted prior attempt" is an argument
    // about a path that names the integration tree; a path that is another spelling
    // of the project checkout is not that, and force-deleting the branch after the
    // removal already refused would leave the destructive half acting on exactly
    // the premise the safe half rejected.
    const removal = forceRemoveWorktree(projectDir, integrationPath);
    if (removal.declined) {
      throw new Error(
        `refusing to prune the integration workspace ${integrationPath}: ${removal.declined.join("; ")}`
      );
    }
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* best-effort */ }
  }

  mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });

  execFileSync(
    "git",
    ["worktree", "add", integrationPath, "-b", branch, ...(baseSha ? [baseSha] : [])],
    { cwd: projectDir, stdio: ["ignore", "ignore", "pipe"] }
  );

  return { integrationPath };
}

/** FG-584: the ref naming the last candidate that PASSED the D1 integration gate.
 *
 *  Deliberately a REF and not a table or an event. The question a dependent has to
 *  answer before it is provisioned is "is my prerequisite's commit in a tree that
 *  was merged AND proven to build?", and against this ref that whole question is
 *  one ancestry check on the object graph: self-verifying, idempotent to re-ask,
 *  identical before and after a crash, and readable by any process without a
 *  handshake with the one that recorded it. An in-memory accumulator owned by a
 *  single dispatchFanoutStep invocation could answer it only for that invocation. */
export function gatedCandidateRef(runId: string, parentTaskId: string): string {
  return `refs/forge/${runId}/${parentTaskId}/gated`;
}

/** Advance the gated-candidate ref to `sha` — the durable record that this exact
 *  candidate passed the gate. MONOTONIC in what it contains: every sha recorded
 *  here is a descendant of the last one, so each advance strictly contains every
 *  prerequisite the previous one did. The candidate branch is rewound exactly once
 *  per resume, and only back to the prerequisite-only view this ref is already an
 *  ancestor of (see rewindCandidateToPrerequisites). */
export function recordGatedCandidate(
  projectDir: string,
  runId: string,
  parentTaskId: string,
  sha: string
): void {
  execFileSync("git", ["update-ref", gatedCandidateRef(runId, parentTaskId), sha], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** The gated-candidate ref's current commit, or undefined when nothing has been
 *  gated yet. Undefined is a legitimate answer, not an error: before the first
 *  prerequisite group is gated, NO edge is satisfied — which is exactly right. */
export function gatedCandidateTip(
  projectDir: string,
  runId: string,
  parentTaskId: string
): string | undefined {
  return resolveCommit(projectDir, gatedCandidateRef(runId, parentTaskId));
}

/** FG-584 (AC4/AC9): the ref naming the candidate as it stood with PREREQUISITES
 *  ONLY — recorded immediately before the wave folds in its deferred leaves.
 *
 *  Mid-wave the candidate deliberately holds prerequisites and nothing else: an item
 *  nothing depends on is never provisioned FROM, so merging it early would put
 *  unrelated unpublished worker output into every later dependent's base and into
 *  the D1 gate that decides whether they may start. The fold at the end of the wave
 *  is what makes that a change of WHEN rather than WHETHER — and it is the one
 *  moment the candidate stops being prerequisite-only. A crash after it (and before
 *  the parent finalizes) leaves a candidate a RESUMED wave would otherwise re-gate
 *  and hand to a dependent, leaf and all. This ref is how a resuming process finds
 *  its way back to the same view a first pass had. */
export function prerequisiteCandidateRef(runId: string, parentTaskId: string): string {
  return `refs/forge/${runId}/${parentTaskId}/prerequisites`;
}

/** Record the candidate's prerequisite-only tip. Written before the first deferred
 *  leaf is folded in, so it is always a commit the gated ref is an ancestor of. */
export function recordPrerequisiteCandidate(
  projectDir: string,
  runId: string,
  parentTaskId: string,
  sha: string
): void {
  execFileSync("git", ["update-ref", prerequisiteCandidateRef(runId, parentTaskId), sha], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** FG-584 (AC4/AC9): rewind an ADOPTED candidate to its prerequisite-only view.
 *
 *  Called once, before a resumed wave re-enters its group loop, so that the sha it
 *  gates and the base it cuts dependents from are derived from the same view a first
 *  pass derived them from. Without it a resume re-gates the RAW tip — which after a
 *  crash mid-fold contains leaves — records that as the gated candidate, and cuts a
 *  dependent's workspace from it.
 *
 *  Bounded and reversible by construction: it only ever moves back to a commit the
 *  candidate already contains, and the only commits it discards are leaf merges,
 *  every one of which is re-derived from a durable captured branch at the end of the
 *  wave. Refuses anything else — an unresolvable ref, a tip that already IS the
 *  recorded view, or a recorded view that is not an ancestor of the tip (a candidate
 *  that has been re-cut under it) — because a rewind that is not a strict undo of
 *  the fold is not one this function can prove safe.
 *
 *  Returns the sha it rewound to, or undefined when it left the candidate alone. */
export function rewindCandidateToPrerequisites(
  projectDir: string,
  runId: string,
  parentTaskId: string,
  integrationPath: string
): string | undefined {
  const prereq = resolveCommit(projectDir, prerequisiteCandidateRef(runId, parentTaskId));
  const tip = integrationBranchTip(projectDir, runId, parentTaskId);
  if (prereq === undefined || tip === undefined || prereq === tip) return undefined;
  if (!isCommitIntegrated(projectDir, prereq, integrationBranchName(runId, parentTaskId))) return undefined;
  execFileSync("git", ["reset", "--hard", prereq], {
    cwd: integrationPath,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return prereq;
}

/** FG-584: OPEN the run's candidate, creating it only if it does not exist yet.
 *
 *  The ORDERED fan-out builds the FG-353 integration branch INCREMENTALLY — one
 *  worker+integration cycle per dependency group — so between groups that branch
 *  is not a leftover from an aborted attempt, it IS the wave's durable progress.
 *  createIntegrationWorktree's prune-then-create posture is right for the
 *  all-at-once wave it was written for and exactly wrong here: after a crash it
 *  would force-delete every merge already made and re-run prerequisites whose
 *  commits are already integrated, which is the duplication AC9 forbids.
 *
 *  So: an existing branch is ADOPTED, never pruned. Only its working tree is
 *  re-materialized when it has gone missing or drifted onto another ref — the
 *  tree is derivable from the branch, the branch is not derivable from anything.
 *  `baseSha` applies only to the create case. */
export function openIntegrationWorktree(
  projectDir: string,
  runId: string,
  parentTaskId: string,
  baseSha?: string
): { integrationPath: string; adopted: boolean } {
  const integrationPath = integrationWorktreeDir(runId, parentTaskId);
  const branch = integrationBranchName(runId, parentTaskId);

  if (resolveCommit(projectDir, branch) === undefined) {
    return { ...createIntegrationWorktree(projectDir, runId, parentTaskId, baseSha), adopted: false };
  }

  if (existsSync(integrationPath) && checkedOutRef(integrationPath) === `refs/heads/${branch}`) {
    return { integrationPath, adopted: true };
  }

  // FG-693: re-materializing over a tree whose identity is not proven distinct from
  // the project checkout would remove that checkout and put the integration branch
  // in its place. The removal refuses; so does the replacement it exists to enable.
  const removal = forceRemoveWorktree(projectDir, integrationPath);
  if (removal.declined) {
    throw new Error(
      `refusing to re-materialize the integration workspace ${integrationPath}: ${removal.declined.join("; ")}`
    );
  }
  mkdirSync(join(WORKTREES_DIR, runId, parentTaskId), { recursive: true });
  execFileSync("git", ["worktree", "add", integrationPath, branch], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { integrationPath, adopted: true };
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
    // FG-584 (AC8/D2): read the conflicting paths BEFORE aborting. `merge --abort`
    // clears the unmerged index, so a block recorded after it could only ever name
    // the worker and the candidate — never the paths, which is the one part of the
    // block an operator resolves against.
    const conflictPaths = unmergedPaths(integrationWorktreePath);
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
      ...(conflictPaths && conflictPaths.length > 0 ? { conflictPaths } : {}),
    };
  }
}

/** The paths git left UNMERGED in `treePath`'s index. Best-effort and read-only:
 *  undefined when the probe itself could not run, which is different from an empty
 *  list (a failure that produced no conflicting paths at all — a plumbing error
 *  rather than a textual conflict). */
function unmergedPaths(treePath: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: treePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return undefined;
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
  const removal = forceRemoveWorktree(projectDir, path);
  // FG-693: everything below is disposal of the same integration step, authorized by
  // the same premise — that `path` names the integration workspace and not the
  // project checkout under another spelling. Where the removal could not establish
  // that, the branch and the candidate refs stay too: a leaked ref is reclaimable by
  // a later pass, a deleted one is the only durable record of the wave's work.
  if (removal.declined) return;
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch { /* best-effort */ }
  // FG-584: the ordered wave's candidate refs go with the candidate they name.
  // Only reached after a PROVEN publication, so nothing is still deciding readiness
  // against the gated one or resuming against the prerequisite-only one.
  for (const ref of [gatedCandidateRef(runId, parentTaskId), prerequisiteCandidateRef(runId, parentTaskId)]) {
    try {
      execFileSync("git", ["update-ref", "-d", ref], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch { /* best-effort */ }
  }
}
