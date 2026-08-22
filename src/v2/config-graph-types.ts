// FG-349: the versioned, independently-governed contract for the dashboard
// Control-Plane surface (Sources + Provider/Runtime Capability panels) and the
// `forge config graph --json` CLI. This module is the ONE presentation
// vocabulary shared by every consumer (dashboard, campaign reports, operator
// addons, CLI). It is deliberately a CONTRACT type distinct from the internal
// resolver types it projects — and it imports NO resolver, so the vocabulary
// can be versioned without dragging resolver internals across the boundary.
//
// Vocabulary axes (kept aligned with ControlPlaneReceipt in task-manifest.ts so
// the EFFECTIVE view here and the RECORDED view there never teach two mental
// models):
//   SOURCE    — human-authored config.
//   DERIVED   — Forge-compiled/generated config.
//   EFFECTIVE — the config Forge would use NOW for this project (live).
//   RECORDED  — historical config captured when a run/task dispatched.
//
// A projection into this vocabulary must NEVER erase the origin or the
// uncertainty of the native resolver verdict it came from: every row/cell keeps
// that verdict VERBATIM in a `native` field.

/** How much confidence the truth axis carries — see the module header. */
export type TruthAxis = "SOURCE" | "DERIVED" | "EFFECTIVE" | "RECORDED";
export const TRUTH_AXES: readonly TruthAxis[] = ["SOURCE", "DERIVED", "EFFECTIVE", "RECORDED"];

/** The one status vocabulary every Sources row projects into. */
export type RowStatus =
  | "active"
  | "absent"
  | "overridden"
  | "template-only"
  | "derived"
  | "stale"
  | "missing"
  | "warning";
export const ROW_STATUSES: readonly RowStatus[] = [
  "active",
  "absent",
  "overridden",
  "template-only",
  "derived",
  "stale",
  "missing",
  "warning",
];

/** Declared PER SURFACE, so "fully replaces host" is a data property, never a
 *  hardcoded string. A surface that adopts merge semantics later declares
 *  `merge` here and the view labels it correctly with no code change. */
export type OverrideSemantics = "full-replacement" | "merge" | "none";
export const OVERRIDE_SEMANTICS: readonly OverrideSemantics[] = ["full-replacement", "merge", "none"];

/** Capability-fact provenance (FG-401). Distinguishes a configured fact from a
 *  host-detected one from an inferred (would-be-container) one from an
 *  unavailable/unknown one — reusing this vocabulary rather than a second one. */
export type CapabilityProvenance = "configured" | "detected" | "inferred" | "unavailable" | "unknown";
export const CAPABILITY_PROVENANCE: readonly CapabilityProvenance[] = [
  "configured",
  "detected",
  "inferred",
  "unavailable",
  "unknown",
];

/** Prerequisite / provider readiness (FG-401). */
export type Readiness = "available" | "unavailable" | "deferred" | "unknown";
export const READINESS_STATES: readonly Readiness[] = ["available", "unavailable", "deferred", "unknown"];

/** Where a fact was actually witnessed. Host-process facts are `host-observed`;
 *  a fact about the would-be run CONTAINER is `inferred`, never asserted as
 *  witnessed availability. */
export type ObservedBy = "host-observed" | "inferred";

/** One provenance row for a config surface in the Sources panel. Projects an
 *  existing resolver's native verdict into the vocabulary while carrying it
 *  verbatim in `native`. */
export type ConfigRow = {
  /** Stable surface id, e.g. "workflow", "model-policy", "docs-surfaces". */
  key: string;
  /** Human-facing label. */
  label: string;
  truth: TruthAxis;
  status: RowStatus;
  /** Source file path(s) — human-authored inputs to this surface. */
  sourcePaths: string[];
  /** The file Forge would actually use now (EFFECTIVE), when there is one. */
  effectivePath?: string;
  overrideSemantics: OverrideSemantics;
  /** The explicit replacement/merge callout, e.g.
   *  "project .forge/model-policy.yml active — fully replaces host ~/.forge/model-policy.yml".
   *  A DATA property so the client renders it verbatim, never composes it. */
  overrideCallout?: string;
  detail?: string;
  warning?: string;
  /** The owning resolver's native verdict, verbatim — never re-derived here. */
  native: unknown;
};

export type SourcesSection = {
  rows: ConfigRow[];
};

/** One provider/runtime auth row (FG-401). Presence/availability only — never
 *  a secret value. Host-observed. */
export type ProviderRow = {
  provider: string;
  /** EffectiveAuth mode ("subscription" | "api" | "bedrock"). */
  mode: string;
  readiness: Readiness;
  provenance: CapabilityProvenance;
  /** Redaction-clean; names the env var / mechanism and whether it is present. */
  detail: string;
  observedBy: ObservedBy;
  native: unknown;
};

/** One capability-matrix cell (FG-401), per (capability, adapter). */
export type CapabilityRow = {
  capability: string;
  adapter: string;
  title: string;
  /** Native support literal (supported | partial | evidence-gated | unsupported). */
  support: string;
  provenance: CapabilityProvenance;
  limitation?: string;
  observedBy: ObservedBy;
  native: unknown;
};

/** A workflow-prerequisite readiness row (FG-401): Shipping Reviewer, Campaign
 *  Runner, etc. Every state carries a reason. */
export type PrerequisiteRow = {
  name: string;
  readiness: Readiness;
  reason: string;
  observedBy: ObservedBy;
  native: unknown;
};

export type CapabilitiesSection = {
  providers: ProviderRow[];
  capabilities: CapabilityRow[];
  prerequisites: PrerequisiteRow[];
};

/** Top-level project identity + reachability, mirrored from path-identity. */
export type ProjectIdentity = {
  dir: string;
  status: RowStatus;
  detail?: string;
  native: unknown;
};

/** The versioned, panel-partitioned contract both the CLI and the dashboard
 *  consume UNMODIFIED. Additional panels (RACI audit, model matrix, runtime
 *  readiness, agents/workflows, seed drift, orchestrator sessions) attach as
 *  further keys under `sections` without restructuring this type. */
export type ConfigGraph = {
  version: number;
  project: ProjectIdentity;
  forgeHome: string;
  sections: {
    sources: SourcesSection;
    capabilities: CapabilitiesSection;
  };
};

export const CONFIG_GRAPH_VERSION = 1;

/** Map a native resolver verdict into the presentation vocabulary while keeping
 *  it VERBATIM. The mapping supplies the projected fields (at minimum a
 *  status/readiness/provenance); the native verdict is carried unchanged so no
 *  consumer has to trust the projection over the source of truth. */
export function project<N, M extends object>(native: N, mapping: M): M & { native: N } {
  return { ...mapping, native };
}
