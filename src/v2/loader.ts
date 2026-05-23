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
import { WorkflowSchema, RuntimeSchema, type Workflow, type Runtime } from "./schema.js";

// Resolved lazily so tests can swap FORGE_HOME between cases. Cheap.
function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

export type LoadContext = {
  /** Absolute path to the project dir. Used to look up the project's override. */
  projectDir?: string;
};

export function loadWorkflow(name: string, ctx: LoadContext = {}): Workflow {
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "workflows", `${name}.yml`)
    : undefined;
  const workspacePath = join(forgeHome(), "workflows", `${name}.yml`);

  const path = projectPath && existsSync(projectPath) ? projectPath : workspacePath;
  if (!existsSync(path)) {
    throw new Error(
      `workflow '${name}' not found at ${projectPath ?? workspacePath} (or workspace default)`
    );
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
  return result.data;
}

export function loadRuntime(name: string, ctx: LoadContext = {}): Runtime {
  // Sentinel: `claude` means "auto-detect from env" — but only if no literal
  // `claude.yml` exists at the workspace path. This keeps tests and ad-hoc
  // installs working with a single `claude.yml` while production seeds ship
  // claude-bedrock.yml / claude-oauth.yml / claude-apikey.yml for detection.
  let resolvedName = name;
  if (name === "claude") {
    const literalProject = ctx.projectDir
      ? join(ctx.projectDir, ".forge", "runtimes", "claude.yml")
      : undefined;
    const literalWorkspace = join(forgeHome(), "runtimes", "claude.yml");
    if (!(literalProject && existsSync(literalProject)) && !existsSync(literalWorkspace)) {
      resolvedName = detectRuntimeName(ctx);
    }
  }

  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "runtimes", `${resolvedName}.yml`)
    : undefined;
  const workspacePath = join(forgeHome(), "runtimes", `${resolvedName}.yml`);

  const path = projectPath && existsSync(projectPath) ? projectPath : workspacePath;
  if (!existsSync(path)) {
    throw new Error(
      `runtime '${resolvedName}' not found at ${projectPath ?? workspacePath} (or workspace default)`
    );
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

function formatZodError(prefix: string, err: import("zod").ZodError): string {
  const lines: string[] = [`${prefix}: schema validation failed`];
  for (const issue of err.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    lines.push(`  - ${path}: ${issue.message}`);
  }
  return lines.join("\n");
}
