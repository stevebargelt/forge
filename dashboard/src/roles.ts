// FG-817: the Roles surface behind GET /api/roles and GET /api/roles/:role. A projection,
// not new data: the installed seed ($FORGE_HOME/agents/<role>), the published seed
// generation (protocols, runtimes, workflows, the compiled routing policy), the model
// policy, and the store's task/model_calls rows. Read-only — there is no POST, because a
// seed changes only through `forge upgrade` — and nothing here shells out (invariant 21).
//
// Each tab carries a `source` naming where its content was read from; the client prints
// it as the tab's caption, so the page never states a fact without its origin.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { inspectSeedInstall, protocolRelPath, resolveSeedGeneration, type SeedGeneration } from "../../src/v2/seed-generation.js";
import { defaultActivityForRole, resolveModel } from "../../src/v2/model-resolution.js";
import { loadModelPolicyWithSource, loadRuntimeWithSource } from "../../src/v2/loader.js";
import { resolveRuntimeMetadata } from "../../src/v2/schema.js";
import { assetRoot } from "../../src/v2/asset-root.js";
import {
  composeRoleInstructions,
  generationHistory,
  generationIdOfSource,
  generationRedRoles,
  generationRoutingPolicyPath,
  isRoleName,
  listSeedRoles,
  roleAgentDir,
  roleBackups,
  roleDescription,
  roleMountMode,
  routesNamingRole,
} from "../../src/v2/role-surface.js";
import { loadPolicy } from "@forge/governance";
import { lastTaskAtByRole, roleOps, roleReceipts, roleUsage, roleUsageByModel, tasksForRole } from "./queries.js";

export const ROLE_SECRETS_TEXT = "none: containers receive no project secrets";
const RECENT_TASKS = 5;
const TASKS_LIMIT = 50;
const RECEIPTS_LIMIT = 20;
const USAGE_WINDOWS = ["7d", "30d", "all"];
const OPS_WINDOW = "30d";

function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generationSummary(gen: SeedGeneration | null) {
  return gen ? { id: basename(gen.root), root: gen.root, sourceAssetRoot: gen.manifest.sourceAssetRoot } : null;
}

function modelPolicySource(gen: SeedGeneration | null): { source: string; path: string | null; error: string | null } {
  try {
    const p = loadModelPolicyWithSource({ seedGeneration: gen });
    return { source: p.source, path: p.source === "absent" ? null : p.path, error: null };
  } catch (err) {
    return { source: "invalid", path: null, error: message(err) };
  }
}

export type RoleResolution = {
  activity: string;
  profile: string | null;
  effort: string | null;
  model: string | null;
  provider: string | null;
  auth: string | null;
  runtime: string | null;
  resolvedBy: string | null;
  mappingPath: string | null;
  error: string | null;
};

/** The profile and effort model policy resolves for the role's DEFAULT activity — the
 *  resolution a dispatch with no explicit step activity gets. */
function resolveForRole(role: string, gen: SeedGeneration | null): RoleResolution {
  const activity = defaultActivityForRole(role);
  const none = { profile: null, effort: null, model: null, provider: null, auth: null, runtime: null, resolvedBy: null, mappingPath: null };
  try {
    const r = resolveModel({ agentRole: role, seedGeneration: gen });
    return {
      activity,
      profile: r.profile ?? null,
      effort: r.effort ?? null,
      model: r.model || null,
      provider: r.provider ?? null,
      auth: r.auth ?? null,
      runtime: r.runtime || null,
      resolvedBy: r.resolvedBy,
      mappingPath: r.mappingPath ?? null,
      error: null,
    };
  } catch (err) {
    return { activity, ...none, error: message(err) };
  }
}

type SettingsRead = { path: string; present: boolean; text: string | null; tools: string[] | null; error: string | null };

function readSettings(home: string, role: string): SettingsRead {
  const path = join(roleAgentDir(home, role), "settings.json");
  if (!existsSync(path)) return { path, present: false, text: null, tools: null, error: null };
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text) as { tools?: unknown };
    const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === "string") : null;
    return { path, present: true, text, tools, error: null };
  } catch (err) {
    return { path, present: true, text, tools: null, error: `settings.json is not valid JSON: ${message(err)}` };
  }
}

function storeRead<T>(read: () => T, fallback: T): { value: T; error: string | null } {
  try {
    return { value: read(), error: null };
  } catch (err) {
    return { value: fallback, error: message(err) };
  }
}

/** GET /api/roles — every installed role seed with its activity, resolved profile and
 *  effort, mount mode and last task time. */
export function rolesIndex() {
  const home = forgeHome();
  const gen = resolveSeedGeneration(home);
  const install = inspectSeedInstall(home);
  const reds = generationRedRoles(gen);
  const last = storeRead(() => lastTaskAtByRole(), new Map<string, string>());
  const roles = listSeedRoles(home).map((role) => {
    const resolution = resolveForRole(role, gen);
    const mount = roleMountMode(role, reds);
    return {
      role,
      description: roleDescription(readFileSync(join(roleAgentDir(home, role), "CLAUDE.md"), "utf8")),
      defaultActivity: resolution.activity,
      profile: resolution.profile,
      effort: resolution.effort,
      model: resolution.model,
      resolvedBy: resolution.resolvedBy,
      resolutionError: resolution.error,
      mountMode: mount.mode,
      mountModeSource: mount.source,
      settings: existsSync(join(roleAgentDir(home, role), "settings.json")),
      protocolSha: gen?.manifest.files[protocolRelPath(role)] ?? null,
      lastTaskAt: last.value.get(role) ?? null,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    agentsDir: join(home, "agents"),
    generation: generationSummary(gen),
    seedInstall: install.kind === "incomplete" ? { kind: install.kind, reason: install.reason } : { kind: install.kind, reason: null },
    modelPolicy: modelPolicySource(gen),
    storeError: last.error,
    roles,
  };
}

function hostSkills() {
  const dir = join(assetRoot(), "seeds", "skills");
  if (!existsSync(dir)) return { dir, skills: [] as Array<{ name: string; path: string }> };
  const skills = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, path: join(dir, e.name, "SKILL.md") }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, skills };
}

function boundRuntime(runtimeName: string, gen: SeedGeneration | null) {
  try {
    const rt = loadRuntimeWithSource(runtimeName, { seedGeneration: gen });
    const meta = resolveRuntimeMetadata(rt);
    return {
      name: rt.name,
      source: rt.source,
      path: rt.path,
      text: readFileSync(rt.path, "utf8"),
      kind: meta.runtimeKind,
      authStrategy: meta.authStrategy,
      authMode: rt.auth.mode,
      image: rt.image,
      skillMounts: rt.mounts
        .filter((m) => m.container.includes("/.claude/skills/"))
        .map((m) => ({ name: basename(m.container), host: m.host, container: m.container, mode: m.mode, optional: m.optional === true })),
      error: null,
    };
  } catch (err) {
    return { name: runtimeName, source: null, path: null, text: null, kind: null, authStrategy: null, authMode: null, image: null, skillMounts: [], error: message(err) };
  }
}

/** GET /api/roles/:role — every tab's payload for one role, or null for an unknown role.
 *  `project` is a REGISTERED project the caller already resolved; the instructions are
 *  composed anchored at its dir, as dispatch against that project composes them. */
export function roleDetail(role: string, project?: { key: string; dir: string }) {
  const home = forgeHome();
  if (!isRoleName(role) || !listSeedRoles(home).includes(role)) return null;
  const gen = resolveSeedGeneration(home);
  const agentDir = roleAgentDir(home, role);
  const claudeMdPath = join(agentDir, "CLAUDE.md");
  const resolution = resolveForRole(role, gen);
  const mount = roleMountMode(role, generationRedRoles(gen));
  const settings = readSettings(home, role);
  const policyPath = gen ? generationRoutingPolicyPath(gen) : null;
  const policy = policyPath ? loadPolicy(policyPath) : undefined;
  const policySource = modelPolicySource(gen);
  const runtime = boundRuntime(resolution.runtime ?? "claude", gen);

  const tasks = storeRead(() => tasksForRole(role, TASKS_LIMIT), []);
  const ops = storeRead(() => roleOps(role, OPS_WINDOW), null);
  const usage = storeRead(() => roleUsage(role, USAGE_WINDOWS), []);
  const usageByModel = storeRead(() => roleUsageByModel(role), []);
  const receipts = storeRead(() => roleReceipts(role, RECEIPTS_LIMIT), []);
  const storeError = tasks.error ?? ops.error ?? usage.error ?? usageByModel.error ?? receipts.error;

  const protocolSha = gen?.manifest.files[protocolRelPath(role)] ?? null;
  const skills = hostSkills();

  return {
    role,
    generatedAt: new Date().toISOString(),
    generation: generationSummary(gen),
    storeError,
    overview: {
      source: `${claudeMdPath}; model policy ${policySource.path ?? `(${policySource.source})`}; routing policy ${policyPath ?? "(no seed generation)"}; tasks and model_calls in forge.db`,
      description: roleDescription(readFileSync(claudeMdPath, "utf8")),
      resolution,
      modelPolicy: policySource,
      mountMode: mount,
      routingPolicy: { path: policyPath, available: policy !== undefined },
      routes: routesNamingRole(policy, role),
      recentTasks: tasks.value.slice(0, RECENT_TASKS),
      ops: ops.value,
      usage: usage.value.find((u) => u.since === OPS_WINDOW) ?? null,
      protocolSha,
    },
    instructions: {
      source: project
        ? `composeSystemPrompt over ${claudeMdPath}, ${join(home, "constraints")}, the seed generation's agent protocol and project ${project.key}'s ${join(project.dir, ".forge")} (addendum and constraints)`
        : `composeSystemPrompt over ${claudeMdPath}, ${join(home, "constraints")} and the seed generation's agent protocol — host-only: pick a project in Scope to see its addendum`,
      project: project ?? null,
      ...composeRoleInstructions({ home, role, generation: gen, mountMode: mount.mode, project }),
    },
    skills: {
      source: `host: ${skills.dir}; container: the ${runtime.name} runtime's skill mounts${runtime.path ? ` (${runtime.path})` : ""}`,
      host: skills.skills,
      container: runtime.skillMounts,
      runtimeError: runtime.error,
    },
    configuration: {
      source: `${settings.path}; runtime ${runtime.path ?? runtime.name}`,
      settings,
      runtime,
      authStrategy: runtime.authStrategy,
      runtimeBoundBy: resolution.resolvedBy ? `model policy ${resolution.resolvedBy} (${resolution.provider ?? "?"}/${resolution.auth ?? "?"})` : "legacy (no model policy): the runtime detected from the environment",
    },
    secrets: {
      source: "the dispatch mount set: no project secret is mounted or passed into a container",
      text: ROLE_SECRETS_TEXT,
    },
    tools: {
      source: settings.path,
      settingsPresent: settings.present,
      declared: settings.tools,
      enforced: false,
      note: "declared, not enforced: nothing outside tests reads settings.json's tools list",
      mcp: "none",
    },
    tasks: {
      source: "tasks WHERE agent_role = role, newest first, in forge.db",
      rows: tasks.value,
      limit: TASKS_LIMIT,
    },
    receipts: {
      source: `each task's manifest.json agentProtocol receipt; ${join(home, "seed-generations")}; ${join(home, "pre-upgrade-backup")}`,
      dispatches: receipts.value.map((r) => ({ ...r, generation: r.protocol ? generationIdOfSource(home, r.protocol.source) : null })),
      generations: generationHistory(home, role, gen),
      backups: roleBackups(home, role),
    },
    usage: {
      source: "model_calls joined to tasks by agent_role in forge.db (forge usage --by role)",
      windows: usage.value,
      byModel: usageByModel.value,
      ceilings: "none: per-role spend ceilings are a future ticket",
    },
  };
}
