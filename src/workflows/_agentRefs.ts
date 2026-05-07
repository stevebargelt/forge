import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRef } from "../types/index.js";

const AGENTS_DIR = process.env.FORGE_HOME
  ? join(process.env.FORGE_HOME, "agents")
  : join(homedir(), ".forge", "agents");

// Logical alias → concrete model. Resolution order (per spawn-time call):
//   1. FORGE_USE_LITELLM=1 → pass alias through; LiteLLM resolves it.
//   2. FORGE_MODEL_<ALIAS> env var → user override.
//   3. CLAUDE_CODE_USE_BEDROCK=1 → Bedrock-style id from BEDROCK_MAP.
//   4. Default Anthropic-direct id from DIRECT_MAP.
//   5. If no map entry, return the alias verbatim (claude will validate).
const DIRECT_MAP: Record<string, string> = {
  "fast-orchestrator": "claude-haiku-4-5",
  "spec-writer": "claude-sonnet-4-6",
  "deep-thinker": "claude-opus-4-7",
};
// Claude 4.x on Bedrock requires cross-region inference profile IDs (prefixed with the
// region group, e.g. `us.`). Plain on-demand model IDs return 400. Override with
// FORGE_MODEL_<ALIAS> if your account uses a different region group (eu., apac., etc.)
// or a custom inference profile ARN.
const BEDROCK_MAP: Record<string, string> = {
  "fast-orchestrator": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "spec-writer": "us.anthropic.claude-sonnet-4-6",
  "deep-thinker": "us.anthropic.claude-opus-4-7",
};

function resolveModel(alias: string): string {
  if (process.env.FORGE_USE_LITELLM === "1") return alias;
  const envOverride = process.env[`FORGE_MODEL_${alias.replace(/-/g, "_").toUpperCase()}`];
  if (envOverride) return envOverride;
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return BEDROCK_MAP[alias] ?? alias;
  }
  return DIRECT_MAP[alias] ?? alias;
}

export function agent(role: string, model: string, image?: string): AgentRef {
  return { role, agentDir: join(AGENTS_DIR, role), model: resolveModel(model), image };
}
