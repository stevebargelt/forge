import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCredsMode,
  hasAwsSsoConfigured,
  hasAnyAwsSsoProfile,
  hasFreshSsoCache,
  resolveAwsProfile,
  resolveAwsRegion,
  validateCredsForNewRun,
  getAuthState,
  readOauthHint,
  isOauthHintFresh,
  writeOauthHint,
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
  "FORGE_HOME",
  "FORGE_OAUTH_VOLUME",
];
let snapshot: Record<string, string | undefined> = {};
let tmpAwsDir: string;
let tmpForgeHome: string;

beforeEach(() => {
  snapshot = {};
  for (const k of KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  // Each test gets its own fake ~/.aws dir; tests that want SSO configured
  // write into it explicitly. Tests that want it absent leave it empty.
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2);
  tmpAwsDir = join(tmpdir(), `forge-creds-test-${stamp}`);
  mkdirSync(tmpAwsDir, { recursive: true });
  process.env.FORGE_AWS_DIR = tmpAwsDir;
  // Each test also gets its own FORGE_HOME so writeOauthHint() doesn't touch
  // the user's real cache file.
  tmpForgeHome = join(tmpdir(), `forge-home-test-${stamp}`);
  mkdirSync(tmpForgeHome, { recursive: true });
  process.env.FORGE_HOME = tmpForgeHome;
});

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  rmSync(tmpAwsDir, { recursive: true, force: true });
  rmSync(tmpForgeHome, { recursive: true, force: true });
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

test("AWS config with sso_session only in a named profile + no AWS_PROFILE → oauth fallback", () => {
  // No AWS_PROFILE in env, [default] has nothing. The named profile having
  // SSO doesn't matter — without AWS_PROFILE, the user hasn't signaled AWS.
  // Falls through to oauth.
  writeAwsConfig("[profile work]\nsso_session = my-sso\n");
  assert.equal(detectCredsMode(), "anthropic-oauth");
});

test("AWS_PROFILE set → auto-detect bedrock regardless of config contents", () => {
  // AWS_PROFILE is the user's signal that they want AWS. The detector picks
  // bedrock without requiring CLAUDE_CODE_USE_BEDROCK=1. Pre-flight catches
  // any actual SSO problems at run-creation time.
  process.env.AWS_PROFILE = "adx-dev";
  writeAwsConfig("[profile adx-dev]\nsso_session = adx-dev\nregion = us-east-1\n");
  assert.equal(detectCredsMode(), "bedrock");
});

test("AWS_PROFILE set even without SSO config → still bedrock (pre-flight catches misconfig)", () => {
  // The detector doesn't second-guess AWS_PROFILE — if the user set it, that
  // intent stands. validateCredsForNewRun handles the "but you have no SSO
  // cache" case with a clear error message.
  process.env.AWS_PROFILE = "static";
  writeAwsConfig("[profile static]\naws_access_key_id = AKIA...\n");
  assert.equal(detectCredsMode(), "bedrock");
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

test("hasAwsSsoConfigured (no AWS_PROFILE) only checks [default], not named profiles", () => {
  // With no AWS_PROFILE in env, hasAwsSsoConfigured() resolves to checking
  // [default]. SSO in [profile work] doesn't help.
  writeAwsConfig(
    "[default]\nregion = us-east-1\n[profile work]\nsso_session = work-sso\n"
  );
  assert.equal(hasAwsSsoConfigured(), false);
});

test("hasAwsSsoConfigured honors AWS_PROFILE when set", () => {
  process.env.AWS_PROFILE = "work";
  writeAwsConfig(
    "[default]\nregion = us-east-1\n[profile work]\nsso_session = work-sso\n"
  );
  assert.equal(hasAwsSsoConfigured(), true);
});

test("hasAwsSsoConfigured accepts an explicit profile-name override", () => {
  // Useful for callers that want to inspect a specific profile regardless
  // of env state.
  writeAwsConfig("[profile build]\nsso_session = build-sso\n");
  assert.equal(hasAwsSsoConfigured("build"), true);
  assert.equal(hasAwsSsoConfigured("nope"), false);
});

// -------- hasAnyAwsSsoProfile (popover hint) --------

test("hasAnyAwsSsoProfile: false when no AWS config exists", () => {
  assert.equal(hasAnyAwsSsoProfile(), false);
});

test("hasAnyAwsSsoProfile: true when [default] has SSO", () => {
  writeAwsConfig("[default]\nsso_session = my-sso\n");
  assert.equal(hasAnyAwsSsoProfile(), true);
});

test("hasAnyAwsSsoProfile: true when any named [profile X] has SSO", () => {
  // The case Steven hit: [profile adx-dev] has SSO but no [default].
  writeAwsConfig("[profile adx-dev]\nsso_session = adx-dev\nregion = us-east-1\n");
  assert.equal(hasAnyAwsSsoProfile(), true);
});

test("hasAnyAwsSsoProfile: ignores [sso-session X] sections (those declare sessions, not profiles)", () => {
  writeAwsConfig(
    "[sso-session adx-dev]\nsso_start_url = https://example.awsapps.com/start/\n"
  );
  assert.equal(hasAnyAwsSsoProfile(), false);
});

test("hasAnyAwsSsoProfile: false when only non-SSO profiles exist", () => {
  writeAwsConfig(
    "[default]\nregion = us-east-1\n[profile static]\naws_access_key_id = AKIA...\n"
  );
  assert.equal(hasAnyAwsSsoProfile(), false);
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

test("validateCredsForNewRun: oauth + fresh credsPresent=true hint → no throw", () => {
  writeOauthHint({ credsPresent: true, email: "x@y.com" });
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: oauth + fresh credsPresent=false hint → throws", () => {
  writeOauthHint({ credsPresent: false });
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) => err.message.startsWith(AUTH_ERROR_PREFIX) && err.message.includes("forge auth login")
  );
});

test("AUTH_ERROR_PREFIX is a stable string the dashboard sniffs for", () => {
  // If this changes, dashboard server.ts's `out.stderr.includes(AUTH_ERROR_PREFIX)`
  // check still passes (it imports the constant). But downstream tooling /
  // tests / docs that hardcode the string would break — keep it stable.
  assert.equal(AUTH_ERROR_PREFIX, "Auth error: ");
});

// -------- getAuthState (#97 indicator backend) --------

test("getAuthState: oauth + fresh credsPresent hint → health=ok with identity", () => {
  // Seed a fresh hint so getAuthState reads it instead of probing the volume
  // (which would hit the host's real Docker — flaky in CI).
  writeOauthHint({
    credsPresent: true,
    email: "test@example.com",
    organizationName: "Test Org",
    plan: "claude_max",
    loggedInAt: "2025-07-26T21:46:20.660879Z",
  });
  const s = getAuthState();
  assert.equal(s.mode, "anthropic-oauth");
  assert.equal(s.health, "ok");
  assert.equal(s.identity, "test@example.com");
  assert.equal(s.remediation, "");
  assert.equal(s.detail.oauthEmail, "test@example.com");
  assert.equal(s.detail.oauthOrganization, "Test Org");
  assert.equal(s.detail.oauthPlan, "claude_max");
  assert.equal(s.detail.oauthLoggedInAt, "2025-07-26T21:46:20.660879Z");
});

test("getAuthState: oauth + fresh credsPresent=false hint → health=missing", () => {
  // Probe ran, found no creds. Indicator should surface "missing" + the
  // remediation command, not the old optimistic "ready" lie.
  writeOauthHint({ credsPresent: false });
  const s = getAuthState();
  assert.equal(s.mode, "anthropic-oauth");
  assert.equal(s.health, "missing");
  assert.equal(s.remediation, "forge auth login");
});

test("getAuthState: oauth + AWS configured but no AWS_PROFILE → awsAvailable=true", () => {
  // Edge case: host has [profile adx-dev] with SSO but the user hasn't
  // exported AWS_PROFILE in this shell. Detector picks oauth (no
  // AWS_PROFILE signal). Indicator hint surfaces that AWS is available.
  // Seed a hint so we don't probe the host's real volume.
  writeOauthHint({ credsPresent: true, email: "x@y.com" });
  writeAwsConfig("[profile adx-dev]\nsso_session = adx-dev\nregion = us-east-1\n");
  const s = getAuthState();
  assert.equal(s.mode, "anthropic-oauth");
  assert.equal(s.detail.awsAvailable, true);
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

// -------- OAuth hint helpers (#97 follow-up) --------

test("readOauthHint: returns null when hint file doesn't exist", () => {
  assert.equal(readOauthHint(), null);
});

test("readOauthHint: returns null on malformed JSON", () => {
  writeFileSync(join(tmpForgeHome, "oauth-hint.json"), "{not valid");
  assert.equal(readOauthHint(), null);
});

test("readOauthHint: returns null when cached volume name doesn't match active", () => {
  // The active volume is the default "forge-claude-oauth" but the cache was
  // written for a different name. Treat as a stale hint.
  writeFileSync(
    join(tmpForgeHome, "oauth-hint.json"),
    JSON.stringify({
      volumeName: "some-other-volume",
      writtenAt: new Date().toISOString(),
      credsPresent: true,
      email: "x@y.com",
    })
  );
  assert.equal(readOauthHint(), null);
});

test("writeOauthHint + readOauthHint round-trips identity fields", () => {
  writeOauthHint({
    credsPresent: true,
    email: "steve@example.com",
    organizationName: "Example Org",
    plan: "claude_max",
    loggedInAt: "2025-07-26T21:46:20.660879Z",
  });
  const hint = readOauthHint();
  assert.ok(hint);
  assert.equal(hint!.credsPresent, true);
  assert.equal(hint!.email, "steve@example.com");
  assert.equal(hint!.organizationName, "Example Org");
  assert.equal(hint!.plan, "claude_max");
  assert.equal(hint!.loggedInAt, "2025-07-26T21:46:20.660879Z");
  assert.equal(hint!.volumeName, "forge-claude-oauth");
  assert.ok(hint!.writtenAt);
});

test("writeOauthHint creates FORGE_HOME if it doesn't exist", () => {
  // Remove the auto-created dir, write should recreate it.
  rmSync(tmpForgeHome, { recursive: true, force: true });
  writeOauthHint({ credsPresent: false });
  assert.equal(existsSync(join(tmpForgeHome, "oauth-hint.json")), true);
});

test("writeOauthHint writes atomically (no .tmp file left behind)", () => {
  writeOauthHint({ credsPresent: true, email: "x@y.com" });
  assert.equal(existsSync(join(tmpForgeHome, "oauth-hint.json")), true);
  assert.equal(existsSync(join(tmpForgeHome, "oauth-hint.json.tmp")), false);
});

test("writeOauthHint can record credsPresent=false (probe ran, found nothing)", () => {
  writeOauthHint({ credsPresent: false });
  const hint = readOauthHint();
  assert.ok(hint);
  assert.equal(hint!.credsPresent, false);
  assert.equal(hint!.email, undefined);
});

test("isOauthHintFresh: false when no hint exists", () => {
  assert.equal(isOauthHintFresh(), false);
});

test("isOauthHintFresh: true for a just-written hint", () => {
  writeOauthHint({ credsPresent: true, email: "x@y.com" });
  assert.equal(isOauthHintFresh(), true);
});

test("isOauthHintFresh: false when hint is older than threshold", () => {
  writeFileSync(
    join(tmpForgeHome, "oauth-hint.json"),
    JSON.stringify({
      volumeName: "forge-claude-oauth",
      writtenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10m ago
      credsPresent: true,
    })
  );
  assert.equal(isOauthHintFresh(), false);
  // But true if we lift the threshold:
  assert.equal(isOauthHintFresh(15 * 60 * 1000), true);
});

test("writeOauthHint honors FORGE_OAUTH_VOLUME override in volumeName field", () => {
  process.env.FORGE_OAUTH_VOLUME = "test-volume";
  writeOauthHint({ credsPresent: true });
  const raw = JSON.parse(readFileSync(join(tmpForgeHome, "oauth-hint.json"), "utf8")) as { volumeName: string };
  assert.equal(raw.volumeName, "test-volume");
});
