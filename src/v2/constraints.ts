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
import { readAiAttribution } from "./ai-attribution.js";

export type ConstraintLevel = "suggest" | "force";

// FG-799: an OPTIONAL declared toggle. When present, the constraint is included in
// the effective set ONLY when the named project config equals the given value. The
// only config understood today is `ai_attribution`; an unknown config never matches
// (the constraint is skipped rather than silently kept). A constraint with no
// enabled_when behaves exactly as before.
export type ConstraintEnabledWhen = { config: string; equals: string };

export type Constraint = {
  id: string;
  level: ConstraintLevel;
  roles: string[];
  workflows: string[];
  phases?: string[];
  tags: string[];
  body: string;
  antiPrompt?: string;
  enabledWhen?: ConstraintEnabledWhen;
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
export type ConstraintSkip = { id: string; reason: string };
// `skipped` — constraints DROPPED from the effective set by a host enabled_when gate.
// `ignoredEnabledWhen` — constraints KEPT (active) whose enabled_when was NOT honored
// because it was declared by the PROJECT layer, not the host (FG-799 / RF-2). These are
// distinct: a dropped constraint does not enforce; an ignored-gate one enforces
// unconditionally. Do not conflate them into one list.
export type EffectiveConstraints = {
  constraints: Constraint[];
  skipped: ConstraintSkip[];
  ignoredEnabledWhen: ConstraintSkip[];
};

// FG-799: the toggle-aware resolver. Builds the host-union-project set exactly as
// before (host-wins on id collision), then evaluates enabled_when against the
// PROJECT's config — but ONLY for HOST-declared constraints, dropping the ones whose
// toggle does not hold and recording an auditable skip note. A constraint without
// enabled_when is always kept — so a tree with no toggled constraints is byte-identical
// to before, with an empty `skipped`. Host-wins is UNCHANGED: a project constraint
// colliding with a host id is dropped up front, so it can never supply an enabled_when
// for a host rule.
//
// RF-2: enabled_when is honored ONLY on the HOST copy of a constraint. A project-layer
// ADDITIVE constraint that carries enabled_when must NOT be able to gate its own
// enforcement on project-controlled config — that would let a project make its guardrail
// contingent on a value it also owns. Such a constraint is therefore loaded WITHOUT the
// gate (always active), and the ignored field is recorded in `ignoredEnabledWhen`.
export function resolveEffectiveConstraints(opts: {
  hostDir: string;
  projectDir?: string;
}): EffectiveConstraints {
  const host = loadAllConstraints(opts.hostDir);
  const hostIds = new Set(host.map((c) => c.id));
  const project =
    opts.projectDir === undefined
      ? []
      : loadAllConstraints(projectConstraintsDir(opts.projectDir!)).filter((c) => !hostIds.has(c.id));

  // enabled_when today understands ONE config, ai_attribution, gating the host
  // no-ai-attribution force rule against the project's mode (default suppress).
  const aiMode = opts.projectDir ? readAiAttribution(opts.projectDir).mode : "suppress";
  const constraints: Constraint[] = [];
  const skipped: ConstraintSkip[] = [];
  const ignoredEnabledWhen: ConstraintSkip[] = [];

  for (const c of host) {
    if (c.enabledWhen) {
      const actual = c.enabledWhen.config === "ai_attribution" ? aiMode : undefined;
      if (actual !== c.enabledWhen.equals) {
        skipped.push({ id: c.id, reason: `toggle ${c.enabledWhen.config}=${actual ?? "unknown"}` });
        continue;
      }
    }
    constraints.push(c);
  }

  for (const c of project) {
    if (c.enabledWhen) {
      ignoredEnabledWhen.push({
        id: c.id,
        reason: `enabled_when ${c.enabledWhen.config}=${c.enabledWhen.equals} ignored (project layer; host-only gate)`,
      });
    }
    constraints.push(c);
  }

  return { constraints, skipped, ignoredEnabledWhen };
}

export function loadEffectiveConstraints(opts: { hostDir: string; projectDir?: string }): Constraint[] {
  return resolveEffectiveConstraints(opts).constraints;
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
    enabledWhen: parseEnabledWhen(fm["enabled_when"], path),
  };
}

// FG-799: parse the OPTIONAL enabled_when frontmatter. Absent → undefined (the
// constraint always applies). A present value must be an object with string
// `config` and `equals`; anything else throws (loud/safe — a malformed toggle must
// never silently become "always enabled" or "always skipped").
function parseEnabledWhen(raw: unknown, path: string): ConstraintEnabledWhen | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Constraint ${path} has a malformed enabled_when (expected { config, equals })`);
  }
  const obj = raw as Record<string, unknown>;
  const config = obj["config"];
  const equals = obj["equals"];
  if (typeof config !== "string" || typeof equals !== "string") {
    throw new Error(`Constraint ${path} enabled_when requires string 'config' and 'equals'`);
  }
  return { config, equals };
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
