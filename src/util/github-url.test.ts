import { test } from "node:test";
import assert from "node:assert/strict";
import { githubBrowserUrl, deriveGithubUrl, type GitRunner } from "./github-url.js";

// ── githubBrowserUrl (pure URL parsing) ──────────────────────────────────────

test("FG-438 githubBrowserUrl: SSH scp-form → canonical https, .git trimmed", () => {
  assert.equal(githubBrowserUrl("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(githubBrowserUrl("git@github.com:owner/repo"), "https://github.com/owner/repo");
});

test("FG-438 githubBrowserUrl: HTTPS → canonical https, .git trimmed", () => {
  assert.equal(githubBrowserUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(githubBrowserUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
});

test("FG-438 githubBrowserUrl: ssh:// (with optional port) and git:// transports", () => {
  assert.equal(githubBrowserUrl("ssh://git@github.com/owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(githubBrowserUrl("ssh://git@github.com:22/owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(githubBrowserUrl("git://github.com/owner/repo.git"), "https://github.com/owner/repo");
});

test("FG-438 githubBrowserUrl: trailing slash trimmed", () => {
  assert.equal(githubBrowserUrl("https://github.com/owner/repo/"), "https://github.com/owner/repo");
});

test("FG-438 githubBrowserUrl: non-GitHub / malformed → undefined", () => {
  assert.equal(githubBrowserUrl("git@gitlab.com:owner/repo.git"), undefined);
  assert.equal(githubBrowserUrl("https://bitbucket.org/owner/repo.git"), undefined);
  assert.equal(githubBrowserUrl(""), undefined);
  assert.equal(githubBrowserUrl("not a url"), undefined);
  assert.equal(githubBrowserUrl("https://github.com/owner"), undefined); // no repo segment
});

// ── deriveGithubUrl (git remotes → canonical URL) ────────────────────────────

function fakeGit(remoteVOutput: string, opts: { throws?: boolean } = {}): GitRunner {
  return () => {
    if (opts.throws) throw new Error("not a git repository");
    return remoteVOutput;
  };
}

test("FG-438 deriveGithubUrl: single origin GitHub remote (fetch+push lines dedupe)", () => {
  const git = fakeGit(
    "origin\tgit@github.com:owner/repo.git (fetch)\n" +
    "origin\tgit@github.com:owner/repo.git (push)\n",
  );
  assert.equal(deriveGithubUrl("/proj", git), "https://github.com/owner/repo");
});

test("FG-438 deriveGithubUrl: not a git repo / git unavailable → undefined (no broken link)", () => {
  assert.equal(deriveGithubUrl("/proj", fakeGit("", { throws: true })), undefined);
});

test("FG-438 deriveGithubUrl: git repo with no remotes → undefined", () => {
  assert.equal(deriveGithubUrl("/proj", fakeGit("")), undefined);
});

test("FG-438 deriveGithubUrl: remotes present but none GitHub → undefined", () => {
  assert.equal(deriveGithubUrl("/proj", fakeGit("origin\tgit@gitlab.com:o/r.git (fetch)\n")), undefined);
});

test("FG-438 deriveGithubUrl: multiple GitHub remotes → prefer origin", () => {
  const git = fakeGit(
    "upstream\thttps://github.com/upstream-owner/repo.git (fetch)\n" +
    "origin\tgit@github.com:my-owner/repo.git (fetch)\n",
  );
  assert.equal(deriveGithubUrl("/proj", git), "https://github.com/my-owner/repo");
});

test("FG-438 deriveGithubUrl: origin is non-GitHub but another remote is → first GitHub remote", () => {
  const git = fakeGit(
    "origin\tgit@gitlab.com:o/r.git (fetch)\n" +
    "gh\thttps://github.com/gh-owner/repo.git (fetch)\n",
  );
  assert.equal(deriveGithubUrl("/proj", git), "https://github.com/gh-owner/repo");
});
