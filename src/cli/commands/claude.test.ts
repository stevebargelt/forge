// FG-576 step 6 — `forge claude`'s own surface, unit tier.
//
// The command is now the explicit Claude shortcut around the shared launch
// primitive, so what is unit-testable here is exactly the part it still owns: the
// argument surface it parses out before the shared launcher sees anything, the
// project-root walk, and the two flags (`--bedrock` / `--aws-profile`) whose only
// effect is on the adapter it hands the launcher.
//
// Everything with a durable consequence — the receipt, the liveness record, the
// D5/D16 refusal, argv reaching the child — is proved end to end against a FAKE
// `claude` in fg576-claude-shortcut.integration.test.ts. Nothing here spawns a
// process, reads real auth, or touches the operator's Claude settings (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeChildEnv,
  claudeShortcutAdapter,
  findProjectRoot,
  parseClaudeShortcutArgs,
} from "./claude.js";
import type {
  AdapterLaunchContext,
  AdapterReadiness,
  OrchestratorAdapter,
} from "../../orchestrator/adapter.js";
import type { OrchestratorDecision } from "../../v2/orchestrator-resolve.js";
import type { EffectiveAuth } from "../../v2/model-resolution.js";

const MARKER = "<!-- forge:orchestrator-start -->";

let tmp: string;
let savedAwsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-claude-test-"));
  savedAwsDir = process.env["FORGE_AWS_DIR"];
});
afterEach(() => {
  if (savedAwsDir === undefined) delete process.env["FORGE_AWS_DIR"];
  else process.env["FORGE_AWS_DIR"] = savedAwsDir;
  rmSync(tmp, { recursive: true, force: true });
});

// ----- findProjectRoot -----

test("findProjectRoot: returns cwd when CLAUDE.md with the orchestrator marker is at cwd", () => {
  writeFileSync(join(tmp, "CLAUDE.md"), `# x\n${MARKER}\nbody\n`);
  assert.equal(findProjectRoot(tmp), tmp);
});

test("findProjectRoot: walks up from a subdir to find the marker", () => {
  writeFileSync(join(tmp, "CLAUDE.md"), `# x\n${MARKER}\nbody\n`);
  const sub = join(tmp, "src", "deep", "subdir");
  mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub), tmp);
});

test("findProjectRoot: returns null when no CLAUDE.md exists anywhere up the tree", () => {
  // tmp dir is unrelated to user's homedir; walking up wouldn't normally hit
  // a marker file in this scenario.
  const sub = join(tmp, "no-claude-md");
  mkdirSync(sub);
  // Walking up from /tmp/.../no-claude-md would eventually hit / — and on a
  // dev machine the user's home CLAUDE.md might match. We can't assume null,
  // so the safest assertion is: when starting from tmp itself (which has no
  // CLAUDE.md), the function either returns null OR returns a path
  // outside tmp. Both are acceptable; only "returned tmp itself" would be wrong.
  const result = findProjectRoot(sub);
  assert.ok(result === null || !result.startsWith(tmp), `should not match inside tmp; got ${result}`);
});

test("findProjectRoot: ignores CLAUDE.md WITHOUT the orchestrator marker", () => {
  // Plain CLAUDE.md doesn't make a project the orchestrator's home.
  writeFileSync(join(tmp, "CLAUDE.md"), `# this project has no forge block\n`);
  const sub = join(tmp, "sub");
  mkdirSync(sub);
  const result = findProjectRoot(sub);
  // Same caveat as above — might match a parent CLAUDE.md. But it must NOT
  // return tmp itself, because tmp's CLAUDE.md lacks the marker.
  assert.ok(result !== tmp, `should not return tmp (no marker in its CLAUDE.md); got ${result}`);
});

// ----- parseClaudeShortcutArgs: the display name (-n / --name) -----

test("parse: no -n / --name leaves the name unset, so the project's own label wins", () => {
  assert.equal(parseClaudeShortcutArgs([]).name, undefined);
  assert.equal(parseClaudeShortcutArgs(["--continue", "--model", "sonnet"]).name, undefined);
});

test("parse: -n / --name / --name= all supply the display name, and never reach passthrough", () => {
  for (const args of [["-n", "myname"], ["--name", "myname"], ["--name=myname"]]) {
    const parsed = parseClaudeShortcutArgs([...args, "--add-dir", "/tmp"]);
    assert.equal(parsed.name, "myname", args.join(" "));
    assert.deepEqual(parsed.passthrough, ["--add-dir", "/tmp"], `${args.join(" ")} leaked the name into passthrough`);
  }
});

// ----- parseClaudeShortcutArgs: AC14, the aliases that must keep working -----

test("parse AC14: `forge claude --model opus --continue` is a Forge-owned model plus a continue, not passthrough", () => {
  const parsed = parseClaudeShortcutArgs(["--model", "opus", "--continue"]);

  assert.equal(parsed.model, "opus");
  assert.equal(parsed.continueSession, true);
  // Forge owns the model, so it must NOT also travel to the child as passthrough —
  // that is how a flag ends up on argv twice and argv ordering decides the model.
  assert.deepEqual(parsed.passthrough, []);
});

test("parse AC14: every accepted form of the Forge-owned selection flags", () => {
  for (const [args, expected] of [
    [["--model=opus"], "opus"],
    [["-m", "sonnet"], "sonnet"],
    [["--model", "claude-sonnet-4-6"], "claude-sonnet-4-6"],
  ] as const) {
    assert.equal(parseClaudeShortcutArgs([...args]).model, expected, args.join(" "));
  }

  for (const args of [["--continue"], ["-c"]]) {
    assert.equal(parseClaudeShortcutArgs(args).continueSession, true, args.join(" "));
  }

  for (const args of [["--resume", "abc-123"], ["-r", "abc-123"], ["--resume=abc-123"]]) {
    assert.equal(parseClaudeShortcutArgs(args).resume, "abc-123", args.join(" "));
  }

  assert.equal(parseClaudeShortcutArgs(["--profile", "claude-bedrock"]).profile, "claude-bedrock");
  assert.equal(parseClaudeShortcutArgs(["--profile=claude-bedrock"]).profile, "claude-bedrock");
  assert.equal(parseClaudeShortcutArgs(["--explain"]).explain, true);
});

test("parse: a value-taking flag with no value is left for the D6 guard rather than guessed", () => {
  // `--model` followed by another flag: consuming '--continue' as the model would
  // launch a session on a model the operator never named.
  const parsed = parseClaudeShortcutArgs(["--model", "--continue"]);
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.continueSession, true);
  assert.deepEqual(parsed.passthrough, ["--model"]);

  const trailing = parseClaudeShortcutArgs(["--resume"]);
  assert.equal(trailing.resume, undefined);
  assert.deepEqual(trailing.passthrough, ["--resume"]);
});

// ----- parseClaudeShortcutArgs: passthrough -----

test("parse: provider-native flags Forge does not own reach passthrough verbatim", () => {
  const parsed = parseClaudeShortcutArgs(["--add-dir", "/tmp/extra", "--permission-mode", "plan"]);
  assert.deepEqual(parsed.passthrough, ["--add-dir", "/tmp/extra", "--permission-mode", "plan"]);
});

test("parse: after an explicit `--`, nothing is claimed by Forge", () => {
  const parsed = parseClaudeShortcutArgs(["--model", "opus", "--", "--model", "not-mine"]);
  assert.equal(parsed.model, "opus");
  assert.deepEqual(parsed.passthrough, ["--model", "not-mine"]);
});

// ----- parseClaudeShortcutArgs: --bedrock / --aws-profile (FG-158) -----

test("parse FG-158: --bedrock is extracted and never forwarded to claude", () => {
  assert.equal(parseClaudeShortcutArgs([]).bedrock, false);
  assert.equal(parseClaudeShortcutArgs(["--continue", "--model", "sonnet"]).bedrock, false);

  const parsed = parseClaudeShortcutArgs(["--bedrock", "--continue"]);
  assert.equal(parsed.bedrock, true);
  assert.deepEqual(parsed.passthrough, [], "--bedrock is forge's flag and must not reach claude");
});

test("parse FG-158: --aws-profile is extracted in both forms and never forwarded to claude", () => {
  assert.equal(parseClaudeShortcutArgs(["--bedrock"]).awsProfile, undefined);

  for (const args of [
    ["--bedrock", "--aws-profile", "adx-dev", "--continue"],
    ["--bedrock", "--aws-profile=adx-dev", "--continue"],
  ]) {
    const parsed = parseClaudeShortcutArgs(args);
    assert.equal(parsed.awsProfile, "adx-dev", args.join(" "));
    assert.equal(parsed.bedrock, true);
    assert.equal(parsed.continueSession, true);
    assert.deepEqual(parsed.passthrough, [], `${args.join(" ")} leaked a forge flag to claude`);
  }
});

// ----- the shortcut adapter -----

function fakeDecision(auth: EffectiveAuth, profile: string | undefined = "claude-subscription"): OrchestratorDecision {
  return {
    adapter: "claude-code",
    provider: "anthropic",
    runtime: auth === "bedrock" ? "claude-bedrock" : auth === "api" ? "claude-apikey" : "claude-oauth",
    profile,
    model: "claude-sonnet-4-6",
    modelExplicit: true,
    auth,
    alias: "default",
    costTier: "standard",
    resolvedBy: "defaults.profile",
    modelResolvedBy: "profile.map.default",
    policySource: "host",
    policyPath: "/fixture/model-policy.yml",
    legacy: false,
    operation: { kind: "new" },
    projectDir: tmp,
    authProbe: { provider: "anthropic", mode: auth, status: "available", detail: "fixture probe" },
    sessionIdentityStrength: "asserted",
    limitations: [],
    notes: [],
    providerPin: "claude-code",
  };
}

const EMPTY_READINESS: AdapterReadiness = { evidence: {}, advisories: [], limitations: [] };

/** A base that performs no I/O at all, so these stay unit tests: the wrapper's job
 *  is to decide WHICH AWS profile and WHETHER to refuse, not to probe anything. */
function stubBase(): OrchestratorAdapter {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    executable: "claude",
    forgeOwnedFlags: [],
    reservedPassthroughFlags: [],
    probeReadiness: () => ({ ok: true, readiness: { ...EMPTY_READINESS, advisories: ["base advisory"] } }),
    declareInstructionCarrier: () => ({
      path: null, content: null, generation: null, acceptance: "not_applicable", evidence: null, argv: [], limitations: [],
    }),
    declareSessionIdentityStrength: () => "asserted",
    mapSessionOperation: () => ({ ok: true, mapping: { argv: [], identity: { providerSessionId: null, strength: "unknown", basis: null }, sessionTarget: null, notes: [], limitations: [] } }),
    buildArgv: () => ({ ok: true, argv: [] }),
    buildChildEnv: (ctx) => ({ ...ctx.parentEnv }),
    preflight: () => [],
    onSpawnConfirmed: () => ({}),
    closeOut: () => {},
  };
}

function contextFor(decision: OrchestratorDecision, parentEnv: NodeJS.ProcessEnv = {}): AdapterLaunchContext {
  return {
    decision,
    projectDir: tmp,
    projectName: "fixture",
    sessionKey: "11111111-1111-4111-8111-111111111111",
    receiptId: "orx-fixture0000",
    runId: null,
    taskId: null,
    operation: { kind: "new" },
    passthrough: [],
    parentEnv,
  };
}

test("shortcut adapter FG-158: --aws-profile wins over AWS_PROFILE for the CHILD env, and the parent is untouched", () => {
  const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", AWS_PROFILE: "env-profile" };
  const adapter = claudeShortcutAdapter({
    bedrockAsserted: true,
    bedrockAssertedBy: "--bedrock",
    awsProfile: "cli-profile",
    base: stubBase(),
  });

  const child = adapter.buildChildEnv(contextFor(fakeDecision("bedrock"), parentEnv), EMPTY_READINESS);

  assert.equal(child["CLAUDE_CODE_USE_BEDROCK"], "1");
  assert.equal(child["AWS_PROFILE"], "cli-profile");
  assert.equal(child["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1");
  assert.deepEqual(parentEnv, { PATH: "/usr/bin", AWS_PROFILE: "env-profile" });
});

test("shortcut adapter FG-158: with no --aws-profile the AWS_PROFILE env value is used", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: true, bedrockAssertedBy: "--bedrock", awsProfile: undefined, base: stubBase() });
  const child = adapter.buildChildEnv(contextFor(fakeDecision("bedrock"), { AWS_PROFILE: "env-profile" }), EMPTY_READINESS);
  assert.equal(child["AWS_PROFILE"], "env-profile");
});

test("shortcut adapter AC2: a non-bedrock resolution carries no AWS or bedrock variable, even with --aws-profile", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: false, bedrockAssertedBy: undefined, awsProfile: "cli-profile", base: stubBase() });
  const child = adapter.buildChildEnv(contextFor(fakeDecision("subscription"), { PATH: "/usr/bin" }), EMPTY_READINESS);

  assert.equal(child["CLAUDE_CODE_USE_BEDROCK"], undefined);
  assert.equal(child["AWS_PROFILE"], undefined);
});

test("shortcut adapter: an unused --aws-profile is REPORTED rather than silently dropped", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: false, bedrockAssertedBy: undefined, awsProfile: "cli-profile", base: stubBase() });
  const probed = adapter.probeReadiness(contextFor(fakeDecision("subscription")));

  assert.ok(probed.ok);
  assert.ok(probed.readiness.advisories.some((a) => a.includes("--aws-profile 'cli-profile' was not applied")));
  assert.ok(probed.readiness.advisories.includes("base advisory"), "the base adapter's advisories must survive the wrapper");
});

test("shortcut adapter: an inherited CLAUDE_CODE_USE_BEDROCK that contradicts the resolved auth is reported", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: false, bedrockAssertedBy: undefined, awsProfile: undefined, base: stubBase() });
  const probed = adapter.probeReadiness(contextFor(fakeDecision("subscription"), { CLAUDE_CODE_USE_BEDROCK: "1" }));

  assert.ok(probed.ok);
  assert.ok(probed.readiness.advisories.some((a) => a.includes("CLAUDE_CODE_USE_BEDROCK=1 is set in this shell")));
});

test("shortcut adapter: an asserted Bedrock launch against a non-Bedrock profile REFUSES before spawn, with remedies", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: true, bedrockAssertedBy: "--bedrock", awsProfile: undefined, base: stubBase() });
  const probed = adapter.probeReadiness(contextFor(fakeDecision("subscription")));

  assert.equal(probed.ok, false);
  if (probed.ok) return;
  assert.equal(probed.refusal.code, "adapter-not-ready");
  assert.match(probed.refusal.message, /--bedrock/);
  assert.match(probed.refusal.message, /claude-subscription/);
  assert.match(probed.refusal.message, /auth 'subscription'/);
  assert.ok(probed.refusal.remediation.length > 0, "a refusal with no remedy is a dead end");
});

test("shortcut adapter: an asserted Bedrock launch against a Bedrock profile proceeds", () => {
  const adapter = claudeShortcutAdapter({ bedrockAsserted: true, bedrockAssertedBy: "--bedrock", awsProfile: undefined, base: stubBase() });
  assert.equal(adapter.probeReadiness(contextFor(fakeDecision("bedrock", "claude-bedrock"))).ok, true);
});

// ----- buildClaudeChildEnv (re-exported from the adapter that now owns it) -----

test("buildClaudeChildEnv: disables background tasks for non-Bedrock sessions", () => {
  const parentEnv: NodeJS.ProcessEnv = { PATH: "/test/bin" };

  const childEnv = buildClaudeChildEnv(parentEnv);

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(childEnv.AWS_PROFILE, undefined);
  assert.deepEqual(parentEnv, { PATH: "/test/bin" });
});

test("buildClaudeChildEnv: overrides an unsafe parent value without mutating it", () => {
  const parentEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
  };

  const childEnv = buildClaudeChildEnv(parentEnv);

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(parentEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "0");
});

test("buildClaudeChildEnv: combines the invariant with Bedrock configuration", () => {
  const parentEnv: NodeJS.ProcessEnv = {
    PATH: "/test/bin",
    AWS_PROFILE: "old-profile",
  };

  const childEnv = buildClaudeChildEnv(parentEnv, "forge-profile");

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(childEnv.AWS_PROFILE, "forge-profile");
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(parentEnv.AWS_PROFILE, "old-profile");
  assert.equal(parentEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
});
