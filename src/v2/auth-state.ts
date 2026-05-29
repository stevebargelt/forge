// forge #176 — stage a captured auth profile for injection into a container.
//
// Shared by `forge invoke` (explicit --auth-profile) and the pipeline runner
// (run-level --auth-profile, scoped to browser-capable steps). Resolves the
// profile, fails fast on missing/expired, and reconciles localhost-family
// origins (#183) into a mode-600 staged copy when the agent will reach the host
// via host.docker.internal. Returns the host path to mount + the (possibly
// rewritten) origins for caller logging.

import { join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { profileStatus, readProfile, reconcileStateForContainer } from "../util/auth-profiles.js";

export class AuthProfileError extends Error {}

export interface StagedAuthState {
  hostPath: string;     // path to bind-mount read-only into the container
  origins: string[];    // origins the agent should navigate to (post-reconcile)
  reconciled: boolean;  // true when localhost origins were rewritten + a copy staged
}

// Throws AuthProfileError when the profile is missing or expired — the caller
// fails the task (no container should run with a dead session).
export function resolveAuthStateForContainer(profileName: string, taskDirPath: string): StagedAuthState {
  const status = profileStatus(profileName);
  const remediation = `run: forge auth-profile login ${profileName} --url <url>`;
  if (!status.exists) throw new AuthProfileError(`auth profile '${profileName}' not found — ${remediation}`);
  if (status.expired) throw new AuthProfileError(`auth profile '${profileName}' is expired — ${remediation}`);

  const original = readProfile(profileName);
  if (!original) throw new AuthProfileError(`auth profile '${profileName}' could not be read`);

  const { state, changed } = reconcileStateForContainer(original);
  const origins = state.origins.map((o) => o.origin);
  if (!changed) {
    return { hostPath: status.path, origins, reconciled: false };
  }
  // Stage the rewritten copy mode 600 so the bearer token isn't exposed by the
  // task dir's 0777 perms.
  const staged = join(taskDirPath, "auth-state.json");
  writeFileSync(staged, JSON.stringify(state));
  chmodSync(staged, 0o600);
  return { hostPath: staged, origins, reconciled: true };
}

// In a PIPELINE run, only browser-driving roles get an auth profile injected —
// non-browsing roles (architect, tech-lead, backend/security advisors) don't
// need the credential and shouldn't carry it (nor trip the browser-tools guard).
// `forge invoke` does NOT use this filter: an explicit --auth-profile is honored
// for whatever agent the user named.
const BROWSER_CAPABLE_ROLES = new Set([
  "engineer",
  "frontend-specialist",
  "test-engineer",
  "manual-qa",
]);

export function roleUsesBrowser(role: string): boolean {
  return BROWSER_CAPABLE_ROLES.has(role);
}
