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
import { basename, join, sep } from "node:path";
import { inspectSeedInstall, protocolRelPath, resolveSeedGeneration, type SeedGeneration } from "../../src/v2/seed-generation.js";
import { defaultActivityForRole, resolveModel } from "../../src/v2/model-resolution.js";
import { loadModelPolicy, loadModelPolicyWithSource, loadRuntimeWithSource, type LoadContext } from "../../src/v2/loader.js";
import { modelResolveReport } from "../../src/v2/model-resolve-report.js";
import { resolveIdleTimeoutMs } from "../../src/v2/idle-watchdog.js";
import { oauthVolumeName } from "../../src/util/creds.js";
import { resolveRuntimeMetadata } from "../../src/v2/schema.js";
import { assetRoot } from "../../src/v2/asset-root.js";
import {
  composeRoleInstructions,
  dockerfileToolchain,
  generationHistory,
  generationIdOfSource,
  generationRedRoles,
  generationRoutingPolicyPath,
  isRoleName,
  listSeedRoles,
  parseSkillFrontmatter,
  resolveHostTemplate,
  roleActivities,
  roleAgentDir,
  roleBackups,
  roleConstraints,
  roleDescription,
  roleMountMode,
  roleResultContract,
  routesNamingRole,
  type MountMode,
} from "../../src/v2/role-surface.js";
import { loadPolicy } from "@forge/governance";
import { lastTaskAtByRole, roleOps, roleReceipts, roleUsage, roleUsageBreakdown, tasksForRole, type RoleUsageByProvider } from "./queries.js";

export const ROLE_SECRETS_TEXT = "none: containers receive no project secrets";
const RECENT_TASKS = 5;
const TASKS_LIMIT = 50;
const RECEIPTS_LIMIT = 20;
const USAGE_WINDOWS = ["1d", "7d", "30d", "all"];
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


type SkillEntry = {
  name: string;
  description: string | null;
  descriptionSource: string | null;
  source: "forge-bundled" | "project" | "host";
  host: string;
  hostPath: string | null;
  present: boolean;
  container: string;
  mode: string;
  optional: boolean;
  referencedBySeed: boolean;
};

function readSkill(dir: string | null): { description: string | null; descriptionSource: string | null } {
  const path = dir ? join(dir, "SKILL.md") : null;
  if (!path || !existsSync(path)) return { description: null, descriptionSource: null };
  return { description: parseSkillFrontmatter(readFileSync(path, "utf8")).description, descriptionSource: path };
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text);
}

function hostSkills() {
  const dir = join(assetRoot(), "seeds", "skills");
  if (!existsSync(dir)) return { dir, skills: [] as Array<{ name: string; path: string; description: string | null }> };
  const skills = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, path: join(dir, e.name, "SKILL.md"), description: readSkill(join(dir, e.name)).description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, skills };
}

function skillSource(hostPath: string | null, project?: { dir: string }): SkillEntry["source"] {
  const under = (root: string) => hostPath !== null && (hostPath === root || hostPath.startsWith(root + sep));
  if (under(join(assetRoot(), "seeds", "skills"))) return "forge-bundled";
  if (project && under(project.dir)) return "project";
  return "host";
}

/** Every skill a container for this role receives: the bound runtime's skill mounts, and —
 *  with a project anchored — the project's own `.claude/skills`, which arrive with /project. */
function mountedSkills(runtime: BoundRuntime, seedText: string, project?: { key: string; dir: string }): SkillEntry[] {
  const out: SkillEntry[] = runtime.skillMounts.map((m) => {
    const hostPath = resolveHostTemplate(m.host, process.env, homedir());
    return {
      name: m.name,
      ...readSkill(hostPath),
      source: skillSource(hostPath, project),
      host: m.host,
      hostPath,
      present: hostPath !== null && existsSync(hostPath),
      container: m.container,
      mode: m.mode,
      optional: m.optional,
      referencedBySeed: mentions(seedText, m.name),
    };
  });
  const projectDir = project ? join(project.dir, ".claude", "skills") : null;
  if (projectDir && existsSync(projectDir)) {
    for (const e of readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(projectDir, e.name);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      out.push({
        name: e.name, ...readSkill(dir), source: "project", host: dir, hostPath: dir, present: true,
        container: `/project/.claude/skills/${e.name}`, mode: "with /project", optional: false, referencedBySeed: mentions(seedText, e.name),
      });
    }
  }
  return out;
}

type BoundRuntime = ReturnType<typeof boundRuntime>;

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
      mounts: rt.mounts,
      idleTimeoutSeconds: rt.container.idle_timeout_seconds,
      skillMounts: rt.mounts
        .filter((m) => m.container.includes("/.claude/skills/"))
        .map((m) => ({ name: basename(m.container), host: m.host, container: m.container, mode: m.mode, optional: m.optional === true })),
      error: null,
    };
  } catch (err) {
    return {
      name: runtimeName, source: null, path: null, text: null, kind: null, authStrategy: null, authMode: null, image: null,
      mounts: [], idleTimeoutSeconds: null, skillMounts: [], error: message(err),
    };
  }
}

/** One row per activity the role can be dispatched with, each the report `forge model
 *  resolve <role> --activity <a> --json` prints (`resolve`, verbatim), plus the bound
 *  runtime's image. */
function harnessActivities(role: string, gen: SeedGeneration | null, project?: { key: string; dir: string }) {
  const ctx: LoadContext = { seedGeneration: gen, ...(project ? { projectDir: project.dir } : {}) };
  const runtimeCtx: LoadContext = { seedGeneration: gen };
  const defaultActivity = defaultActivityForRole(role);
  let policyActivities: string[] | null = null;
  let policyError: string | null = null;
  try {
    const policy = loadModelPolicy(ctx);
    policyActivities = policy ? Object.keys(policy.defaults.activity) : null;
  } catch (err) {
    policyError = message(err);
  }
  const rows = roleActivities(defaultActivity, policyActivities).map((activity) => {
    const report = modelResolveReport(role, { activity, ctx, runtimeCtx });
    if (!report.ok) {
      return {
        activity, isDefault: activity === defaultActivity, profile: null, provider: null, model: null, auth: null, runtime: null, image: null,
        costTier: null, effort: null, resolvedBy: null, mapping: null, mappingPath: null, outcome: null, dispatchable: null,
        error: report.error, resolve: { error: report.error },
      };
    }
    const r = report.resolution;
    const runtime = boundRuntime(r.runtime, gen);
    return {
      activity,
      isDefault: activity === defaultActivity,
      profile: r.profile ?? null,
      provider: r.provider ?? null,
      model: r.model || null,
      auth: r.auth ?? null,
      runtime: r.runtime || null,
      image: runtime.image,
      costTier: r.costTier ?? null,
      effort: report.effort ?? r.effort ?? null,
      resolvedBy: r.resolvedBy,
      mapping: report.mappingSummary ?? null,
      mappingPath: r.mappingPath ?? null,
      outcome: r.outcome ?? null,
      dispatchable: report.dispatchable ?? null,
      error: null,
      resolve: JSON.parse(JSON.stringify(report.json)) as Record<string, unknown>,
    };
  });
  return { rows, policyError };
}

const PROJECT_MOUNT = "${PROJECT_DIR}";

/** The container a dispatch of this role gets, read from the bound runtime seed and the
 *  dispatch code's own inputs: mounts with their modes, the auth volume, skill mounts,
 *  idle timeout and network. */
function containerFacts(runtime: BoundRuntime, mount: MountMode) {
  const rtSource = runtime.path ?? `runtime ${runtime.name} (unreadable)`;
  const mounts = runtime.mounts.map((m) => ({
    path: m.container,
    mode: m.host === PROJECT_MOUNT ? mount.mode : m.mode,
    source: m.host,
    optional: m.optional === true,
    caption: m.host === PROJECT_MOUNT ? `${rtSource} mounts[] (mode ${m.mode}: ${mount.source})` : `${rtSource} mounts[]`,
  }));
  const volumeEnv = process.env.FORGE_OAUTH_VOLUME;
  const authVolume = runtime.authMode === "oauth-volume"
    ? { authMode: runtime.authMode, volume: oauthVolumeName(), path: "/home/agent", mode: "rw", source: `${rtSource} auth.mode: oauth-volume; volume name ${volumeEnv ? "from FORGE_OAUTH_VOLUME" : "the default in src/util/creds.ts (FORGE_OAUTH_VOLUME unset)"}; mounted by src/v2/spawn.ts buildDockerArgs` }
    : { authMode: runtime.authMode, volume: null, path: null, mode: null, source: `${rtSource} auth.mode: ${runtime.authMode ?? "unknown"} — no auth volume is mounted` };
  const override = process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  const idleTimeout = {
    seconds: runtime.idleTimeoutSeconds,
    effectiveMs: resolveIdleTimeoutMs(runtime.idleTimeoutSeconds ?? undefined),
    override: override !== undefined && override !== "" ? override : null,
    source: `${rtSource} container.idle_timeout_seconds${override ? "; overridden by FORGE_AGENT_IDLE_TIMEOUT_MS" : ""} (src/v2/idle-watchdog.ts)`,
  };
  const network = {
    mode: "docker default (bridge)",
    source: "src/v2/spawn.ts buildDockerArgs passes no --network flag, and the runtime schema declares none",
  };
  return {
    source: `${rtSource}; src/v2/spawn.ts buildDockerArgs`,
    mounts,
    authVolume,
    skillMounts: runtime.skillMounts,
    idleTimeout,
    network,
  };
}

const AGENT_IMAGE = "agent-dev-worker";

/** The image's toolchain from the Dockerfile this release builds it from, named; unknown
 *  for any image this host carries no Dockerfile for. */
function imageToolchain(image: string | null) {
  const dockerfile = join(assetRoot(), "docker", `${AGENT_IMAGE}.Dockerfile`);
  if (!image || image.split(":")[0] !== AGENT_IMAGE || !existsSync(dockerfile)) {
    return { image, source: null, entries: null, note: `unknown: this host carries no Dockerfile for image ${image ?? "(none)"}` };
  }
  return {
    image,
    source: dockerfile,
    entries: dockerfileToolchain(readFileSync(dockerfile, "utf8")),
    note: "as the release's Dockerfile builds it; an image built from an older release may differ (forge doctor checks the build digest)",
  };
}

const PROVIDER_COST: Record<string, string> = {
  subscription: "tokens only (subscription)",
  bedrock: "tokens only (Bedrock)",
};

const PRICING = { source: null, note: "no pricing source on this host: model_calls records token counts only (src/store/schema.ts), so no cost is estimated" };

function providerCost(row: RoleUsageByProvider) {
  if (row.auth === "api") return { cost: null, costNote: "API key — no pricing source on this host; tokens only" };
  return { cost: null, costNote: row.auth ? PROVIDER_COST[row.auth] ?? `tokens only (${row.auth})` : "tokens only (provider not recorded: legacy dispatch)" };
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
  const seedText = readFileSync(claudeMdPath, "utf8");
  const resolution = resolveForRole(role, gen);
  const mount = roleMountMode(role, generationRedRoles(gen));
  const settings = readSettings(home, role);
  const policyPath = gen ? generationRoutingPolicyPath(gen) : null;
  const policy = policyPath ? loadPolicy(policyPath) : undefined;
  const policySource = modelPolicySource(gen);
  const runtime = boundRuntime(resolution.runtime ?? "claude", gen);
  const container = containerFacts(runtime, mount);
  const harness = harnessActivities(role, gen, project);

  const tasks = storeRead(() => tasksForRole(role, TASKS_LIMIT), []);
  const ops = storeRead(() => roleOps(role, OPS_WINDOW), null);
  const usage = storeRead(() => roleUsage(role, USAGE_WINDOWS), []);
  const breakdown = storeRead(() => new Map(USAGE_WINDOWS.map((w) => [w, roleUsageBreakdown(role, w)])), new Map<string, ReturnType<typeof roleUsageBreakdown>>());
  const receipts = storeRead(() => roleReceipts(role, RECEIPTS_LIMIT), []);
  const storeError = tasks.error ?? ops.error ?? usage.error ?? breakdown.error ?? receipts.error;

  const protocolSha = gen?.manifest.files[protocolRelPath(role)] ?? null;
  const skills = hostSkills();
  const mounted = mountedSkills(runtime, seedText, project);
  const composed = composeRoleInstructions({ home, role, generation: gen, mountMode: mount.mode, project });
  const protocolPath = gen && protocolSha ? join(gen.root, protocolRelPath(role)) : null;
  const contractFiles = composed.ok ? composed.files : [
    ...(protocolPath && existsSync(protocolPath) ? [{ kind: "protocol", path: protocolPath, markdown: readFileSync(protocolPath, "utf8") }] : []),
    { kind: "entry", path: claudeMdPath, markdown: seedText },
  ];
  const resultContract = roleResultContract(contractFiles);
  const constraintsDir = join(home, "constraints");
  const constraints = storeRead(() => roleConstraints({ role, hostDir: constraintsDir, projectDir: project?.dir }), []);
  const toolchain = imageToolchain(runtime.image);
  const latest = tasks.value[0] ?? null;

  return {
    role,
    generatedAt: new Date().toISOString(),
    generation: generationSummary(gen),
    storeError,
    overview: {
      source: `${claudeMdPath}; model policy ${policySource.path ?? `(${policySource.source})`}; the ${runtime.name} runtime's skill mounts; tasks and model_calls in forge.db`,
      description: roleDescription(seedText),
      resolution,
      modelPolicy: policySource,
      mountMode: mount,
      latestTask: latest ? { taskId: latest.taskId, runId: latest.runId, runTitle: latest.runTitle, status: latest.status, createdAt: latest.createdAt, completedAt: latest.completedAt } : null,
      skills: mounted.map((s) => s.name),
      recentTasks: tasks.value.slice(0, RECENT_TASKS),
      ops: ops.value,
      usage: usage.value.find((u) => u.since === OPS_WINDOW) ?? null,
      protocolSha,
    },
    instructions: {
      source: project
        ? `composeSystemPrompt over ${claudeMdPath}, ${constraintsDir}, the seed generation's agent protocol and project ${project.key}'s ${join(project.dir, ".forge")} (addendum and constraints)`
        : `composeSystemPrompt over ${claudeMdPath}, ${constraintsDir} and the seed generation's agent protocol — host-only: pick a project in Scope to see its addendum`,
      project: project ?? null,
      ...composed,
    },
    harness: {
      source: `forge model resolve ${role} --activity <a> (src/v2/model-resolve-report.ts) over model policy ${policySource.path ?? `(${policySource.source})`}; container facts from ${runtime.path ?? runtime.name} and src/v2/spawn.ts`,
      activities: harness.rows,
      policyError: harness.policyError,
      container,
      settings,
      runtime: { name: runtime.name, source: runtime.source, path: runtime.path, text: runtime.text, kind: runtime.kind, authStrategy: runtime.authStrategy, authMode: runtime.authMode, image: runtime.image, error: runtime.error },
      authStrategy: runtime.authStrategy,
      runtimeBoundBy: resolution.resolvedBy ? `model policy ${resolution.resolvedBy} (${resolution.provider ?? "?"}/${resolution.auth ?? "?"})` : "legacy (no model policy): the runtime detected from the environment",
      edit: {
        settings: `seeds/agents/${role}/settings.json in the forge release, installed to ${settings.path} — published by forge upgrade`,
        runtime: `seeds/runtimes/${runtime.name}.yml in the forge release${runtime.path ? `, read from ${runtime.path}` : ""} — published by forge upgrade`,
        policy: `model policy ${policySource.path ?? "(none: legacy mode)"} — edit model-policy.yml; forge never writes it`,
      },
    },
    skills: {
      source: `container: the ${runtime.name} runtime's skill mounts${runtime.path ? ` (${runtime.path})` : ""}, each SKILL.md's frontmatter${project ? ` and ${join(project.dir, ".claude", "skills")}` : ""}; host-only: ${skills.dir}; references: ${claudeMdPath}`,
      mounted,
      hostOnly: skills.skills,
      available: [] as unknown[],
      availableNote: "The skill registry (FG-797/FG-798) will list skills this role could mount but does not; until it lands this section is empty.",
      runtimeError: runtime.error,
    },
    capabilities: {
      source: `model policy ${policySource.path ?? `(${policySource.source})`}; routing policy ${policyPath ?? "(no seed generation)"}; ${resultContract.source ?? `${claudeMdPath} (no output schema)`}; constraints ${constraintsDir}${project ? ` and ${join(project.dir, ".forge", "constraints")}` : ""}`,
      activities: harness.rows.map((r) => ({ activity: r.activity, isDefault: r.isDefault, profile: r.profile, model: r.model, dispatchable: r.dispatchable, resolvedBy: r.resolvedBy, error: r.error })),
      routingPolicy: { path: policyPath, available: policy !== undefined },
      routes: routesNamingRole(policy, role),
      resultContract: { ...resultContract, note: resultContract.declared ? null : "not declared" },
      mountMode: mount,
      constraints: constraints.value,
      constraintsError: constraints.error,
    },
    secrets: {
      source: "the dispatch mount set: no project secret is mounted or passed into a container",
      text: ROLE_SECRETS_TEXT,
    },
    tools: {
      source: `declared: ${settings.path}; effective: ${container.source}${toolchain.source ? `; toolchain ${toolchain.source}` : ""}`,
      settingsPresent: settings.present,
      declared: settings.tools,
      enforced: false,
      note: "declared, not enforced: nothing outside tests reads settings.json's tools list",
      mcp: "none",
      effective: {
        mounts: container.mounts.map((m) => ({ path: m.path, mode: m.mode, optional: m.optional })),
        network: container.network,
        toolchain,
        mcp: "none",
      },
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
      source: "model_calls joined to tasks by agent_role in forge.db (forge usage show --by role --since <w>); provider and auth from each call's task (tasks.resolved_provider, resolved_auth)",
      windows: usage.value.map((w) => {
        const b = breakdown.value.get(w.since) ?? { byModel: [], byProvider: [] };
        return { ...w, byModel: b.byModel, byProvider: b.byProvider.map((p) => ({ ...p, ...providerCost(p) })) };
      }),
      pricing: PRICING,
      ceilings: "none: per-role spend ceilings are a future ticket",
    },
  };
}
