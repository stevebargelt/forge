// forge RACI — project override resolution (#280, Story 7).
//
// A project may specialize routing without corrupting the host-global default by
// dropping its own files under <project>/.forge/. Semantics are FULL REPLACEMENT,
// not merge — identical to how src/v2/loader.ts resolves workflows/runtimes:
//   1. <project>/.forge/forge-raci.md      -> the effective RACI, if present
//   2. ~/.forge/forge-raci.md              -> host default fallback
// (and the same for routing-policy.yml). The resolver reports which SOURCE won so
// every consumer can make host-vs-project explicit.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { RACI_PATH, ROUTING_POLICY_PATH } from "../util/paths.js";
import {
  GENERATION_ROUTING_POLICY,
  resolveSeedGeneration,
  type SeedGeneration,
} from "../v2/seed-generation.js";

export type RoutingSource = "host" | "project";
export type ResolvedRouting = {
  source: RoutingSource;
  path: string;
  exists: boolean;
  /** Set when the source is a project RACI override whose policy is not compiled
   *  yet. Consumers must NOT route from this path (it doesn't exist) and must NOT
   *  fall back to host — they fail and tell the operator to compile the override. */
  uncompiledOverride?: boolean;
  /** FG-583: HOST source, but no complete seed generation is published — so there
   *  is NO effective host routing policy (the flat ~/.forge/routing-policy.yml is
   *  never a dispatch source). `path` is left as the flat path for message context
   *  only; `exists` is false. Consumers MUST branch on this rather than read `path`:
   *  a DISPATCH consumer refuses (like the loader's noCompleteGenerationError); an
   *  OPERATOR consumer reports inspectSeedInstall's named no-generation state. */
  noGeneration?: boolean;
  /** FG-583: the seed generation root the HOST policy resolved from, when a
   *  generation is anchored/live. Absent for a project override or no-generation. */
  generationRoot?: string;
};

export function projectRaciPath(projectDir: string): string {
  return join(projectDir, ".forge", "forge-raci.md");
}

export function projectPolicyPath(projectDir: string): string {
  return join(projectDir, ".forge", "routing-policy.yml");
}

/** Effective RACI source: the project override if it exists, else the host. */
export function resolveRaciPath(projectDir?: string): ResolvedRouting {
  if (projectDir !== undefined) {
    const p = projectRaciPath(projectDir);
    if (existsSync(p)) return { source: "project", path: p, exists: true };
  }
  return { source: "host", path: RACI_PATH, exists: existsSync(RACI_PATH) };
}

/** Effective routing policy. A compiled project policy wins. If it's absent but a
 *  project RACI override EXISTS, the effective source is still the project — its
 *  policy is merely uncompiled, and we must NOT fall back to host (that would
 *  route from the wrong policy while an override source is in force).
 *
 *  FG-583: when the effective source is HOST, the routing policy is the one
 *  COMPILED INTO THE SEED GENERATION (join(generation.root, GENERATION_ROUTING_POLICY)),
 *  NEVER the flat ~/.forge/routing-policy.yml — which is retained only for the
 *  FG-579 drift detector / doctor registry and is never a dispatch source. The
 *  `seedGeneration` anchor mirrors the loader's `ctx.seedGeneration`:
 *    - `undefined` (the ordinary case) → resolve the LIVE seed pointer per call
 *      (a single atomic swap, so one call always observes one complete generation);
 *    - a resolved `SeedGeneration` → PIN this resolution to that held generation,
 *      so a running invocation stays on ONE generation on the policy axis too;
 *    - `null` → no generation anchored → no effective host policy (noGeneration). */
export function resolvePolicyPath(
  projectDir?: string,
  seedGeneration?: SeedGeneration | null,
): ResolvedRouting {
  if (projectDir !== undefined) {
    const policy = projectPolicyPath(projectDir);
    if (existsSync(policy)) return { source: "project", path: policy, exists: true };
    if (existsSync(projectRaciPath(projectDir))) {
      return { source: "project", path: policy, exists: false, uncompiledOverride: true };
    }
  }
  const generation = seedGeneration !== undefined ? seedGeneration : resolveSeedGeneration();
  if (!generation) {
    // No complete generation: there is NO effective host routing policy. Leave the
    // flat path for message context only, exists:false, and flag noGeneration — a
    // consumer must branch on it, never read the flat file.
    return { source: "host", path: ROUTING_POLICY_PATH, exists: false, noGeneration: true };
  }
  const path = join(generation.root, GENERATION_ROUTING_POLICY);
  return { source: "host", path, exists: existsSync(path), generationRoot: generation.root };
}
