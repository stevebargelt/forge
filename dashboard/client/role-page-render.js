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

// FG-837: the grouped left sub-nav a role page shows at 900px and wider (under it the
// FG-817 tablist stands in). Every tab is in exactly one group; the hashes are the tabs'.
export const ROLE_TAB_GROUPS = Object.freeze([
  { id: "role", label: "Role", tabs: ["overview", "instructions", "skills"] },
  { id: "runtime", label: "Runtime", tabs: ["harness", "secrets", "tools"] },
  { id: "governance", label: "Governance", tabs: ["capabilities", "receipts"] },
  { id: "audit", label: "Audit", tabs: ["tasks", "usage"] },
]);

const SUBNAV_LABELS = { capabilities: "Capabilities / Trust" };

// 15px line icons on a 24-unit box, drawn like the FG-829 glyphs.
export const SUBNAV_ICONS = Object.freeze({
  overview: ["M12 3l2 5 5 .5-4 3.5 1.5 5L12 14l-4.5 3 1.5-5-4-3.5L10 8z"],
  instructions: ["M5 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H5z", "M19 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"],
  skills: ["M4 6h16M4 12h10M4 18h7"],
  harness: ["M4 7h16M4 12h16M4 17h16", "M10.5 7a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M16.5 12a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M9.5 17a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0"],
  secrets: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"],
  tools: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-2.6z"],
  capabilities: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", "M9 12l2 2 4-4"],
  receipts: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
  tasks: ["M20 12a8 8 0 1 1-16 0a8 8 0 1 1 16 0", "M12 8v4l3 2"],
  usage: ["M4 19h16M6 16V9M10 16V5M14 16v-7M18 16v-4"],
});

export function roleSubnav(role, current) {
  return ROLE_TAB_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: g.tabs.map((id) => ({
      id,
      label: SUBNAV_LABELS[id] ?? TAB_LABELS[id],
      href: hashFor({ view: "roles", id: role, tab: id }),
      current: id === current,
      icon: SUBNAV_ICONS[id],
    })),
  }));
}

/** The header's meta line: runtime · model · family · mount, each a value the payload
 *  carries (the default activity's resolution) or "—". */
export function roleMeta(detail, family) {
  const r = detail?.overview?.resolution ?? {};
  const mode = detail?.overview?.mountMode?.mode;
  return {
    runtime: r.runtime || "—",
    model: r.error ? "unresolved" : r.model || "—",
    family,
    mount: mode === "ro" ? "read-only" : mode === "rw" ? "read-write" : "—",
  };
}

const constraintName = (k) => (k.file ? k.file.split("/").pop().replace(/\.md$/, "") : k.id);

/** The Overview's four cards as label/value rows, each with the tab its link opens. */
export function overviewCards(detail, family) {
  const o = detail.overview;
  const r = o.resolution ?? {};
  const c = detail.capabilities ?? {};
  const link = (tab, label) => ({ label, href: hashFor({ view: "roles", id: detail.role, tab }) });
  return {
    identity: {
      link: link("instructions", "Instructions"),
      rows: [
        ["Family", family],
        ["Default activity", r.activity || "—"],
        ["Mount", o.mountMode?.mode === "ro" ? "read-only" : o.mountMode?.mode === "rw" ? "read-write" : "—"],
        ["Seed generation", detail.generation?.id ?? "none published", "mono"],
        ["Protocol sha", o.protocolSha ? shortSha(o.protocolSha) : "none", o.protocolSha ? "mono" : null],
      ],
    },
    harness: {
      link: link("harness", "Configure"),
      rows: r.error
        ? [["Resolution", `unresolved: ${r.error}`, "err"]]
        : [
          ["Runtime", r.runtime || "—"],
          ["Profile", r.profile || "legacy (no model policy)"],
          ["Model", r.model || "—", "mono"],
          ["Auth", authLabel(r.auth)],
          ["Resolved by", r.resolvedBy || "—", "mono"],
        ],
    },
    capabilities: {
      link: link("capabilities", "Trust"),
      rows: [
        ["Activities", (c.activities ?? []).map((a) => a.activity).join(", ") || "—"],
        ["Routes", (c.routes ?? []).map((rt) => `${rt.route} (${relationLabel(rt.relations)})`).join(", ") || "none"],
        ["Constraints", (c.constraints ?? []).map(constraintName).join(" · ") || "none"],
      ],
    },
    skills: {
      link: link("skills", "Manage"),
      chips: skillChips(detail.role, o.skills),
      hostOnly: (detail.skills?.hostOnly ?? []).map((k) => k.name),
    },
  };
}

/** The Overview's Recent tasks rows: id, the run's title, and "status · 3h ago". */
export function recentTaskRows(overview, now = Date.now()) {
  return (overview?.recentTasks ?? []).map((t) => ({
    taskId: t.taskId,
    href: hashFor({ view: "task", id: t.taskId }),
    title: t.runTitle || t.runId,
    meta: `${t.status} · ${formatRelativeTime(t.createdAt, now)}`,
    when: formatTimestamp(t.createdAt),
  }));
}
