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
export type ResolvedRouting = { source: RoutingSource; path: string; exists: boolean };

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

/** Effective routing policy: the project override if it exists, else the host. */
export function resolvePolicyPath(projectDir?: string): ResolvedRouting {
  if (projectDir !== undefined) {
    const p = projectPolicyPath(projectDir);
    if (existsSync(p)) return { source: "project", path: p, exists: true };
  }
  return { source: "host", path: ROUTING_POLICY_PATH, exists: existsSync(ROUTING_POLICY_PATH) };
}
