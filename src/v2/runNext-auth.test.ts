// #176 pipeline wiring: --auth-profile staged into browser-capable steps only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { writeProfile } from "../util/auth-profiles.js";
import type { Workflow } from "./schema.js";

function makeStubExec(resultJson: unknown): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function supabaseValue(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt, refresh_token: "r" });
}

// Write a runtime that mounts a browser-tools dir carrying the injector (so the
// #181 auth guard passes), returning the runtime name.
function setupBrowserRuntime(): string {
  const fhome = process.env.FORGE_HOME!;
  const btDir = join(fhome, "bt-skill");
  mkdirSync(btDir, { recursive: true });
  writeFileSync(join(btDir, "auth-inject.js"), "// stub injector\n");
  const rtPath = join(fhome, "runtimes", "claude-bt.yml");
  mkdirSync(dirname(rtPath), { recursive: true });
  writeFileSync(rtPath, `
name: claude-bt
description: bt stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
  - { host: "${btDir}", container: /home/agent/.claude/skills/browser-tools }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  return "claude-bt";
}

function oneStepWorkflow(agent: string, runtime: string): Workflow {
  return {
    name: `wf-${agent}`,
    description: "one step",
    inputs: [],
    steps: [{ id: "step", agent, gate: "auto", manual: false, depends_on: [], runtime, reds: [] }],
  };
}

function stagedAuthPathFor(runId: string): string | undefined {
  const primary = tasksForRun(runId).find((t) => t.phase === "step" && t.parentId === undefined);
  if (!primary) return undefined;
  const p = join(taskDir(runId, primary.id), "auth-state.json");
  return existsSync(p) ? p : undefined;
}

test("runNext: browser-capable step gets a reconciled, mode-600 auth-state staged", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  delete process.env.FORGE_CONTAINER_HOST;
  const runtime = setupBrowserRuntime();
  writeProfile("pipe-admin", {
    cookies: [],
    origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(Math.floor(Date.now() / 1000) + 3600) }] }],
  });

  const wf = oneStepWorkflow("engineer", runtime);
  const { runId } = startRun({ workflow: wf, title: "auth pipe", inputs: {}, projectDir: "/tmp/x", authProfile: "pipe-admin" });
  await runNext({ runId, workflow: wf, dockerExec: makeStubExec({ status: "complete" }) });

  const staged = stagedAuthPathFor(runId);
  assert.ok(staged, "engineer step should have a staged auth-state.json");
  assert.equal(statSync(staged!).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(staged!, "utf8"));
  assert.equal(written.origins[0].origin, "http://host.docker.internal:3000");
});

test("runNext: a non-browser step (architecture-advisor) gets NO auth-state even when the run has a profile", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const runtime = setupBrowserRuntime();
  writeProfile("pipe-admin2", {
    cookies: [],
    origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(Math.floor(Date.now() / 1000) + 3600) }] }],
  });

  const wf = oneStepWorkflow("architecture-advisor", runtime);
  const { runId } = startRun({ workflow: wf, title: "auth pipe2", inputs: {}, projectDir: "/tmp/x", authProfile: "pipe-admin2" });
  await runNext({ runId, workflow: wf, dockerExec: makeStubExec({ status: "complete" }) });

  assert.equal(stagedAuthPathFor(runId), undefined, "non-browser role must not carry the credential");
});
