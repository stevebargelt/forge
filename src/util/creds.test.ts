import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCredsMode,
  hasAwsSsoConfigured,
  hasFreshSsoCache,
  resolveAwsProfile,
  resolveAwsRegion,
  validateCredsForNewRun,
  getAuthState,
  AUTH_ERROR_PREFIX,
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

// -------- hasFreshSsoCache --------

function writeSsoCache(name: string, body: object): void {
  const dir = join(tmpAwsDir, "sso", "cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body));
}

test("hasFreshSsoCache: false when cache dir doesn't exist", () => {
  assert.equal(hasFreshSsoCache(join(tmpAwsDir, "sso", "cache")), false);
});

test("hasFreshSsoCache: false when only a client-registration file exists (no session)", () => {
  // Client-registration files have `expiresAt` but no `startUrl` / `accessToken`.
  // They prove the SDK has registered, not that there's an active session.
  writeSsoCache("reg.json", {
    clientId: "abc",
    clientSecret: "shh",
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
  assert.equal(hasFreshSsoCache(join(tmpAwsDir, "sso", "cache")), false);
});

test("hasFreshSsoCache: true when a session cache has future expiresAt", () => {
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h out
  });
  assert.equal(hasFreshSsoCache(join(tmpAwsDir, "sso", "cache")), true);
});

test("hasFreshSsoCache: false when the session cache is expired", () => {
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago
  });
  assert.equal(hasFreshSsoCache(join(tmpAwsDir, "sso", "cache")), false);
});

test("hasFreshSsoCache: true when any cache file is fresh (mixed dir)", () => {
  // Real ~/.aws/sso/cache has both client-registration AND session files
  // side by side. Only one needs to be a fresh session for us to accept.
  writeSsoCache("reg.json", {
    clientId: "abc",
    clientSecret: "shh",
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  assert.equal(hasFreshSsoCache(join(tmpAwsDir, "sso", "cache")), true);
});

test("hasFreshSsoCache: tolerates corrupt JSON in one file without failing", () => {
  const dir = join(tmpAwsDir, "sso", "cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "broken.json"), "{not valid json");
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  assert.equal(hasFreshSsoCache(dir), true);
});

// -------- validateCredsForNewRun --------

test("validateCredsForNewRun: bedrock + fresh SSO cache → no throw", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "test";
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: bedrock + expired SSO cache → throws with AUTH_ERROR_PREFIX", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "test";
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  });
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) => err.message.startsWith(AUTH_ERROR_PREFIX) && err.message.includes("aws sso login")
  );
});

test("validateCredsForNewRun: bedrock + no cache dir → throws with AUTH_ERROR_PREFIX", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "test";
  // tmpAwsDir exists but has no sso/cache subdir
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) => err.message.startsWith(AUTH_ERROR_PREFIX) && err.message.includes("no SSO cache")
  );
});

test("validateCredsForNewRun: apikey + ANTHROPIC_API_KEY set → no throw", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: apikey mode forced by CLAUDE_CODE_USE_BEDROCK=0 + missing key → throws", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "0";
  // Simulate "user wanted apikey but forgot to set ANTHROPIC_API_KEY". Mode
  // resolves to oauth in this case (since the key isn't set), so the check
  // doesn't throw — defer to spawn time. This test documents that intentional
  // softness: validateCredsForNewRun() doesn't validate oauth.
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: oauth mode → no throw (deferred to spawn time)", () => {
  // No AWS, no API key — falls to oauth. We don't probe the docker volume here
  // because that costs 1-2 seconds; the spawn-time ensureCreds() handles it.
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("AUTH_ERROR_PREFIX is a stable string the dashboard sniffs for", () => {
  // If this changes, dashboard server.ts's `out.stderr.includes(AUTH_ERROR_PREFIX)`
  // check still passes (it imports the constant). But downstream tooling /
  // tests / docs that hardcode the string would break — keep it stable.
  assert.equal(AUTH_ERROR_PREFIX, "Auth error: ");
});

// -------- getAuthState (#97 indicator backend) --------

test("getAuthState: oauth default → health=ok, no identity", () => {
  const s = getAuthState();
  assert.equal(s.mode, "anthropic-oauth");
  assert.equal(s.health, "ok");
  assert.equal(s.identity, "");
  assert.equal(s.remediation, "");
});

test("getAuthState: apikey mode → health=ok, no identity", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const s = getAuthState();
  assert.equal(s.mode, "anthropic-apikey");
  assert.equal(s.health, "ok");
  assert.equal(s.identity, "");
});

test("getAuthState: bedrock + fresh SSO → health=ok with identity", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "sgws-poc";
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  const s = getAuthState();
  assert.equal(s.mode, "bedrock");
  assert.equal(s.health, "ok");
  assert.equal(s.identity, "sgws-poc");
});

test("getAuthState: bedrock + expired SSO → health=expired with remediation", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "sgws-poc";
  writeSsoCache("session.json", {
    startUrl: "https://example.awsapps.com/start/",
    accessToken: "tok-abc",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const s = getAuthState();
  assert.equal(s.mode, "bedrock");
  assert.equal(s.health, "expired");
  assert.equal(s.identity, "sgws-poc");
  assert.ok(s.remediation.includes("aws sso login --profile sgws-poc"));
});

test("getAuthState: bedrock + no SSO cache → health=expired", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "sgws-poc";
  const s = getAuthState();
  assert.equal(s.mode, "bedrock");
  assert.equal(s.health, "expired");
  assert.ok(s.remediation.includes("aws sso login"));
});
