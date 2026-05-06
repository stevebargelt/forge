import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Constraint, ConstraintLevel, WorkflowName } from "../types/index.js";
import { CONSTRAINTS_DIR } from "../util/paths.js";

export function loadAllConstraints(dir: string = CONSTRAINTS_DIR): Constraint[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  return files.map((f) => parseConstraintFile(join(dir, f)));
}

export function parseConstraintFile(path: string): Constraint {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Partial<Record<string, unknown>>;
  const id = fm.id;
  const level = fm.level;
  if (typeof id !== "string" || (level !== "suggest" && level !== "force")) {
    throw new Error(`Constraint ${path} missing required frontmatter (id, level)`);
  }
  return {
    id,
    level: level as ConstraintLevel,
    roles: Array.isArray(fm.roles) ? (fm.roles as string[]) : [],
    workflows: Array.isArray(fm.workflows) ? (fm.workflows as WorkflowName[]) : [],
    phases: Array.isArray(fm.phases) ? (fm.phases as string[]) : undefined,
    body: parsed.content.trim(),
    antiPrompt: typeof fm.antiPrompt === "string" ? fm.antiPrompt : undefined,
  };
}

export function filterConstraints(
  all: Constraint[],
  opts: { role: string; workflow: WorkflowName; phase: string; level?: ConstraintLevel }
): Constraint[] {
  return all.filter((c) => {
    if (opts.level && c.level !== opts.level) return false;
    if (c.roles.length > 0 && !c.roles.includes(opts.role)) return false;
    if (c.workflows.length > 0 && !c.workflows.includes(opts.workflow)) return false;
    if (c.phases && c.phases.length > 0 && !c.phases.includes(opts.phase)) return false;
    return true;
  });
}
