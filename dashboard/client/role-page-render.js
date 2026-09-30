// FG-817: a role page (#roles/<role>[/<tab>]), as data — the tab strip, the screen line,
// each tab's source caption and the composed instructions split into their marked
// sections. FG-827 adds the Harness rows, the Skills badges, the Overview's Latest task
// card and Skills chips, and the Usage periods. Pure; role-page-view.js renders it. Every
// value is read from GET /api/roles/:role.

import { hashFor, ROUTES } from "./view-routing.js";
import { formatRelativeTime, formatTimestamp, formatTokens, shortSha } from "./format.js";
import { statusToken } from "./status-tokens.js";

const TAB_LABELS = {
  overview: "Overview",
  instructions: "Instructions",
  harness: "Harness / Runtime",
  skills: "Skills",
  capabilities: "Capabilities",
  tools: "Tools",
  secrets: "Secrets",
  tasks: "Tasks",
  receipts: "Receipts",
  usage: "Usage",
};

export const ROLE_TABS = Object.freeze(ROUTES.roles.tabs.map((id) => ({ id, label: TAB_LABELS[id] ?? id })));

export function roleTabLabel(tab) {
  return TAB_LABELS[tab] ?? TAB_LABELS.overview;
}

export function roleTabs(role, current) {
  return ROLE_TABS.map((t) => ({ ...t, href: hashFor({ view: "roles", id: role, tab: t.id }), current: t.id === current }));
}

/** The caption every tab carries: where its content was read from. */
export function tabCaption(detail, tab) {
  const source = detail?.[tab]?.source;
  return typeof source === "string" && source !== "" ? `Source: ${source}` : "Source: unavailable";
}

/** The screen line: what the role is doing lately, that it does not need you (a seed
 *  changes only through forge upgrade), and the verb that explains where it runs. */
export function roleHeader(role, detail) {
  const verb = `forge model resolve ${role}`;
  if (!detail) return { happening: `Loading ${role}`, needsYou: false, needs: "", todo: "", verb: null };
  const last = detail.overview?.recentTasks?.[0];
  const happening = last ? `${role} last ran ${last.status === "running" ? "and is running" : `(${last.status})`}` : `${role} has no recorded task`;
  return { happening, needsYou: false, needs: "Nothing needs you", todo: "", verb };
}

/** The composed prompt cut at its section bounds, each with its kind and title. The
 *  concatenated texts are the prompt, so the page shows the exact bytes. */
export function instructionSections(instructions) {
  if (!instructions || instructions.ok !== true || !Array.isArray(instructions.sections)) return [];
  return instructions.sections.map((s) => ({
    kind: s.kind,
    id: s.id ?? null,
    title: s.title,
    text: instructions.prompt.slice(s.start, s.end),
  }));
}

export function percent(rate) {
  return typeof rate === "number" ? `${Math.round(rate * 100)}%` : "—";
}

export { formatTokens as tokens };

export function relationLabel(relations) {
  return (relations ?? []).map((r) => (r === "followup" ? "required follow-up" : r)).join(", ");
}

export { shortSha };

const AUTH_LABELS = { subscription: "subscription", api: "API key", bedrock: "Bedrock" };

/** The auth mode as the operator names it: subscription, API key or Bedrock. */
export function authLabel(auth) {
  if (auth === null || auth === undefined || auth === "") return "—";
  return AUTH_LABELS[auth] ?? auth;
}

/** The Harness table: one row per activity, each cell a value `forge model resolve` printed. */
export function harnessRows(harness) {
  return (harness?.activities ?? []).map((r) => ({
    activity: r.activity,
    isDefault: r.isDefault === true,
    error: r.error ?? null,
    mappingSummary: r.mapping ?? null,
    cells: {
      profile: r.profile ?? "legacy",
      provider: r.provider ?? "—",
      model: r.model ?? "—",
      auth: authLabel(r.auth),
      runtime: r.runtime ?? "—",
      image: r.image ?? "—",
      costTier: r.costTier ?? "—",
      effort: r.effort ?? "—",
      resolvedBy: r.resolvedBy ?? "—",
      mapping: r.mappingPath ?? "—",
      dispatchable: r.dispatchable === true ? "yes" : r.dispatchable === false ? "no" : "—",
    },
  }));
}

export const HARNESS_COLUMNS = Object.freeze([
  ["activity", "Activity"], ["profile", "Profile"], ["provider", "Provider"], ["model", "Model"], ["auth", "Auth"],
  ["runtime", "Runtime"], ["image", "Image"], ["costTier", "Cost tier"], ["effort", "Effort"], ["resolvedBy", "Resolved by"],
  ["mapping", "Mapping"], ["dispatchable", "Dispatchable"],
]);

const SKILL_SOURCES = { "forge-bundled": "Forge bundled", project: "Project", host: "Host path" };

export function skillSourceLabel(source) {
  return SKILL_SOURCES[source] ?? String(source ?? "unknown");
}

/** The Overview's Skills chips: each mounted skill, linking to the Skills tab. */
export function skillChips(role, names) {
  const href = hashFor({ view: "roles", id: role, tab: "skills" });
  return (names ?? []).map((name) => ({ name, href }));
}

/** The Overview's Latest task card: the task's status token, its links and when. */
export function latestTaskCard(overview, now = Date.now()) {
  const t = overview?.latestTask;
  if (!t) return null;
  return {
    taskId: t.taskId,
    href: hashFor({ view: "task", id: t.taskId }),
    runHref: hashFor({ view: "run", id: t.runId }),
    runLabel: t.runTitle || t.runId,
    token: statusToken("task", t.status),
    when: formatRelativeTime(t.createdAt, now),
    title: formatTimestamp(t.createdAt),
  };
}

export const USAGE_PERIODS = Object.freeze(["1d", "7d", "30d", "all"]);
export const DEFAULT_USAGE_PERIOD = "30d";

export function usageWindow(usage, since) {
  return (usage?.windows ?? []).find((w) => w.since === since) ?? null;
}
