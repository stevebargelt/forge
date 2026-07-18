// Canonical repository identity for read models such as the dashboard project
// registry. Unlike v2/project-identity.ts (which intentionally identifies one
// physical publication checkout), this groups independent clones when durable
// Git evidence says they are checkouts of the same repository.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { derivePreferredRemoteIdentity, type GitRunner } from "./github-url.js";
import { findGitRoot } from "./git-root.js";

const defaultGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString();

export type RepositoryIdentitySource = "remote" | "git-common-dir" | "path";

export type RepositoryCheckoutIdentity = {
  key: string;
  source: RepositoryIdentitySource;
  checkoutRoot: string;
  exists: boolean;
  branch?: string;
  githubUrl?: string;
  remoteName?: string;
};

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function identityKey(source: RepositoryIdentitySource, evidence: string): string {
  return `repo-${createHash("sha256").update(`${source}:${evidence}`).digest("hex").slice(0, 20)}`;
}

function observedBranch(checkoutRoot: string, exists: boolean, git: GitRunner): string | undefined {
  if (!exists) return undefined;
  try {
    const branch = git(["-C", checkoutRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function gitCommonDir(checkoutRoot: string, git: GitRunner): string | undefined {
  try {
    const raw = git(["-C", checkoutRoot, "rev-parse", "--git-common-dir"]).trim();
    if (!raw) return undefined;
    return canonicalPath(isAbsolute(raw) ? raw : resolve(checkoutRoot, raw));
  } catch {
    return undefined;
  }
}

/** Resolve the strongest currently observable repository identity.
 *
 * Forge has no explicit stable repository-id field today, so the active order
 * begins at the preferred normalized remote. If no remote exists, linked
 * worktrees share their Git common dir. Genuinely local repositories fall back
 * to the canonical physical checkout path. Missing paths never claim a branch. */
export function repositoryCheckoutIdentity(
  projectDir: string,
  git: GitRunner = defaultGit,
): RepositoryCheckoutIdentity {
  const checkoutRoot = canonicalPath(findGitRoot(projectDir));
  const exists = existsSync(checkoutRoot);
  const branch = observedBranch(checkoutRoot, exists, git);
  const remote = exists ? derivePreferredRemoteIdentity(checkoutRoot, git) : undefined;
  if (remote) {
    const remoteName = remote.path.split("/").filter(Boolean).pop();
    return {
      key: identityKey("remote", remote.key),
      source: "remote",
      checkoutRoot,
      exists,
      ...(branch ? { branch } : {}),
      ...(remote.githubUrl ? { githubUrl: remote.githubUrl } : {}),
      ...(remoteName ? { remoteName } : {}),
    };
  }

  const commonDir = exists ? gitCommonDir(checkoutRoot, git) : undefined;
  if (commonDir) {
    return {
      key: identityKey("git-common-dir", commonDir),
      source: "git-common-dir",
      checkoutRoot,
      exists,
      ...(branch ? { branch } : {}),
    };
  }

  return {
    key: identityKey("path", checkoutRoot),
    source: "path",
    checkoutRoot,
    exists,
    ...(branch ? { branch } : {}),
  };
}
