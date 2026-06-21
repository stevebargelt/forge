// FG-337: per-role capability flag.
//
// Narrative/triage roles produce human-readable text output and do not honor
// the structured result.json contract — they can use the inferred-result
// fallback when the runtime completes cleanly but writes no result.json.
// Structured roles (implementers, reds, specialists) always require a real
// result.json; missing it is a contract violation, not a recoverable state.
//
// No central role registry exists in the TypeScript layer (roles are declared
// in seeds/agents/<name>/CLAUDE.md). Smallest mechanism: a closed Set of the
// narrative roles, with the default being requiresStructuredResult=true.

const NARRATIVE_ROLES = new Set([
  "research-specialist",
  "prompt-author",
  "manual-qa",
]);

export function requiresStructuredResult(role: string): boolean {
  return !NARRATIVE_ROLES.has(role);
}
