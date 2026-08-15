// forge v2 — Zod schemas for Workflow + Runtime YAML.
//
// These validate YAML at load time and surface field-level errors. Types
// derived via z.infer are the source of truth for the v2 layer; everything
// downstream (loader, runner, spawn) imports from here.
//
// Reference: docs/prds/yaml-orchestrator-116/SCHEMA.md
//
// **Pending dep install:** this file imports `zod`. Run `npm install zod yaml`
// before typechecking/testing. Added as a separate step to keep this commit
// dep-free; the alternative would be writing schemas as TS types only, which
// loses the runtime-validation half of what we're after.

import { z } from "zod";

// ------------------------------------------------------------------
// Shared primitives
// ------------------------------------------------------------------

// Step / input / mount names: lower-kebab-case. Strict naming keeps YAML
// readable and prevents accidental shell-quoting traps.
const NameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: "names must be lower-kebab-case (start with letter, then letters/digits/hyphens)",
});

// ------------------------------------------------------------------
// Workflow YAML
// ------------------------------------------------------------------

const InputDefSchema = z.object({
  name: NameSchema,
  required: z.boolean().default(false),
  type: z.enum(["text", "textarea", "path"]),
  help: z.string().optional(),
});

// #227: a step/red's capability field is named `activity:` (it names a capability
// intent — "review", "reasoning" — resolved against defaults.activity / the
// profile map, NOT a concrete model). The legacy name was `model:`, which was
// Claude/legacy-shaped and misleading. Accept the old name as a deprecated alias
// so existing workflow YAMLs keep working; warn once per process to nudge
// migration. Zod would otherwise silently DROP an unknown `model:` key and let
// the capability fall back — a silent behavior change, so the alias is required,
// not just nice-to-have.
let warnedModelFieldDeprecation = false;
function aliasModelToActivity(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  if (o["model"] === undefined || o["activity"] !== undefined) return raw;
  if (!warnedModelFieldDeprecation) {
    warnedModelFieldDeprecation = true;
    console.error(
      "forge: workflow step/red field `model:` is deprecated — rename to `activity:` " +
        "(it names a capability, not a concrete model). Still accepted for now.",
    );
  }
  const { model, ...rest } = o;
  return { ...rest, activity: model };
}

const RedDefSchema = z.preprocess(
  aliasModelToActivity,
  z.object({
    agent: NameSchema,
    activity: z.string().optional(), // capability alias; legacy name `model:` (deprecated, aliased)
    authority: z.enum(["authoritative", "specialist"]),
    gate_on_verdict: z.boolean().default(true),
  }),
);

const FanoutFromUpstreamSchema = z.object({
  step: NameSchema,
  array_key: z.string().min(1),
  input_key: z.string().min(1),
});

const FanoutDefSchema = z.object({
  from_upstream: FanoutFromUpstreamSchema,
  max_concurrency: z.number().int().positive().optional(),
  failure_mode: z.enum(["fail-phase", "retry-once", "continue"]).default("fail-phase"),
  // discipline_key names the field on each upstream-array element that carries
  // the routing key. Default at runtime is "discipline" (matches the
  // AgentDiscipline type in src/types/); kept optional in the schema so
  // existing fanout fixtures don't have to declare it.
  discipline_key: z.string().min(1).optional(),
  // agent_map maps discipline values to agent role names. Unmatched values
  // (or any input that isn't an object) fall back to step.agent.
  agent_map: z.record(z.string(), z.string()).optional(),
});

// Default `auto` (orchestrator-mediated). v1 defaulted every phase to human
// gates; v2 flips to autonomous-by-default with explicit opt-in to human.
// See SCHEMA.md "Gate semantics" + STATUS.md "Gate defaults" for the
// rationale (modeled after Jeff's `approval: final` pattern).
const GateSchema = z.enum(["human", "verdict", "auto", "none"]).default("auto");

const StepSchema = z.preprocess(
  aliasModelToActivity,
  z
  .object({
    id: NameSchema,
    agent: NameSchema.optional(),
    activity: z.string().optional(), // capability alias; legacy name `model:` (deprecated, aliased above)
    // runtime: LEGACY-ONLY. Consulted only when no model-policy.yml is active
    // (resolveModelForTask). In policy mode the runtime is derived from the
    // resolved (provider, auth) binding and this field is IGNORED. Defaults to
    // claude; seeds don't set it — don't add it to policy-era workflows.
    runtime: NameSchema.default("claude"),
    depends_on: z.array(NameSchema).default([]),
    gate: GateSchema,
    on_reject: NameSchema.optional(),
    workflow_additions: z.string().optional(),
    manual: z.boolean().default(false),
    reds: z.array(RedDefSchema).default([]),
    fanout: FanoutDefSchema.optional(),
  })
  .superRefine((step, ctx) => {
    if (step.manual) {
      if (step.agent !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent"],
          message: "manual steps must not declare an agent",
        });
      }
      if (step.gate !== "human") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gate"],
          message: "manual steps must have gate: human (nothing else makes sense without an agent to verdict on)",
        });
      }
      if (step.reds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reds"],
          message: "manual steps cannot have reds (no artifact to audit until submit)",
        });
      }
      if (step.fanout) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fanout"],
          message: "manual steps cannot fanout",
        });
      }
    } else {
      if (!step.agent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent"],
          message: "non-manual steps must declare an agent",
        });
      }
    }
    if (step.gate === "verdict" && step.reds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate"],
        message: "gate: verdict requires at least one red (nothing to aggregate otherwise)",
      });
    }
  }),
);

export const WorkflowSchema = z
  .object({
    name: NameSchema,
    description: z.string().min(1),
    // FG-640: THE EXPLICIT CUTOVER SWITCH. Which authority model settles this workflow's
    // runs — declared in the workflow file, stamped onto the run row at creation, and never
    // inferred from which command was typed. An unmigrated workflow omits it and keeps
    // verdict/blocked_by_red exactly as before; migrating one is a visible, reviewable edit
    // to this line rather than a behavior change that arrives with a new CLI flag.
    review_mode: z.enum(["legacy_verdict", "legacy_review_loop", "evidence_led"]).default("legacy_verdict"),
    inputs: z.array(InputDefSchema).default([]),
    steps: z.array(StepSchema).min(1),
  })
  .superRefine((wf, ctx) => {
    // Step ids must be unique.
    const seen = new Set<string>();
    for (const step of wf.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps"],
          message: `duplicate step id: ${step.id}`,
        });
      }
      seen.add(step.id);
    }
    // depends_on must reference existing steps.
    const ids = new Set(wf.steps.map((s) => s.id));
    for (const step of wf.steps) {
      for (const dep of step.depends_on) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps"],
            message: `step '${step.id}' depends_on unknown step '${dep}'`,
          });
        }
      }
      if (step.on_reject && !ids.has(step.on_reject)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps"],
          message: `step '${step.id}' on_reject references unknown step '${step.on_reject}'`,
        });
      }
      // FG-476/FG-478: dispatchFanoutStep's existingParent lookup has no
      // recovery-row reuse (unlike dispatchSingleStep's), so an on_reject
      // targeting a fanout step reproduces the duplicate-primary hang FG-476
      // fixed for single-agent steps. Real recovery-into-fanout semantics
      // (re-expansion, child identity, parent aggregation) are out of scope
      // here — fail fast at validation instead.
      if (step.on_reject && ids.has(step.on_reject)) {
        const targetStep = wf.steps.find((s) => s.id === step.on_reject);
        if (targetStep?.fanout) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps"],
            message: `step '${step.id}' has on_reject: '${step.on_reject}', but '${step.on_reject}' is a fanout step; on_reject recovery into a fanout step is not supported (tracked in FG-478)`,
          });
        }
      }
      if (step.fanout && !ids.has(step.fanout.from_upstream.step)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps"],
          message: `step '${step.id}' fanout.from_upstream references unknown step '${step.fanout.from_upstream.step}'`,
        });
      }
    }
    // No cycles in depends_on (cheap topological check).
    detectCycles(wf, ctx);
  });

function detectCycles(wf: z.infer<typeof rawWorkflowShape>, ctx: z.RefinementCtx): void {
  const graph: Record<string, string[]> = {};
  for (const step of wf.steps) graph[step.id] = step.depends_on;

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  for (const id of Object.keys(graph)) color[id] = WHITE;

  function dfs(id: string): string | null {
    color[id] = GRAY;
    for (const dep of graph[id] ?? []) {
      if (color[dep] === GRAY) return dep;
      if (color[dep] === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    color[id] = BLACK;
    return null;
  }

  for (const id of Object.keys(graph)) {
    if (color[id] === WHITE) {
      const cycle = dfs(id);
      if (cycle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps"],
          message: `cycle in depends_on graph involving '${cycle}'`,
        });
        return;
      }
    }
  }
}

// Helper type for the cycle detector — same shape as WorkflowSchema's input
// pre-refinement. Hand-written because Zod's .superRefine input type doesn't
// expose cleanly.
const rawWorkflowShape = z.object({
  steps: z.array(z.object({ id: z.string(), depends_on: z.array(z.string()).default([]) })),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type RedDef = z.infer<typeof RedDefSchema>;
export type FanoutDef = z.infer<typeof FanoutDefSchema>;
export type InputDef = z.infer<typeof InputDefSchema>;
export type Gate = z.infer<typeof GateSchema>;

// ------------------------------------------------------------------
// Runtime YAML
// ------------------------------------------------------------------

const DetectDefSchema = z.object({
  env: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
});

const AuthDefSchema = z.object({
  // codex-auth (AWN-7 Walk): RO-mount the host Codex subscription credential
  // (~/.codex/auth.json); the entrypoint copies it into a writable CODEX_HOME.
  // pi-auth (#266): same pattern for pi's OAuth credential (~/.forge/pi-agent/
  // auth.json, minted by `forge pi login`); entrypoint copies into PI_CODING_AGENT_DIR.
  mode: z.enum(["env-snapshot", "mount", "apikey", "oauth-volume", "codex-auth", "pi-auth"]),
});

// #292 — runtime metadata seam. These declare a runtime's EXECUTION BEHAVIOR
// explicitly, so downstream code (usage parsing, prompt injection, auth wiring)
// chooses from runtime metadata instead of inferring from upstream provider/
// profile names. The PRD's correction (docs/prds/provider-agnostic-runtime-pi.md):
// provider/model are model-SELECTION facts; runtime_kind/log_format/etc. are
// EXECUTION facts. All four are optional in YAML so a pre-#292 custom runtime
// still loads — resolveRuntimeMetadata() infers any missing field from existing
// signals (the one place legacy inference lives).
const RuntimeKindSchema = z.enum(["claude-code", "codex", "pi"]);
const LogFormatSchema = z.enum(["claude-stream-json", "codex-jsonl", "pi-jsonl"]);
// `message-arg`: system prompt via a CLI flag (e.g. pi --append-system-prompt) and
// the task package as a positional message argument — not stdin. Added for pi
// (#261); the actual prompt-injection MAPPING logic is #263's concern, this is
// only the truthful declaration so resolveRuntimeMetadata doesn't mislabel pi as
// claude-stdin-package.
const PromptStrategySchema = z.enum(["claude-stdin-package", "stdin-prepend", "runtime-context-file", "message-arg"]);
// auth_strategy is the ABSTRACT, provider-independent auth category — distinct
// from auth.mode (the docker-wiring detail spawn.ts consumes; env-snapshot vs
// mount are both the aws-bedrock strategy). It defaults by deriving from
// auth.mode (see resolveRuntimeMetadata) so the two can never contradict.
// `aws-bedrock` extends the PRD's illustrative list, which omitted Bedrock.
const AuthStrategySchema = z.enum([
  "oauth-volume",
  "codex-auth",
  "env-provider-api-key",
  "pi-auth-json",
  "local-endpoint",
  "aws-bedrock",
]);

const MountDefSchema = z.object({
  host: z.string().min(1),
  container: z.string().min(1),
  mode: z.string().default("rw"), // 'rw', 'ro', or '${PROJECT_MODE:-rw}' template
  optional: z.boolean().default(false),
});

const InvocationDefSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  stdin: z.string().optional(),
});

const ContainerDefSchema = z.object({
  name: z.string().min(1), // typically "forge-{{TASK_ID}}"
  remove_on_exit: z.boolean().default(true),
  idle_timeout_seconds: z.number().int().positive().default(300),
});

const ResultDefSchema = z.object({
  file: z.string().min(1),
  stdout_log: z.string().default("container.stdout.log"),
  stderr_log: z.string().default("container.stderr.log"),
});

export const RuntimeSchema = z.object({
  name: NameSchema,
  description: z.string().min(1),
  // #292 runtime metadata — see the schema comment above. Optional for back-compat;
  // normalized to always-present by resolveRuntimeMetadata().
  runtime_kind: RuntimeKindSchema.optional(),
  log_format: LogFormatSchema.optional(),
  prompt_strategy: PromptStrategySchema.optional(),
  auth_strategy: AuthStrategySchema.optional(),
  detect: DetectDefSchema.optional(),
  image: z.string().min(1),
  // Model aliases: at least 'default' must be present so unspecified-model
  // steps resolve. Validated in superRefine.
  models: z.record(z.string(), z.string()),
  auth: AuthDefSchema,
  env: z.record(z.string(), z.string()).default({}),
  mounts: z.array(MountDefSchema),
  invocation: InvocationDefSchema,
  container: ContainerDefSchema,
  result: ResultDefSchema,
}).superRefine((rt, ctx) => {
  if (!("default" in rt.models)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["models"],
      message: "runtime.models must include a 'default' alias (used when steps don't declare model)",
    });
  }
});

export type Runtime = z.infer<typeof RuntimeSchema>;
export type Auth = z.infer<typeof AuthDefSchema>;
export type Mount = z.infer<typeof MountDefSchema>;

export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;
export type LogFormat = z.infer<typeof LogFormatSchema>;
export type PromptStrategy = z.infer<typeof PromptStrategySchema>;
export type AuthStrategy = z.infer<typeof AuthStrategySchema>;

/** The #292 runtime metadata, with every field resolved to a concrete value. */
export type RuntimeMetadata = {
  runtimeKind: RuntimeKind;
  logFormat: LogFormat;
  promptStrategy: PromptStrategy;
  authStrategy: AuthStrategy;
};

// auth.mode (docker-wiring detail) → abstract auth_strategy default. The ONLY
// derivation between the two vocabularies, so they can't drift: env-snapshot and
// mount are both Bedrock wiring → aws-bedrock.
const AUTH_MODE_TO_STRATEGY: Record<Auth["mode"], AuthStrategy> = {
  "oauth-volume": "oauth-volume",
  "codex-auth": "codex-auth",
  apikey: "env-provider-api-key",
  "pi-auth": "pi-auth-json",
  "env-snapshot": "aws-bedrock",
  mount: "aws-bedrock",
};

/** Resolve a runtime's #292 execution metadata to concrete values. Explicit YAML
 *  fields win; anything omitted (a pre-#292 runtime) is INFERRED here — the single
 *  place legacy "guess behavior from the invocation" logic lives, so the rest of
 *  the codebase keys off metadata, never off provider names. `codex` is inferred
 *  from the invocation command; `pi` is never inferred (Pi runtimes declare it). */
export function resolveRuntimeMetadata(rt: Runtime): RuntimeMetadata {
  const isCodex = rt.invocation.command === "codex";
  return {
    runtimeKind: rt.runtime_kind ?? (isCodex ? "codex" : "claude-code"),
    logFormat: rt.log_format ?? (isCodex ? "codex-jsonl" : "claude-stream-json"),
    promptStrategy: rt.prompt_strategy ?? (isCodex ? "stdin-prepend" : "claude-stdin-package"),
    authStrategy: rt.auth_strategy ?? AUTH_MODE_TO_STRATEGY[rt.auth.mode],
  };
}

// ------------------------------------------------------------------
// Model policy YAML (model-policy.yml) — AWN-7 Crawl (FORGE-DEC provider-resolution)
// ------------------------------------------------------------------
//
// Policy is OPT-IN. When no model-policy.yml exists at either the project or
// workspace path, forge uses the legacy runtime.models[alias] resolution and
// behavior is unchanged. A policy file flips resolution into the two-pass model:
//   capability alias (workflow intent) -> profile.map[alias].model (concrete)
//   profile.provider + effective auth  -> runtime (execution mechanism)
//
// Separation of concerns (the ADR's core reconciliation):
//   profile  owns POLICY     — provider + auth intent + capability->model/cost map
//   runtime  owns EXECUTION   — image + command + mounts + prompt/result + env detect
//   forge    owns BINDING     — (provider, effective_auth) -> runtime YAML name

// FG-560: the model-policy versioning anchor. `model-policy.yml` is an
// operator-owned config surface, so it carries an explicit schema_version and is
// migrated ONLY by `forge upgrade` (the sole migration authority) — ordinary
// policy loading is strictly read-only and never rewrites or reinterprets a file.
//
// Current = 2. The dispatch loaders (loadModelPolicy / loadModelPolicyWithSource)
// gate on this BEFORE Zod runs: a v1 file (no schema_version) or any older-known
// version is refused with a `forge upgrade` directive and left byte-identical; a
// newer-unknown version fails loud ('upgrade Forge') and is NEVER downgraded or
// reinterpreted as an older schema. Bump this (and add a migration in
// model-policy-migration.ts) whenever the policy shape changes incompatibly.
export const CURRENT_MODEL_POLICY_SCHEMA_VERSION = 2;

// Coarse, hand-maintained per-model label (ADR §9). NOT a computed dollar figure
// — OAuth/subscription has no per-token cost and prices drift. Guardrails reason
// over the qualitative tier of the resolved (profile, model).
const CostTierSchema = z.enum(["cheap", "standard", "premium"]);

// Auth/transport mode for a profile. `auto` delegates to env detection
// (FORGE-DEC-007/013) at resolution time; the others PIN a mode and fail loud
// if its credentials are absent (unless the profile opts into fallback). The
// EFFECTIVE mode (never `auto`) is what gets recorded in the DB/manifest.
const AuthModeSchema = z.enum(["auto", "subscription", "api", "bedrock"]);

// What to do when a resolved profile has no working auth in the environment.
// fail = clear error naming provider + missing auth (default); fallback = pick a
// same-or-lower-cost alternative bounded by allowed_profiles (lands in Run).
const OnUnavailableSchema = z.enum(["fail", "fallback"]);

const CapabilityEntrySchema = z.object({
  model: z.string().min(1),
  cost_tier: CostTierSchema,
  tool_capable: z.boolean().optional(),
});

const ModelProfileSchema = z
  .object({
    // provider is intentionally an open string, NOT an enum: a new provider
    // (openai) should not require a schema bump. The (provider, effective_auth)
    // -> runtime binding table is where an unknown provider fails loud.
    //
    // When `runtime` (below) is set, provider denotes the UPSTREAM model vendor
    // (e.g. groq, anthropic, ollama) that the explicit runtime fronts — it is
    // passed through to the runtime as ${UPSTREAM_PROVIDER}, not used for binding.
    provider: z.string().min(1),
    auth: AuthModeSchema,
    // #265: explicit runtime YAML name. A runtime like `pi` fronts MANY upstream
    // providers, so (provider, auth) -> runtime can't pick it. When set, the
    // resolver uses this runtime directly (skipping the binding table) and treats
    // `provider` as the upstream vendor. Absent = legacy (provider, auth) binding,
    // unchanged. An unknown runtime name fails loud at loadRuntime (dispatch time).
    runtime: z.string().min(1).optional(),
    // capability alias -> { model, cost_tier }. At least one alias required.
    map: z.record(z.string(), CapabilityEntrySchema),
    // Profile-scoped override of the policy-level on_unavailable default. Lets a
    // non-critical profile opt into fallback without changing global behavior.
    on_unavailable: OnUnavailableSchema.optional(),
  })
  .superRefine((profile, ctx) => {
    if (Object.keys(profile.map).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["map"],
        message: "profile map must contain at least one capability alias",
      });
    }
  });

export const ModelPolicySchema = z
  .object({
    // FG-560: the schema version anchor. Current = 2 (see
    // CURRENT_MODEL_POLICY_SCHEMA_VERSION). The dispatch READ-path enforces
    // explicit presence + currency via the loader version gate BEFORE this schema
    // runs, so by the time Zod sees the document schema_version is always 2. Kept
    // `.default(2)` here (rather than required) purely so a legacy-shaped object
    // handed straight to ModelPolicySchema.safeParse — internal tools/tests, never
    // the dispatch path — still validates; the migration engine and seed write the
    // key explicitly, and the loader gate refuses any file that omits it.
    schema_version: z
      .literal(CURRENT_MODEL_POLICY_SCHEMA_VERSION)
      .default(CURRENT_MODEL_POLICY_SCHEMA_VERSION),
    // Global default; per-profile on_unavailable overrides it. Defaults to fail
    // (fail loud — never silently run a different model than policy specified).
    on_unavailable: OnUnavailableSchema.default("fail"),
    model_profiles: z.record(z.string(), ModelProfileSchema),
    defaults: z.object({
      // Ultimate fallback profile when no activity/agent override matches.
      profile: z.string().min(1),
      // activity (capability) -> profile. The forge-default selection layer.
      activity: z.record(z.string(), z.string()).default({}),
    }),
    overrides: z
      .object({
        // agent role -> profile. Realizes goal 2 (pin one agent to a provider).
        agents: z.record(z.string(), z.string()).default({}),
      })
      .default({ agents: {} }),
    // Bounds orchestrator autonomy (Run). Empty/absent = all defined profiles
    // allowed. Informational in Crawl; enforced once orchestrator choice lands.
    allowed_profiles: z.array(z.string()).default([]),
  })
  .superRefine((policy, ctx) => {
    const profileNames = new Set(Object.keys(policy.model_profiles));
    if (profileNames.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model_profiles"],
        message: "at least one profile must be defined",
      });
    }
    const checkRef = (name: string, path: (string | number)[]) => {
      if (!profileNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `references unknown profile '${name}' (defined: ${[...profileNames].join(", ") || "none"})`,
        });
      }
    };
    checkRef(policy.defaults.profile, ["defaults", "profile"]);
    for (const [activity, name] of Object.entries(policy.defaults.activity)) {
      checkRef(name, ["defaults", "activity", activity]);
    }
    for (const [agent, name] of Object.entries(policy.overrides.agents)) {
      checkRef(name, ["overrides", "agents", agent]);
    }
    policy.allowed_profiles.forEach((name, i) => checkRef(name, ["allowed_profiles", i]));
  });

export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;
export type AuthMode = z.infer<typeof AuthModeSchema>;
export type CostTier = z.infer<typeof CostTierSchema>;
export type OnUnavailable = z.infer<typeof OnUnavailableSchema>;
