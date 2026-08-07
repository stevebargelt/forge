// FG-576 — orchestrator LAUNCH resolution and the pre-spawn gates.
//
// This module answers one question: "given the effective model policy and the
// operator's explicit overrides, WHICH interactive adapter launches, with which
// concrete model, provider, auth and project root — or why does Forge refuse?"
//
// It deliberately contains NO spawn path. AC5's "fails before spawn" is therefore
// structural rather than a code path someone has to remember: every refusal below
// is returned from a module that cannot start a process.
//
// Precedence is EXACTLY today's stack, because D3 forbids a parallel parser and D2
// forbids new policy vocabulary. Profile selection is delegated verbatim to the
// shared resolveModel() with agentRole 'orchestrator' and no step alias, so the
// capability is the intentional policy `default`:
//
//   CLI --profile → overrides.agents.orchestrator → defaults.activity.default
//                 → defaults.profile,  then  profile.map.default
//
// What this module ADDS lives at the launch boundary and NOWHERE else, so
// containerized task-agent selection is behaviorally untouched (the ticket's
// non-goals):
//
//   1. allowed_profiles as the autonomy CEILING (the shared resolver still
//      ignores it, exactly as it does today).
//   2. runtime → adapter binding over a CLOSED set: an unsupported runtime
//      (including pi) is refused, naming profile, runtime, reason and remedy.
//   3. An auth-availability probe for the SELECTED provider only — a Codex
//      credential is never consulted for an anthropic resolution, and the inverse.
//   4. --profile / --model precedence and provenance, with --model validated
//      against the ADAPTER's vocabulary and recorded verbatim under its own
//      resolved_by token, distinct from the policy tokens (AC4, AC14).
//   5. A legacy decision (no policy file at all) that still records a CONCRETE
//      provider/adapter rather than an empty one.
//   6. A provider-pin predicate evaluated AFTER resolution but never feeding INTO
//      it (D5): a shortcut refuses the resolution it actually got, and never
//      silently re-resolves to some other profile the operator did not choose.

import { loadModelPolicyWithSource, type LoadContext } from "./loader.js";
import { detectAuthMode, resolveModel, type EffectiveAuth } from "./model-resolution.js";
import { probeAuth, type AuthProbe } from "./provider-doctor.js";
import type { CostTier } from "./schema.js";
import {
  adapterDescriptor,
  checkModelVocabulary,
  limitationsForAdapter,
  type CapabilityLimitation,
  type OrchestratorAdapterId,
  type SessionIdentityStrength,
} from "./orchestrator-capabilities.js";

/** D2: the EXISTING agent role. No new policy vocabulary is introduced. */
export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";

/** The session operation the operator asked for. Part of the pre-spawn receipt
 *  (D9) — resume is provider-bound, and the binding is enforced by the adapters
 *  against the durable receipt, never by sniffing the identifier's format. */
export type OrchestratorSessionOperation =
  | { kind: "new" }
  | { kind: "continue" }
  | { kind: "resume"; sessionId: string };

// ---------------------------------------------------------------------------
// Runtime → adapter binding: the CLOSED supported set (AC5)
// ---------------------------------------------------------------------------

type InteractiveRuntimeBinding = {
  runtime: string;
  adapter: OrchestratorAdapterId;
  /** The provider whose CLI actually executes. Ordinarily identical to the
   *  profile's `provider`; they differ only for a #265 explicit-runtime profile,
   *  where `provider` names the UPSTREAM vendor the runtime fronts. */
  provider: string;
  /** The auth mode this runtime name implies. Used only for the legacy reverse
   *  lookup — in policy mode the profile's declared auth is authoritative. */
  auth: EffectiveAuth;
};

const INTERACTIVE_RUNTIMES: readonly InteractiveRuntimeBinding[] = [
  { runtime: "claude-oauth", adapter: "claude-code", provider: "anthropic", auth: "subscription" },
  { runtime: "claude-apikey", adapter: "claude-code", provider: "anthropic", auth: "api" },
  { runtime: "claude-bedrock", adapter: "claude-code", provider: "anthropic", auth: "bedrock" },
  { runtime: "codex-subscription", adapter: "codex", provider: "openai", auth: "subscription" },
];

/** Runtimes forge KNOWS and deliberately does not launch interactively. Named
 *  separately from "unknown runtime" so the refusal can say why rather than only
 *  that. */
const UNSUPPORTED_INTERACTIVE_RUNTIMES: Record<string, string> = {
  "pi-oauth":
    "pi has no interactive orchestrator adapter — it is a containerized task-agent runtime only, and FG-576 " +
    "deliberately does not make it an interactive orchestrator",
  "pi-apikey":
    "pi has no interactive orchestrator adapter — it is a containerized task-agent runtime only, and FG-576 " +
    "deliberately does not make it an interactive orchestrator",
};

function bindAdapter(runtime: string): InteractiveRuntimeBinding | undefined {
  return INTERACTIVE_RUNTIMES.find((r) => r.runtime === runtime);
}

/** Every runtime that CAN launch an interactive orchestrator, for refusal text
 *  and for the docs-parity surface. */
export function supportedInteractiveRuntimes(): string[] {
  return INTERACTIVE_RUNTIMES.map((r) => r.runtime);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_REFUSAL_CODES = [
  "policy-error",
  "unknown-profile",
  "no-capability-mapping",
  "profile-not-allowed",
  "unsupported-runtime",
  "provider-pin-mismatch",
  "model-not-accepted",
  "auth-unavailable",
  "invalid-session-operation",
] as const;

export type OrchestratorRefusalCode = (typeof ORCHESTRATOR_REFUSAL_CODES)[number];

export type OrchestratorRefusal = {
  code: OrchestratorRefusalCode;
  /** The full operator-facing message: what was selected, why it cannot launch,
   *  and the remediation. Printed as-is by the commands. */
  message: string;
  /** Structured echo of the same facts, for the receipt and for --json surfaces. */
  profile?: string | undefined;
  runtime?: string | undefined;
  provider?: string | undefined;
  adapter?: OrchestratorAdapterId | undefined;
  /** One or more CONCRETE remedies. Never empty — a refusal with no remedy is a
   *  dead end, and D16 requires remedies rather than a bare incompatibility
   *  report. */
  remediation: string[];
};

function makeRefusal(
  code: OrchestratorRefusalCode,
  headline: string,
  remediation: string[],
  facts: Pick<OrchestratorRefusal, "profile" | "runtime" | "provider" | "adapter"> = {},
): OrchestratorRefusal {
  const body = remediation.map((r) => `  - ${r}`).join("\n");
  return { code, message: `${headline}\nFix:\n${body}`, remediation, ...facts };
}

function refuse(
  code: OrchestratorRefusalCode,
  headline: string,
  remediation: string[],
  facts: Pick<OrchestratorRefusal, "profile" | "runtime" | "provider" | "adapter"> = {},
): OrchestratorResolution {
  return { ok: false, refusal: makeRefusal(code, headline, remediation, facts) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type OrchestratorDecision = {
  adapter: OrchestratorAdapterId;
  /** The provider whose CLI executes — what the receipt records and what the auth
   *  probe was run against. */
  provider: string;
  /** The profile's declared provider, when it differs from `provider` (a #265
   *  explicit-runtime profile naming an upstream vendor). Undefined when they
   *  agree, which is the ordinary case. */
  upstreamProvider?: string | undefined;
  runtime: string;
  /** undefined only in legacy mode (no policy file). */
  profile: string | undefined;
  /** The concrete model handed to the child. Empty ONLY in legacy mode with no
   *  --model, where no policy-selected model exists to record; `modelExplicit`
   *  distinguishes that from a policy-selected one. */
  model: string;
  modelExplicit: boolean;
  auth: EffectiveAuth;
  /** Capability alias the model came from. undefined in legacy mode. */
  alias: string | undefined;
  costTier: CostTier | undefined;
  /** Which rule selected the PROFILE — the existing resolver's token
   *  (cli.--profile / overrides.agents.orchestrator / defaults.activity.<cap> /
   *  defaults.profile / legacy). */
  resolvedBy: string;
  /** Which rule selected the MODEL. Distinct from `resolvedBy` so an explicit
   *  --model is never mistaken for a policy selection (AC4). */
  modelResolvedBy: string;
  policySource: "project" | "host" | "absent";
  policyPath: string | undefined;
  legacy: boolean;
  operation: OrchestratorSessionOperation;
  projectDir: string;
  /** The probe run for THIS provider and no other. Recorded as evidence. */
  authProbe: AuthProbe;
  sessionIdentityStrength: SessionIdentityStrength;
  /** Every capability the selected adapter does not fully supply, straight from
   *  the parity matrix. Recorded, never fabricated (AC9, AC12). */
  limitations: CapabilityLimitation[];
  /** Coherence notes THIS resolution produced (as opposed to standing adapter
   *  gaps): a legacy launch with no recorded model, an explicit-runtime profile
   *  whose upstream vendor differs from the launched CLI's provider. Recorded on
   *  the receipt so `forge show` can explain the choice (AC11). */
  notes: string[];
  /** The provider shortcut that produced this launch, when one did (D5). */
  providerPin: OrchestratorAdapterId | undefined;
};

export type OrchestratorResolution =
  | { ok: true; decision: OrchestratorDecision }
  | { ok: false; refusal: OrchestratorRefusal };

export type OrchestratorLaunchRequest = {
  /** Forge's `--profile`: a model-policy profile name. Highest profile-selection
   *  precedence (AC4). */
  cliProfile?: string | undefined;
  /** Provenance label recorded when cliProfile wins. Defaults to "cli.--profile". */
  profileSource?: string | undefined;
  /** Forge's `--model`: a concrete override, validated against the selected
   *  adapter's vocabulary and recorded VERBATIM. */
  cliModel?: string | undefined;
  /** D5: the adapter a provider SHORTCUT pins. Evaluated against the resolution
   *  that policy actually produced; it never changes which profile is selected. */
  providerPin?: OrchestratorAdapterId | undefined;
  /** How the pin is described in a refusal (e.g. "forge claude"). */
  providerPinSource?: string | undefined;
  operation?: OrchestratorSessionOperation | undefined;
  /** Resolved project root. Defaults to cwd. */
  projectDir?: string | undefined;
  ctx?: LoadContext | undefined;
  /** Test seam for the auth probe. Defaults to provider-doctor's probeAuth. The
   *  launcher calls it EXACTLY ONCE, for the selected provider only. */
  authProbe?: ((provider: string, mode: EffectiveAuth) => AuthProbe) | undefined;
};

export function resolveOrchestratorLaunch(req: OrchestratorLaunchRequest): OrchestratorResolution {
  const projectDir = req.projectDir ?? process.cwd();
  const ctx: LoadContext = { ...(req.ctx ?? {}), projectDir };
  const operation = req.operation ?? { kind: "new" as const };
  const probe = req.authProbe ?? probeAuth;

  if (operation.kind === "resume" && operation.sessionId.trim() === "") {
    return refuse("invalid-session-operation", `--resume needs a session identifier.`, [
      "pass the session id recorded on the receipt: `forge orchestrator --resume <id>`",
      "or start a fresh session with `forge orchestrator`",
    ]);
  }

  // ---- Load the effective policy (project over host). ----
  let loaded: ReturnType<typeof loadModelPolicyWithSource>;
  try {
    loaded = loadModelPolicyWithSource(ctx);
  } catch (e) {
    return refuse("policy-error", `model policy could not be read: ${(e as Error).message}`, [
      "fix the reported model-policy.yml error, then retry",
      "or remove the file to fall back to legacy (no-policy) resolution",
    ]);
  }

  const base =
    loaded.policy === undefined
      ? legacyDecisionBasis(req)
      : policyDecisionBasis(req, loaded.policy, ctx);
  if ("refusal" in base) return { ok: false, refusal: base.refusal };

  const { profile, runtime, model, modelResolvedByPolicy, alias, costTier, resolvedBy, auth, policyProvider, legacy, allowedProfiles } =
    base;

  // ---- Gate: allowed_profiles is the autonomy CEILING, enforced HERE ONLY. ----
  // The shared resolver still ignores it, so resolution for every other agent role
  // is behaviorally identical to today (the ticket's non-goals).
  if (profile !== undefined && allowedProfiles.length > 0 && !allowedProfiles.includes(profile)) {
    return refuse(
      "profile-not-allowed",
      `profile '${profile}' is not permitted to run an interactive Forge orchestrator: ` +
        `model policy's allowed_profiles ceiling lists ${allowedProfiles.map((p) => `'${p}'`).join(", ")}.`,
      [
        `launch one of the permitted profiles: \`forge orchestrator --profile <${allowedProfiles.join("|")}>\``,
        `or add '${profile}' to allowed_profiles in the effective model-policy.yml if it should be permitted`,
      ],
      { profile, runtime, provider: policyProvider },
    );
  }

  // ---- Gate: runtime → adapter over a closed set, and the provider pin (D5). ----
  const binding = bindAdapter(runtime);

  if (req.providerPin !== undefined && (binding === undefined || binding.adapter !== req.providerPin)) {
    // D16: a shortcut refuses the resolution it ACTUALLY got. It never re-resolves
    // to some other profile of the pinned provider that the operator did not choose.
    const pinned = adapterDescriptor(req.providerPin);
    const shortcut = req.providerPinSource ?? `the ${pinned.displayName} shortcut`;
    const got = binding
      ? `${adapterDescriptor(binding.adapter).displayName} (provider '${binding.provider}')`
      : `runtime '${runtime}', which has no interactive adapter at all`;
    return refuse(
      "provider-pin-mismatch",
      `${shortcut} launches ${pinned.displayName} only, but model policy resolves the orchestrator to ` +
        `${got}` +
        (profile ? ` via profile '${profile}'` : ``) +
        `. Refusing rather than launching a provider you did not select, or re-resolving to a ` +
        `${pinned.displayName} profile you did not choose.`,
      [
        `run \`forge orchestrator\` to launch what policy selected`,
        `or select a ${pinned.displayName}-compatible profile for this launch: \`${shortcut} --profile <profile>\``,
        `or set \`overrides.agents.orchestrator\` in the effective model-policy.yml to a ${pinned.displayName} profile`,
      ],
      { profile, runtime, provider: policyProvider, adapter: binding?.adapter },
    );
  }

  if (binding === undefined) {
    const why =
      UNSUPPORTED_INTERACTIVE_RUNTIMES[runtime] ??
      `runtime '${runtime}' is not one of the interactive adapters this build ships`;
    return refuse(
      "unsupported-runtime",
      `cannot launch an interactive orchestrator: ` +
        (profile ? `profile '${profile}' ` : `the orchestrator resolution `) +
        `selects runtime '${runtime}', and ${why}. ` +
        `Supported interactive runtimes: ${supportedInteractiveRuntimes().join(", ")}. ` +
        `Forge refuses before spawn rather than silently substituting Claude, Codex, or an ambient CLI default.`,
      [
        `select a supported profile for this launch: \`forge orchestrator --profile <profile>\``,
        `or point \`overrides.agents.orchestrator\` at a profile whose runtime is one of: ${supportedInteractiveRuntimes().join(", ")}`,
        `run \`forge orchestrator --explain\` or \`forge model resolve\` to see the effective choice before launching`,
      ],
      { profile, runtime, provider: policyProvider },
    );
  }

  const adapter = binding.adapter;
  const descriptor = adapterDescriptor(adapter);
  const limitations = limitationsForAdapter(adapter);

  // ---- Gate: an explicit --model is validated against the ADAPTER's vocabulary. ----
  let finalModel = model;
  let modelResolvedBy = modelResolvedByPolicy;
  let modelExplicit = model !== "";
  if (req.cliModel !== undefined) {
    const check = checkModelVocabulary(adapter, req.cliModel);
    if (!check.ok) {
      return refuse(
        "model-not-accepted",
        `${check.reason}.` +
          (profile ? ` (the orchestrator resolved to profile '${profile}', runtime '${runtime}')` : ``),
        [
          `pass a model this adapter accepts: ${descriptor.modelVocabularyDescription}`,
          `or omit --model and let model policy select the model for profile '${profile ?? "(none)"}'`,
          `or map the model in the profile's \`map\` block in model-policy.yml — policy-selected model ids are not restricted to the adapter's CLI vocabulary`,
        ],
        { profile, runtime, provider: binding.provider, adapter },
      );
    }
    // Recorded VERBATIM — no normalization, so `--model opus` stays `opus`.
    finalModel = req.cliModel;
    modelResolvedBy = "cli.--model";
    modelExplicit = true;
  }

  const notes: string[] = [];
  if (!modelExplicit) {
    notes.push(
      `no model-policy.yml is in effect (resolvedBy=legacy), so no policy-selected model was recorded and ` +
        `${descriptor.displayName}'s own default model applies. Create a model-policy.yml or pass --model to ` +
        `record an explicit choice.`,
    );
  }

  if (policyProvider !== undefined && policyProvider !== binding.provider) {
    notes.push(
      `profile '${profile}' declares upstream provider '${policyProvider}' while runtime '${runtime}' launches ` +
        `the ${descriptor.displayName} CLI (provider '${binding.provider}'). Auth was probed for ` +
        `'${binding.provider}' — the credentials the launched CLI actually needs.`,
    );
  }

  // ---- Gate: auth coherence, for the SELECTED provider ONLY. ----
  // One probe, one provider. A Codex credential is never consulted for an
  // anthropic resolution and a Claude credential is never consulted for a Codex
  // one — this call site is the reason that holds (AC2).
  const authProbe = probe(binding.provider, auth);
  if (authProbe.status === "unavailable") {
    return refuse(
      "auth-unavailable",
      `cannot launch ${descriptor.displayName}: ` +
        (profile ? `profile '${profile}' ` : `the orchestrator resolution `) +
        `requires provider '${binding.provider}' auth '${auth}', which is unavailable in this environment ` +
        `(${authProbe.detail}).`,
      [
        ...authRemedies(binding.provider, auth),
        `or select a profile whose auth is available: \`forge orchestrator --profile <profile>\``,
        `run \`forge providers doctor\` to see which (provider, auth) pairs are available here`,
      ],
      { profile, runtime, provider: binding.provider, adapter },
    );
  }

  return {
    ok: true,
    decision: {
      adapter,
      provider: binding.provider,
      upstreamProvider: policyProvider !== undefined && policyProvider !== binding.provider ? policyProvider : undefined,
      runtime,
      profile,
      model: finalModel,
      modelExplicit,
      auth,
      alias,
      costTier,
      resolvedBy,
      modelResolvedBy,
      policySource: loaded.source,
      policyPath: loaded.source === "absent" ? undefined : loaded.path,
      legacy,
      operation,
      projectDir,
      authProbe,
      sessionIdentityStrength: descriptor.sessionIdentity,
      limitations,
      notes,
      providerPin: req.providerPin,
    },
  };
}

function authRemedies(provider: string, auth: EffectiveAuth): string[] {
  if (provider === "openai") return ["run `codex login` to mint the Codex subscription credential"];
  if (provider === "anthropic") {
    if (auth === "bedrock") return ["run `aws sso login --profile <profile>` (or set AWS_PROFILE) to restore Bedrock credentials"];
    if (auth === "api") return ["export ANTHROPIC_API_KEY for this shell"];
    return ["run `forge auth login` to populate the Claude OAuth credential"];
  }
  return [`supply the credentials for provider '${provider}' auth '${auth}'`];
}

// ---------------------------------------------------------------------------
// The two resolution bases: policy mode and legacy mode
// ---------------------------------------------------------------------------

type DecisionBasis = {
  profile: string | undefined;
  runtime: string;
  model: string;
  modelResolvedByPolicy: string;
  alias: string | undefined;
  costTier: CostTier | undefined;
  resolvedBy: string;
  auth: EffectiveAuth;
  /** The profile's declared provider. undefined in legacy mode. */
  policyProvider: string | undefined;
  legacy: boolean;
  allowedProfiles: readonly string[];
};

function policyDecisionBasis(
  req: OrchestratorLaunchRequest,
  policy: NonNullable<ReturnType<typeof loadModelPolicyWithSource>["policy"]>,
  ctx: LoadContext,
): DecisionBasis | { refusal: OrchestratorRefusal } {
  // Pre-checks against the loaded policy, so the two operator-caused failures the
  // shared resolver raises as bare exceptions become named, remediable refusals.
  // These are plain lookups against the already-parsed document — no second parser.
  const defined = Object.keys(policy.model_profiles);
  if (req.cliProfile !== undefined && policy.model_profiles[req.cliProfile] === undefined) {
    return {
      refusal: makeRefusal(
        "unknown-profile",
        `--profile '${req.cliProfile}' is not defined in the effective model policy ` +
          `(defined: ${defined.join(", ") || "none"}).`,
        [
          `pass one of the defined profiles: \`forge orchestrator --profile <${defined.join("|") || "…"}>\``,
          `or define '${req.cliProfile}' under model_profiles in the effective model-policy.yml`,
        ],
      ),
    };
  }

  // D2: role 'orchestrator', no step alias — the capability is the intentional
  // policy `default`, not a newly invented activity.
  const selected = selectProfileName(policy, req);
  const selectedProfile = policy.model_profiles[selected.name];
  if (selectedProfile !== undefined && selectedProfile.map["default"] === undefined) {
    return {
      refusal: makeRefusal(
        "no-capability-mapping",
        `profile '${selected.name}' has no \`default\` capability mapping, so no concrete orchestrator model can be ` +
          `selected (mapped: ${Object.keys(selectedProfile.map).join(", ")}).`,
        [
          `add a \`default:\` entry to profile '${selected.name}'.map in the effective model-policy.yml`,
          `or select a profile that maps \`default\`: \`forge orchestrator --profile <profile>\``,
        ],
        { profile: selected.name },
      ),
    };
  }

  let res: ReturnType<typeof resolveModel>;
  try {
    res = resolveModel({
      agentRole: ORCHESTRATOR_AGENT_ROLE,
      cliProfile: req.cliProfile,
      profileSource: req.profileSource,
      ctx,
    });
  } catch (e) {
    return {
      refusal: makeRefusal("policy-error", `orchestrator resolution failed: ${(e as Error).message}`, [
        "fix the reported model-policy.yml problem, then retry",
        "run `forge model resolve --agent orchestrator` to inspect the effective choice",
      ]),
    };
  }

  return {
    profile: res.profile,
    runtime: res.runtime,
    model: res.model,
    modelResolvedByPolicy: `profile.map.${res.alias ?? "default"}`,
    alias: res.alias,
    costTier: res.costTier,
    resolvedBy: res.resolvedBy,
    // In policy mode the profile's declared auth (with `auto` already resolved to
    // a concrete mode) is authoritative — that is the credential the operator asked
    // for, and AC2's "correct Claude auth mode".
    auth: res.auth ?? detectAuthMode(),
    policyProvider: res.provider,
    legacy: false,
    allowedProfiles: policy.allowed_profiles,
  };
}

/** Mirror of the shared resolver's pass-2 selection, used ONLY to name the profile
 *  in a pre-resolution refusal. resolveModel() remains the authority for the value
 *  actually used — this never feeds into it. */
function selectProfileName(
  policy: NonNullable<ReturnType<typeof loadModelPolicyWithSource>["policy"]>,
  req: OrchestratorLaunchRequest,
): { name: string } {
  if (req.cliProfile) return { name: req.cliProfile };
  const agentOverride = policy.overrides.agents[ORCHESTRATOR_AGENT_ROLE];
  if (agentOverride) return { name: agentOverride };
  const activityDefault = policy.defaults.activity["default"];
  if (activityDefault) return { name: activityDefault };
  return { name: policy.defaults.profile };
}

/** No policy file at all. The launcher still records a CONCRETE provider, adapter
 *  and runtime rather than an empty one — an unrecorded provider is exactly the
 *  "manual shadow path" this ticket exists to remove. The MODEL is left empty and
 *  flagged `modelExplicit: false`, because inventing one would be a fabricated
 *  selection: legacy mode has no policy to select from. */
function legacyDecisionBasis(req: OrchestratorLaunchRequest): DecisionBasis {
  const adapter: OrchestratorAdapterId = req.providerPin ?? "claude-code";
  const descriptor = adapterDescriptor(adapter);
  const detected = detectAuthMode();
  const row =
    INTERACTIVE_RUNTIMES.find((r) => r.adapter === adapter && r.auth === detected) ??
    INTERACTIVE_RUNTIMES.find((r) => r.adapter === adapter);
  // Every adapter has at least one row by construction of INTERACTIVE_RUNTIMES.
  const binding = row as InteractiveRuntimeBinding;
  return {
    profile: undefined,
    runtime: binding.runtime,
    model: "",
    modelResolvedByPolicy: "legacy.provider-default",
    alias: undefined,
    costTier: undefined,
    resolvedBy: "legacy",
    auth: binding.auth,
    policyProvider: descriptor.provider,
    legacy: true,
    allowedProfiles: [],
  };
}

// ---------------------------------------------------------------------------
// --explain (AC15) / receipt projection (AC11)
// ---------------------------------------------------------------------------

/** The recorded pre-spawn decision, in one order, for `forge orchestrator
 *  --explain` and for `forge show`. One formatter so the two surfaces cannot
 *  drift. */
export function explainDecision(d: OrchestratorDecision): { label: string; value: string }[] {
  return [
    { label: "profile", value: d.profile ?? "(none — no model-policy.yml in effect)" },
    { label: "runtime", value: d.runtime },
    { label: "provider", value: d.provider + (d.upstreamProvider ? ` (upstream: ${d.upstreamProvider})` : "") },
    { label: "model", value: d.modelExplicit ? d.model : `(none recorded — ${adapterDescriptor(d.adapter).displayName} default applies)` },
    { label: "auth", value: `${d.auth} (${d.authProbe.status}: ${d.authProbe.detail})` },
    { label: "adapter", value: d.adapter },
    { label: "resolved_by", value: `${d.resolvedBy} (model: ${d.modelResolvedBy})` },
  ];
}
