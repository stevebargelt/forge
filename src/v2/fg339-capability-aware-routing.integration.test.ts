// FG-339 integration tests: capability-aware routing — end-to-end wiring.
//
// These tests exercise the FULL invoke/runNext dispatch cycle to verify:
//   1. Structured role + pi non-capable model → refused BEFORE spawning container
//      (fail-fast with a clear message naming the role and the tool_capable fix)
//   2. Structured role + pi capable model (tool_capable:true) → dispatches OK
//      (gate passes; task fails only because the stub writes no result.json)
//   3. Narrative role + pi non-capable model → passes through (no gate refusal)
//      (FG-337 inferred-result backstop completes the task)
//   4. Structured role + non-pi runtime → default capable (no gate refusal)
//   5. Legacy mode (no policy file) → gate skipped entirely
//   6. runNext pipeline path: same gate applies (structured refused, narrative passes)
//
// Requirements exercised:
//   A. The discriminator is requiresStructuredResult(), not a new requiresTools flag —
//      narrative roles are never refused regardless of the runtime.
//   B. Pi runtimes default non-capable (tool_capable absent → false for pi);
//      non-pi runtimes default capable (tool_capable absent → true for non-pi).
//   C. resolvedBy==='legacy' is a gate no-op — legacy mode is unaffected.
//   D. Error message names the role, mentions tool_capable fix, and tool-capable model.
//   E. Symmetry: invoke path and runNext path both enforce the gate.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import type { Workflow } from "./schema.js";

// ---------------------------------------------------------------------------
// Runtime YAML setup (idempotent — shared FORGE_HOME, check-before-write)
// ---------------------------------------------------------------------------

function ensurePiStubRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "pi-stub.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: pi-stub
description: test stub pi runtime for FG-339
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

function ensureClaudeApiKeyRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude-apikey.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: claude-apikey
description: test stub non-pi runtime for FG-339
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

// Policy YAML with:
//   pi-non-capable : pi-stub runtime, no tool_capable (defaults non-capable on pi)
//   pi-capable     : pi-stub runtime, tool_capable:true
//   claude-api     : anthropic/api (binds to claude-apikey runtime, non-pi)
const FG339_POLICY = `on_unavailable: fail
model_profiles:
  pi-non-capable:
    provider: anthropic
    auth: api
    runtime: pi-stub
    map:
      default: { model: llama-3.3-70b-stub, cost_tier: cheap }
  pi-capable:
    provider: anthropic
    auth: api
    runtime: pi-stub
    map:
      default: { model: llama-3.3-70b-stub, cost_tier: cheap, tool_capable: true }
  claude-api:
    provider: anthropic
    auth: api
    map:
      default: { model: claude-sonnet-stub, cost_tier: standard }
defaults:
  profile: pi-non-capable
  activity: {}
`;

function writePolicyToProject(projectDir: string): void {
  const forgeDir = join(projectDir, ".forge");
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, "model-policy.yml"), FG339_POLICY);
}

// ---------------------------------------------------------------------------
// Exec stubs
// ---------------------------------------------------------------------------

type DockerExecArgs = { stdoutPath: string; stderrPath: string; resultJsonPath?: string };

function piCleanEnd(content: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "end_turn", content }],
    }) + "\n"
  );
}

// Pi exec that writes clean agent_end JSONL but no result.json (exits 0).
function makePiNoResultExec(jsonl: string, exitCode = 0) {
  return async ({ stdoutPath, stderrPath }: DockerExecArgs): Promise<number> => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, jsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// Noop exec — writes empty stdout/stderr, no result.json (simulates a non-pi stub).
function makeNoopExec(exitCode = 0) {
  return async ({ stdoutPath, stderrPath }: DockerExecArgs): Promise<number> => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// ---------------------------------------------------------------------------
// Workflow helper for runNext tests
// ---------------------------------------------------------------------------

let wfSeq = 0;
function makeWorkflow(agent: string): Workflow {
  const uid = ++wfSeq;
  return {
    name: `fg339-int-${uid}`,
    description: `FG-339 integration test workflow (${agent})`,
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [
      {
        id: "step",
        agent,
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "pi-stub",   // ignored in policy mode; present only to satisfy schema
        reds: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Env save / restore
// ---------------------------------------------------------------------------

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // Ensure shared runtimes exist (idempotent).
  ensurePiStubRuntime();
  ensureClaudeApiKeyRuntime();
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

// ---------------------------------------------------------------------------
// Requirement A+D: structured role + pi non-capable → refused at dispatch
// ---------------------------------------------------------------------------

test("FG-339 int: invoke — engineer on pi non-capable model is refused before spawning", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-eng-nc-"));
  try {
    writePolicyToProject(projectDir);
    const r = await invoke({
      agentRole: "engineer",
      task: "write some code",
      projectDir,
      modelProfile: "pi-non-capable",
      dockerExec: makeNoopExec(),
    });

    assert.equal(r.status, "failed", "structured role on non-capable pi model must be refused");
    assert.ok(r.error, "error must be set");
    assert.match(r.error!, /engineer/, "error must name the role (requirement D)");
    assert.match(r.error!, /tool_capable/, "error must mention tool_capable fix (requirement D)");
    assert.match(r.error!, /tool-capable/, "error must describe the requirement (requirement D)");
    assert.match(r.error!, /pi-non-capable/, "error must name the profile (requirement D)");
    assert.match(r.error!, /llama-3.3-70b-stub/, "error must name the model (requirement D)");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-339 int: invoke — red-wide on pi non-capable model is refused (structured role)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-red-nc-"));
  try {
    writePolicyToProject(projectDir);
    const r = await invoke({
      agentRole: "red-wide",
      task: "review the code",
      projectDir,
      modelProfile: "pi-non-capable",
      dockerExec: makeNoopExec(),
    });

    assert.equal(r.status, "failed");
    assert.match(r.error!, /red-wide/, "error must name the role");
    assert.match(r.error!, /tool_capable/);
    assert.match(r.error!, /pi-non-capable/, "error must name the profile");
    assert.match(r.error!, /llama-3.3-70b-stub/, "error must name the model");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement B: structured role + pi capable (tool_capable:true) → dispatches
// ---------------------------------------------------------------------------

test("FG-339 int: invoke �� engineer on pi capable model (tool_capable:true) passes the gate", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-eng-cap-"));
  try {
    writePolicyToProject(projectDir);
    const r = await invoke({
      agentRole: "engineer",
      task: "write some code",
      projectDir,
      modelProfile: "pi-capable",
      dockerExec: makePiNoResultExec(piCleanEnd("Here is my implementation.")),
    });

    // Gate passed — task runs and fails because the stub writes no result.json
    // (structured role: no FG-337 inferred fallback).
    assert.equal(r.status, "failed", "task fails for result-missing reason (gate passed)");
    assert.ok(!r.error?.includes("tool_capable"),
      "error must NOT be the capability refusal message (gate passed)");
    assert.ok(!r.error?.includes("tool-capable model"),
      "error must not be the capability refusal (gate passed)");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement A: narrative role + pi non-capable → passes through (no refusal)
// ---------------------------------------------------------------------------

test("FG-339 int: invoke — research-specialist on pi non-capable model passes through (FG-337 backstop)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-rs-nc-"));
  try {
    writePolicyToProject(projectDir);
    const text = "Paris is the capital of France.";
    const r = await invoke({
      agentRole: "research-specialist",
      task: "research something",
      projectDir,
      modelProfile: "pi-non-capable",
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    // Narrative role: gate does not apply → task completes via FG-337 inferred result.
    assert.equal(r.status, "complete",
      "narrative role passes gate and completes via FG-337 inferred result");
    assert.ok(!r.error?.includes("tool_capable"),
      "error must NOT be a tool capability refusal");
    const result = r.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
    assert.equal(result.summary, text);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-339 int: invoke — prompt-author on pi non-capable model passes through", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-pa-nc-"));
  try {
    writePolicyToProject(projectDir);
    const text = "This is the authored prompt output.";
    const r = await invoke({
      agentRole: "prompt-author",
      task: "write a design prompt",
      projectDir,
      modelProfile: "pi-non-capable",
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    assert.equal(r.status, "complete", "prompt-author passes gate (narrative role)");
    assert.ok(!r.error?.includes("tool_capable"),
      "prompt-author must not hit capability gate");
    const result = r.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement B: non-pi runtime → default capable (anthropic/OpenAI profiles unaffected)
// ---------------------------------------------------------------------------

test("FG-339 int: invoke — engineer on non-pi runtime (claude-api) defaults to capable (no refusal)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-nonpi-"));
  try {
    writePolicyToProject(projectDir);
    // claude-api profile: anthropic/api → binds to claude-apikey runtime (not pi)
    // → effectiveToolCapable = undefined ?? (runtimeKind !== 'pi') = undefined ?? true = true
    const r = await invoke({
      agentRole: "engineer",
      task: "write some code",
      projectDir,
      modelProfile: "claude-api",
      dockerExec: makeNoopExec(),
    });

    assert.equal(r.status, "failed");
    assert.ok(!r.error?.includes("tool_capable"),
      "non-pi runtime must not trigger capability gate");
    assert.ok(!r.error?.includes("tool-capable model"),
      "non-pi runtime must default to capable");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement C: legacy mode (no policy file) → gate entirely skipped
// ---------------------------------------------------------------------------

test("FG-339 int: invoke — legacy mode (no policy file) skips capability gate for engineer on pi runtime", async () => {
  // No policy file → legacy mode → resolvedBy='legacy' → gate skipped.
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-legacy-"));
  try {
    // deliberately do NOT call writePolicyToProject → no model-policy.yml
    const r = await invoke({
      agentRole: "engineer",
      task: "legacy mode task",
      projectDir,
      runtimeName: "pi-stub",  // pi runtime — but gate is skipped in legacy mode
      dockerExec: makePiNoResultExec(piCleanEnd("legacy output")),
    });

    // Legacy: gate skipped → engineer runs → fails for result-missing (not capability).
    assert.equal(r.status, "failed");
    assert.ok(!r.error?.includes("tool_capable"),
      "legacy mode must NOT trigger capability gate");
    // Confirms failure is result-missing, not capability refusal.
    const isResultMissing =
      (r.error ?? "").includes("result.json") ||
      (r.error ?? "").includes("result_missing") ||
      (r.error ?? "").includes("no_result_json");
    assert.ok(isResultMissing,
      `legacy mode engineer must fail for result-missing reason, got: ${r.error}`);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement E: runNext (pipeline) path — gate applies on pipeline dispatch
// ---------------------------------------------------------------------------

test("FG-339 int: runNext — engineer on pi non-capable model is refused before spawning", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-rn-eng-nc-"));
  try {
    writePolicyToProject(projectDir);
    const wf = makeWorkflow("engineer");
    const { runId } = startRun({
      workflow: wf,
      title: "fg339-rn-eng-nc",
      inputs: { brief: "test" },
      projectDir,
      modelProfile: "pi-non-capable",
    });

    const wave = await runNext({ runId, workflow: wf, dockerExec: makeNoopExec() });

    assert.deepEqual(wave.failedSteps, ["step"],
      "engineer on pi non-capable must fail in pipeline");
    assert.deepEqual(wave.completedSteps, [],
      "no steps should complete when capability gate blocks");

    const task = tasksForRun(runId).find((t) => t.phase === "step")!;
    assert.equal(task.status, "failed");
    assert.ok(task.error, "task.error must be set");
    assert.match(task.error!, /engineer/, "error must name the role");
    assert.match(task.error!, /tool_capable/, "error must mention the tool_capable fix");
    assert.match(task.error!, /pi-non-capable/, "error must name the profile");
    assert.match(task.error!, /llama-3.3-70b-stub/, "error must name the model");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-339 int: runNext — research-specialist on pi non-capable model passes through", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-rn-rs-nc-"));
  try {
    writePolicyToProject(projectDir);
    const text = "Pipeline research finding via FG-339+FG-337.";
    const wf = makeWorkflow("research-specialist");
    const { runId } = startRun({
      workflow: wf,
      title: "fg339-rn-rs-nc",
      inputs: { brief: "test" },
      projectDir,
      modelProfile: "pi-non-capable",
    });

    const wave = await runNext({
      runId, workflow: wf,
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    // Narrative role: gate passes → FG-337 inferred result completes the task.
    assert.deepEqual(wave.completedSteps, ["step"],
      "research-specialist must complete via inferred result (gate passed)");
    assert.deepEqual(wave.failedSteps, [],
      "no steps must fail when narrative role passes capability gate");
    assert.equal(wave.runStatus, "complete");

    const task = tasksForRun(runId).find((t) => t.phase === "step")!;
    assert.equal(task.status, "complete");
    const result = task.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred");
    assert.equal(result.summary, text);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-339 int: runNext — engineer on pi capable model (tool_capable:true) dispatches", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg339-rn-eng-cap-"));
  try {
    writePolicyToProject(projectDir);
    const wf = makeWorkflow("engineer");
    const { runId } = startRun({
      workflow: wf,
      title: "fg339-rn-eng-cap",
      inputs: { brief: "test" },
      projectDir,
      modelProfile: "pi-capable",
    });

    const wave = await runNext({
      runId, workflow: wf,
      dockerExec: makePiNoResultExec(piCleanEnd("I wrote the code.")),
    });

    // Gate passed — engineer runs and fails for result-missing (structured role, no FG-337).
    assert.deepEqual(wave.failedSteps, ["step"],
      "engineer fails for result-missing (NOT capability refusal)");

    const task = tasksForRun(runId).find((t) => t.phase === "step")!;
    assert.equal(task.status, "failed");
    assert.ok(!task.error?.includes("tool_capable"),
      "error must NOT be capability refusal when tool_capable:true passes gate");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
