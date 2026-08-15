// FG-560 (step 9): SHARED operator-surface rendering for the two model-policy
// provenance axes.
//
// mapping-path provenance (exact | default-fallback) is a SEPARATE axis from the
// profile-selection provenance (`resolvedBy`). This module is the ONE place every
// operator surface — `forge model resolve`, `forge show`, the dashboard consumers
// via the shared string — turns those axes into human/JSON text, so they cannot
// disagree. The load-bearing invariant: a default fallback is labelled DISTINCTLY
// on every surface and is NEVER rendered as though it satisfied an explicit
// activity (that combination is the activity_unmapped refusal, below).

import { ACTIVITY_UNMAPPED_REASON } from "./model-resolution.js";

/** A distinct, human-readable phrase for the mapping-path axis. `undefined` in
 *  legacy mode (no policy => no provenance), so a legacy surface renders nothing
 *  new. An exact hit reads plainly; a default fallback ALWAYS reads distinctly —
 *  and when the capability was EXPLICIT, it says so, since that is precisely the
 *  case a silent default would misrepresent. */
export function mappingPathSummary(
  mappingPath: string | undefined,
  capabilitySource: string | undefined,
): string | undefined {
  if (!mappingPath) return undefined; // legacy — no mapping-path axis at all
  if (mappingPath === "exact") {
    return capabilitySource === "explicit"
      ? "exact — the explicit activity is mapped directly in this profile"
      : "exact — the activity is mapped directly in this profile";
  }
  if (mappingPath === "default-fallback") {
    return capabilitySource === "explicit"
      ? "default-fallback — map.default (the EXPLICIT activity is NOT mapped in this profile)"
      : "default-fallback — map.default (no activity-specific mapping)";
  }
  // An unrecognized value (a newer forge wrote it): surface it verbatim rather
  // than swallowing it into one of the known phrasings.
  return `${mappingPath} (unrecognized mapping-path value)`;
}

/** True when persisted/derived provenance describes the activity_unmapped shape:
 *  an EXPLICIT activity that resolved only via map.default. Dispatch refuses this
 *  before spawning (provider-doctor.ts), so a normally-dispatched task row is
 *  never this — but a surface that reads one must still name it honestly rather
 *  than presenting a default fallback as a satisfied explicit activity. */
export function isActivityUnmappedProvenance(
  mappingPath: string | undefined,
  capabilitySource: string | undefined,
): boolean {
  return capabilitySource === "explicit" && mappingPath === "default-fallback";
}

/** The machine-readable refusal, with every field a script needs to act on it:
 *  the agent + activity that demanded a mapping, the profile that was selected and
 *  the rule that selected it, the mappings that DO exist, the default model that
 *  would have been used (labelled diagnostic-only so nothing treats it as the
 *  answer), and the policy path. Shared by every surface so they never diverge. */
export type ActivityUnmappedDetail = {
  reason: string;
  agent: string;
  activity: string;
  /** Selected profile. */
  profile: string;
  /** Profile-SELECTION provenance (`resolvedBy`) — a SEPARATE axis from mapping. */
  resolutionSource: string;
  /** The capability names this profile DOES map. */
  availableMappings: string[];
  /** The map.default model — surfaced ONLY as a diagnostic, never as dispatched. */
  diagnosticDefaultModel: string;
  /** Always true: names the field above as diagnostic-only for machine readers. */
  diagnosticOnly: true;
  /** The resolved policy file, or null when the surface cannot prove it (a
   *  persisted task read on another host). */
  policyPath: string | null;
  /** The shared human sentence (activityUnmappedMessage), for a one-line render. */
  message: string;
};

export function buildActivityUnmappedDetail(input: {
  agent: string;
  activity: string;
  profile: string;
  resolutionSource: string;
  availableMappings: string[];
  diagnosticDefaultModel: string;
  policyPath: string | null;
  message: string;
}): ActivityUnmappedDetail {
  return {
    reason: ACTIVITY_UNMAPPED_REASON,
    diagnosticOnly: true,
    ...input,
  };
}

/** The human refusal block — one labelled line per field, so an operator reading
 *  the terminal sees exactly what `--json` carries. */
export function renderActivityUnmapped(d: ActivityUnmappedDetail): string[] {
  return [
    `✗ ${d.reason}: explicit activity '${d.activity}' is not mapped in profile '${d.profile}'`,
    `    agent:              ${d.agent}`,
    `    activity:           ${d.activity} (explicit)`,
    `    selected profile:   ${d.profile}`,
    `    resolution source:  ${d.resolutionSource}`,
    `    available mappings: ${d.availableMappings.length ? d.availableMappings.join(", ") : "(none)"}`,
    `    default model:      ${d.diagnosticDefaultModel}  ⚠ DIAGNOSTIC ONLY — NOT dispatched for this explicit activity`,
    `    policy path:        ${d.policyPath ?? "(unknown — read from a persisted task row)"}`,
    `    fix: add a '${d.activity}' entry to profile '${d.profile}' map, or drop the explicit activity to accept the profile default.`,
  ];
}
