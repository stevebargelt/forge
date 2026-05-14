// forge v2 — template substitution.
//
// Runtime YAML strings can reference variables: ${TASK_DIR}, ${MODEL}, etc.
// `${VAR}` substitutes from the context map, throws if missing.
// `${VAR:-default}` substitutes with a fallback. Default is treated as a
// literal string (no recursive substitution).
//
// Variables come from two places:
//   - Runner-supplied context (TASK_DIR, MODEL, SYSTEM_PROMPT, etc. — see
//     SCHEMA.md "Template substitution")
//   - process.env (for things like AWS_REGION)
//
// Lookup order: context first, then process.env, then default (if `${VAR:-d}`),
// else throw with the variable name.

export type SubstContext = Record<string, string | undefined>;

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function substitute(template: string, ctx: SubstContext): string {
  return template.replace(VAR_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const fromCtx = ctx[name];
    if (fromCtx !== undefined && fromCtx !== "") return fromCtx;
    const fromEnv = process.env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    if (fallback !== undefined) return fallback;
    throw new Error(`template variable '\${${name}}' is not defined (no context, no env, no fallback)`);
  });
}

// Variant that returns undefined instead of throwing when a required variable
// is missing. Used by optional mount resolution: an unset DESIGN_DIR shouldn't
// throw, it should signal "skip this mount."
export function substituteOptional(template: string, ctx: SubstContext): string | undefined {
  try {
    const result = substitute(template, ctx);
    return result === "" ? undefined : result;
  } catch {
    return undefined;
  }
}

// Expand ~ to homedir(). Many runtime YAML mounts reference ~/pi-skills/... and
// docker bind-mounts can't expand ~ on their own.
import { homedir } from "node:os";

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}
