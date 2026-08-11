// Canonical repository identity for read models such as the dashboard project
// registry. Unlike v2/project-identity.ts (which intentionally identifies one
// physical publication checkout), this groups independent clones when durable
// Git evidence says they are checkouts of the same repository.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { derivePreferredRemoteIdentity, type GitRunner } from "./github-url.js";
import { findGitRoot } from "./git-root.js";
import { identify, lexicalResolutionOf, provenPhysical } from "./path-identity.js";

const defaultGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString();

export type RepositoryIdentitySource = "remote" | "git-common-dir" | "path";

export type RepositoryCheckoutIdentity = {
  key: string;
  source: RepositoryIdentitySource;
  /** PROVEN physical identity of the checkout root when `exists` is true.
   *
   *  FG-693: when `exists` is FALSE nothing was proven, and this field carries
   *  the lexical spelling only so a read model can still label and group a row
   *  for a checkout that is gone. `exists` is the discriminator — this module
   *  modelled resolvability as a first-class field long before the contract
   *  existed, which is why it can keep one field instead of two. An unproven
   *  checkoutRoot must never be compared against a proven one to decide
   *  identity, authority, scope, liveness, cleanup or ownership; consumers that
   *  need that comparison call compareIdentity() in util/path-identity.ts. */
  checkoutRoot: string;
  /** True exactly when the filesystem resolved the checkout root — i.e. exactly
   *  when `checkoutRoot` is a proven physical path. */
  exists: boolean;
  branch?: string;
  githubUrl?: string;
  remoteName?: string;
};

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

/** The PROVEN physical git common dir, or undefined.
 *
 *  FG-693: a common dir the filesystem would not confirm yields undefined rather
 *  than a lexical guess, so an unproven path can never become the evidence a
 *  whole group of worktrees is keyed on. The caller then falls through to the
 *  path source, which carries `exists` alongside it. */
function gitCommonDir(checkoutRoot: string, git: GitRunner): string | undefined {
  try {
    const raw = git(["-C", checkoutRoot, "rev-parse", "--git-common-dir"]).trim();
    if (!raw) return undefined;
    return provenPhysical(isAbsolute(raw) ? raw : resolve(checkoutRoot, raw)) ?? undefined;
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
  // FG-693: the ONE canonicalization, via the shared contract. There is no
  // local realpath-with-lexical-fallback here any more — a fallback that
  // returned a lexical path in the resolved position is exactly what made an
  // unproven spelling indistinguishable from a proven one.
  const rootIdentity = identify(findGitRoot(projectDir));
  const exists = rootIdentity.kind === "resolved";
  // Unproven ⇒ the lexical spelling, reported ONLY under `exists: false`. The
  // key material below is unchanged by FG-693 on purpose: repo_evidence_key is
  // durable in the project registry, and re-deriving it would re-identify
  // existing projects — a data change this ticket is additive-only about.
  const checkoutRoot =
    rootIdentity.kind === "resolved" ? rootIdentity.physical : lexicalResolutionOf(rootIdentity);
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
