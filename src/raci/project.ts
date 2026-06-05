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

/** Effective routing policy. A compiled project policy wins. If it's absent but a
 *  project RACI override EXISTS, the effective source is still the project — its
 *  policy is merely uncompiled, and we must NOT fall back to host (that would
 *  route from the wrong policy while an override source is in force). Only when
 *  neither project file exists do we fall back to the host default. */
export function resolvePolicyPath(projectDir?: string): ResolvedRouting {
  if (projectDir !== undefined) {
    const policy = projectPolicyPath(projectDir);
    if (existsSync(policy)) return { source: "project", path: policy, exists: true };
    if (existsSync(projectRaciPath(projectDir))) {
      return { source: "project", path: policy, exists: false, uncompiledOverride: true };
    }
  }
  return { source: "host", path: ROUTING_POLICY_PATH, exists: existsSync(ROUTING_POLICY_PATH) };
}
