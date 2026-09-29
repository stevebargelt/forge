// FG-817: a role page (#roles/<role>[/<tab>]), as data — the tab strip, the screen line,
// each tab's source caption and the composed instructions split into their marked
// sections. Pure; role-page-view.js renders it. Every value is read from
// GET /api/roles/:role.

import { hashFor, ROUTES } from "./view-routing.js";
import { formatTokens, shortSha } from "./format.js";

const TAB_LABELS = {
  overview: "Overview",
  instructions: "Instructions",
  skills: "Skills",
  configuration: "Configuration",
  secrets: "Secrets",
  tools: "Tools",
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

/** The screen line: what the role is doing lately, whether it needs you (a seed never
 *  does — it changes only through forge upgrade), and the verb that explains it. */
export function roleHeader(role, detail) {
  const verb = `forge model resolve ${role}`;
  if (!detail) return { happening: `Loading ${role}`, needsYou: false, needs: "", todo: "", verb: null };
  const last = detail.overview?.recentTasks?.[0];
  const happening = last ? `${role} last ran ${last.status === "running" ? "and is running" : `(${last.status})`}` : `${role} has no recorded task`;
  return { happening, needsYou: false, needs: "A seed changes only through forge upgrade", todo: "Read why it runs where it does", verb };
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
