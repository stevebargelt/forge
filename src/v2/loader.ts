// forge v2 — YAML loader.
//
// Reads workflow and runtime YAML files from ~/.forge/ (workspace default)
// with optional override at <project>/.forge/ (full replacement, not merge).
// Validates via Zod and returns typed objects.
//
// Resolution order for workflow `<name>`:
//   1. <projectDir>/.forge/workflows/<name>.yml  (full replacement if present)
//   2. ~/.forge/workflows/<name>.yml             (workspace default)
//
// Same for runtimes: <projectDir>/.forge/runtimes/<name>.yml then
// ~/.forge/runtimes/<name>.yml.
//
// Errors are thrown synchronously with the offending YAML path in the
// message — callers (the CLI / dashboard) format them for humans.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  WorkflowSchema,
  RuntimeSchema,
  ModelPolicySchema,
  type Workflow,
  type Runtime,
  type ModelPolicy,
} from "./schema.js";
import { sha256OfBytes } from "../util/content-digest.js";
import {
  generationCategoryDir,
  resolveSeedGeneration,
  inspectSeedInstall,
  type SeedGeneration,
} from "./seed-generation.js";

// Resolved lazily so tests can swap FORGE_HOME between cases. Cheap.
function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

export type LoadContext = {
  /** Absolute path to the project dir. Used to look up the project's override. */
  projectDir?: string;
  /** Absolute path to the forge source repo. Forwarded to image inspection for Dockerfile mtime comparison. */
  forgeRepoDir?: string;
  /** FG-583: the seed generation this invocation is anchored to. Captured ONCE at
   *  dispatch/run entry (resolveSeedGeneration) and threaded here so every lazy load
   *  reads the SAME complete generation for the life of the invocation — an
   *  already-running invocation stays anchored to the generation it opened even if
   *  the seed pointer swaps mid-run.
   *
   *  `undefined` (the ordinary case) means "resolve the live seed pointer per call";
   *  because publication is a single atomic swap, a per-call resolve still observes
   *  ONE complete generation, never a mix. `null` means "no generation anchored" — and
   *  since there is no flat dispatch fallback (see workspaceGeneration), a dispatch
   *  load then REFUSES rather than reading the pre-migration flat layout. A resolved
   *  generation pins this invocation. */
  seedGeneration?: SeedGeneration | null;
};

/** THE single dispatch-side resolve point for the forge-owned, dispatch-coupled seed
 *  surface (workflows / runtimes). Returns the anchored-or-live-resolved generation,
 *  or null when NONE is published.
 *
 *  FG-583 (invariant moved here): there is no flat-layout dispatch fallback. When this
 *  returns null the host has no complete seed generation, and every dispatch consumer
 *  (next / invoke / gate / campaign / continue / model-resolution / runNext) reaches
 *  the seed surface THROUGH the loaders below — so they all inherit one named,
 *  repairable refusal (noCompleteGenerationError) from this ONE place, rather than each
 *  gating for the state itself. The flat $FORGE_HOME/<category> copies still exist for
 *  the FG-579 drift detector and doctor's runtime registry, but neither dispatches, so
 *  the flat surface is never a dispatch source. A project override is resolved by each
 *  loader BEFORE consulting this, so it is honored and never refused. */
function workspaceGeneration(ctx: LoadContext): SeedGeneration | null {
  return ctx.seedGeneration !== undefined ? ctx.seedGeneration : resolveSeedGeneration(forgeHome());
}

/** The named, repairable refusal raised when a dispatch load needs the host seed
 *  surface but no complete generation is published — distinct wording for an
 *  incomplete (torn/mid-publish) generation vs an absent one, from inspectSeedInstall. */
function noCompleteGenerationError(category: "workflows" | "runtimes"): Error {
  const home = forgeHome();
  const state = inspectSeedInstall(home);
  const head =
    state.kind === "incomplete"
      ? `the seed install is incomplete: ${state.reason}`
      : `no seed generation is published for this $FORGE_HOME (${home})`;
  return new Error(
    `refusing to dispatch — no complete seed generation is published; ${head}\n` +
      `The forge-owned ${category} surface is published as ONE atomic seed generation; forge will not ` +
      `dispatch under the flat pre-migration layout (kept only for drift detection / doctor, never for ` +
      `dispatch).\n` +
      `Fix: run \`forge upgrade\` to publish a complete seed generation. A project override at ` +
      `<project>/.forge/${category}/<name>.yml is always honored and never refused.`,
  );
}

// FG-583: a workflow resolved from within a published generation is measured
// against the generation's OWN provenance manifest, not the executing-release
// assetRoot baseline (FG-579's original measure). The generation is internally
// consistent BY CONSTRUCTION — published atomically from one assetRoot — so this
// only ever fires on a genuinely mixed/incomplete generation, which it NAMES as
// such rather than re-checking bytes file-by-file against a moving baseline. This
// is the re-anchoring that keeps the two-pointer window (Risk#2) from producing a
// spurious hard refusal after promoting a new interpreter before its seeds commit.
function assertGenerationWorkflowConsistent(
  name: string,
  installedPath: string,
  generation: SeedGeneration,
): void {
  const rel = `workflows/${name}.yml`;
  const expected = generation.manifest.files[rel];
  // This runs ONLY for a workflow resolved FROM the generation (callers guard with
  // !isProject && generation), so a missing manifest entry is not "project-only" —
  // it is a file present inside the generation dir that the generation's provenance
  // manifest never published (a torn/tampered generation with an EXTRA file). Refuse
  // it, exactly as a byte-mismatch is refused: a generation-owned dispatch surface is
  // a CLOSED set, not merely per-file digest-checked.
  if (!expected) {
    throw new Error(
      `workflow '${name}' resolves inside the published seed generation but is not in its provenance manifest — ` +
        `refusing to dispatch an unmanifested file.\n` +
        `  installed:   ${installedPath}\n` +
        `  generation:  ${generation.root}\n` +
        `The seed generation is published atomically as one complete unit; a file present under the generation ` +
        `but absent from its manifest means this generation is torn or was tampered with — a state no release shipped.\n` +
        `Fix: forge upgrade to republish a complete generation.`,
    );
  }
  if (sha256OfBytes(installedPath) === expected) return;
  throw new Error(
    `workflow '${name}' does not match its published seed generation — refusing to dispatch a mixed/incomplete generation.\n` +
      `  installed:   ${installedPath}\n` +
      `  generation:  ${generation.root}\n` +
      `The seed generation is published atomically as one complete unit, so a workflow whose bytes differ ` +
      `from the generation's own manifest means this generation is torn or mid-publish — a state no release ` +
      `shipped. Forge refuses rather than dispatch under it.\n` +
      `Fix: forge upgrade to republish a complete generation.`,
  );
}

// FG-583: runtimes ride inside the atomic generation exactly as workflows do, so a
// runtime resolved from within a published generation is held to the SAME provenance
// check — its bytes must match the generation's OWN manifest. Without this a
// changed/replaced/missing runtime inside a purported generation stays Zod-valid and
// silently alters the dispatched runtime, defeating the complete release-owned
// workflows+runtimes surface the generation is supposed to guarantee.
function assertGenerationRuntimeConsistent(
  name: string,
  installedPath: string,
  generation: SeedGeneration,
): void {
  const rel = `runtimes/${name}.yml`;
  const expected = generation.manifest.files[rel];
  // Runs ONLY for a runtime resolved FROM the generation (callers guard with
  // !isProject && generation): a missing manifest entry is an unmanifested file
  // present in the generation dir (torn/tampered EXTRA file), not a project symbol.
  // Refuse it — the generation-owned runtime surface is a CLOSED set.
  if (!expected) {
    throw new Error(
      `runtime '${name}' resolves inside the published seed generation but is not in its provenance manifest — ` +
        `refusing to dispatch an unmanifested file.\n` +
        `  installed:   ${installedPath}\n` +
        `  generation:  ${generation.root}\n` +
        `The seed generation is published atomically as one complete unit; a file present under the generation ` +
        `but absent from its manifest means this generation is torn or was tampered with — a state no release shipped.\n` +
        `Fix: forge upgrade to republish a complete generation.`,
    );
  }
  if (sha256OfBytes(installedPath) === expected) return;
  throw new Error(
    `runtime '${name}' does not match its published seed generation — refusing to dispatch a mixed/incomplete generation.\n` +
      `  installed:   ${installedPath}\n` +
      `  generation:  ${generation.root}\n` +
      `The seed generation is published atomically as one complete unit, so a runtime whose bytes differ ` +
      `from the generation's own manifest means this generation is torn or mid-publish — a state no release ` +
      `shipped. Forge refuses rather than dispatch under it.\n` +
      `Fix: forge upgrade to republish a complete generation.`,
  );
}

// FG-579 note: the drifted-HOST-workflow refusal that used to live here (a
// byte-compare of the FLAT $FORGE_HOME/workflows against the release baseline) is
// subsumed by FG-583's no-flat-dispatch contract. The flat layout is never a dispatch
// source now, so a drifted flat workflow is refused wholesale (noCompleteGenerationError)
// before any per-file drift measure would run. Drift WITHIN a published generation —
// a hand-edited file inside the generation dir — is still caught, by
// assertGenerationWorkflowConsistent against the generation's own manifest. The FG-335
// advisory detector (detectSeedDrift) is unchanged.

export function loadWorkflow(name: string, ctx: LoadContext = {}): Workflow {
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "workflows", `${name}.yml`)
    : undefined;
  const isProject = !!(projectPath && existsSync(projectPath));

  let path: string;
  let generation: SeedGeneration | null;
  if (isProject) {
    path = projectPath!;
    generation = null;
  } else {
    generation = workspaceGeneration(ctx);
    if (!generation) throw noCompleteGenerationError("workflows");
    path = join(generationCategoryDir(generation, "workflows"), `${name}.yml`);
    if (!existsSync(path)) {
      throw new Error(`workflow '${name}' not found at ${path} (or project override)`);
    }
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`workflow '${name}' (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`workflow '${name}' (${path})`, result.error));
  }
  if (result.data.name !== name) {
    throw new Error(
      `workflow at ${path} declares name='${result.data.name}' but was loaded by name='${name}' — they must match`
    );
  }
  // A project override is intentional operator specialization — never refused. A
  // resolved generation is measured against its OWN provenance manifest.
  if (!isProject && generation) {
    assertGenerationWorkflowConsistent(name, path, generation);
  }
  return result.data;
}

export function loadRuntime(name: string, ctx: LoadContext = {}): Runtime {
  const generation = workspaceGeneration(ctx);
  // Sentinel: `claude` means "auto-detect from env" — but only if no literal
  // `claude.yml` exists at the project override or within the resolved generation.
  // This keeps tests and ad-hoc installs working with a single `claude.yml` while
  // production seeds ship claude-bedrock.yml / claude-oauth.yml / claude-apikey.yml
  // for detection.
  let resolvedName = name;
  if (name === "claude") {
    const literalProject = ctx.projectDir
      ? join(ctx.projectDir, ".forge", "runtimes", "claude.yml")
      : undefined;
    const literalWorkspace = generation
      ? join(generationCategoryDir(generation, "runtimes"), "claude.yml")
      : undefined;
    if (!(literalProject && existsSync(literalProject)) && !(literalWorkspace && existsSync(literalWorkspace))) {
      resolvedName = detectRuntimeName(ctx);
    }
  }

  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "runtimes", `${resolvedName}.yml`)
    : undefined;
  const isProject = !!(projectPath && existsSync(projectPath));

  let path: string;
  if (isProject) {
    path = projectPath!;
  } else {
    if (!generation) throw noCompleteGenerationError("runtimes");
    path = join(generationCategoryDir(generation, "runtimes"), `${resolvedName}.yml`);
    if (!existsSync(path)) {
      throw new Error(`runtime '${resolvedName}' not found at ${path} (or project override)`);
    }
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`runtime '${resolvedName}' (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = RuntimeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`runtime '${resolvedName}' (${path})`, result.error));
  }
  // A project override is intentional operator specialization — never refused. A
  // resolved generation is measured against its OWN provenance manifest.
  if (!isProject && generation) {
    assertGenerationRuntimeConsistent(resolvedName, path, generation);
  }
  return result.data;
}

/** Stamp the resolved model id at task-create time. Loads the runtime YAML,
 *  resolves alias → concrete model id (e.g. `spec-writer` → `us.anthropic.claude-sonnet-4-6`),
 *  returns it. Returns undefined if the runtime fails to load — we don't want
 *  a model-lookup failure to block task creation; the task itself will fail
 *  at dispatch with a clearer error.
 *
 *  Use this at every insertTask site where a real container will run, so the
 *  task row records which model was intended. The dashboard reads this for
 *  per-task model badges; orchestrators / debuggers read it via `forge show`.
 */
export function resolveModelForTask(
  runtimeName: string,
  alias: string | undefined,
  ctx: LoadContext = {}
): string | undefined {
  try {
    const runtime = loadRuntime(runtimeName, ctx);
    if (!alias) return runtime.models["default"];
    return runtime.models[alias] ?? runtime.models["default"];
  } catch {
    return undefined;
  }
}

// Resolves `runtime: claude` (the schema default) into a concrete runtime name
// by reading env. Order mirrors v1's detectCredsMode():
//   1. Bedrock: CLAUDE_CODE_USE_BEDROCK=1
//   2. API key: ANTHROPIC_API_KEY set
//   3. OAuth (default)
function detectRuntimeName(_ctx: LoadContext): string {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") return "claude-bedrock";
  if (process.env.ANTHROPIC_API_KEY) return "claude-apikey";
  return "claude-oauth";
}

/** Load model-policy.yml if present. Policy is OPT-IN: returns undefined when no
 *  file exists at either the project or workspace path, and callers fall back to
 *  legacy runtime.models[alias] resolution (behavior unchanged). When present,
 *  the project file fully replaces the workspace file — same override semantics
 *  as workflows/runtimes. Throws (with the path) on parse / validation failure.
 *
 *  Note: this returns the single effective policy document. The ADR's §4 Pass-2
 *  precedence (project > user > forge-default) is applied by the resolver that
 *  consumes this, not here. */
export function loadModelPolicy(ctx: LoadContext = {}): ModelPolicy | undefined {
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "model-policy.yml")
    : undefined;
  const workspacePath = join(forgeHome(), "model-policy.yml");

  const path =
    projectPath && existsSync(projectPath)
      ? projectPath
      : existsSync(workspacePath)
        ? workspacePath
        : undefined;
  if (!path) return undefined; // no policy → legacy resolution, behavior unchanged

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`model-policy (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = ModelPolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`model-policy (${path})`, result.error));
  }
  return result.data;
}

// --- Provenance-returning loader variants ---
//
// Each *WithSource variant applies identical resolution logic to its existing
// counterpart but also returns which config layer supplied the file ('host' for
// workspace, 'project' for project-level override) plus the resolved path.
// These are consumed by the control-plane receipt (FG-350) to record dispatch-
// time provenance without modifying any existing caller.

/** Augments a loaded object T with the config layer that supplied it. */
export type LoadedWithSource<T> = T & { source: "host" | "project"; path: string };

export function loadWorkflowWithSource(
  name: string,
  ctx: LoadContext = {},
): LoadedWithSource<Workflow> {
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "workflows", `${name}.yml`)
    : undefined;
  const isProject = !!(projectPath && existsSync(projectPath));

  let path: string;
  let generation: SeedGeneration | null;
  if (isProject) {
    path = projectPath!;
    generation = null;
  } else {
    generation = workspaceGeneration(ctx);
    if (!generation) throw noCompleteGenerationError("workflows");
    path = join(generationCategoryDir(generation, "workflows"), `${name}.yml`);
    if (!existsSync(path)) {
      throw new Error(`workflow '${name}' not found at ${path} (or project override)`);
    }
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`workflow '${name}' (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`workflow '${name}' (${path})`, result.error));
  }
  if (result.data.name !== name) {
    throw new Error(
      `workflow at ${path} declares name='${result.data.name}' but was loaded by name='${name}' — they must match`
    );
  }
  if (!isProject && generation) {
    assertGenerationWorkflowConsistent(name, path, generation);
  }
  return { ...result.data, source: isProject ? "project" : "host", path };
}

export function loadRuntimeWithSource(
  name: string,
  ctx: LoadContext = {}
): LoadedWithSource<Runtime> {
  const generation = workspaceGeneration(ctx);
  let resolvedName = name;
  if (name === "claude") {
    const literalProject = ctx.projectDir
      ? join(ctx.projectDir, ".forge", "runtimes", "claude.yml")
      : undefined;
    const literalWorkspace = generation
      ? join(generationCategoryDir(generation, "runtimes"), "claude.yml")
      : undefined;
    if (!(literalProject && existsSync(literalProject)) && !(literalWorkspace && existsSync(literalWorkspace))) {
      resolvedName = detectRuntimeName(ctx);
    }
  }

  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "runtimes", `${resolvedName}.yml`)
    : undefined;
  const isProject = !!(projectPath && existsSync(projectPath));

  let path: string;
  if (isProject) {
    path = projectPath!;
  } else {
    if (!generation) throw noCompleteGenerationError("runtimes");
    path = join(generationCategoryDir(generation, "runtimes"), `${resolvedName}.yml`);
    if (!existsSync(path)) {
      throw new Error(`runtime '${resolvedName}' not found at ${path} (or project override)`);
    }
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `runtime '${resolvedName}' (${path}): YAML parse error — ${(e as Error).message}`
    );
  }
  const result = RuntimeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`runtime '${resolvedName}' (${path})`, result.error));
  }
  if (!isProject && generation) {
    assertGenerationRuntimeConsistent(resolvedName, path, generation);
  }
  return { ...result.data, source: isProject ? "project" : "host", path };
}

/** Discriminated union returned by loadModelPolicyWithSource. */
export type ModelPolicyWithSource =
  | { source: "host" | "project"; path: string; policy: ModelPolicy }
  | { source: "absent"; policy: undefined };

export function loadModelPolicyWithSource(ctx: LoadContext = {}): ModelPolicyWithSource {
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "model-policy.yml")
    : undefined;
  const workspacePath = join(forgeHome(), "model-policy.yml");

  const isProject = !!(projectPath && existsSync(projectPath));
  const path = isProject
    ? projectPath!
    : existsSync(workspacePath)
      ? workspacePath
      : undefined;

  if (!path) return { source: "absent", policy: undefined };

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`model-policy (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = ModelPolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`model-policy (${path})`, result.error));
  }
  return { source: isProject ? "project" : "host", path, policy: result.data };
}

function formatZodError(prefix: string, err: import("zod").ZodError): string {
  const lines: string[] = [`${prefix}: schema validation failed`];
  for (const issue of err.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    lines.push(`  - ${path}: ${issue.message}`);
  }
  return lines.join("\n");
}
