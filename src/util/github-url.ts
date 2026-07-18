// FG-438: derive a project's canonical GitHub browser URL from its local git
// remotes. Pure URL parsing + a thin `git remote -v` reader (injectable for
// tests). No network, no GitHub API, no auth — just the remotes already on disk.

import { execFileSync } from "node:child_process";

export type GitRunner = (args: string[]) => string;
const defaultGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString();

export type NormalizedGitRemote = {
  /** Transport- and credential-independent repository identity. */
  key: string;
  host: string;
  path: string;
  githubUrl?: string;
};

/** Normalize a Git remote without retaining credentials or transport spelling.
 * GitHub SSH/HTTPS/git forms intentionally converge on the same host/path key.
 * Other network hosts are normalized conservatively: host casing and a trailing
 * `.git`/slash are ignored, while a non-default explicit port remains part of
 * the identity so unrelated self-hosted repositories are not collapsed. */
export function normalizeGitRemoteUrl(remoteUrl: string): NormalizedGitRemote | undefined {
  const raw = remoteUrl.trim();
  if (!raw) return undefined;

  let host: string;
  let port = "";
  let repoPath: string;

  const scp = !raw.includes("://") ? /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw) : null;
  if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
    host = scp[1]!.toLowerCase();
    repoPath = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
    repoPath = parsed.pathname;
  }

  const path = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!host || !path || !path.includes("/")) return undefined;

  const isGithub = host === "github.com";
  const keyHost = isGithub || !port ? host : `${host}:${port}`;
  const keyPath = isGithub ? path.toLowerCase() : path;
  return {
    key: `${keyHost}/${keyPath}`,
    host,
    path,
    ...(isGithub ? { githubUrl: `https://github.com/${path}` } : {}),
  };
}

/** Convert a single git remote URL to its canonical GitHub browser URL
 *  (`https://github.com/<owner>/<repo>`), or `undefined` when it is not a GitHub
 *  remote. Handles the SSH scp-form (`git@github.com:o/r`), `ssh://`, `git://`,
 *  and `http(s)://` transports, trims a trailing `.git` and slash. */
export function githubBrowserUrl(remoteUrl: string): string | undefined {
  return normalizeGitRemoteUrl(remoteUrl)?.githubUrl;
}

/** Read a project's git remotes as an ordered name→url map (first URL per remote
 *  name wins — `remote -v` lists fetch before push). Empty when the dir is not a
 *  git repo or has no remotes. */
function readRemotes(projectDir: string, git: GitRunner): Map<string, string> {
  const remotes = new Map<string, string>();
  let out: string;
  try {
    out = git(["-C", projectDir, "remote", "-v"]);
  } catch {
    return remotes; // not a git repo / git unavailable → no remotes
  }
  for (const line of out.split("\n")) {
    // "origin\tgit@github.com:o/r.git (fetch)"
    const m = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)/.exec(line.trim());
    if (m && !remotes.has(m[1]!)) remotes.set(m[1]!, m[2]!);
  }
  return remotes;
}

/** Preferred repository remote identity: `origin` when it is parseable,
 * otherwise the first parseable remote. This is the canonical grouping signal
 * used by the project registry; it deliberately supports non-GitHub hosts too. */
export function derivePreferredRemoteIdentity(
  projectDir: string,
  git: GitRunner = defaultGit,
): NormalizedGitRemote | undefined {
  const remotes = readRemotes(projectDir, git);
  const origin = remotes.get("origin");
  if (origin) {
    const normalized = normalizeGitRemoteUrl(origin);
    if (normalized) return normalized;
  }
  for (const url of remotes.values()) {
    const normalized = normalizeGitRemoteUrl(url);
    if (normalized) return normalized;
  }
  return undefined;
}

/** The project's canonical GitHub URL: prefer `origin` when it is a GitHub
 *  remote, else the first GitHub remote found (in `remote -v` order). Returns
 *  `undefined` when the dir has no git remotes or none are GitHub. `git` is
 *  injectable for tests. */
export function deriveGithubUrl(projectDir: string, git: GitRunner = defaultGit): string | undefined {
  const remotes = readRemotes(projectDir, git);
  const origin = remotes.get("origin");
  if (origin) {
    const fromOrigin = githubBrowserUrl(origin);
    if (fromOrigin) return fromOrigin;
  }
  for (const url of remotes.values()) {
    const derived = githubBrowserUrl(url);
    if (derived) return derived;
  }
  return undefined;
}
