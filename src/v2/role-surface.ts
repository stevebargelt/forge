// FG-817: the Roles surface's read model — every agent seed as an object, projected from
// what the host already carries. No new data and no write: a role's seed changes only
// through `forge upgrade` (invariant 4/7), so everything here is a READ of the installed
// seed ($FORGE_HOME/agents/<role>), the published seed generation (protocols, runtimes,
// workflows, the compiled routing policy) and the model policy. Nothing shells out
// (invariant 21) — the dashboard serves this on a GET.
//
// The composed instructions are composed by the SAME function every dispatch funnels
// through (composeSystemPrompt), against the synthetic `forge invoke` workflow shape, so
// the page shows the bytes a container would receive for an ad-hoc dispatch of the role
// rather than a re-assembly that could drift from it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { composeSystemPrompt } from "./compose.js";
import { invokeWorkflowShape } from "./invoke-shape.js";
import { REVIEW_DISPATCH_ROLES, RISK_LENSES, lensRole } from "./review-contract.js";
import {
  GENERATION_ROUTING_POLICY,
  protocolRelPath,
  readGenerationManifest,
  type SeedGeneration,
} from "./seed-generation.js";
import { seedGenerationsDirIn } from "../util/paths.js";
import { provenPhysical } from "../util/path-identity.js";
import { sha256OfString } from "../util/content-digest.js";
import { hostEditMigrationRootDir } from "./host-edit-migration.js";
import type { RoutingPolicy } from "../raci/policy-schema.js";

/** A role name as it may appear in a path segment: no separators, no dot-dirs. */
export function isRoleName(role: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(role);
}

export function roleAgentDir(home: string, role: string): string {
  return join(home, "agents", role);
}

/** Every installed role seed: a directory under $FORGE_HOME/agents carrying a CLAUDE.md. */
export function listSeedRoles(home: string): string[] {
  const dir = join(home, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isRoleName(e.name) && existsSync(join(dir, e.name, "CLAUDE.md")))
    .map((e) => e.name)
    .sort();
}

/** The seed's first prose paragraph — what the role is — skipping its `# role` title. */
export function roleDescription(claudeMd: string): string {
  const paragraphs = claudeMd.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const p of paragraphs) {
    const text = p.trim();
    if (text === "" || text.startsWith("#")) continue;
    return text.replace(/\s+/g, " ");
  }
  return "";
}

export type RoleRelation = "responsible" | "consulted" | "followup";
export type RoleRoute = { route: string; path: string; relations: RoleRelation[] };

/** The routes of a compiled routing policy that NAME `role`, and how: as the responsible
 *  agent, as consulted, or as a required follow-up. A route naming it twice lists both. */
export function routesNamingRole(policy: RoutingPolicy | undefined, role: string): RoleRoute[] {
  if (!policy) return [];
  const out: RoleRoute[] = [];
  for (const [route, r] of Object.entries(policy.routes)) {
    const relations: RoleRelation[] = [];
    if (r.responsible === role) relations.push("responsible");
    if (r.consulted.includes(role)) relations.push("consulted");
    if (r.required_followups.includes(role)) relations.push("followup");
    if (relations.length > 0) out.push({ route, path: r.path, relations });
  }
  return out;
}

export function generationRoutingPolicyPath(gen: SeedGeneration): string {
  return join(gen.root, GENERATION_ROUTING_POLICY);
}

/** Roles a generation workflow declares as a red — dispatched with /project read-only. */
export function generationRedRoles(gen: SeedGeneration | null): Set<string> {
  const reds = new Set<string>();
  if (!gen) return reds;
  const dir = join(gen.root, "workflows");
  if (!existsSync(dir)) return reds;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    try {
      const wf = parseYaml(readFileSync(join(dir, file), "utf8")) as { steps?: Array<{ reds?: Array<{ agent?: unknown }> }> };
      for (const step of wf?.steps ?? []) for (const red of step?.reds ?? []) if (typeof red?.agent === "string") reds.add(red.agent);
    } catch {
      // An unparseable workflow is the loader's refusal to name, not this read's.
    }
  }
  return reds;
}

export type MountMode = { mode: "rw" | "ro"; source: string };

/** The /project mount a role is dispatched under. The dispatch sites decide it, not the
 *  seed: a workflow red, and the review lane's risk-lens reviewers and rechecker, run
 *  read-only; everything else is a writable blue. */
export function roleMountMode(role: string, redRoles: Set<string>): MountMode {
  if (redRoles.has(role)) return { mode: "ro", source: "declared as a red in a seed-generation workflow" };
  if (RISK_LENSES.some((lens) => lensRole(lens) === role)) return { mode: "ro", source: "the review lane dispatches risk-lens reviewers read-only" };
  if (role === REVIEW_DISPATCH_ROLES.recheck) return { mode: "ro", source: "the review lane dispatches the rechecker read-only" };
  return { mode: "rw", source: "a blue dispatch mounts /project read-write" };
}

export type PromptSectionKind = "protocol" | "base" | "addendum" | "workflow" | "constraint" | "framing";
export type PromptSection = { kind: PromptSectionKind; title: string; id?: string; start: number; end: number };

const SEP = "\n\n---\n\n";

/** Split a composed prompt into its tiers. The sections TILE the prompt — each separator
 *  opens the section after it — so concatenating them gives back the exact bytes.
 *  `protocolLength` is the length of the tier-0 protocol text compose put first (0 for an
 *  uncovered role); every later tier is found by the heading compose gives it, searched
 *  from the end so a heading quoted inside the role seed cannot claim the real tier. */
export function segmentComposedPrompt(prompt: string, opts: { protocolLength: number }): PromptSection[] {
  const bounds: Array<{ kind: PromptSectionKind; at: number }> = [];
  let limit = prompt.length;
  const find = (kind: PromptSectionKind, heading: string) => {
    const at = prompt.lastIndexOf(SEP + heading, limit - 1);
    if (at > opts.protocolLength) {
      bounds.push({ kind, at });
      limit = at;
    }
  };
  find("framing", "## Output contract");
  find("constraint", "# Constraints\n\n");
  find("workflow", "# Workflow additions (step: ");
  find("addendum", "## Project-specific instructions (");
  if (opts.protocolLength > 0) bounds.push({ kind: "base", at: opts.protocolLength });
  bounds.push({ kind: opts.protocolLength > 0 ? "protocol" : "base", at: 0 });
  bounds.sort((a, b) => a.at - b.at);

  const sections: PromptSection[] = [];
  bounds.forEach((b, i) => {
    const end = bounds[i + 1]?.at ?? prompt.length;
    if (b.kind !== "constraint") {
      sections.push({ kind: b.kind, title: SECTION_TITLES[b.kind], start: b.at, end });
      return;
    }
    const body = prompt.slice(b.at, end);
    const starts = [...body.matchAll(/^## Constraint: (.+)$/gm)];
    starts.forEach((m, j) => {
      const id = m[1]!.trim();
      const start = j === 0 ? b.at : b.at + m.index!;
      const next = starts[j + 1];
      sections.push({ kind: "constraint", id, title: `Constraint: ${id}`, start, end: next ? b.at + next.index! : end });
    });
    if (starts.length === 0) sections.push({ kind: "constraint", title: "Constraints", start: b.at, end });
  });
  return sections;
}

const SECTION_TITLES: Record<PromptSectionKind, string> = {
  protocol: "Forge-owned agent protocol (seed generation)",
  base: "Role seed (CLAUDE.md)",
  addendum: "Project addendum",
  workflow: "Workflow additions",
  constraint: "Constraints",
  framing: "Output contract and run framing",
};

/** The content hash of a composed prompt, as the page names it. */
export function composedInstructionsHash(prompt: string): string {
  return sha256OfString(prompt);
}

export type ComposedInstructions =
  | {
      ok: true;
      context: string;
      prompt: string;
      sha256: string;
      sections: PromptSection[];
      protocol: { sha256: string; source: string } | null;
      constraintsSkipped: Array<{ id: string; reason: string }>;
    }
  | { ok: false; context: string; refusal: string };

/** The role's system prompt composed exactly as `forge invoke <role>` would hand it to a
 *  container, under the given mount mode. With `project` it is anchored at that project's
 *  dir the way dispatch anchors it (invoke.ts passes projectDir), so its `.forge` addendum
 *  and constraints are composed in; without it the prompt is host-only. A covered role
 *  whose protocol the generation cannot supply is refused by compose itself, and that
 *  refusal is what the page shows. */
export function composeRoleInstructions(opts: {
  home: string;
  role: string;
  generation: SeedGeneration | null;
  mountMode: "rw" | "ro";
  project?: { key: string; dir: string };
}): ComposedInstructions {
  const anchor = opts.project ? `project ${opts.project.key} anchored at ${opts.project.dir}` : "no project anchored";
  const context = `forge invoke ${opts.role} (workflow: invoke, step: task, /project ${opts.mountMode}, ${anchor})`;
  const { step, workflow } = invokeWorkflowShape(opts.role, undefined, undefined);
  const composed = composeSystemPrompt({
    role: opts.role,
    workflow,
    step,
    seedGeneration: opts.generation,
    agentDir: roleAgentDir(opts.home, opts.role),
    constraintsDir: join(opts.home, "constraints"),
    projectDir: opts.project?.dir,
    projectMode: opts.mountMode,
  });
  if (!composed.ok) return { ok: false, context, refusal: composed.refusal };
  const protocolLength = composed.protocol ? readFileSync(composed.protocol.source, "utf8").length : 0;
  return {
    ok: true,
    context,
    prompt: composed.prompt,
    sha256: composedInstructionsHash(composed.prompt),
    sections: segmentComposedPrompt(composed.prompt, { protocolLength }),
    protocol: composed.protocol ? { sha256: composed.protocol.sha256, source: composed.protocol.source } : null,
    constraintsSkipped: composed.constraintsSkipped.map((s) => ({ id: s.id, reason: s.reason })),
  };
}

export type GenerationEntry = {
  id: string;
  current: boolean;
  publishedAt: string;
  sourceAssetRoot: string;
  /** the role's protocol sha in that generation's manifest; null when it carries none. */
  protocolSha: string | null;
};

/** Every published generation under $FORGE_HOME/seed-generations, newest first. */
export function generationHistory(home: string, role: string, current: SeedGeneration | null): GenerationEntry[] {
  const dir = seedGenerationsDirIn(home);
  if (!existsSync(dir)) return [];
  // The pointer resolves physically; generation ids are unique names in this one dir.
  const currentId = current ? basename(current.root) : null;
  const out: GenerationEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const root = join(dir, e.name);
    const manifest = readGenerationManifest(root);
    if (!manifest) continue;
    out.push({
      id: e.name,
      current: e.name === currentId,
      publishedAt: statSync(root).mtime.toISOString(),
      sourceAssetRoot: manifest.sourceAssetRoot,
      protocolSha: manifest.files[protocolRelPath(role)] ?? null,
    });
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id));
}

/** The seed generation a recorded protocol source path sits in, by directory name. */
export function generationIdOfSource(home: string, source: string): string | null {
  // The manifest records canonical paths while FORGE_HOME may be reached through a symlink
  // (macOS /var -> /private/var); a pruned generation's source no longer resolves, so try both forms.
  const dir = seedGenerationsDirIn(home);
  for (const d of new Set([dir, provenPhysical(dir) ?? dir])) {
    for (const s of new Set([source, provenPhysical(source) ?? source])) {
      const rel = relative(d, s);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep)[0] ?? null;
    }
  }
  return null;
}

export type HostEditBackup = { dir: string; files: string[] };

/** FG-776 host-edit backups that captured this role's seed before an upgrade overwrote it. */
export function roleBackups(home: string, role: string): HostEditBackup[] {
  const root = hostEditMigrationRootDir(home);
  if (!existsSync(root)) return [];
  const out: HostEditBackup[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const roleDir = join(root, e.name, "agents", role);
    if (!existsSync(roleDir)) continue;
    out.push({ dir: join(root, e.name), files: walk(roleDir).map((f) => relative(join(root, e.name), f)) });
  }
  return out.sort((a, b) => basename(b.dir).localeCompare(basename(a.dir)));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
