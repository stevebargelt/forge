// AWN-6: project-provided auth state. Lets a project declare how to log in for
// testing without forge owning app credentials or login logic. The PROJECT owns
// credentials, the login flow, token refresh, and cleanup; FORGE owns role
// scoping, freshness, read-only mounting, redaction, and lifecycle events.
//
// Config lives at <project>/.forge/auth-profiles.yml:
//   auth_profiles:
//     qa:
//       kind: project-command
//       command: npm run e2e:auth
//       storage_state: .playwright/.auth/qa.json
//       required_env: [E2E_SUPABASE_EMAIL, E2E_SUPABASE_PASSWORD]
//       roles: [test-engineer, manual-qa, frontend-specialist]
//
// Forge checks required_env by NAME (never prints values), runs the command in
// the project dir, verifies the storage_state file was produced, then stages it
// read-only (mode 600) into the task dir like a captured profile. Reds never get
// auth state. Errors never include the command's stderr (it can echo secrets).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { reconcileStateForContainer } from "../util/auth-profiles.js";
import { writeSecretFile } from "../util/secret-file.js";
import type { StagedAuthState } from "./auth-state.js";

// The project login command runs on the HOST before the container starts, so the
// container idle-watchdog can't bound it. Cap it so a hung login can't wedge a
// task indefinitely. (Configurable later if needed.)
const AUTH_COMMAND_TIMEOUT_MS = 120_000;

export class ProjectAuthError extends Error {}

export const ProjectAuthProfileSchema = z
  .object({
    kind: z.literal("project-command"),
    command: z.string().min(1),
    storage_state: z.string().min(1),
    required_env: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  })
  .strict();
export type ProjectAuthProfile = z.infer<typeof ProjectAuthProfileSchema>;

const ProfilesFileSchema = z.object({ auth_profiles: z.record(z.string(), ProjectAuthProfileSchema) }).strict();

const CONFIG_REL = join(".forge", "auth-profiles.yml");

/** Load a named project-command auth profile from <project>/.forge/auth-profiles.yml.
 *  Returns undefined when the file or the named profile is absent. Throws on a
 *  malformed config (loud, so a typo doesn't silently disable auth). */
export function loadProjectAuthProfile(projectDir: string, name: string): ProjectAuthProfile | undefined {
  const path = join(projectDir, CONFIG_REL);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ProjectAuthError(`${CONFIG_REL}: YAML parse error — ${(e as Error).message}`);
  }
  const parsed = ProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProjectAuthError(`${CONFIG_REL}: invalid — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data.auth_profiles[name];
}

/** Required env vars that are absent or empty — by NAME only, never values. */
export function missingRequiredEnv(profile: ProjectAuthProfile, env: NodeJS.ProcessEnv = process.env): string[] {
  return (profile.required_env ?? []).filter((name) => !env[name] || env[name] === "");
}

/** Whether a role may receive this profile's auth. Reds NEVER get auth state
 *  (safety, regardless of config). An unscoped profile (no roles) allows any
 *  non-red role; a scoped one allows only listed roles. */
export function profileAllowsRole(profile: ProjectAuthProfile, role: string): boolean {
  if (role.startsWith("red-") || role === "red") return false;
  if (!profile.roles || profile.roles.length === 0) return true;
  return profile.roles.includes(role);
}

export type AuthCommandRunner = (command: string, cwd: string) => { ok: boolean; code: number; timedOut?: boolean };

const defaultRunner: AuthCommandRunner = (command, cwd) => {
  // Inherit the env (the project's login needs its creds) but DON'T capture
  // stdout/stderr into anything we surface — it can echo secrets. Time-bounded so
  // a hung login can't block the task forever (no container watchdog yet).
  const r = spawnSync(command, {
    cwd, shell: true, stdio: ["ignore", "ignore", "ignore"], env: process.env,
    timeout: AUTH_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  return { ok: r.status === 0 && !timedOut, code: r.status ?? -1, timedOut };
};

/** Run the project's login command to produce its storage_state file. Returns the
 *  absolute path to the produced file. Throws (secret-free) on missing env, a
 *  failed command, or a missing output file. */
export function produceStorageState(profile: ProjectAuthProfile, projectDir: string, opts?: { runner?: AuthCommandRunner }): string {
  const missing = missingRequiredEnv(profile);
  if (missing.length > 0) {
    throw new ProjectAuthError(`auth profile: missing required env: ${missing.join(", ")} — set these before the login command runs`);
  }
  const runner = opts?.runner ?? defaultRunner;
  const res = runner(profile.command, projectDir);
  if (res.timedOut) {
    // Don't echo the configured command (it could contain inline creds).
    throw new ProjectAuthError(`auth command timed out after ${Math.round(AUTH_COMMAND_TIMEOUT_MS / 1000)}s — check the project's login setup`);
  }
  if (!res.ok) {
    // Report exit code only — NOT the raw command string (Finding 5: a command
    // with inline credentials would otherwise be persisted in the failure event).
    throw new ProjectAuthError(`auth command failed (exit ${res.code}) — check the project's login setup`);
  }
  const statePath = resolve(projectDir, profile.storage_state);
  if (!existsSync(statePath)) {
    throw new ProjectAuthError(`auth command ran but produced no storage_state at '${profile.storage_state}'`);
  }
  return statePath;
}

/** Full project-command resolution for a container: role-gate, run the login
 *  command, then reconcile + stage the produced storage_state read-only (mode
 *  600) into the task dir. Mirrors resolveAuthStateForContainer's staging. */
export function resolveProjectAuthForContainer(
  profile: ProjectAuthProfile,
  projectDir: string,
  taskDirPath: string,
  role: string,
  opts?: { runner?: AuthCommandRunner },
): StagedAuthState {
  if (!profileAllowsRole(profile, role)) {
    throw new ProjectAuthError(`role '${role}' is not permitted this auth profile (reds never receive auth; scoped roles: ${profile.roles?.join(", ") ?? "any non-red"})`);
  }
  const statePath = produceStorageState(profile, projectDir, opts);
  let original: { origins?: Array<{ origin: string }> };
  try {
    original = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (e) {
    throw new ProjectAuthError(`produced storage_state is not valid JSON: ${(e as Error).message}`);
  }
  const { state } = reconcileStateForContainer(original as Parameters<typeof reconcileStateForContainer>[0]);
  const origins = state.origins.map((o) => o.origin);
  // Always stage a forge-owned mode-600 copy (atomically; the task dir is 0777)
  // — never bind-mount the project's file directly (single redaction point).
  const staged = join(taskDirPath, "auth-state.json");
  writeSecretFile(staged, JSON.stringify(state));
  return { hostPath: staged, origins, reconciled: true };
}
