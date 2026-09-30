// FG-821: breadcrumbs for object pages, as data. Pure, so a unit test over this and a
// browser test over the rendered trail mean the same thing.
//
// THE RULE: a trail is built from the PAYLOAD of the page on screen (the run's
// projectDir, the task's run, the run's ticket), never from history — so an inbox click
// and a pasted link give the same trail. The chain is
// Project › [Ticket ›] Run › Task › Explain; every crumb but the last is a link, and
// Project resolves to the run index scoped to that project (#runs?project=<key>).

import { hashFor } from "./view-routing.js";

function nonEmpty(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function basename(dir) {
  return dir.replace(/\/+$/, "").split("/").pop() || dir;
}

/** The registered project whose checkouts include `projectDir`, or null. */
export function projectForDir(projectDir, projects) {
  const dir = nonEmpty(projectDir);
  if (!dir || !Array.isArray(projects)) return null;
  return projects.find((p) => Array.isArray(p.checkouts) && p.checkouts.some((c) => c.projectDir === dir)) ?? null;
}

/** The registered project a payload names — by `projectKey` when it carries one (the
 *  backlog's `ticketsProjectKey`), else by the checkout directory. */
function projectForPayload(payload, projects) {
  const key = nonEmpty(payload.projectKey);
  const byKey = key && Array.isArray(projects) ? projects.find((p) => p.key === key) : null;
  return byKey ?? (key ? { key, label: key } : projectForDir(payload.projectDir, projects));
}

/** The Project crumb. An unregistered or missing directory still gets a crumb (its
 *  basename, or "Unknown project"), linking to the unscoped run index. */
export function projectCrumb(projectDir, projects, projectKey = null) {
  const project = projectForPayload({ projectDir, projectKey }, projects);
  if (project) return { kind: "project", label: project.label || project.key, href: hashFor({ view: "runs", scope: { project: project.key } }) };
  const dir = nonEmpty(projectDir);
  return { kind: "project", label: dir ? basename(dir) : "Unknown project", href: hashFor({ view: "runs" }) };
}

/**
 * The trail for one object page.
 *
 * `page` names the page on screen: "run" | "task" | "explain" | "ticket" | "review".
 * The rest is read off that page's payload: `projectDir` (or `projectKey`), `ticketId`, `runId`,
 * `runTitle`, `taskId`, `taskLabel`, `reviewId`. A crumb the payload cannot fill is
 * omitted (a run with no ticket has no ticket crumb) rather than guessed.
 */
export function breadcrumbTrail(page, payload, projects) {
  const p = payload ?? {};
  const project = projectForPayload(p, projects);
  const crumbs = [projectCrumb(p.projectDir, projects, p.projectKey)];
  const ticketId = nonEmpty(p.ticketId);
  const runId = nonEmpty(p.runId);
  const taskId = nonEmpty(p.taskId);
  if (ticketId) {
    crumbs.push({ kind: "ticket", label: ticketId, href: hashFor({ view: "backlog", id: ticketId, scope: project ? { project: project.key } : null }) });
  }
  if (page !== "ticket" && runId) {
    crumbs.push({ kind: "run", label: nonEmpty(p.runTitle) ?? runId, href: hashFor({ view: "run", id: runId }) });
  }
  if ((page === "task" || page === "explain") && taskId) {
    crumbs.push({ kind: "task", label: nonEmpty(p.taskLabel) ?? taskId, href: hashFor({ view: "task", id: taskId }) });
  }
  if (page === "explain" && taskId) {
    crumbs.push({ kind: "explain", label: "Explain", href: hashFor({ view: "task", id: taskId, tab: "explain" }) });
  }
  if (page === "review" && nonEmpty(p.reviewId)) {
    crumbs.push({ kind: "review", label: p.reviewId, href: hashFor({ view: "reviews", id: p.reviewId }) });
  }
  return crumbs.map((crumb, i) => (i === crumbs.length - 1 ? { ...crumb, href: null } : crumb));
}

/** A role page's trail: Roles › <role> › <tab>. The Roles list is global, so there is no
 *  project crumb; the role crumb keeps the page's scope. The tab crumb is the page on screen. */
export function roleTrail(role, tabLabel, scope = null) {
  return [
    { kind: "roles", label: "Roles", href: hashFor({ view: "roles" }) },
    { kind: "role", label: role, href: hashFor({ view: "roles", id: role, scope }) },
    { kind: "role-tab", label: tabLabel, href: null },
  ];
}

/** A checkout's note page (FG-830): Project › Notes › <checkout label>. The Notes crumb
 *  keeps the scope the page was opened under. */
export function noteTrail(checkoutLabel, scope, projects) {
  const project = scope && scope.project ? scope.project : null;
  return [
    projectCrumb(null, projects, project),
    { kind: "notes", label: "Notes", href: hashFor({ view: "notes", scope }) },
    { kind: "note", label: checkoutLabel, href: null },
  ];
}

/** Where Escape goes from an object page: its parent, one level up the same chain.
 *  A run's parent is the run index; a task's is its run; Explain's is its task. */
export function parentHash(page, payload, scope = null) {
  const p = payload ?? {};
  switch (page) {
    case "explain":
      return nonEmpty(p.taskId) ? hashFor({ view: "task", id: p.taskId }) : hashFor({ view: "runs", scope });
    case "task":
      return nonEmpty(p.runId) ? hashFor({ view: "run", id: p.runId }) : hashFor({ view: "runs", scope });
    case "ticket":
      return hashFor({ view: "backlog", scope });
    case "review":
      return hashFor({ view: "reviews", scope });
    case "note":
      return hashFor({ view: "notes", scope });
    case "role":
      return hashFor({ view: "roles" });
    default:
      return hashFor({ view: "runs", scope });
  }
}
