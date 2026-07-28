// FG-612: forge-on-forge dispatch guard.
//
// Hit live 2026-07-24: `forge new feature --project <the forge checkout>` with
// FORGE_WORKTREES unset. Agents write into the shared bind-mount when worktree
// mode is off, and bin/forge execs node with tsx loaded in-process over src/
// (FG-569) — there is no meaningful dist/. So every half-written engineer file
// was IMMEDIATELY live for every forge process on the host, in every project.
// A concurrent orchestrator in another repo found `forge new` broken mid-write.
//
// The guard: refuse, pre-container and pre-row, when the project being
// dispatched against overlaps the source root of the forge that is executing
// and THIS dispatch provisions no isolated workspace. "This dispatch" is the
// load-bearing word — see DispatchIsolation.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { assetRoot } from "./asset-root.js";

/** Canonical path, tolerant of a path that does not exist yet (realpath throws
 *  there; existence is preflightProjectMount's job, not this guard's). Both
 *  sides of the comparison MUST go through here: the machine-wide `forge` is an
 *  npm-link symlink and macOS /var is a symlink to /private/var, so an
 *  un-canonicalized compare silently never matches — a guard that is inert is
 *  worse than no guard at all. */
function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The source root of the forge that is currently executing. Under a release
 *  that is the release tree; under a live checkout it is the checkout — the
 *  same answer assetRoot() gives for release-owned bytes, which is exactly the
 *  tree a dispatch must not be allowed to mutate underneath itself. */
export function forgeSourceRoot(): string {
  return canonical(assetRoot());
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Self-host means the mount and the executing forge's source tree overlap in
 *  EITHER direction: the project IS the source root, contains it (a parent-dir
 *  mount), or is a subdir of it (--allow-subproject). All three put agent
 *  writes inside the tree this process is running from. */
export function isSelfHostDispatch(projectDir: string, sourceRoot = forgeSourceRoot()): boolean {
  const project = canonical(projectDir);
  const root = canonical(sourceRoot);
  return contains(root, project) || contains(project, root);
}

/** What THIS dispatch does about isolation, stated by the caller. The guard must
 *  never derive it from isWorktreeModeEnabled(): since FG-345 that flag answers
 *  "is isolation the default on this host", which is a different question from
 *  "does this code path provision a workspace". Reading the first as the second
 *  is what let a self-host `forge invoke` onto the live checkout unrefused. */
export type DispatchIsolation =
  /** This dispatch provisions a task-scoped workspace; the agent never touches the live tree. */
  | "isolated"
  /** This path provisions one when worktree mode is armed — and it is not armed here. */
  | "not-armed"
  /** This path mounts the live project dir unconditionally, whatever the flag says. */
  | "never-isolated";

/** FG-345 made isolation default-on, which makes the remediation platform-specific:
 *  "set FORGE_WORKTREES=1" is only ever the fix on a host where the platform
 *  default is OFF and the worktree preflight would actually pass. */
function remediation(): string {
  if (process.platform === "darwin") {
    return (
      `Isolation is ON by default on this host (FG-345), so reaching this refusal means\n` +
      `FORGE_WORKTREES is explicitly set to a non-"1" value.\n` +
      `\n` +
      `  unset FORGE_WORKTREES  restore the default so agents work in a task-scoped workspace (the fix)\n` +
      `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
    );
  }
  if (process.platform === "linux") {
    return (
      `Isolation is off by default on a Linux host, and FORGE_WORKTREES=1 will NOT arm it here —\n` +
      `the worktree preflight hard-fails on Linux, permanently by design (forge's orchestrator is\n` +
      `macOS-only; "Linux" in those gates means the agent container).\n` +
      `\n` +
      `  dispatch against a CLONE of the forge checkout instead (the fix)\n` +
      `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
    );
  }
  return (
    `Isolation is off by default on this ${process.platform} host — the platform default is darwin-only.\n` +
    `\n` +
    `  FORGE_WORKTREES=1      arm worktree isolation so agents work in a task-scoped workspace (the fix)\n` +
    `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
  );
}

/** The no-isolation-on-this-path refusal. Naming FORGE_WORKTREES here would be
 *  actively wrong: arming it does not isolate an invoke, so an operator who
 *  followed that advice would land back on the live checkout believing they had
 *  fixed it. The token is deliberately absent from this message. */
function sharedCheckoutRemediation(): string {
  return (
    `\`forge invoke\` dispatches straight at the project mount — it provisions no task-scoped\n` +
    `workspace, so FG-345's default-on isolation does NOT cover this path (that guarantee is a\n` +
    `workflow-dispatch property). This refusal is structural, not a missing flag: arming worktree\n` +
    `isolation would not change what this dispatch mounts.\n` +
    `\n` +
    `  dispatch against a disposable CLONE of the forge checkout instead (the fix)\n` +
    `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
  );
}

function refusalMessage(projectDir: string, sourceRoot: string, isolation: DispatchIsolation): string {
  const headline =
    isolation === "never-isolated"
      ? `self-host dispatch on a path that provisions no isolated workspace (FG-612)`
      : `self-host dispatch with worktree isolation off (FG-612)`;
  return (
    `forge: REFUSING to dispatch — ${headline}.\n` +
    `  project:            ${canonical(projectDir)}\n` +
    `  forge source root:  ${canonical(sourceRoot)}  (the tree this forge is executing)\n` +
    `\n` +
    `Agents write into the shared project mount, and forge runs src/ in-process (FG-569) —\n` +
    `a half-written file is immediately live for every forge process on this host.\n` +
    `\n` +
    (isolation === "never-isolated" ? sharedCheckoutRemediation() : remediation())
  );
}

const warned = new Set<string>();

/** Refuse a self-host dispatch unless THIS dispatch actually provisions an
 *  isolated workspace, or the operator has explicitly acknowledged the shared
 *  checkout. Throws — callers must invoke this BEFORE any container starts and
 *  before any run/task row is written; after the first agent file lands the
 *  damage is already done.
 *
 *  `isolation` is the caller's, never inferred: workflow dispatch passes
 *  isWorktreeModeEnabled(), the invoke path passes "never-isolated" because it
 *  mounts args.projectDir whatever the flag resolves to.
 *
 *  Ordering note: the caller's isolation is "not-armed" under
 *  FORGE_NO_WORKTREES=1, so the kill switch is checked on its own AFTER it — the
 *  override proceeds loudly rather than tripping the refusal it exists to
 *  bypass. */
export function assertSelfHostDispatchAllowed(
  projectDir: string,
  isolation: DispatchIsolation,
  sourceRoot = forgeSourceRoot()
): void {
  if (!isSelfHostDispatch(projectDir, sourceRoot)) return;
  if (isolation === "isolated") return;

  if (process.env.FORGE_NO_WORKTREES === "1") {
    const key = canonical(projectDir);
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(
        `forge: WARNING — dispatching against the live forge source at ${key} with worktree isolation ` +
          `disabled (FORGE_NO_WORKTREES=1). Agents are writing to the source tree this forge is executing; ` +
          `partial writes are live for every forge process on this host. On a host where isolation is ` +
          `supported, unset FORGE_NO_WORKTREES (and any explicit FORGE_WORKTREES=0) to isolate instead.\n`
      );
    }
    return;
  }

  throw new Error(refusalMessage(projectDir, sourceRoot, isolation));
}

/** Test-only: the once-per-project warning latch is process-global. */
export function _resetSelfHostWarnings(): void {
  warned.clear();
}
