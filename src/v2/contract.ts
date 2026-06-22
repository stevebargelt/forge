import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

/** Resolve the docs-surfaces receipt for the control-plane manifest. Returns the
 *  effective source ("project" if a valid project file was loaded, "built-in" if absent
 *  or invalid) and a warning string when a present-but-invalid project file was ignored. */
export function resolveDocsSurfacesReceipt(projectDir: string): {
  receipt: { source: "project" | "built-in"; path?: string };
  warning?: string;
} {
  const path = join(projectDir, ".forge", "docs-surfaces.yml");
  if (!existsSync(path)) return { receipt: { source: "built-in" } };
  try {
    const parsed = DocsSurfacesFileSchema.safeParse(parseYaml(readFileSync(path, "utf8")));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        receipt: { source: "built-in" },
        warning: `docs-surfaces.yml invalid — ${detail}; using forge defaults`,
      };
    }
    return { receipt: { source: "project", path } };
  } catch (e) {
    return {
      receipt: { source: "built-in" },
      warning: `docs-surfaces.yml: ${(e as Error).message}; using forge defaults`,
    };
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

