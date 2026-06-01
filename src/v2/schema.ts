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

const RedDefSchema = z.object({
  agent: NameSchema,
  model: z.string().optional(),
  authority: z.enum(["authoritative", "specialist"]),
  gate_on_verdict: z.boolean().default(true),
});

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

const StepSchema = z
  .object({
    id: NameSchema,
    agent: NameSchema.optional(),
    model: z.string().optional(),
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
  });

export const WorkflowSchema = z
  .object({
    name: NameSchema,
    description: z.string().min(1),
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
  mode: z.enum(["env-snapshot", "mount", "apikey", "oauth-volume", "codex-auth"]),
});

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
});

const ModelProfileSchema = z
  .object({
    // provider is intentionally an open string, NOT an enum: a new provider
    // (openai) should not require a schema bump. The (provider, effective_auth)
    // -> runtime binding table is where an unknown provider fails loud.
    provider: z.string().min(1),
    auth: AuthModeSchema,
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
