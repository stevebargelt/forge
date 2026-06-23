// FG-354: persistence-check root selection for worktree tasks.
//
// The fix: both call sites in invoke.ts and runNext.ts now pass
// (worktreePath ?? projectDir) instead of always passing projectDir.
// These tests prove the correct root is used at the invoke.ts call site
// by controlling which directory the file lands in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { setTaskWorktreePath } from "../store/tasks.js";
import { failureKindForTask } from "./failure-kind.js";

function setupRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
}

// Extract the task ID from a stdoutPath: RUNS_DIR/<runId>/<taskId>/container.stdout.log
function taskIdFromStdoutPath(stdoutPath: string): string {
  return basename(dirname(stdoutPath));
}

// FG-354 test 1: no worktreePath set → persistence check uses run.projectDir.
// A file present in projectDir must satisfy the check.
test("FG-354: no worktreePath → checkResultPersistence uses projectDir (existing behavior unchanged)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg354-proj-"));
  try {
    writeFileSync(join(projectDir, "changed.ts"), "x");

    const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        status: "complete",
        files_modified: ["changed.ts"],
      }));
      writeFileSync(stdoutPath, "stub");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({ agentRole: "engineer", task: "t", projectDir, dockerExec: stubExec });
    assert.equal(r.status, "complete", "file in projectDir must pass when no worktreePath");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// FG-354 test 2: worktreePath set → a file present in worktreePath passes.
test("FG-354: worktreePath set → file in worktreePath satisfies persistence check", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg354-proj-"));
  const worktreeDir = mkdtempSync(join(tmpdir(), "fg354-wt-"));
  try {
    // File lives in the worktree, NOT in projectDir.
    writeFileSync(join(worktreeDir, "changed.ts"), "x");

    const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Simulate FG-351 worktree setup: record the worktreePath on the task row
      // BEFORE the result is processed (matches the real production code path where
      // setTaskWorktreePath runs before runContainer returns).
      const taskId = taskIdFromStdoutPath(stdoutPath);
      setTaskWorktreePath(taskId, worktreeDir);
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        status: "complete",
        files_modified: ["changed.ts"],
      }));
      writeFileSync(stdoutPath, "stub");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({ agentRole: "engineer", task: "t", projectDir, dockerExec: stubExec });
    assert.equal(r.status, "complete", "file in worktreePath must pass when worktreePath is set");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});

// FG-354 test 3: worktreePath set → file ONLY in projectDir does NOT pass.
// Verifies the check uses the worktree root, not the main checkout.
test("FG-354: worktreePath set → file only in projectDir fails persistence check", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg354-proj-"));
  const worktreeDir = mkdtempSync(join(tmpdir(), "fg354-wt-"));
  try {
    // File is in projectDir only — the worktree does NOT have it.
    writeFileSync(join(projectDir, "changed.ts"), "x");

    const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const taskId = taskIdFromStdoutPath(stdoutPath);
      setTaskWorktreePath(taskId, worktreeDir);
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        status: "complete",
        files_modified: ["changed.ts"],
      }));
      writeFileSync(stdoutPath, "stub");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({ agentRole: "engineer", task: "t", projectDir, dockerExec: stubExec });
    assert.equal(r.status, "failed", "file only in projectDir must fail when worktreePath is set");
    assert.match(r.error ?? "", /work not persisted/, "failure reason must name the persistence problem");
    assert.equal(failureKindForTask(r.taskId), "work_not_persisted");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});

// FG-354 test 4: no worktreePath set → falls back to projectDir safely.
// A complete task with no files_modified (common case) passes regardless.
test("FG-354: no worktreePath set + no files_modified → passes safely (existing task-state contract)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg354-proj-"));
  try {
    const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
      writeFileSync(stdoutPath, "stub");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const r = await invoke({ agentRole: "engineer", task: "t", projectDir, dockerExec: stubExec });
    assert.equal(r.status, "complete", "no files_modified → no persistence check → complete");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
