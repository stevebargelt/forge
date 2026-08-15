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
import { detectCredsMode } from "../util/creds.js";
import type { CostTier, OnUnavailable } from "./schema.js";
import type { SeedGeneration } from "./seed-generation.js";

// Effective auth is the AuthMode enum minus "auto" — "auto" is an INPUT that
// resolves to one of these, and only the resolved value is ever recorded.
export type EffectiveAuth = "subscription" | "api" | "bedrock";

// FG-560: two INDEPENDENT provenance axes, distinct from `resolvedBy` (which
// records how the PROFILE was selected).
//
//   capabilitySource — where the capability alias came from:
//     "explicit"     the workflow step's `activity:` (stepAlias) demanded it
//     "role-derived" it fell out of defaultActivityForRole (no explicit intent)
//
//   mappingPath — how the concrete model was read out of the chosen profile:
//     "exact"            profile.map[capability] hit directly
//     "default-fallback" capability absent → fell through to profile.map["default"]
//
// The two combine into the `activity_unmapped` fail-closed refusal: an EXPLICIT
// activity that only resolves via map.default was demanded but not honored, so a
// silent default is worse than a loud stop. A ROLE-DERIVED default-fallback is
// legacy-equivalent and stays valid. Default-only profiles (a map with just
// "default", e.g. pi-groq) are intentional catch-alls and are NEVER flagged.
export type CapabilitySource = "explicit" | "role-derived";
export type MappingPath = "exact" | "default-fallback";
export type ResolutionOutcome = "resolved" | "activity_unmapped";

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
  /** Effective on_unavailable (profile override ?? policy default). "fail" in
   *  legacy mode (irrelevant — no dispatch availability gate runs in legacy). */
  onUnavailable: OnUnavailable;
  /** Whether the resolved model supports tool calls. Undefined = unset in policy
   *  (defaults at dispatch time: non-pi runtimes default true, pi defaults false). */
  toolCapable?: boolean;
  /** FG-560 axis 1 — where the capability alias came from. undefined in legacy mode. */
  capabilitySource?: CapabilitySource;
  /** FG-560 axis 2 — how the concrete model was read from the profile map.
   *  undefined in legacy mode. */
  mappingPath?: MappingPath;
  /** FG-560 — resolution outcome. "resolved" for every honored resolution;
   *  "activity_unmapped" when an EXPLICIT activity fell to map.default on a
   *  non-default-only profile (a fail-closed refusal that is inspectable WITHOUT
   *  throwing, so the dispatch preflight and `forge model resolve --json` read the
   *  same fact). undefined in legacy mode. */
  outcome?: ResolutionOutcome;
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
  // FG-639: the evidence-led lifecycle's Stage 8 role. Review work, so it resolves the
  // same activity as the discipline reds rather than falling through to "default".
  "review-rechecker": "review",
  "architecture-advisor": "reasoning",
  "tech-lead": "reasoning",
  "prompt-author": "design",
  designer: "design",
};

function defaultActivityForRole(role: string): string {
  return DEFAULT_ACTIVITY_BY_ROLE[role] ?? "default";
}

// (provider, effective auth) -> runtime YAML name. THE Crawl seam. Walk adds the
// openai/subscription row (Codex via ChatGPT subscription); openai/api
// (codex-apikey) is the deferred second auth mode.
const RUNTIME_BINDING: Record<string, Partial<Record<EffectiveAuth, string>>> = {
  anthropic: {
    subscription: "claude-oauth",
    api: "claude-apikey",
    bedrock: "claude-bedrock",
  },
  openai: {
    subscription: "codex-subscription",
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

// Effective auth detection for `auth: auto`. Delegates to the authoritative
// detectCredsMode() (FORGE-DEC-007/013) so the recorded auth matches what forge
// actually runs — same precedence as runtime selection (CLAUDE_CODE_USE_BEDROCK,
// then ANTHROPIC_API_KEY, AWS_PROFILE, ~/.aws SSO config, else oauth). Mapping
// the CredsMode enum onto the profile auth vocabulary.
export function detectAuthMode(): EffectiveAuth {
  const mode = detectCredsMode();
  if (mode === "bedrock") return "bedrock";
  if (mode === "anthropic-apikey") return "api";
  return "subscription";
}

export type ResolveOpts = {
  /** Agent role being dispatched (e.g. "engineer", "red-security"). */
  agentRole: string;
  /** Workflow step `model:` alias — the explicit capability intent, if any. */
  stepAlias?: string | undefined;
  /** CLI `--profile` override (highest profile-selection precedence). */
  cliProfile?: string | undefined;
  /** Provenance label recorded as `resolvedBy` when `cliProfile` wins. Defaults
   *  to "cli.--profile" (a single `forge invoke --profile`). `forge new --profile`
   *  passes "run.profile" so `forge show` distinguishes a whole-run operator pin
   *  from a per-agent flag. Ignored unless `cliProfile` is set. */
  profileSource?: string | undefined;
  /** The step's `runtime:` field — used only in legacy mode. Default "claude". */
  runtimeName?: string | undefined;
  ctx?: LoadContext;
  /** FG-583: the held seed generation this dispatch is anchored to. Threaded into
   *  the load context so task-create-time model stamping resolves the runtime (and
   *  any generation-coupled load) from the SAME complete generation the dispatching
   *  invocation will consume — never a live re-resolve that could read a newer one.
   *  `undefined` → whatever `ctx.seedGeneration` carries (ordinary live resolution);
   *  an explicit value (incl. `null`) pins it. */
  seedGeneration?: SeedGeneration | null;
};

export function resolveModel(opts: ResolveOpts): ModelResolution {
  const ctx: LoadContext =
    opts.seedGeneration !== undefined
      ? { ...(opts.ctx ?? {}), seedGeneration: opts.seedGeneration }
      : (opts.ctx ?? {});
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
      onUnavailable: "fail",
    };
  }

  // ---- Policy mode ----
  // Pass 1 — capability (task intent). Axis 1: an explicit step `activity:`
  // (stepAlias) is the operator's demand; anything else is role-derived.
  const capabilitySource: CapabilitySource = opts.stepAlias ? "explicit" : "role-derived";
  const capability = opts.stepAlias ?? defaultActivityForRole(opts.agentRole);

  // Pass 2 — profile (who runs it). Highest wins.
  let profileName: string;
  let resolvedBy: string;
  const agentOverride = policy.overrides.agents[opts.agentRole];
  const activityDefault = policy.defaults.activity[capability];
  if (opts.cliProfile) {
    profileName = opts.cliProfile;
    resolvedBy = opts.profileSource ?? "cli.--profile";
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

  // Concrete model: capability mapping, with "default" as the within-profile
  // fallback. Axis 2: an exact map hit vs a fall-through to map.default.
  const exactEntry = profile.map[capability];
  const entry = exactEntry ?? profile.map["default"];
  if (!entry) {
    // Hard fail-loud stays a throw: no exact mapping AND no default to fall to,
    // so there is nothing to run at all (unchanged pre-FG-560 behavior).
    throw new Error(
      `profile '${profileName}' has no mapping for capability '${capability}' ` +
        `and no 'default' (mapped: ${Object.keys(profile.map).join(", ")})`
    );
  }
  const mappingPath: MappingPath = exactEntry ? "exact" : "default-fallback";

  // A default-only profile (map is just "default") is an intentional catch-all —
  // every activity resolves via the default there, so it is NEVER a refusal.
  const mapKeys = Object.keys(profile.map);
  const isDefaultOnly = mapKeys.length === 1 && mapKeys[0] === "default";

  // FG-560 fail-closed refusal, as an OUTCOME not a throw: an EXPLICIT activity
  // that only resolves via map.default on a profile that DOES map named
  // activities. Role-derived default-fallback and default-only profiles stay
  // "resolved". The fields below still describe the would-be resolution so the
  // outcome is inspectable (forge model resolve --json / the dispatch gate).
  const outcome: ResolutionOutcome =
    capabilitySource === "explicit" && mappingPath === "default-fallback" && !isDefaultOnly
      ? "activity_unmapped"
      : "resolved";

  // #265: an explicit profile.runtime wins (a pi runtime fronts many upstream
  // providers, so the (provider, auth) binding table can't select it). provider
  // then denotes the UPSTREAM vendor passed through as ${UPSTREAM_PROVIDER}.
  // Absent → today's (provider, effective auth) binding, unchanged. An unknown
  // runtime name fails loud downstream at loadRuntime (dispatch time).
  const runtime = profile.runtime ?? bindRuntime(profile.provider, auth);

  return {
    alias: capability,
    model: entry.model,
    profile: profileName,
    provider: profile.provider,
    auth,
    costTier: entry.cost_tier,
    resolvedBy,
    runtime,
    onUnavailable: profile.on_unavailable ?? policy.on_unavailable,
    toolCapable: entry.tool_capable,
    capabilitySource,
    mappingPath,
    outcome,
  };
}

// FG-560 — the stable machine-readable reason code carried on refusals, so the
// dispatch preflight (step 4) and `forge model resolve --json` (step 9) name the
// same thing. Kept as a const, not an inline literal, so a rename is one edit.
export const ACTIVITY_UNMAPPED_REASON = "activity_unmapped";

/** True when a resolution is the fail-closed refusal (explicit activity that only
 *  resolved via map.default on a profile that maps named activities). Inspectable
 *  without throwing — the caller decides whether to block dispatch or render it. */
export function isActivityUnmapped(res: ModelResolution): boolean {
  return res.outcome === "activity_unmapped";
}

/** A readable, deterministic explanation of an activity_unmapped refusal for
 *  human + --json surfaces. Safe to call on any resolution; returns undefined
 *  when there is nothing to refuse. */
export function activityUnmappedMessage(res: ModelResolution): string | undefined {
  if (!isActivityUnmapped(res)) return undefined;
  return (
    `${ACTIVITY_UNMAPPED_REASON}: explicit activity '${res.alias}' is not mapped in ` +
    `profile '${res.profile}'; it would fall through to map.default ('${res.model}'). ` +
    `Add a '${res.alias}' entry to the profile map, or drop the explicit activity to ` +
    `accept the profile default.`
  );
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
  /** FG-560 axis 1 — where the capability alias came from ("explicit" |
   *  "role-derived"). Omitted in legacy mode (no policy => no provenance). */
  resolvedCapabilitySource?: string;
  /** FG-560 axis 2 — how the concrete model was read from the profile map
   *  ("exact" | "default-fallback"). Omitted in legacy mode. */
  resolvedMappingPath?: string;
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
    // FG-560: mapping-path provenance is a SEPARATE axis from profile-selection
    // provenance (resolvedBy) — carried alongside it, never standing in for it.
    resolvedCapabilitySource: res.capabilitySource,
    resolvedMappingPath: res.mappingPath,
  };
}

// The manifest `model` block a resolution implies — written only in policy mode.
// Returns undefined in legacy mode (resolvedBy="legacy") so the manifest simply
// omits the block, matching pre-AWN-7 manifests.
export function manifestModelBlock(res: ModelResolution):
  | { alias: string; model: string; profile: string; provider: string; auth: string; costTier: string; resolvedBy: string; runtime: string; capabilitySource: string; mappingPath: string }
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
    // FG-560: both provenance axes travel in the manifest model block too, so
    // "which mapping path resolved this model" is answerable from the durable
    // dispatch manifest, not only the task row.
    capabilitySource: res.capabilitySource ?? "",
    mappingPath: res.mappingPath ?? "",
  };
}
