// forge v2 — model resolution (AWN-7 Crawl, FORGE-DEC provider-resolution).
//
// Two-pass resolver. Capability (task intent) and profile (who runs it) are
// resolved INDEPENDENTLY, then the concrete model is read out of the profile:
//
//   Pass 1 — capability:  step `model:` alias  ?? agent default activity ?? "default"
//   Pass 2 — profile:     --profile ?? overrides.agents[role]
//                                   ?? defaults.activity[capability]
//                                   ?? defaults.profile
//   concrete model    = profile.map[capability].model   (fail loud if unmapped)
//   effective auth    = profile.auth === "auto" ? env-detected : profile.auth
//   runtime (execute) = (provider, effective auth) -> runtime YAML name
//
// Policy is OPT-IN. With no model-policy.yml at the project or workspace path,
// this falls back to legacy resolveModelForTask (runtime.models[alias]) and the
// returned record carries resolvedBy="legacy" with the policy fields undefined —
// behavior is byte-identical to pre-AWN-7.
//
// Policy loading is FILE-LEVEL REPLACEMENT (not key-by-key merge): a project's
// .forge/model-policy.yml, if present, is the entire project policy; else the
// workspace ~/.forge/model-policy.yml; else legacy resolution. This matches
// forge's existing "project file wins" override pattern. Key-level merge can be
// added later behind loadModelPolicy if ergonomics demand it.
//
// Future note (Run stage, not Crawl): when bounded orchestrator choice lands, a
// global/admin allowed_profiles may become a CEILING over project policy so a
// project can't silently expand orchestrator autonomy. Off by default today.

import { loadModelPolicy, resolveModelForTask, type LoadContext } from "./loader.js";
import type { CostTier } from "./schema.js";

// Effective auth is the AuthMode enum minus "auto" — "auto" is an INPUT that
// resolves to one of these, and only the resolved value is ever recorded.
export type EffectiveAuth = "subscription" | "api" | "bedrock";

export type ModelResolution = {
  /** Capability alias from pass 1 (e.g. "review"). undefined in legacy mode. */
  alias: string | undefined;
  /** Concrete model id handed to the runtime as ${MODEL}. */
  model: string;
  /** Named profile chosen in pass 2. undefined in legacy mode. */
  profile: string | undefined;
  /** Provider that runs it (e.g. "anthropic"). undefined in legacy mode. */
  provider: string | undefined;
  /** EFFECTIVE auth mode — never "auto". undefined in legacy mode. */
  auth: EffectiveAuth | undefined;
  /** Cost tier of the resolved (profile, model). undefined in legacy mode. */
  costTier: CostTier | undefined;
  /** Which rule selected the profile — drives `forge show` / `forge model resolve`. */
  resolvedBy: string;
  /** Runtime YAML to execute with: bound from (provider, auth) in policy mode,
   *  or the step's runtime name in legacy mode. */
  runtime: string;
};

// Pass-1 fallback: agent role -> default capability activity. Small + local for
// Crawl per the ADR. Promote to seed frontmatter only if this grows or becomes
// project-specific. Unlisted roles fall back to "default".
const DEFAULT_ACTIVITY_BY_ROLE: Record<string, string> = {
  "red-wide": "review",
  "red-narrow": "review",
  "red-frontend": "review",
  "red-backend": "review",
  "red-security": "review",
  "architecture-advisor": "reasoning",
  "tech-lead": "reasoning",
  "prompt-author": "design",
  designer: "design",
};

function defaultActivityForRole(role: string): string {
  return DEFAULT_ACTIVITY_BY_ROLE[role] ?? "default";
}

// (provider, effective auth) -> runtime YAML name. THE Crawl seam. Codex (Walk)
// adds rows: openai -> { api: "codex-apikey", subscription: "codex-subscription" }.
const RUNTIME_BINDING: Record<string, Partial<Record<EffectiveAuth, string>>> = {
  anthropic: {
    subscription: "claude-oauth",
    api: "claude-apikey",
    bedrock: "claude-bedrock",
  },
};

function bindRuntime(provider: string, auth: EffectiveAuth): string {
  const runtime = RUNTIME_BINDING[provider]?.[auth];
  if (!runtime) {
    const known = Object.entries(RUNTIME_BINDING)
      .flatMap(([p, m]) => Object.keys(m).map((a) => `${p}/${a}`))
      .join(", ");
    throw new Error(
      `no runtime bound for provider='${provider}' auth='${auth}' (known: ${known})`
    );
  }
  return runtime;
}

// Effective auth detection — mirrors loader's detectRuntimeName() / v1
// detectCredsMode(), but yields the auth MODE rather than a runtime name. Used
// only when a profile declares auth: auto.
export function detectAuthMode(): EffectiveAuth {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return "subscription";
}

export type ResolveOpts = {
  /** Agent role being dispatched (e.g. "engineer", "red-security"). */
  agentRole: string;
  /** Workflow step `model:` alias — the explicit capability intent, if any. */
  stepAlias?: string | undefined;
  /** CLI `--profile` override (highest profile-selection precedence). */
  cliProfile?: string | undefined;
  /** The step's `runtime:` field — used only in legacy mode. Default "claude". */
  runtimeName?: string | undefined;
  ctx?: LoadContext;
};

export function resolveModel(opts: ResolveOpts): ModelResolution {
  const ctx = opts.ctx ?? {};
  const policy = loadModelPolicy(ctx);

  // ---- Legacy mode: no policy file → today's behavior, unchanged. ----
  if (!policy) {
    const runtimeName = opts.runtimeName ?? "claude";
    const model = resolveModelForTask(runtimeName, opts.stepAlias, ctx);
    return {
      alias: undefined,
      model: model ?? "",
      profile: undefined,
      provider: undefined,
      auth: undefined,
      costTier: undefined,
      resolvedBy: "legacy",
      runtime: runtimeName,
    };
  }

  // ---- Policy mode ----
  // Pass 1 — capability (task intent).
  const capability = opts.stepAlias ?? defaultActivityForRole(opts.agentRole);

  // Pass 2 — profile (who runs it). Highest wins.
  let profileName: string;
  let resolvedBy: string;
  const agentOverride = policy.overrides.agents[opts.agentRole];
  const activityDefault = policy.defaults.activity[capability];
  if (opts.cliProfile) {
    profileName = opts.cliProfile;
    resolvedBy = "cli.--profile";
  } else if (agentOverride) {
    profileName = agentOverride;
    resolvedBy = `overrides.agents.${opts.agentRole}`;
  } else if (activityDefault) {
    profileName = activityDefault;
    resolvedBy = `defaults.activity.${capability}`;
  } else {
    profileName = policy.defaults.profile;
    resolvedBy = "defaults.profile";
  }

  const profile = policy.model_profiles[profileName];
  if (!profile) {
    // Only reachable via --profile: every other selection path references a
    // profile the schema's cross-ref validation already proved exists.
    throw new Error(
      `--profile '${profileName}' is not defined in model-policy ` +
        `(defined: ${Object.keys(policy.model_profiles).join(", ") || "none"})`
    );
  }

  // Effective auth — resolve "auto" to a concrete mode; record only the concrete.
  const auth: EffectiveAuth = profile.auth === "auto" ? detectAuthMode() : profile.auth;

  // Concrete model: capability mapping, with "default" as the within-profile fallback.
  const entry = profile.map[capability] ?? profile.map["default"];
  if (!entry) {
    throw new Error(
      `profile '${profileName}' has no mapping for capability '${capability}' ` +
        `and no 'default' (mapped: ${Object.keys(profile.map).join(", ")})`
    );
  }

  const runtime = bindRuntime(profile.provider, auth);

  return {
    alias: capability,
    model: entry.model,
    profile: profileName,
    provider: profile.provider,
    auth,
    costTier: entry.cost_tier,
    resolvedBy,
    runtime,
  };
}

// The task-row fields a resolution implies. Use at every task-creation site so
// the row, runtime selection, and manifest agree. In legacy mode the resolved_*
// fields stay undefined and agentAlias falls back to the workflow-declared alias
// (preserving pre-AWN-7 agent_alias behavior for usage rollups).
export type TaskModelFields = {
  agentAlias: string | undefined;
  agentModel: string;
  resolvedProfile?: string;
  resolvedProvider?: string;
  resolvedAuth?: string;
  resolvedBy?: string;
};

export function taskModelFields(
  res: ModelResolution,
  workflowAlias: string | undefined
): TaskModelFields {
  const agentAlias = res.alias ?? workflowAlias;
  if (res.resolvedBy === "legacy") {
    return { agentAlias, agentModel: res.model };
  }
  return {
    agentAlias,
    agentModel: res.model,
    resolvedProfile: res.profile,
    resolvedProvider: res.provider,
    resolvedAuth: res.auth,
    resolvedBy: res.resolvedBy,
  };
}

// The manifest `model` block a resolution implies — written only in policy mode.
// Returns undefined in legacy mode (resolvedBy="legacy") so the manifest simply
// omits the block, matching pre-AWN-7 manifests.
export function manifestModelBlock(res: ModelResolution):
  | { alias: string; model: string; profile: string; provider: string; auth: string; costTier: string; resolvedBy: string; runtime: string }
  | undefined {
  if (res.resolvedBy === "legacy") return undefined;
  return {
    alias: res.alias ?? "",
    model: res.model,
    profile: res.profile ?? "",
    provider: res.provider ?? "",
    auth: res.auth ?? "",
    costTier: res.costTier ?? "",
    resolvedBy: res.resolvedBy,
    runtime: res.runtime,
  };
}
