// FG-744 (fork C) RF-1: the trusted tier runs ARBITRARY test code, which can move HEAD or dirty
// the working tree. The pre-run refusal proves the tree was the clean candidate BEFORE the run;
// it says nothing about after. This suite pins the POST-run re-confirmation: a tier run that
// leaves the workspace dirty at the candidate is a `blocked` environment fault whose output is
// never accepted as evidence, and a tier run that leaves the tree clean returns its output.
//
// Tier: integration — it builds the real wiring deps and spawns a real `node --test` subprocess
// against a throwaway git repo, so the git-state coupling the runner actually has is exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCoordinatorDeps } from "./review-wiring.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function initRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "fg744-rf1-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  // The worktree tier preloads `./src/test-setup.ts`; an empty stand-in is enough for a probe
  // that imports only node built-ins. tsx resolves through a symlink to the real node_modules.
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "test-setup.ts"), "");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  return { dir, head };
}

// The probe is COMMITTED, exactly as the fixer's higher-tier test file is committed into the
// candidate by the fix cycle before the recheck runs. That leaves the tree clean at the candidate
// going in, so the only thing that can dirty it is code the probe runs — the RF-1 case.
function writeProbe(dir: string, name: string, body: string): { file: string; head: string } {
  const file = join(dir, "src", name);
  writeFileSync(
    file,
    [`import { test } from "node:test";`, `import { writeFileSync } from "node:fs";`, body, ""].join("\n"),
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", `probe ${name}`], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { file, head };
}

// The subprocess is `node --test`; if THIS process's node-test context leaks in through the
// inherited env, the child treats itself as a nested subtest and does not run the file — so the
// probe would never dirty the tree. Production never runs the tier under a node:test parent;
// clearing it here reproduces that, not papers over it.
async function withoutNodeTestContext<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env["NODE_TEST_CONTEXT"] = saved;
  }
}

test("FG-744 / RF-1: a tier run that DIRTIES the workspace at the candidate is blocked, not accepted", async () => {
  const { dir } = initRepo();
  try {
    const deps = buildCoordinatorDeps({ projectDir: dir, ticketId: "FG-744" });
    // The probe passes as a TEST, but it plants an untracked file into the repo as it runs — the
    // exact "arbitrary test code moved the workspace" case RF-1 guards. A pass that leaves the tree
    // dirty must still be refused.
    const { file: probe, head } = writeProbe(
      dir,
      "dirtier.worktree.test.ts",
      `test("plants a file then passes", () => { writeFileSync(new URL("./planted.txt", import.meta.url), "x"); });`,
    );
    const result = await withoutNodeTestContext(() =>
      deps.runTrustedTier!({ tier: "worktree", testFiles: [probe], candidateSha: head }),
    );
    assert.equal(result.runnerOutput, undefined, "a dirtied tree's output is never accepted");
    assert.match(result.blocked ?? "", /workspace_dirty_at_candidate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-744 / RF-1: a tier run that leaves the workspace CLEAN returns its output", async () => {
  const { dir } = initRepo();
  try {
    const deps = buildCoordinatorDeps({ projectDir: dir, ticketId: "FG-744" });
    const { file: probe, head } = writeProbe(dir, "clean.worktree.test.ts", `test("leaves the tree clean", () => {});`);
    const result = await withoutNodeTestContext(() =>
      deps.runTrustedTier!({ tier: "worktree", testFiles: [probe], candidateSha: head }),
    );
    assert.equal(result.blocked, undefined, "a clean tree at the candidate is not a block");
    assert.match(result.runnerOutput ?? "", /leaves the tree clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
