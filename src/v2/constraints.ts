// forge v2 — constraint loader/filter. Migrated from src/spine/constraints.ts.
//
// Constraints are markdown files with YAML frontmatter (id, level, roles,
// workflows, phases, antiPrompt). They feed into composeSystemPrompt's tier 3
// (suggest-level) for blue agents and into reds' anti-prompts (force-level).
//
// v2 difference vs v1: workflow is `string` not `WorkflowName` — v2 workflow
// names are arbitrary YAML names, not a fixed union.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { CONSTRAINTS_DIR } from "../util/paths.js";

export type ConstraintLevel = "suggest" | "force";

export type Constraint = {
  id: string;
  level: ConstraintLevel;
  roles: string[];
  workflows: string[];
  phases?: string[];
  tags: string[];
  body: string;
  antiPrompt?: string;
};

export function loadAllConstraints(dir: string = CONSTRAINTS_DIR): Constraint[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  return files.map((f) => parseConstraintFile(join(dir, f)));
}

// FG-775 (FG-767 T2): the project's additive constraint layer lives here.
export function projectConstraintsDir(projectDir: string): string {
  return join(projectDir, ".forge", "constraints");
}

// FG-775 (FG-767 T2): THE ONE resolver for the effective constraint set, consumed by BOTH
// compose's suggest set and the reds' force anti-prompt set — do not fork this logic.
//
// Effective set = HOST set UNION PROJECT set (<projectDir>/.forge/constraints). The host set
// is ALWAYS fully included; the project set is ADDITIVE-ONLY — a project can make guardrails
// MORE restrictive but can NEVER drop or weaken a host constraint. On an id collision the HOST
// constraint WINS (never last-writer-wins): a project constraint sharing a host id is dropped,
// so its content/level cannot replace the host's — the force-level ones especially.
//
// A missing project layer (no projectDir, or no <projectDir>/.forge/constraints) is a clean
// no-op: the host set alone, byte-identical to before this change. A malformed file in EITHER
// layer throws from parseConstraintFile (loud/safe) — never a silent skip, which would be an
// invisible guardrail gap.
export function loadEffectiveConstraints(opts: { hostDir: string; projectDir?: string }): Constraint[] {
  const host = loadAllConstraints(opts.hostDir);
  if (opts.projectDir === undefined) return host;
  const hostIds = new Set(host.map((c) => c.id));
  const project = loadAllConstraints(projectConstraintsDir(opts.projectDir));
  const additive = project.filter((c) => !hostIds.has(c.id));
  return [...host, ...additive];
}

export function parseConstraintFile(path: string): Constraint {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Partial<Record<string, unknown>>;
  const id = fm["id"];
  const level = fm["level"];
  if (typeof id !== "string" || (level !== "suggest" && level !== "force")) {
    throw new Error(`Constraint ${path} missing required frontmatter (id, level)`);
  }
  return {
    id,
    level: level as ConstraintLevel,
    roles: Array.isArray(fm["roles"]) ? (fm["roles"] as string[]) : [],
    workflows: Array.isArray(fm["workflows"]) ? (fm["workflows"] as string[]) : [],
    phases: Array.isArray(fm["phases"]) ? (fm["phases"] as string[]) : undefined,
    tags: Array.isArray(fm["tags"]) ? (fm["tags"] as string[]) : [],
    body: parsed.content.trim(),
    antiPrompt: typeof fm["antiPrompt"] === "string" ? fm["antiPrompt"] : undefined,
  };
}

export function filterConstraints(
  all: Constraint[],
  opts: { role: string; workflow: string; phase: string; level?: ConstraintLevel; runTags?: string[] },
): Constraint[] {
  return all.filter((c) => {
    if (opts.level && c.level !== opts.level) return false;
    if (c.roles.length > 0 && !c.roles.includes(opts.role)) return false;
    if (c.workflows.length > 0 && !c.workflows.includes(opts.workflow)) return false;
    if (c.phases && c.phases.length > 0 && !c.phases.includes(opts.phase)) return false;
    if (c.tags.length > 0 && !c.tags.some((t) => (opts.runTags ?? []).includes(t))) return false;
    return true;
  });
}
