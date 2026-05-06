import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "./composeSystemPrompt.js";
import type { Run, Phase, Workflow } from "../types/index.js";

let TMP: string;
let AGENT_DIR: string;
let CONSTRAINTS_DIR: string;

const RUN: Run = {
  id: "run-test",
  workflow: "investigation",
  title: "test",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

const WORKFLOW: Workflow = {
  name: "investigation",
  description: "test",
  phases: [],
};

function phaseWith(opts: Partial<Phase> = {}): Phase {
  return {
    name: opts.name ?? "frame",
    agents: [],
    gate: "human",
    workflowAdditions: opts.workflowAdditions,
  };
}

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "forge-compose-"));
  AGENT_DIR = join(TMP, "agent");
  CONSTRAINTS_DIR = join(TMP, "constraints");
  mkdirSync(AGENT_DIR);
  mkdirSync(CONSTRAINTS_DIR);

  writeFileSync(join(AGENT_DIR, "CLAUDE.md"), "# framer\n\nBase agent prompt.\n");

  writeFileSync(
    join(CONSTRAINTS_DIR, "global-suggest.md"),
    `---
id: global-suggest
level: suggest
roles: []
workflows: []
---

# Global suggest

Default to no comments.
`
  );

  writeFileSync(
    join(CONSTRAINTS_DIR, "framer-only.md"),
    `---
id: framer-only
level: suggest
roles: [framer]
workflows: [investigation]
---

# Framer only

Output JSON.
`
  );

  writeFileSync(
    join(CONSTRAINTS_DIR, "force-anti.md"),
    `---
id: force-anti
level: force
roles: [framer]
workflows: [investigation]
antiPrompt: "Demonstrate the artifact violates X"
---

# Force-level

Body.
`
  );

  writeFileSync(
    join(CONSTRAINTS_DIR, "wrong-role.md"),
    `---
id: wrong-role
level: suggest
roles: [implementer]
workflows: [investigation]
---

# Implementer only

Should NOT appear in framer prompt.
`
  );
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("composeSystemPrompt: tier 1 base prompt is included", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.match(out, /Base agent prompt/);
});

test("composeSystemPrompt: tier 2 workflowAdditions appended when present", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith({ workflowAdditions: "Phase-specific framing here." }),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.match(out, /Phase-specific framing here/);
  assert.match(out, /Workflow additions \(phase: frame\)/);
});

test("composeSystemPrompt: tier 2 omitted when workflowAdditions empty", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.equal(/Workflow additions/.test(out), false);
});

test("composeSystemPrompt: tier 3 includes matching suggest constraints", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.match(out, /global-suggest/);
  assert.match(out, /framer-only/);
});

test("composeSystemPrompt: tier 3 excludes force-level constraints (those go to reds)", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.equal(/force-anti/.test(out), false);
  assert.equal(/Demonstrate the artifact violates X/.test(out), false);
});

test("composeSystemPrompt: tier 3 excludes constraints scoped to other roles", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.equal(/wrong-role/.test(out), false);
  assert.equal(/Should NOT appear/.test(out), false);
});

test("composeSystemPrompt: tier ordering — base before additions before constraints before framing", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith({ workflowAdditions: "MARKER_TIER2" }),
    taskPackageFraming: "MARKER_FRAMING",
    constraintsDir: CONSTRAINTS_DIR,
  });
  const i1 = out.indexOf("Base agent prompt");
  const i2 = out.indexOf("MARKER_TIER2");
  const i3 = out.indexOf("global-suggest");
  const i4 = out.indexOf("MARKER_FRAMING");
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2 && i4 > i3, `order broken: ${i1}, ${i2}, ${i3}, ${i4}`);
});

test("composeSystemPrompt: missing agent CLAUDE.md is logged inline, not thrown", () => {
  const noAgent = join(TMP, "no-agent");
  mkdirSync(noAgent);
  const out = composeSystemPrompt({
    role: "ghost",
    agentDir: noAgent,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.match(out, /Agent base CLAUDE\.md not found/);
});

test("composeSystemPrompt: taskPackageFraming appended when provided", () => {
  const out = composeSystemPrompt({
    role: "framer",
    agentDir: AGENT_DIR,
    run: RUN,
    workflow: WORKFLOW,
    phase: phaseWith(),
    taskPackageFraming: "# Output schema\n\nWrite to /task/result.json",
    constraintsDir: CONSTRAINTS_DIR,
  });
  assert.match(out, /Output schema/);
  assert.match(out, /\/task\/result\.json/);
});
