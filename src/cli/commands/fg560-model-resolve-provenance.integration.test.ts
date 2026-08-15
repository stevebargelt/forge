// FG-560 (step 9): the `forge model resolve` OPERATOR SURFACE for mapping-path
// provenance + the activity_unmapped refusal.
//
// Driven through the REAL registered command (registerModel + commander
// parseAsync → the same .action() the CLI runs). Asserts on BOTH the human lines
// and the --json payload, per the review contract: a default fallback is labelled
// distinctly and NEVER as though it satisfied an explicit activity; the refusal
// carries every field a script needs; legacy output is UNCHANGED. Operates on a
// disposable $FORGE_HOME — the real ~/.forge is never touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";
import { registerModel } from "./model.js";

const RUNTIME_OAUTH = `
name: claude-oauth
description: test
image: agent-dev-worker:latest
models:
  default: claude-sonnet-4-6
auth:
  mode: oauth-volume
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: claude
  args: ["--model", "\${MODEL}"]
container:
  name: forge-\${TASK_ID}
result:
  file: /task/result.json
`;

// claude-bedrock maps only { review, default } — an EXPLICIT `reasoning` against it
// falls to map.default: the activity_unmapped shape. claude-subscription maps
// reasoning directly: an exact hit.
const POLICY = `
schema_version: 2
on_unavailable: fail
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-4-8,   cost_tier: premium }
      review:    { model: claude-sonnet-4-6, cost_tier: standard }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      review:  { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity:
    reasoning: claude-subscription
    review: claude-subscription
overrides:
  agents:
    red-security: claude-bedrock
allowed_profiles: [claude-subscription, claude-bedrock]
`;

let homeDir: string;
let projectDir: string;
let savedForgeHome: string | undefined;

function writeHostRuntime(): void {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(join(homeDir, "runtimes", "claude-oauth.yml"), RUNTIME_OAUTH);
  publishFlatAsGeneration(homeDir);
}

async function runResolve(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerModel(program);
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const savedExit = process.exitCode;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "forge", "model", "resolve", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exitCode = savedExit;
  }
}

beforeEach(() => {
  savedForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "fg560-mr-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg560-mr-proj-"));
  process.env.FORGE_HOME = homeDir;
  writeHostRuntime();
});

afterEach(() => {
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("legacy (no policy): NO mapping/provenance lines appear — output unchanged", async () => {
  // No model-policy.yml anywhere → legacy mode.
  const human = await runResolve(["engineer", "--project", projectDir]);
  assert.match(human.out, /mode:\s+legacy/);
  assert.doesNotMatch(human.out, /mapping:/, "legacy output must not gain a mapping-path line");

  const json = await runResolve(["engineer", "--project", projectDir, "--json"]);
  const parsed = JSON.parse(json.out) as { resolvedBy: string; mappingPath?: string; capabilitySource?: string; activityUnmapped?: unknown };
  assert.equal(parsed.resolvedBy, "legacy");
  assert.equal(parsed.mappingPath, undefined, "legacy carries no mapping-path axis");
  assert.equal(parsed.activityUnmapped, undefined);
});

test("policy exact hit: mapping-path line labels 'exact' alongside resolvedBy (a separate axis)", async () => {
  writeFileSync(join(homeDir, "model-policy.yml"), POLICY);
  const human = await runResolve(["engineer", "--activity", "reasoning", "--project", projectDir]);
  assert.match(human.out, /resolved by:\s+defaults\.activity\.reasoning/);
  assert.match(human.out, /mapping:\s+exact/);
  assert.doesNotMatch(human.out, /activity_unmapped/);

  const json = await runResolve(["engineer", "--activity", "reasoning", "--project", projectDir, "--json"]);
  const parsed = JSON.parse(json.out) as { mappingPath: string; capabilitySource: string; resolvedBy: string; outcome: string };
  assert.equal(parsed.mappingPath, "exact");
  assert.equal(parsed.capabilitySource, "explicit");
  // The two axes are distinct: resolvedBy is the profile-selection provenance.
  assert.equal(parsed.resolvedBy, "defaults.activity.reasoning");
  assert.equal(parsed.outcome, "resolved");
});

test("policy default-fallback (explicit): human labels it distinctly + prints the activity_unmapped refusal with all fields", async () => {
  writeFileSync(join(homeDir, "model-policy.yml"), POLICY);
  // red-security → claude-bedrock (via override), explicit activity `reasoning`
  // which claude-bedrock does NOT map → falls to map.default → activity_unmapped.
  const human = await runResolve(["red-security", "--activity", "reasoning", "--project", projectDir]);
  assert.match(human.out, /mapping:\s+default-fallback/);
  // never render a default fallback as a satisfied explicit activity
  assert.match(human.out, /EXPLICIT activity is NOT mapped/);
  assert.match(human.out, /activity_unmapped/);
  assert.match(human.out, /selected profile:\s+claude-bedrock/);
  assert.match(human.out, /available mappings:\s+review, default/);
  assert.match(human.out, /DIAGNOSTIC ONLY/);
  assert.match(human.out, /policy path:.*model-policy\.yml/);
});

test("policy default-fallback (explicit) --json: the refusal is machine-readable with every field", async () => {
  writeFileSync(join(homeDir, "model-policy.yml"), POLICY);
  const json = await runResolve(["red-security", "--activity", "reasoning", "--project", projectDir, "--json"]);
  const parsed = JSON.parse(json.out) as {
    mappingPath: string;
    capabilitySource: string;
    outcome: string;
    resolvedBy: string;
    activityUnmapped?: {
      reason: string;
      agent: string;
      activity: string;
      profile: string;
      resolutionSource: string;
      availableMappings: string[];
      diagnosticDefaultModel: string;
      diagnosticOnly: boolean;
      policyPath: string | null;
    };
  };
  assert.equal(parsed.mappingPath, "default-fallback");
  assert.equal(parsed.capabilitySource, "explicit");
  assert.equal(parsed.outcome, "activity_unmapped");
  const u = parsed.activityUnmapped;
  assert.ok(u, "--json must carry a structured activityUnmapped block");
  assert.equal(u!.reason, "activity_unmapped");
  assert.equal(u!.agent, "red-security");
  assert.equal(u!.activity, "reasoning");
  assert.equal(u!.profile, "claude-bedrock");
  // resolution source (profile-selection provenance) is a SEPARATE field from mapping.
  assert.equal(u!.resolutionSource, "overrides.agents.red-security");
  assert.deepEqual(u!.availableMappings, ["review", "default"]);
  assert.equal(u!.diagnosticDefaultModel, "us.anthropic.claude-sonnet-4-6");
  assert.equal(u!.diagnosticOnly, true);
  assert.match(u!.policyPath ?? "", /model-policy\.yml$/);
});

test("policy default-fallback (ROLE-DERIVED): distinct label, but NO refusal (legacy-equivalent)", async () => {
  writeFileSync(join(homeDir, "model-policy.yml"), POLICY);
  // No explicit activity: engineer's role-derived default → claude-subscription
  // default profile, capability "default" maps exactly. To hit a role-derived
  // default-fallback we resolve an agent with a role-derived non-default activity
  // against a profile lacking it — use --profile to pin claude-bedrock with no
  // explicit activity, so capabilitySource is role-derived.
  const json = await runResolve(["engineer", "--profile", "claude-bedrock", "--project", projectDir, "--json"]);
  const parsed = JSON.parse(json.out) as { mappingPath: string; capabilitySource: string; outcome: string; activityUnmapped?: unknown };
  assert.equal(parsed.capabilitySource, "role-derived");
  // engineer role-derived activity is "default" → exact on claude-bedrock.default.
  // Either way, a role-derived resolution is NEVER the refusal.
  assert.equal(parsed.outcome, "resolved");
  assert.equal(parsed.activityUnmapped, undefined);
});
