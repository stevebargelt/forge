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
  const projectPath = ctx.projectDir
    ? join(ctx.projectDir, ".forge", "runtimes", `${name}.yml`)
    : undefined;
  const workspacePath = join(forgeHome(), "runtimes", `${name}.yml`);

  const path = projectPath && existsSync(projectPath) ? projectPath : workspacePath;
  if (!existsSync(path)) {
    throw new Error(
      `runtime '${name}' not found at ${projectPath ?? workspacePath} (or workspace default)`
    );
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`runtime '${name}' (${path}): YAML parse error — ${(e as Error).message}`);
  }
  const result = RuntimeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(`runtime '${name}' (${path})`, result.error));
  }
  return result.data;
}

function formatZodError(prefix: string, err: import("zod").ZodError): string {
  const lines: string[] = [`${prefix}: schema validation failed`];
  for (const issue of err.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    lines.push(`  - ${path}: ${issue.message}`);
  }
  return lines.join("\n");
}
