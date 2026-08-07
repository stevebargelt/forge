// FG-576 step 3 — orchestrator launch resolution and the pre-spawn gates.
//
// Table-driven over FIXTURE model-policy files written into a disposable
// FORGE_HOME / project dir. AC13: the operator's policy, credentials and config
// roots are NEVER read — FORGE_HOME and FORGE_CODEX_DIR are redirected for every
// test, the auth probe is injected by default, and nothing here spawns anything.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModel, type EffectiveAuth } from "./model-resolution.js";
import type { AuthProbe } from "./provider-doctor.js";
import {
  ORCHESTRATOR_REFUSAL_CODES,
  explainDecision,
  resolveOrchestratorLaunch,
  supportedInteractiveRuntimes,
  type OrchestratorDecision,
  type OrchestratorLaunchRequest,
  type OrchestratorRefusal,
} from "./orchestrator-resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILES = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5, cost_tier: premium }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
  codex-subscription:
    provider: openai
    auth: subscription
    map:
      default: { model: gpt-5.6-terra, cost_tier: standard }
  pi-groq:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
  no-default:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5, cost_tier: premium }
`;

/** Baseline: no orchestrator override anywhere. defaults.profile decides. */
const POLICY_DEFAULT = `${PROFILES}
defaults:
  profile: claude-subscription
  activity: {}
`;

/** AC3's recipe, verbatim as an operator would type it: ONE line under
 *  overrides.agents makes Codex the interactive orchestrator. */
const POLICY_CODEX_ORCHESTRATOR = `${PROFILES}
defaults:
  profile: claude-subscription
  activity: {}
overrides:
  agents:
    orchestrator: codex-subscription
`;

const POLICY_ACTIVITY_DEFAULT = `${PROFILES}
defaults:
  profile: claude-subscription
  activity:
    default: claude-bedrock
`;

const POLICY_PI_ORCHESTRATOR = `${PROFILES}
defaults:
  profile: claude-subscription
  activity: {}
overrides:
  agents:
    orchestrator: pi-groq
`;

const POLICY_CEILING = `${PROFILES}
defaults:
  profile: claude-subscription
  activity: {}
overrides:
  agents:
    orchestrator: claude-bedrock
allowed_profiles: [claude-subscription, codex-subscription]
`;

const POLICY_NO_DEFAULT_MAP = `${PROFILES}
defaults:
  profile: no-default
  activity: {}
`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let codexDir: string;
let envSnap: Record<string, string | undefined>;

const ENV_KEYS = [
  "FORGE_HOME",
  "FORGE_CODEX_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_API_KEY",
  "AWS_PROFILE",
];

beforeEach(() => {
  envSnap = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  homeDir = mkdtempSync(join(tmpdir(), "fg576-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg576-proj-"));
  codexDir = mkdtempSync(join(tmpdir(), "fg576-codex-"));
  process.env.FORGE_HOME = homeDir;
  // AC13: the Codex subscription probe reads FORGE_CODEX_DIR/auth.json. Pointing
  // it at a disposable dir is what keeps the operator's ~/.codex out of every
  // test on this file, including the ones that use the REAL probe.
  process.env.FORGE_CODEX_DIR = codexDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [homeDir, projectDir, codexDir]) rmSync(d, { recursive: true, force: true });
});

function writeHostPolicy(yaml: string): void {
  writeFileSync(join(homeDir, "model-policy.yml"), yaml);
}

function writeProjectPolicy(yaml: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), yaml);
}

type ProbeCall = { provider: string; mode: EffectiveAuth };

/** Records every (provider, auth) the launcher probes, so "the SELECTED provider
 *  only" is asserted rather than assumed. */
function recordingProbe(status: AuthProbe["status"] = "available") {
  const calls: ProbeCall[] = [];
  const probe = (provider: string, mode: EffectiveAuth): AuthProbe => {
    calls.push({ provider, mode });
    return { provider, mode, status, detail: `stub probe: ${provider}/${mode} ${status}` };
  };
  return { calls, probe };
}

function launch(req: Partial<OrchestratorLaunchRequest> = {}) {
  const { calls, probe } = recordingProbe();
  const res = resolveOrchestratorLaunch({ projectDir, authProbe: probe, ...req });
  return { res, calls };
}

function decisionOf(res: ReturnType<typeof resolveOrchestratorLaunch>): OrchestratorDecision {
  assert.equal(res.ok, true, res.ok ? "" : `refused: ${res.refusal.message}`);
  if (!res.ok) throw new Error("unreachable");
  return res.decision;
}

function refusalOf(res: ReturnType<typeof resolveOrchestratorLaunch>): OrchestratorRefusal {
  assert.equal(res.ok, false, res.ok ? `expected a refusal, got ${JSON.stringify(res.decision)}` : "");
  if (res.ok) throw new Error("unreachable");
  return res.refusal;
}

// ---------------------------------------------------------------------------
// AC5 — structural: this module cannot spawn anything
// ---------------------------------------------------------------------------

test("AC5: no spawn path is reachable from the resolution module at all", () => {
  for (const f of ["orchestrator-resolve.ts", "orchestrator-capabilities.ts"]) {
    const src = readFileSync(join(HERE, f), "utf8");
    for (const forbidden of ["node:child_process", "child_process", "spawnSync", "execSync", "execFile"]) {
      assert.ok(
        !src.includes(forbidden),
        `${f} references ${forbidden} — pre-spawn refusal must be structural, not a code path someone remembers`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// AC1 / AC3 — policy selects the adapter
// ---------------------------------------------------------------------------

test("AC1: no orchestrator override → defaults.profile, and the adapter is NAMED", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const { res } = launch();
  const d = decisionOf(res);
  assert.equal(d.profile, "claude-subscription");
  assert.equal(d.adapter, "claude-code");
  assert.equal(d.provider, "anthropic");
  assert.equal(d.runtime, "claude-oauth");
  assert.equal(d.model, "claude-sonnet-4-6");
  assert.equal(d.auth, "subscription");
  assert.equal(d.resolvedBy, "defaults.profile");
  assert.equal(d.modelResolvedBy, "profile.map.default");
  assert.equal(d.alias, "default");
  assert.equal(d.legacy, false);
  assert.equal(d.policySource, "host");
  assert.equal(d.policyPath, join(homeDir, "model-policy.yml"));
});

test("AC3: `overrides.agents.orchestrator: codex-subscription` alone selects the Codex adapter", () => {
  // The ONLY change versus the AC1 case is one line in the host policy file: no
  // Forge source edit, no shell alias, no per-project file.
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const { res } = launch();
  const d = decisionOf(res);
  assert.equal(d.profile, "codex-subscription");
  assert.equal(d.adapter, "codex");
  assert.equal(d.provider, "openai");
  assert.equal(d.runtime, "codex-subscription");
  assert.equal(d.model, "gpt-5.6-terra");
  assert.equal(d.resolvedBy, "overrides.agents.orchestrator");
  assert.equal(d.sessionIdentityStrength, "correlated");
});

test("AC1: a PROJECT policy replaces the host policy for this launch", () => {
  writeHostPolicy(POLICY_DEFAULT);
  writeProjectPolicy(POLICY_CODEX_ORCHESTRATOR);
  const d = decisionOf(launch().res);
  assert.equal(d.adapter, "codex");
  assert.equal(d.policySource, "project");
  assert.equal(d.policyPath, join(projectDir, ".forge", "model-policy.yml"));
});

// ---------------------------------------------------------------------------
// AC4 — precedence and provenance
// ---------------------------------------------------------------------------

test("AC4: --profile beats overrides beats defaults.activity beats defaults.profile, each with a DISTINCT resolved_by", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const fromDefaultProfile = decisionOf(launch().res);
  assert.equal(fromDefaultProfile.resolvedBy, "defaults.profile");
  assert.equal(fromDefaultProfile.profile, "claude-subscription");

  writeHostPolicy(POLICY_ACTIVITY_DEFAULT);
  const fromActivity = decisionOf(launch().res);
  assert.equal(fromActivity.resolvedBy, "defaults.activity.default");
  assert.equal(fromActivity.profile, "claude-bedrock");

  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const fromOverride = decisionOf(launch().res);
  assert.equal(fromOverride.resolvedBy, "overrides.agents.orchestrator");
  assert.equal(fromOverride.profile, "codex-subscription");

  const fromCli = decisionOf(launch({ cliProfile: "claude-subscription" }).res);
  assert.equal(fromCli.resolvedBy, "cli.--profile");
  assert.equal(fromCli.profile, "claude-subscription");

  const tokens = [fromDefaultProfile, fromActivity, fromOverride, fromCli].map((d) => d.resolvedBy);
  assert.equal(new Set(tokens).size, 4, `resolved_by tokens must be distinct: ${tokens.join(", ")}`);
});

test("AC4: --profile provenance can be relabelled by the calling surface", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const d = decisionOf(launch({ cliProfile: "claude-bedrock", profileSource: "forge claude --profile" }).res);
  assert.equal(d.resolvedBy, "forge claude --profile");
});

test("AC14: --model=<alias> accepted by the Claude adapter survives and is recorded VERBATIM", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const d = decisionOf(launch({ cliModel: "opus" }).res);
  assert.equal(d.model, "opus", "the alias is recorded verbatim, never normalized to a concrete id");
  assert.equal(d.modelExplicit, true);
  assert.equal(d.modelResolvedBy, "cli.--model");
  // The MODEL token is distinct from the PROFILE token: an explicit --model must
  // never be mistakable for a policy selection.
  assert.equal(d.resolvedBy, "defaults.profile");
  assert.notEqual(d.modelResolvedBy, d.resolvedBy);
});

test("AC4: --model is validated against the ADAPTER's vocabulary, not the policy's id set", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const r = refusalOf(launch({ cliModel: "gpt-5.6-terra" }).res);
  assert.equal(r.code, "model-not-accepted");
  assert.match(r.message, /Claude Code adapter/);
  assert.ok(r.remediation.length > 0);

  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const r2 = refusalOf(launch({ cliModel: "opus" }).res);
  assert.equal(r2.code, "model-not-accepted");
  assert.equal(r2.adapter, "codex");
  assert.match(r2.message, /profile 'codex-subscription'/);
});

test("AC4: a policy-selected model id is NOT restricted to the adapter's CLI vocabulary", () => {
  // The policy map is the escape hatch the --model refusal points at. A concrete
  // id an operator maps in policy must resolve even though the CLI-flag validator
  // would not accept the same string.
  writeHostPolicy(`${PROFILES}  exotic:
    provider: anthropic
    auth: subscription
    map:
      default: { model: "some-internal-build-42", cost_tier: standard }
defaults:
  profile: exotic
  activity: {}
`);
  const d = decisionOf(launch().res);
  assert.equal(d.model, "some-internal-build-42");
  assert.equal(d.modelResolvedBy, "profile.map.default");
});

// ---------------------------------------------------------------------------
// AC5 — unsupported runtime fails before spawn
// ---------------------------------------------------------------------------

test("AC5: a pi-runtime orchestrator resolution is REFUSED, naming profile, runtime, reason and remedy", () => {
  writeHostPolicy(POLICY_PI_ORCHESTRATOR);
  const { res, calls } = launch();
  const r = refusalOf(res);
  assert.equal(r.code, "unsupported-runtime");
  assert.match(r.message, /pi-groq/, "the refusal must name the SELECTED PROFILE");
  assert.match(r.message, /pi-apikey/, "the refusal must name the RUNTIME");
  assert.match(r.message, /no interactive orchestrator adapter/i, "the refusal must say WHY");
  assert.match(r.message, /Fix:/);
  assert.ok(r.remediation.length >= 2, "a refusal must carry concrete remedies");
  assert.equal(r.profile, "pi-groq");
  assert.equal(r.runtime, "pi-apikey");
  assert.match(r.message, new RegExp(supportedInteractiveRuntimes().join(".*")));
  assert.match(r.message, /never silently substituting|refuses before spawn/i);
  // The refusal happens BEFORE any credential is consulted.
  assert.deepEqual(calls, []);
});

test("AC5: an unknown runtime name is refused generically rather than falling through", () => {
  writeHostPolicy(`${PROFILES}  ghost:
    provider: anthropic
    auth: subscription
    runtime: some-future-runtime
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: ghost
  activity: {}
`);
  const r = refusalOf(launch().res);
  assert.equal(r.code, "unsupported-runtime");
  assert.match(r.message, /some-future-runtime/);
  assert.match(r.message, /not one of the interactive adapters this build ships/);
});

// ---------------------------------------------------------------------------
// allowed_profiles — the ceiling lives at the LAUNCH boundary only
// ---------------------------------------------------------------------------

test("allowed_profiles refuses the orchestrator launch, naming the ceiling and both remedies", () => {
  writeHostPolicy(POLICY_CEILING);
  const r = refusalOf(launch().res);
  assert.equal(r.code, "profile-not-allowed");
  assert.match(r.message, /claude-bedrock/);
  assert.match(r.message, /allowed_profiles/);
  assert.match(r.message, /'claude-subscription', 'codex-subscription'/);
  assert.ok(r.remediation.length >= 2);
});

test("NON-GOAL PRESERVED: the ceiling is not enforced for any other agent role", () => {
  writeHostPolicy(POLICY_CEILING);
  // The SAME disallowed profile, resolved through the shared resolver for a
  // containerized task agent, is byte-identical to today: it resolves, it is not
  // refused, and nothing about it mentions the ceiling.
  const engineer = resolveModel({ agentRole: "engineer", cliProfile: "claude-bedrock", ctx: { projectDir } });
  assert.equal(engineer.profile, "claude-bedrock");
  assert.equal(engineer.runtime, "claude-bedrock");
  assert.equal(engineer.model, "us.anthropic.claude-sonnet-4-6");
  assert.equal(engineer.resolvedBy, "cli.--profile");

  // And a second call after an orchestrator launch has been resolved is identical
  // — the launch boundary mutates no shared state.
  refusalOf(launch().res);
  const again = resolveModel({ agentRole: "engineer", cliProfile: "claude-bedrock", ctx: { projectDir } });
  assert.deepEqual(again, engineer);
});

test("an empty allowed_profiles means every defined profile may launch", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const d = decisionOf(launch({ cliProfile: "claude-bedrock" }).res);
  assert.equal(d.profile, "claude-bedrock");
  assert.equal(d.runtime, "claude-bedrock");
  assert.equal(d.auth, "bedrock");
});

// ---------------------------------------------------------------------------
// D5 / D16 — the provider pin refuses the resolution it ACTUALLY got
// ---------------------------------------------------------------------------

test("D5/D16: a Claude shortcut under a Codex-resolving policy refuses with BOTH remedies", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const { res, calls } = launch({ providerPin: "claude-code", providerPinSource: "forge claude" });
  const r = refusalOf(res);
  assert.equal(r.code, "provider-pin-mismatch");
  assert.match(r.message, /forge claude/);
  assert.match(r.message, /codex-subscription/, "names the resolved profile");
  assert.match(r.message, /Codex CLI/, "names what policy actually resolved");
  assert.match(r.message, /provider 'openai'/);
  assert.match(r.message, /forge orchestrator/, "remedy 1: launch what policy selected");
  assert.match(r.message, /--profile|overrides\.agents\.orchestrator/, "remedy 2: choose a compatible profile");
  assert.match(r.message, /never|Refusing rather than/i);
  assert.equal(r.adapter, "codex");
  assert.equal(r.runtime, "codex-subscription");
  // D5: refusing, NOT re-resolving. No auth was probed for either provider.
  assert.deepEqual(calls, []);
});

test("D5: the pin never changes WHICH profile policy selects — it only refuses after", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const withPin = launch({ providerPin: "claude-code", providerPinSource: "forge claude" });
  const withoutPin = decisionOf(launch().res);
  const r = refusalOf(withPin.res);
  // Same profile in both cases: the pinned command reports the resolution it got.
  assert.equal(r.profile, withoutPin.profile);
  assert.equal(r.runtime, withoutPin.runtime);
});

test("D5: a matching pin launches normally and is recorded on the decision", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const d = decisionOf(launch({ providerPin: "claude-code", providerPinSource: "forge claude" }).res);
  assert.equal(d.adapter, "claude-code");
  assert.equal(d.providerPin, "claude-code");
});

test("D5: a Claude shortcut under a PI-resolving policy still refuses as a pin mismatch, naming the runtime", () => {
  writeHostPolicy(POLICY_PI_ORCHESTRATOR);
  const r = refusalOf(launch({ providerPin: "claude-code", providerPinSource: "forge claude" }).res);
  assert.equal(r.code, "provider-pin-mismatch");
  assert.match(r.message, /pi-apikey/);
  assert.match(r.message, /no interactive adapter at all/);
});

// ---------------------------------------------------------------------------
// Auth coherence — the SELECTED provider only
// ---------------------------------------------------------------------------

test("AC2: a Claude resolution probes anthropic ONCE and never consults a Codex credential", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const { res, calls } = launch();
  decisionOf(res);
  assert.deepEqual(calls, [{ provider: "anthropic", mode: "subscription" }]);
});

test("AC2: a Codex resolution probes openai ONCE and never consults a Claude credential", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const { res, calls } = launch();
  decisionOf(res);
  assert.deepEqual(calls, [{ provider: "openai", mode: "subscription" }]);
});

test("AC2: a bedrock-resolving profile probes anthropic/bedrock only", () => {
  writeHostPolicy(POLICY_ACTIVITY_DEFAULT);
  const { res, calls } = launch();
  const d = decisionOf(res);
  assert.equal(d.auth, "bedrock");
  assert.deepEqual(calls, [{ provider: "anthropic", mode: "bedrock" }]);
});

test("an unavailable credential for the selected provider refuses before spawn, with a provider-correct remedy", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const { probe } = recordingProbe("unavailable");
  const r = refusalOf(resolveOrchestratorLaunch({ projectDir, authProbe: probe }));
  assert.equal(r.code, "auth-unavailable");
  assert.match(r.message, /codex-subscription/);
  assert.match(r.message, /provider 'openai' auth 'subscription'/);
  assert.match(r.message, /codex login/, "the remedy must be the CODEX one, never a Claude one");
  assert.ok(!/forge auth login/.test(r.message), "no Claude remedy may appear on a Codex refusal");
});

test("an UNKNOWN probe never blocks — uncertainty is not unavailability", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const { probe } = recordingProbe("unknown");
  const d = decisionOf(resolveOrchestratorLaunch({ projectDir, authProbe: probe }));
  assert.equal(d.authProbe.status, "unknown");
});

test("REAL probe, disposable roots: the Codex credential decides a Codex launch and nothing else", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  // No ~/.codex/auth.json in the disposable FORGE_CODEX_DIR → refused.
  const missing = refusalOf(resolveOrchestratorLaunch({ projectDir }));
  assert.equal(missing.code, "auth-unavailable");
  assert.match(missing.message, /codex login/);

  // Mint it in the DISPOSABLE root only (AC13 — the operator's ~/.codex is never
  // touched, because FORGE_CODEX_DIR points elsewhere for this whole file).
  writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "fake" } }));
  const d = decisionOf(resolveOrchestratorLaunch({ projectDir }));
  assert.equal(d.adapter, "codex");
  assert.equal(d.authProbe.status, "available");
  assert.equal(d.authProbe.provider, "openai");

  // The SAME present Codex credential is not evidence a Claude launch may
  // proceed on Codex terms: a Claude resolution probes anthropic, whose OAuth
  // hint is absent from the disposable FORGE_HOME.
  writeHostPolicy(POLICY_DEFAULT);
  const claude = decisionOf(resolveOrchestratorLaunch({ projectDir }));
  assert.equal(claude.authProbe.provider, "anthropic");
  assert.equal(claude.authProbe.status, "unknown");
  assert.ok(!/codex/i.test(claude.authProbe.detail));
});

// ---------------------------------------------------------------------------
// Legacy mode — a concrete provider, never an empty one
// ---------------------------------------------------------------------------

test("legacy: no policy file records a CONCRETE provider/adapter/runtime and flags the absent model", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0"; // pin auth detection: oauth, on every host
  const d = decisionOf(launch().res);
  assert.equal(d.legacy, true);
  assert.equal(d.policySource, "absent");
  assert.equal(d.policyPath, undefined);
  assert.equal(d.profile, undefined);
  assert.equal(d.provider, "anthropic", "legacy must record a concrete provider, not an empty one");
  assert.equal(d.adapter, "claude-code");
  assert.equal(d.runtime, "claude-oauth");
  assert.equal(d.auth, "subscription");
  assert.equal(d.resolvedBy, "legacy");
  assert.equal(d.model, "");
  assert.equal(d.modelExplicit, false);
  assert.equal(d.modelResolvedBy, "legacy.provider-default");
  assert.ok(
    d.notes.some((n) => /no model-policy\.yml is in effect/.test(n)),
    "the absent model must be a RECORDED note, not a silently invented model",
  );
});

test("legacy: detected auth picks the concrete runtime", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  assert.equal(decisionOf(launch().res).runtime, "claude-bedrock");
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  process.env.ANTHROPIC_API_KEY = "sk-fake";
  assert.equal(decisionOf(launch().res).runtime, "claude-apikey");
});

test("AC14: legacy + `--model opus` still launches Claude with the alias recorded", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  const d = decisionOf(launch({ cliModel: "opus", providerPin: "claude-code" }).res);
  assert.equal(d.model, "opus");
  assert.equal(d.modelExplicit, true);
  assert.equal(d.modelResolvedBy, "cli.--model");
  assert.equal(d.notes.length, 0, "an explicit model leaves nothing unrecorded");
});

test("legacy: a Codex pin records openai concretely rather than defaulting to anthropic", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  const { res, calls } = launch({ providerPin: "codex" });
  const d = decisionOf(res);
  assert.equal(d.adapter, "codex");
  assert.equal(d.provider, "openai");
  assert.equal(d.runtime, "codex-subscription");
  assert.deepEqual(calls, [{ provider: "openai", mode: "subscription" }]);
});

// ---------------------------------------------------------------------------
// Policy errors become named, remediable refusals
// ---------------------------------------------------------------------------

test("an undefined --profile is a named refusal listing the defined profiles", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const r = refusalOf(launch({ cliProfile: "ghost" }).res);
  assert.equal(r.code, "unknown-profile");
  assert.match(r.message, /ghost/);
  assert.match(r.message, /claude-subscription/);
});

test("a profile with no `default` mapping is a named refusal, not an exception", () => {
  writeHostPolicy(POLICY_NO_DEFAULT_MAP);
  const r = refusalOf(launch().res);
  assert.equal(r.code, "no-capability-mapping");
  assert.match(r.message, /no-default/);
  assert.match(r.message, /default/);
  assert.equal(r.profile, "no-default");
});

test("an unparseable policy is a named refusal, not an exception", () => {
  writeHostPolicy("model_profiles: [this is not a mapping\n");
  const r = refusalOf(launch().res);
  assert.equal(r.code, "policy-error");
  assert.ok(r.remediation.length > 0);
});

test("a schema-invalid policy is a named refusal, not an exception", () => {
  writeHostPolicy("model_profiles: {}\ndefaults:\n  profile: nope\n");
  const r = refusalOf(launch().res);
  assert.equal(r.code, "policy-error");
});

// ---------------------------------------------------------------------------
// Session operations (D9 input to the adapters)
// ---------------------------------------------------------------------------

test("the requested session operation is carried onto the decision verbatim", () => {
  writeHostPolicy(POLICY_DEFAULT);
  assert.deepEqual(decisionOf(launch().res).operation, { kind: "new" });
  assert.deepEqual(decisionOf(launch({ operation: { kind: "continue" } }).res).operation, { kind: "continue" });
  const resume = decisionOf(launch({ operation: { kind: "resume", sessionId: "abc-123" } }).res);
  assert.deepEqual(resume.operation, { kind: "resume", sessionId: "abc-123" });
});

test("an empty --resume identifier is refused before anything else happens", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const { res, calls } = launch({ operation: { kind: "resume", sessionId: "  " } });
  const r = refusalOf(res);
  assert.equal(r.code, "invalid-session-operation");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Recorded capability limitations + the explain surface
// ---------------------------------------------------------------------------

test("AC12: a Codex decision carries the usage limitation as a RECORDED value", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const d = decisionOf(launch().res);
  const usage = d.limitations.find((l) => l.capability === "usage-capture");
  assert.ok(usage, "the Codex usage gap must be recorded on the decision");
  assert.equal(usage.support, "unsupported");
  assert.match(usage.note, /fabricat/i);
  assert.ok(d.limitations.some((l) => l.capability === "heartbeat"));
  assert.ok(d.limitations.some((l) => l.capability === "remote-control"));
});

test("a Claude decision carries only the gaps Claude actually has", () => {
  writeHostPolicy(POLICY_DEFAULT);
  const d = decisionOf(launch().res);
  assert.ok(!d.limitations.some((l) => l.capability === "usage-capture"));
  assert.ok(!d.limitations.some((l) => l.capability === "heartbeat"));
  assert.equal(d.sessionIdentityStrength, "asserted");
});

test("AC15: explainDecision reports the seven recorded launch fields, in order", () => {
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  const d = decisionOf(launch().res);
  const rows = explainDecision(d);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["profile", "runtime", "provider", "model", "auth", "adapter", "resolved_by"],
  );
  for (const r of rows) assert.ok(r.value.trim().length > 0, `${r.label} rendered empty`);
  assert.match(rows[0]!.value, /codex-subscription/);
  assert.match(rows[3]!.value, /gpt-5\.6-terra/);
  assert.match(rows[5]!.value, /codex/);
});

test("AC15: explain names the absent legacy model rather than showing an empty field", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  const rows = explainDecision(decisionOf(launch().res));
  assert.match(rows[0]!.value, /no model-policy\.yml/);
  assert.match(rows[3]!.value, /none recorded/);
});

// ---------------------------------------------------------------------------
// Refusal hygiene — every code carries an actionable remedy
// ---------------------------------------------------------------------------

test("every refusal this module can emit names a remedy, and the code set is closed", () => {
  assert.equal(new Set(ORCHESTRATOR_REFUSAL_CODES).size, ORCHESTRATOR_REFUSAL_CODES.length);
  const emitted: OrchestratorRefusal[] = [];

  writeHostPolicy("model_profiles: [nope\n");
  emitted.push(refusalOf(launch().res));
  writeHostPolicy(POLICY_DEFAULT);
  emitted.push(refusalOf(launch({ cliProfile: "ghost" }).res));
  writeHostPolicy(POLICY_NO_DEFAULT_MAP);
  emitted.push(refusalOf(launch().res));
  writeHostPolicy(POLICY_CEILING);
  emitted.push(refusalOf(launch().res));
  writeHostPolicy(POLICY_PI_ORCHESTRATOR);
  emitted.push(refusalOf(launch().res));
  writeHostPolicy(POLICY_CODEX_ORCHESTRATOR);
  emitted.push(refusalOf(launch({ providerPin: "claude-code", providerPinSource: "forge claude" }).res));
  emitted.push(refusalOf(launch({ cliModel: "opus" }).res));
  const { probe } = recordingProbe("unavailable");
  emitted.push(refusalOf(resolveOrchestratorLaunch({ projectDir, authProbe: probe })));
  emitted.push(refusalOf(launch({ operation: { kind: "resume", sessionId: "" } }).res));

  for (const r of emitted) {
    assert.ok(ORCHESTRATOR_REFUSAL_CODES.includes(r.code), `unknown refusal code ${r.code}`);
    assert.ok(r.remediation.length > 0, `${r.code} carries no remedy`);
    assert.match(r.message, /Fix:/, `${r.code} does not render its remedies`);
    for (const remedy of r.remediation) assert.ok(remedy.trim().length > 0);
  }
  // Every declared code is actually reachable — a dead code would be an
  // un-testable branch masquerading as coverage.
  assert.deepEqual(
    [...new Set(emitted.map((r) => r.code))].sort(),
    [...ORCHESTRATOR_REFUSAL_CODES].sort(),
  );
});
