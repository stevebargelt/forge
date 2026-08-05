// FG-679: pure decision logic for the `Current activity` surface, split out of
// main.js so it is unit-testable with the node test runner — the same pattern as
// verification-render.js, and for the same reason: the FG-487 review found that
// badge/label logic living only inline in main.js had zero coverage, which is
// exactly where a producer/renderer field mismatch hides behind a green suite.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE (BD-4). It NEVER composes a status
// string. `statusLabel` arrives from the server already rendered by
// src/v2/launch.ts's `statusLine` — the ONE human rendering of the launch status
// vocabulary — and this module passes it through byte-for-byte. So
// `terminated by SIGTERM (signal sender not recorded — origin unknown)`, a bare
// `exited 143 (signal-range code, no signal evidence — origin unknown)`,
// `owner gone without an exit record (…)` and `unknown (no exit record, owner gone
// — e.g. host reboot)` stay FOUR DIFFERENT FACTS on the dashboard. Flattening any
// of them into a generic `failed` badge is a regression in honesty and is
// prohibited — which is also why the CSS classes below are keyed on the structured
// state and none of them is named `failed`.

/** Badge class for a host-verification launch. Keyed on the STRUCTURED state, never
 *  on a substring of the rendered label, and deliberately never `status-failed`:
 *  the four terminal-ish dispositions are four different facts, not one failure. */
export function launchBadgeClass(entry) {
  if (!entry || typeof entry !== "object") return "launch-state-unknown";
  if (entry.observation === "unobserved") return "launch-state-unobserved";
  const state = entry.status && entry.status.state;
  switch (state) {
    case "running": return "launch-state-running";
    case "exited_ok": return "launch-state-exited_ok";
    case "exited_error": return "launch-state-exited_error";
    case "signaled": return "launch-state-signaled";
    case "terminated_unattributed": return "launch-state-terminated_unattributed";
    case "owner_gone": return "launch-state-owner_gone";
    default: return "launch-state-unknown";
  }
}

/** The badge TEXT. Always the server-rendered `statusLabel`, verbatim. An entry with
 *  no label at all reads as the explicit absence of an observation, never as a
 *  fabricated disposition. */
export function launchBadgeText(entry) {
  const label = entry && entry.statusLabel;
  return typeof label === "string" && label !== "" ? label : "not observed";
}

export function launchBadge(entry) {
  return { class: launchBadgeClass(entry), text: launchBadgeText(entry) };
}

/** BD-3: a launch placed by anything weaker than explicit submission metadata is
 *  LABELED, not silently attributed. Returns null when the placement was authorized. */
export function launchAssociationLabel(entry) {
  if (!entry || typeof entry !== "object") return null;
  return entry.unassociated ? "unassociated" : null;
}

/** The identity line under a launch row. Identity only — no host filesystem path is
 *  carried on the record, and none is rendered or linked (BD-10). */
export function launchIdentityLine(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [entry.launchId];
  if (entry.runId) parts.push(`run ${entry.runId}`);
  if (entry.taskId) parts.push(`task ${entry.taskId}`);
  if (entry.ticketId) parts.push(entry.ticketId);
  if (entry.campaignId) parts.push(`campaign ${entry.campaignId}`);
  if (entry.projectLabel) parts.push(entry.projectLabel);
  return parts.join(" · ");
}

/** BD-8: `CI not observed` is a DIFFERENT FACT from `CI not running`. The first is
 *  about the observer, the second is about the checks. This is the section-level
 *  answer for "nothing has ever been observed". */
export function ciSectionLabel(section) {
  if (!section || typeof section !== "object") return "CI not observed";
  return section.state === "observed" ? null : (section.label || "CI not observed");
}

export function ciBadgeClass(observation) {
  if (!observation || typeof observation !== "object") return "ci-state-not_observed";
  switch (observation.state) {
    case "running": return "ci-state-running";
    case "not_running": return "ci-state-not_running";
    case "stale": return "ci-state-stale";
    default: return "ci-state-not_observed";
  }
}

export function ciBadgeText(observation) {
  const label = observation && observation.label;
  return typeof label === "string" && label !== "" ? label : "CI not observed";
}

/** BD-5: a summary verdict does not satisfy the requirement — every required context
 *  is enumerated with its own state, URL and observation time. An observation that
 *  carries none says so explicitly rather than reading as "all green". */
export function ciContextRows(observation) {
  const contexts = observation && Array.isArray(observation.contexts) ? observation.contexts : [];
  return contexts.map((c) => ({
    context: c.context,
    state: c.state,
    url: typeof c.url === "string" && c.url !== "" ? c.url : null,
    observedAt: c.observedAt || "",
    class: ciContextClass(c.state),
  }));
}

export function ciContextClass(state) {
  if (typeof state !== "string") return "ci-ctx-unknown";
  if (/^(pending|queued|in_progress|waiting)$/i.test(state)) return "ci-ctx-pending";
  if (/^(success|passed|neutral)$/i.test(state)) return "ci-ctx-success";
  if (/^(failure|failed|timed_out|cancelled|action_required)$/i.test(state)) return "ci-ctx-failure";
  return "ci-ctx-unknown";
}

/** Whether the surface has anything to show at all — used to pick the empty copy
 *  without ever implying "nothing is happening" when what we mean is "nothing was
 *  observed". */
export function activityIsEmpty(activity) {
  if (!activity || typeof activity !== "object") return true;
  const agents = Array.isArray(activity.agents) ? activity.agents : [];
  const launches = Array.isArray(activity.hostVerification) ? activity.hostVerification : [];
  const unassociated = Array.isArray(activity.unassociated) ? activity.unassociated : [];
  const ci = activity.requiredCi && Array.isArray(activity.requiredCi.observations) ? activity.requiredCi.observations : [];
  return agents.length === 0 && launches.length === 0 && unassociated.length === 0 && ci.length === 0;
}

export function activityCounts(activity) {
  const a = activity && typeof activity === "object" ? activity : {};
  return {
    agents: Array.isArray(a.agents) ? a.agents.length : 0,
    hostVerification: Array.isArray(a.hostVerification) ? a.hostVerification.length : 0,
    requiredCi: a.requiredCi && Array.isArray(a.requiredCi.observations) ? a.requiredCi.observations.length : 0,
    unassociated: Array.isArray(a.unassociated) ? a.unassociated.length : 0,
  };
}
