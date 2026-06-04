// forge RACI — record-block format types.
//
// The RACI (seeds/forge-raci.md) is the human-authored SOURCE; it compiles to
// routing-policy.yml (the derived machine artifact). See
// docs/prds/raci-routing-policy.md.
//
// This module owns the parsed in-memory shape of a RACI route block plus the
// route-path vocabulary. Grammar enforcement lives in parse.ts. Semantic
// validation against the host and the force-rule baseline (do force_rules
// resolve? does responsible name an installed agent?) is a separate concern —
// `forge raci validate` / `forge route validate` (stories #277/#278).

export const ROUTE_PATHS = [
  "in_session",
  "invoke",
  "invoke_chain",
  "workflow",
  "manual",
  "cli",
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];

/** An `informed` target, optionally conditional (`name:when=condition`). */
export type InformedTarget = {
  name: string;
  when?: string;
};

/** One parsed RACI route block. */
export type RouteRecord = {
  route: string;
  /** Advisory classification hints — never code-dispatched. */
  classificationHints: string[];
  responsible: string;
  /** Always "human" — enforced at parse time (visible governance reminder). */
  accountable: "human";
  path: RoutePath;
  /** Present iff path === "cli" — the literal invocation. */
  command?: string;
  consulted: string[];
  requiredFollowups: string[];
  informed: InformedTarget[];
  forceRules: string[];
};
