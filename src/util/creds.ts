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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CredsMode = "bedrock" | "anthropic-oauth" | "anthropic-apikey";

const OAUTH_VOLUME_NAME = "forge-claude-oauth";

// Auto-detection precedence (#79):
//   1. CLAUDE_CODE_USE_BEDROCK=1  → force bedrock
//   2. CLAUDE_CODE_USE_BEDROCK=0  → force OFF bedrock, fall through to (3)/(4)/(5)
//   3. ANTHROPIC_API_KEY set      → apikey
//   4. ~/.aws/config has an SSO-backed default profile → auto-detect bedrock
//   5. Fallback → oauth
//
// The auto-detect path means a host with AWS configured doesn't need to source
// use-bedrock.sh — the dashboard process inherits its env from whatever launched
// it, so previously, forgetting to source the script silently broke every run.
// The hard-off (CLAUDE_CODE_USE_BEDROCK=0) lets a user with AWS configured still
// force oauth/apikey for a session without unsetting AWS env vars.
export function detectCredsMode(): CredsMode {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  const hardOff = process.env.CLAUDE_CODE_USE_BEDROCK === "0";
  if (!hardOff) {
    // Auto-detect bedrock from AWS config before falling back to oauth/apikey.
    // ANTHROPIC_API_KEY still wins over AWS config when both are present, on the
    // theory that an explicit API key in env is more deliberate than a leftover
    // ~/.aws/config from someone's workplace.
    if (process.env.ANTHROPIC_API_KEY) return "anthropic-apikey";
    if (hasAwsSsoConfigured()) return "bedrock";
    return "anthropic-oauth";
  }
  // Hard-off bedrock: fall to apikey if set, else oauth.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic-apikey";
  return "anthropic-oauth";
}

// Returns the AWS profile to use for bedrock mode. Honors AWS_PROFILE when set;
// otherwise falls back to "default" — which is what auto-detected bedrock implies,
// since the auto-detect only triggers when the default profile has sso_session.
export function resolveAwsProfile(): string {
  return process.env.AWS_PROFILE ?? "default";
}

// Returns the AWS region to use for bedrock mode. Honors AWS_REGION when set;
// otherwise falls back to us-east-1 (matches use-bedrock.sh's default).
export function resolveAwsRegion(): string {
  return process.env.AWS_REGION ?? "us-east-1";
}

// Scan ~/.aws/config for an SSO-backed default profile. Returns true if found.
// Cheap: existsSync + read + plain-string scan. No INI library dependency.
// We look specifically at the [default] profile because that's what the auto-
// detect path will use via resolveAwsProfile() — finding sso_session in some
// other profile doesn't help if AWS_PROFILE isn't pointing at it.
export function hasAwsSsoConfigured(): boolean {
  const configPath = join(awsConfigDir(), "config");
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  // Find the [default] section (AWS config uses [default] for the default
  // profile, [profile name] for named profiles). Scan forward until the next
  // [ section header or EOF, and check whether sso_session = ... appears in
  // that block.
  const lines = text.split(/\r?\n/);
  let inDefault = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDefault = line === "[default]";
      continue;
    }
    if (!inDefault) continue;
    // Allow whitespace around the = sign, accept either sso_session or sso_start_url
    // as evidence of SSO configuration. sso_session is the AWS v2 form; sso_start_url
    // is the legacy form that's still accepted by the AWS CLI.
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
