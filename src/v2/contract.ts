// AWN-4: task contract — an explicit, machine-readable assignment attached to a
// task. Gives agents a sharper brief (objective, allowed file areas, expected
// artifacts, validation commands, auth, risk) and gives reviewers/orchestrators
// concrete criteria (review invariants). Phase 1: define + surface (carry it in
// the manifest, render it in the agent's package and in `forge show`). Phase 2
// (follow-up): record satisfied checks in results + declare contracts in workflow
// YAML + have the orchestrator template prefer them.

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// File format matches docs/agentic-workflow-next-steps.md §4 (snake_case YAML/
// JSON). .strict() rejects unknown keys so a typo'd field is a loud error, not a
// silently-ignored contract clause.
export const TaskContractSchema = z
  .object({
    objective: z.string().min(1),
    allowed_paths: z.array(z.string()).optional(),
    expected_artifacts: z.array(z.string()).optional(),
    validation: z.object({ commands: z.array(z.string()).optional() }).strict().optional(),
    auth_profile: z.string().nullable().optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    review: z
      .object({ required: z.boolean().optional(), invariants: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .strict();

export type TaskContract = z.infer<typeof TaskContractSchema>;

/** Parse + validate a contract file (YAML or JSON — JSON is valid YAML). The
 *  contract may be the file root or under a top-level `contract:` key. */
export function parseContractFile(path: string): TaskContract {
  if (!existsSync(path)) throw new Error(`--contract file not found: ${path}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`contract ${path}: YAML/JSON parse error — ${(e as Error).message}`);
  }
  const obj = (raw && typeof raw === "object" && "contract" in (raw as object))
    ? (raw as { contract: unknown }).contract
    : raw;
  const parsed = TaskContractSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(`contract ${path}: invalid — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Render a contract as Markdown for the agent's task package, so it works to an
 *  explicit brief and knows to flag deviations. */
export function renderContract(c: TaskContract): string {
  const lines: string[] = ["## Task contract", "", `**Objective:** ${c.objective}`];
  if (c.allowed_paths?.length) lines.push("", `**Allowed paths** (touch only these):`, ...c.allowed_paths.map((p) => `- \`${p}\``));
  if (c.expected_artifacts?.length) lines.push("", `**Expected artifacts:**`, ...c.expected_artifacts.map((a) => `- ${a}`));
  if (c.validation?.commands?.length) lines.push("", `**Validation** (must pass):`, ...c.validation.commands.map((cmd) => `- \`${cmd}\``));
  if (c.auth_profile) lines.push("", `**Auth profile:** ${c.auth_profile}`);
  if (c.risk) lines.push("", `**Risk:** ${c.risk}`);
  if (c.review?.invariants?.length) lines.push("", `**Invariants** (must hold):`, ...c.review.invariants.map((inv) => `- ${inv}`));
  lines.push("", "If you must deviate from this contract (touch a path outside the allowed set, skip a validation, etc.), state the deviation and why explicitly in your result.");
  return lines.join("\n");
}
