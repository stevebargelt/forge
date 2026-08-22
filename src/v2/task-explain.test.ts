// FG-348 [C]: buildTaskExplain unit spec. Proves each block is driven off the
// presence/absence of its OWN recorded block, and that absence emits the ticket's
// warnings without throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskExplain, type BuildTaskExplainInput } from "./task-explain.js";
import { RUN_EXPLAIN_VERSION } from "./run-explain-types.js";
import type { Task, TaskPackage } from "../types/index.js";
import type { ControlPlaneReceipt, TaskManifest } from "./task-manifest.js";

function mkTask(opts: Partial<Task> & { id: string } = { id: "t1" }): Task {
  const taskPackage: TaskPackage = {
    taskId: opts.id,
    runId: "run1",
    phase: opts.phase ?? "build",
    role: opts.agentRole ?? "engineer",
    inputs: opts.taskPackage?.inputs ?? {},
    composedSystemPrompt: "",
  };
  return {
    id: opts.id,
    runId: "run1",
    phase: opts.phase ?? "build",
    agentRole: opts.agentRole ?? "engineer",
    status: opts.status ?? "complete",
    ...(opts.agentAlias !== undefined ? { agentAlias: opts.agentAlias } : {}),
    ...(opts.agentModel !== undefined ? { agentModel: opts.agentModel } : {}),
    ...(opts.resolvedProfile !== undefined ? { resolvedProfile: opts.resolvedProfile } : {}),
    ...(opts.resolvedProvider !== undefined ? { resolvedProvider: opts.resolvedProvider } : {}),
    ...(opts.resolvedAuth !== undefined ? { resolvedAuth: opts.resolvedAuth } : {}),
    ...(opts.resolvedBy !== undefined ? { resolvedBy: opts.resolvedBy } : {}),
    taskPackage,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

const CONTROL_PLANE: ControlPlaneReceipt = {
  workflow: { name: "feature", source: "host", path: "/seed/feature.yml" },
  runtime: { name: "claude-apikey", source: "host", path: "/seed/claude-apikey.yml" },
  modelPolicy: { source: "host", path: "/home/.forge/model-policy.yml" },
  docsSurfaces: { source: "built-in" },
  constraints: { dir: "/seed/constraints", suggestCount: 2, forceCount: 1 },
  projectDir: "/project",
  mountMode: "rw",
};

const FULL_MANIFEST: Partial<TaskManifest> = {
  controlPlane: CONTROL_PLANE,
  model: {
    alias: "coding",
    model: "claude-opus",
    profile: "claude-bedrock",
    provider: "anthropic",
    auth: "bedrock",
    costTier: "premium",
    resolvedBy: "overrides.agents.engineer",
    runtime: "claude-apikey",
    capabilitySource: "role-derived",
    mappingPath: "exact",
  },
  runtime: {
    name: "claude-apikey",
    kind: "claude-code",
    logFormat: "claude-stream-json",
    promptStrategy: "claude-stdin-package",
    authStrategy: "env-provider-api-key",
  },
};

function baseInput(overrides: Partial<BuildTaskExplainInput> = {}): BuildTaskExplainInput {
  return {
    task: mkTask({ id: "t1" }),
    gates: [],
    verdicts: [],
    ...overrides,
  };
}

test("carries the contract version and identity", () => {
  const explain = buildTaskExplain(baseInput({ manifest: FULL_MANIFEST }));
  assert.equal(explain.version, RUN_EXPLAIN_VERSION);
  assert.equal(explain.taskId, "t1");
  assert.equal(explain.role, "engineer");
});

test("a full manifest yields authoritative blocks with no absence warnings", () => {
  const explain = buildTaskExplain(baseInput({ manifest: FULL_MANIFEST, gateType: "verdict" }));
  assert.equal(explain.modelResolution?.status, "recorded");
  assert.equal(explain.modelResolution?.profile, "claude-bedrock");
  assert.equal(explain.runtime?.status, "recorded");
  assert.equal(explain.runtime?.kind, "claude-code");
  assert.equal(explain.mountMode?.status, "recorded");
  assert.equal(explain.mountMode?.mountMode, "rw");
  assert.equal(explain.workflowSource?.status, "recorded");
  assert.equal(explain.workflowSource?.source, "host");
  // No degradation warnings for a complete manifest.
  assert.deepEqual(explain.warnings, []);
});

test("manifest missing the controlPlane block emits the mount-inferred warning and marks blocks inferred", () => {
  const manifest: Partial<TaskManifest> = { model: FULL_MANIFEST.model, runtime: FULL_MANIFEST.runtime };
  const explain = buildTaskExplain(baseInput({ manifest }));
  assert.equal(explain.mountMode?.status, "inferred");
  assert.equal(explain.workflowSource?.status, "inferred");
  // Model + runtime blocks are still authoritative — absence is per-block.
  assert.equal(explain.modelResolution?.status, "recorded");
  assert.equal(explain.runtime?.status, "recorded");
  assert.ok(explain.warnings.some((w) => /mount details are inferred/i.test(w)));
});

test("manifest missing the model block emits the model-policy-absent / legacy warning", () => {
  const manifest: Partial<TaskManifest> = { controlPlane: CONTROL_PLANE, runtime: FULL_MANIFEST.runtime };
  const task = mkTask({ id: "t1", agentAlias: "coding", agentModel: "claude-x" });
  const explain = buildTaskExplain(baseInput({ task, manifest }));
  assert.equal(explain.modelResolution?.status, "inferred");
  assert.equal(explain.modelResolution?.alias, "coding");
  assert.ok(explain.warnings.some((w) => /model policy absent; legacy runtime alias resolution used/i.test(w)));
});

test("a wholly-absent manifest degrades to unknown blocks + predates-manifest warning without throwing", () => {
  let explain!: ReturnType<typeof buildTaskExplain>;
  assert.doesNotThrow(() => {
    explain = buildTaskExplain(baseInput({ manifest: undefined }));
  });
  assert.equal(explain.modelResolution?.status, "unknown");
  assert.equal(explain.runtime?.status, "unknown");
  assert.equal(explain.mountMode?.status, "unknown");
  assert.equal(explain.workflowSource?.status, "unknown");
  assert.ok(explain.warnings.some((w) => /predates manifest\.json/i.test(w)));
  // The absent-model warning does NOT fire on a wholly-absent manifest — it is a
  // legacy-mode signal, not a no-receipt one.
  assert.ok(!explain.warnings.some((w) => /model policy absent/i.test(w)));
});

test("project workflow override surfaces prominently", () => {
  const manifest: Partial<TaskManifest> = {
    ...FULL_MANIFEST,
    controlPlane: { ...CONTROL_PLANE, workflow: { name: "feature", source: "project", path: "/project/.forge/workflows/feature.yml" } },
  };
  const explain = buildTaskExplain(baseInput({ manifest }));
  assert.ok(explain.warnings.some((w) => /project workflow override is active/i.test(w)));
});

test("receipt-recorded warnings are surfaced verbatim, after derived-absence warnings", () => {
  const manifest: Partial<TaskManifest> = {
    ...FULL_MANIFEST,
    controlPlane: { ...CONTROL_PLANE, warnings: ["routing lookup failed"] },
  };
  const explain = buildTaskExplain(baseInput({ manifest }));
  assert.ok(explain.warnings.includes("routing lookup failed"));
});

test("gate block projects DB decisions and the workflow gate type", () => {
  const explain = buildTaskExplain(
    baseInput({
      manifest: FULL_MANIFEST,
      gateType: "human",
      gates: [{ decision: "advance", rationale: "looks good", decidedBy: "steve", decidedAt: "2026-08-01T01:00:00.000Z" }],
    }),
  );
  assert.equal(explain.gate?.gateType, "human");
  assert.equal(explain.gate?.decisions.length, 1);
  assert.equal(explain.gate?.decisions[0]?.decision, "advance");
});

test("reds block projects verdicts with a finding count", () => {
  const explain = buildTaskExplain(
    baseInput({
      manifest: FULL_MANIFEST,
      verdicts: [
        { redTaskId: "r1", redRole: "red-wide", verdict: "pass", confidence: 0.9, authority: "authoritative", findings: [{ severity: "low" }] },
      ],
    }),
  );
  assert.equal(explain.reds?.reds.length, 1);
  assert.equal(explain.reds?.reds[0]?.findingCount, 1);
  assert.equal(explain.reds?.reds[0]?.verdict, "pass");
});

test("upstream inputs are summarized, never dumped verbatim", () => {
  const task = mkTask({ id: "t1" });
  task.taskPackage.inputs = { brief: "x".repeat(500), fanoutIndex: 2, nested: { a: 1 } };
  const explain = buildTaskExplain(baseInput({ task, manifest: FULL_MANIFEST }));
  const brief = explain.upstream?.inputs.find((i) => i.key === "brief");
  assert.ok(brief && brief.summary.length <= 81, "long strings are truncated");
  const nested = explain.upstream?.inputs.find((i) => i.key === "nested");
  assert.equal(nested?.summary, "object{1}");
});

test("a fanout child input surfaces the plan.steps warning", () => {
  const task = mkTask({ id: "c1" });
  task.taskPackage.inputs = { fanoutIndex: 0 };
  const explain = buildTaskExplain(baseInput({ task, manifest: FULL_MANIFEST }));
  assert.ok(explain.warnings.some((w) => /fanout children were created from plan\.steps/i.test(w)));
});
