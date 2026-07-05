// FG-438: derive a project's canonical GitHub browser URL from its local git
// remotes. Pure URL parsing + a thin `git remote -v` reader (injectable for
// tests). No network, no GitHub API, no auth — just the remotes already on disk.

import { execFileSync } from "node:child_process";

export type GitRunner = (args: string[]) => string;
const defaultGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString();

/** Convert a single git remote URL to its canonical GitHub browser URL
 *  (`https://github.com/<owner>/<repo>`), or `undefined` when it is not a GitHub
 *  remote. Handles the SSH scp-form (`git@github.com:o/r`), `ssh://`, `git://`,
 *  and `http(s)://` transports, trims a trailing `.git` and slash. */
export function githubBrowserUrl(remoteUrl: string): string | undefined {
  const u = remoteUrl.trim();
  if (!u) return undefined;
  const patterns: RegExp[] = [
    /^git@github\.com:([^/]+)\/(.+)$/i,                       // git@github.com:owner/repo(.git)
    /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/(.+)$/i, // ssh://git@github.com[:port]/owner/repo
    /^git:\/\/github\.com\/([^/]+)\/(.+)$/i,                  // git://github.com/owner/repo
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+)$/i,   // http(s)://[user@]github.com/owner/repo
  ];
  for (const re of patterns) {
    const m = re.exec(u);
    if (m) {
      const owner = m[1];
      const repo = (m[2] ?? "").replace(/\.git$/i, "").replace(/\/+$/, "");
      if (owner && repo) return `https://github.com/${owner}/${repo}`;
    }
  }
  return undefined;
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
