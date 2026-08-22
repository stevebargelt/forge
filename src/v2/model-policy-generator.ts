// FG-346: GENERATE a host model-policy.yml from setup answers — the ASK-and-
// GENERATE half FG-252 called for and never shipped. Pure: answers in, an explicit
// reviewable YAML string (+ the validated policy object) out. No IO.
//
// What it guarantees (the invariants a parser-valid-but-broken policy would miss):
//   - every model id and profile name comes from the CATALOG, nothing free-text;
//   - every overrides.agents key is a REAL agent role (isKnownRole) — a typo'd role
//     that would silently never fire is REJECTED here, not at dispatch;
//   - every referenced profile (defaults / activity / pins) is one that was actually
//     offered — an invalid selection throws rather than producing a dangling ref;
//   - each generated profile map RESOLVES every capability that can route to it (the
//     four standard capabilities + `default` + any extra activity keys), so the
//     resolver never falls through unexpectedly;
//   - runtime-fronted (pi/groq) profiles carry `runtime:` and mark entries
//     tool_capable: true, so dispatch's checkToolCapability does not refuse them;
//   - the document carries schema_version: 2 explicitly and a generated-by header,
//     so it round-trips through the production loader (version gate + Zod) and is not
//     mistaken for a hand-authored file.

import { stringify as stringifyYaml } from "yaml";
import { ModelPolicySchema, type ModelPolicy, type CostTier } from "./schema.js";
import {
  costTierForFamily,
  isKnownRole,
  isRuntimeFronted,
  runtimeForProvider,
} from "./model-policy-catalog.js";
import type { ProfileChoice } from "./model-policy-choices.js";

// The capabilities every generated profile maps, so any role-derived capability
// (red-* → review, tech-lead / architecture-advisor → reasoning, research-* → default)
// resolves to an EXACT map entry rather than falling through. Extra activity keys
// (spec-writer / fast-orchestrator) are added per policy when present.
const BASE_CAPABILITIES = ["reasoning", "review", "fast", "default"] as const;

export type GenerateInput = {
  /** The offerable choices (superset). Referenced profiles are resolved from here. */
  choices: ProfileChoice[];
  /** defaults.profile — the ultimate fallback. */
  defaultProfile: string;
  /** capability -> profileName (defaults.activity). */
  activity: Record<string, string>;
  /** agent role -> profileName (overrides.agents). Keys must be real roles. */
  rolePins: Record<string, string>;
};

export type GenerateResult = {
  /** Explicit, reviewable YAML with a generated-by header. */
  yaml: string;
  /** The validated policy object (ModelPolicySchema.parse of the built document).
   *  For early error detection / convenience only — the routing summary is computed
   *  from a RE-PARSED policy loaded via the production loader, never from this. */
  policy: ModelPolicy;
};

export class InvalidSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectionError";
  }
}

function capabilityEntry(choice: ProfileChoice): { model: string; cost_tier: CostTier; tool_capable?: boolean } {
  const entry: { model: string; cost_tier: CostTier; tool_capable?: boolean } = {
    model: choice.model,
    cost_tier: costTierForFamily(choice.family),
  };
  // Runtime-fronted (pi/groq) upstreams are guilty-until-proven-innocent at
  // dispatch — a structured role is refused unless the entry is tool_capable.
  if (isRuntimeFronted(choice.provider)) entry.tool_capable = true;
  return entry;
}

export function generateModelPolicy(input: GenerateInput): GenerateResult {
  const byName = new Map(input.choices.map((c) => [c.profileName, c] as const));

  const referenced = new Set<string>([
    input.defaultProfile,
    ...Object.values(input.activity),
    ...Object.values(input.rolePins),
  ]);

  // Reject a dangling reference to a profile that was never offered.
  for (const name of referenced) {
    if (!byName.has(name)) {
      throw new InvalidSelectionError(
        `selected profile '${name}' is not among the offered choices ` +
          `(offered: ${[...byName.keys()].join(", ") || "none"})`,
      );
    }
  }

  // Reject any override key that is not a real agent role (a typo'd role parses
  // clean and silently never fires — catch it here).
  for (const role of Object.keys(input.rolePins)) {
    if (!isKnownRole(role)) {
      throw new InvalidSelectionError(
        `overrides.agents key '${role}' is not a known agent role (a role is a seeds/agents/<role> directory)`,
      );
    }
  }

  // The capabilities each profile must map: the base four + any extra activity keys.
  const activityCapabilities = new Set<string>([...BASE_CAPABILITIES, ...Object.keys(input.activity)]);

  const model_profiles: Record<string, unknown> = {};
  for (const name of [...referenced].sort()) {
    const choice = byName.get(name)!;
    const map: Record<string, unknown> = {};
    for (const cap of activityCapabilities) {
      map[cap] = capabilityEntry(choice);
    }
    const profile: Record<string, unknown> = {
      provider: choice.provider,
      auth: choice.auth,
    };
    const runtime = runtimeForProvider(choice.provider);
    if (runtime) profile.runtime = runtime;
    profile.map = map;
    model_profiles[name] = profile;
  }

  // Build the document with a deliberate key order for a readable file.
  const doc: Record<string, unknown> = {
    schema_version: 2,
    on_unavailable: "fail",
    model_profiles,
    defaults: {
      profile: input.defaultProfile,
      activity: { ...input.activity },
    },
    overrides: {
      agents: { ...input.rolePins },
    },
    allowed_profiles: [...referenced].sort(),
  };

  // Validate the built document (catches any structural mistake before we render).
  const parsed = ModelPolicySchema.safeParse(doc);
  if (!parsed.success) {
    throw new InvalidSelectionError(
      `generated policy failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const yaml = HEADER + stringifyYaml(doc, { lineWidth: 0 });
  return { yaml, policy: parsed.data };
}

const HEADER =
  "# forge model-policy — GENERATED by `forge setup` (FG-346).\n" +
  "# Reconfigure with `forge setup --reconfigure`. Direct YAML editing is the expert\n" +
  "# escape hatch, not the primary path — regenerating overwrites hand edits.\n" +
  "# Profiles are named <provider>-<auth>-<model-family> with concrete, seed-derived model ids.\n";
