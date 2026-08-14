// FG-524 regression: invoke WARN must preserve the shared evaluator's full
// tests_run semantics, not merely check whether the field is present.
//
// This drives the real invoke result-ingestion path with the same on-disk
// result.json boundary an agent container uses.  Values of zero and a string
// are both non-compliant according to validation-contract.ts and therefore
// must complete with a warning (the documented WARN, rather than HOLD, policy).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { evaluateValidationContract } from "./validation-contract.js";
import { eventsForTask } from "../store/events.js";
import { getTask } from "../store/tasks.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg524-values.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `name: fg524-values
description: FG-524 validation-contract value test runtime
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function resultExec(result: unknown): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const taskDir = dirname(stdoutPath);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-524 invoke: non-positive and malformed tests_run values warn with the shared evaluator reason", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  for (const testsRun of [0, "12"] as const) {
    const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-values-"));
    const result = { status: "complete", diff_summary: "work completed", tests_run: testsRun };
    try {
      const expected = evaluateValidationContract({ role: "engineer", result });
      assert.equal(expected.held, true, "fixture must fail the shared contract");

      const invocation = await invoke({
        agentRole: "engineer",
        task: "an ad-hoc implementation task",
        projectDir,
        runtimeName: "fg524-values",
        dockerExec: resultExec(result),
      });

      assert.equal(invocation.status, "complete", "WARN policy must not strand an ad-hoc invoke");
      assert.equal(getTask(invocation.taskId)?.status, "complete");
      const warnings = eventsForTask(invocation.taskId)
        .filter((event) => event.eventType === "task.validation_warning");
      assert.equal(warnings.length, 1, "every shared-contract failure must be observable once");
      assert.deepEqual(warnings[0]?.payload, {
        kind: "validation_contract",
        reason: expected.reason,
      }, "invoke must publish the evaluator's exact named reason, not reinterpret it");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }
});
