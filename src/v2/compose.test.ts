import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "./compose.js";
import type { Workflow } from "./schema.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "forge-v2-compose-"));
  const agentDir = join(root, "agents", "architect");
  const constraintsDir = join(root, "constraints");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(constraintsDir, { recursive: true });
  return { root, agentDir, constraintsDir };
}

const WORKFLOW: Workflow = {
  name: "feature",
  description: "",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "architect", agent: "architect", activity: "spec-writer", runtime: "claude", depends_on: [], gate: "human", manual: false, reds: [] },
  ],
};

test("composeSystemPrompt: returns the agent's CLAUDE.md as the first section", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect\n\nBody text.");
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
  });
  assert.ok(out.startsWith("# architect"));
  assert.ok(out.includes("Body text."));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: appends workflow_additions when present", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  const step = { ...WORKFLOW.steps[0]!, workflow_additions: "Do the thing." };
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step,
    agentDir,
    constraintsDir,
  });
  assert.ok(out.includes("# Workflow additions (step: architect)"));
  assert.ok(out.includes("Do the thing."));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: includes the output-contract framing at the end", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
  });
  assert.ok(out.includes("## Output contract"));
  assert.ok(out.includes("/task/result.json"));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: handles missing agent CLAUDE.md gracefully", () => {
  const { agentDir, constraintsDir, root } = setup();
  // Don't write CLAUDE.md.
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
  });
  assert.ok(out.includes("(Agent base CLAUDE.md not found"));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: pulls in matching suggest-level constraints", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "no-bluff.md"),
    `---
id: no-bluff
level: suggest
roles: [architect]
workflows: [feature]
---
Don't bluff.`
  );
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
  });
  assert.ok(out.includes("# Constraints"));
  assert.ok(out.includes("Constraint: no-bluff"));
  assert.ok(out.includes("Don't bluff."));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: tagged constraint is excluded when runTags has no match", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "ios-only.md"),
    `---
id: ios-only
level: suggest
roles: []
workflows: []
tags: [ios]
---
iOS-specific rule.`
  );
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
    runTags: ["android"],
  });
  assert.ok(!out.includes("ios-only"));
  assert.ok(!out.includes("iOS-specific rule."));
  rmSync(root, { recursive: true, force: true });
});

test("composeSystemPrompt: tagged constraint is included when runTags has a match", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "ios-only.md"),
    `---
id: ios-only
level: suggest
roles: []
workflows: []
tags: [ios]
---
iOS-specific rule.`
  );
  const out = composeSystemPrompt({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
    runTags: ["ios"],
  });
  assert.ok(out.includes("ios-only"));
  assert.ok(out.includes("iOS-specific rule."));
  rmSync(root, { recursive: true, force: true });
});
