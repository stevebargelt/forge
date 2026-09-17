// FG-795 — exercise the shipped Sonnet 5 defaults through the same install,
// seed-generation, and resolver chain that dispatch uses. The fs guard covers
// seed text; these tests prove the installed seeds are the resolver's inputs.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModel } from "./model-resolution.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

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
    ["claude-oauth", "spec-writer", "claude-opus-4-8"],
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

test("a project copy of the shipped policy resolves review and default through subscription and Bedrock profiles", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  copyFileSync(shippedPolicy, join(projectDir, ".forge", "model-policy.yml"));

  for (const [profile, expectedModel] of [
    ["claude-subscription", "claude-sonnet-5"],
    ["claude-bedrock", "us.anthropic.claude-sonnet-5"],
  ] as const) {
    for (const alias of ["review", "default"]) {
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
