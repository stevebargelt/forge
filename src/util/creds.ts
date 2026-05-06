// Credential resolution and validation. Forge supports three auth modes for agents.
// The mode is chosen by env var; per-spawn validation runs before every docker run.
//
//   bedrock           — CLAUDE_CODE_USE_BEDROCK=1 + AWS_* exported. Work default.
//   anthropic-oauth   — OAuth-based, persisted in a named docker volume. Personal Mac default.
//                       The volume is initialized once via `forge auth login` (TODO).
//   anthropic-apikey  — ANTHROPIC_API_KEY env var. Escape hatch.
//
// The OAuth credential file lives on macOS in the Keychain, not in ~/.claude/.credentials.json,
// so the older host-file-mount pattern (DEC-006 in the vault corpus) does not work on Mac.
// We sidestep this by giving the container its own credential store via a named volume —
// the user logs in once inside a forge auth container, the volume holds the token, and every
// agent run mounts the same volume read-only at /home/agent/.claude.

import { execFileSync } from "node:child_process";

export type CredsMode = "bedrock" | "anthropic-oauth" | "anthropic-apikey";

const OAUTH_VOLUME_NAME = "forge-claude-oauth";

export function detectCredsMode(): CredsMode {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic-apikey";
  return "anthropic-oauth";
}

export function oauthVolumeName(): string {
  return process.env.FORGE_OAUTH_VOLUME ?? OAUTH_VOLUME_NAME;
}

export function ensureCreds(): void {
  const mode = detectCredsMode();
  if (mode === "bedrock") {
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (!process.env[k]) {
        throw new Error(
          `Bedrock mode requires ${k}. Export AWS creds (e.g. \`. ./scripts/use-bedrock.sh\`) or unset CLAUDE_CODE_USE_BEDROCK.`
        );
      }
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
