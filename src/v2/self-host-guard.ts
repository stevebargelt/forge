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
// and worktree isolation is not armed.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { assetRoot } from "./asset-root.js";
import { isWorktreeModeEnabled } from "./worktree-lifecycle.js";

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

function refusalMessage(projectDir: string, sourceRoot: string): string {
  return (
    `forge: REFUSING to dispatch — self-host dispatch with worktree isolation off (FG-612).\n` +
    `  project:            ${canonical(projectDir)}\n` +
    `  forge source root:  ${canonical(sourceRoot)}  (the tree this forge is executing)\n` +
    `\n` +
    `Agents write into the shared project mount when worktree mode is off, and forge runs\n` +
    `src/ in-process (FG-569) — a half-written file is immediately live for every forge\n` +
    `process on this host.\n` +
    `\n` +
    remediation()
  );
}

const warned = new Set<string>();

/** Refuse a self-host dispatch unless worktree isolation is armed or the
 *  operator has explicitly acknowledged the shared checkout. Throws — callers
 *  must invoke this BEFORE any container starts and before any run/task row is
 *  written; after the first agent file lands the damage is already done.
 *
 *  Ordering note: isWorktreeModeEnabled() is false under FORGE_NO_WORKTREES=1,
 *  so the kill switch is checked on its own AFTER it — the override proceeds
 *  loudly rather than tripping the refusal it exists to bypass. */
export function assertSelfHostDispatchAllowed(projectDir: string, sourceRoot = forgeSourceRoot()): void {
  if (!isSelfHostDispatch(projectDir, sourceRoot)) return;
  if (isWorktreeModeEnabled()) return;

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

  throw new Error(refusalMessage(projectDir, sourceRoot));
}

/** Test-only: the once-per-project warning latch is process-global. */
export function _resetSelfHostWarnings(): void {
  warned.clear();
}
