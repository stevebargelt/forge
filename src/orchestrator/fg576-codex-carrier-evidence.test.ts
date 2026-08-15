// FG-576 step 7 — AC8's POSITIVE-EVIDENCE GATE, and the rest of the Codex adapter's
// half of the provider-neutral contract.
//
// WHAT IS ACTUALLY AT RISK HERE. Codex's instructions-file config key is
// version-coupled, and a bare `-c` override is NOT covered by --strict-config: a build
// that does not know the key ACCEPTS the flag and silently ignores it. So a Codex
// launch that merely CONSTRUCTS the flag and then registers a fully initialized Forge
// orchestrator is not a slightly-degraded orchestrator — it is a bare Codex session on
// the operator's machine under a receipt that says otherwise, and nothing downstream
// can tell the difference. Every assertion below is about the difference between
// evidence and construction.
//
// These exercise the adapter MEMBERS directly (probeReadiness / declareInstruction-
// Carrier / mapSessionOperation / buildArgv / buildChildEnv / preflight) rather than
// through a spawn, because the properties that matter are properties of the PLAN: what
// would reach the child, and what would be recorded about it. The version probe is
// injected, the seed generation is published into a disposable FORGE_HOME, and no
// executable is spawned (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { currentAdapterStamp, projectAdapterBaseline } from "../v2/seed-drift.js";
import type { AdapterStamp } from "../v2/operator-workflows.js";
import { closeDb } from "../store/db.js";
import { persistPendingOrchestratorReceipt } from "../store/orchestrator-receipts.js";
import { FORGE_OWNED_CODEX_SKILL_DIRS } from "../v2/render-codex-skills.js";
import {
  CODEX_CARRIER_ORIENTATION_MARKER,
  CODEX_CARRIER_SOURCE_REL,
  CODEX_CARRIER_SPLICE_MARKER,
  GENERATION_CODEX_CARRIER,
  codexCarrierPath,
  publishSeedGeneration,
  resolveSeedGeneration,
  type SeedGeneration,
} from "../v2/seed-generation.js";
import { stageAgentProtocols } from "../v2/seed-generation.testkit.js";
import { resolveOrchestratorLaunch, type OrchestratorDecision, type OrchestratorSessionOperation } from "../v2/orchestrator-resolve.js";
import type { AuthProbe } from "../v2/provider-doctor.js";
import {
  CODEX_ALLOW_UNINITIALIZED_ENV,
  CODEX_CARRIER_MIN_VERSION,
  CODEX_INSTRUCTIONS_CONFIG_KEY,
  CODEX_RESERVED_PASSTHROUGH_FLAGS,
  buildCodexChildEnv,
  createCodexAdapter,
  evaluateCodexCarrierSupport,
} from "./codex-adapter.js";
import { correlateCodexSession, listCodexSessions, type CodexSessionRecord } from "./codex-session-state.js";
import { guardPassthrough, mintSessionKey, planLaunch } from "./launch.js";
import type { AdapterLaunchContext, OrchestratorAdapter } from "./adapter.js";

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
  profile: codex-subscription
  activity: {}
`;

const SUPPORTED_VERSION = "codex-cli 0.144.1";
const OLD_VERSION = "codex-cli 0.101.0";

const ALWAYS_AVAILABLE = (provider: string, mode: string): AuthProbe =>
  ({ provider, mode, status: "available", detail: "fixture probe" }) as AuthProbe;

let base: string;
let home: string;
let projectDir: string;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = ["FORGE_HOME", "FORGE_DB_PATH", "FORGE_CODEX_DIR", CODEX_ALLOW_UNINITIALIZED_ENV] as const;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-codex-evidence-")));
  home = join(base, "forge-home");
  projectDir = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(projectDir, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\n`, "utf8");

  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  delete process.env["FORGE_CODEX_DIR"];
  delete process.env[CODEX_ALLOW_UNINITIALIZED_ENV];
  closeDb();
});

afterEach(() => {
  closeDb();
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A disposable tree shaped like a release, carrying the canonical orchestrator policy
 *  and the Codex carrier scaffolding. Published through the REAL publisher, so the
 *  carrier under test is the one a release actually renders and the manifest pins. */
function publishCarrierGeneration(opts: { withCarrier?: boolean } = {}): SeedGeneration {
  const release = join(base, `release-${Math.random().toString(36).slice(2, 8)}`);
  const seeds = join(release, "seeds");
  mkdirSync(join(seeds, "workflows"), { recursive: true });
  mkdirSync(join(seeds, "runtimes"), { recursive: true });
  writeFileSync(join(seeds, "workflows", "feature.yml"), `name: feature\nsteps: []\n`);
  writeFileSync(join(seeds, "runtimes", "claude.yml"), `kind: claude\n`);
  stageAgentProtocols(seeds);
  writeFileSync(
    join(seeds, "orchestrator-template.md"),
    [
      "<!-- forge:orchestrator-start -->",
      "",
      "# forge orchestrator",
      "",
      "Route work through the RACI.",
      "",
      "<!-- forge:orchestrator-end -->",
      "",
      "PROJECT TAIL — never Forge policy.",
      "",
    ].join("\n"),
  );
  if (opts.withCarrier !== false) {
    mkdirSync(join(seeds, "codex"), { recursive: true });
    writeFileSync(
      join(seeds, CODEX_CARRIER_SOURCE_REL),
      [
        "# Forge orchestrator — Codex CLI",
        "",
        "SCAFFOLDING: shell, edits, when to ask.",
        "",
        // FG-253: publication refuses a scaffolding without this marker, and the
        // region below it is rendered from Forge's own workflow definition.
        CODEX_CARRIER_ORIENTATION_MARKER,
        "",
        CODEX_CARRIER_SPLICE_MARKER,
        "",
      ].join("\n"),
    );
  }
  publishSeedGeneration({ home, assetsDir: release, trustedAssetRoot: () => release });
  const gen = resolveSeedGeneration(home);
  assert.ok(gen, "a seed generation must resolve after publishing");
  return gen;
}

function decisionFor(overrides: { cliProfile?: string; cliModel?: string; operation?: OrchestratorSessionOperation } = {}): OrchestratorDecision {
  const res = resolveOrchestratorLaunch({
    projectDir,
    authProbe: ALWAYS_AVAILABLE as never,
    ...overrides,
  });
  assert.ok(res.ok, `fixture policy failed to resolve: ${res.ok ? "" : res.refusal.message}`);
  assert.equal(res.decision.adapter, "codex", "the fixture policy must resolve the orchestrator to Codex");
  return res.decision;
}

function contextFor(decision: OrchestratorDecision, extra: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext {
  const operation = extra.operation ?? decision.operation;
  return {
    decision,
    projectDir,
    projectName: "fixture-project",
    sessionKey: mintSessionKey(operation),
    receiptId: "orx-fixture0000",
    runId: null,
    taskId: null,
    operation,
    passthrough: [],
    parentEnv: process.env,
    ...extra,
  };
}

function adapterWithVersion(version: string | null, opts: { allowUninitialized?: boolean } = {}): OrchestratorAdapter {
  return createCodexAdapter({
    versionProbe: () => version,
    forgeHome: home,
    ...(opts.allowUninitialized !== undefined ? { allowUninitialized: opts.allowUninitialized } : {}),
  });
}

function limitationNotes(readinessLimitations: { capability: string; note: string }[]): string {
  return readinessLimitations.map((l) => `${l.capability}: ${l.note}`).join("\n");
}

// ---------------------------------------------------------------------------
// AC8 — what the probe establishes, and what it refuses to establish
// ---------------------------------------------------------------------------

test("FG-576 AC8: a version probe establishes support, absence of support, or nothing — and those are three different answers", () => {
  const supported = evaluateCodexCarrierSupport(SUPPORTED_VERSION);
  assert.equal(supported.kind, "supported");
  assert.match(supported.kind === "supported" ? supported.evidence : "", new RegExp(CODEX_INSTRUCTIONS_CONFIG_KEY));

  const old = evaluateCodexCarrierSupport(OLD_VERSION);
  assert.equal(old.kind, "unsupported");
  assert.match(old.kind === "unsupported" ? old.detail : "", /strict-config/);

  // The distinction AC8 turns on: an unrunnable probe establishes NOTHING, which is
  // not the same as establishing that the build lacks the capability.
  assert.equal(evaluateCodexCarrierSupport(null).kind, "unknown");
  assert.equal(evaluateCodexCarrierSupport("").kind, "unknown");
  assert.equal(evaluateCodexCarrierSupport("codex (unknown build)").kind, "unknown");

  // The boundary is inclusive: the minimum version IS evidence.
  assert.equal(evaluateCodexCarrierSupport(`codex-cli ${CODEX_CARRIER_MIN_VERSION}`).kind, "supported");
});

test("FG-576 AC8/AC1: a probed-supported build binds the generation's carrier per launch, with its provenance recorded", () => {
  const gen = publishCarrierGeneration();
  const adapter = adapterWithVersion(SUPPORTED_VERSION);
  const ctx = contextFor(decisionFor());

  const planned = planLaunch(adapter, ctx);
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  const plan = planned.plan;

  // The carrier is bound by a PER-LAUNCH config override pointing INSIDE the Forge
  // generation root — not installed, not copied into the operator's Codex config.
  const configIndex = plan.argv.indexOf("-c");
  assert.notEqual(configIndex, -1, `no config override in ${plan.argv.join(" ")}`);
  assert.equal(plan.argv[configIndex + 1], `${CODEX_INSTRUCTIONS_CONFIG_KEY}=${codexCarrierPath(gen)}`);
  assert.ok(codexCarrierPath(gen).startsWith(gen.root), "the bound carrier escaped the seed generation root");

  assert.equal(plan.carrier.acceptance, "accepted");
  assert.equal(plan.carrier.generation, gen.root);
  assert.match(String(plan.carrier.evidence), /codex --version reports 0\.144\.1/);
  assert.match(String(plan.carrier.evidence), new RegExp(gen.manifest.files[GENERATION_CODEX_CARRIER]!));
  assert.match(String(plan.carrier.evidence), /CODEX_HOME was not set/);

  // The launcher materializes — and, at close-out, REMOVES — only what it wrote. The
  // carrier already exists inside the immutable generation, so this launch declares
  // nothing to materialize; a path here would delete the published artifact.
  assert.equal(plan.carrier.path, null);
  assert.equal(plan.carrier.content, null);

  // The bound file is the one the release rendered, and it carries the canonical policy.
  const bytes = readFileSync(codexCarrierPath(gen), "utf8");
  assert.match(bytes, /Route work through the RACI/);
  assert.doesNotMatch(bytes, /PROJECT TAIL/);

  // FG-253: the instruction surface a session is actually BOUND to names the skills
  // Forge installs — iterated from the installer's own owned-skill set — and states
  // that their activation is unverified. Binding the carrier is evidence about the
  // carrier; it is never evidence a skill loaded.
  for (const skill of FORGE_OWNED_CODEX_SKILL_DIRS) {
    assert.ok(bytes.includes(skill), `the bound carrier does not name the installed skill '${skill}'`);
  }
  assert.match(bytes, /activation is unverified/i);
});

test("FG-576 AC8 REGRESSION: a build without the instructions-file capability is refused BEFORE spawn, with a named remedy", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(OLD_VERSION);

  const planned = planLaunch(adapter, contextFor(decisionFor()));
  assert.equal(planned.ok, false, "a build with no carrier capability must not plan a launch at all");
  if (planned.ok) return;

  assert.equal(planned.refusal.code, "adapter-not-ready");
  assert.match(planned.refusal.message, /nothing was spawned/i);
  const remedies = planned.refusal.remediation.join("\n");
  assert.match(remedies, new RegExp(`upgrade the codex CLI to ${CODEX_CARRIER_MIN_VERSION.replace(/\./g, "\\.")}`));
  assert.match(remedies, new RegExp(CODEX_ALLOW_UNINITIALIZED_ENV));
});

test("FG-576 AC8 REGRESSION: the degrade path launches, but the receipt fields say NOT fully initialized and no carrier is bound", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(OLD_VERSION, { allowUninitialized: true });

  const planned = planLaunch(adapter, contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  const plan = planned.plan;

  // Never `accepted`: constructing the flag is not evidence it was honored, so the
  // flag is not constructed at all and the receipt says so in its own fields.
  assert.equal(plan.carrier.acceptance, "unproven");
  assert.equal(plan.carrier.argv.length, 0);
  assert.equal(plan.argv.includes("-c"), false, `a degraded launch bound a carrier: ${plan.argv.join(" ")}`);
  assert.match(limitationNotes(plan.limitations), /NOT a fully initialized Forge orchestrator/);
});

test("FG-576 AC8: a probe that cannot run refuses NOTHING — the spawn path must report a missing binary itself", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(null);

  const planned = planLaunch(adapter, contextFor(decisionFor()));
  // Deliberately not a refusal: an absent or unrunnable `codex` must reach the spawn
  // path so the receipt closes as `spawn_failed` with the real error, rather than
  // being reported as a policy decision.
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  assert.equal(planned.plan.carrier.acceptance, "unproven");
  assert.equal(planned.plan.argv.includes("-c"), false);
  assert.match(limitationNotes(planned.plan.limitations), /could not be run before launch/);
  assert.match(limitationNotes(planned.plan.limitations), /NOT a fully initialized Forge orchestrator/);
});

test("FG-576 AC8/D8: a generation whose carrier does not match its manifest is refused, not bound", () => {
  const gen = publishCarrierGeneration();
  writeFileSync(codexCarrierPath(gen), "# not the bytes this release rendered\n", "utf8");

  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.equal(planned.ok, false, "bytes no release rendered must never be bound as an instruction surface");
  if (planned.ok) return;
  assert.equal(planned.refusal.code, "adapter-not-ready");
  assert.match(planned.refusal.remediation.join("\n"), /forge upgrade/);
});

test("FG-576 AC8: a release that published no carrier degrades honestly instead of faking one", () => {
  publishCarrierGeneration({ withCarrier: false });

  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  assert.equal(planned.plan.carrier.acceptance, "unproven");
  assert.equal(planned.plan.argv.includes("-c"), false);
  assert.match(limitationNotes(planned.plan.limitations), /no Codex instruction carrier/);
  assert.match(limitationNotes(planned.plan.limitations), /forge upgrade/);
});

// ---------------------------------------------------------------------------
// AC2 / AC4 / AC6 — the argv Forge owns
// ---------------------------------------------------------------------------

test("FG-576 AC2/AC4/AC6: the Codex argv carries the policy model, the project root and the carrier once each — and no Claude flag", () => {
  publishCarrierGeneration();
  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  const argv = planned.plan.argv;

  const count = (flag: string): number => argv.filter((t) => t === flag || t.startsWith(`${flag}=`)).length;
  for (const flag of ["--model", "--cd", "-c"]) {
    assert.equal(count(flag), 1, `${flag} appears ${count(flag)}× in ${argv.join(" ")}`);
  }
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(argv[argv.indexOf("--cd") + 1], projectDir);

  // Forge's --profile is a MODEL-POLICY profile. It never becomes Codex's own config
  // profile, or one command line would carry two authorities over model and
  // instructions — the recorded decision and an unrecorded one.
  assert.equal(argv.includes("-p"), false, `Forge's --profile leaked onto the Codex command line: ${argv.join(" ")}`);
  assert.equal(argv.includes("--profile"), false);

  // Not one Claude flag anywhere: neither adapter can silently launch the other.
  for (const claudeFlag of ["--session-id", "--append-system-prompt", "--append-system-prompt-file", "-n"]) {
    assert.equal(argv.includes(claudeFlag), false, `Claude flag ${claudeFlag} reached the Codex argv`);
  }
});

test("FG-576 D6: passthrough may not set the provider, model, auth, project root, instruction surface or session identity", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(SUPPORTED_VERSION);

  for (const token of ["-m", "--model=gpt-4", "-c", "--config=x=1", "-p", "--profile=fast", "--cd", "--oss", "exec", "resume", "--last", "login"]) {
    const refusal = guardPassthrough(adapter, [token]);
    assert.ok(refusal, `passthrough token '${token}' was permitted`);
    assert.equal(refusal.code, "passthrough-not-permitted");
  }

  // A provider-native flag Forge does not own still works — passthrough exists for it.
  assert.equal(guardPassthrough(adapter, ["--sandbox", "workspace-write"]), null);

  // The reserved set is the adapter's own declaration, and it names both spellings of
  // every dimension Forge records.
  for (const flag of ["--model", "--config", "--profile", "--cd", "resume"]) {
    assert.ok(CODEX_RESERVED_PASSTHROUGH_FLAGS.includes(flag as never), `${flag} is not reserved`);
  }
});

// ---------------------------------------------------------------------------
// AC2 — auth isolation
// ---------------------------------------------------------------------------

test("FG-576 AC2: the Codex child environment is COMPOSED — no Claude credential or control reaches it", () => {
  publishCarrierGeneration();
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/op",
    GOPATH: "/home/op/go",
    OPENAI_BASE_URL: "https://example.invalid",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    ANTHROPIC_API_KEY: "claude-secret",
    AWS_PROFILE: "claude-only",
  } as NodeJS.ProcessEnv;
  const child = buildCodexChildEnv(parent);

  // Composed from the parent INDEPENDENTLY: Forge's Claude credential and control
  // families are withheld, whether the operator armed them or a `forge claude` shell
  // did. A Codex child that inherited them would make Claude's auth reachable from a
  // session whose recorded auth decision is Codex's.
  for (const claudeOwned of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "ANTHROPIC_API_KEY", "AWS_PROFILE"]) {
    assert.equal(claudeOwned in child, false, `${claudeOwned} reached the Codex child environment`);
  }

  // ...and the operator's own environment is NOT stripped: this child runs their
  // toolchain, so everything outside Forge's provider surface passes through.
  assert.deepEqual(child, { PATH: "/usr/bin", HOME: "/home/op", GOPATH: "/home/op/go", OPENAI_BASE_URL: "https://example.invalid" });

  assert.notEqual(child, parent, "the parent environment must never be handed to the child by reference");
  // D8: Forge does not point the child at another Codex home.
  assert.equal("CODEX_HOME" in child, false);
  assert.deepEqual(
    parent,
    {
      PATH: "/usr/bin",
      HOME: "/home/op",
      GOPATH: "/home/op/go",
      OPENAI_BASE_URL: "https://example.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      ANTHROPIC_API_KEY: "claude-secret",
      AWS_PROFILE: "claude-only",
    },
    "the parent was mutated",
  );
});

test("FG-576 AC2: preflight consults the Codex auth probe only, and never a Claude credential", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(SUPPORTED_VERSION);

  const available = decisionFor();
  assert.equal(available.authProbe.provider, "openai", "the resolver probed a provider other than the selected one");
  assert.deepEqual(adapter.preflight(contextFor(available)), []);

  // The project has no CLAUDE.md orchestrator block beyond the marker, no
  // .claude/settings.local.json and no .claude/commands — every Claude preflight
  // warning would fire here. None may.
  const unavailable: OrchestratorDecision = {
    ...available,
    authProbe: { provider: "openai", mode: "subscription", status: "unavailable", detail: "no ~/.codex/auth.json" } as AuthProbe,
  };
  const warnings = adapter.preflight(contextFor(unavailable));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /codex login/);
  assert.doesNotMatch(warnings.join("\n"), /CLAUDE\.md|\.claude|aws sso|forge auth login/i);
});

// ---------------------------------------------------------------------------
// AC9 / AC10 — session operations and provider-bound resume
// ---------------------------------------------------------------------------

test("FG-576 AC9: new and continue map onto Codex's own verbs and assert no identity before spawn", () => {
  publishCarrierGeneration();
  const adapter = adapterWithVersion(SUPPORTED_VERSION);
  const decision = decisionFor();

  assert.equal(adapter.declareSessionIdentityStrength(), "correlated");

  const fresh = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "new" } }));
  assert.ok(fresh.ok);
  assert.deepEqual(fresh.ok ? fresh.mapping.argv : null, []);
  assert.equal(fresh.ok ? fresh.mapping.identity.strength : null, "unknown");
  assert.match(fresh.ok ? String(fresh.mapping.identity.basis) : "", /cannot be told its session id/);

  const cont = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "continue" } }));
  assert.ok(cont.ok);
  assert.deepEqual(cont.ok ? cont.mapping.argv : null, ["resume", "--last"]);
  assert.equal(cont.ok ? cont.mapping.identity.strength : null, "unknown");
  assert.match(cont.ok ? limitationNotes(cont.mapping.limitations) : "", /session-operations/);
});

test("FG-576 AC10/D9: a Claude-minted identifier is refused by RECEIPT LOOKUP, not by identifier format", () => {
  publishCarrierGeneration();
  const claudeId = "11111111-2222-4333-8444-555555555555";
  const codexId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  // Deliberately the same SHAPE — both providers use bare UUIDs, so a format check
  // could not tell these apart and must never be what decides.
  persistPendingOrchestratorReceipt({
    sessionKey: claudeId,
    projectDir,
    runtime: "claude-oauth",
    provider: "anthropic",
    adapter: "claude-code",
    sessionOperation: "new",
    providerSessionId: claudeId,
  });
  persistPendingOrchestratorReceipt({
    sessionKey: codexId,
    projectDir,
    runtime: "codex-subscription",
    provider: "openai",
    adapter: "codex",
    sessionOperation: "new",
    providerSessionId: codexId,
  });

  const adapter = adapterWithVersion(SUPPORTED_VERSION);
  const decision = decisionFor();

  const refused = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "resume", sessionId: claudeId } }));
  assert.equal(refused.ok, false, "a Claude-minted session must not be resumable in Codex");
  if (!refused.ok) {
    assert.equal(refused.refusal.code, "cross-provider-resume");
    assert.match(refused.refusal.message, /claude-code/);
    assert.match(refused.refusal.message, /looked up in the Forge receipt that minted it, not guessed from its format/);
  }

  const allowed = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "resume", sessionId: codexId } }));
  assert.ok(allowed.ok, "a Codex-minted identifier of the SAME shape must be accepted");
  if (allowed.ok) {
    assert.deepEqual(allowed.mapping.argv, ["resume", codexId]);
    assert.equal(allowed.mapping.sessionTarget, codexId);
    // Never `asserted`: codex is told which session to open, not what to call itself.
    assert.equal(allowed.mapping.identity.strength, "correlated");
  }

  const unsafe = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "resume", sessionId: "--dangerously" } }));
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.ok ? "" : unsafe.refusal.code, "unsafe-session-identifier");
});

// ---------------------------------------------------------------------------
// AC9 — the correlation refuses to guess
// ---------------------------------------------------------------------------

function sessionRecord(id: string, cwd: string | null): CodexSessionRecord {
  return { sessionId: id, path: `/sessions/rollout-${id}.jsonl`, mtimeMs: 1, cwd };
}

test("FG-576 AC9: one new session in the project correlates; two are AMBIGUOUS, never a guess", () => {
  const baseline = new Set(["old-session"]);

  const none = correlateCodexSession({ sessions: [sessionRecord("old-session", projectDir)], projectDir, baseline });
  assert.equal(none.strength, "unknown");
  assert.equal(none.providerSessionId, null);

  const one = correlateCodexSession({
    sessions: [sessionRecord("old-session", projectDir), sessionRecord("new-a", projectDir)],
    projectDir,
    baseline,
  });
  assert.equal(one.strength, "correlated");
  assert.equal(one.providerSessionId, "new-a");
  assert.match(one.basis, /CORRELATED, not asserted/);

  const two = correlateCodexSession({
    sessions: [sessionRecord("new-a", projectDir), sessionRecord("new-b", projectDir)],
    projectDir,
    baseline,
  });
  assert.equal(two.strength, "ambiguous");
  assert.equal(two.providerSessionId, null, "an ambiguous correlation must bind NO identity");
  assert.match(two.basis, /new-a/);
  assert.match(two.basis, /new-b/);

  // Another project's session is not a candidate, and neither is one that declares no
  // project at all — attribution is fail-closed.
  const elsewhere = correlateCodexSession({
    sessions: [sessionRecord("new-c", "/somewhere/else"), sessionRecord("new-d", null)],
    projectDir,
    baseline,
  });
  assert.equal(elsewhere.strength, "unknown");
});

test("FG-576 AC13: the session reader resolves through FORGE_CODEX_DIR and reads codex's own rollout shape", () => {
  const codexDir = join(base, "codex-state");
  const day = join(codexDir, "sessions", "2026", "08", "07");
  mkdirSync(day, { recursive: true });
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  writeFileSync(
    join(day, `rollout-2026-08-07T12-00-00-${id}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: projectDir } })}\n{"type":"message"}\n`,
    "utf8",
  );
  writeFileSync(join(day, "not-a-rollout.txt"), "ignored\n", "utf8");

  process.env["FORGE_CODEX_DIR"] = codexDir;
  const sessions = listCodexSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, id);
  assert.equal(sessions[0]!.cwd, projectDir);

  // An absent root is an empty answer, never a throw: provider-internal state is
  // fragile by construction and a reader that threw would break the launcher.
  process.env["FORGE_CODEX_DIR"] = join(base, "does-not-exist");
  assert.deepEqual(listCodexSessions(), []);
});

// ---------------------------------------------------------------------------
// FG-253 RF-5 — the launch-boundary generation split judges the BOUND carrier
// ---------------------------------------------------------------------------
//
// Codex resolves its instruction carrier out of the PUBLISHED seed generation, so a
// failed or deferred publication leaves a session running new code while bound to an
// older generation's orientation bytes. The adapter-split report used to compare the
// project against the RUNNING assets, which is wrong in both directions: silence when
// the bound carrier disagrees with the project, and a warning when it agrees.
// Detectability is what step 8 shipped in place of atomicity, so a detector that is
// wrong in both directions is worse than none.

/** Publish a generation whose source tree NAMES itself the way a release does, so the
 *  bound generation has a stamp that is not this checkout's. */
function publishNamedGeneration(id: string): SeedGeneration {
  const gen = publishCarrierGeneration();
  writeFileSync(join(gen.manifest.sourceAssetRoot, "forge-release.json"), JSON.stringify({ id }), "utf8");
  return gen;
}

function installProjectAdapters(stamp: AdapterStamp): void {
  for (const base of projectAdapterBaseline(stamp)) {
    const target = join(projectDir, ...base.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, base.bytes, "utf8");
  }
}

function adapterLimitation(plan: { limitations: readonly { capability: string; note: string }[] }) {
  return plan.limitations.find((l) => l.capability === "operator-adapters");
}

test("FG-253 RF-5: adapters that agree with the RUNNING assets are still reported when the session is bound to an older generation", () => {
  const boundId = "release-fg253-codexbound-01";
  publishNamedGeneration(boundId);
  assert.notEqual(currentAdapterStamp(), boundId, "the fixture must differ from the running assets");
  installProjectAdapters(currentAdapterStamp());

  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);

  const limitation = adapterLimitation(planned.plan);
  assert.ok(limitation, "a session bound to another generation reported agreement it does not have");
  assert.match(limitation.note, new RegExp(boundId), "the report must name the generation actually bound");
  assert.match(limitation.note, new RegExp(currentAdapterStamp()));
});

test("FG-253 RF-5: adapters that agree with the BOUND generation report nothing, even when the running assets differ", () => {
  const boundId = "release-fg253-codexbound-02";
  publishNamedGeneration(boundId);
  installProjectAdapters(boundId);

  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  assert.equal(
    adapterLimitation(planned.plan),
    undefined,
    "warning about adapters that match the carrier this session is bound to is a false positive",
  );
});

test("FG-253 RF-5: a bound generation with no nameable release is reported unverifiable, not as agreement", () => {
  // publishCarrierGeneration's source tree carries no release manifest — a dev
  // checkout that is not the running one, whose content identity this process cannot
  // compute. Silence there would be a claim; so would a comparison.
  publishCarrierGeneration();
  installProjectAdapters(currentAdapterStamp());

  const planned = planLaunch(adapterWithVersion(SUPPORTED_VERSION), contextFor(decisionFor()));
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);

  const limitation = adapterLimitation(planned.plan);
  assert.ok(limitation, "an unnameable binding must be reported, not silently compared against the running assets");
  assert.match(limitation.note, /cannot be compared/);
});
