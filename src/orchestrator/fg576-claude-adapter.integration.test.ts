// FG-576 step 5 — the CLAUDE ADAPTER's half of the provider-neutral contract.
//
// These exercise the adapter members directly (probeReadiness / declareInstruction-
// Carrier / mapSessionOperation / buildArgv / buildChildEnv / preflight) rather than
// through a spawn, because the properties that matter are properties of the PLAN:
// what would reach the child, and what would be recorded about it. A test that could
// only observe them after a spawn could not assert the pre-spawn ones at all.
//
// Nothing here reads or writes real auth, a real Claude config root, or the
// operator's model policy: the help probe is injected, the policy is a fixture in a
// disposable FORGE_HOME, and no executable is spawned (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../store/db.js";
import { persistPendingOrchestratorReceipt } from "../store/orchestrator-receipts.js";
import { resolveOrchestratorLaunch, type OrchestratorDecision, type OrchestratorSessionOperation } from "../v2/orchestrator-resolve.js";
import type { AuthProbe } from "../v2/provider-doctor.js";
import {
  buildClaudeChildEnv,
  claudeProjectPreflight,
  createClaudeAdapter,
  resolveClaudeBedrockProfile,
  CLAUDE_RESERVED_PASSTHROUGH_FLAGS,
} from "./claude-adapter.js";
import { guardPassthrough, planLaunch, mintSessionKey } from "./launch.js";
import type { AdapterLaunchContext, OrchestratorAdapter } from "./adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CANONICAL_TEMPLATE = join(REPO_ROOT, "seeds", "orchestrator-template.md");

const POLICY = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

const HELP_WITH_FILE_FLAG = "Options:\n  --append-system-prompt-file <path>\n  --append-system-prompt <prompt>\n";
const HELP_WITH_INLINE_ONLY = "Options:\n  --append-system-prompt <prompt>\n";
const HELP_WITH_NEITHER = "Options:\n  --model <model>\n";

const ALWAYS_AVAILABLE = (provider: string, mode: string): AuthProbe =>
  ({ provider, mode, status: "available", detail: "fixture probe" }) as AuthProbe;

let base: string;
let home: string;
let projectDir: string;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = ["FORGE_HOME", "FORGE_DB_PATH", "AWS_PROFILE", "CLAUDE_CODE_USE_BEDROCK"] as const;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-claude-adapter-")));
  home = join(base, "forge-home");
  projectDir = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(projectDir, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\n`, "utf8");

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
  closeDb();
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function decisionFor(overrides: { cliProfile?: string; cliModel?: string; operation?: OrchestratorSessionOperation } = {}): OrchestratorDecision {
  const res = resolveOrchestratorLaunch({
    projectDir,
    authProbe: ALWAYS_AVAILABLE as never,
    ...overrides,
  });
  assert.ok(res.ok, `fixture policy failed to resolve: ${res.ok ? "" : res.refusal.message}`);
  return res.decision;
}

function contextFor(
  decision: OrchestratorDecision,
  extra: Partial<AdapterLaunchContext> = {},
): AdapterLaunchContext {
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

function adapterWithHelp(help: string | null): OrchestratorAdapter {
  return createClaudeAdapter({ helpProbe: () => help });
}

// ---------------------------------------------------------------------------
// Readiness: EVIDENCE about the installed build, never an assumption
// ---------------------------------------------------------------------------

test("integ FG-576: the carrier binds the instruction flag the installed build actually advertises", () => {
  const decision = decisionFor();

  for (const [help, expectedFlag] of [
    [HELP_WITH_FILE_FLAG, "--append-system-prompt-file"],
    [HELP_WITH_INLINE_ONLY, "--append-system-prompt"],
  ] as const) {
    const adapter = adapterWithHelp(help);
    const ctx = contextFor(decision);
    const readiness = adapter.probeReadiness(ctx);
    assert.ok(readiness.ok);
    const carrier = adapter.declareInstructionCarrier(ctx, readiness.readiness);

    assert.equal(carrier.argv[0], expectedFlag);
    assert.equal(carrier.acceptance, "accepted");
    assert.match(String(carrier.evidence), new RegExp(`claude --help advertises \\${expectedFlag}`));
    assert.match(String(carrier.generation), /^(dev|release)@[0-9a-f]{16}$/);
  }
});

test("integ FG-576 AC8-shape: a build advertising NO instruction flag binds no carrier and NAMES the gap", () => {
  const adapter = adapterWithHelp(HELP_WITH_NEITHER);
  const ctx = contextFor(decisionFor());
  const readiness = adapter.probeReadiness(ctx);
  assert.ok(readiness.ok);

  // Constructing a flag is never evidence it was honored — so when the build gives
  // no evidence, nothing is claimed and the limitation is a RECORDED value.
  assert.equal(readiness.readiness.evidence["carrierFlag"], undefined);
  const gap = readiness.readiness.limitations.find((l) => l.capability === "instruction-source");
  assert.ok(gap, "a build with no instruction flag must record the gap");
  assert.match(gap.note, /advertises neither/);

  const carrier = adapter.declareInstructionCarrier(ctx, readiness.readiness);
  assert.deepEqual([...carrier.argv], []);
  assert.equal(carrier.acceptance, "unproven");
  assert.equal(carrier.path, null);
});

test("integ FG-576: an unrunnable help probe records the absence of evidence and is NOT a pre-spawn refusal", () => {
  const adapter = adapterWithHelp(null);
  const ctx = contextFor(decisionFor());
  const readiness = adapter.probeReadiness(ctx);

  // An absent binary is an ENVIRONMENT failure, so it must reach the spawn path and
  // close the receipt as spawn_failed — reporting it as a policy refusal here would
  // name the wrong cause and offer the wrong remedy.
  assert.ok(readiness.ok, "a failed help probe must not become a policy refusal");
  assert.match(
    String(readiness.readiness.limitations.find((l) => l.capability === "instruction-source")?.note),
    /could not be run before launch/,
  );
});

test("integ FG-576 D8: the carrier is the canonical seed verbatim, materialized under FORGE'S OWN root only", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor());
  const readiness = adapter.probeReadiness(ctx);
  assert.ok(readiness.ok);
  const carrier = adapter.declareInstructionCarrier(ctx, readiness.readiness);

  assert.equal(carrier.content, readFileSync(CANONICAL_TEMPLATE, "utf8"));
  assert.ok(carrier.path!.startsWith(home), `carrier ${carrier.path} escaped the Forge root ${home}`);
  assert.equal(carrier.argv[1], carrier.path);

  // Operator-owned files are never read for content, spliced, or rewritten (D8).
  const claudeMdBefore = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
  adapter.declareInstructionCarrier(ctx, readiness.readiness);
  assert.equal(readFileSync(join(projectDir, "CLAUDE.md"), "utf8"), claudeMdBefore);
});

// ---------------------------------------------------------------------------
// argv (AC2 / AC4)
// ---------------------------------------------------------------------------

test("integ FG-576 AC2/AC4: the plan's argv carries every Forge-owned flag exactly once, in a closed set", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor(), { passthrough: ["--add-dir", "/tmp/extra"] });
  const planned = planLaunch(adapter, ctx);
  assert.ok(planned.ok, planned.ok ? "" : planned.refusal.message);
  const argv = planned.plan.argv;

  for (const flag of ["-n", "--model", "--session-id", "--append-system-prompt-file"]) {
    assert.equal(argv.filter((t) => t === flag).length, 1, `${flag} in ${argv.join(" ")}`);
  }

  // Argument closure: every leading-dash token is either a flag the adapter declares
  // it may emit, or one the operator passed after the separator. Nothing else.
  const declared = new Set<string>(adapter.forgeOwnedFlags);
  const passthrough = new Set(ctx.passthrough);
  for (const token of argv) {
    if (!token.startsWith("-")) continue;
    assert.ok(
      declared.has(token) || passthrough.has(token),
      `argv contains '${token}', which is neither a Forge-owned flag nor operator passthrough`,
    );
  }

  assert.equal(planned.plan.cwd, projectDir);
  assert.equal(planned.plan.executable, "claude");
  assert.deepEqual(argv.slice(-2), ["--add-dir", "/tmp/extra"]);
});

test("integ FG-576: legacy mode records no model rather than fabricating one, and emits no --model", () => {
  rmSync(join(home, "model-policy.yml"));
  const decision = decisionFor();
  assert.equal(decision.legacy, true);
  assert.equal(decision.modelExplicit, false);

  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const planned = planLaunch(adapter, contextFor(decision));
  assert.ok(planned.ok);
  assert.equal(planned.plan.argv.includes("--model"), false, "legacy mode must not invent a model");
  // The decision still names a CONCRETE provider/adapter — an unrecorded provider is
  // exactly the manual shadow path this ticket removes.
  assert.equal(decision.provider, "anthropic");
  assert.equal(decision.adapter, "claude-code");
});

// ---------------------------------------------------------------------------
// Child environment (AC2)
// ---------------------------------------------------------------------------

test("integ FG-576 AC2: the Claude child env is composed from the parent and never mutates it", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/x" };
  const child = buildClaudeChildEnv(parent, "sso-prod");

  assert.equal(child["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1");
  assert.equal(child["CLAUDE_CODE_USE_BEDROCK"], "1");
  assert.equal(child["AWS_PROFILE"], "sso-prod");
  assert.equal(child["PATH"], "/usr/bin");

  // The parent shell is untouched — the FG-158 invariant, preserved verbatim.
  assert.deepEqual(parent, { PATH: "/usr/bin", HOME: "/home/x" });
});

test("integ FG-576 AC2: a subscription launch carries no AWS or bedrock variable at all", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor());
  const planned = planLaunch(adapter, ctx);
  assert.ok(planned.ok);

  assert.equal(planned.plan.env["CLAUDE_CODE_USE_BEDROCK"], undefined);
  assert.equal(planned.plan.env["AWS_PROFILE"], undefined);
  assert.equal(resolveClaudeBedrockProfile(ctx), undefined);
});

test("integ FG-576 AC2: a bedrock-auth resolution injects the bedrock variables into the CHILD only", () => {
  process.env["AWS_PROFILE"] = "from-env";
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor({ cliProfile: "claude-bedrock" }));
  const planned = planLaunch(adapter, ctx);
  assert.ok(planned.ok);

  assert.equal(planned.plan.env["CLAUDE_CODE_USE_BEDROCK"], "1");
  assert.equal(planned.plan.env["AWS_PROFILE"], "from-env");
  assert.equal(process.env["CLAUDE_CODE_USE_BEDROCK"], undefined, "the parent process env was mutated");
});

// ---------------------------------------------------------------------------
// Session operations (AC10)
// ---------------------------------------------------------------------------

test("integ FG-576 AC10: a new session's identity is ASSERTED before spawn and is the canonical key", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor());
  const mapped = adapter.mapSessionOperation(ctx);
  assert.ok(mapped.ok);

  assert.deepEqual([...mapped.mapping.argv], ["--session-id", ctx.sessionKey]);
  assert.equal(mapped.mapping.identity.strength, "asserted");
  assert.equal(mapped.mapping.identity.providerSessionId, ctx.sessionKey);
  assert.equal(adapter.declareSessionIdentityStrength(), "asserted");
});

test("integ FG-576 AC9/AC10: --continue records an UNKNOWN identity rather than a guessed one", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const ctx = contextFor(decisionFor(), { operation: { kind: "continue" } });
  const mapped = adapter.mapSessionOperation(ctx);
  assert.ok(mapped.ok);

  assert.deepEqual([...mapped.mapping.argv], ["--continue"]);
  assert.equal(mapped.mapping.identity.strength, "unknown");
  assert.equal(mapped.mapping.identity.providerSessionId, null);
  assert.ok(mapped.mapping.limitations.some((l) => l.capability === "session-operations"));
});

test("integ FG-576 AC10: cross-provider resume is refused from the RECEIPT, not from the identifier's format", () => {
  const codexId = "44444444-4444-4444-8444-444444444444";
  const claudeId = "55555555-5555-4555-8555-555555555555";
  // Identical shape. Only the durable receipt distinguishes them.
  persistPendingOrchestratorReceipt({
    sessionKey: codexId,
    projectDir,
    runtime: "codex-subscription",
    provider: "openai",
    adapter: "codex",
    sessionOperation: "new",
    providerSessionId: codexId,
  });
  persistPendingOrchestratorReceipt({
    sessionKey: claudeId,
    projectDir,
    runtime: "claude-oauth",
    provider: "anthropic",
    adapter: "claude-code",
    sessionOperation: "new",
    providerSessionId: claudeId,
  });

  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const decision = decisionFor();

  const refused = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "resume", sessionId: codexId } }));
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.refusal.code, "cross-provider-resume");

  const allowed = adapter.mapSessionOperation(contextFor(decision, { operation: { kind: "resume", sessionId: claudeId } }));
  assert.ok(allowed.ok, "a Claude-minted identifier of the SAME shape must be accepted");
  assert.deepEqual([...allowed.mapping.argv], ["--resume", claudeId]);
  assert.match(String(allowed.mapping.identity.basis), /matched to the Forge receipt/);
});

test("integ FG-576: a resume identifier that is not filename-safe is refused, never sanitized", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  for (const bad of ["../escape", "-rf", "with space", ""]) {
    const res = adapter.mapSessionOperation(contextFor(decisionFor(), { operation: { kind: "resume", sessionId: bad } }));
    assert.equal(res.ok, false, `'${bad}' was accepted as a session identifier`);
    assert.equal(res.ok ? "" : res.refusal.code, "unsafe-session-identifier");
  }
});

// ---------------------------------------------------------------------------
// D6 — the passthrough closure
// ---------------------------------------------------------------------------

test("integ FG-576 D6: every Forge-owned dimension is declared reserved for passthrough", () => {
  const reserved = new Set<string>(CLAUDE_RESERVED_PASSTHROUGH_FLAGS);
  for (const flag of [
    "--model",
    "-m",
    "--session-id",
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--append-system-prompt",
    "--append-system-prompt-file",
    "--system-prompt",
    "--system-prompt-file",
    "--settings",
    "-n",
    "--name",
    "--print",
    "-p",
  ]) {
    assert.ok(reserved.has(flag), `${flag} is a Forge-owned dimension but is not reserved against passthrough`);
  }
});

test("integ FG-576 D6: the guard refuses both `--flag value` and `--flag=value`, and lets unowned flags through", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);

  for (const tokens of [["--model", "opus"], ["--model=opus"], ["--session-id=x"], ["-p"]]) {
    const refusal = guardPassthrough(adapter, tokens);
    assert.ok(refusal, `${tokens.join(" ")} was allowed through passthrough`);
    assert.equal(refusal.code, "passthrough-not-permitted");
    assert.match(refusal.message, /D6/);
    assert.ok(refusal.remediation.length > 0, "a refusal with no remedy is a dead end");
  }

  assert.equal(guardPassthrough(adapter, ["--add-dir", "/tmp", "--permission-mode", "plan"]), null);
});

test("integ FG-576 D6: a refused passthrough stops the PLAN, so nothing downstream can be reached", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const planned = planLaunch(adapter, contextFor(decisionFor(), { passthrough: ["--model", "opus"] }));
  assert.equal(planned.ok, false);
  assert.equal(planned.ok ? "" : planned.refusal.code, "passthrough-not-permitted");
});

// ---------------------------------------------------------------------------
// Preflight is advisory (FG-499)
// ---------------------------------------------------------------------------

test("integ FG-576: project preflight reports warnings and never throws", () => {
  // A forge-init'd shape: the marker is present, the per-developer config is not.
  const warnings = claudeProjectPreflight(projectDir);
  assert.ok(warnings.some((w) => w.includes("settings.local.json")));

  // A directory that is not a forge project at all.
  const bare = join(base, "bare");
  mkdirSync(bare, { recursive: true });
  assert.deepEqual(claudeProjectPreflight(bare), [
    "CLAUDE.md has no forge orchestrator block. Run `forge init` to bootstrap.",
  ]);

  // A path that does not exist is a warning, not an exception.
  assert.equal(claudeProjectPreflight(join(base, "absent")).length, 1);
});

test("integ FG-576: the plan's advisories are warnings only — a half-configured project still plans", () => {
  const adapter = adapterWithHelp(HELP_WITH_FILE_FLAG);
  const planned = planLaunch(adapter, contextFor(decisionFor()));
  assert.ok(planned.ok, "advisory preflight findings must never block a launch (FG-499)");
  assert.ok(planned.plan.advisories.length > 0);
  assert.equal(existsSync(join(projectDir, ".claude")), false, "preflight must not create anything it warns about");
});
