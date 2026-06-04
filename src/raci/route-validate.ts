// forge RACI — operational-policy lint (the core of `forge route validate`, #278).
//
// Validates the DERIVED routing-policy.yml as an executable policy in an
// environment. Unlike raci validate (#277, host-independent), this resolves
// symbols against THIS host and, when a RACI source is present, checks the
// policy still agrees with what the RACI compiles to.
//
// Boundary: this NEVER generates the policy. A caller that has no policy reports
// `policy_not_found` — it does not silently compile from RACI. Compiler and
// validator roles stay clean. An absent RACI is NOT a failure: a compiled policy
// can travel standalone (validate schema + host resolution, skip drift).
//
// Host access is injected (HostEnv) so the core is pure + testable; the CLI wires
// the real ~/.forge lookups.

import { isDeepStrictEqual } from "node:util";
import { RoutingPolicySchema, type RoutingPolicy, type PolicyRoute } from "./policy-schema.js";
import { compileRaciDocument } from "./compile.js";
import { EVIDENCE_SOURCES, FORCE_RULES_BASELINE, BUILTIN_SYMBOLS, CLI_ACTIONS } from "./vocab.js";

export type RouteFinding = { code: string; message: string; route?: string };
export type RouteValidation = {
  ok: boolean;
  mode: "standalone" | "with-raci";
  findings: RouteFinding[];
};

export type HostEnv = {
  /** Is an agent role installed on this host? (~/.forge/agents/<role>/) */
  agentInstalled: (role: string) => boolean;
  /** Is a workflow known on this host? (~/.forge/workflows/<name>.yml or seeded) */
  workflowKnown: (name: string) => boolean;
};

/** Validate a parsed-but-untyped policy object against the schema + host. When
 *  `raciSource` is provided, also checks drift against the compiled RACI. */
export function validateRoutePolicy(
  policyInput: unknown,
  host: HostEnv,
  raciSource?: string,
): RouteValidation {
  const findings: RouteFinding[] = [];
  const mode: RouteValidation["mode"] = raciSource !== undefined ? "with-raci" : "standalone";

  const parsed = RoutingPolicySchema.safeParse(policyInput);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({ code: "schema_error", message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
    }
    return { ok: false, mode, findings };
  }
  const policy = parsed.data;

  for (const [routeKey, route] of Object.entries(policy.routes)) {
    resolveRoute(routeKey, route, host, findings);
  }

  if (raciSource !== undefined) {
    let compiled: RoutingPolicy | undefined;
    try {
      compiled = compileRaciDocument(raciSource);
    } catch (e) {
      findings.push({ code: "raci_compile_error", message: e instanceof Error ? e.message : String(e) });
    }
    if (compiled) driftFindings(compiled, policy, findings);
  }

  return { ok: findings.length === 0, mode, findings };
}

function resolveRoute(routeKey: string, route: PolicyRoute, host: HostEnv, findings: RouteFinding[]): void {
  resolveResponsible(routeKey, route, host, findings);

  // consulted — a built-in, a known evidence source, or an installed agent.
  for (const c of route.consulted) {
    if (!BUILTIN_SYMBOLS.has(c) && !EVIDENCE_SOURCES.has(c) && !host.agentInstalled(c)) {
      findings.push({
        code: "consulted_unresolved",
        route: routeKey,
        message: `consulted "${c}" is not a built-in, evidence source, or installed agent`,
      });
    }
  }

  // required_followups — installed agent roles.
  for (const f of route.required_followups) {
    if (!BUILTIN_SYMBOLS.has(f) && !host.agentInstalled(f)) {
      findings.push({
        code: "followup_unresolved",
        route: routeKey,
        message: `required followup "${f}" is not an installed agent`,
      });
    }
  }

  // force_rules — dormant while the baseline is empty (don't pretend resolution).
  if (FORCE_RULES_BASELINE.size > 0) {
    for (const fr of route.force_rules) {
      if (!FORCE_RULES_BASELINE.has(fr)) {
        findings.push({
          code: "force_rule_unresolved",
          route: routeKey,
          message: `force rule "${fr}" is not in the host baseline`,
        });
      }
    }
  }
}

function resolveResponsible(routeKey: string, route: PolicyRoute, host: HostEnv, findings: RouteFinding[]): void {
  const r = route.responsible;
  if (BUILTIN_SYMBOLS.has(r)) return; // human / orchestrator — always valid

  const flag = (message: string) =>
    findings.push({ code: "responsible_unresolved", route: routeKey, message });

  switch (route.path) {
    case "cli":
      if (!CLI_ACTIONS.has(r)) flag(`cli responsible "${r}" is not a known CLI action`);
      break;
    case "workflow":
      if (!host.workflowKnown(r)) flag(`workflow "${r}" is not known on this host`);
      break;
    case "invoke":
    case "invoke_chain":
      if (!host.agentInstalled(r)) flag(`agent "${r}" is not installed on this host`);
      break;
    case "in_session":
    case "manual":
      flag(`${route.path} responsible "${r}" should be a built-in (orchestrator/human)`);
      break;
  }
}

function driftFindings(compiled: RoutingPolicy, actual: RoutingPolicy, findings: RouteFinding[]): void {
  if (compiled.version !== actual.version || !isDeepStrictEqual(compiled.governance, actual.governance)) {
    findings.push({ code: "policy_drift", message: "policy header (version/governance) differs from the compiled RACI" });
  }
  for (const k of Object.keys(compiled.routes)) {
    if (!(k in actual.routes)) {
      findings.push({ code: "policy_drift", route: k, message: `route "${k}" is in the compiled RACI but missing from the policy` });
    } else if (!isDeepStrictEqual(compiled.routes[k], actual.routes[k])) {
      findings.push({ code: "policy_drift", route: k, message: `route "${k}" differs from the compiled RACI` });
    }
  }
  for (const k of Object.keys(actual.routes)) {
    if (!(k in compiled.routes)) {
      findings.push({ code: "policy_drift", route: k, message: `route "${k}" is in the policy but not in the compiled RACI` });
    }
  }
}
