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

import { formatDuration } from "./duration.js";

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

/** Whether the PAYLOAD carries any row at all.
 *
 *  NOT the authority for Home's empty state since FG-694 — `homeActivityView().empty`
 *  is. This looks only at row counts, so a `not_observed` CI section (current work
 *  exists, no observation recorded) reads as empty here while Home correctly reports
 *  `CI status unavailable`. Kept for the payload-level diagnostic it names. */
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

// ───────────────────────────── FG-694 ─────────────────────────────
//
// Everything above answers "what does this observation say?". Everything below
// answers the two questions FG-694 found Home getting wrong, and they are the SAME
// question pointed in opposite directions:
//
//   1. What may Home CLAIM about work? (AC4/AC6) — the audit payload rendered raw
//      turned ten terminal tickets with ten check rows apiece into "Current
//      activity". Home gets ONE compact line per current candidate; the per-context
//      evidence is not deleted, it moves behind a disclosure (AC5).
//   2. What may Home CLAIM when it has no payload at all? (AC7) — a 404 from a
//      pre-FG-679 server left `activity === null`, and the surface answered
//      `No agent task in flight` / `No host launch observed in flight` /
//      `CI not observed` — three observations, from zero observations. Those four
//      strings (with `Nothing currently running.`) are FACTS ABOUT THE WORLD. A
//      request that failed has looked at nothing and may not say any of them.
//
// The load state is therefore modeled explicitly — loading / ready / unavailable —
// rather than as "activity is null". Null is not a state; it is the absence of one,
// and it is exactly what let a failure read as an observation.

/** The surface-level failure copy. Deliberately about the SURFACE ("we could not
 *  read current activity"), never about the work ("nothing is running"). */
export const CURRENT_ACTIVITY_UNAVAILABLE_LABEL = "Current activity unavailable";
export const CURRENT_ACTIVITY_LOADING_LABEL = "Loading current activity…";

/** The one calm statement for a SUCCESSFUL read that found nothing current (AC6).
 *  Reachable only from a payload we actually parsed. */
export const NOTHING_RUNNING_LABEL = "Nothing currently running.";

/** Compact CI vocabulary for Home. `CI not observed` is NOT in it: FG-694 makes
 *  that a diagnostic-surface string, because host-wide it was reading as a fact
 *  about the checks rather than about the observer. */
export const CI_NOT_STARTED_LABEL = "CI not started";
export const CI_STATUS_UNAVAILABLE_LABEL = "CI status unavailable";
export const CI_RUNNING_LABEL = "CI running";
export const CI_FAILED_LABEL = "CI failed";
export const CI_PASSED_LABEL = "CI passed";

/** The four strings a failed/absent read may never produce. Exported so the test
 *  asserts against the SAME list the renderer is written against, rather than a
 *  second copy that can drift out of agreement with it. */
export const OBSERVATION_CLAIMS = [
  "No agent task in flight",
  "No host launch observed",
  "CI not observed",
  NOTHING_RUNNING_LABEL,
];

/** The load state before anything has been read. A frozen singleton so `===` is a
 *  usable identity check and no caller can mutate the initial state. */
export const ACTIVITY_LOADING = Object.freeze({ phase: "loading" });

/** How a read FAILED. Kept structured — the reason drives the operator-facing
 *  detail line, and `http` carries its status so a 404 can say the one useful thing
 *  about it (the server predates the route). */
export function activityUnavailable(reason, status = null) {
  return Object.freeze({ phase: "unavailable", reason, status: typeof status === "number" ? status : null });
}

/** Is this actually a current-activity payload? A 200 carrying an HTML error page,
 *  an empty object, or a truncated body is NOT missing data we can render around —
 *  it is a read that failed, and saying so is the whole of AC7.
 *
 *  Deliberately shape-only, and deliberately tolerant of a payload from an OLDER
 *  server: `requiredCi.state` is not checked against the three known values, so a
 *  server that predates FG-694's `no_current_candidate` still reads as valid. The
 *  renderer treats an unrecognized state conservatively. */
export function isCurrentActivityPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Array.isArray(value.agents)) return false;
  if (!Array.isArray(value.hostVerification)) return false;
  const ci = value.requiredCi;
  if (!ci || typeof ci !== "object" || Array.isArray(ci)) return false;
  if (typeof ci.state !== "string" || ci.state === "") return false;
  return Array.isArray(ci.observations);
}

/** A parsed response body → a load state. The ONLY door from a network read into
 *  `ready`, so nothing can render as observed without having passed validation. */
export function activityFromBody(body) {
  if (!isCurrentActivityPayload(body)) return activityUnavailable("malformed");
  return { phase: "ready", activity: body };
}

/** How long an unanswered read may stay "loading" before it is a FAILED read.
 *  Generous relative to the 2s poll — the route reads persisted state only — but
 *  bounded, because "still loading" forever is how the surface said nothing while
 *  the operator waited for it to say something. */
export const CURRENT_ACTIVITY_TIMEOUT_MS = 8000;

/** The ONE door between the network and the surface, and the whole of AC7.
 *
 *  The defect it exists to prevent: the poll used to ignore a non-OK response, leave
 *  `activity` at null, and let the renderer read that null as "we looked and found
 *  nothing" — so a dashboard server predating the route answered 404 and Home
 *  reported `No agent task in flight`, `No host launch observed in flight` and `CI
 *  not observed` while `forge status` showed an active orchestrator task.
 *
 *  Every failure mode resolves to an explicit `unavailable`, and nothing resolves to
 *  `ready` without a body that validated. It NEVER rejects: its failure is its
 *  return value, so no caller can drop it on the floor.
 *
 *  Lives here rather than in main.js so the failure modes are exercised through the
 *  code that ships, not through a re-implementation of it in a test. */
export async function readCurrentActivity(url, fetchImpl, timeoutMs = CURRENT_ACTIVITY_TIMEOUT_MS) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (doFetch === null) return activityUnavailable("network");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res || res.ok !== true) {
      return activityUnavailable("http", res ? res.status : null);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return activityUnavailable("malformed");
    }
    return activityFromBody(body);
  } catch (e) {
    return activityUnavailable(e && e.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

export function activityPhase(load) {
  if (!load || typeof load !== "object") return "loading";
  if (load.phase === "ready" && isCurrentActivityPayload(load.activity)) return "ready";
  if (load.phase === "unavailable") return "unavailable";
  if (load.phase === "ready") return "unavailable"; // a `ready` with no readable payload is not ready
  return "loading";
}

/** What went wrong, in operator words. Never speculates about the WORK — only about
 *  the read. The 404 hint names the version-skew case FG-694 reproduced: a dashboard
 *  server started before FG-679 serves this client and 404s the route. */
export function activityUnavailableDetail(load) {
  const reason = load && typeof load === "object" ? load.reason : undefined;
  const status = load && typeof load === "object" && typeof load.status === "number" ? load.status : null;
  switch (reason) {
    case "http":
      return status === 404
        ? "/api/current-activity answered 404 — this dashboard server predates the route; restart it from the current forge."
        : `/api/current-activity answered ${status === null ? "an error" : status}.`;
    case "malformed":
      return "/api/current-activity answered with a body this client could not read.";
    case "timeout":
      return "/api/current-activity did not answer in time.";
    case "network":
      return "/api/current-activity could not be reached.";
    default:
      return "/api/current-activity could not be read.";
  }
}

/** Elapsed since a start time, or an explicit dash. A start time we cannot read — or
 *  one AHEAD of the reader's clock (host/browser skew) — is not an elapsed duration,
 *  and a negative one would be a small lie on a surface whose whole job is not to
 *  tell them. */
export function caElapsedText(startedAt, now) {
  if (!startedAt) return "—";
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return `⏱ ${formatDuration(ms)}`;
}

/** How a candidate is NAMED on Home. The ticket id when the observer recorded one;
 *  otherwise the short sha. Never the full 40-char sha — that is drill-down detail
 *  (AC4), and it is still rendered in full once the operator opens it (AC5). */
export function ciCandidateLabel(observation) {
  if (!observation || typeof observation !== "object") return null;
  const ticket = observation.ticketId;
  if (typeof ticket === "string" && ticket !== "") return ticket;
  const sha = observation.candidateSha;
  return typeof sha === "string" && sha !== "" ? sha.slice(0, 7) : null;
}

function contextNameList(rows) {
  const names = rows.map((r) => r.context).filter((n) => typeof n === "string" && n !== "");
  if (names.length === 0) return null;
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

/** ONE compact line for ONE current candidate (AC4):
 *
 *      FG-253 · CI running · 7/10 complete
 *      FG-253 · CI failed · test-extended
 *
 *  The state is read off the CONTEXTS, which are observed facts, not composed from
 *  prose. Two deliberate choices:
 *
 *  - a failing required context outranks pending ones. `CI failed` with checks still
 *    queued is accurate — a required check has failed — and it is the fact an
 *    operator acts on. The pending count is still there under the disclosure.
 *  - `stale` and `unavailable` both collapse to `CI status unavailable`, because
 *    both mean the same thing to a reader of NOW: we do not know. What made it
 *    unknown (last observation time, the unavailable reason) is detail, not summary,
 *    and AC4 bans raw observation timestamps from the summary line. */
export function ciCompactSummary(observation) {
  const rows = ciContextRows(observation);
  const total = rows.length;
  const failing = rows.filter((r) => r.class === "ci-ctx-failure");
  const pending = rows.filter((r) => r.class === "ci-ctx-pending");
  const identity = ciCandidateLabel(observation);
  const o = observation && typeof observation === "object" ? observation : {};
  const unreadable = o.state === "stale" || o.outcome === "unavailable"
    || (typeof o.unavailableReason === "string" && o.unavailableReason !== "");

  let state;
  let label;
  let detail = null;
  if (unreadable) {
    state = "unavailable";
    label = CI_STATUS_UNAVAILABLE_LABEL;
  } else if (failing.length > 0) {
    state = "failed";
    label = CI_FAILED_LABEL;
    detail = contextNameList(failing);
  } else if (pending.length > 0 || o.state === "running") {
    state = "running";
    label = CI_RUNNING_LABEL;
    detail = total > 0 ? `${total - pending.length}/${total} complete` : null;
  } else if (total === 0) {
    // The observer looked at this candidate and enumerated no required context. That
    // is "no check has been created yet", which is a different fact from "we have not
    // looked" — and the one string AC7 reserves for it.
    state = "not_started";
    label = CI_NOT_STARTED_LABEL;
  } else if (rows.every((r) => r.class === "ci-ctx-success")) {
    state = "passed";
    label = CI_PASSED_LABEL;
    detail = `${total}/${total} complete`;
  } else {
    // Mixed or vocabulary we do not recognize. The server's own label is the honest
    // answer; this module does not invent one for a state it cannot classify.
    state = "not_running";
    label = typeof o.label === "string" && o.label !== "" ? o.label : CI_STATUS_UNAVAILABLE_LABEL;
  }
  return { identity, state, label, detail, class: `ci-compact-${state}`, observation: observation ?? null };
}

/** The CI block for Home, or `null` for "render no CI row at all".
 *
 *  `no_current_candidate` returns null — nothing in scope could be waiting on
 *  required checks, so there is nothing to report and no observation was missed. An
 *  ABSENT or unrecognized section returns null for the same reason: silence is the
 *  only honest output when we do not know what we are looking at. */
export function homeCiSummaries(section) {
  if (!section || typeof section !== "object") return null;
  if (section.state === "no_current_candidate") return null;
  const observations = Array.isArray(section.observations) ? section.observations : [];
  if (observations.length > 0) return observations.map(ciCompactSummary);
  if (section.state === "not_observed") {
    // There IS current work owed an observation and we have none. Home says the
    // status is unavailable — NOT `CI not observed`, which host-wide read as a claim
    // about the checks, and not `CI not started`, which we have no evidence for.
    return [{
      identity: null,
      state: "unavailable",
      label: CI_STATUS_UNAVAILABLE_LABEL,
      detail: null,
      class: "ci-compact-unavailable",
      observation: null,
    }];
  }
  return null;
}

/** The WHOLE Home decision, as data. The component is a rendering of this and adds
 *  no decisions of its own — which is what lets the AC7 tests assert over rendered
 *  output and over this model and have them mean the same thing.
 *
 *  `sections` carries ONLY non-empty sections (AC6): an empty section's heading is
 *  not rendered, because three permanently-empty subsections were the noise. */
export function homeActivityView(load) {
  const phase = activityPhase(load);
  if (phase === "loading") return { phase, message: CURRENT_ACTIVITY_LOADING_LABEL, sections: [], ci: null, empty: false };
  if (phase === "unavailable") {
    return {
      phase,
      message: CURRENT_ACTIVITY_UNAVAILABLE_LABEL,
      detail: activityUnavailableDetail(load),
      retry: true,
      sections: [],
      ci: null,
      empty: false,
    };
  }
  const activity = load.activity;
  const ci = homeCiSummaries(activity.requiredCi);
  const sections = [];
  const agents = activity.agents;
  const launches = activity.hostVerification;
  const unassociated = Array.isArray(activity.unassociated) ? activity.unassociated : [];
  if (agents.length > 0) sections.push({ kind: "agents", heading: "Agents", entries: agents });
  if (launches.length > 0) sections.push({ kind: "hostVerification", heading: "Host verification", entries: launches });
  if (ci !== null) sections.push({ kind: "requiredCi", heading: "Required CI", entries: ci });
  if (unassociated.length > 0) sections.push({ kind: "unassociated", heading: "Unassociated activity", entries: unassociated });
  return {
    phase,
    sections,
    ci,
    empty: sections.length === 0,
    message: sections.length === 0 ? NOTHING_RUNNING_LABEL : null,
  };
}
