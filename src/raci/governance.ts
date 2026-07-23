// forge RACI — read-only effective-governance read model (#281, consumed by the
// CLI `forge route governance` and the dashboard panel #285).
//
// Resolves the policy in force (host or project override), and surfaces the two
// things that would otherwise let the table lie: an UNCOMPILED override, and
// DRIFT between the in-force policy and what its own RACI source compiles to.
// Pure read: compiles the RACI in memory to compare; never writes or recompiles
// to disk, never resolves host symbols, never enforces (that's route validate).

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { RACI_PATH } from "../util/paths.js";
import { resolvePolicyPath, projectRaciPath, describeNoEffectiveHostPolicy, type RoutingSource } from "./project.js";
import { summarizeRouteChanges, type RouteChangeSummary } from "./propose.js";
import { computePolicyDrift, type RouteFinding } from "./route-validate.js";
import { compileRaciDocument } from "./compile.js";
import { RoutingPolicySchema, type PolicyRoute, type RoutingPolicy } from "./policy-schema.js";

/** FG-583: the flat-file host diff baseline is retired — the effective host policy
 *  is the one compiled INTO the live seed generation. Returns that path, or "" when
 *  no generation is published (loadPolicy("") is a clean undefined, so a missing
 *  generation simply yields no diff rather than reading the flat file). */
function hostGenerationPolicyPath(): string {
  const host = resolvePolicyPath(undefined);
  return host.noGeneration ? "" : host.path;
}

/** Parse a policy file into a typed policy, or undefined if absent/invalid. */
export function loadPolicy(path: string): RoutingPolicy | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = RoutingPolicySchema.safeParse(parseYaml(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A project RACI override exists but hasn't been compiled. Consumers must fail
 *  on this rather than fall back to host — routing from host while an override
 *  source is in force is exactly the bug #280 is meant to prevent. */
export function overrideNotCompiledFinding(projectDir: string): RouteFinding {
  return {
    code: "override_not_compiled",
    message: `project RACI override exists (${projectRaciPath(projectDir)}) but its policy is not compiled — run: forge route compile --project ${projectDir}`,
  };
}

export type GovernanceView =
  | {
      ok: true;
      source: RoutingSource;
      path: string;
      accountable: string;
      routes: Record<string, PolicyRoute>;
      /** Host-vs-project route diff; present only for a project override. */
      diff?: RouteChangeSummary;
      /** Drift between the in-force policy and what its OWN RACI source compiles
       *  to. Non-empty => the table is STALE and may not match the live rules. */
      drift?: RouteFinding[];
    }
  | { ok: false; source: RoutingSource; path: string; findings: RouteFinding[] };

/** READ-ONLY effective-governance view: the routes the resolved policy compiles
 *  to, plus a host-vs-project diff for an override and a drift warning when the
 *  policy is stale vs its RACI source. Host policy path is injectable so the diff
 *  is testable without real ~/.forge. */
export function governanceView(opts: { projectDir?: string; hostPolicyPath?: string }): GovernanceView {
  const resolved = resolvePolicyPath(opts.projectDir);

  if (resolved.source === "project" && resolved.uncompiledOverride && opts.projectDir !== undefined) {
    return { ok: false, source: "project", path: resolved.path, findings: [overrideNotCompiledFinding(opts.projectDir)] };
  }

  // FG-583: a host resolution with no complete seed generation — OR a torn/tampered
  // generation policy (finding 2) — has NO usable effective routing policy. Report
  // the NAMED install state (finding 4: absent vs incomplete/torn/tampered), never an
  // empty matrix from a missing flat path. The dashboard/CLI render this as a
  // readiness finding.
  if (resolved.source === "host" && (resolved.noGeneration || resolved.incompletePolicy)) {
    const code = resolved.incompletePolicy ? "incomplete_seed_generation" : "no_seed_generation";
    return {
      ok: false,
      source: "host",
      path: resolved.path,
      findings: [{ code, message: describeNoEffectiveHostPolicy(resolved) }],
    };
  }

  // FG-583: the host diff baseline is the generation's compiled policy too (never
  // the flat file). Injectable for tests; when absent, resolve from the generation.
  const hostPolicyPath = opts.hostPolicyPath ?? hostGenerationPolicyPath();

  const policy = loadPolicy(resolved.path);
  if (!policy) {
    const suffix = resolved.source === "project" && opts.projectDir ? ` --project ${opts.projectDir}` : "";
    return {
      ok: false,
      source: resolved.source,
      path: resolved.path,
      findings: [{ code: "policy_not_found", message: `routing policy not found or invalid: ${resolved.path} (run: forge route compile${suffix})` }],
    };
  }

  let diff: RouteChangeSummary | undefined;
  if (resolved.source === "project") {
    const hostPolicy = loadPolicy(hostPolicyPath);
    if (hostPolicy) diff = summarizeRouteChanges(hostPolicy, policy);
  }

  // Drift: is the in-force policy still what its OWN RACI source compiles to? A
  // stale policy would make the table lie (PRD Story 8). Read-only — compile the
  // effective RACI in memory and compare; never recompile to disk. The RACI for
  // the policy's source: project RACI for a project policy, host RACI for host.
  // A project policy with NO project RACI is standalone — nothing to drift against.
  let drift: RouteFinding[] | undefined;
  const raciForSource = resolved.source === "project" && opts.projectDir !== undefined
    ? projectRaciPath(opts.projectDir)
    : RACI_PATH;
  if (existsSync(raciForSource)) {
    try {
      const compiled = compileRaciDocument(readFileSync(raciForSource, "utf8"));
      const d = computePolicyDrift(compiled, policy);
      if (d.length > 0) drift = d;
    } catch (e) {
      drift = [{ code: "raci_compile_error", message: `effective RACI source does not compile: ${(e as Error).message}` }];
    }
  }

  return {
    ok: true,
    source: resolved.source,
    path: resolved.path,
    accountable: policy.governance.accountable,
    routes: policy.routes,
    ...(diff ? { diff } : {}),
    ...(drift ? { drift } : {}),
  };
}
