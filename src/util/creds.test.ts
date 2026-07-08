import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCredsMode,
  detectStaleStsCache,
  exportCredsOverridesStaleness,
  formatExpiryForDisplay,
  hasAwsSsoConfigured,
  hasAnyAwsSsoProfile,
  hasFreshSsoCache,
  resolveAwsProfile,
  resolveProfileSsoIdentity,
  resolveAwsRegion,
  ssoTokenCacheFilename,
  stsCacheFilename,
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
  "FORGE_AWS_CREDS_FOR_TEST",
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
  // The active volume defaults to "forge-claude-oauth-v2" but the cache was
  // written for a different name. Treat as a stale hint — covers both the
  // user-set FORGE_OAUTH_VOLUME drift case and the v1→v2 migration.
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
  assert.equal(hint!.volumeName, "forge-claude-oauth-v2");
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
      volumeName: "forge-claude-oauth-v2",
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

// ----- #119 / FG-435: detectStaleStsCache (profile-scoped) -----
//
// FG-435 replaced the old "freshest SSO file vs freshest STS file, across ALL
// profiles" heuristic with one that recomputes the EXACT filenames botocore
// itself uses for a given profile's SSO token cache (ssoTokenCacheFilename)
// and STS credential cache (stsCacheFilename), then reads only those two
// files. These helpers mirror what `aws sso login` / `aws sts
// get-caller-identity` actually write, so tests can place cache files exactly
// where the detector will look for a given profile — the same way multiple
// real profiles' caches coexist without colliding (the hashes differ).

function configureLegacySsoProfile(
  profile: string,
  opts: { startUrl: string; accountId?: string; roleName?: string }
): void {
  const lines = [`[profile ${profile}]`, `sso_start_url = ${opts.startUrl}`, `region = us-east-1`];
  if (opts.accountId) lines.push(`sso_account_id = ${opts.accountId}`);
  if (opts.roleName) lines.push(`sso_role_name = ${opts.roleName}`);
  writeFileSync(join(tmpAwsDir, "config"), lines.join("\n") + "\n", { flag: "a" });
}

function configureSessionSsoProfile(
  profile: string,
  opts: { sessionName: string; startUrl: string; accountId?: string; roleName?: string }
): void {
  const lines = [
    `[profile ${profile}]`,
    `sso_session = ${opts.sessionName}`,
    opts.accountId ? `sso_account_id = ${opts.accountId}` : "",
    opts.roleName ? `sso_role_name = ${opts.roleName}` : "",
    `region = us-east-1`,
    `[sso-session ${opts.sessionName}]`,
    `sso_start_url = ${opts.startUrl}`,
    `sso_region = us-east-1`,
  ].filter(Boolean);
  writeFileSync(join(tmpAwsDir, "config"), lines.join("\n") + "\n", { flag: "a" });
}

// Writes this profile's own SSO token cache file at the exact filename
// botocore's SSOTokenProvider would use, so detectStaleStsCache finds it via
// its computed hash rather than a glob/freshest scan.
function writeProfileSsoToken(profile: string, mtimeMs: number, expiresAt?: string): void {
  const identity = resolveProfileSsoIdentity(tmpAwsDir, profile);
  assert.ok(identity, `test setup bug: profile '${profile}' has no resolvable SSO identity`);
  const dir = join(tmpAwsDir, "sso", "cache");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ssoTokenCacheFilename(identity!));
  writeFileSync(path, JSON.stringify({
    accessToken: "fake-token",
    startUrl: identity!.startUrl,
    expiresAt: expiresAt ?? new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
  }));
  const t = mtimeMs / 1000;
  utimesSync(path, t, t);
}

// Writes this profile's own STS credential cache file at the exact filename
// botocore's SSOCredentialFetcher would use.
function writeProfileStsCache(profile: string, mtimeMs: number): void {
  const identity = resolveProfileSsoIdentity(tmpAwsDir, profile);
  assert.ok(identity?.accountId && identity.roleName, `test setup bug: profile '${profile}' missing accountId/roleName`);
  const dir = join(tmpAwsDir, "cli", "cache");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, stsCacheFilename({ accountId: identity!.accountId!, roleName: identity!.roleName!, startUrl: identity!.startUrl }));
  writeFileSync(path, JSON.stringify({ Credentials: { Expiration: "2099-01-01T00:00:00Z" } }));
  const t = mtimeMs / 1000;
  utimesSync(path, t, t);
}

test("detectStaleStsCache: returns null when the profile has no SSO configured at all (unresolvable mapping, safe-degrade)", () => {
  writeAwsConfig("[profile plain]\naws_access_key_id = AKIA...\n");
  assert.equal(detectStaleStsCache({ profile: "plain" }), null);
});

test("detectStaleStsCache: returns null when the profile doesn't exist in config", () => {
  assert.equal(detectStaleStsCache({ profile: "nope" }), null);
});

test("detectStaleStsCache: advisory non-blocking when sso_account_id/sso_role_name are missing (unresolvable STS cache key)", () => {
  configureLegacySsoProfile("partial", { startUrl: "https://example.awsapps.com/start" });
  const result = detectStaleStsCache({ profile: "partial" });
  assert.equal(result?.stale, false);
  assert.equal(result?.advisory, true);
  assert.match(result?.reason ?? "", /Could not confidently associate/);
});

test("detectStaleStsCache: SSO-direct profile with no profile-associated cli/cache entry → not stale (no vestigial-cache false positive)", () => {
  // The FORGE-DEC-013 bedrock case: SSO cache is fresh, but this profile has
  // never populated ~/.aws/cli/cache (bedrock reads SSO directly). Must NOT
  // be flagged stale just because a cli/cache dir exists for OTHER profiles.
  configureLegacySsoProfile("sso-direct", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  writeProfileSsoToken("sso-direct", Date.now() - 5_000);
  mkdirSync(join(tmpAwsDir, "cli", "cache"), { recursive: true }); // dir exists, but no file for this profile
  const result = detectStaleStsCache({ profile: "sso-direct" });
  assert.equal(result?.stale, false);
  assert.equal(result?.reason, "");
});

test("detectStaleStsCache: {stale:false} when this profile's own STS cache is newer than its own SSO session", () => {
  configureLegacySsoProfile("fresh", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileSsoToken("fresh", now - 60_000);  // SSO from 1 min ago
  writeProfileStsCache("fresh", now - 10_000);  // STS from 10s ago (newer)
  const result = detectStaleStsCache({ profile: "fresh" });
  assert.equal(result?.stale, false);
});

test("detectStaleStsCache: {stale:true} when this profile's own SSO session is newer than its own STS cache — names the profile, says other profiles unaffected", () => {
  configureLegacySsoProfile("adx-dev-poweruser", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileStsCache("adx-dev-poweruser", now - 60_000);   // STS from 1 min ago
  writeProfileSsoToken("adx-dev-poweruser", now - 10_000);   // SSO from 10s ago (newer → stale)
  const result = detectStaleStsCache({ profile: "adx-dev-poweruser" });
  assert.equal(result?.stale, true);
  assert.match(result?.reason ?? "", /STS credentials for profile 'adx-dev-poweruser' are stale/);
  assert.match(result?.reason ?? "", /other profiles are unaffected/);
  assert.match(result?.reason ?? "", /aws sts get-caller-identity --profile adx-dev-poweruser/);
});

test("detectStaleStsCache: tolerates 1-second mtime jitter (same-second refresh isn't flagged)", () => {
  configureLegacySsoProfile("jitter", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileStsCache("jitter", now - 1000);
  writeProfileSsoToken("jitter", now - 200);  // 800ms newer — within 1s slack
  const result = detectStaleStsCache({ profile: "jitter" });
  assert.equal(result?.stale, false);
});

test("detectStaleStsCache: cross-profile isolation — fresh SSO activity on profile A does not flag profile B stale", () => {
  // The exact multi-profile false positive from FG-435: profile A (adx-dev)
  // has a very fresh SSO session; profile B (adx-dev-poweruser) is the one
  // being launched, with its OWN stale-looking STS cache. Profile A's
  // freshness must have zero bearing on profile B's verdict.
  configureLegacySsoProfile("adx-dev", { startUrl: "https://example.awsapps.com/start-a", accountId: "111", roleName: "RA" });
  configureLegacySsoProfile("adx-dev-poweruser", { startUrl: "https://example.awsapps.com/start-b", accountId: "222", roleName: "RB" });
  const now = Date.now();
  // Profile A: extremely fresh SSO, no STS cache of its own at all.
  writeProfileSsoToken("adx-dev", now - 1_000);
  // Profile B: STS cache newer than its own SSO session → NOT stale.
  writeProfileSsoToken("adx-dev-poweruser", now - 120_000);
  writeProfileStsCache("adx-dev-poweruser", now - 10_000);

  const resultB = detectStaleStsCache({ profile: "adx-dev-poweruser" });
  assert.equal(resultB?.stale, false, "profile B must be judged on its own caches only");

  const resultA = detectStaleStsCache({ profile: "adx-dev" });
  assert.equal(resultA?.stale, false, "profile A has no STS cache of its own — nothing to be stale");
});

test("detectStaleStsCache: cross-profile isolation — profile B genuinely stale even though profile A looks fine", () => {
  configureLegacySsoProfile("adx-dev", { startUrl: "https://example.awsapps.com/start-a", accountId: "111", roleName: "RA" });
  configureLegacySsoProfile("adx-dev-poweruser", { startUrl: "https://example.awsapps.com/start-b", accountId: "222", roleName: "RB" });
  const now = Date.now();
  // Profile A: perfectly consistent (STS newer than SSO).
  writeProfileSsoToken("adx-dev", now - 60_000);
  writeProfileStsCache("adx-dev", now - 10_000);
  // Profile B: genuinely stale (SSO newer than its own STS).
  writeProfileStsCache("adx-dev-poweruser", now - 60_000);
  writeProfileSsoToken("adx-dev-poweruser", now - 5_000);

  assert.equal(detectStaleStsCache({ profile: "adx-dev" })?.stale, false);
  const resultB = detectStaleStsCache({ profile: "adx-dev-poweruser" });
  assert.equal(resultB?.stale, true);
  assert.match(resultB?.reason ?? "", /profile 'adx-dev-poweruser'/);
});

test("detectStaleStsCache: preserves single-profile stale detection when profile association is clear (sso_session form, FG-119/FG-120 lineage)", () => {
  configureSessionSsoProfile("adx-dev", { sessionName: "s1", startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileStsCache("adx-dev", now - 60_000);
  writeProfileSsoToken("adx-dev", now - 5_000);
  const result = detectStaleStsCache({ profile: "adx-dev" });
  assert.equal(result?.stale, true);
  assert.match(result?.reason ?? "", /profile 'adx-dev'/);
});

// ----- exportCredsOverridesStaleness (FG-435 work-laptop recurrence) -----

test("exportCredsOverridesStaleness: true when export-credentials succeeds (test escape hatch)", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  assert.equal(exportCredsOverridesStaleness("adx-dev"), true);
});

test("exportCredsOverridesStaleness: false when export-credentials fails (no aws CLI / no override in this environment)", () => {
  assert.equal(exportCredsOverridesStaleness("adx-dev"), false);
});

test("validateCredsForNewRun: work-laptop recurrence — mtime-stale but export-credentials succeeds → no throw (advisory only)", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  configureSessionSsoProfile("adx-dev", { sessionName: "s1", startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileStsCache("adx-dev", now - 60_000);
  writeProfileSsoToken("adx-dev", now - 5_000);  // SSO newer → mtime heuristic says stale
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: bedrock STS cache stale + export-credentials also fails → throws, names the profile, other profiles unaffected", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  configureSessionSsoProfile("adx-dev", { sessionName: "s1", startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  const now = Date.now();
  writeProfileStsCache("adx-dev", now - 60_000);
  writeProfileSsoToken("adx-dev", now - 5_000);  // SSO newer → STS stale
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) =>
      err.message.includes("predate its current SSO session") &&
      err.message.includes("profile 'adx-dev'") &&
      err.message.includes("other profiles are unaffected") &&
      err.message.includes("aws sso login --profile adx-dev"),
  );
});

// ----- timezone-safe expiry messaging (FG-435) -----

test("formatExpiryForDisplay: labels a Z-suffixed timestamp as UTC and includes a local rendering", () => {
  const iso = "2026-07-07T23:35:21.000Z";
  const out = formatExpiryForDisplay(iso);
  assert.match(out, /2026-07-07T23:35:21\.000Z \(UTC\)/);
  assert.match(out, /local:/);
});

test("formatExpiryForDisplay: returns the raw string unchanged when unparseable", () => {
  assert.equal(formatExpiryForDisplay("not-a-date"), "not-a-date");
});

test("validateCredsForNewRun: expired SSO session error names the profile, cache file, raw expiresAt, and UTC-labeled interpretation", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  configureLegacySsoProfile("adx-dev", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  // A session cache exists for this exact profile, but its expiresAt is in the
  // past — hasFreshSsoCache will reject it, so validateCredsForNewRun must
  // describe THIS profile's own expired token with evidence, not a bare
  // "expired" claim.
  const expiredAt = "2026-07-07T23:35:21.000Z";
  writeProfileSsoToken("adx-dev", Date.now() - 1000, expiredAt);
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) =>
      err.message.includes("profile 'adx-dev'") &&
      err.message.includes(`raw expiresAt=${expiredAt}`) &&
      err.message.includes("(UTC)") &&
      err.message.includes("aws sso login --profile adx-dev"),
  );
});

test("validateCredsForNewRun: 2026-07-07 orchestrator recurrence — SSO cache looks expired but export-credentials succeeds → no throw (launch-ready regardless of stale-looking cache)", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  configureLegacySsoProfile("adx-dev", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  // hasFreshSsoCache would reject this (expiresAt in the past), reproducing
  // the recurrence where the operator had just refreshed `adx-dev` but the
  // cache-mtime/expiresAt heuristic still called it expired. A successful
  // export-credentials probe (same credential path forge injects into
  // containers) must be authoritative over that heuristic.
  writeProfileSsoToken("adx-dev", Date.now() - 1000, "2026-07-07T23:35:21.000Z");
  assert.doesNotThrow(() => validateCredsForNewRun());
});

test("validateCredsForNewRun: SSO cache looks expired AND export-credentials also fails → still hard-blocks, naming the resolved profile", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  configureLegacySsoProfile("adx-dev", { startUrl: "https://example.awsapps.com/start", accountId: "111", roleName: "R" });
  writeProfileSsoToken("adx-dev", Date.now() - 1000, "2026-07-07T23:35:21.000Z");
  assert.throws(
    () => validateCredsForNewRun(),
    (err: Error) => err.message.includes("profile 'adx-dev'") && err.message.includes("aws sso login --profile adx-dev"),
  );
});
