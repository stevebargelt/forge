// FG-685: the no-AI-attribution commit-msg hook as a WORKSPACE artifact.
//
// Two layers have to agree on one answer to "where are the hook bytes": the
// operator-facing installer (`forge init` / `forge upgrade`, src/cli) and the
// clone substrate that provisions a mutating agent's private workspace
// (src/v2/worktree-lifecycle.ts). The source resolution below is the single
// answer; it moved here verbatim from init.ts.
//
// The two installers are deliberately DIFFERENT mechanisms for the same policy:
//
//   • the operator's primary checkout gets a SYMLINK through $FORGE_HOME/current
//     (init.ts), so a promotion changes the enforced bytes without re-running
//     init. That is right for a checkout that lives on the host next to
//     $FORGE_HOME.
//   • a Forge-provisioned task clone gets the hook's BYTES as a regular file.
//     The agent runs against that workspace INSIDE a container where
//     $FORGE_HOME is not mounted, so a symlink out to the host dangles — and a
//     dangling commit-msg hook is reported by git as no hook at all, with no
//     diagnostic. Silent non-enforcement is the FG-685 defect itself, so the
//     artifact must be self-contained: a regular file, executable, no symlink,
//     no host path, no FORGE_HOME.
//
// Because the artifact is a copy rather than a link, OWNERSHIP is decided by
// CONTENT IDENTITY instead of link identity: bytes equal to the bundled hook are
// Forge's, anything else (a different regular file, ANY symlink, an unreadable
// target) is someone else's and is left untouched. That refuse-to-clobber
// behavior is what makes this installer safe to aim at a workspace that is not
// freshly created.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeIdentity, identify, provenSameOnly } from "./path-identity.js";

// ── The bundled hook source (moved verbatim from init.ts) ─────────────────────

// Candidate paths for the bundled commit-msg hook script. Same fileURLToPath
// walk-up pattern as readTemplate (works under tsx and the built dist).
function hookSourceCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "..", "..", "scripts", "git-hooks", "commit-msg-no-ai-attribution"),
    join(here, "..", "..", "..", "scripts", "git-hooks", "commit-msg-no-ai-attribution"),
  ];
}

/** Resolve the bundled commit-msg hook script, or undefined when it isn't found.
 *  Non-throwing so callers that only need the dev source as an OPTIONAL
 *  owned-target / dev-fallback can tolerate its absence (FG-582 FIX 4). */
export function tryResolveHookSource(): string | undefined {
  return hookSourceCandidates().find((c) => existsSync(c));
}

/** The dev-checkout hook source, required. Only a genuine dev-arm install with no
 *  resolvable source reaches this throw — the promoted arm never calls it. */
export function resolveHookSource(): string {
  const source = tryResolveHookSource();
  if (source) return source;
  throw new Error(
    `commit-msg hook source not found. Looked at:\n  ${hookSourceCandidates().join("\n  ")}`
  );
}

// ── The workspace installer (materializes the bytes) ─────────────────────────

/** The NAMED refusal a provisioner raises when it cannot prove the workspace it
 *  is about to hand an agent will actually refuse an AI-attribution commit.
 *
 *  Named, and greppable by `reason`, on purpose: the alternative to failing here
 *  is provisioning a workspace whose hook is absent, non-executable, or at a
 *  directory git will not consult — which is indistinguishable from success on
 *  the host and is exactly the defect FG-685 exists to remove. A rare loud
 *  dispatch failure is the better trade. */
export class CommitMsgHookUnenforceableError extends Error {
  readonly reason = "commit_msg_hook_unenforceable" as const;
  constructor(public readonly workspacePath: string, public readonly detail: string) {
    super(
      `refusing to provision ${workspacePath}: its no-AI-attribution commit-msg hook is not enforceable — ${detail}. ` +
        "A workspace whose hook silently never runs is the FG-685 defect; failing provisioning is deliberate."
    );
    this.name = "CommitMsgHookUnenforceableError";
  }
}

/** What the planner found at the hook target, carried into execute so it can
 *  re-verify nothing changed before it writes (the same AC-5 posture init.ts
 *  takes, with content identity in place of link identity). */
type ExpectedTargetState = "absent" | "forge-owned";

export type WorkspaceHookPlan =
  | { action: "install"; target: string; source: string; expect: ExpectedTargetState }
  | { action: "already-installed"; target: string }
  | { action: "exists-other"; target: string; details: string }
  | { action: "not-a-git-repo" };

type TargetState =
  | { kind: "absent" }
  | { kind: "forge-owned"; executable: boolean }
  | { kind: "other"; details: string };

/** Classify what sits at the hook target by lstat + bytes. lstat, never
 *  existsSync: existsSync follows a symlink and would read a dangling link — the
 *  precise failure this installer exists to avoid — as a healthy hook. */
function readTargetState(target: string, bundled: Buffer): TargetState {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) return { kind: "other", details: "symlink (never Forge-owned in a workspace)" };
  if (!st.isFile()) return { kind: "other", details: "not a regular file" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch {
    return { kind: "other", details: "unreadable" };
  }
  if (!bytes.equals(bundled)) return { kind: "other", details: "regular file (some other hook)" };
  return { kind: "forge-owned", executable: (st.mode & 0o111) !== 0 };
}

/** Decide what to do for a Forge-provisioned workspace's commit-msg hook without
 *  writing anything. Exported for testing.
 *
 *  `.git` must be a DIRECTORY. A linked worktree's `.git` is a file pointing at
 *  the parent's common dir, and writing hooks through it would write the PARENT
 *  repository's shared hooks directory — which FG-685 AC4 forbids (zero change
 *  to the operator's primary checkout). Such a workspace is reported
 *  not-a-git-repo here rather than silently redirected. */
export function planWorkspaceCommitMsgHook(workspacePath: string): WorkspaceHookPlan {
  const gitDir = join(workspacePath, ".git");
  let gitSt;
  try {
    gitSt = lstatSync(gitDir);
  } catch {
    return { action: "not-a-git-repo" };
  }
  if (!gitSt.isDirectory()) return { action: "not-a-git-repo" };

  const source = resolveHookSource();
  const target = join(gitDir, "hooks", "commit-msg");
  const state = readTargetState(target, readFileSync(source));

  switch (state.kind) {
    case "absent":
      return { action: "install", target, source, expect: "absent" };
    case "forge-owned":
      // Content proves ownership, so a stripped executable bit is ours to
      // repair — a mode-0644 commit-msg is a hook git silently never runs.
      return state.executable
        ? { action: "already-installed", target }
        : { action: "install", target, source, expect: "forge-owned" };
    case "other":
      return { action: "exists-other", target, details: state.details };
  }
}

export function executeWorkspaceCommitMsgHook(plan: WorkspaceHookPlan): string {
  switch (plan.action) {
    case "install": {
      const bundled = readFileSync(plan.source);
      // Between planning and here the target could have been replaced. Re-read
      // its identity and refuse to mutate unless it STILL matches what the
      // planner classified — never overwrite something we no longer own.
      const now = readTargetState(plan.target, bundled);
      if (now.kind !== plan.expect) return "skipped — changed since plan";
      mkdirSync(dirname(plan.target), { recursive: true });
      atomicWriteHook(plan.target, bundled);
      return `installed ${plan.target}`;
    }
    case "already-installed":
      return "already installed (no change)";
    case "exists-other":
      return `SKIPPED — existing hook (${plan.details}); leave it alone`;
    case "not-a-git-repo":
      return "skipped (not a workspace with its own .git directory)";
  }
}

/** Write the hook at a temp name in the SAME directory and rename() over the
 *  target — an atomic replace on one filesystem — so .git/hooks/commit-msg is
 *  never momentarily absent and a concurrent commit cannot slip through an
 *  unguarded window. chmod after write because writeFileSync's mode is masked by
 *  the process umask, and the executable bit is not optional here: git runs a
 *  non-executable hook not at all. */
function atomicWriteHook(target: string, bytes: Buffer): void {
  const tmp = join(dirname(target), `.commit-msg.forge-${process.pid}.tmp`);
  try {
    unlinkSync(tmp);
  } catch {
    /* no stale temp to clear */
  }
  writeFileSync(tmp, bytes, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
}

// ── The hooks-path pin (makes "git will consult it" structural) ───────────────

/** The pinned value. WORKSPACE-RELATIVE on purpose: the clone's host path is NOT
 *  the path it is mounted at inside the agent container, so an absolute pin would
 *  name a directory that does not exist there. Git resolves a relative
 *  core.hooksPath against the top of the working tree, which is the same
 *  directory on both sides of the mount. */
const PINNED_HOOKS_PATH = ".git/hooks";

function readLocalHooksPath(workspacePath: string): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["config", "--local", "--get-all", "core.hooksPath"], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined; // exit 1 = unset; anything else = not a repo we can read
  }
  // Multi-valued is legal in the file and git honors the LAST one, so that is
  // the value that decides where hooks come from.
  const values = out.split("\n").filter((v) => v.trim().length > 0);
  return values.at(-1)?.trim();
}

/** Pin the effective hooks directory in the workspace's OWN (--local) config.
 *
 *  Without this, "git will consult this directory" is only true because the agent
 *  image happens to carry no git configuration: core.hooksPath resolved on the
 *  HOST at provisioning time says nothing about what a global or system config
 *  inside the container resolves it to, and a base-image change that set one would
 *  silently un-enforce every provisioned clone. Local config outranks both global
 *  and system, and it lives inside the workspace, so the pin travels with the
 *  clone across the mount and the property becomes structural rather than
 *  contingent on the image.
 *
 *  Clone-scoped, so AC4 is untouched: this writes the workspace's own
 *  .git/config, never the operator checkout's shared one. Only ever called for a
 *  workspace whose `.git` is a DIRECTORY — a linked worktree's --local config IS
 *  the parent's shared config.
 *
 *  An existing value is left alone, the same refuse-to-clobber posture the file
 *  installer takes; assertWorkspaceHookEnforceable then refuses the workspace by
 *  name if it does not point at the hook we installed. */
function pinWorkspaceHooksPath(workspacePath: string): void {
  if (readLocalHooksPath(workspacePath) !== undefined) return;
  execFileSync("git", ["config", "--local", "core.hooksPath", PINNED_HOOKS_PATH], {
    cwd: workspacePath,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Prove — after installing — that this workspace will ACTUALLY refuse an
 *  AI-attribution commit message. Every check below is a way the guard can
 *  degrade to "no hook" with no diagnostic, which a bare existence check passes
 *  identically in the working and the silently-broken case:
 *
 *    • a symlink (dangles inside the container, where the host path is unmounted)
 *    • a non-executable mode (git skips it)
 *    • bytes that are not the bundled hook (a foreign or truncated script)
 *    • a core.hooksPath override moving the effective hooks dir out of the
 *      workspace (`git rev-parse --git-path hooks` honors it, so it is the check)
 *    • that same override arriving from the CONTAINER's global or system config
 *      instead of the host's, which the rev-parse above cannot see at all — so the
 *      workspace's own --local pin is checked directly, and checked for being
 *      relative, since an absolute pin names a host path the container has not got
 *
 *  Throws CommitMsgHookUnenforceableError. */
export function assertWorkspaceHookEnforceable(workspacePath: string): void {
  const target = join(workspacePath, ".git", "hooks", "commit-msg");
  const fail = (detail: string): never => {
    throw new CommitMsgHookUnenforceableError(workspacePath, detail);
  };

  let st;
  try {
    st = lstatSync(target);
  } catch {
    return fail(`no commit-msg hook at ${target}`);
  }
  if (st.isSymbolicLink()) {
    return fail(
      `${target} is a symlink; a workspace hook must be self-contained (a host path is not mounted in the agent container)`
    );
  }
  if (!st.isFile()) return fail(`${target} is not a regular file`);
  if ((st.mode & 0o111) === 0) return fail(`${target} is not executable (mode ${(st.mode & 0o777).toString(8)})`);

  let bundled: Buffer;
  try {
    bundled = readFileSync(resolveHookSource());
  } catch (e) {
    return fail(`the bundled hook source could not be read: ${String(e)}`);
  }
  if (!readFileSync(target).equals(bundled)) {
    return fail(`${target} is not the bundled no-AI-attribution hook (a foreign hook was left in place)`);
  }

  let hooksPath: string;
  try {
    hooksPath = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return fail(`could not resolve the effective hooks directory: ${String(e)}`);
  }
  const effective = resolve(workspacePath, hooksPath);
  const installed = dirname(target);
  // FG-693: one contract, and the ACTING-class projection — the permissive
  // outcome here is "these are the same directory, the hook git runs IS the hook
  // we installed", so an indeterminate comparison must NOT certify. Unresolved
  // is therefore a refusal, exactly as the old catch-returns-false was, but now
  // the message says which side would not resolve instead of naming a spelling
  // as though it were a directory that answered.
  const effectiveId = identify(effective);
  const installedId = identify(installed);
  if (!provenSameOnly(effectiveId, installedId)) {
    return fail(
      `git consults ${describeIdentity(effectiveId)} for hooks, not ${describeIdentity(installedId)} — a core.hooksPath override would make the guard never run`
    );
  }

  const pin = readLocalHooksPath(workspacePath);
  if (pin === undefined) {
    return fail(
      `core.hooksPath is not pinned in ${workspacePath}'s own --local config, so the effective hooks directory is decided by whatever global or system git config the agent container carries rather than by this workspace`
    );
  }
  if (isAbsolute(pin)) {
    return fail(
      `core.hooksPath is pinned to the absolute path ${pin}; the workspace is mounted at a different path inside the agent container, where that names something else or nothing at all`
    );
  }
  // FG-693: the pin and the installed hooks dir are the SAME QUESTION as the
  // rev-parse comparison above — "is this one directory?" — so they are answered
  // the same way. A lexical compare called two spellings of one directory
  // different and refused a workspace whose hook git would in fact have run; it
  // is also the shape that, elsewhere in forge, silently made guards inert.
  // provenSameOnly again: certifying is the permissive outcome.
  const pinned = resolve(workspacePath, pin);
  if (!provenSameOnly(pinned, installedId)) {
    return fail(
      `core.hooksPath is pinned to ${pin} (${describeIdentity(pinned)}), not to the installed hooks directory ${describeIdentity(installedId)}`
    );
  }
}

/** Install the hook into a Forge-PROVISIONED workspace and prove it will run.
 *  The one entry point provisioning calls: plan → execute → pin → assert, with
 *  every failure surfacing as CommitMsgHookUnenforceableError rather than as a
 *  quietly unguarded workspace. */
export function provisionWorkspaceCommitMsgHook(workspacePath: string): string {
  let outcome: string;
  try {
    const plan = planWorkspaceCommitMsgHook(workspacePath);
    outcome = executeWorkspaceCommitMsgHook(plan);
    if (plan.action === "install" || plan.action === "already-installed") {
      pinWorkspaceHooksPath(workspacePath);
    }
  } catch (e) {
    if (e instanceof CommitMsgHookUnenforceableError) throw e;
    throw new CommitMsgHookUnenforceableError(workspacePath, `installing the hook failed: ${String(e)}`);
  }
  assertWorkspaceHookEnforceable(workspacePath);
  return outcome;
}
