import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCredsMode,
  hasAwsSsoConfigured,
  resolveAwsProfile,
  resolveAwsRegion,
} from "./creds.js";

// Snapshot of every env var creds.ts cares about. detectCredsMode reads several
// of them, and the auto-detect path is sensitive to any leaking state, so each
// test starts from a known-empty slate and restores at the end.
const KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_API_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "FORGE_AWS_DIR",
];
let snapshot: Record<string, string | undefined> = {};
let tmpAwsDir: string;

beforeEach(() => {
  snapshot = {};
  for (const k of KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  // Each test gets its own fake ~/.aws dir; tests that want SSO configured
  // write into it explicitly. Tests that want it absent leave it empty.
  tmpAwsDir = join(
    tmpdir(),
    `forge-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpAwsDir, { recursive: true });
  process.env.FORGE_AWS_DIR = tmpAwsDir;
});

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  rmSync(tmpAwsDir, { recursive: true, force: true });
});

function writeAwsConfig(content: string): void {
  writeFileSync(join(tmpAwsDir, "config"), content);
}

// -------- hard overrides --------

test("CLAUDE_CODE_USE_BEDROCK=1 forces bedrock regardless of other env", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal(detectCredsMode(), "bedrock");
});

test("CLAUDE_CODE_USE_BEDROCK=0 hard-disables bedrock even when AWS SSO is configured", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  writeAwsConfig("[default]\nsso_session = my-sso\n");
  // With AWS configured, auto-detect would normally pick bedrock. The hard-off
  // forces fallback to oauth (no API key set).
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("CLAUDE_CODE_USE_BEDROCK=0 + ANTHROPIC_API_KEY falls to apikey", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  writeAwsConfig("[default]\nsso_session = my-sso\n");
  assert.equal(detectCredsMode(), "anthropic-apikey");
});

// -------- auto-detect (no hard override) --------

test("ANTHROPIC_API_KEY wins over auto-detected bedrock", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  writeAwsConfig("[default]\nsso_session = my-sso\n");
  assert.equal(detectCredsMode(), "anthropic-apikey");
});

test("AWS config with sso_session in default profile auto-detects bedrock", () => {
  writeAwsConfig("[default]\nsso_session = my-sso\nregion = us-east-1\n");
  assert.equal(detectCredsMode(), "bedrock");
});

test("AWS config with sso_start_url in default profile auto-detects bedrock (legacy form)", () => {
  writeAwsConfig(
    "[default]\nsso_start_url = https://example.awsapps.com/start\nsso_account_id = 123456789012\n"
  );
  assert.equal(detectCredsMode(), "bedrock");
});

test("AWS config with sso_session only in a named profile does NOT auto-detect bedrock", () => {
  // sso_session in [profile work] doesn't help — auto-detect only fires when
  // the default profile is SSO-configured, because resolveAwsProfile() returns
  // 'default' when AWS_PROFILE isn't set.
  writeAwsConfig("[profile work]\nsso_session = my-sso\n");
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("AWS config without any SSO falls through to oauth", () => {
  writeAwsConfig(
    "[default]\nregion = us-east-1\naws_access_key_id = AKIA...\naws_secret_access_key = ...\n"
  );
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("missing ~/.aws/config falls through to oauth", () => {
  // FORGE_AWS_DIR points at an empty dir (no config file inside).
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("missing ~/.aws dir entirely falls through to oauth", () => {
  process.env.FORGE_AWS_DIR = join(tmpAwsDir, "does-not-exist");
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("no AWS, no API key, no overrides → oauth (default)", () => {
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

// -------- hasAwsSsoConfigured edge cases --------

test("hasAwsSsoConfigured returns false on empty config file", () => {
  writeAwsConfig("");
  assert.equal(hasAwsSsoConfigured(), false);
});

test("hasAwsSsoConfigured tolerates extra whitespace around the = sign", () => {
  writeAwsConfig("[default]\nsso_session   =   my-sso\n");
  assert.equal(hasAwsSsoConfigured(), true);
});

test("hasAwsSsoConfigured doesn't false-match sso_session in a non-default profile", () => {
  writeAwsConfig(
    "[default]\nregion = us-east-1\n[profile work]\nsso_session = work-sso\n"
  );
  assert.equal(hasAwsSsoConfigured(), false);
});

test("hasAwsSsoConfigured doesn't false-match sso_session as a key fragment", () => {
  // Lines like `# sso_session = ...` (comment) or `my_sso_session = foo`
  // shouldn't trip the detector. The regex is anchored to start-of-line + the
  // exact key name.
  writeAwsConfig(
    "[default]\n# sso_session = commented out\nmy_sso_session = something\nregion = us-east-1\n"
  );
  assert.equal(hasAwsSsoConfigured(), false);
});

// -------- resolveAwsProfile / resolveAwsRegion --------

test("resolveAwsProfile honors AWS_PROFILE when set", () => {
  process.env.AWS_PROFILE = "custom";
  assert.equal(resolveAwsProfile(), "custom");
});

test("resolveAwsProfile falls back to 'default' when AWS_PROFILE unset", () => {
  assert.equal(resolveAwsProfile(), "default");
});

test("resolveAwsRegion honors AWS_REGION when set", () => {
  process.env.AWS_REGION = "us-west-2";
  assert.equal(resolveAwsRegion(), "us-west-2");
});

test("resolveAwsRegion falls back to 'us-east-1' when AWS_REGION unset", () => {
  assert.equal(resolveAwsRegion(), "us-east-1");
});
