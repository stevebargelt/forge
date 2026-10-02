// FG-795 — exercise the shipped Sonnet 5 defaults through the same install,
// seed-generation, and resolver chain that dispatch uses. The fs guard covers
// seed text; these tests prove the installed seeds are the resolver's inputs.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModel } from "./model-resolution.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { offerableChoices } from "./model-policy-choices.js";
import { runUpgrade } from "../cli/commands/upgrade.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shippedPolicy = join(repoRoot, "seeds", "model-policy.example.yml");

let homeDir: string;
let projectDir: string;
let savedForgeHome: string | undefined;

function installShippedRuntimes(): void {
  const result = spawnSync("bash", [join(repoRoot, "scripts", "install-seeds.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      FORGE_HOME: homeDir,
      CLAUDE_SKILLS_DEST: join(homeDir, "claude-skills"),
    },
  });
  assert.equal(result.status, 0, `install-seeds.sh failed: ${result.stderr}`);

  // The installer writes the flat runtime surface; dispatch consumes its atomically
  // published counterpart. Publish that installed surface rather than a fixture.
  publishFlatAsGeneration(homeDir, { assetsParent: homeDir });
}

function resolve(runtimeName: string, alias: string) {
  return resolveModel({
    agentRole: "engineer",
    runtimeName,
    stepAlias: alias,
    ctx: { projectDir },
  });
}

beforeEach(() => {
  savedForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "fg795-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg795-project-"));
  process.env.FORGE_HOME = homeDir;
  installShippedRuntimes();
});

afterEach(() => {
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("legacy installed runtime seeds resolve Sonnet 5 defaults without changing Opus or Haiku aliases", () => {
  const expected = [
    ["claude-oauth", "default", "claude-sonnet-5"],
    // OAuth deliberately retains its premium spec-writer alias.
    ["claude-oauth", "spec-writer", "claude-opus-5-5"],
    ["claude-oauth", "fast-orchestrator", "claude-haiku-4-5"],
    ["claude-apikey", "default", "claude-sonnet-5"],
    ["claude-apikey", "spec-writer", "claude-sonnet-5"],
    ["claude-apikey", "fast-orchestrator", "claude-haiku-4-5"],
    ["claude-bedrock", "default", "us.anthropic.claude-sonnet-5"],
    ["claude-bedrock", "spec-writer", "us.anthropic.claude-sonnet-5"],
    ["claude-bedrock", "fast-orchestrator", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
  ] as const;

  for (const [runtime, alias, model] of expected) {
    const resolution = resolve(runtime, alias);
    assert.equal(resolution.resolvedBy, "legacy");
    assert.equal(resolution.model, model, `${runtime}.${alias}`);
  }
});

test("FG-803: forge upgrade replaces the installed Claude OAuth runtime and dispatch resolves its Opus 5.5 spec-writer", () => {
  const installed = join(homeDir, "runtimes", "claude-oauth.yml");
  const shipped = join(repoRoot, "seeds", "runtimes", "claude-oauth.yml");

  // A stale host runtime is the actual upgrade case: the command must overwrite
  // it, publish the new generation, and leave dispatch reading that generation.
  writeFileSync(installed, readFileSync(shipped, "utf8").replace("claude-opus-5-5", "claude-opus-4-8"));

  const before = process.exitCode;
  const previousSkillsDest = process.env.CLAUDE_SKILLS_DEST;
  process.exitCode = undefined;
  process.env.CLAUDE_SKILLS_DEST = join(homeDir, "claude-skills");
  try {
    const result = runUpgrade(
      { skipGit: true, skipNpm: true, skipProject: true },
      { mode: "dev", assetsDir: repoRoot, devDir: repoRoot },
    );
    assert.equal(result.ok, true, `forge upgrade left unresolved work: ${result.unresolved.join(", ")}`);
    assert.equal(result.assetInstall, "installed");
    assert.equal(result.seedGeneration, "published");
  } finally {
    process.exitCode = before;
    if (previousSkillsDest === undefined) delete process.env.CLAUDE_SKILLS_DEST;
    else process.env.CLAUDE_SKILLS_DEST = previousSkillsDest;
  }

  assert.equal(readFileSync(installed, "utf8"), readFileSync(shipped, "utf8"), "upgrade installs the shipped runtime bytes");
  const resolution = resolve("claude-oauth", "spec-writer");
  assert.equal(resolution.resolvedBy, "legacy");
  assert.equal(resolution.model, "claude-opus-5-5");
});

test("FG-803: the operator-facing Anthropic subscription choice derives Opus 5.5 from the seed, never a legacy Opus id", () => {
  const choices = offerableChoices([
    { provider: "anthropic", mode: "subscription", status: "available", detail: "OAuth volume has credentials" },
  ]);
  const opus = choices.find((choice) => choice.profileName === "anthropic-subscription-opus");

  assert.ok(opus, "the model-policy choices surface must offer the subscription Opus family");
  assert.equal(opus.model, "claude-opus-5-5");
  for (const choice of choices) {
    assert.doesNotMatch(choice.model, /claude-opus-4-8\b|claude-opus-5(?![-.\d])/);
  }
});

test("a project copy of the shipped policy resolves review and default through subscription and Bedrock profiles", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  copyFileSync(shippedPolicy, join(projectDir, ".forge", "model-policy.yml"));

  // FG-807: the subscription review row moved to Opus 5.5 at low effort; Bedrock keeps Sonnet.
  for (const [profile, alias, expectedModel] of [
    ["claude-subscription", "review", "claude-opus-5-5"],
    ["claude-subscription", "default", "claude-sonnet-5"],
    // FG-803: reasoning/spec-writer name Opus 5.5 in every Opus-carrying profile.
    ["claude-subscription", "reasoning", "claude-opus-5-5"],
    ["claude-subscription", "spec-writer", "claude-opus-5-5"],
    ["claude-api", "reasoning", "claude-opus-5-5"],
    ["claude-api", "spec-writer", "claude-opus-5-5"],
    ["claude-bedrock", "review", "us.anthropic.claude-sonnet-5"],
    ["claude-bedrock", "default", "us.anthropic.claude-sonnet-5"],
  ] as const) {
    const resolution = resolveModel({
      agentRole: "engineer",
      stepAlias: alias,
      cliProfile: profile,
      ctx: { projectDir },
    });
    assert.equal(resolution.profile, profile);
    assert.equal(resolution.model, expectedModel, `${profile}.${alias}`);
    assert.equal(resolution.resolvedBy, "cli.--profile");
  }
});

test("a project policy pin to Sonnet 4.6 overrides the shipped Sonnet 5 default", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), `
schema_version: 2
on_unavailable: fail
model_profiles:
  pinned-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
      review: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: pinned-subscription
  activity:
    review: pinned-subscription
overrides:
  agents: {}
allowed_profiles: [pinned-subscription]
`);

  const resolution = resolveModel({ agentRole: "engineer", ctx: { projectDir } });
  assert.equal(resolution.resolvedBy, "defaults.profile");
  assert.equal(resolution.model, "claude-sonnet-4-6");
});

test("a project policy pin to Opus 4.8 overrides the shipped Opus 5.5 default", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), `
schema_version: 2
on_unavailable: fail
model_profiles:
  pinned-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-5, cost_tier: standard }
      spec-writer: { model: claude-opus-4-8, cost_tier: premium }
      review: { model: claude-opus-4-8, cost_tier: premium }
defaults:
  profile: pinned-subscription
  activity:
    review: pinned-subscription
overrides:
  agents: {}
allowed_profiles: [pinned-subscription]
`);

  const resolution = resolveModel({ agentRole: "engineer", stepAlias: "spec-writer", ctx: { projectDir } });
  assert.equal(resolution.resolvedBy, "defaults.profile");
  assert.equal(resolution.model, "claude-opus-4-8");
});
