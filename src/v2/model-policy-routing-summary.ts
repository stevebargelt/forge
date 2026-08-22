// FG-346: the effective routing summary — computed from a RE-PARSED policy through
// the PRODUCTION resolver (resolveModel), never from the raw setup answers.
//
// Why re-parse: the answers and the written file can only be trusted to agree if the
// summary is derived the same way dispatch will actually resolve. So the caller loads
// the just-written policy via the production loader (loadModelPolicy: version gate +
// Zod) and hands the parsed ModelPolicy here; for each standard capability
// (defaults.activity key) and each notable role pin (overrides.agents key) we ask
// resolveModel — which itself re-loads the policy from `ctx` — what concrete profile
// and model it returns, and render the ticket's `Forge model routing:` block.

import type { ModelPolicy } from "./schema.js";
import type { LoadContext } from "./loader.js";
import { resolveModel } from "./model-resolution.js";

export type RoutingLine = { label: string; capabilityOrRole: string; profile: string; model: string };

// Friendly labels for the standard capabilities, in display order. Only those
// present in defaults.activity are rendered.
const CAPABILITY_LABELS: Array<[string, string]> = [
  ["default", "default work"],
  ["reasoning", "reasoning-heavy work"],
  ["review", "review"],
  ["fast", "fast work"],
  ["spec-writer", "spec authoring"],
  ["fast-orchestrator", "fast orchestration"],
];

// A role name that is not pinned in any generated policy, used to probe capability
// routing without an overrides.agents match interfering with profile selection.
const NEUTRAL_PROBE_ROLE = "__forge_setup_routing_probe__";

function prettyRole(role: string): string {
  return role.replace(/-/g, " ");
}

/** Compute the effective routing lines from a parsed policy, resolving each entry
 *  through the production resolver (which re-loads the policy from `ctx`). */
export function computeRoutingSummary(policy: ModelPolicy, ctx: LoadContext = {}): RoutingLine[] {
  const lines: RoutingLine[] = [];

  // Standard capabilities (defaults.activity), in the friendly display order.
  for (const [capability, label] of CAPABILITY_LABELS) {
    if (!(capability in policy.defaults.activity)) continue;
    const res = resolveModel({ agentRole: NEUTRAL_PROBE_ROLE, stepAlias: capability, ctx });
    lines.push({
      label,
      capabilityOrRole: capability,
      profile: res.profile ?? "(unresolved)",
      model: res.model,
    });
  }

  // Notable role pins (overrides.agents), in declared order.
  for (const role of Object.keys(policy.overrides.agents)) {
    const res = resolveModel({ agentRole: role, ctx });
    lines.push({
      label: prettyRole(role),
      capabilityOrRole: role,
      profile: res.profile ?? "(unresolved)",
      model: res.model,
    });
  }

  return lines;
}

/** Render the routing lines as the ticket's concise `Forge model routing:` block. */
export function renderRoutingSummary(lines: RoutingLine[]): string {
  const out = ["Forge model routing:"];
  if (lines.length === 0) {
    out.push("  (no capabilities or role pins configured)");
    return out.join("\n");
  }
  const width = Math.max(...lines.map((l) => l.label.length + 1)) + 2; // +1 for ':'
  for (const l of lines) {
    out.push(`  ${(l.label + ":").padEnd(width)}${l.profile}`);
  }
  return out.join("\n");
}
