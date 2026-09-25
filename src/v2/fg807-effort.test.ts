// FG-807 — the effort knob and intent-routed reds.
//
//   AC1  capability entries accept `effort`; an invalid level is REJECTED, not stripped.
//   AC2  effort flows through ModelResolution and lands in the manifest model block.
//   AC3  each seed runtime maps effort to its CLI (claude --effort, pi --thinking,
//        codex -c model_reasoning_effort=…), with max→xhigh where the enum stops short;
//        a runtime without a mapping records `ignored (<reason>)`.
//   AC4  effort unset → every seed runtime's argv is byte-identical to pre-FG-807.
//   AC5  shipped workflows route reds by role default, not the fast-orchestrator alias.
//   AC6  the example's review row + the setup catalog's red-cost choice.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ModelPolicySchema,
  RuntimeSchema,
  effortRecord,
  resolveRuntimeEffort,
  type Runtime,
} from "./schema.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { manifestModelBlock, resolveModel } from "./model-resolution.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { offerableChoices } from "./model-policy-choices.js";
import { generateModelPolicy } from "./model-policy-generator.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadSeedRuntime(name: string): Runtime {
  return RuntimeSchema.parse(parseYaml(readFileSync(join(repoRoot, "seeds", "runtimes", `${name}.yml`), "utf8")));
}

const CTX: SpawnContext = {
  TASK_ID: "task-x",
  TASK_DIR: "/tmp/forge/task-x",
  PROJECT_DIR: "/tmp/project",
  PROJECT_MODE: "rw",
  MODEL: "the-model",
  SYSTEM_PROMPT: "SYS",
  TASK_PACKAGE_MARKDOWN: "PKG",
};

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "FORGE_AWS_CREDS_FOR_TEST",
  "FORGE_AUTH_MODE",
  "FORGE_CODEX_DIR",
  "FORGE_PI_DIR",
  "FORGE_HOME",
  "CLAUDE_CODE_USE_BEDROCK",
  "UPSTREAM_PROVIDER",
  "EFFORT",
];
let envSnap: Record<string, string | undefined>;

beforeEach(() => {
  envSnap = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  const codexDir = mkdtempSync(join(tmpdir(), "fg807-codex-"));
  writeFileSync(join(codexDir, "auth.json"), "{}");
  process.env.FORGE_CODEX_DIR = codexDir;
  const piDir = mkdtempSync(join(tmpdir(), "fg807-pi-"));
  writeFileSync(join(piDir, "auth.json"), "{}");
  process.env.FORGE_PI_DIR = piDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The invocation argv: everything after the image, up to the spawn-appended
 *  `--setting-sources` (claude-code only). */
function invocationArgv(rt: Runtime, ctx: SpawnContext): string[] {
  const { args, imageIndex } = buildDockerArgs(rt, ctx);
  const tail = args.slice(imageIndex + 1);
  const ss = tail.indexOf("--setting-sources");
  return ss >= 0 ? tail.slice(0, ss) : tail;
}

// ── AC1 ─────────────────────────────────────────────────────────────────────

function policyWithReview(entry: Record<string, unknown>) {
  return {
    schema_version: 2,
    model_profiles: {
      p: { provider: "anthropic", auth: "subscription", map: { default: { model: "m", cost_tier: "standard" }, review: entry } },
    },
    defaults: { profile: "p" },
  };
}

test("AC1: every effort level is accepted on a capability entry and survives parsing", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const r = ModelPolicySchema.safeParse(policyWithReview({ model: "m", cost_tier: "premium", effort }));
    assert.ok(r.success, `effort '${effort}' should validate`);
    assert.equal(r.data!.model_profiles.p!.map.review!.effort, effort);
  }
});

test("AC1: an invalid effort is rejected by validation, not silently stripped", () => {
  for (const effort of ["minimal", "off", "LOW", "", 3]) {
    const r = ModelPolicySchema.safeParse(policyWithReview({ model: "m", cost_tier: "premium", effort }));
    assert.equal(r.success, false, `effort ${JSON.stringify(effort)} must be rejected`);
    assert.ok(r.error!.issues.some((i) => i.path.includes("effort")), "issue names the effort field");
  }
});

test("runtime schema: invocation.effort and the ${EFFORT_ARGS} placeholder must come together", () => {
  const base = loadSeedRuntime("claude-oauth");
  const noPlaceholder = { ...base, invocation: { ...base.invocation, args: base.invocation.args.filter((a) => a !== "${EFFORT_ARGS}") } };
  assert.equal(RuntimeSchema.safeParse(noPlaceholder).success, false, "effort block without placeholder is refused");
  const noBlock = { ...base, invocation: { ...base.invocation, effort: undefined } };
  assert.equal(RuntimeSchema.safeParse(noBlock).success, false, "placeholder without effort block is refused");
});

// ── AC4: unset effort → byte-identical argv (golden, copied from the pre-FG-807 seeds) ──

const CLAUDE_ARGV = [
  "claude", "--model", "the-model", "--append-system-prompt", "SYS", "--dangerously-skip-permissions",
  "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--print",
];
const PI_ARGV = [
  "pi", "-p", "--mode", "json", "--no-context-files", "--no-session", "--provider", "anthropic",
  "--model", "the-model", "--append-system-prompt", "SYS", "@/task/package.md",
];
const PRE_FG807_ARGV: Record<string, string[]> = {
  "claude-apikey": CLAUDE_ARGV,
  "claude-bedrock": CLAUDE_ARGV,
  "claude-oauth": CLAUDE_ARGV,
  "codex-subscription": [
    "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
    "-m", "the-model", "--cd", "/project", "-",
  ],
  "pi-apikey": PI_ARGV,
  "pi-oauth": PI_ARGV,
};

for (const [name, expected] of Object.entries(PRE_FG807_ARGV)) {
  test(`AC4: ${name} with effort unset renders exactly the pre-FG-807 argv`, () => {
    const rt = loadSeedRuntime(name);
    assert.deepEqual(invocationArgv(rt, CTX), expected);
    assert.deepEqual(invocationArgv(rt, { ...CTX, EFFORT: "" }), expected, "empty EFFORT is unset");
  });
}

// ── AC3: per-runtime mapping ────────────────────────────────────────────────

function withInserted(argv: string[], after: string, extra: string[]): string[] {
  const i = argv.indexOf(after);
  return [...argv.slice(0, i + 1), ...extra, ...argv.slice(i + 1)];
}

const EFFORT_CASES: Array<[string, string, string[]]> = [
  ["claude-oauth", "low", ["--effort", "low"]],
  ["claude-apikey", "max", ["--effort", "max"]],
  ["claude-bedrock", "xhigh", ["--effort", "xhigh"]],
  ["pi-apikey", "medium", ["--thinking", "medium"]],
  ["pi-oauth", "max", ["--thinking", "xhigh"]],
  ["codex-subscription", "high", ["-c", "model_reasoning_effort=high"]],
  ["codex-subscription", "max", ["-c", "model_reasoning_effort=xhigh"]],
];

for (const [name, level, flags] of EFFORT_CASES) {
  test(`AC3: ${name} effort=${level} → ${flags.join(" ")} right after the model`, () => {
    const rt = loadSeedRuntime(name);
    assert.deepEqual(invocationArgv(rt, { ...CTX, EFFORT: level }), withInserted(PRE_FG807_ARGV[name]!, "the-model", flags));
  });
}

test("AC3: the manifest record names the runtime-native value when it differs", () => {
  assert.equal(effortRecord(resolveRuntimeEffort(loadSeedRuntime("claude-oauth"), "low")), "low");
  assert.equal(effortRecord(resolveRuntimeEffort(loadSeedRuntime("pi-oauth"), "max")), "max (as xhigh)");
  assert.equal(effortRecord(resolveRuntimeEffort(loadSeedRuntime("claude-oauth"), undefined)), undefined);
});

test("AC3: a runtime with no effort mapping records ignored (<reason>) and dispatches unchanged", () => {
  const seed = loadSeedRuntime("claude-oauth");
  const rt: Runtime = {
    ...seed,
    name: "custom-claude",
    invocation: { ...seed.invocation, args: seed.invocation.args.filter((a) => a !== "${EFFORT_ARGS}"), effort: undefined },
  };
  const outcome = resolveRuntimeEffort(rt, "low");
  assert.equal(outcome?.status, "ignored");
  assert.equal(effortRecord(outcome), "ignored (runtime 'custom-claude' declares no invocation.effort mapping)");
  assert.deepEqual(invocationArgv(rt, { ...CTX, EFFORT: "low" }), CLAUDE_ARGV);
});

// ── AC2: resolution + manifest ──────────────────────────────────────────────

test("AC2: effort flows from the policy entry through ModelResolution into the manifest model block", () => {
  const home = mkdtempSync(join(tmpdir(), "fg807-home-"));
  const project = mkdtempSync(join(tmpdir(), "fg807-proj-"));
  try {
    process.env.FORGE_HOME = home;
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "claude-oauth.yml"), readFileSync(join(repoRoot, "seeds", "runtimes", "claude-oauth.yml")));
    publishFlatAsGeneration(home);
    writeFileSync(
      join(home, "model-policy.yml"),
      [
        "schema_version: 2",
        "model_profiles:",
        "  sub:",
        "    provider: anthropic",
        "    auth: subscription",
        "    map:",
        "      review:  { model: claude-opus-5-5, cost_tier: premium, effort: low }",
        "      default: { model: claude-sonnet-5, cost_tier: standard }",
        "defaults:",
        "  profile: sub",
        "",
      ].join("\n"),
    );

    const red = resolveModel({ agentRole: "red-wide", ctx: { projectDir: project } });
    assert.equal(red.alias, "review");
    assert.equal(red.model, "claude-opus-5-5");
    assert.equal(red.effort, "low");
    const rec = effortRecord(resolveRuntimeEffort(loadSeedRuntime(red.runtime), red.effort));
    const block = manifestModelBlock(red, rec)!;
    assert.equal(block.model, "claude-opus-5-5");
    assert.equal(block.effort, "low");

    const eng = resolveModel({ agentRole: "engineer", ctx: { projectDir: project } });
    assert.equal(eng.effort, undefined);
    assert.ok(!("effort" in manifestModelBlock(eng, undefined)!), "unset effort is omitted from the manifest");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ── AC5: shipped workflows route reds by intent ─────────────────────────────

const WORKFLOWS = ["feature", "feature-ui-design-needed", "feature-ui-design-provided", "security-audit"];

for (const wf of WORKFLOWS) {
  test(`AC5: ${wf}.yml pins no red to an activity, so each resolves its role default`, () => {
    const doc = parseYaml(readFileSync(join(repoRoot, "seeds", "workflows", `${wf}.yml`), "utf8")) as {
      steps: Array<{ reds?: Array<{ agent: string; activity?: string; model?: string }> }>;
    };
    const reds = doc.steps.flatMap((s) => s.reds ?? []);
    assert.ok(reds.length > 0, "workflow has reds");
    for (const red of reds) {
      assert.equal(red.activity ?? red.model, undefined, `${red.agent} must not pin an activity`);
    }
  });
}

test("AC5: every red role in the shipped workflows defaults to the review activity; fast-orchestrator stays mapped", () => {
  const home = mkdtempSync(join(tmpdir(), "fg807-home-"));
  const project = mkdtempSync(join(tmpdir(), "fg807-proj-"));
  try {
    process.env.FORGE_HOME = home;
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "claude-oauth.yml"), readFileSync(join(repoRoot, "seeds", "runtimes", "claude-oauth.yml")));
    publishFlatAsGeneration(home);
    writeFileSync(join(home, "model-policy.yml"), readFileSync(join(repoRoot, "seeds", "model-policy.example.yml")));

    const roles = new Set<string>();
    for (const wf of WORKFLOWS) {
      const doc = parseYaml(readFileSync(join(repoRoot, "seeds", "workflows", `${wf}.yml`), "utf8")) as {
        steps: Array<{ reds?: Array<{ agent: string }> }>;
      };
      for (const s of doc.steps) for (const r of s.reds ?? []) roles.add(r.agent);
    }
    for (const role of roles) {
      const r = resolveModel({ agentRole: role, ctx: { projectDir: project } });
      assert.equal(r.alias, "review", `${role} resolves review`);
      assert.equal(r.mappingPath, "exact");
      assert.equal(r.model, "claude-opus-5-5");
      assert.equal(r.effort, "low");
    }

    const triage = resolveModel({ agentRole: "engineer", stepAlias: "fast-orchestrator", ctx: { projectDir: project } });
    assert.equal(triage.model, "claude-haiku-4-5");
    assert.equal(triage.outcome, "resolved");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ── AC6: example policy + setup's red-cost choice ───────────────────────────

test("AC6: example policy review rows — Opus 5.5 low on subscription/api, Sonnet on bedrock, codex unchanged", () => {
  const policy = ModelPolicySchema.parse(parseYaml(readFileSync(join(repoRoot, "seeds", "model-policy.example.yml"), "utf8")));
  for (const p of ["claude-subscription", "claude-api"]) {
    assert.deepEqual(policy.model_profiles[p]!.map.review, { model: "claude-opus-5-5", cost_tier: "premium", effort: "low" });
  }
  assert.deepEqual(policy.model_profiles["claude-bedrock"]!.map.review, { model: "us.anthropic.claude-sonnet-5", cost_tier: "standard" });
  assert.deepEqual(policy.model_profiles["codex-subscription"]!.map.review, { model: "gpt-5.6-terra", cost_tier: "standard" });
});

test("AC6: setup offers the opus-review family (with its effort) and a review pick generates it", () => {
  const choices = offerableChoices([
    { provider: "anthropic", mode: "subscription", status: "available", detail: "" },
    { provider: "anthropic", mode: "bedrock", status: "available", detail: "" },
  ]);
  const opusReview = choices.find((c) => c.profileName === "anthropic-subscription-opus-review");
  assert.ok(opusReview, "opus-review offered on subscription");
  assert.equal(opusReview.model, "claude-opus-5-5");
  assert.equal(opusReview.effort, "low");
  assert.equal(choices.find((c) => c.profileName === "anthropic-subscription-sonnet")?.model, "claude-sonnet-5");
  assert.ok(!choices.some((c) => c.auth === "bedrock" && c.effort), "bedrock families carry no effort");

  const gen = generateModelPolicy({
    choices,
    defaultProfile: "anthropic-subscription-sonnet",
    activity: { default: "anthropic-subscription-sonnet", review: "anthropic-subscription-opus-review" },
    rolePins: {},
  });
  assert.deepEqual(gen.policy.model_profiles["anthropic-subscription-opus-review"]!.map.review, {
    model: "claude-opus-5-5",
    cost_tier: "premium",
    effort: "low",
  });
  assert.equal(gen.policy.defaults.activity.review, "anthropic-subscription-opus-review");
  assert.ok(!("effort" in gen.policy.model_profiles["anthropic-subscription-sonnet"]!.map.review!));
});
