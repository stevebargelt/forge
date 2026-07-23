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
import { FORGE_HOME, RACI_PATH } from "../util/paths.js";
import { resolveSeedGeneration, GENERATION_ROUTING_POLICY, type SeedGeneration } from "../v2/seed-generation.js";

export type RoutingSource = "host" | "project";
export type ResolvedRouting = {
  source: RoutingSource;
  path: string;
  exists: boolean;
  /** Set when the source is a project RACI override whose policy is not compiled
   *  yet. Consumers must NOT route from this path (it doesn't exist) and must NOT
   *  fall back to host — they fail and tell the operator to compile the override. */
  uncompiledOverride?: boolean;
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

/** A deliberately non-existent host policy path returned when NO complete seed
 *  generation is published. Nothing ever writes under this marker dir, so every policy
 *  reader — loadPolicy / explainRouteFile / validateRoutePolicyFile all fail closed on
 *  a missing file, and the `exists` gate short-circuits — resolves policy_not_found
 *  rather than reading the mutable flat routing-policy.yml. It is NOT derived from the
 *  seed pointer, so a torn/incomplete generation's routing-policy.yml is never read. */
function noGenerationPolicySentinel(): string {
  return join(FORGE_HOME, ".no-seed-generation", GENERATION_ROUTING_POLICY);
}

/** Effective routing policy. A compiled project policy wins. If it's absent but a
 *  project RACI override EXISTS, the effective source is still the project — its
 *  policy is merely uncompiled, and we must NOT fall back to host (that would
 *  route from the wrong policy while an override source is in force). When neither
 *  project file exists, the effective host policy is the one INSIDE the resolved seed
 *  generation; there is NO flat-layout fallback (see below). */
export function resolvePolicyPath(
  projectDir?: string,
  // FG-583: the held seed generation. A project override always wins; otherwise the
  // HOST policy is the one INSIDE this generation — workflows, runtimes, and the
  // derived routing policy are ONE generation resolved from ONE anchor, so a
  // dispatch can never combine an old generation's workflows with a newly-rewritten
  // flat policy. `undefined` → resolve the live pointer (safe: an atomic publication
  // still observes one complete generation); `null` → the flat pre-migration layout.
  seedGeneration?: SeedGeneration | null,
): ResolvedRouting {
  if (projectDir !== undefined) {
    const policy = projectPolicyPath(projectDir);
    if (existsSync(policy)) return { source: "project", path: policy, exists: true };
    if (existsSync(projectRaciPath(projectDir))) {
      return { source: "project", path: policy, exists: false, uncompiledOverride: true };
    }
  }
  const gen = seedGeneration !== undefined ? seedGeneration : resolveSeedGeneration();
  if (gen) {
    // The generation's compiled routing policy. Absent (the generation shipped no
    // host RACI) → `exists:false`, which every consumer treats as fail-closed
    // (lane 'manual' / policy_not_found) — NEVER a fall-through to the flat file,
    // which could belong to a different generation.
    const genPolicy = join(gen.root, GENERATION_ROUTING_POLICY);
    return { source: "host", path: genPolicy, exists: existsSync(genPolicy) };
  }
  // FG-583: NO complete generation is published — mirror the loader's
  // noCompleteGenerationError. There is no flat-layout dispatch fallback: the mutable
  // flat ROUTING_POLICY_PATH can exist (forge init/setup compile it) yet belong to no
  // published generation, so falling back to it would let a dispatch-adjacent consumer
  // (the route preflight run before `forge new` / `forge invoke`) validate a route
  // against a policy set that never shipped with the workflow/runtime generation. Fail
  // closed by returning a non-existent host path, exactly as the generation-shipped-no-
  // policy branch above does. `forge upgrade` republishes a complete generation.
  return { source: "host", path: noGenerationPolicySentinel(), exists: false };
}
