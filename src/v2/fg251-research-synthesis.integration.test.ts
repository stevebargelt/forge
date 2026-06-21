// FG-251 integration tests: research-synthesis workflow structure + routing.
//
// What these tests verify:
//   1. The research-synthesis seed workflow loads and validates under WorkflowSchema
//      (end-to-end load path through loadWorkflow, not just safeParse on raw YAML).
//   2. Step DAG shape and the independence invariant:
//      research-primary and research-skeptic both depend_on [frame] only —
//      neither must depend on the other. This structural guarantee is the
//      enforcement mechanism that keeps both research branches independent before
//      synthesis; if it regresses, the skeptic would see the primary's findings
//      before synthesis, defeating the dual-research design.
//   3. Fanout wiring: both research steps fan out from frame, array_key: lanes.
//   4. Gate assignments match the design intent (human gates on frame + synthesize,
//      auto on research steps and docs).
//   5. research-primary and research-skeptic are classified as narrative roles —
//      they pass the FG-339 capability gate even on pi non-capable models.
//   6. runNext dispatches research-primary and research-skeptic on pi non-capable
//      profiles; FG-337 inferred-result backstop completes them cleanly.
//
// Requirements exercised:
//   A. Structural independence: research-primary.depends_on === [frame],
//      research-skeptic.depends_on === [frame] — no cross-dependency.
//   B. Narrative role classification: requiresStructuredResult returns false
//      for research-primary and research-skeptic, true for research-framer.
//   C. Capability gate pass-through: pi non-capable profile does not block
//      narrative research roles (matches FG-339 parity for new roles).
//   D. FG-337 backstop: narrative roles complete via inferred result when
//      the pi runtime writes no result.json.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "./loader.js";
import { requiresStructuredResult } from "./role-capabilities.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import type { Workflow } from "./schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedWorkflowPath = join(repoRoot, "seeds", "workflows", "research-synthesis.yml");

// ---------------------------------------------------------------------------
// Pi JSONL stub helpers (mirrors fg337 / fg339 patterns)
// ---------------------------------------------------------------------------

function piCleanEnd(content: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "end_turn", content }],
    }) + "\n"
  );
}

// Writes pi JSONL to stdout; leaves result.json absent (clean exit, no file).
function makePiNoResultExec(jsonl: string, exitCode = 0) {
  return async ({ stdoutPath, stderrPath }: { stdoutPath: string; stderrPath: string }): Promise<number> => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, jsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// ---------------------------------------------------------------------------
// Runtime + policy setup (idempotent, same approach as fg339 tests)
// ---------------------------------------------------------------------------

function ensurePiStubRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "pi-stub.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: pi-stub
description: test stub pi runtime for FG-251
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

const FG251_POLICY = `on_unavailable: fail
model_profiles:
  pi-non-capable:
    provider: anthropic
    auth: api
    runtime: pi-stub
    map:
      default: { model: llama-3.3-70b-stub, cost_tier: cheap }
defaults:
  profile: pi-non-capable
  activity: {}
`;

function writePolicyToProject(projectDir: string): void {
  const forgeDir = join(projectDir, ".forge");
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, "model-policy.yml"), FG251_POLICY);
}

// ---------------------------------------------------------------------------
// Minimal single-step workflow helper for dispatch tests
// ---------------------------------------------------------------------------

let wfSeq = 0;
function makeWorkflow(agent: string): Workflow {
  const uid = ++wfSeq;
  return {
    name: `fg251-int-${uid}`,
    description: `FG-251 integration test workflow (${agent})`,
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [
      {
        id: "step",
        agent,
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "pi-stub",
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
  ensurePiStubRuntime();
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

// ---------------------------------------------------------------------------
// Section 1: Workflow loads via loadWorkflow (end-to-end load path)
// ---------------------------------------------------------------------------

test("FG-251: research-synthesis seed workflow loads cleanly via loadWorkflow", () => {
  // Write the real seed to the test FORGE_HOME so loadWorkflow can find it.
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  const src = readFileSync(seedWorkflowPath, "utf8");
  writeFileSync(join(wfDir, "research-synthesis.yml"), src);

  const wf = loadWorkflow("research-synthesis");
  assert.equal(wf.name, "research-synthesis");
  assert.ok(wf.description.length > 0, "description must be non-empty");
});

// ---------------------------------------------------------------------------
// Section 2: Step DAG shape assertions
// ---------------------------------------------------------------------------

test("FG-251: research-synthesis has exactly 4 steps in the expected order (docs step removed in FG-344)", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const ids = wf.steps.map((s) => s.id);
  assert.deepEqual(ids, ["frame", "research-primary", "research-skeptic", "synthesize"],
    "step IDs must appear in the designed order — docs step was removed in FG-344 (research emits a report, not operator docs)");
});

test("FG-251: research-primary depends_on [frame] only — no cross-dependency with research-skeptic (Req A)", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const primary = wf.steps.find((s) => s.id === "research-primary")!;
  assert.ok(primary, "research-primary step must exist");
  assert.deepEqual(primary.depends_on, ["frame"],
    "research-primary must depend_on [frame] only — not research-skeptic");
});

test("FG-251: research-skeptic depends_on [frame] only — no cross-dependency with research-primary (Req A)", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const skeptic = wf.steps.find((s) => s.id === "research-skeptic")!;
  assert.ok(skeptic, "research-skeptic step must exist");
  assert.deepEqual(skeptic.depends_on, ["frame"],
    "research-skeptic must depend_on [frame] only — not research-primary");
});

test("FG-251: synthesize depends_on frame, research-primary, and research-skeptic", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const synth = wf.steps.find((s) => s.id === "synthesize")!;
  assert.ok(synth, "synthesize step must exist");
  assert.ok(synth.depends_on.includes("frame"), "synthesize must depend on frame");
  assert.ok(synth.depends_on.includes("research-primary"), "synthesize must depend on research-primary");
  assert.ok(synth.depends_on.includes("research-skeptic"), "synthesize must depend on research-skeptic");
});

// ---------------------------------------------------------------------------
// Section 3: Fanout wiring
// ---------------------------------------------------------------------------

test("FG-251: research-primary has fanout from frame with array_key: lanes", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const primary = wf.steps.find((s) => s.id === "research-primary")!;
  assert.ok(primary.fanout, "research-primary must declare fanout");
  assert.equal(primary.fanout!.from_upstream.step, "frame");
  assert.equal(primary.fanout!.from_upstream.array_key, "lanes");
});

test("FG-251: research-skeptic has fanout from frame with array_key: lanes", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const skeptic = wf.steps.find((s) => s.id === "research-skeptic")!;
  assert.ok(skeptic.fanout, "research-skeptic must declare fanout");
  assert.equal(skeptic.fanout!.from_upstream.step, "frame");
  assert.equal(skeptic.fanout!.from_upstream.array_key, "lanes");
});

// ---------------------------------------------------------------------------
// Section 4: Gate assignments
// ---------------------------------------------------------------------------

test("FG-251: gate assignments match design intent (human on frame + synthesize, auto on research steps; no docs step after FG-344)", () => {
  const wfDir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "research-synthesis.yml"), readFileSync(seedWorkflowPath, "utf8"));

  const wf = loadWorkflow("research-synthesis");
  const gateMap = Object.fromEntries(wf.steps.map((s) => [s.id, s.gate]));
  assert.equal(gateMap["frame"], "human",
    "frame gate must be human — bad decomposition wastes the entire fanout");
  assert.equal(gateMap["research-primary"], "auto",
    "research-primary gate must be auto — narrative output, synthesizer reads both sides");
  assert.equal(gateMap["research-skeptic"], "auto",
    "research-skeptic gate must be auto — narrative output, synthesizer reads both sides");
  assert.equal(gateMap["synthesize"], "human",
    "synthesize gate must be human — operator reviews per-claim verdicts before closing");
  assert.equal(gateMap["docs"], undefined,
    "docs step must not exist — FG-344 removed it; research emits a report artifact, not operator docs");
});

// ---------------------------------------------------------------------------
// Section 5: Role capability classification (Req B)
// ---------------------------------------------------------------------------

test("FG-251: research-primary is a narrative role — requiresStructuredResult returns false (Req B)", () => {
  assert.equal(requiresStructuredResult("research-primary"), false,
    "research-primary must be narrative: no result.json required, FG-337 inferred fallback applies");
});

test("FG-251: research-skeptic is a narrative role — requiresStructuredResult returns false (Req B)", () => {
  assert.equal(requiresStructuredResult("research-skeptic"), false,
    "research-skeptic must be narrative: no result.json required, FG-337 inferred fallback applies");
});

test("FG-251: research-framer is a structured role — requiresStructuredResult returns true", () => {
  // The framer writes result.json with {status, question, lanes} — structured contract.
  assert.equal(requiresStructuredResult("research-framer"), true,
    "research-framer must be structured: it writes result.json with the lanes array");
});

test("FG-251: synthesizer is a structured role — requiresStructuredResult returns true", () => {
  // The synthesizer writes result.json with {status, claims} — structured contract.
  assert.equal(requiresStructuredResult("synthesizer"), true,
    "synthesizer must be structured: it writes result.json with the claims array");
});

// ---------------------------------------------------------------------------
// Section 6: Capability gate pass-through via runNext (Req C + D)
// ---------------------------------------------------------------------------

test("FG-251: runNext — research-primary on pi non-capable profile passes the capability gate (Req C)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg251-rp-nc-"));
  try {
    writePolicyToProject(projectDir);
    const text = "Supporting evidence found for the claim.";
    const wf = makeWorkflow("research-primary");
    const { runId } = startRun({
      workflow: wf,
      title: "fg251-research-primary-nc",
      inputs: { brief: "test" },
      projectDir,
      modelProfile: "pi-non-capable",
    });

    const wave = await runNext({
      runId, workflow: wf,
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    // Narrative role: capability gate does not apply → FG-337 inferred result completes the task.
    assert.deepEqual(wave.completedSteps, ["step"],
      "research-primary must complete via inferred result (gate passed)");
    assert.deepEqual(wave.failedSteps, [],
      "no steps must fail when narrative role passes capability gate");
    assert.equal(wave.runStatus, "complete");

    const task = tasksForRun(runId).find((t) => t.phase === "step")!;
    assert.equal(task.status, "complete");
    assert.ok(!task.error?.includes("tool_capable"),
      "error must NOT be a capability refusal — research-primary is narrative (Req C)");
    const result = task.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred", "Req D: inferred-result backstop applied");
    assert.equal(result.summary, text, "Req D: inferred summary carries assistant text");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-251: runNext — research-skeptic on pi non-capable profile passes the capability gate (Req C)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg251-rs-nc-"));
  try {
    writePolicyToProject(projectDir);
    const text = "Counter-evidence found challenging the claim.";
    const wf = makeWorkflow("research-skeptic");
    const { runId } = startRun({
      workflow: wf,
      title: "fg251-research-skeptic-nc",
      inputs: { brief: "test" },
      projectDir,
      modelProfile: "pi-non-capable",
    });

    const wave = await runNext({
      runId, workflow: wf,
      dockerExec: makePiNoResultExec(piCleanEnd(text)),
    });

    // Narrative role: capability gate does not apply → FG-337 inferred result completes the task.
    assert.deepEqual(wave.completedSteps, ["step"],
      "research-skeptic must complete via inferred result (gate passed)");
    assert.deepEqual(wave.failedSteps, [],
      "no steps must fail when narrative role passes capability gate");
    assert.equal(wave.runStatus, "complete");

    const task = tasksForRun(runId).find((t) => t.phase === "step")!;
    assert.equal(task.status, "complete");
    assert.ok(!task.error?.includes("tool_capable"),
      "error must NOT be a capability refusal — research-skeptic is narrative (Req C)");
    const result = task.result as Record<string, unknown>;
    assert.equal(result.contract, "inferred", "Req D: inferred-result backstop applied");
    assert.equal(result.summary, text, "Req D: inferred summary carries assistant text");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-251: runNext — research-primary and research-skeptic both complete in same pi non-capable run", async () => {
  // Two sequential single-step workflow runs (one per role) simulates the parity of
  // both branches completing cleanly. A true parallel-fanout dispatch requires more
  // complex test harness setup; this tests the dispatch contract independently.
  const primaryText = "Primary: cache writes use a write-barrier before invalidation.";
  const skepticText = "Skeptic: unit tests do not cover concurrent-write invalidation path.";

  const pDir = mkdtempSync(join(tmpdir(), "fg251-dual-p-"));
  const sDir = mkdtempSync(join(tmpdir(), "fg251-dual-s-"));
  try {
    writePolicyToProject(pDir);
    writePolicyToProject(sDir);

    const wfP = makeWorkflow("research-primary");
    const { runId: runIdP } = startRun({
      workflow: wfP, title: "fg251-dual-primary",
      inputs: { brief: "test" }, projectDir: pDir, modelProfile: "pi-non-capable",
    });
    const waveP = await runNext({
      runId: runIdP, workflow: wfP,
      dockerExec: makePiNoResultExec(piCleanEnd(primaryText)),
    });

    const wfS = makeWorkflow("research-skeptic");
    const { runId: runIdS } = startRun({
      workflow: wfS, title: "fg251-dual-skeptic",
      inputs: { brief: "test" }, projectDir: sDir, modelProfile: "pi-non-capable",
    });
    const waveS = await runNext({
      runId: runIdS, workflow: wfS,
      dockerExec: makePiNoResultExec(piCleanEnd(skepticText)),
    });

    assert.equal(waveP.runStatus, "complete", "primary branch must complete");
    assert.equal(waveS.runStatus, "complete", "skeptic branch must complete");

    const taskP = tasksForRun(runIdP).find((t) => t.phase === "step")!;
    const taskS = tasksForRun(runIdS).find((t) => t.phase === "step")!;
    assert.equal(taskP.status, "complete");
    assert.equal(taskS.status, "complete");

    const resP = taskP.result as Record<string, unknown>;
    const resS = taskS.result as Record<string, unknown>;
    assert.equal(resP.summary, primaryText, "primary inferred summary must carry supporting text");
    assert.equal(resS.summary, skepticText, "skeptic inferred summary must carry counter-evidence text");
  } finally {
    rmSync(pDir, { recursive: true, force: true });
    rmSync(sDir, { recursive: true, force: true });
  }
});
