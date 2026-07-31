// FG-366 fast-gate coverage: the only test asserting the runNext/pipeline-path
// resolved runtime.name (fg350-control-plane-receipts.worktree.test.ts) lives
// in the worktree tier, which `npm test` (test:unit, the fast gate) excludes.
// This duplicates that one assertion here so AC4 has evidence in the fast gate
// too, not only in test:extended.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { TaskManifest } from "./task-manifest.js";
import type { DockerExecFn } from "./docker-exec.js";
import { assetRoot } from "./asset-root.js";
import type { Workflow } from "./schema.js";

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "fg366-pipe",
  description: "FG-366: single-step pipeline for runtime-name resolution test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

function makeSimpleExec(result: unknown = { status: "complete" }): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-366 (fast gate): sentinel 'claude' runtime records the concrete declared name on the runNext/pipeline path", async () => {
  const origForgeHome = process.env.FORGE_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "forge-fg366-fast-"));
  process.env.FORGE_HOME = isolatedHome;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg366-fast-proj-"));
  try {
    // Write ONLY claude-apikey.yml — no claude.yml so sentinel resolution fires.
    const runtimeDir = join(isolatedHome, "runtimes");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "claude-apikey.yml"), `name: claude-apikey
description: fg366 fast-gate test stub
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
    // FG-583: dispatch reads only a published generation — publish the flat runtime.
    publishFlatAsGeneration(isolatedHome);
    // FG-654: this isolated home is a HOST, and a host that dispatches `engineer` must
    // carry the agent seeds — the Forge-owned protocol region is a dispatch precondition
    // now, so an agents-less home is refused by name rather than silently composing a
    // placeholder. Provisioned exactly as install-seeds.sh provisions a fresh host.
    cpSync(join(assetRoot(), "seeds", "agents"), join(isolatedHome, "agents"), { recursive: true });

    const { runId } = startRun({
      workflow: SINGLE_STEP_WORKFLOW,
      title: "fg366 fast-gate pipeline sentinel test",
      inputs: {},
      projectDir,
    });
    await runNext({ runId, workflow: SINGLE_STEP_WORKFLOW, dockerExec: makeSimpleExec() });

    const tasks = tasksForRun(runId).filter((t) => t.parentId === undefined);
    assert.equal(tasks.length, 1, "one primary task expected");
    const manifest = JSON.parse(
      readFileSync(join(taskDir(runId, tasks[0]!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;

    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.runtime.name,
      "claude-apikey",
      "sentinel-resolved runtime must record the concrete YAML-declared name in controlPlane on the pipeline path too",
    );

    // FG-366: the outer execution-metadata runtime.name must agree with
    // controlPlane.runtime.name — no intra-manifest sentinel-vs-resolved split.
    assert.ok(manifest.runtime !== undefined, "outer runtime block must be present");
    assert.equal(
      manifest.runtime!.name,
      "claude-apikey",
      "outer manifest.runtime.name must record the resolved concrete runtime, matching controlPlane.runtime.name",
    );
  } finally {
    process.env.FORGE_HOME = origForgeHome;
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
