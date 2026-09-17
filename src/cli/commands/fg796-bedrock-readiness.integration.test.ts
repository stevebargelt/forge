// FG-796 end-to-end coverage: exercise the shipped CLI with isolated homes and
// deterministic credential signals. These cases deliberately never inherit an
// operator's OAuth/Codex/AWS state.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ModelPolicySchema, type ModelPolicy } from "../../v2/schema.js";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";
import { REPO_ROOT, NODE_EXEC, BUILT_CLI_ENTRY } from "../../integration-cli-spawn.js";

let root: string;
let forgeHome: string;
let fakeHome: string;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-fg796-"));
  forgeHome = join(root, "forge-home");
  fakeHome = join(root, "fake-home");
  projectDir = join(root, "project");
  for (const dir of [forgeHome, fakeHome, projectDir]) mkdirSync(dir, { recursive: true });

  // Make doctor see a complete, current host seed install without accessing a
  // real host home. The published generation is the production authority.
  for (const dir of ["workflows", "runtimes", "codex", "agents", "constraints"]) {
    cpSync(join(REPO_ROOT, "seeds", dir), join(forgeHome, dir), { recursive: true });
  }
  cpSync(join(REPO_ROOT, "seeds", "forge-raci.md"), join(forgeHome, "forge-raci.md"));
  cpSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), join(forgeHome, "model-policy.example.yml"));
  publishFlatAsGeneration(forgeHome, { raciPath: join(forgeHome, "forge-raci.md"), assetsParent: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runForge(args: string[], host: "bedrock" | "subscription") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_HOME: forgeHome,
    HOME: fakeHome,
    FORGE_AWS_DIR: join(fakeHome, ".aws"),
    FORGE_CODEX_DIR: join(fakeHome, ".codex"),
    NO_NOTIFY: "true",
    ANTHROPIC_API_KEY: "",
    AWS_PROFILE: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
  };
  if (host === "bedrock") {
    env.AWS_PROFILE = "fg796-bedrock";
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    // The fake probe says the OAuth volume was checked and has no credentials:
    // this is distinct from inheriting an uncheckable real host volume.
    writeFileSync(
      join(forgeHome, "oauth-hint.json"),
      JSON.stringify({ volumeName: "forge-claude-oauth-v2", writtenAt: new Date().toISOString(), credsPresent: false }),
    );
  } else {
    writeFileSync(
      join(forgeHome, "oauth-hint.json"),
      JSON.stringify({ volumeName: "forge-claude-oauth-v2", writtenAt: new Date().toISOString(), credsPresent: true }),
    );
  }
  return spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, ...args], { cwd: projectDir, encoding: "utf8", env });
}

function readPolicy(): ModelPolicy {
  const path = join(forgeHome, "model-policy.yml");
  assert.ok(existsSync(path), "setup must write the host model policy");
  return ModelPolicySchema.parse(parseYaml(readFileSync(path, "utf8")));
}

function assertAllDefaultCapabilitiesUse(policy: ModelPolicy, profile: string): void {
  assert.equal(policy.defaults.profile, profile);
  for (const [capability, actual] of Object.entries(policy.defaults.activity)) {
    assert.match(actual, /^anthropic-bedrock-/, `defaults.activity.${capability} must use a Bedrock profile`);
  }
}

test("integ FG-796: bedrock-only setup generates a bedrock-only policy and doctor is ready", () => {
  const setup = runForge(["setup", "--yes"], "bedrock");
  assert.equal(setup.status, 0, `setup failed\n${setup.stdout}\n${setup.stderr}`);

  const policy = readPolicy();
  const bedrock = "anthropic-bedrock-sonnet";
  assertAllDefaultCapabilitiesUse(policy, bedrock);
  for (const profile of Object.values(policy.overrides.agents)) {
    assert.match(profile, /^anthropic-bedrock-/, "generated pins must not name an unavailable provider");
  }

  const doctor = runForge(["doctor"], "bedrock");
  assert.equal(doctor.status, 0, `doctor failed\n${doctor.stdout}\n${doctor.stderr}`);
  assert.match(doctor.stdout, /Overall: OK \(no blocking failures\)/);
  assert.doesNotMatch(doctor.stdout, /forge auth login/, "a reachable Bedrock policy must not advise OAuth login");
});

test("integ FG-796: seed-shaped pins report their reachability and reconfigure repairs a Bedrock host", () => {
  const seed = readFileSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), "utf8")
    .replace("profile: claude-subscription", "profile: claude-subscription")
    .replace("agents: {}", "agents:\n    red-wide: codex-subscription\n    research-skeptic: codex-subscription");
  // Restore the pre-FG-796 default activity shape too: all activity entries are
  // already subscription in the example; the explicit default pin is the key AC.
  writeFileSync(join(forgeHome, "model-policy.yml"), seed);

  const before = runForge(["doctor"], "bedrock");
  assert.equal(before.status, 1, `seed-shaped policy must block\n${before.stdout}`);
  assert.match(before.stdout, /claude-subscription/);
  assert.match(before.stdout, /defaults\.profile/);
  assert.match(before.stdout, /forge setup --reconfigure/);
  const subscriptionAdvice = before.stdout.split("\n").find((line) => line.includes("re-point to an available anthropic profile")) ?? "";
  assert.doesNotMatch(subscriptionAdvice, /forge auth login/, "the remediation, not the credential detail, must prefer reconfigure");
  assert.match(before.stdout, /codex-subscription/);
  assert.match(before.stdout, /overrides\.agents\.red-wide/);
  assert.match(before.stdout, /remove or re-point the pin\(s\).*overrides\.agents\.red-wide/);

  // A complete headless selection is the non-TTY equivalent of accepting the
  // wizard's preselected answers; unavailable seed selections are dropped.
  const repaired = runForge(["setup", "--yes", "--reconfigure", "--default-profile", "anthropic-bedrock-sonnet"], "bedrock");
  assert.equal(repaired.status, 0, `reconfigure failed\n${repaired.stdout}\n${repaired.stderr}`);
  const policy = readPolicy();
  assertAllDefaultCapabilitiesUse(policy, "anthropic-bedrock-sonnet");
  assert.ok(!Object.values(policy.overrides.agents).some((p) => p.includes("codex")), "Codex pins are dropped");

  const after = runForge(["doctor"], "bedrock");
  assert.equal(after.status, 0, `repaired host must be ready\n${after.stdout}`);
  assert.match(after.stdout, /Overall: OK/);
});

test("integ FG-796: subscription-only setup stays ready while Bedrock is opt-in", () => {
  const setup = runForge(["setup", "--yes"], "subscription");
  assert.equal(setup.status, 0, `setup failed\n${setup.stdout}\n${setup.stderr}`);
  const policy = readPolicy();
  assert.match(policy.defaults.profile, /^anthropic-subscription-/);
  assert.ok(!Object.values(policy.overrides.agents).some((p) => p.includes("codex")), "no Codex pin without Codex auth");

  // Generated policies contain only chosen profiles. Add the shipped Bedrock
  // profile as an operator-selectable, non-default opt-in before exercising the
  // real doctor distinction between warnings and blocking reachability.
  const seed = parseYaml(readFileSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), "utf8")) as ModelPolicy;
  policy.model_profiles["claude-bedrock"] = seed.model_profiles["claude-bedrock"]!;
  writeFileSync(join(forgeHome, "model-policy.yml"), `${JSON.stringify(policy)}\n`);

  const doctor = runForge(["doctor"], "subscription");
  assert.equal(doctor.status, 0, `doctor failed\n${doctor.stdout}`);
  assert.match(doctor.stdout, /! auth claude-bedrock \(anthropic\/bedrock\)/, "unavailable Bedrock remains a non-blocking opt-in warning");
  assert.match(doctor.stdout, /Overall: OK/);
});

test("integ FG-796: setup review-loop default follows policy review then defaults.profile", () => {
  const policyPath = join(forgeHome, "model-policy.yml");
  runForge(["setup", "--yes"], "bedrock");
  let policy = readPolicy();
  policy.defaults.activity.review = "anthropic-bedrock-haiku";
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);

  const review = runForge(["setup"], "bedrock");
  assert.match(review.stdout, /review-loop reviewer \(anthropic-bedrock-haiku\)[\s\S]*default from defaults\.activity\.review/);

  policy = readPolicy();
  delete policy.defaults.activity.review;
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
  const fallback = runForge(["setup"], "bedrock");
  assert.match(fallback.stdout, /review-loop reviewer \(anthropic-bedrock-sonnet\)[\s\S]*default from defaults\.profile/);
});
