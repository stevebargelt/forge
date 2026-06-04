// forge RACI — routing-policy schema.
//
// Typed schema for the DERIVED routing-policy.yml — the machine artifact the
// compiler (#276) emits and `forge route validate` (#278) checks. The RACI
// SOURCE (seeds/forge-raci.md) is parsed by parse.ts; this validates the
// compiled policy.
//
// Boring + uniform by design:
//   - governance.accountable is a HEADER invariant (literal "human"), never
//     per-route — a per-route `accountable` is rejected by .strict().
//   - `informed` is always normalized objects ({ name, when? }), never the
//     source's `name:when=cond` string form.
//   - `none` is a RACI-SOURCE sentinel and must NOT appear in the policy; the
//     compiler emits empty arrays instead.
//
// SHAPE validation only. Whether force_rules resolve to baseline IDs, or
// responsible/consulted name installed agents, is semantic — #277/#278.

import { z } from "zod";
import { ROUTE_PATHS } from "./types.js";

/** Symbol grammar — identical to the #274 source parser. */
const SYMBOL_RE = /^[a-z0-9_-]+$/;
const NONE_IN_POLICY =
  "'none' is a RACI-source sentinel and must not appear in the derived policy (use an empty array)";

/** A symbol value: lowercase letters, digits, hyphen, underscore; not `none`. */
const symbol = z
  .string()
  .regex(SYMBOL_RE, "expected a symbol [a-z0-9_-]+")
  .refine((s) => s !== "none", NONE_IN_POLICY);

const symbolList = z.array(symbol);

/** Route-map key — symbol syntax. Kept a plain ZodString so it's valid as a
 *  record key schema (route keys named "none" are an unlikely non-issue). */
const symbolKey = z.string().regex(SYMBOL_RE, "route key must be a symbol [a-z0-9_-]+");

/** A non-blank string — rejects "" and whitespace-only. */
const nonBlank = (msg: string) => z.string().refine((s) => s.trim().length > 0, msg);

/** classification_hints: advisory free phrases (spaces allowed), non-blank,
 *  not `none`, no conditionals. */
const hint = nonBlank("classification hint must be non-blank").refine(
  (s) => s !== "none",
  NONE_IN_POLICY,
);

/** informed target — normalized object form; optional symbolic condition. */
const InformedTargetSchema = z
  .object({
    name: symbol,
    when: symbol.optional(),
  })
  .strict();

const PolicyRouteSchema = z
  .object({
    classification_hints: z.array(hint).optional(),
    responsible: symbol,
    path: z.enum(ROUTE_PATHS),
    command: nonBlank("command must be non-blank").optional(),
    consulted: symbolList,
    required_followups: symbolList,
    informed: z.array(InformedTargetSchema),
    force_rules: symbolList,
  })
  .strict() // rejects any extra key — notably a per-route `accountable`
  .superRefine((route, ctx) => {
    if (route.path === "cli" && route.command === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "path 'cli' requires a command",
      });
    }
    if (route.path !== "cli" && route.command !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is only allowed for path 'cli'",
      });
    }
  });

const GovernanceSchema = z
  .object({
    accountable: z.literal("human"),
  })
  .strict();

export const RoutingPolicySchema = z
  .object({
    version: z.literal(1),
    governance: GovernanceSchema,
    routes: z
      .record(symbolKey, PolicyRouteSchema)
      .refine((r) => Object.keys(r).length > 0, "policy must define at least one route"),
  })
  .strict();

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export type PolicyRoute = z.infer<typeof PolicyRouteSchema>;
export type PolicyInformedTarget = z.infer<typeof InformedTargetSchema>;
