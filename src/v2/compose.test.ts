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
