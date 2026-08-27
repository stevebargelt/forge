import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "./compose.js";
import { createHash } from "node:crypto";
import { COVERED_ROLES } from "./agent-protocol.js";
import { fixtureReleaseSeeds, publishTestGeneration } from "./seed-generation.testkit.js";
import type { SeedGeneration } from "./seed-generation.js";
import type { Workflow } from "./schema.js";

/** FG-654: composeSystemPrompt returns a discriminated result now — a covered role with
 *  an unresolvable protocol REFUSES rather than composing. These cases all use the
 *  uncovered `architect` role, so unwrapping is the whole adaptation. */
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

test("FG-773: projectDir is inert — the composed prompt is byte-identical with or without it", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect\n\nBody text.");
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
  const base = {
    role: "architect",
    workflow: WORKFLOW,
    step: { ...WORKFLOW.steps[0]!, workflow_additions: "Do the thing." },
    agentDir,
    constraintsDir,
  } as const;
  const without = promptOf(base);
  const withArbitrary = promptOf({ ...base, projectDir: join(root, "some", "project") });
  const withMissing = promptOf({ ...base, projectDir: "/does/not/exist" });
  assert.equal(withArbitrary, without, "an arbitrary projectDir must not change resolution");
  assert.equal(withMissing, without, "a nonexistent projectDir must not change resolution");
  rmSync(root, { recursive: true, force: true });
});

// ─── FG-774: the tier-1 project override is an APPENDED ADDENDUM, not a replacement ─────

function withProjectAddendum(root: string, role: string, body: string): string {
  const projectDir = join(root, "owning-project");
  const addendumDir = join(projectDir, ".forge", "agents", role);
  mkdirSync(addendumDir, { recursive: true });
  writeFileSync(join(addendumDir, "CLAUDE.md"), body);
  return projectDir;
}

test("FG-774: a project addendum is appended as a labeled section AFTER the host base", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect\n\nHOST BASE BODY.");
  const projectDir = withProjectAddendum(root, "architect", "Prefer tabs in this project.");
  const step = { ...WORKFLOW.steps[0]!, workflow_additions: "Do the thing." };
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
    step,
    agentDir,
    constraintsDir,
    projectDir,
  });
  const iBase = out.indexOf("HOST BASE BODY.");
  const iAddendum = out.indexOf("## Project-specific instructions (owning-project)");
  const iAddendumBody = out.indexOf("Prefer tabs in this project.");
  const iWorkflow = out.indexOf("# Workflow additions (step: architect)");
  const iConstraints = out.indexOf("# Constraints");
  assert.ok(iBase >= 0, "the host base is present");
  assert.ok(iAddendum >= 0, "the labeled addendum section is present");
  assert.ok(iAddendumBody > iAddendum, "the addendum body follows its header");
  assert.ok(iBase < iAddendum, "the addendum comes AFTER the host base");
  assert.ok(iAddendum < iWorkflow, "the addendum comes BEFORE workflow_additions");
  assert.ok(iAddendum < iConstraints, "the addendum comes BEFORE constraints");
  rmSync(root, { recursive: true, force: true });
});

test("FG-774: with NO project addendum, output is byte-identical to today", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect\n\nHOST BASE BODY.");
  const step = { ...WORKFLOW.steps[0]!, workflow_additions: "Do the thing." };
  const base = {
    role: "architect",
    workflow: WORKFLOW,
    step,
    agentDir,
    constraintsDir,
  } as const;
  const without = promptOf(base);
  // A projectDir whose .forge/agents/<role>/CLAUDE.md does not exist is a clean no-op.
  const withEmptyProject = promptOf({ ...base, projectDir: join(root, "no-forge-here") });
  assert.equal(withEmptyProject, without, "a project with no addendum file changes nothing");
  assert.ok(!without.includes("## Project-specific instructions"), "no addendum header leaks in");
  rmSync(root, { recursive: true, force: true });
});

// ─── FG-775: compose's tier-3 SUGGEST set is HOST-UNION-PROJECT (host-wins on id) ─────────

function withProjectConstraint(root: string, filename: string, content: string): string {
  const projectDir = join(root, "owning-project");
  const cdir = join(projectDir, ".forge", "constraints");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, filename), content);
  return projectDir;
}

test("FG-775: a project suggest constraint is added to compose's suggest set", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "no-bluff.md"),
    `---
id: no-bluff
level: suggest
roles: []
workflows: []
---
Don't bluff.`
  );
  const projectDir = withProjectConstraint(root, "house-style.md", `---
id: house-style
level: suggest
roles: []
workflows: []
---
Follow the house style.`);
  const out = promptOf({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
    projectDir,
  });
  assert.ok(out.includes("Constraint: no-bluff"), "host constraint still present");
  assert.ok(out.includes("Constraint: house-style"), "project constraint added to the suggest set");
  assert.ok(out.includes("Follow the house style."), "project constraint body present");
  rmSync(root, { recursive: true, force: true });
});

test("FG-775: host wins on id collision — a project constraint cannot replace a host one", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "no-bluff.md"),
    `---
id: no-bluff
level: suggest
roles: []
workflows: []
---
HOST rule body.`
  );
  const projectDir = withProjectConstraint(root, "no-bluff.md", `---
id: no-bluff
level: suggest
roles: []
workflows: []
---
PROJECT tried to replace this.`);
  const out = promptOf({
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
    projectDir,
  });
  assert.ok(out.includes("HOST rule body."), "host content wins");
  assert.ok(!out.includes("PROJECT tried to replace this."), "project cannot override the host id");
  rmSync(root, { recursive: true, force: true });
});

test("FG-775: a project with no .forge/constraints is a clean no-op (identical to today)", () => {
  const { agentDir, constraintsDir, root } = setup();
  writeFileSync(join(agentDir, "CLAUDE.md"), "# architect");
  writeFileSync(
    join(constraintsDir, "no-bluff.md"),
    `---
id: no-bluff
level: suggest
roles: []
workflows: []
---
Don't bluff.`
  );
  const base = {
    role: "architect",
    workflow: WORKFLOW,
    step: WORKFLOW.steps[0]!,
    agentDir,
    constraintsDir,
  } as const;
  const without = promptOf(base);
  const withEmptyProject = promptOf({ ...base, projectDir: join(root, "no-forge-here") });
  assert.equal(withEmptyProject, without, "a project with no constraints layer changes nothing");
  rmSync(root, { recursive: true, force: true });
});

test("FG-774: the tier-0 protocol is unchanged whether or not an addendum is present", () => {
  const fxNoAddendum = protocolFixture("engineer");
  writeFileSync(join(fxNoAddendum.agentDir, "CLAUDE.md"), "# engineer\n\nHOST BASE.\n");
  const outNo = composeFor("engineer", fxNoAddendum, fxNoAddendum.gen);
  assert.ok(outNo.ok, outNo.ok ? "" : outNo.refusal);

  const fxWith = protocolFixture("engineer");
  writeFileSync(join(fxWith.agentDir, "CLAUDE.md"), "# engineer\n\nHOST BASE.\n");
  const projectDir = withProjectAddendum(fxWith.root, "engineer", "Project delta.");
  const outWith = composeSystemPrompt({
    role: "engineer",
    workflow: WORKFLOW,
    step: { ...WORKFLOW.steps[0]!, agent: "engineer" },
    agentDir: fxWith.agentDir,
    constraintsDir: fxWith.constraintsDir,
    projectDir,
    seedGeneration: fxWith.gen,
    releaseSeedsDir: fixtureReleaseSeeds(fxWith.gen),
  });
  assert.ok(outWith.ok, outWith.ok ? "" : outWith.refusal);

  if (outNo.ok && outWith.ok) {
    // The tier-0 protocol block is byte-identical, and the addendum did not displace it
    // ahead of the protocol.
    assert.ok(outNo.prompt.includes(PROTOCOL), "protocol present without addendum");
    assert.ok(outWith.prompt.includes(PROTOCOL), "protocol present WITH addendum");
    assert.equal(outWith.protocol?.sha256, outNo.protocol?.sha256, "the protocol stamp is unchanged");
    const iProtocol = outWith.prompt.indexOf("## The review protocol");
    const iAddendum = outWith.prompt.indexOf("## Project-specific instructions");
    assert.ok(iProtocol >= 0 && iAddendum >= 0);
    assert.ok(iProtocol < iAddendum, "tier-0 protocol still leads the addendum");
  }
  rmSync(fxNoAddendum.root, { recursive: true, force: true });
  rmSync(fxWith.root, { recursive: true, force: true });
});

// ─── FG-654: the dispatch-time protocol gate lives at THIS read seam ─────────

const PROTOCOL = "## The review protocol\n\ncurrent generation\n";

function protocolFixture(role: string, protocols?: false | Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "forge-v2-protocol-"));
  const home = join(root, "home");
  const agentDir = join(home, "agents", role);
  const constraintsDir = join(home, "constraints");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(constraintsDir, { recursive: true });
  const gen = publishTestGeneration(home, {
    agentProtocols: protocols ?? { [role]: PROTOCOL },
    assetsParent: root,
  });
  return { root, home, agentDir, constraintsDir, gen };
}

function composeFor(
  role: string,
  fx: { agentDir: string; constraintsDir: string; gen: SeedGeneration },
  seedGeneration: SeedGeneration | null,
) {
  return composeSystemPrompt({
    role,
    workflow: WORKFLOW,
    step: { ...WORKFLOW.steps[0]!, agent: role },
    agentDir: fx.agentDir,
    constraintsDir: fx.constraintsDir,
    seedGeneration,
    // The fixture's protocol bytes ARE its release's, so the staleness baseline is the
    // disposable release it published from rather than the tree the test runs in.
    releaseSeedsDir: fixtureReleaseSeeds(fx.gen),
  });
}

test("FG-654: the protocol is composed AHEAD of the operator's own prose", () => {
  const fx = protocolFixture("engineer");
  writeFileSync(join(fx.agentDir, "CLAUDE.md"), "# engineer\n\nMY OWN SECTION\n");
  const out = composeFor("engineer", fx, fx.gen);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  if (out.ok) {
    const iProtocol = out.prompt.indexOf("## The review protocol");
    const iOperator = out.prompt.indexOf("MY OWN SECTION");
    assert.ok(iProtocol >= 0, "the protocol is present");
    assert.ok(iOperator >= 0, "the operator's own prose is present");
    assert.ok(iProtocol < iOperator, "the protocol must come FIRST, not be appended after");
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: the recorded sha256 is the hash of the protocol bytes IN the prompt", () => {
  const fx = protocolFixture("red-wide");
  writeFileSync(join(fx.agentDir, "CLAUDE.md"), "# red-wide\n\noperator prose\n");
  const out = composeFor("red-wide", fx, fx.gen);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  if (out.ok) {
    assert.ok(out.prompt.includes(PROTOCOL), "the exact protocol bytes are in the prompt");
    const digest = createHash("sha256").update(Buffer.from(PROTOCOL, "utf8")).digest("hex");
    assert.equal(out.protocol?.sha256, digest, "the stamp digests the composed bytes");
    assert.equal(out.protocol?.role, "red-wide");
    assert.ok(out.protocol?.source.startsWith(fx.gen.root), "source names the generation");
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: no published generation refuses every covered role by name", () => {
  for (const role of COVERED_ROLES) {
    const fx = protocolFixture(role);
    writeFileSync(join(fx.agentDir, "CLAUDE.md"), `# ${role}\n`);
    const out = composeFor(role, fx, null);
    assert.equal(out.ok, false, `${role} composed with NO generation anchored`);
    if (!out.ok) {
      assert.equal(out.role, role);
      assert.ok(out.refusal.includes(role), "the refusal names the role");
      assert.ok(out.refusal.includes("forge upgrade"), "the refusal names the remedy");
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("FG-654: a generation MISSING this role's protocol refuses", () => {
  const fx = protocolFixture("red-security", { engineer: PROTOCOL });
  writeFileSync(join(fx.agentDir, "CLAUDE.md"), "# red-security\n");
  const out = composeFor("red-security", fx, fx.gen);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.ok(out.refusal.includes("red-security"));
    assert.ok(out.refusal.includes("agent-protocols/red-security.md"));
    assert.ok(out.refusal.includes("forge upgrade"));
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: protocol bytes that no longer match the manifest refuse as TAMPERED", () => {
  const fx = protocolFixture("documentation-maintainer");
  writeFileSync(join(fx.agentDir, "CLAUDE.md"), "# documentation-maintainer\n");
  writeFileSync(join(fx.gen.root, "agent-protocols", "documentation-maintainer.md"), "## Something else\n");
  const out = composeFor("documentation-maintainer", fx, fx.gen);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.ok(out.refusal.includes("documentation-maintainer"));
    assert.ok(out.refusal.includes("provenance manifest"));
    assert.ok(out.refusal.includes("forge upgrade"));
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: an ABSENT operator seed FAILS OPEN — the contract comes from the generation", () => {
  const fx = protocolFixture("shipping-reviewer");
  // No installed CLAUDE.md at all. Pre-FG-654 this composed a placeholder with no
  // contract; the region-era code refused. Now the contract is guaranteed present, so
  // the operator's own (absent) customization is not a reason to refuse.
  const out = composeFor("shipping-reviewer", fx, fx.gen);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  if (out.ok) {
    assert.ok(out.prompt.includes("## The review protocol"), "the protocol still composes");
    assert.ok(out.prompt.includes("(Agent base CLAUDE.md not found"), "the placeholder is back");
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: an UNCOVERED role is unaffected — no protocol required, no refusal", () => {
  for (const role of ["synthesizer", "tech-lead", "architect"]) {
    const fx = protocolFixture(role, false);
    writeFileSync(join(fx.agentDir, "CLAUDE.md"), `# ${role}\n\nwhatever\n`);
    const out = composeFor(role, fx, fx.gen);
    assert.ok(out.ok, `${role} must not be gated`);
    if (out.ok) assert.equal(out.protocol, undefined);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ─── FG-654: an embedded legacy protocol is REFUSED, never migrated ──────────

test("FG-654: an installed seed still carrying a marker-fenced region refuses, unmodified", () => {
  const fx = protocolFixture("engineer");
  const installed = join(fx.agentDir, "CLAUDE.md");
  const before =
    "# engineer\n\nMY OWN SECTION\n\n<!-- forge:agent-protocol-start -->\n\n## Ancient protocol\n\nold\n\n<!-- forge:agent-protocol-end -->\n";
  writeFileSync(installed, before);
  const out = composeFor("engineer", fx, fx.gen);
  assert.equal(out.ok, false, "a leftover marker-fenced region must refuse");
  if (!out.ok) {
    assert.ok(out.refusal.includes("engineer"), "names the role");
    assert.ok(out.refusal.includes(installed), "names the installed path");
    assert.ok(/by hand/i.test(out.refusal), "gives MANUAL remediation");
  }
  assert.equal(readFileSync(installed, "utf8"), before, "the operator's file is untouched");
  assert.deepEqual(
    readdirSync(fx.agentDir).sort(),
    ["CLAUDE.md"],
    "no .bak, no staging file, nothing new",
  );
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: the pre-FG-654 UNFENCED shape — a heading the protocol owns — refuses too", () => {
  const fx = protocolFixture("red-narrow");
  const installed = join(fx.agentDir, "CLAUDE.md");
  // No markers anywhere; just the legacy section inlined, which is what a host that
  // never adopted the fence actually holds.
  const before = "# red-narrow\n\nMY OWN SECTION\n\n## The review protocol\n\nan OLD generation\n";
  writeFileSync(installed, before);
  const out = composeFor("red-narrow", fx, fx.gen);
  assert.equal(out.ok, false, "an unfenced embedded protocol must refuse");
  if (!out.ok) {
    assert.ok(out.refusal.includes("red-narrow"));
    assert.ok(out.refusal.includes(installed));
    assert.ok(out.refusal.includes("## The review protocol"), "names the colliding section");
    assert.ok(/by hand/i.test(out.refusal));
  }
  assert.equal(readFileSync(installed, "utf8"), before, "the operator's file is untouched");
  assert.deepEqual(readdirSync(fx.agentDir).sort(), ["CLAUDE.md"]);
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: a `## ` heading inside a code fence is content, not an embedded protocol", () => {
  const fx = protocolFixture("red-backend");
  writeFileSync(
    join(fx.agentDir, "CLAUDE.md"),
    "# red-backend\n\nExample of what NOT to write:\n\n```md\n## The review protocol\n```\n",
  );
  const out = composeFor("red-backend", fx, fx.gen);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  rmSync(fx.root, { recursive: true, force: true });
});
