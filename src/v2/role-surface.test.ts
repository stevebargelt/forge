// FG-817: the Roles surface's pure derivations — which routes name a role and how, the
// composed-instructions content hash and the tier segmentation it is shown with.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeRoleInstructions,
  composedInstructionsHash,
  generationIdOfSource,
  roleDescription,
  roleMountMode,
  routesNamingRole,
  segmentComposedPrompt,
} from "./role-surface.js";
import { composeSystemPrompt } from "./compose.js";
import { invokeWorkflowShape } from "./invoke-shape.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";
import type { RoutingPolicy } from "../raci/policy-schema.js";

function route(responsible: string, consulted: string[] = [], followups: string[] = []) {
  return { responsible, path: "workflow" as const, consulted, required_followups: followups, informed: [], force_rules: [] };
}

const POLICY = {
  version: 1,
  governance: { accountable: "human" },
  routes: {
    "feature.build": route("engineer", ["tech-lead"], ["documentation-maintainer"]),
    "bug.fix": route("engineer"),
    "plan.review": route("tech-lead", ["engineer"], ["engineer"]),
    "docs.update": route("documentation-maintainer", ["engineer-helper"]),
  },
} as unknown as RoutingPolicy;

test("routesNamingRole: every route naming the role, with each relation it holds, in policy order", () => {
  assert.deepEqual(routesNamingRole(POLICY, "engineer"), [
    { route: "feature.build", path: "workflow", relations: ["responsible"] },
    { route: "bug.fix", path: "workflow", relations: ["responsible"] },
    { route: "plan.review", path: "workflow", relations: ["consulted", "followup"] },
  ]);
  assert.deepEqual(routesNamingRole(POLICY, "documentation-maintainer").map((r) => [r.route, r.relations]), [
    ["feature.build", ["followup"]],
    ["docs.update", ["responsible"]],
  ]);
});

test("routesNamingRole: exact names only, and no policy means no routes", () => {
  assert.deepEqual(routesNamingRole(POLICY, "engineer-helper").map((r) => r.route), ["docs.update"]);
  assert.deepEqual(routesNamingRole(POLICY, "red-wide"), []);
  assert.deepEqual(routesNamingRole(undefined, "engineer"), []);
});

test("composedInstructionsHash is the sha256 of the exact prompt bytes and moves with one byte", () => {
  const prompt = "# engineer\n\nYou implement.\n";
  assert.equal(composedInstructionsHash(prompt), createHash("sha256").update(prompt, "utf8").digest("hex"));
  assert.notEqual(composedInstructionsHash(prompt), composedInstructionsHash(prompt.replace("You", "you")));
});

const PROTOCOL = "# Protocol\n\nJudge by this.\n\n---\n\nStill protocol.";
const COMPOSED = [
  PROTOCOL,
  "# engineer\n\nYou implement. It quotes a heading:\n\n---\n\n# Constraints\n\nnot a real tier",
  "## Project-specific instructions (atlas)\n\nUse pnpm.",
  "# Workflow additions (step: task)\n\nFreeform.",
  "# Constraints\n\n## Constraint: no-ai-attribution\n\nNo trailers.\n\n## Constraint: conventions\n\nBe terse.",
  "## Output contract\n\nWrite result.json.",
].join("\n\n---\n\n") + "\n";

test("segmentComposedPrompt tiles the prompt exactly and marks protocol, addendum and each constraint", () => {
  const sections = segmentComposedPrompt(COMPOSED, { protocolLength: PROTOCOL.length });
  assert.equal(sections.map((s) => COMPOSED.slice(s.start, s.end)).join(""), COMPOSED, "the sections are the prompt, byte for byte");
  assert.deepEqual(sections.map((s) => s.id ? `${s.kind}:${s.id}` : s.kind), [
    "protocol", "base", "addendum", "workflow", "constraint:no-ai-attribution", "constraint:conventions", "framing",
  ]);
  const base = sections.find((s) => s.kind === "base")!;
  assert.match(COMPOSED.slice(base.start, base.end), /not a real tier/, "a heading quoted in the seed stays in the seed");
  assert.equal(COMPOSED.slice(sections[0]!.start, sections[0]!.end), PROTOCOL);
});

test("segmentComposedPrompt: an uncovered role with no addendum or constraints is base then framing", () => {
  const prompt = "# tech-lead\n\nPlans.\n\n---\n\n# Workflow additions (step: task)\n\nx\n\n---\n\n## Output contract\n\ny\n";
  const sections = segmentComposedPrompt(prompt, { protocolLength: 0 });
  assert.deepEqual(sections.map((s) => s.kind), ["base", "workflow", "framing"]);
  assert.equal(sections.map((s) => prompt.slice(s.start, s.end)).join(""), prompt);
});

test("roleDescription is the seed's first paragraph after its title", () => {
  assert.equal(roleDescription("# engineer\n\nYou implement the plan,\none step at a time.\n\n## More\n\nx"), "You implement the plan, one step at a time.");
  assert.equal(roleDescription("# empty\n"), "");
});

test("roleMountMode: reds and the rechecker read-only, blues read-write, each naming why", () => {
  const reds = new Set(["shipping-reviewer"]);
  assert.equal(roleMountMode("shipping-reviewer", reds).mode, "ro");
  assert.equal(roleMountMode("review-rechecker", reds).mode, "ro");
  assert.equal(roleMountMode("red-wide", new Set()).mode, "ro");
  const engineer = roleMountMode("engineer", reds);
  assert.equal(engineer.mode, "rw");
  assert.ok(engineer.source.length > 0);
});

test("composeRoleInstructions composes through composeSystemPrompt: same bytes, hash of those bytes, marked sections", () => {
  const home = mkdtempSync(join(tmpdir(), "fg817-compose-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  mkdirSync(join(home, "agents", "engineer"), { recursive: true });
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "# engineer\n\nYou implement the plan.\n");
  mkdirSync(join(home, "constraints"), { recursive: true });
  writeFileSync(join(home, "constraints", "be-terse.md"), "---\nid: be-terse\nlevel: suggest\n---\n\nBe terse.\n");

  const shown = composeRoleInstructions({ home, role: "engineer", generation: gen, mountMode: "rw" });
  assert.equal(shown.ok, true, shown.ok ? "" : shown.refusal);
  if (!shown.ok) return;
  const { step, workflow } = invokeWorkflowShape("engineer", undefined, undefined);
  const direct = composeSystemPrompt({
    role: "engineer", workflow, step, seedGeneration: gen,
    agentDir: join(home, "agents", "engineer"), constraintsDir: join(home, "constraints"), projectMode: "rw",
  });
  assert.equal(direct.ok && direct.prompt, shown.prompt, "the page shows exactly what dispatch composes");
  assert.equal(shown.sha256, createHash("sha256").update(shown.prompt, "utf8").digest("hex"));
  assert.equal(shown.sections.map((s) => shown.prompt.slice(s.start, s.end)).join(""), shown.prompt);
  assert.deepEqual(shown.sections.map((s) => s.id ? `${s.kind}:${s.id}` : s.kind), ["protocol", "base", "workflow", "constraint:be-terse", "framing"]);
  assert.ok(shown.protocol && /^[0-9a-f]{64}$/.test(shown.protocol.sha256), "engineer is a covered role: its protocol is stamped");
  assert.match(shown.prompt, /## Task checklist/, "a read-write mount carries the write-mode framing");
});

test("composeRoleInstructions anchored at a project composes its addendum as dispatch does, marked and hashed apart from host-only", () => {
  const home = mkdtempSync(join(tmpdir(), "fg817-compose-proj-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  mkdirSync(join(home, "agents", "engineer"), { recursive: true });
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "# engineer\n\nYou implement the plan.\n");
  const project = mkdtempSync(join(tmpdir(), "fg817-compose-proj-dir-"));
  mkdirSync(join(project, ".forge", "agents", "engineer"), { recursive: true });
  writeFileSync(join(project, ".forge", "agents", "engineer", "CLAUDE.md"), "Use pnpm here.\n");

  const hostOnly = composeRoleInstructions({ home, role: "engineer", generation: gen, mountMode: "rw" });
  const anchored = composeRoleInstructions({ home, role: "engineer", generation: gen, mountMode: "rw", project: { key: "repo-x", dir: project } });
  assert.ok(hostOnly.ok && anchored.ok);
  if (!hostOnly.ok || !anchored.ok) return;
  const { step, workflow } = invokeWorkflowShape("engineer", undefined, undefined);
  const direct = composeSystemPrompt({
    role: "engineer", workflow, step, seedGeneration: gen,
    agentDir: join(home, "agents", "engineer"), constraintsDir: join(home, "constraints"), projectDir: project, projectMode: "rw",
  });
  assert.equal(direct.ok && direct.prompt, anchored.prompt, "the page shows exactly what dispatch against the project composes");
  assert.deepEqual(anchored.sections.map((s) => s.kind), ["protocol", "base", "addendum", "workflow", "framing"]);
  const addendum = anchored.sections.find((s) => s.kind === "addendum")!;
  assert.equal(addendum.title, "Project addendum");
  assert.match(anchored.prompt.slice(addendum.start, addendum.end), /Use pnpm here\./);
  assert.ok(!hostOnly.sections.some((s) => s.kind === "addendum"));
  assert.notEqual(anchored.sha256, hostOnly.sha256);
  assert.equal(anchored.sha256, createHash("sha256").update(anchored.prompt, "utf8").digest("hex"));
  assert.match(anchored.context, /project repo-x anchored at /);
  assert.match(hostOnly.context, /no project anchored/);
});

test("generationIdOfSource resolves the generation across a symlinked FORGE_HOME in either direction", () => {
  const base = mkdtempSync(join(tmpdir(), "fg817-symlink-"));
  const real = join(base, "real-home");
  const link = join(base, "link-home");
  const protocol = join(real, "seed-generations", "gen-abc", "agents", "engineer", "AGENT.md");
  mkdirSync(join(protocol, ".."), { recursive: true });
  writeFileSync(protocol, "# engineer\n");
  symlinkSync(real, link, "dir");
  const canonical = realpathSync(protocol);
  const viaLink = join(link, "seed-generations", "gen-abc", "agents", "engineer", "AGENT.md");

  assert.equal(generationIdOfSource(link, canonical), "gen-abc");
  assert.equal(generationIdOfSource(real, viaLink), "gen-abc");
  assert.equal(generationIdOfSource(link, viaLink), "gen-abc");
  const pruned = join(realpathSync(real), "seed-generations", "gen-gone", "agents", "engineer", "AGENT.md");
  assert.equal(generationIdOfSource(link, pruned), "gen-gone");
  assert.equal(generationIdOfSource(link, join(base, "elsewhere", "AGENT.md")), null);
  assert.equal(generationIdOfSource(link, join(link, "seed-generations")), null);
});
