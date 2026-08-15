// Two-pass resolver tests (AWN-7 Crawl): legacy fallback, capability pass,
// profile precedence, effective-auth resolution, runtime binding, fail-loud.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveModel,
  detectAuthMode,
  isActivityUnmapped,
  activityUnmappedMessage,
} from "./model-resolution.js";

const RUNTIME_OAUTH = `
name: claude-oauth
description: test
image: agent-dev-worker:latest
models:
  spec-writer: claude-opus-4-8
  fast-orchestrator: claude-haiku-4-5
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

const POLICY = `
on_unavailable: fail
schema_version: 2
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-4-8,   cost_tier: premium }
      review:    { model: claude-sonnet-4-6, cost_tier: standard }
      fast:      { model: claude-haiku-4-5,  cost_tier: cheap }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      review:  { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
  claude-auto:
    provider: anthropic
    auth: auto
    map:
      review:  { model: claude-sonnet-4-6, cost_tier: standard }
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity:
    reasoning: claude-subscription
    review: claude-subscription
overrides:
  agents:
    red-security: claude-bedrock
allowed_profiles: [claude-subscription, claude-bedrock, claude-auto]
`;

let originalForgeHome: string | undefined;
let envSnap: Record<string, string | undefined>;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  envSnap = {
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  for (const k of Object.keys(envSnap)) delete process.env[k];
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-mr-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-v2-mr-proj-"));
  process.env.FORGE_HOME = homeDir;
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeRuntime() {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(join(homeDir, "runtimes", "claude-oauth.yml"), RUNTIME_OAUTH);
  // FG-583: dispatch reads only a published generation — publish the flat runtime.
  publishFlatAsGeneration(homeDir);
}
function writePolicy() {
  writeFileSync(join(homeDir, "model-policy.yml"), POLICY);
}

// ---- Legacy mode (no policy file) ----

test("legacy: no policy → runtime.models[alias], policy fields undefined", () => {
  writeRuntime();
  const r = resolveModel({ agentRole: "engineer", stepAlias: "spec-writer", runtimeName: "claude-oauth" });
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.resolvedBy, "legacy");
  assert.equal(r.profile, undefined);
  assert.equal(r.provider, undefined);
  assert.equal(r.auth, undefined);
  assert.equal(r.alias, undefined);
  assert.equal(r.runtime, "claude-oauth");
});

test("legacy: undefined alias → runtime default", () => {
  writeRuntime();
  const r = resolveModel({ agentRole: "engineer", runtimeName: "claude-oauth" });
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.resolvedBy, "legacy");
});

// ---- Policy mode: profile precedence ----

test("policy: --profile beats everything", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "red-security", stepAlias: "review", cliProfile: "claude-subscription" });
  assert.equal(r.profile, "claude-subscription");
  assert.equal(r.resolvedBy, "cli.--profile");
  assert.equal(r.model, "claude-sonnet-4-6");
});

test("policy: profileSource labels the cliProfile provenance (run.profile vs default cli.--profile)", () => {
  writePolicy();
  // forge new --profile pins the whole run → run.profile provenance.
  const run = resolveModel({ agentRole: "red-security", stepAlias: "review", cliProfile: "claude-subscription", profileSource: "run.profile" });
  assert.equal(run.profile, "claude-subscription");
  assert.equal(run.resolvedBy, "run.profile");
  // Same precedence, just a different recorded source label.
  assert.equal(run.model, "claude-sonnet-4-6");
});

test("policy: profileSource is ignored when no cliProfile is set", () => {
  writePolicy();
  // red-security has an agent override; profileSource must NOT relabel it.
  const r = resolveModel({ agentRole: "red-security", stepAlias: "review", profileSource: "run.profile" });
  assert.equal(r.profile, "claude-bedrock");
  assert.equal(r.resolvedBy, "overrides.agents.red-security");
});

test("policy: overrides.agents beats defaults.activity", () => {
  writePolicy();
  // red-security default activity is "review"; defaults.activity.review →
  // claude-subscription, but overrides.agents.red-security → claude-bedrock wins.
  const r = resolveModel({ agentRole: "red-security" });
  assert.equal(r.profile, "claude-bedrock");
  assert.equal(r.resolvedBy, "overrides.agents.red-security");
  assert.equal(r.alias, "review"); // from the agent default-activity map
  assert.equal(r.model, "us.anthropic.claude-sonnet-4-6");
  assert.equal(r.provider, "anthropic");
  assert.equal(r.auth, "bedrock");
  assert.equal(r.runtime, "claude-bedrock");
  assert.equal(r.costTier, "standard");
});

test("policy: defaults.activity[capability] when no agent override", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "engineer", stepAlias: "reasoning" });
  assert.equal(r.profile, "claude-subscription");
  assert.equal(r.resolvedBy, "defaults.activity.reasoning");
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.costTier, "premium");
});

test("policy: defaults.profile is the ultimate fallback", () => {
  writePolicy();
  // capability "fast" has no defaults.activity entry → defaults.profile.
  const r = resolveModel({ agentRole: "engineer", stepAlias: "fast" });
  assert.equal(r.profile, "claude-subscription");
  assert.equal(r.resolvedBy, "defaults.profile");
  assert.equal(r.model, "claude-haiku-4-5");
});

// ---- Pass 1: capability resolution ----

test("policy: step alias is the capability intent", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "engineer", stepAlias: "review" });
  assert.equal(r.alias, "review");
});

test("policy: no step alias → agent default activity", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "tech-lead" }); // maps to "reasoning"
  assert.equal(r.alias, "reasoning");
  assert.equal(r.model, "claude-opus-4-8");
});

test("policy: unlisted role with no alias → 'default' capability", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "engineer" });
  assert.equal(r.alias, "default");
  // defaults.activity has no "default" → defaults.profile → map.default
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.resolvedBy, "defaults.profile");
});

// ---- Effective auth ----

test("policy: auth: auto resolves to subscription under bedrock hard-off + no apikey", () => {
  writePolicy();
  // Hard-off makes detection deterministic regardless of host ~/.aws config.
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  const r = resolveModel({ agentRole: "engineer", stepAlias: "review", cliProfile: "claude-auto" });
  assert.equal(r.auth, "subscription");
  assert.equal(r.runtime, "claude-oauth");
});

test("policy: auth: auto resolves to bedrock when CLAUDE_CODE_USE_BEDROCK=1", () => {
  writePolicy();
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const r = resolveModel({ agentRole: "engineer", stepAlias: "review", cliProfile: "claude-auto" });
  assert.equal(r.auth, "bedrock");
  assert.equal(r.runtime, "claude-bedrock");
  // effective auth is recorded, never "auto"
  assert.notEqual(r.auth, "auto");
});

test("policy: pinned auth is NOT overridden by env detection", () => {
  writePolicy();
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const r = resolveModel({ agentRole: "engineer", stepAlias: "review", cliProfile: "claude-subscription" });
  assert.equal(r.auth, "subscription"); // pinned, ignores the bedrock env
});

// ---- Fail-loud ----

test("policy: unknown --profile fails loud", () => {
  writePolicy();
  assert.throws(
    () => resolveModel({ agentRole: "engineer", cliProfile: "ghost" }),
    /--profile 'ghost' is not defined/
  );
});

test("policy: capability with no mapping and no default fails loud", () => {
  // A profile that maps only "review" — request "reasoning" via --profile path.
  const narrow = `
on_unavailable: fail
schema_version: 2
model_profiles:
  narrow:
    provider: anthropic
    auth: subscription
    map:
      review: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: narrow
  activity: {}
`;
  writeFileSync(join(homeDir, "model-policy.yml"), narrow);
  assert.throws(
    () => resolveModel({ agentRole: "engineer", stepAlias: "reasoning", cliProfile: "narrow" }),
    /no mapping for capability 'reasoning'/
  );
});

test("detectAuthMode: env precedence bedrock > api > subscription", () => {
  // Hard-off baseline → subscription, independent of host ~/.aws SSO config.
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  assert.equal(detectAuthMode(), "subscription");
  process.env.ANTHROPIC_API_KEY = "sk-x"; // hard-off + apikey → api
  assert.equal(detectAuthMode(), "api");
  process.env.CLAUDE_CODE_USE_BEDROCK = "1"; // explicit bedrock wins
  assert.equal(detectAuthMode(), "bedrock");
});

// ---- Walk: openai/subscription binds to the codex-subscription runtime ----

test("policy: openai + subscription profile binds runtime to codex-subscription", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), `
on_unavailable: fail
schema_version: 2
model_profiles:
  codex-sub:
    provider: openai
    auth: subscription
    map:
      review:  { model: gpt-5-codex, cost_tier: standard }
      default: { model: gpt-5-codex, cost_tier: standard }
defaults:
  profile: codex-sub
  activity: {}
`);
  const r = resolveModel({ agentRole: "red-wide", stepAlias: "review", cliProfile: "codex-sub" });
  assert.equal(r.provider, "openai");
  assert.equal(r.auth, "subscription");
  assert.equal(r.runtime, "codex-subscription");
  assert.equal(r.model, "gpt-5-codex");
});

// ---- #265: explicit runtime (pi) + upstream provider selection ----

const PI_POLICY = `
on_unavailable: fail
schema_version: 2
model_profiles:
  pi-groq-cheap-reds:
    provider: groq
    auth: api
    runtime: pi-apikey
    map:
      review:  { model: llama-3.3-70b-versatile, cost_tier: cheap }
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap }
defaults:
  profile: pi-groq-cheap-reds
  activity: {}
`;

test("#265: a pi profile selects the explicit runtime + upstream provider + model", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), PI_POLICY);
  const r = resolveModel({ agentRole: "red-wide", stepAlias: "review", cliProfile: "pi-groq-cheap-reds" });
  assert.equal(r.runtime, "pi-apikey");   // explicit runtime, NOT a (provider,auth) binding
  assert.equal(r.provider, "groq");        // upstream vendor — not a fake provider=pi
  assert.equal(r.model, "llama-3.3-70b-versatile");
  assert.equal(r.auth, "api");
});

test("#265: an upstream provider with no explicit runtime fails loud (no binding for groq)", () => {
  // Same profile minus `runtime:` — groq has no (provider,auth)->runtime row, so
  // the binding table is the fail-loud. An explicit `runtime:` is the escape.
  writeFileSync(join(homeDir, "model-policy.yml"), PI_POLICY.replace("    runtime: pi-apikey\n", ""));
  assert.throws(
    () => resolveModel({ agentRole: "red-wide", stepAlias: "review", cliProfile: "pi-groq-cheap-reds" }),
    /no runtime bound for provider='groq'/
  );
});

test("#265: explicit runtime is passed through verbatim (loadRuntime is the fail-loud for an unknown name)", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), PI_POLICY.replace("pi-apikey", "pi-does-not-exist"));
  const r = resolveModel({ agentRole: "red-wide", stepAlias: "review", cliProfile: "pi-groq-cheap-reds" });
  assert.equal(r.runtime, "pi-does-not-exist"); // resolver doesn't load it; dispatch's loadRuntime throws
});

test("#265: an unmapped capability on a pi profile fails loud (no fake fallback)", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), PI_POLICY.replace(
    "      default: { model: llama-3.3-70b-versatile, cost_tier: cheap }\n", ""
  ));
  assert.throws(
    () => resolveModel({ agentRole: "architecture-advisor", stepAlias: "reasoning", cliProfile: "pi-groq-cheap-reds" }),
    /no mapping for capability 'reasoning'/
  );
});

// ---- FG-560: mapping-path / capability-source provenance + activity_unmapped ----

// A default-only pi profile (map is JUST "default"). Its explicit activities are
// meant to fall to the default — it must NEVER be flagged activity_unmapped.
const PI_DEFAULT_ONLY = `
on_unavailable: fail
schema_version: 2
model_profiles:
  pi-groq:
    provider: groq
    auth: api
    runtime: pi-apikey
    map:
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap }
defaults:
  profile: pi-groq
  activity: {}
`;

test("FG-560: explicit + exact map hit → resolved, mappingPath=exact", () => {
  writePolicy();
  const r = resolveModel({ agentRole: "engineer", stepAlias: "review" });
  assert.equal(r.capabilitySource, "explicit");
  assert.equal(r.mappingPath, "exact");
  assert.equal(r.outcome, "resolved");
  assert.equal(isActivityUnmapped(r), false);
  assert.equal(activityUnmappedMessage(r), undefined);
  assert.equal(r.model, "claude-sonnet-4-6");
});

test("FG-560: explicit + would-be default-fallback → activity_unmapped (inspectable, no throw)", () => {
  writePolicy();
  // "design" is a named activity absent from claude-subscription's map (which has
  // reasoning/review/fast/default), and the profile is NOT default-only.
  const r = resolveModel({ agentRole: "engineer", stepAlias: "design" });
  assert.equal(r.capabilitySource, "explicit");
  assert.equal(r.mappingPath, "default-fallback");
  assert.equal(r.outcome, "activity_unmapped");
  assert.equal(isActivityUnmapped(r), true);
  // The would-be model is still populated so the refusal is inspectable.
  assert.equal(r.model, "claude-sonnet-4-6");
  const msg = activityUnmappedMessage(r);
  assert.match(msg ?? "", /activity_unmapped/);
  assert.match(msg ?? "", /'design'/);
  assert.match(msg ?? "", /claude-subscription/);
});

test("FG-560: role-derived + exact map hit → resolved", () => {
  writePolicy();
  // tech-lead derives "reasoning", which claude-subscription maps exactly.
  const r = resolveModel({ agentRole: "tech-lead" });
  assert.equal(r.capabilitySource, "role-derived");
  assert.equal(r.mappingPath, "exact");
  assert.equal(r.outcome, "resolved");
  assert.equal(r.alias, "reasoning");
});

test("FG-560: role-derived + default-fallback stays valid (legacy-equivalent), never refused", () => {
  writePolicy();
  // designer derives "design", absent from the map → falls to map.default. Because
  // the capability was NOT explicitly demanded, this is a normal resolution.
  const r = resolveModel({ agentRole: "designer" });
  assert.equal(r.capabilitySource, "role-derived");
  assert.equal(r.mappingPath, "default-fallback");
  assert.equal(r.outcome, "resolved");
  assert.equal(isActivityUnmapped(r), false);
  assert.equal(r.model, "claude-sonnet-4-6");
});

test("FG-560: default-only profile (pi-groq) is never flagged, even for an explicit activity", () => {
  writeFileSync(join(homeDir, "model-policy.yml"), PI_DEFAULT_ONLY);
  const r = resolveModel({ agentRole: "red-wide", stepAlias: "review", cliProfile: "pi-groq" });
  assert.equal(r.capabilitySource, "explicit");
  assert.equal(r.mappingPath, "default-fallback"); // fell to default...
  assert.equal(r.outcome, "resolved"); // ...but a default-only profile is intentional
  assert.equal(isActivityUnmapped(r), false);
  assert.equal(r.model, "llama-3.3-70b-versatile");
});

test("FG-560: legacy mode carries no policy provenance axes", () => {
  writeRuntime();
  const r = resolveModel({ agentRole: "engineer", stepAlias: "spec-writer", runtimeName: "claude-oauth" });
  assert.equal(r.resolvedBy, "legacy");
  assert.equal(r.capabilitySource, undefined);
  assert.equal(r.mappingPath, undefined);
  assert.equal(r.outcome, undefined);
});

// ---- Project policy replaces workspace policy (file-level, not merge) ----

test("policy: project model-policy.yml replaces workspace", () => {
  writePolicy(); // workspace
  // First occurrence of this string is claude-subscription's `review` mapping.
  const projectPolicy = POLICY.replace(
    "model: claude-sonnet-4-6, cost_tier: standard }",
    "model: claude-opus-4-8, cost_tier: standard }"
  );
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), projectPolicy);

  const r = resolveModel({ agentRole: "engineer", stepAlias: "review", ctx: { projectDir } });
  assert.equal(r.model, "claude-opus-4-8");
});
