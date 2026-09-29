// FG-817: the Roles list (#roles), as data — pure, so a unit test over this and the
// browser suite over the rendered table mean the same thing. Every value is read from
// GET /api/roles; nothing is counted or resolved in the browser.

import { hashFor } from "./view-routing.js";

function dash(value) {
  return typeof value === "string" && value !== "" ? value : "—";
}

/** "claude-subscription · claude-sonnet-5 · effort low" — the profile the policy resolves
 *  for the role's default activity, or why it could not. */
export function profileLabel(role) {
  if (role.resolutionError) return `unresolved: ${role.resolutionError}`;
  if (!role.profile) return role.model ? `legacy · ${role.model}` : "legacy (no model policy)";
  return [role.profile, role.model, role.effort ? `effort ${role.effort}` : null].filter(Boolean).join(" · ");
}

export function mountLabel(mode) {
  return mode === "ro" ? "read-only" : mode === "rw" ? "read-write" : "—";
}

export function rolesIndexRows(body) {
  if (!body || !Array.isArray(body.roles)) return [];
  return body.roles.map((r) => ({
    role: r.role,
    href: hashFor({ view: "roles", id: r.role }),
    description: dash(r.description),
    activity: dash(r.defaultActivity),
    profile: profileLabel(r),
    mount: mountLabel(r.mountMode),
    mountSource: r.mountModeSource ?? "",
    lastTaskAt: r.lastTaskAt ?? null,
    settingsMissing: r.settings === false,
  }));
}

/** One-line notices the list owes the operator: no generation, a torn install, an
 *  unreadable model policy or store. */
export function rolesIndexNotices(body) {
  if (!body) return [];
  const out = [];
  if (!body.generation) out.push(`No seed generation is published (${body.seedInstall?.kind ?? "unknown"}): protocols, runtimes and the routing policy cannot be read. Run forge upgrade.`);
  if (body.seedInstall?.reason) out.push(body.seedInstall.reason);
  if (body.modelPolicy?.error) out.push(`Model policy unreadable: ${body.modelPolicy.error}`);
  if (body.storeError) out.push(`Store unreadable, so last-task times are missing: ${body.storeError}`);
  if (Array.isArray(body.roles) && body.roles.length === 0) out.push(`No role seed is installed under ${body.agentsDir ?? "$FORGE_HOME/agents"}. Run forge upgrade.`);
  return out;
}

/** The list's caption: where every column was read from. */
export function rolesIndexSource(body) {
  const gen = body?.generation ? `seed generation ${body.generation.id}` : "no seed generation";
  const policy = body?.modelPolicy?.path ?? `model policy ${body?.modelPolicy?.source ?? "unknown"}`;
  return `Source: ${body?.agentsDir ?? "$FORGE_HOME/agents"}; ${gen}; ${policy}; tasks in forge.db`;
}
