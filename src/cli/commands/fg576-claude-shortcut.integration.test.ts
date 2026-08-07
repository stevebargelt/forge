// FG-576 step 6 — `forge claude` AS THE EXPLICIT CLAUDE SHORTCUT, end to end.
//
// One question runs through every test here: can the shortcut and the generic
// command DRIFT? They cannot, and the way that is proved is by running both and
// comparing what each recorded — not by reading the two call sites and agreeing
// they look similar.
//
// The step's breaking change gets its own coverage, because a command that worked
// yesterday can now refuse: under a Codex-resolving policy `forge claude` EXITS
// NON-ZERO BEFORE SPAWN (D5, D16). That refusal must name the resolved profile, the
// runtime, and BOTH remedies — reporting incompatibility without a way out is what
// D16 exists to forbid.
//
// Everything runs against a FAKE `claude` on PATH and disposable FORGE_HOME /
// FORGE_DB_PATH / FORGE_ORCHESTRATORS_DIR / CLAUDE_CONFIG_DIR roots. No billed
// interactive session is started, no real auth is read or mutated, and the
// operator's installed Claude settings are never written (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../../store/db.js";
import {
  listOrchestratorReceiptsForProject,
  type OrchestratorReceipt,
} from "../../store/orchestrator-receipts.js";
import { loadHeartbeats } from "../../util/orchestrator-heartbeats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
// FG-569's exec-not-spawn entry: ONE node process with tsx loaded in-process.
const LOADER = join(REPO_ROOT, "bin", "forge-loader.mjs");
const CLI_ARGV = ["--import", LOADER, CLI_ENTRY];
const FAKE_CLAUDE = join(REPO_ROOT, "src", "orchestrator", "__fixtures__", "fake-claude.js");
const DOC = join(REPO_ROOT, "docs", "how-to-orchestrator-launcher.md");

/** Claude by default. The Codex profile is DEFINED but not selected, so a test can
 *  flip the orchestrator to it with one `overrides.agents.orchestrator` line —
 *  which is also exactly what an operator types (AC3). */
const CLAUDE_POLICY = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  codex-default:
    provider: openai
    auth: subscription
    map:
      default: { model: gpt-5.6-terra, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

const CODEX_POLICY = `${CLAUDE_POLICY}
overrides:
  agents:
    orchestrator: codex-default
`;

type Roots = {
  base: string;
  home: string;
  db: string;
  orchestrators: string;
  project: string;
  bin: string;
  record: string;
  claudeConfig: string;
};

let roots: Roots;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = [
  "FORGE_HOME",
  "FORGE_DB_PATH",
  "FORGE_ORCHESTRATORS_DIR",
  "CLAUDE_CONFIG_DIR",
  "FAKE_CLAUDE_RECORD",
  "PATH",
  "AWS_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_API_KEY",
] as const;

function makeRoots(): Roots {
  // realpath, because the child reports its cwd resolved and a /tmp symlink would
  // turn "did the child start in the project root?" into a path-shape accident.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-claude-shortcut-")));
  const home = join(base, "forge-home");
  const project = join(base, "project");
  const bin = join(base, "bin");
  const orchestrators = join(base, "orchestrators");
  const claudeConfig = join(base, "claude-config");
  for (const dir of [home, project, bin, orchestrators, claudeConfig]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(home, "model-policy.yml"), CLAUDE_POLICY, "utf8");
  writeFileSync(join(project, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\nproject policy\n`, "utf8");

  // The fake goes on PATH under the real name, so `spawn("claude", ...)` resolves
  // to it exactly the way it would resolve the operator's binary.
  const fake = join(bin, "claude");
  copyFileSync(FAKE_CLAUDE, fake);
  chmodSync(fake, 0o755);

  return {
    base,
    home,
    db: join(home, "forge.db"),
    orchestrators,
    project,
    bin,
    record: join(base, "record.json"),
    claudeConfig,
  };
}

function launchEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    FORGE_HOME: roots.home,
    FORGE_DB_PATH: roots.db,
    FORGE_ORCHESTRATORS_DIR: roots.orchestrators,
    CLAUDE_CONFIG_DIR: roots.claudeConfig,
    FAKE_CLAUDE_RECORD: roots.record,
    PATH: `${roots.bin}:${process.env["PATH"] ?? ""}`,
    ...overrides,
  };
}

function applyEnv(overrides: Record<string, string> = {}): void {
  const env = launchEnv(overrides);
  for (const key of MANAGED_ENV) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The in-process store must re-open at the redirected path, never at the suite's.
  closeDb();
}

function runCli(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [...CLI_ARGV, ...args], {
    cwd: roots.project,
    encoding: "utf8",
    env: launchEnv(overrides),
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readRecord(): { argv: string[]; cwd: string; env: Record<string, string> } {
  assert.ok(existsSync(roots.record), "the fake claude recorded nothing — it was never launched");
  return JSON.parse(readFileSync(roots.record, "utf8"));
}

function clearRecord(): void {
  if (existsSync(roots.record)) unlinkSync(roots.record);
}

function countFlag(argv: string[], flag: string): number {
  return argv.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
}

function receipts(): OrchestratorReceipt[] {
  applyEnv();
  return listOrchestratorReceiptsForProject(roots.project);
}

function usePolicy(body: string): void {
  writeFileSync(join(roots.home, "model-policy.yml"), body, "utf8");
}

beforeEach(() => {
  roots = makeRoots();
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  closeDb();
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  rmSync(roots.base, { recursive: true, force: true });
});

// ─── AC2 / AC6 / AC14: the shortcut resolves policy and records the launch ───

test("integ FG-576 AC2/AC14: `forge claude` launches with the POLICY-selected explicit model, never Claude Code's ambient default", () => {
  const res = runCli(["claude"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--model"), 1, `--model must reach argv exactly once: ${record.argv.join(" ")}`);
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "claude-sonnet-4-6");
  assert.equal(record.cwd, roots.project, "the child did not start in the resolved project root");
  assert.equal(record.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1");
  // The shortcut is Claude-only: no Codex flag, and no Codex binary is consulted.
  assert.equal(countFlag(record.argv, "--config"), 0);

  const receipt = receipts()[0]!;
  assert.equal(receipt.resolvedProfile, "claude-subscription");
  assert.equal(receipt.runtime, "claude-oauth");
  assert.equal(receipt.provider, "anthropic");
  assert.equal(receipt.model, "claude-sonnet-4-6");
  assert.equal(receipt.adapter, "claude-code");
  assert.equal(receipt.state, "exited");
  assert.equal(receipt.exitCode, 0);
});

test("integ FG-576 AC6: the shortcut's receipt is indistinguishable in SHAPE from `forge orchestrator`'s", () => {
  assert.equal(runCli(["claude"]).status, 0);
  assert.equal(runCli(["orchestrator"]).status, 0);

  const all = receipts();
  assert.equal(all.length, 2, "each command must record exactly one receipt");

  // Everything that describes the DECISION and its outcome must match. Only the
  // per-launch identities (receipt id, session key, timestamps, pid) may differ —
  // if any recorded decision field could differ, the two commands have drifted.
  const decisionOf = (r: OrchestratorReceipt): Record<string, unknown> => ({
    resolvedProfile: r.resolvedProfile,
    runtime: r.runtime,
    provider: r.provider,
    model: r.model,
    authMode: r.authMode,
    resolvedBy: r.resolvedBy,
    adapter: r.adapter,
    sessionOperation: r.sessionOperation,
    identityStrength: r.identityStrength,
    projectDir: r.projectDir,
    projectName: r.projectName,
    carrierAcceptance: r.carrier.acceptance,
    carrierGeneration: r.carrier.generation,
    state: r.state,
    exitCode: r.exitCode,
    limitations: r.limitations,
  });

  assert.deepEqual(decisionOf(all[0]!), decisionOf(all[1]!));
  // …and they are genuinely two different launches, not one row read twice.
  assert.notEqual(all[0]!.receiptId, all[1]!.receiptId);
  assert.notEqual(all[0]!.sessionKey, all[1]!.sessionKey);
});

test("integ FG-576 AC6/D12: the shortcut asserts a session identity and closes its own liveness record", () => {
  assert.equal(runCli(["claude"]).status, 0);

  const record = readRecord();
  const receipt = receipts()[0]!;
  assert.equal(record.argv[record.argv.indexOf("--session-id") + 1], receipt.sessionKey);
  assert.equal(receipt.identityStrength, "asserted");
  assert.equal(receipt.providerSessionId, receipt.sessionKey);

  // The launcher-owned artifacts do not outlive the session.
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
  assert.equal(existsSync(String(receipt.carrier.path)), false, "the instruction carrier outlived the session");
});

test("integ FG-576 AC14: an existing alias `forge claude --model opus --continue` still launches Claude, with the model recorded as a CLI override", () => {
  const res = runCli(["claude", "--model", "opus", "--continue"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--model"), 1);
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "opus", "the alias must reach claude verbatim");
  assert.equal(countFlag(record.argv, "--continue"), 1);
  assert.equal(countFlag(record.argv, "--session-id"), 0, "Claude picks the conversation for --continue; Forge asserts no id");

  const receipt = receipts()[0]!;
  assert.equal(receipt.model, "opus", "an explicit --model is recorded VERBATIM, not normalized");
  assert.match(String(receipt.resolvedBy), /model: cli\.--model/);
  assert.equal(receipt.sessionOperation, "continue");
  assert.equal(receipt.adapter, "claude-code");
});

test("integ FG-576 AC14: the alias never launches Codex, even when policy resolves the orchestrator to Codex", () => {
  usePolicy(CODEX_POLICY);

  const res = runCli(["claude", "--model", "opus", "--continue"]);

  assert.notEqual(res.status, 0, "an alias must not silently keep working against a different provider");
  assert.equal(existsSync(roots.record), false, "nothing was executed");
  assert.equal(receipts().length, 0, "a launch refused at the gate must not be recorded at all");
});

test("integ FG-576: -n / --name still overrides the project's display identity", () => {
  assert.equal(runCli(["claude", "-n", "operator-chose-this"]).status, 0);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "-n"), 1, "the display name must reach argv exactly once");
  assert.equal(record.argv[record.argv.indexOf("-n") + 1], "operator-chose-this");
  assert.equal(receipts()[0]!.projectName, "operator-chose-this");
});

// ─── D5 / D16: the refusal, and its remedies ────────────────────────────────

test("integ FG-576 D5/D16: under a Codex-resolving policy `forge claude` exits non-zero BEFORE spawn and names profile, runtime and BOTH remedies", () => {
  usePolicy(CODEX_POLICY);

  const res = runCli(["claude"]);

  assert.notEqual(res.status, 0);
  assert.equal(existsSync(roots.record), false, "the provider CLI was executed despite a refused launch");
  assert.equal(receipts().length, 0, "nothing may be recorded for a launch refused at the gate");
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);

  // What was resolved, in the operator's own vocabulary.
  assert.match(res.stderr, /codex-default/, "the refusal must name the RESOLVED profile");
  assert.match(res.stderr, /codex-subscription/, "the refusal must name the resolved runtime");
  assert.match(res.stderr, /openai/, "the refusal must name the resolved provider");
  assert.match(res.stderr, /Claude Code/);

  // D16: concrete remedies, not a bare incompatibility report.
  assert.match(res.stderr, /forge orchestrator/, "remedy 1: launch what policy selected");
  assert.match(res.stderr, /forge claude --profile/, "remedy 2: select a Claude-compatible profile");
  assert.match(res.stderr, /overrides\.agents\.orchestrator/, "remedy 3: change the policy selection");

  // D16 again: it must NOT silently re-resolve to some other Claude profile.
  assert.doesNotMatch(res.stdout, /Launching as/, "a refused shortcut must not print a launch banner");
});

test("integ FG-576 D5: the generic command resolves the SAME policy to Codex, and never substitutes Claude for it", () => {
  usePolicy(CODEX_POLICY);

  // The generic command carries on down the Codex path (how far depends on whether
  // this environment has a Codex credential and whether this build ships the
  // adapter). What must hold either way: it does NOT refuse for the shortcut's
  // provider-pin reason, and it never launches Claude in Codex's place — the
  // "silently substitutes a provider" failure the whole ticket exists to prevent.
  const res = runCli(["orchestrator"]);

  assert.doesNotMatch(res.stderr, /launches Claude Code only/, "the generic command must not apply a provider pin");
  assert.equal(existsSync(roots.record), false, "`forge orchestrator` launched Claude under a Codex-resolving policy");
  assert.match(`${res.stdout}\n${res.stderr}`, /codex-default|openai|codex/, "the Codex resolution must be visible to the operator");
});

// ─── AC5-style refusals reach the shortcut through the SAME resolver ─────────

test("integ FG-576 AC5: an unsupported runtime refuses through the shortcut too, naming profile, runtime and a remedy", () => {
  usePolicy(`
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  pi-groq:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
defaults:
  profile: claude-subscription
  activity: {}
overrides:
  agents:
    orchestrator: pi-groq
`);

  const res = runCli(["claude"]);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /pi-groq/);
  assert.match(res.stderr, /pi-apikey/);
  assert.match(res.stderr, /Fix:/);
  assert.equal(existsSync(roots.record), false);
  assert.equal(receipts().length, 0);
});

// ─── D6: passthrough is not a second, unrecorded way to change the launch ────

for (const [name, tokens] of [
  ["--session-id", ["--session-id", "11111111-1111-4111-8111-111111111111"]],
  ["--append-system-prompt-file", ["--append-system-prompt-file", "/tmp/evil.md"]],
  ["--print", ["--print"]],
  ["--settings", ["--settings", "/tmp/settings.json"]],
] as const) {
  test(`integ FG-576 D6: \`forge claude\` passthrough cannot set ${name}`, () => {
    const res = runCli(["claude", ...tokens]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /D6/);
    assert.match(res.stderr, /cannot be passed through/);
    assert.equal(existsSync(roots.record), false, "the refused passthrough still reached a child");
    assert.equal(receipts().length, 0);
  });
}

test("integ FG-576 D6: a provider-native flag Forge does not own still reaches claude, exactly once", () => {
  const res = runCli(["claude", "--add-dir", "/tmp"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--add-dir"), 1);
  assert.deepEqual(record.argv.slice(-2), ["--add-dir", "/tmp"]);
});

// ─── AC15: inspect the effective choice before launching ────────────────────

test("integ FG-576 AC15: `forge claude --explain` prints the recorded decision and spawns nothing", () => {
  const res = runCli(["claude", "--explain"]);

  assert.equal(res.status, 0, res.stderr);
  for (const field of ["profile", "runtime", "provider", "model", "auth", "adapter", "resolved_by"]) {
    assert.match(res.stdout, new RegExp(`^${field}\\s`, "m"), `--explain omitted '${field}':\n${res.stdout}`);
  }
  assert.match(res.stdout, /claude-subscription/);
  assert.equal(existsSync(roots.record), false, "--explain spawned the provider CLI");
  assert.equal(receipts().length, 0);
});

// ─── AC7: terminal honesty on the shortcut's path too ───────────────────────

test("integ FG-576 AC7: a spawn failure through the shortcut closes the receipt as spawn_failed and exits non-zero", () => {
  // An EMPTY bin dir as the whole PATH: `claude` cannot be resolved, while the
  // launcher itself still runs because it is invoked through process.execPath.
  const emptyBin = join(roots.base, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });

  const res = runCli(["claude"], { PATH: emptyBin });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /failed to spawn claude/);
  const receipt = receipts()[0]!;
  assert.equal(receipt.state, "spawn_failed");
  assert.equal(receipt.claimsRunning, false);
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

// ─── AC13: the operator's roots are never touched ───────────────────────────

test("integ FG-576 AC13/D8: a shortcut launch writes only under the disposable Forge root, and never edits the project's CLAUDE.md", () => {
  const claudeMdBefore = readFileSync(join(roots.project, "CLAUDE.md"), "utf8");

  assert.equal(runCli(["claude"]).status, 0);

  assert.equal(readFileSync(join(roots.project, "CLAUDE.md"), "utf8"), claudeMdBefore);
  const record = readRecord();
  const carrierIndex = record.argv.indexOf("--append-system-prompt-file");
  assert.notEqual(carrierIndex, -1, "the Forge-owned carrier was not bound");
  assert.ok(
    record.argv[carrierIndex + 1]!.startsWith(roots.home),
    `carrier ${record.argv[carrierIndex + 1]} escaped the Forge root ${roots.home}`,
  );
  // The disposable Claude config root exists and stays empty: nothing about this
  // launch writes into a provider config root (D8).
  assert.equal(existsSync(join(roots.claudeConfig, "settings.json")), false);
});

test("integ FG-576 AC2: a subscription-resolving shortcut launch carries no AWS or Bedrock variable into the child", () => {
  clearRecord();
  const res = runCli(["claude"], { AWS_PROFILE: "" });
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(record.env["CLAUDE_CODE_USE_BEDROCK"], undefined);
  assert.equal(receipts()[0]!.authMode, "subscription");
});

// ─── AC15: the operator documentation ships in this step ────────────────────

test("integ FG-576 AC15/D16: the operator doc documents the shortcut, the refusal and both remedies", () => {
  assert.ok(existsSync(DOC), "docs/how-to-orchestrator-launcher.md must ship with the refusal it explains");
  const doc = readFileSync(DOC, "utf8");

  assert.match(doc, /forge orchestrator/);
  assert.match(doc, /forge claude/);
  // The refusal and its two remedies, in the operator's own vocabulary.
  assert.match(doc, /refus/i);
  assert.match(doc, /overrides\.agents\.orchestrator/);
  assert.match(doc, /forge claude --profile/);
  assert.match(doc, /--explain/);
  assert.match(doc, /--bedrock/);
});
