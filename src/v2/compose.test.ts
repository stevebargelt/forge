import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "./compose.js";
import { COVERED_ROLES, PROTOCOL_START_MARKER, PROTOCOL_END_MARKER } from "./agent-protocol.js";
import type { Workflow } from "./schema.js";

/** FG-654: composeSystemPrompt returns a discriminated result now — a covered role with
 *  an absent or stale protocol region REFUSES rather than composing. These cases all use
 *  the uncovered `architect` role, so unwrapping is the whole adaptation. */
function promptOf(args: Parameters<typeof composeSystemPrompt>[0]): string {
  const out = composeSystemPrompt(args);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  return out.prompt;
}

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
  const out = promptOf({
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
  const out = promptOf({
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
  const out = promptOf({
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
  const out = promptOf({
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
  const out = promptOf({
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
  const out = promptOf({
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
  const out = promptOf({
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

// ─── FG-654: the dispatch-time protocol gate lives at THIS read seam ─────────

function protocolFixture(role: string, region: string) {
  const root = mkdtempSync(join(tmpdir(), "forge-v2-protocol-"));
  const home = join(root, "home");
  const release = join(root, "release");
  for (const base of [home, release]) mkdirSync(join(base, "agents", role), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  writeFileSync(
    join(release, "agents", role, "CLAUDE.md"),
    `# ${role}\n\n${PROTOCOL_START_MARKER}\n\n${region}\n\n${PROTOCOL_END_MARKER}\n`,
  );
  return { root, home, release, constraintsDir: join(home, "constraints") };
}

function composeFor(role: string, fx: { home: string; release: string; constraintsDir: string }) {
  return composeSystemPrompt({
    role,
    workflow: WORKFLOW,
    step: { ...WORKFLOW.steps[0]!, agent: role },
    constraintsDir: fx.constraintsDir,
    protocolPaths: { forgeHome: fx.home, seedsDir: fx.release },
  });
}

test("FG-654: every covered role is refused BY NAME when its installed region is stale", () => {
  for (const role of COVERED_ROLES) {
    const fx = protocolFixture(role, "## The protocol\n\ncurrent generation");
    writeFileSync(
      join(fx.home, "agents", role, "CLAUDE.md"),
      `# ${role}\n\n${PROTOCOL_START_MARKER}\n\n## The protocol\n\nOLD generation\n\n${PROTOCOL_END_MARKER}\n`,
    );
    const out = composeFor(role, fx);
    assert.equal(out.ok, false, `${role} composed under a stale protocol region`);
    if (!out.ok) {
      assert.equal(out.role, role);
      assert.ok(out.refusal.includes(role), "the refusal names the role");
      assert.ok(/[0-9a-f]{64}/.test(out.refusal), "the refusal names the installed sha");
      assert.ok(out.refusal.split(/[0-9a-f]{64}/).length >= 3, "the refusal names BOTH shas");
      assert.ok(out.refusal.includes("forge upgrade"), "the refusal names the remedy");
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("FG-654: an ABSENT seed for a covered role refuses instead of composing the fail-open placeholder", () => {
  const fx = protocolFixture("red-wide", "## The protocol\n\ncurrent generation");
  // No installed copy at all — the state compose.ts used to paper over with
  // "(Agent base CLAUDE.md not found …)" and dispatch anyway.
  const out = composeFor("red-wide", fx);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.ok(out.refusal.includes("NO installed seed"));
    assert.ok(!out.refusal.includes("(Agent base CLAUDE.md not found"));
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: a covered role whose region matches composes, and carries the stamp", () => {
  const fx = protocolFixture("engineer", "## The protocol\n\ncurrent generation");
  writeFileSync(
    join(fx.home, "agents", "engineer", "CLAUDE.md"),
    `# engineer\n\nMY OWN SECTION\n\n${PROTOCOL_START_MARKER}\n\n## The protocol\n\ncurrent generation\n\n${PROTOCOL_END_MARKER}\n`,
  );
  const out = composeFor("engineer", fx);
  assert.ok(out.ok);
  if (out.ok) {
    assert.ok(out.prompt.includes("MY OWN SECTION"), "the operator's own prose is composed too");
    assert.equal(out.protocol?.role, "engineer");
    assert.match(out.protocol?.sha256 ?? "", /^[0-9a-f]{64}$/);
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: an UNCOVERED role is unaffected — no fence required, no refusal", () => {
  for (const role of ["synthesizer", "tech-lead", "architect"]) {
    const fx = protocolFixture(role, "## The protocol\n\nirrelevant");
    // Installed seed with NO fence at all. A covered role in this state refuses.
    mkdirSync(join(fx.home, "agents", role), { recursive: true });
    writeFileSync(join(fx.home, "agents", role, "CLAUDE.md"), `# ${role}\n\nwhatever\n`);
    const out = composeFor(role, fx);
    assert.ok(out.ok, `${role} must not be gated`);
    if (out.ok) assert.equal(out.protocol, undefined);
    rmSync(fx.root, { recursive: true, force: true });
  }
});
