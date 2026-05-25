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
  mode: z.enum(["env-snapshot", "mount", "apikey", "oauth-volume"]),
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
