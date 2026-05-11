// Credential resolution and validation. Forge supports three auth modes for agents.
// The mode is chosen by env + auto-detection; per-spawn validation runs before every docker run.
//
//   bedrock           — CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE set, OR auto-detected from
//                       a ~/.aws/config that has an sso_session-backed default profile.
//                       Work default. The container reads SSO/STS state from a mounted
//                       ~/.aws (RO). The host watchdog keeps the SSO cache fresh; see
//                       FORGE-DEC-013.
//   anthropic-oauth   — OAuth-based, persisted in a named docker volume. Personal Mac default.
//                       The volume is initialized once via `forge auth login`.
//   anthropic-apikey  — ANTHROPIC_API_KEY env var. Escape hatch.
//
// The OAuth credential file lives on macOS in the Keychain, not in ~/.claude/.credentials.json,
// so the older host-file-mount pattern (DEC-006 in the vault corpus) does not work on Mac.
// We sidestep this by giving the container its own credential store via a named volume —
// the user logs in once inside a forge auth container, the volume holds the token, and every
// agent run mounts the same volume read-only at /home/agent/.claude.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWatchdogRunning } from "./sso-watchdog.js";

export type CredsMode = "bedrock" | "anthropic-oauth" | "anthropic-apikey";

const OAUTH_VOLUME_NAME = "forge-claude-oauth";

// Auto-detection precedence (#79):
//   1. CLAUDE_CODE_USE_BEDROCK=1   → force bedrock
//   2. CLAUDE_CODE_USE_BEDROCK=0   → force OFF bedrock, fall through to (3)/(4)/(5)
//   3. ANTHROPIC_API_KEY set       → apikey
//   4. AWS_PROFILE set             → bedrock (env var IS the user's "I want AWS" signal)
//   5. ~/.aws/config has SSO in [default] → bedrock
//   6. Fallback                    → oauth
//
// Rule 4 is the key ergonomic: any AWS-aware shell tooling sets AWS_PROFILE
// (direnv, asdf-aws, the AWS CLI itself when you `aws configure sso`). If the
// user has AWS_PROFILE in their env, they've already chosen AWS; we shouldn't
// require them to also remember CLAUDE_CODE_USE_BEDROCK=1.
//
// The hard-off (CLAUDE_CODE_USE_BEDROCK=0) lets a user with AWS_PROFILE set
// still force oauth/apikey without unsetting their shell AWS config.
export function detectCredsMode(): CredsMode {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  const hardOff = process.env.CLAUDE_CODE_USE_BEDROCK === "0";
  if (!hardOff) {
    // ANTHROPIC_API_KEY still wins over AWS config when both are present, on
    // the theory that an explicit API key in env is more deliberate than a
    // leftover ~/.aws/config from someone's workplace.
    if (process.env.ANTHROPIC_API_KEY) return "anthropic-apikey";
    if (process.env.AWS_PROFILE) return "bedrock";
    if (hasAwsSsoConfigured()) return "bedrock";
    return "anthropic-oauth";
  }
  // Hard-off bedrock: fall to apikey if set, else oauth.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic-apikey";
  return "anthropic-oauth";
}

// Returns the AWS profile to use for bedrock mode. Honors AWS_PROFILE when set;
// otherwise falls back to "default". When AWS_PROFILE is set, that IS the
// signal that the user wants AWS — detectCredsMode() picks bedrock without
// needing CLAUDE_CODE_USE_BEDROCK.
export function resolveAwsProfile(): string {
  return process.env.AWS_PROFILE ?? "default";
}

// Returns the AWS region to use for bedrock mode. Honors AWS_REGION when set;
// otherwise falls back to us-east-1 (matches use-bedrock.sh's default).
export function resolveAwsRegion(): string {
  return process.env.AWS_REGION ?? "us-east-1";
}

// Parse ~/.aws/config and return the key/value pairs of the given profile
// section. AWS config uses [default] for the default profile and [profile X]
// for named profiles, so callers pass profileName='default' / profileName='work'
// (without the "profile " prefix). Returns an empty object when the config or
// the named section doesn't exist. Cheap: existsSync + read + plain-string
// scan. No INI library dependency.
export function parseAwsProfile(profileName: string): Record<string, string> {
  const configPath = join(awsConfigDir(), "config");
  if (!existsSync(configPath)) return {};
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  const targetHeader = profileName === "default" ? "[default]" : `[profile ${profileName}]`;
  const lines = text.split(/\r?\n/);
  const out: Record<string, string> = {};
  let inTarget = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTarget = line === targetHeader;
      continue;
    }
    if (!inTarget) continue;
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

// True when the *active* profile has SSO configured (either the AWS v2 form
// sso_session or the legacy sso_start_url). The active profile is $AWS_PROFILE
// when set, otherwise [default]. Reused by detectCredsMode for the auto-detect
// path. Pass an explicit profile name to override.
export function hasAwsSsoConfigured(profileName?: string): boolean {
  const name = profileName ?? resolveAwsProfile();
  const p = parseAwsProfile(name);
  return Boolean(p["sso_session"] || p["sso_start_url"]);
}

// True when *any* named profile in ~/.aws/config has SSO configured. Used by
// the oauth popover to hint that bedrock is available on this host even though
// auto-detect picked oauth (e.g. the user has [profile adx-dev] but no
// AWS_PROFILE in env). Cheap: one fs read.
export function hasAnyAwsSsoProfile(): boolean {
  const configPath = join(awsConfigDir(), "config");
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  let inAnyProfile = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      // Match either [default] or [profile X]. Skip [sso-session X] — those
      // declare reusable sessions, not profiles you'd auth as.
      inAnyProfile = line === "[default]" || line.startsWith("[profile ");
      continue;
    }
    if (!inAnyProfile) continue;
    if (/^sso_session\s*=/.test(line)) return true;
    if (/^sso_start_url\s*=/.test(line)) return true;
  }
  return false;
}

export function oauthVolumeName(): string {
  return process.env.FORGE_OAUTH_VOLUME ?? OAUTH_VOLUME_NAME;
}

// Path to the host AWS dir that bedrock-mode containers mount RO.
export function awsConfigDir(): string {
  return process.env.FORGE_AWS_DIR ?? join(homedir(), ".aws");
}

export function ensureCreds(): void {
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    const dir = awsConfigDir();
    if (!existsSync(dir)) {
      throw new Error(
        `Bedrock mode expects ${dir} to exist (mounted into agent containers RO). Run \`aws configure sso\` first, or set FORGE_AWS_DIR to point at your AWS config dir.`
      );
    }
    const refresh = process.env.FORGE_CREDS_REFRESH;
    if (refresh) {
      try {
        execFileSync(refresh, [], { stdio: "ignore" });
      } catch (err) {
        throw new Error(`FORGE_CREDS_REFRESH failed: ${(err as Error).message}`);
      }
    }
    return;
  }

  if (mode === "anthropic-apikey") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("anthropic-apikey mode requires ANTHROPIC_API_KEY in the environment.");
    }
    return;
  }

  // anthropic-oauth: ensure the named docker volume exists and contains a credentials file.
  // The volume is created+populated by `forge auth login` (TODO); this check just gives a
  // useful error if the user runs `forge next` before logging in.
  const volume = oauthVolumeName();
  let credsPresent = false;
  try {
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/home/agent/.claude`,
        "agent-dev-worker",
        "test",
        "-s",
        "/home/agent/.claude/.credentials.json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    credsPresent = true;
    void out;
  } catch {
    credsPresent = false;
  }
  if (!credsPresent) {
    throw new Error(
      `No Claude OAuth credentials found in docker volume '${volume}'.
Run \`forge auth login\` once (or set CLAUDE_CODE_USE_BEDROCK=1 + AWS creds for Bedrock mode,
or set ANTHROPIC_API_KEY for API-key mode).`
    );
  }
}

// Auth-error prefix used by validateCredsForNewRun(). The CLI's top-level
// handler prints the error verbatim; the dashboard's POST handler sniffs for
// this prefix in stderr to route an "auth problem, here's what to fix" toast
// instead of a generic 500. Exposed as a constant so dashboard + CLI agree on
// the string without a separate IPC contract.
export const AUTH_ERROR_PREFIX = "Auth error: ";

// Pre-flight check at run-creation time (#79 part 2). Catches the failure mode
// where bedrock mode is active but the SSO cache is empty/expired — without
// this, the run is created, dispatch starts, and the first container fails
// ~30 seconds in with a 403 from inside Docker.
//
// Throws an Error prefixed with AUTH_ERROR_PREFIX on failure. Caller is
// expected to print and exit 1 (CLI) or convert to a structured 400 (dashboard).
export function validateCredsForNewRun(): void {
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    const cacheDir = join(awsConfigDir(), "sso", "cache");
    if (!existsSync(cacheDir)) {
      throw new Error(
        `${AUTH_ERROR_PREFIX}Bedrock mode active but no SSO cache found at ${cacheDir}. Run \`aws sso login --profile ${resolveAwsProfile()}\` and try again.`
      );
    }
    if (!hasFreshSsoCache(cacheDir)) {
      throw new Error(
        `${AUTH_ERROR_PREFIX}Bedrock mode active but the AWS SSO token is expired (or no session cache exists yet). Run \`aws sso login --profile ${resolveAwsProfile()}\` and try again.`
      );
    }
    return;
  }
  if (mode === "anthropic-apikey") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        `${AUTH_ERROR_PREFIX}anthropic-apikey mode requires ANTHROPIC_API_KEY in the environment.`
      );
    }
    return;
  }
  // oauth: defer to ensureCreds at spawn time. The docker-volume probe is
  // expensive (spins up a container) and not worth running per `forge new`;
  // the failure mode here is the user not having run `forge auth login`,
  // which still surfaces clearly at the first task dispatch.
}

// Snapshot of the dashboard's auth state for the indicator (#97). Pure
// inspection — no throws, no network, no docker. Returns enough for the UI
// to render the inline pill + the click-to-open popover.
//
// Per mode, what's populated:
//   bedrock — full detail (profile, account, role, region, ssoPortal,
//             expiresAt, watchdog). All from ~/.aws on the host; cheap.
//   oauth   — volumeName only. We don't probe the volume here (a docker
//             run takes 1-2s and the popover should open instantly).
//   apikey  — nothing beyond mode + health. We deliberately don't show key
//             prefix/suffix; it leaks credentials into screenshots without
//             earning much.
export type AuthState = {
  mode: CredsMode;
  // 'ok' = ready to use. 'expired' = bedrock SSO token has expired (or never
  // logged in). 'missing' = mode requires something that isn't there
  // (e.g. ANTHROPIC_API_KEY missing in apikey mode — though detectCredsMode
  // won't return apikey if the var is absent, so this branch is theoretical
  // for now and reserved for #106's future provider checks).
  health: "ok" | "expired" | "missing";
  // Short identity string for the inline pill ("sgws-poc" for bedrock profile,
  // etc.). Empty string when no identity metadata is available (oauth/apikey).
  identity: string;
  // Action the user should take when health !== 'ok'. Empty when ok.
  remediation: string;
  // Detail surface for the click-to-open popover. Bedrock fields are populated
  // from ~/.aws/config + the SSO cache + the watchdog PID file; oauth fields
  // are mostly the volume name; apikey is empty.
  detail: AuthDetail;
};

export type AuthDetail = {
  // bedrock-only
  profile?: string;        // AWS profile (e.g. "adx-dev")
  accountId?: string;      // sso_account_id from ~/.aws/config
  roleName?: string;       // sso_role_name from ~/.aws/config
  region?: string;         // resolveAwsRegion()
  ssoPortal?: string;      // host part of session cache's startUrl
  expiresAt?: string;      // ISO timestamp from the session cache
  watchdogRunning?: boolean;
  // oauth-only
  oauthVolume?: string;
  // Hint surface (#97 follow-up). True when mode resolved to oauth but the
  // host actually has AWS SSO configured for some profile — the dashboard
  // user might have wanted bedrock and forgotten to arm it.
  awsAvailable?: boolean;
};

export function getAuthState(): AuthState {
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    const profile = resolveAwsProfile();
    const region = resolveAwsRegion();
    const cacheDir = join(awsConfigDir(), "sso", "cache");
    const profileConfig = parseAwsProfile(profile);
    const session = existsSync(cacheDir) ? readFreshSsoSession(cacheDir) : null;
    const detail: AuthDetail = {
      profile,
      region,
      watchdogRunning: isWatchdogRunningSafe(),
    };
    if (profileConfig["sso_account_id"]) detail.accountId = profileConfig["sso_account_id"];
    if (profileConfig["sso_role_name"]) detail.roleName = profileConfig["sso_role_name"];
    if (session) {
      detail.expiresAt = session.expiresAt;
      detail.ssoPortal = extractHost(session.startUrl);
    }
    if (!session) {
      return {
        mode,
        health: "expired",
        identity: profile,
        remediation: `aws sso login --profile ${profile}`,
        detail,
      };
    }
    return { mode, health: "ok", identity: profile, remediation: "", detail };
  }
  if (mode === "anthropic-apikey") {
    return { mode, health: "ok", identity: "", remediation: "", detail: {} };
  }
  // oauth: report 'ok' here. The docker-volume probe is too expensive to run
  // on every dashboard load — if it's actually missing, run-creation surfaces
  // a clear error. The indicator stays optimistic for oauth.
  return {
    mode,
    health: "ok",
    identity: "",
    remediation: "",
    detail: {
      oauthVolume: oauthVolumeName(),
      awsAvailable: hasAnyAwsSsoProfile(),
    },
  };
}

// Wrap isWatchdogRunning() in a try/catch so getAuthState can't throw from a
// PID-file-read error (very unlikely but the indicator path must be robust).
function isWatchdogRunningSafe(): boolean {
  try {
    return isWatchdogRunning();
  } catch {
    return false;
  }
}

// Pull the host out of a URL string. Falls back to the raw value if URL parsing
// fails — better to show something weird than nothing.
function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Snapshot of an SSO session cache file: just the user-relevant fields. Used
// to drive the indicator's expiry countdown + portal hostname.
export type SsoSessionSnapshot = {
  startUrl: string;
  expiresAt: string; // ISO timestamp
};

// Find the freshest *session* cache file in ~/.aws/sso/cache/ — i.e., one
// with top-level startUrl + accessToken + a non-expired expiresAt. Client-
// registration files (year-long expiry, no startUrl/accessToken) are skipped.
// Returns null when no fresh session exists.
export function readFreshSsoSession(cacheDir: string): SsoSessionSnapshot | null {
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return null;
  }
  const now = Date.now();
  let bestExpiry = -Infinity;
  let best: SsoSessionSnapshot | null = null;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let parsed: { expiresAt?: string; startUrl?: string; accessToken?: string };
    try {
      parsed = JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.startUrl || !parsed.accessToken || !parsed.expiresAt) continue;
    const expiry = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) continue;
    // Multiple fresh sessions can exist if the user has switched profiles
    // recently. Pick the one with the latest expiry — it's the most recently
    // refreshed.
    if (expiry > bestExpiry) {
      bestExpiry = expiry;
      best = { startUrl: parsed.startUrl, expiresAt: parsed.expiresAt };
    }
  }
  return best;
}

// Boolean wrapper kept for back-compat with existing call sites.
export function hasFreshSsoCache(cacheDir: string): boolean {
  return readFreshSsoSession(cacheDir) !== null;
}
