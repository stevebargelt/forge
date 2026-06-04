// forge RACI — fixed vocabularies. Host-INDEPENDENT sets shared by the authoring
// lint (#277) and, later, operational validation (#278). Kept in one module
// rather than scattered constants so both validators draw from one source.

/** Controlled `informed` vocabulary — post-work record/surface targets. A RACI
 *  `informed` name must be one of these (host-independent; enforced by #277). */
export const INFORMED_TARGETS: ReadonlySet<string> = new Set([
  "user_summary",
  "backlog",
  "handoff_notes",
  "docs_impact",
  "notification",
  "routing_log",
  "event_log",
  "ops_check",
  "dashboard",
  "website",
]);

/** Known evidence sources a `consulted` entry may name (as opposed to an agent
 *  role). Defined here for #278's agent-vs-evidence resolution; NOT enforced by
 *  the authoring lint — `consulted` is shape-only in #277. */
export const EVIDENCE_SOURCES: ReadonlySet<string> = new Set([
  "affected_code",
  "existing_tests",
  "ops_incident",
  "design_artifacts",
]);

/** Symbols always valid regardless of host — no resolution needed. */
export const BUILTIN_SYMBOLS: ReadonlySet<string> = new Set(["human", "orchestrator"]);

/** Fixed CLI-action registry — maps a `path: cli` route's `responsible` symbol to
 *  the literal `command` it must carry. route validate (#278) checks BOTH: the
 *  symbol is known AND the route's command matches the registered invocation. */
export const CLI_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["forge-ops-repair", "forge ops repair"],
]);

/** Static force-rule baseline. PLACEHOLDER: routing-scoped force rules are not
 *  yet defined (the seed uses `force_rules: none` everywhere), so this is empty.
 *  While empty, force-rule resolution is DORMANT — validators must not pretend a
 *  baseline exists. Populate when routing force rules are introduced. */
export const FORCE_RULES_BASELINE: ReadonlySet<string> = new Set<string>([]);
