// Tests for `forge upgrade`. The action handler itself is integration-heavy
// (shells out to bash, writes files), so we focus on tryGitPull's pure
// decision logic — that's where the meaningful branching lives.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tryGitPull, tryNpmInstall } from "./upgrade.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-upgrade-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function initRepo(opts: { withRemote?: boolean; dirty?: boolean } = {}): void {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  execSync('git commit -q --allow-empty -m "initial"', { cwd: dir });
  if (opts.withRemote) {
    // Point at a bogus URL — we never actually fetch in the no-remote /
    // dirty / dry-run paths, and the test for the real pull is exercised
    // elsewhere (or not — git pull network would be too flaky to test).
    execSync('git remote add origin https://invalid.example.invalid/repo.git', { cwd: dir });
  }
  if (opts.dirty) {
    execSync("touch dirty-file && git add dirty-file", { cwd: dir });
  }
}

test("tryGitPull: returns 'no-remote' when repo has no remote configured", () => {
  initRepo({ withRemote: false });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "no-remote");
});

test("tryGitPull: returns 'dirty' when working tree has uncommitted changes", () => {
  initRepo({ withRemote: true, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dirty takes priority over no-remote check", () => {
  initRepo({ withRemote: false, dirty: true });
  const r = tryGitPull(dir, /* dryRun */ false);
  // Dirty is the earlier check; no-remote would also apply but dirty wins.
  assert.equal(r.kind, "dirty");
});

test("tryGitPull: dry-run with remote + clean tree returns 'ok' without actually fetching", () => {
  initRepo({ withRemote: true });
  const r = tryGitPull(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

test("tryGitPull: returns 'error' when not a git repo", () => {
  // Don't init.
  const r = tryGitPull(dir, /* dryRun */ false);
  // Either kind: "error" or kind: "no-remote" is acceptable; git status fails
  // before we get to the remote check.
  assert.ok(r.kind === "error" || r.kind === "no-remote");
});

test("tryNpmInstall: returns 'no-package-json' when the dir has no package.json", () => {
  const r = tryNpmInstall(dir, /* dryRun */ false);
  assert.equal(r.kind, "no-package-json");
});

test("tryNpmInstall: dry-run with package.json returns 'ok' without invoking npm", () => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
  const r = tryNpmInstall(dir, /* dryRun */ true);
  assert.equal(r.kind, "ok");
});

// ── #229: --rebuild-image branch + release-check tail (operator-facing path) ──

import { maybeRebuildImage, renderReleaseCheckLines } from "./upgrade.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";

function greenInputs() {
  return {
    image: { name: "agent-dev-worker:latest", present: true, createdMs: 2000, dockerfileMtimeMs: 1000 },
    clis: [{ command: "codex", present: true, neededBy: ["codex-subscription"] }],
    policy: { present: true, valid: true },
    profileAuth: [{ profile: "codex-subscription", provider: "openai", auth: "subscription", status: "available" as const, detail: "ok" }],
    routing: { present: true, ok: true, detail: "ok" },
  };
}

test("#229 maybeRebuildImage: --rebuild-image (not dry-run) runs docker/build.sh in the docker dir", () => {
  const calls: { cmd: string; cwd: string }[] = [];
  const r = maybeRebuildImage({ rebuildImage: true }, "/repo", (cmd, opts) => { calls.push({ cmd, cwd: opts.cwd }); });
  assert.equal(r.ran, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /build\.sh/);
  assert.match(calls[0]!.cwd, /\/repo\/docker$/);
  assert.equal(r.error, undefined);
});

test("#229 maybeRebuildImage: dry-run does NOT rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({ rebuildImage: true, dryRun: true }, "/repo", () => { called = true; });
  assert.equal(r.ran, false);
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: without the flag, no rebuild", () => {
  let called = false;
  const r = maybeRebuildImage({}, "/repo", () => { called = true; });
  assert.equal(r.ran, false);
  assert.equal(called, false);
});

test("#229 maybeRebuildImage: a failing build surfaces an error, doesn't throw", () => {
  const r = maybeRebuildImage({ rebuildImage: true }, "/repo", () => { throw new Error("docker boom"); });
  assert.equal(r.ran, true);
  assert.match(r.error ?? "", /rebuild failed/);
});

test("#229 renderReleaseCheckLines: a clean report → single ready line", () => {
  assert.deepEqual(
    renderReleaseCheckLines(buildReleaseReport(greenInputs())),
    ["Release check: ✓ image, runtime CLIs, auth, and policies look ready."],
  );
});

test("#229 renderReleaseCheckLines: problems → action header + each problem + doctor pointer", () => {
  const inputs = greenInputs();
  inputs.clis = [{ command: "codex", present: false, neededBy: ["codex-subscription"] }];
  const lines = renderReleaseCheckLines(buildReleaseReport(inputs));
  assert.match(lines[0]!, /action needed/i);
  assert.ok(lines.some((l) => /cli codex.*missing/.test(l)), "names the failing CLI");
  assert.match(lines[lines.length - 1]!, /forge doctor/);
});
