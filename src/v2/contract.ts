// AWN-4: task contract — an explicit, machine-readable assignment attached to a
// task. Gives agents a sharper brief (objective, allowed file areas, expected
// artifacts, validation commands, auth, risk) and gives reviewers/orchestrators
// concrete criteria (review invariants). Phase 1: define + surface (carry it in
// the manifest, render it in the agent's package and in `forge show`). Phase 2
// (follow-up): record satisfied checks in results + declare contracts in workflow
// YAML + have the orchestrator template prefer them.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
    // Docs-drift Walk (#241): does this task change operator-visible behavior?
    // COARSE on purpose — a single bool, not the 6-way docs_impact enum. The
    // enum is deferred until real usage shows it's needed (avoid premature
    // precision). The orchestrator may declare it explicitly; otherwise it is
    // default-inferred from changed paths (see inferOperatorBehaviorChanged).
    // #242 (Run) uses this as an ADVISORY ship-time signal (warn, don't block)
    // until L2 precision (#243) + L3 verdict wiring make a hard gate safe.
    operator_behavior_changed: z.boolean().optional(),
  })
  .strict();

export type TaskContract = z.infer<typeof TaskContractSchema>;

// Behavior-defining surfaces whose change implies operator-facing docs may now
// be stale. Deliberately EXCLUDES docs/ and learnings/ — a docs-only change is
// not a behavior change, it's the remediation; inferring `operator_behavior_changed`
// from a docs edit would flag the documentation-maintainer's own output (and
// circularly trip the #242 gate). Coarse + directory-stable to avoid the
// keyword-list rot #240 measured; tune as real usage accrues.
//
// These are forge's OWN surfaces — the built-in fallback. Any project can
// replace them by writing <project>/.forge/docs-surfaces.yml (see
// loadOperatorSurfaces, #246); until #246 that hardcoding meant docs-impact
// inference fired only forge-on-forge.
export const OPERATOR_SURFACES: readonly string[] = [
  "src/cli/", // commands + flags the operator invokes
  "seeds/workflows/", // workflow shapes
  "seeds/runtimes/", // provider/auth runtimes
  "seeds/constraints/", // force-level rules agents obey
  "seeds/orchestrator-template.md", // the orchestrator contract
  "seeds/forge-raci.md", // work-type routing
  "seeds/model-policy.example.yml", // the example operators copy
  "src/notify/", // notification behavior + flags
  "src/util/auth-profiles", // auth modes/profiles
  "src/util/creds", // credential handling
  "src/v2/loader.ts", // workflow/runtime/policy loading
  "src/v2/schema.ts", // workflow/runtime/policy vocabulary (activity:, runtime:, ...)
  "src/v2/model-resolution.ts", // capability/profile -> model resolution
  "src/v2/provider-doctor.ts", // `forge providers doctor` behavior
  "src/v2/contract.ts", // the task-contract shape operators/agents declare
  "scripts/install-seeds.sh", // what `forge upgrade` provisions
];

// #246: a project may override the operator-surface list. Schema mirrors the
// loader convention (.strict() rejects typos loudly within the file).
const DocsSurfacesFileSchema = z
  .object({ surfaces: z.array(z.string().min(1)) })
  .strict();

/** Resolve the operator-surface list for a project. A
 *  <projectDir>/.forge/docs-surfaces.yml fully REPLACES forge's built-in
 *  defaults (matching loader.ts's per-project override semantics — not a merge);
 *  absent → the OPERATOR_SURFACES defaults. Fail-soft on a malformed file: this
 *  feeds the ADVISORY docs-impact signal embedded in `forge show`, so a typo in
 *  an opt-in config must warn, not crash a read-only diagnostic. */
export function loadOperatorSurfaces(projectDir?: string): readonly string[] {
  if (!projectDir) return OPERATOR_SURFACES;
  const path = join(projectDir, ".forge", "docs-surfaces.yml");
  if (!existsSync(path)) return OPERATOR_SURFACES;
  try {
    const parsed = DocsSurfacesFileSchema.safeParse(parseYaml(readFileSync(path, "utf8")));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      console.warn(`docs-surfaces ${path}: invalid — ${detail}; using forge defaults`);
      return OPERATOR_SURFACES;
    }
    return parsed.data.surfaces;
  } catch (e) {
    console.warn(`docs-surfaces ${path}: ${(e as Error).message}; using forge defaults`);
    return OPERATOR_SURFACES;
  }
}

function matchesSurface(path: string, surfaces: readonly string[]): string | null {
  const p = path.replace(/^\.?\//, "");
  for (const s of surfaces) {
    if (p === s || p.startsWith(s)) return s;
  }
  return null;
}

/** Default inference for `operator_behavior_changed`: true if any changed path
 *  touches a behavior-defining operator surface. The orchestrator can override
 *  by setting the contract field explicitly. `surfaces` defaults to forge's own
 *  set; pass loadOperatorSurfaces(projectDir) for cross-project inference (#246). */
export function inferOperatorBehaviorChanged(
  changedPaths: readonly string[],
  surfaces: readonly string[] = OPERATOR_SURFACES
): boolean {
  return changedPaths.some((p) => matchesSurface(p, surfaces) !== null);
}

/** The distinct operator surfaces a set of changed paths touched (empty when
 *  none). The building block for both the inference and the suggestion. */
export function operatorSurfacesTouched(
  changedPaths: readonly string[],
  surfaces: readonly string[] = OPERATOR_SURFACES
): string[] {
  const hit = new Set<string>();
  for (const p of changedPaths) {
    const s = matchesSurface(p, surfaces);
    if (s) hit.add(s);
  }
  return [...hit];
}

/** Auto-suggest the documentation-maintainer when changed paths hit operator
 *  surfaces. Returns a one-line suggestion naming the surfaces, or null when
 *  nothing operator-facing changed. */
export function docsImpactSuggestion(
  changedPaths: readonly string[],
  surfaces: readonly string[] = OPERATOR_SURFACES
): string | null {
  const hit = operatorSurfacesTouched(changedPaths, surfaces);
  if (hit.length === 0) return null;
  return `operator surfaces changed (${hit.join(", ")}) — durable docs may be stale; consider: forge invoke documentation-maintainer`;
}

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
  if (c.operator_behavior_changed) lines.push("", `**Operator behavior changes** with this task — operator-facing docs (commands, flags, defaults, examples) will need updating to match. Note the doc impact in your result so it isn't lost.`);
  lines.push("", "If you must deviate from this contract (touch a path outside the allowed set, skip a validation, etc.), state the deviation and why explicitly in your result.");
  return lines.join("\n");
}
