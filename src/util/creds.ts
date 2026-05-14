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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWatchdogRunning } from "./sso-watchdog.js";

export type CredsMode = "bedrock" | "anthropic-oauth" | "anthropic-apikey";

// Volume name carries a version suffix so the mount-point migration in #97
// follow-up (was /home/agent/.claude, now /home/agent — captures .claude.json
// for identity) doesn't try to retrofit existing v1 volumes. Anyone with the
// old "forge-claude-oauth" volume just runs `forge auth login` once and the
// new v2 volume gets populated; the old one is orphaned (manual cleanup via
// `docker volume rm forge-claude-oauth`).
const OAUTH_VOLUME_NAME = "forge-claude-oauth-v2";
const LEGACY_OAUTH_VOLUME_NAME = "forge-claude-oauth";

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

export type ExportedAwsCreds = {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
  AWS_CREDENTIAL_EXPIRATION?: string;
};

// #121: derive fresh STS credentials on the host and return them as env vars
// for injection into a child container. Replaces FORGE-DEC-013's "mount
// ~/.aws and let the container's SDK derive" approach because that approach
// fails when the container's AWS SDK can't reproduce the host's credential
// chain (corp TLS proxy, SDK version differences, static-creds shadow). Jeff
// & Terry's pattern, proven in 8+ production projects.
//
// Calls `aws configure export-credentials --profile <p> --format env-no-export`.
// Throws on non-zero exit — that's the "AWS is broken on the host" pre-flight,
// surfaced as a real error before the container spawns. Caller decides
// whether to fall back to mount mode or surface to the user.
export function exportAwsCreds(profile: string): ExportedAwsCreds {
  // Test escape hatch: FORGE_AWS_CREDS_FOR_TEST=KEY=v,SECRET=v,TOKEN=v
  // skips shelling out to aws. Lets unit tests assert the wiring without
  // requiring AWS CLI + a real SSO session.
  const testOverride = process.env.FORGE_AWS_CREDS_FOR_TEST;
  if (testOverride !== undefined) {
    const parsed: Partial<ExportedAwsCreds> = {};
    for (const pair of testOverride.split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k === "AWS_ACCESS_KEY_ID" || k === "AWS_SECRET_ACCESS_KEY" || k === "AWS_SESSION_TOKEN" || k === "AWS_CREDENTIAL_EXPIRATION") {
        parsed[k] = v;
      }
    }
    if (!parsed.AWS_ACCESS_KEY_ID || !parsed.AWS_SECRET_ACCESS_KEY || !parsed.AWS_SESSION_TOKEN) {
      throw new Error("FORGE_AWS_CREDS_FOR_TEST missing one of AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN");
    }
    return parsed as ExportedAwsCreds;
  }
  const out = execFileSync(
    "aws",
    ["configure", "export-credentials", "--profile", profile, "--format", "env-no-export"],
    { encoding: "utf8" }
  );
  const parsed: Partial<ExportedAwsCreds> = {};
  for (const line of out.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    if (k === "AWS_ACCESS_KEY_ID" || k === "AWS_SECRET_ACCESS_KEY" || k === "AWS_SESSION_TOKEN" || k === "AWS_CREDENTIAL_EXPIRATION") {
      parsed[k] = v;
    }
  }
  if (!parsed.AWS_ACCESS_KEY_ID || !parsed.AWS_SECRET_ACCESS_KEY || !parsed.AWS_SESSION_TOKEN) {
    throw new Error(
      `aws configure export-credentials returned incomplete output for profile '${profile}': missing one of AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN`
    );
  }
  return parsed as ExportedAwsCreds;
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

// Surface the legacy volume name so `forge auth status` can warn the user
// when an orphaned v1 volume is still present on the host.
export function legacyOauthVolumeName(): string {
  return LEGACY_OAUTH_VOLUME_NAME;
}

// Path to the host AWS dir that bedrock-mode containers mount RO.
export function awsConfigDir(): string {
  return process.env.FORGE_AWS_DIR ?? join(homedir(), ".aws");
}

// -------- OAuth identity hint (#97 follow-up: oauth detail) --------
//
// Anthropic OAuth credentials live inside the forge-claude-oauth Docker
// volume. The credentials file (.credentials.json) is in there; alongside it,
// claude writes .claude.json containing identity info — email, org name,
// plan tier, login timestamp. Reading either file requires spinning up a
// container with the volume mounted (the host can't see the volume
// contents directly), which costs ~1-2 seconds.
//
// To avoid paying that cost on every dashboard poll, we cache a small
// non-secret subset of .claude.json on the host at ~/.forge/oauth-hint.json
// and refresh only when the cache is stale. The hint is also written
// directly by `forge auth login` (no probe needed there — the volume is
// already mounted in that container).

export type OauthHint = {
  // Identifies the volume the hint was captured from. If the user's
  // FORGE_OAUTH_VOLUME changes (rare), this won't match and the probe
  // will re-run.
  volumeName: string;
  // When the hint was written. Used for stale-cache detection.
  writtenAt: string;
  // True when the volume has a usable .credentials.json. False is meaningful:
  // it means we probed and there's no credential, so the dashboard should
  // surface that instead of optimistic "ready."
  credsPresent: boolean;
  // Identity fields — populated only when credsPresent. From .claude.json's
  // oauthAccount block.
  email?: string;
  organizationName?: string;
  // Plan label that's human-friendly. We surface organizationType ("claude_max")
  // for now; if Anthropic changes the field, this will need adjusting.
  plan?: string;
  // Login or subscription start. From subscriptionCreatedAt; gives "when was
  // I logged in" context for the popover.
  loggedInAt?: string;
};

function oauthHintPath(): string {
  const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(forgeHome, "oauth-hint.json");
}

// Read the cached hint file. Returns null when missing or unparseable; the
// caller's job to decide whether to re-probe.
export function readOauthHint(): OauthHint | null {
  const path = oauthHintPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OauthHint;
    if (parsed.volumeName !== oauthVolumeName()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// True when the cached hint exists, matches the active volume, and is younger
// than the threshold (5 minutes by default). Used by callers that want to
// avoid a docker probe when they can.
export function isOauthHintFresh(maxAgeMs = 5 * 60 * 1000): boolean {
  const hint = readOauthHint();
  if (!hint) return false;
  const age = Date.now() - Date.parse(hint.writtenAt);
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

// Write the hint atomically (write to temp + rename). Caller passes the
// fields it has; volumeName + writtenAt are filled in here.
export function writeOauthHint(fields: Omit<OauthHint, "volumeName" | "writtenAt">): void {
  const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  mkdirSync(forgeHome, { recursive: true });
  const path = oauthHintPath();
  const tmp = path + ".tmp";
  const hint: OauthHint = {
    ...fields,
    volumeName: oauthVolumeName(),
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(tmp, JSON.stringify(hint, null, 2));
  renameSync(tmp, path);
}

// Spin a one-shot container with the OAuth volume mounted and read both
// .credentials.json (presence only) and .claude.json (identity fields) in a
// single sh invocation. Returns null if docker isn't available or the probe
// fails or times out; returns a hint with credsPresent=false when the volume
// exists but the credential file isn't there. The result is also persisted
// to the host cache, so subsequent callers can use readOauthHint() instead.
//
// Bounded by a hard 5-second timeout — on machines where Docker is slow or
// not running, the probe must not block the dashboard's request loop. The
// async wrapper kickProbeOauthVolume() is the preferred API for hot paths.
export function probeOauthVolume(): OauthHint | null {
  const volume = oauthVolumeName();
  let raw: string;
  try {
    // sh script: emit creds-presence flag, then either the .claude.json
    // content or an empty marker. One docker run, two facts.
    // Volume mounts at /home/agent (the user's home dir inside the agent
    // container) — credentials live at $HOME/.claude/.credentials.json,
    // account info at $HOME/.claude.json. Both captured by mounting the
    // parent dir.
    raw = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/x:ro`,
        "alpine",
        "sh",
        "-c",
        // Output format: line 1 = "yes" or "no" for creds presence; lines
        // 2+ = .claude.json content (or empty if missing). Plain text so we
        // don't need a JSON parser inside the container's alpine image.
        '[ -s /x/.claude/.credentials.json ] && echo yes || echo no; [ -f /x/.claude.json ] && cat /x/.claude.json || echo ""',
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 5000, // hard cap so a hung docker daemon can't freeze the dashboard
      }
    );
  } catch {
    // Docker not available, image missing, volume missing, timeout exceeded —
    // all roll up to "we can't tell." Caller decides how to surface this.
    return null;
  }
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx === -1) return null;
  const credsPresent = raw.slice(0, newlineIdx).trim() === "yes";
  const claudeJsonRaw = raw.slice(newlineIdx + 1).trim();
  let identity: Pick<OauthHint, "email" | "organizationName" | "plan" | "loggedInAt"> = {};
  if (claudeJsonRaw) {
    try {
      const parsed = JSON.parse(claudeJsonRaw) as { oauthAccount?: Record<string, unknown> };
      const oa = parsed.oauthAccount;
      if (oa && typeof oa === "object") {
        const get = (k: string): string | undefined => {
          const v = oa[k];
          return typeof v === "string" && v ? v : undefined;
        };
        identity = {
          email: get("emailAddress"),
          organizationName: get("organizationName"),
          plan: get("organizationType"),
          loggedInAt: get("subscriptionCreatedAt"),
        };
      }
    } catch {
      // Malformed .claude.json — ignore identity fields, keep credsPresent.
    }
  }
  const fields = { credsPresent, ...identity };
  try {
    writeOauthHint(fields);
  } catch {
    // Cache write is best-effort; getAuthState falls back to probing next time.
  }
  return {
    ...fields,
    volumeName: volume,
    writtenAt: new Date().toISOString(),
  };
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

  // anthropic-oauth: ensure the named docker volume exists and contains a
  // credentials file. The volume is created+populated by `forge auth login`;
  // this check just gives a useful error if the user runs `forge next`
  // before logging in. Mount point is /home/agent so .claude/.credentials.json
  // (token) and .claude.json (identity) both land in the volume.
  const volume = oauthVolumeName();
  let credsPresent = false;
  try {
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/home/agent`,
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
  // oauth: consult the host-side hint cache. If the cache is fresh and says
  // credsPresent=false, fail at click time rather than wedging a task ~30
  // seconds into the first spawn. If the cache is stale or absent, probe
  // the volume once (1-2s) and use that result. If even the probe can't
  // tell us (docker down), defer to ensureCreds at spawn time — same as
  // before.
  let hint = readOauthHint();
  if (!hint || !isOauthHintFresh()) {
    const probed = probeOauthVolume();
    if (probed) hint = probed;
  }
  if (hint && hint.credsPresent === false) {
    throw new Error(
      `${AUTH_ERROR_PREFIX}OAuth volume '${oauthVolumeName()}' has no credentials. Run \`forge auth login\` and try again.`
    );
  }
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
  // oauth-only — populated from the host-side hint file (oauth-hint.json),
  // which is written by `forge auth login` and refreshed by probeOauthVolume().
  oauthVolume?: string;
  oauthEmail?: string;            // emailAddress from oauthAccount
  oauthOrganization?: string;     // organizationName
  oauthPlan?: string;             // organizationType (e.g. "claude_max")
  oauthLoggedInAt?: string;       // subscriptionCreatedAt
  oauthHintWrittenAt?: string;    // when the hint was last refreshed; "stale"
                                  // pre-login users see this empty
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
  // oauth: read the host-side hint cache. If fresh, use it. Otherwise probe
  // the volume once (1-2s) and write a new hint. The probe failure modes
  // (docker not running, volume missing) leave us with a stale-or-absent
  // hint; we still return a sensible state but mark health=missing.
  let hint = readOauthHint();
  if (!hint || !isOauthHintFresh()) {
    const probed = probeOauthVolume();
    if (probed) hint = probed;
  }
  const detail: AuthDetail = {
    oauthVolume: oauthVolumeName(),
    awsAvailable: hasAnyAwsSsoProfile(),
  };
  if (hint) {
    detail.oauthHintWrittenAt = hint.writtenAt;
    if (hint.email) detail.oauthEmail = hint.email;
    if (hint.organizationName) detail.oauthOrganization = hint.organizationName;
    if (hint.plan) detail.oauthPlan = hint.plan;
    if (hint.loggedInAt) detail.oauthLoggedInAt = hint.loggedInAt;
  }
  if (hint && hint.credsPresent === false) {
    return {
      mode,
      health: "missing",
      identity: hint.email ?? "",
      remediation: "forge auth login",
      detail,
    };
  }
  return {
    mode,
    health: "ok",
    identity: hint?.email ?? "",
    remediation: "",
    detail,
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
