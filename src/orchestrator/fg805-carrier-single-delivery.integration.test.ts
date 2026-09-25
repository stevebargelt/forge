// FG-805 — the orchestrator policy reaches a forge-launched session ONCE, rendered for
// the project's ai_attribution mode.
//
// Before this, the Claude carrier was the RAW seeds/orchestrator-template.md: both
// `forge:if ai_attribution=…` bullets (so the session was told attribution was both
// forbidden and allowed), the placeholder "Stack + project context" tail, and — because
// Claude Code also loads the project's CLAUDE.md forge block — every rule twice. The
// Codex carrier sliced the tail but did not resolve the conditionals either.
//
// Real seeds are used for the render assertions (those are the bytes an operator gets);
// every root is a disposable mkdtemp and no provider binary is spawned.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../store/db.js";
import { assetRoot } from "../v2/asset-root.js";
import { renderOrchestratorTemplate, type AiAttributionMode } from "../v2/ai-attribution.js";
import { applyOrchestratorBlock } from "../cli/commands/init.js";
import {
  CODEX_CARRIER_SOURCE_REL,
  GENERATION_CODEX_CARRIER,
  GENERATION_CODEX_CARRIER_ALLOW,
  GENERATION_MANIFEST_NAME,
  codexCarrierPath,
  generationCodexCarrierState,
  publishSeedGeneration,
  renderCodexCarrier,
  renderOrchestratorPolicy,
  resolveSeedGeneration,
} from "../v2/seed-generation.js";
import { stageAgentProtocols } from "../v2/seed-generation.testkit.js";
import { resolveOrchestratorLaunch, type OrchestratorDecision } from "../v2/orchestrator-resolve.js";
import type { AuthProbe } from "../v2/provider-doctor.js";
import { claudeMdOrchestratorBlock, createClaudeAdapter } from "./claude-adapter.js";
import { CODEX_INSTRUCTIONS_CONFIG_KEY, createCodexAdapter } from "./codex-adapter.js";
import { mintSessionKey, planLaunch } from "./launch.js";
import type { AdapterCarrier, AdapterLaunchContext } from "./adapter.js";

const SEEDS = join(assetRoot(), "seeds");
const TEMPLATE = readFileSync(join(SEEDS, "orchestrator-template.md"), "utf8");
const SCAFFOLD = readFileSync(join(SEEDS, CODEX_CARRIER_SOURCE_REL), "utf8");

const SUPPRESS_BULLET = "Don't attribute work to an AI assistant";
const ALLOW_BULLET = "AI attribution is ALLOWED in this project";
const BULLET: Record<AiAttributionMode, { keep: string; drop: string }> = {
  suppress: { keep: SUPPRESS_BULLET, drop: ALLOW_BULLET },
  allow: { keep: ALLOW_BULLET, drop: SUPPRESS_BULLET },
};

const POLICY = `
schema_version: 2
model_profiles:
  codex-subscription:
    provider: openai
    auth: subscription
    map:
      default: { model: gpt-5.6-terra, cost_tier: standard }
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

const HELP_WITH_FILE_FLAG = "Options:\n  --append-system-prompt-file <file>\n  --append-system-prompt <prompt>\n";

const ALWAYS_AVAILABLE = (provider: string, mode: string): AuthProbe =>
  ({ provider, mode, status: "available", detail: "fixture probe" }) as AuthProbe;

let base: string;
let home: string;
let projectDir: string;
let envSnapshot: Record<string, string | undefined>;
const MANAGED_ENV = ["FORGE_HOME", "FORGE_DB_PATH", "AWS_PROFILE", "CLAUDE_CODE_USE_BEDROCK"] as const;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fg805-carrier-")));
  home = join(base, "forge-home");
  projectDir = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");

  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  delete process.env["AWS_PROFILE"];
  delete process.env["CLAUDE_CODE_USE_BEDROCK"];
  closeDb();
});

afterEach(() => {
  closeDb();
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

function setMode(mode: AiAttributionMode): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `ai_attribution: ${mode}\n`, "utf8");
}

function contextFor(): AdapterLaunchContext {
  const res = resolveOrchestratorLaunch({ projectDir, authProbe: ALWAYS_AVAILABLE as never });
  assert.ok(res.ok, `fixture policy failed to resolve: ${res.ok ? "" : res.refusal.message}`);
  const decision: OrchestratorDecision = res.decision;
  return {
    decision,
    projectDir,
    projectName: "fixture-project",
    sessionKey: mintSessionKey(decision.operation),
    receiptId: "orx-fixture0000",
    runId: null,
    taskId: null,
    operation: decision.operation,
    passthrough: [],
    parentEnv: process.env,
  };
}

function claudeCarrier(): AdapterCarrier {
  const adapter = createClaudeAdapter({ helpProbe: () => HELP_WITH_FILE_FLAG });
  const ctx = contextFor();
  const readiness = adapter.probeReadiness(ctx);
  assert.ok(readiness.ok);
  return adapter.declareInstructionCarrier(ctx, readiness.readiness);
}

function codexContext(): AdapterLaunchContext {
  const res = resolveOrchestratorLaunch({ projectDir, cliProfile: "codex-subscription", authProbe: ALWAYS_AVAILABLE as never });
  assert.ok(res.ok, `fixture policy failed to resolve Codex: ${res.ok ? "" : res.refusal.message}`);
  assert.equal(res.decision.adapter, "codex");
  const decision: OrchestratorDecision = res.decision;
  return {
    decision,
    projectDir,
    projectName: "fixture-project",
    sessionKey: mintSessionKey(decision.operation),
    receiptId: "orx-fixture0000",
    runId: null,
    taskId: null,
    operation: decision.operation,
    passthrough: [],
    parentEnv: process.env,
  };
}

function codexAdapter() {
  return createCodexAdapter({ versionProbe: () => "codex-cli 0.144.1", forgeHome: home });
}

function assertRenderedFor(mode: AiAttributionMode, text: string, surface: string): void {
  assert.ok(!text.includes("forge:if"), `${surface} (${mode}) still carries a forge:if marker`);
  assert.ok(!text.includes("forge:endif"), `${surface} (${mode}) still carries a forge:endif marker`);
  assert.ok(text.includes(BULLET[mode].keep), `${surface} (${mode}) lost its attribution bullet`);
  assert.ok(!text.includes(BULLET[mode].drop), `${surface} (${mode}) carries the other mode's attribution bullet`);
  assert.ok(!text.includes("Stack + project context"), `${surface} (${mode}) carries the project placeholder tail`);
  assert.ok(!text.includes("forge:orchestrator-start"), `${surface} (${mode}) carries the CLAUDE.md block markers`);
}

function assertExactlyOneAttributionBullet(mode: AiAttributionMode, text: string, surface: string): void {
  const count = (needle: string) => text.split(needle).length - 1;
  assert.equal(count(BULLET[mode].keep), 1, `${surface} (${mode}) must contain its attribution bullet exactly once`);
  assert.equal(count(BULLET[mode].drop), 0, `${surface} (${mode}) must not contain the other attribution bullet`);
}

/** A release-shaped tree published through the same publisher `forge upgrade` calls. */
function publishCurrentRelease() {
  const release = join(base, "release");
  mkdirSync(join(release, "seeds", "codex"), { recursive: true });
  mkdirSync(join(release, "seeds", "workflows"), { recursive: true });
  mkdirSync(join(release, "seeds", "runtimes"), { recursive: true });
  writeFileSync(join(release, "seeds", "workflows", "feature.yml"), "name: feature\nsteps: []\n");
  writeFileSync(join(release, "seeds", "runtimes", "claude.yml"), "kind: claude\n");
  stageAgentProtocols(join(release, "seeds"));
  writeFileSync(join(release, "seeds", "orchestrator-template.md"), TEMPLATE);
  writeFileSync(join(release, "seeds", CODEX_CARRIER_SOURCE_REL), SCAFFOLD);
  publishSeedGeneration({ home, assetsDir: release, trustedAssetRoot: () => release });
  const generation = resolveSeedGeneration(home);
  assert.ok(generation, "publication must resolve a generation");
  return generation;
}

// ─── AC1 / AC2: both carriers render through the init renderer and slice the region ──

for (const mode of ["suppress", "allow"] as const) {
  test(`FG-805: the Claude carrier for an ai_attribution=${mode} project is rendered and sliced`, () => {
    setMode(mode);
    const carrier = claudeCarrier();

    assert.equal(carrier.argv[0], "--append-system-prompt-file");
    assertRenderedFor(mode, String(carrier.content), "Claude carrier");
    assert.equal(carrier.content, renderOrchestratorPolicy(TEMPLATE, mode));
    assert.match(String(carrier.evidence), new RegExp(`ai_attribution=${mode}`));

    // The generation digest is over the bytes delivered, not the raw seed.
    const digest = createHash("sha256").update(String(carrier.content)).digest("hex").slice(0, 16);
    assert.ok(String(carrier.generation).endsWith(`@${digest}`), `generation ${carrier.generation} is not over the delivered bytes`);
  });

  test(`FG-805: the Codex carrier for ai_attribution=${mode} resolves the conditionals the same way`, () => {
    const text = renderCodexCarrier(SCAFFOLD, TEMPLATE, mode);
    assertRenderedFor(mode, text, "Codex carrier");
    assert.ok(text.includes(renderOrchestratorPolicy(TEMPLATE, mode)), "the Codex carrier splices the same policy the Claude carrier delivers");
  });
}

test("FG-805: the carrier policy is exactly the region init writes into CLAUDE.md, for either mode", () => {
  for (const mode of ["suppress", "allow"] as const) {
    const claudeMd = applyOrchestratorBlock("", renderOrchestratorTemplate(TEMPLATE, mode)).content;
    writeFileSync(join(projectDir, "CLAUDE.md"), claudeMd, "utf8");
    assert.equal(claudeMdOrchestratorBlock(projectDir), renderOrchestratorPolicy(TEMPLATE, mode));
  }
});

// ─── AC3: one delivery path ─────────────────────────────────────────────────────

test("FG-805: a project whose CLAUDE.md carries the rendered block gets NO appended policy", () => {
  setMode("allow");
  const block = renderOrchestratorPolicy(TEMPLATE, "allow");
  writeFileSync(
    join(projectDir, "CLAUDE.md"),
    `# project\n\n${applyOrchestratorBlock("", renderOrchestratorTemplate(TEMPLATE, "allow")).content}`,
    "utf8",
  );

  const carrier = claudeCarrier();
  assert.deepEqual([...carrier.argv], [], "the policy must not be appended when CLAUDE.md already delivers it");
  assert.equal(carrier.path, null, "nothing is materialized for a carrier that is not passed");
  assert.equal(carrier.content, null);
  assert.equal(carrier.acceptance, "accepted");
  assert.deepEqual(carrier.limitations, []);
  assert.match(String(carrier.evidence), /delivered via the forge block in .*CLAUDE\.md/);
  assert.match(String(carrier.evidence), /matches the policy rendered from .* for ai_attribution=allow/);
  const digest = createHash("sha256").update(block).digest("hex").slice(0, 16);
  assert.ok(String(carrier.generation).endsWith(`@${digest}`), "the generation digest is over the CLAUDE.md block the session reads");

  const planned = planLaunch(createClaudeAdapter({ helpProbe: () => HELP_WITH_FILE_FLAG }), contextFor());
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  assert.ok(!planned.plan.argv.includes("--append-system-prompt-file"), `argv double-delivers: ${planned.plan.argv.join(" ")}`);
  assert.ok(!planned.plan.argv.includes("--append-system-prompt"), `argv double-delivers: ${planned.plan.argv.join(" ")}`);
});

test("FG-805: a CLAUDE.md block rendered for the OTHER mode is still the single path, and the drift is recorded", () => {
  setMode("allow");
  writeFileSync(join(projectDir, "CLAUDE.md"), applyOrchestratorBlock("", renderOrchestratorTemplate(TEMPLATE, "suppress")).content, "utf8");

  const carrier = claudeCarrier();
  assert.deepEqual([...carrier.argv], []);
  assert.match(String(carrier.evidence), /differs from the policy rendered/);
  const gap = carrier.limitations.find((l) => l.capability === "instruction-source");
  assert.ok(gap, "a stale block must be named on the receipt");
  assert.match(gap.note, /forge upgrade/);
});

test("FG-805: changing ai_attribution without re-rendering records drift, and re-rendering clears it", () => {
  setMode("suppress");
  writeFileSync(join(projectDir, "CLAUDE.md"), applyOrchestratorBlock("", renderOrchestratorTemplate(TEMPLATE, "suppress")).content, "utf8");
  assert.deepEqual(claudeCarrier().limitations, [], "the initial rendered block is current");

  // This is the operator flow: configuration changes first, but CLAUDE.md has not
  // yet been refreshed by upgrade. The block remains the only delivery path.
  setMode("allow");
  const stale = claudeCarrier();
  assert.deepEqual(stale.argv, [], "a stale rendered block must not cause a second appended delivery");
  assert.equal(stale.limitations.length, 1);
  assert.match(stale.limitations[0]!.note, /ai_attribution=allow/);
  assert.match(stale.limitations[0]!.note, /forge upgrade/);

  const refreshed = applyOrchestratorBlock(readFileSync(join(projectDir, "CLAUDE.md"), "utf8"), renderOrchestratorTemplate(TEMPLATE, "allow"));
  writeFileSync(join(projectDir, "CLAUDE.md"), refreshed.content, "utf8");
  const current = claudeCarrier();
  assert.deepEqual(current.argv, []);
  assert.deepEqual(current.limitations, [], "the re-rendered allow block must no longer report drift");
});

test("FG-805: a CLAUDE.md with no balanced forge block still gets the appended carrier", () => {
  for (const claudeMd of [null, "# project\n", "<!-- forge:orchestrator-start -->\n"]) {
    rmSync(join(projectDir, "CLAUDE.md"), { force: true });
    if (claudeMd !== null) writeFileSync(join(projectDir, "CLAUDE.md"), claudeMd, "utf8");
    assert.equal(claudeMdOrchestratorBlock(projectDir), null);
    const carrier = claudeCarrier();
    assert.equal(carrier.argv[0], "--append-system-prompt-file", `CLAUDE.md=${JSON.stringify(claudeMd)}`);
    assertRenderedFor("suppress", String(carrier.content), "Claude carrier");
  }
});

// ─── Codex: the generation publishes one pinned variant per mode ────────────────

test("FG-805: the seed generation publishes a pinned Codex carrier per ai_attribution mode", () => {
  const gen = publishCurrentRelease();

  assert.equal(codexCarrierPath(gen), join(gen.root, GENERATION_CODEX_CARRIER));
  assert.equal(codexCarrierPath(gen, "allow"), join(gen.root, GENERATION_CODEX_CARRIER_ALLOW));
  for (const mode of ["suppress", "allow"] as const) {
    assert.deepEqual(generationCodexCarrierState(gen, mode), { kind: "present", path: codexCarrierPath(gen, mode) });
    const text: string = readFileSync(codexCarrierPath(gen, mode), "utf8");
    assert.equal(text, renderCodexCarrier(SCAFFOLD, TEMPLATE, mode));
    assertRenderedFor(mode, text, "published Codex carrier");
  }
});

test("FG-805: an old single-variant generation names the allow gap, then upgrade-equivalent republish binds allow", () => {
  const legacy = publishCurrentRelease();
  // Model a generation published by the pre-FG-805 publisher: it legitimately has
  // only the historical suppress carrier, with no dangling or unrendered allow file.
  rmSync(codexCarrierPath(legacy, "allow"));
  const manifestPath = join(legacy.root, GENERATION_MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, string> };
  delete manifest.files[GENERATION_CODEX_CARRIER_ALLOW];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(generationCodexCarrierState(resolveSeedGeneration(home)!, "allow"), { kind: "absent" });

  setMode("allow");
  const before = codexAdapter().probeReadiness(codexContext());
  assert.ok(before.ok, before.ok ? "" : before.refusal.message);
  assert.equal(before.readiness.limitations.length, 1, "the legacy gap must be recorded, not silently replaced by raw policy bytes");
  assert.match(before.readiness.limitations[0]!.note, /ai_attribution=allow/);
  assert.match(before.readiness.limitations[0]!.note, /forge upgrade/);
  const unbound = codexAdapter().declareInstructionCarrier(codexContext(), before.readiness);
  assert.equal(unbound.acceptance, "unproven");
  assert.deepEqual(unbound.argv, []);

  // publishSeedGeneration is the atomic publication step that `forge upgrade` runs.
  const republished = publishCurrentRelease();
  assert.notEqual(republished.root, legacy.root, "republish must select a fresh generation");
  assert.deepEqual(generationCodexCarrierState(republished, "suppress").kind, "present");
  assert.deepEqual(generationCodexCarrierState(republished, "allow").kind, "present");
  const planned = planLaunch(codexAdapter(), codexContext());
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  assert.equal(planned.plan.argv[planned.plan.argv.indexOf("-c") + 1], `${CODEX_INSTRUCTIONS_CONFIG_KEY}=${codexCarrierPath(republished, "allow")}`);
  assert.equal(planned.plan.carrier.acceptance, "accepted");
  assert.deepEqual(planned.plan.carrier.limitations, [], "the republished allow carrier itself must bind without a limitation");
  assert.ok(
    !planned.plan.limitations.some((limitation) => /carries no Codex instruction carrier for ai_attribution=allow/.test(limitation.note)),
    "the legacy-generation instruction-source limitation must disappear after republish",
  );
});

test("FG-805: every carrier path adapters can bind is marker-free and has exactly one attribution bullet", () => {
  const generation = publishCurrentRelease();
  for (const mode of ["suppress", "allow"] as const) {
    setMode(mode);
    rmSync(join(projectDir, "CLAUDE.md"), { force: true });
    const claude = claudeCarrier();
    assertRenderedFor(mode, String(claude.content), "adapter-bound Claude carrier");
    assertExactlyOneAttributionBullet(mode, String(claude.content), "adapter-bound Claude carrier");

    const planned = planLaunch(codexAdapter(), codexContext());
    assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
    const bound = codexCarrierPath(generation, mode);
    assert.equal(planned.plan.argv[planned.plan.argv.indexOf("-c") + 1], `${CODEX_INSTRUCTIONS_CONFIG_KEY}=${bound}`);
    const codex = readFileSync(bound, "utf8");
    assertRenderedFor(mode, codex, "adapter-bound Codex carrier");
    assertExactlyOneAttributionBullet(mode, codex, "adapter-bound Codex carrier");
  }
});
