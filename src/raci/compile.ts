// forge RACI — compiler: source record blocks -> derived routing policy.
//
// Pure transform from the parsed RACI (RouteRecord[], parse.ts) into the typed
// RoutingPolicy (policy-schema.ts). The two halves align by construction
// (#274/#275): same symbol grammar, same { name, when? } informed shape, [] where
// the source had `none`. Compilation is therefore mostly mechanical:
//   - hoist `accountable` to the governance HEADER; never emit it per-route
//   - source `none` lists are already [] from the parser
//   - keep `informed` normalized; include `command` only on cli routes
//   - one policy route per RACI route, source order preserved
//
// The output is validated against RoutingPolicySchema before returning. No file
// writing, no host resolution, no drift checks (#277/#278).

import { type RouteRecord } from "./types.js";
import { parseRaci } from "./parse.js";
import { RoutingPolicySchema, type RoutingPolicy } from "./policy-schema.js";

/** Compile parsed RACI route records into a validated routing policy. */
export function compileRaciToPolicy(records: RouteRecord[]): RoutingPolicy {
  const routes: Record<string, unknown> = {};
  for (const r of records) {
    routes[r.route] = {
      classification_hints: r.classificationHints,
      responsible: r.responsible,
      path: r.path,
      ...(r.command !== undefined ? { command: r.command } : {}),
      consulted: r.consulted,
      required_followups: r.requiredFollowups,
      informed: r.informed.map((t) =>
        t.when === undefined ? { name: t.name } : { name: t.name, when: t.when },
      ),
      force_rules: r.forceRules,
      // `accountable` is intentionally NOT emitted per-route — hoisted below.
    };
  }

  const policy = {
    version: 1,
    governance: { accountable: "human" },
    routes,
  };

  // Belt-and-suspenders: the emitted object must satisfy the #275 schema.
  return RoutingPolicySchema.parse(policy);
}

/** Parse a RACI document and compile it to a validated routing policy. */
export function compileRaciDocument(content: string): RoutingPolicy {
  return compileRaciToPolicy(parseRaci(content));
}
