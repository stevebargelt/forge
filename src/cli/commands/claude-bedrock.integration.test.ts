/**
 * Integration tests for FG-158 / FG-435 / FG-499: `forge claude`'s Bedrock surface.
 *
 * Covers five areas thin in the existing unit-test suite:
 *   (1) AWS_PROFILE resolution order: --aws-profile flag > project.json.awsProfile
 *                                     > AWS_PROFILE env > "default"
 *   (2) Child env receives CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE while
 *       the parent process.env is NOT mutated.
 *   (3) Forge-specific --bedrock / --aws-profile flags are stripped from the
 *       argv that would be forwarded to claude.
 *   (4) apikey mode exits non-zero when ANTHROPIC_API_KEY is unset (subprocess test).
 *   (5) readProjectAuth returns null for absent / invalid project.json (cross-check).
 *   (6/7) FG-435 + FG-499: the STS / SSO preflight is profile-scoped and ADVISORY.
 *
 * FG-576 step 6 rewired the command onto the shared launch primitive, so these were
 * updated in three ways — each one STRENGTHENING what is asserted, not relaxing it:
 *
 *   * The precedence checks (1) now run through the shipped code path
 *     (claudeShortcutAdapter().buildChildEnv) instead of a mirror of the expression
 *     the command used to evaluate inline. A mirror can agree with a comment while
 *     disagreeing with the binary.
 *   * The subprocess FG-499 tests put a FAKE `claude` on PATH and assert
 *     **exit code 0**. Previously `claude` was absent, the spawn failed for an
 *     unrelated reason, and "advisory only" could only be inferred from the banner
 *     appearing. Now a non-zero exit for an advisory finding fails the test outright,
 *     which is what FG-499 actually protects.
 *   * The advisory text is asserted against combined stdout+stderr: the shared
 *     launcher prints every adapter advisory through ONE stream so `forge claude`
 *     and `forge orchestrator` cannot report the same finding differently. The
 *     wording, the profile scoping and the non-fatality are unchanged.
 *
 * Every subprocess run uses disposable FORGE_HOME / FORGE_DB_PATH /
 * FORGE_ORCHESTRATORS_DIR / FORGE_AWS_DIR roots and a fake CLI: no billed session is
 * started and no real auth is read or mutated (AC13).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { claudeShortcutAdapter, parseClaudeShortcutArgs } from "./claude.js";
import { readProjectAuth } from "../../util/project-meta.js";
import { resolveProfileSsoIdentity, ssoTokenCacheFilename, stsCacheFilename } from "../../util/creds.js";
import { utimesSync } from "node:fs";
import type { AdapterLaunchContext, AdapterReadiness } from "../../orchestrator/adapter.js";
import type { OrchestratorDecision } from "../../v2/orchestrator-resolve.js";
import type { EffectiveAuth } from "../../v2/model-resolution.js";

const here = dirname(fileURLToPath(import.meta.url));
// From src/cli/commands/ go up two to src/, then into cli/index.ts.
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";
// node_modules lives at the project root (three levels above here).
const FAKE_CLAUDE = resolve(here, "..", "..", "orchestrator", "__fixtures__", "fake-claude.js");

let tmp: string;
let savedAwsProfile: string | undefined;
let savedBedrockEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-claude-bedrock-integ-"));
  savedAwsProfile = process.env.AWS_PROFILE;
  savedBedrockEnv = process.env.CLAUDE_CODE_USE_BEDROCK;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // Restore env vars touched by individual tests.
  if (savedAwsProfile === undefined) {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = savedAwsProfile;
  }
  if (savedBedrockEnv === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrockEnv;
  }
});

function writeForgeProjectJson(projectDir: string, body: Record<string, unknown>): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "project.json"), JSON.stringify(body));
}

/** A disposable PATH whose `claude` is the fixture executable. AC13: nothing here
 *  may reach a real provider CLI. */
function fakeClaudeBin(): string {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "claude");
  copyFileSync(FAKE_CLAUDE, fake);
  chmodSync(fake, 0o755);
  return bin;
}

/** Disposable Forge roots for a subprocess run, so no test writes into the
 *  operator's ~/.forge, store or heartbeat namespace. */
function disposableRoots(): Record<string, string> {
  const home = join(tmp, "forge-home");
  mkdirSync(home, { recursive: true });
  return {
    FORGE_HOME: home,
    FORGE_DB_PATH: join(home, "forge.db"),
    FORGE_ORCHESTRATORS_DIR: join(tmp, "orchestrators"),
  };
}

// ─── (1) AWS_PROFILE resolution order, through the shipped code path ──────────
//
// `forge claude --aws-profile <p>` is a Forge-owned flag: it is extracted here and
// handed to the adapter, which is the ONLY thing that decides which AWS profile
// reaches the child. So the precedence assertions run against that adapter.

function bedrockDecision(auth: EffectiveAuth = "bedrock"): OrchestratorDecision {
  return {
    adapter: "claude-code",
    provider: "anthropic",
    runtime: "claude-bedrock",
    profile: "claude-bedrock",
    model: "us.anthropic.claude-sonnet-4-6",
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

function childEnvFor(args: string[], parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parsed = parseClaudeShortcutArgs(args);
  const adapter = claudeShortcutAdapter({
    bedrockAsserted: true,
    bedrockAssertedBy: "--bedrock",
    awsProfile: parsed.awsProfile,
  });
  const ctx: AdapterLaunchContext = {
    decision: bedrockDecision(),
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
  return adapter.buildChildEnv(ctx, EMPTY_READINESS);
}

test("integ FG-158: --aws-profile CLI flag wins over project.json.awsProfile", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  const env = childEnvFor(["--bedrock", "--aws-profile", "cli-profile"], {});
  assert.equal(env["AWS_PROFILE"], "cli-profile");
});

test("integ FG-158: --aws-profile CLI flag wins over AWS_PROFILE env var", () => {
  const env = childEnvFor(["--bedrock", "--aws-profile", "cli-profile"], { AWS_PROFILE: "env-profile" });
  assert.equal(env["AWS_PROFILE"], "cli-profile");
});

test("integ FG-158: --aws-profile=<value> (single-token form) wins over project.json.awsProfile", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  const env = childEnvFor(["--bedrock", "--aws-profile=flag-profile"], {});
  assert.equal(env["AWS_PROFILE"], "flag-profile");
});

test("integ FG-158: project.json.awsProfile wins over AWS_PROFILE env var", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  const env = childEnvFor(["--bedrock"], { AWS_PROFILE: "env-profile" });
  assert.equal(env["AWS_PROFILE"], "project-profile");
});

test("integ FG-158: AWS_PROFILE env var wins over hard-coded 'default' fallback", () => {
  const env = childEnvFor(["--bedrock"], { AWS_PROFILE: "env-profile" });
  assert.equal(env["AWS_PROFILE"], "env-profile");
});

test("integ FG-158: falls back to 'default' when no profile source is configured", () => {
  const env = childEnvFor(["--bedrock"], {});
  assert.equal(env["AWS_PROFILE"], "default");
});

// ─── (2) Parent process.env is not mutated when building childEnv ─────────────

test("integ FG-158: childEnv has CLAUDE_CODE_USE_BEDROCK=1 and AWS_PROFILE; the parent env object is not mutated", () => {
  const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", AWS_PROFILE: "pre-existing" };

  const childEnv = childEnvFor(["--bedrock", "--aws-profile", "integ-bedrock-profile"], parentEnv);

  assert.equal(childEnv["CLAUDE_CODE_USE_BEDROCK"], "1");
  assert.equal(childEnv["AWS_PROFILE"], "integ-bedrock-profile");
  // The parent object the adapter composed from is untouched — the FG-158 invariant.
  assert.deepEqual(parentEnv, { PATH: "/usr/bin", AWS_PROFILE: "pre-existing" });
});

test("integ FG-158: childEnv inherits all parent env vars alongside the injected bedrock vars", () => {
  const parentEnv: NodeJS.ProcessEnv = { _FG158_SENTINEL: "sentinel-value" };

  const childEnv = childEnvFor(["--bedrock", "--aws-profile", "bedrock-profile"], parentEnv);

  assert.equal(childEnv["CLAUDE_CODE_USE_BEDROCK"], "1");
  assert.equal(childEnv["AWS_PROFILE"], "bedrock-profile");
  assert.equal(childEnv["_FG158_SENTINEL"], "sentinel-value");
  assert.equal(parentEnv["CLAUDE_CODE_USE_BEDROCK"], undefined);
});

// ─── (3) Forge flags stripped from what reaches claude ───────────────────────

test("integ FG-158: --bedrock and --aws-profile (two-token form) never reach claude; other flags are honored", () => {
  const parsed = parseClaudeShortcutArgs(["--bedrock", "--aws-profile", "adx-dev", "--continue", "--model", "sonnet"]);

  assert.equal(parsed.bedrock, true);
  assert.equal(parsed.awsProfile, "adx-dev");
  // Forge owns --continue and --model now, so neither is passthrough either — but
  // both are still honored, which is what an existing alias depends on (AC14).
  assert.equal(parsed.continueSession, true);
  assert.equal(parsed.model, "sonnet");
  assert.deepEqual(parsed.passthrough, [], "no forge-owned flag may reach claude as passthrough");
});

test("integ FG-158: --aws-profile=<value> (single-token form) never reaches claude; --resume is honored", () => {
  const parsed = parseClaudeShortcutArgs(["--bedrock", "--aws-profile=adx-dev", "--resume", "abc123"]);

  assert.equal(parsed.awsProfile, "adx-dev");
  assert.equal(parsed.resume, "abc123");
  assert.deepEqual(parsed.passthrough, []);
});

test("integ FG-158: no bedrock flags in args → provider-native flags pass through untouched", () => {
  const parsed = parseClaudeShortcutArgs(["--add-dir", "/tmp/extra", "--permission-mode", "plan"]);

  assert.equal(parsed.bedrock, false);
  assert.equal(parsed.awsProfile, undefined);
  assert.deepEqual(parsed.passthrough, ["--add-dir", "/tmp/extra", "--permission-mode", "plan"]);
});

// ─── (4) apikey mode exits non-zero when ANTHROPIC_API_KEY is unset ──────────

test("integ FG-158: forge claude exits 1 when auth=apikey and ANTHROPIC_API_KEY is not set", () => {
  // Write a minimal git root with .forge/project.json auth=apikey.
  // findGitRoot will stop here because .git is present; readProjectAuth
  // will then find .forge/project.json at this same dir.
  mkdirSync(join(tmp, ".git"));
  writeForgeProjectJson(tmp, { auth: "apikey" });

  // Strip ANTHROPIC_API_KEY from the subprocess env so the guard fires.
  const testEnv = { ...process.env, ...disposableRoots() };
  delete testEnv.ANTHROPIC_API_KEY;
  delete testEnv.CLAUDE_CODE_USE_BEDROCK;   // ensure only the apikey path is hit

  const result = spawnSync(tsx, [entry, "claude"], {
    cwd: tmp,
    env: testEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    1,
    `expected exit code 1 for apikey with no key; got ${result.status}. stderr: ${result.stderr}`,
  );
  assert.match(
    result.stderr,
    /auth=apikey requires ANTHROPIC_API_KEY/,
    "error message must name the missing variable",
  );
});

test("integ FG-158: forge claude does NOT exit prematurely when auth=apikey and ANTHROPIC_API_KEY IS set", () => {
  // When the key is present the apikey guard passes and the launch proceeds all the
  // way to the (fake) child.
  mkdirSync(join(tmp, ".git"));
  writeForgeProjectJson(tmp, { auth: "apikey" });

  const testEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...disposableRoots(),
    ANTHROPIC_API_KEY: "sk-test-placeholder",
    PATH: `${fakeClaudeBin()}:${process.env.PATH ?? ""}`,
  };
  delete testEnv.CLAUDE_CODE_USE_BEDROCK;

  const result = spawnSync(tsx, [entry, "claude"], {
    cwd: tmp,
    env: testEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  // The apikey guard must NOT have fired (which exits 1 with "auth=apikey requires ...").
  const apiKeyGuardFired =
    result.status === 1 && result.stderr.includes("auth=apikey requires ANTHROPIC_API_KEY");
  assert.ok(!apiKeyGuardFired, "apikey guard must not fire when ANTHROPIC_API_KEY is set");
  assert.equal(result.status, 0, `expected a clean launch; stdout=${result.stdout} stderr=${result.stderr}`);
});

// ─── (5) readProjectAuth returns null for absent / invalid project.json ────────
// Cross-checks the unit-test coverage from project-meta.test.ts in integration context.

test("integ FG-158: readProjectAuth returns null when .forge/ directory is entirely absent", () => {
  // tmp has no .forge/ directory at all.
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json with no auth fields", () => {
  writeForgeProjectJson(tmp, {});
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json containing unrecognised auth value", () => {
  writeForgeProjectJson(tmp, { auth: "saml-sso" });
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json containing malformed JSON", () => {
  mkdirSync(join(tmp, ".forge"), { recursive: true });
  writeFileSync(join(tmp, ".forge", "project.json"), "{ broken json ");
  assert.equal(readProjectAuth(tmp), null);
});

// ─── (6) FG-435: `forge claude` STS pre-flight is profile-scoped ─────────────
//
// Reproduces the real work-laptop recurrence: the mtime heuristic looks stale
// for the resolved profile, but `aws configure export-credentials` (the same
// credential path forge injects into containers) succeeds — launch must not
// be hard-blocked, only advised. Uses FORGE_AWS_DIR + FORGE_AWS_CREDS_FOR_TEST
// (creds.ts's existing test seams) so no real AWS CLI or network is involved.

function writeAwsConfigForFakeProfile(awsDir: string, profile: string): void {
  mkdirSync(awsDir, { recursive: true });
  writeFileSync(
    join(awsDir, "config"),
    `[profile ${profile}]\nsso_start_url = https://example.awsapps.com/start\nsso_account_id = 111111111111\nsso_role_name = TestRole\nregion = us-east-1\n`,
  );
}

// Writes this profile's own SSO token + STS cache files at the EXACT
// filenames botocore computes for it (mirrors the hashing approach
// creds.ts:detectStaleStsCache now uses), with the SSO token newer than the
// STS cache — i.e. the mtime heuristic's stale shape.
function writeStaleCachesForProfile(awsDir: string, profile: string): void {
  const identity = resolveProfileSsoIdentity(awsDir, profile);
  assert.ok(identity?.accountId && identity.roleName, "test setup bug: profile identity incomplete");
  const now = Date.now();

  const ssoDir = join(awsDir, "sso", "cache");
  mkdirSync(ssoDir, { recursive: true });
  const ssoFile = join(ssoDir, ssoTokenCacheFilename(identity!));
  writeFileSync(ssoFile, JSON.stringify({
    accessToken: "fake-token",
    startUrl: identity!.startUrl,
    expiresAt: new Date(now + 8 * 3600 * 1000).toISOString(),
  }));
  const ssoTime = (now - 5_000) / 1000;
  utimesSync(ssoFile, ssoTime, ssoTime);

  const stsDir = join(awsDir, "cli", "cache");
  mkdirSync(stsDir, { recursive: true });
  const stsFile = join(stsDir, stsCacheFilename({ accountId: identity!.accountId!, roleName: identity!.roleName!, startUrl: identity!.startUrl }));
  writeFileSync(stsFile, JSON.stringify({ Credentials: { Expiration: "2099-01-01T00:00:00Z" } }));
  const stsTime = (now - 60_000) / 1000;
  utimesSync(stsFile, stsTime, stsTime);
}

/** Run `forge claude` against the fake CLI with disposable roots. Returns the exit
 *  status plus the combined operator-facing output: the shared launcher prints one
 *  advisory stream for both commands, so an assertion on WHICH stream carried a
 *  finding would test the launcher's plumbing rather than FG-499's contract. */
function runForgeClaude(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string; output: string } {
  const result = spawnSync(tsx, [entry, "claude"], {
    cwd: tmp,
    env: { ...env, ...disposableRoots(), PATH: `${fakeClaudeBin()}:${env.PATH ?? ""}` },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

test("integ FG-435: forge claude does NOT hard-block when STS cache looks stale but export-credentials succeeds (work-laptop recurrence)", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  writeAwsConfigForFakeProfile(awsDir, "forge-fg435-test-profile");
  writeStaleCachesForProfile(awsDir, "forge-fg435-test-profile");

  const result = runForgeClaude({
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "forge-fg435-test-profile",
    FORGE_AWS_DIR: awsDir,
    FORGE_AWS_CREDS_FOR_TEST: "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t",
  });

  assert.equal(result.status, 0, `advisory findings must never fail the launch; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(
    result.output,
    /advisory.*continuing|continuing.*advisory/s,
    `expected an advisory (non-blocking) message; got ${result.output}`,
  );
  assert.doesNotMatch(
    result.output,
    /Credential export also failed/,
    `must not report a hard failure when export-credentials succeeded; got ${result.output}`,
  );
});

test("integ FG-499: forge claude does NOT hard-block (advisory only), naming the resolved profile, when STS cache is stale and export-credentials also fails", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  writeAwsConfigForFakeProfile(awsDir, "forge-fg435-test-profile");
  writeStaleCachesForProfile(awsDir, "forge-fg435-test-profile");

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "forge-fg435-test-profile", FORGE_AWS_DIR: awsDir };
  delete env.FORGE_AWS_CREDS_FOR_TEST; // no override → export-credentials shells out to the real (absent) `aws` binary and fails

  const result = runForgeClaude(env);

  // FG-499: an interactive claude session handles its own auth failure natively, so
  // this preflight condition must never exit non-zero — only warn (naming the
  // profile + remediation) and proceed to launch. With a fake `claude` on PATH the
  // exit code is now a direct assertion rather than an inference.
  assert.equal(result.status, 0, `FG-499: an advisory finding must not fail the launch; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.output, /profile 'forge-fg435-test-profile'/);
  assert.match(result.output, /aws sso login --profile forge-fg435-test-profile/);
  assert.match(result.output, /advisory only/);
  // Launch actually proceeded past the credential check: the banner is printed by
  // the shared launcher only after every pre-spawn gate has passed.
  assert.match(
    result.stdout,
    /Launching as '.*' orchestrator via Claude Code/,
    `expected the shared launch banner; got stdout=${result.stdout} stderr=${result.stderr}`,
  );
  assert.match(result.stdout, /bedrock:forge-fg435-test-profile/, "the resolved AWS profile must stay visible at launch");
  assert.match(result.stdout, /auth: anthropic\/bedrock/);
});

// ─── (7) FG-435 round 2: profile-scoped SSO-expiry check (no STS cache at all) ─
//
// detectStaleStsCache only fires when the profile has its OWN ~/.aws/cli/cache
// STS entry to compare mtimes against. A profile authenticating SSO-direct
// (FORGE-DEC-013 — the common bedrock case) never populates cli/cache, so an
// expired SSO session with no STS cache used to sail through as {stale:
// false} and forge claude would silently launch a doomed session. These tests
// cover the gap: write an expired SSO token cache file with NO corresponding
// STS cache file at all.

function writeExpiredSsoOnlyForProfile(awsDir: string, profile: string): void {
  const identity = resolveProfileSsoIdentity(awsDir, profile);
  assert.ok(identity, "test setup bug: profile identity not resolved");
  const ssoDir = join(awsDir, "sso", "cache");
  mkdirSync(ssoDir, { recursive: true });
  const ssoFile = join(ssoDir, ssoTokenCacheFilename(identity!));
  writeFileSync(ssoFile, JSON.stringify({
    accessToken: "fake-expired-token",
    startUrl: identity!.startUrl,
    expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h in the past
  }));
  // Deliberately no ~/.aws/cli/cache entry — the SSO-direct shape.
}

test("integ FG-499: forge claude does NOT hard-block (advisory only) on expired SSO session with no STS cache, naming the profile + sso login remediation", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  writeAwsConfigForFakeProfile(awsDir, "forge-fg435r2-test-profile");
  writeExpiredSsoOnlyForProfile(awsDir, "forge-fg435r2-test-profile");

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "forge-fg435r2-test-profile", FORGE_AWS_DIR: awsDir };
  delete env.FORGE_AWS_CREDS_FOR_TEST; // no override → export-credentials shells out to the real (absent) `aws` binary and fails

  const result = runForgeClaude(env);

  assert.equal(result.status, 0, `FG-499: advisory only — must not exit non-zero; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.output, /profile 'forge-fg435r2-test-profile'/);
  assert.match(result.output, /aws sso login --profile forge-fg435r2-test-profile/);
  assert.match(result.output, /advisory only/);
  assert.match(result.stdout, /Launching as '.*' orchestrator via Claude Code/);
  assert.match(result.stdout, /bedrock:forge-fg435r2-test-profile/);
});

test("integ FG-435 round 2: forge claude does NOT hard-block on expired SSO session when export-credentials succeeds (advisory only)", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  writeAwsConfigForFakeProfile(awsDir, "forge-fg435r2-test-profile");
  writeExpiredSsoOnlyForProfile(awsDir, "forge-fg435r2-test-profile");

  const result = runForgeClaude({
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "forge-fg435r2-test-profile",
    FORGE_AWS_DIR: awsDir,
    FORGE_AWS_CREDS_FOR_TEST: "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t",
  });

  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(
    result.output,
    /advisory.*continuing|continuing.*advisory/s,
    `expected an advisory (non-blocking) message; got ${result.output}`,
  );
  assert.doesNotMatch(
    result.output,
    /aws sso login --profile forge-fg435r2-test-profile/,
    `must not report the hard-failure remediation when export-credentials succeeded; got ${result.output}`,
  );
});

test("integ FG-435 round 2: a fresh OTHER profile does not mask the resolved profile's expired SSO session (cross-profile isolation)", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  mkdirSync(awsDir, { recursive: true });
  writeFileSync(
    join(awsDir, "config"),
    [
      "[profile forge-fg435r2-fresh-other]",
      "sso_start_url = https://other.awsapps.com/start",
      "sso_account_id = 222222222222",
      "sso_role_name = OtherRole",
      "region = us-east-1",
      "",
      "[profile forge-fg435r2-expired-target]",
      "sso_start_url = https://example.awsapps.com/start",
      "sso_account_id = 111111111111",
      "sso_role_name = TestRole",
      "region = us-east-1",
      "",
    ].join("\n"),
  );

  // OTHER profile: fresh SSO session (expiresAt far in the future).
  const otherIdentity = resolveProfileSsoIdentity(awsDir, "forge-fg435r2-fresh-other");
  assert.ok(otherIdentity, "test setup bug: other-profile identity not resolved");
  const ssoDir = join(awsDir, "sso", "cache");
  mkdirSync(ssoDir, { recursive: true });
  writeFileSync(
    join(ssoDir, ssoTokenCacheFilename(otherIdentity!)),
    JSON.stringify({
      accessToken: "fake-fresh-token",
      startUrl: otherIdentity!.startUrl,
      expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    }),
  );

  // Resolved (target) profile: expired SSO session, no STS cache.
  writeExpiredSsoOnlyForProfile(awsDir, "forge-fg435r2-expired-target");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "forge-fg435r2-expired-target",
    FORGE_AWS_DIR: awsDir,
  };
  delete env.FORGE_AWS_CREDS_FOR_TEST; // no override → export-credentials fails for the target profile

  const result = runForgeClaude(env);

  // FG-499: advisory only — the target profile's own expiry must still be named
  // (not masked by the fresh other profile), and this must never exit non-zero.
  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.output, /profile 'forge-fg435r2-expired-target'/);
  assert.doesNotMatch(result.output, /forge-fg435r2-fresh-other/);
  assert.match(result.output, /advisory only/);
  assert.match(result.stdout, /Launching as '.*' orchestrator via Claude Code/);
});

test("integ FG-435 round 2 fix: forge claude does NOT hard-block a plain (non-SSO) static-credential bedrock profile, and never shells out to export-credentials for it", () => {
  mkdirSync(join(tmp, ".git"));
  const awsDir = join(tmp, "fake-aws");
  mkdirSync(awsDir, { recursive: true });
  writeFileSync(
    join(awsDir, "config"),
    `[profile forge-fg435r2-static-profile]\nregion = us-east-1\n`,
  );
  writeFileSync(
    join(awsDir, "credentials"),
    `[forge-fg435r2-static-profile]\naws_access_key_id = AKIAFAKE\naws_secret_access_key = fakesecret\n`,
  );

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "forge-fg435r2-static-profile", FORGE_AWS_DIR: awsDir };
  // No FORGE_AWS_CREDS_FOR_TEST override and no real `aws` binary reachable in
  // this shape — if the fix regresses and this profile is treated as SSO, the
  // export-credentials call fails and an SSO remediation is reported.
  delete env.FORGE_AWS_CREDS_FOR_TEST;

  const result = runForgeClaude(env);

  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.doesNotMatch(
    result.output,
    /no SSO session mapping could be resolved/,
    `must not treat a non-SSO profile as an unresolvable SSO mapping; got ${result.output}`,
  );
  assert.doesNotMatch(result.output, /aws sso login/, `must not report an SSO remediation for a non-SSO profile; got ${result.output}`);
});
