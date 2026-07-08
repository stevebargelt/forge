// FG-491: annotated `files_modified` claims (`path:line-range — prose` style)
// must not trip the persistence check's all-claims-missing signature when the
// referenced files are real, and must still fail closed on genuine loss.
//
// persistence-check.test.ts pins normalizeClaim()/checkResultPersistence()
// directly with evidence-shape fixtures. These tests pin the SAME behavior
// through the real invoke() call site (invoke.ts:620) — the only path that
// proves an agent result carrying annotated claims survives markTaskComplete
// instead of being silently downgraded by the persistence gate.
//
// runNext.ts:537 calls checkResultPersistence with the identical signature
// (worktreePath ?? projectDir) and the identical work_not_persisted failTask
// wiring — that call-site wiring (not the annotation-parsing logic itself,
// which lives entirely inside checkResultPersistence) is already pinned with
// raw claims by fg354-dispatch.worktree.test.ts (dispatch-1/2/3). Since the
// annotation normalization is a pure function shared by both callers, it does
// not need a second, heavier worktree-harness duplicate here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { getTask } from "../store/tasks.js";
import { failureKindForTask } from "./failure-kind.js";

function setupRuntimeStub(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `
name: claude
description: test stub
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

function touch(projectDir: string, rel: string): void {
  const p = join(projectDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x");
}

function stubExecWriting(result: unknown): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-491 (invoke): complete + annotated files_modified referencing real files → completes, result not nulled, tests_run preserved (no work_not_persisted downgrade)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg491-real-"));
  try {
    // Real preserved evidence shapes (PR-review-comment style) — the referenced
    // path token exists in the fixture project even though the whole claim string
    // never could as a literal path.
    touch(projectDir, "src/v2/invoke.ts");
    touch(projectDir, "src/store/runs.ts");
    touch(projectDir, "src/campaign/fg484-auto-gate-cancel-race.integration.test.ts");

    const agentResult = {
      status: "complete",
      tests_run: 12,
      tests_passed: 12,
      files_modified: [
        "src/v2/invoke.ts:153-162 — workflow_additions no longer embeds args.task",
        "src/store/runs.ts:140-197",
        "src/campaign/fg484-auto-gate-cancel-race.integration.test.ts (new)",
      ],
    };

    const r = await invoke({
      agentRole: "test-engineer",
      task: "write integration tests",
      projectDir,
      dockerExec: stubExecWriting(agentResult),
    });

    assert.equal(r.status, "complete", "annotated claims resolving to real files must not fail the task");
    assert.deepEqual(r.result, agentResult, "result must be returned intact, not nulled/discarded");

    const task = getTask(r.taskId);
    assert.ok(task);
    assert.equal(task!.status, "complete");
    // tests_run/tests_passed survive on the persisted task row's result blob.
    const storedResult = task!.result as typeof agentResult;
    assert.equal(storedResult.tests_run, 12, "tests_run must be preserved on the stored task result");
    assert.equal(storedResult.tests_passed, 12);
    assert.deepEqual(storedResult.files_modified, agentResult.files_modified);

    assert.notEqual(failureKindForTask(r.taskId), "work_not_persisted", "no persistence downgrade for real annotated claims");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-491 (invoke): genuine loss — raw, annotated, and /workspace-absolute claims where nothing exists on host → downgraded to failed with a persistence error naming the raw claim, normalized path, and unparseable list", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg491-loss-"));
  try {
    const agentResult = {
      status: "complete",
      tests_run: 3,
      files_modified: [
        "src/totally/gone.ts",
        "src/also/missing.ts:5-10 — never landed",
        "/workspace/scratch/output.txt",
        ":1-5",
      ],
    };

    const r = await invoke({
      agentRole: "test-engineer",
      task: "write integration tests",
      projectDir,
      dockerExec: stubExecWriting(agentResult),
    });

    assert.equal(r.status, "failed", "total loss across raw/annotated/absolute claims must fail the task");
    assert.match(r.error ?? "", /work not persisted/);

    // Raw claim text present verbatim.
    assert.match(r.error ?? "", /src\/also\/missing\.ts:5-10 — never landed/, "error must contain the raw annotated claim");
    // Its normalized path present (raw → normalized rendering).
    assert.match(r.error ?? "", /src\/also\/missing\.ts:5-10 — never landed → src\/also\/missing\.ts/, "error must show the normalized path for the annotated claim");
    // The unannotated raw claim and the /workspace absolute claim also named.
    assert.match(r.error ?? "", /src\/totally\/gone\.ts/);
    assert.match(r.error ?? "", /\/workspace\/scratch\/output\.txt/);
    // The unparseable claim is called out distinctly, never as proof of persistence.
    assert.match(r.error ?? "", /unparseable|no parseable path token/i);
    assert.match(r.error ?? "", /:1-5/, "the unparseable raw claim itself must be named");

    assert.equal(failureKindForTask(r.taskId), "work_not_persisted");

    const task = getTask(r.taskId);
    assert.ok(task);
    assert.equal(task!.status, "failed", "task must be downgraded to failed, not left complete");
    // The original claimed result is preserved on the failed task row for diagnosis.
    assert.deepEqual(task!.result, agentResult);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-491 (invoke): partial presence — one annotated claim resolves to a real file among otherwise-missing claims → completes (not total loss)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg491-partial-"));
  try {
    touch(projectDir, "src/present.ts");
    const agentResult = {
      status: "complete",
      files_modified: ["src/present.ts:1-5 — landed fine", "src/absent.ts:9-10 — never landed"],
    };

    const r = await invoke({
      agentRole: "test-engineer",
      task: "write integration tests",
      projectDir,
      dockerExec: stubExecWriting(agentResult),
    });

    assert.equal(r.status, "complete", "one resolved+existing claim among the set means this is not total loss");
    assert.deepEqual(r.result, agentResult);
    assert.notEqual(failureKindForTask(r.taskId), "work_not_persisted");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// FG-491 (reopened): prose whose first word happens to name a real file must
// not count as proof of persistence through the real invoke() seam either —
// normalizeClaim() only recognizes empty/dash-led/paren-led remainders as
// path claims now, so this prose is unparseable and must fail closed exactly
// like a genuine loss.

test("FG-491 (reopened, invoke): complete + prose-only files_modified whose first word names a real file → downgraded to failed, error lists the claim as unparseable", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg491-prose-only-"));
  try {
    touch(projectDir, "README.md");
    const agentResult = {
      status: "complete",
      files_modified: ["README.md updated the real file elsewhere"],
    };

    const r = await invoke({
      agentRole: "test-engineer",
      task: "write integration tests",
      projectDir,
      dockerExec: stubExecWriting(agentResult),
    });

    assert.equal(
      r.status,
      "failed",
      "prose must never count as proof of persistence just because its first word names a real file",
    );
    assert.match(r.error ?? "", /work not persisted/);
    assert.match(r.error ?? "", /README\.md updated the real file elsewhere/, "error must name the raw prose claim");
    assert.match(r.error ?? "", /unparseable|no parseable path token/i, "error must call out the claim as unparseable");

    assert.equal(failureKindForTask(r.taskId), "work_not_persisted");

    const task = getTask(r.taskId);
    assert.ok(task);
    assert.equal(task!.status, "failed", "task must be downgraded to failed, not left complete");
    assert.deepEqual(task!.result, agentResult);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-491 (reopened, invoke): prose claim alongside a real existing path claim → completes (partial presence via the real claim only)", async () => {
  setupRuntimeStub();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "fg491-prose-plus-real-"));
  try {
    touch(projectDir, "src/real.ts");
    const agentResult = {
      status: "complete",
      files_modified: ["README.md updated the real file elsewhere", "src/real.ts"],
    };

    const r = await invoke({
      agentRole: "test-engineer",
      task: "write integration tests",
      projectDir,
      dockerExec: stubExecWriting(agentResult),
    });

    assert.equal(
      r.status,
      "complete",
      "the genuine path claim must carry partial presence even alongside unparseable prose",
    );
    assert.deepEqual(r.result, agentResult, "result must be returned intact, not nulled/discarded");
    assert.notEqual(failureKindForTask(r.taskId), "work_not_persisted");

    const task = getTask(r.taskId);
    assert.ok(task);
    assert.equal(task!.status, "complete");
    assert.deepEqual((task!.result as typeof agentResult).files_modified, agentResult.files_modified);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
