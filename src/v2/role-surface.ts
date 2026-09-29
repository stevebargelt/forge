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
import { loadAllConstraints, parseConstraintFile, projectConstraintsDir, resolveEffectiveConstraints } from "./constraints.js";
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
      /** FG-827: the source behind each section, in composition order. */
      files: InstructionFile[];
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
  const sections = segmentComposedPrompt(composed.prompt, { protocolLength });
  return {
    ok: true,
    context,
    prompt: composed.prompt,
    sha256: composedInstructionsHash(composed.prompt),
    sections,
    files: instructionFiles({
      role: opts.role,
      prompt: composed.prompt,
      sections,
      agentDir: roleAgentDir(opts.home, opts.role),
      constraintsDir: join(opts.home, "constraints"),
      protocolSource: composed.protocol?.source ?? null,
      workflowAdditions: step.workflow_additions,
      stepId: step.id,
      project: opts.project,
    }),
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

// ---- FG-827: the second pass's derivations. Each reads a file the host already carries
// and names it; none guesses from prose.

export type InstructionFileKind = "entry" | "protocol" | "constraint" | "workflow" | "addendum";
export type InstructionFile = {
  id: string;
  label: string;
  kind: InstructionFileKind;
  /** The file read, or null for a source that is not a file (the synthetic invoke step). */
  path: string | null;
  /** The EXACT bytes of this source's section as composeSystemPrompt emitted them —
   *  `prompt.slice(start, end)`, the joining `---` separator excluded. */
  markdown: string;
  start: number;
  end: number;
  bytes: number;
  /** The source as declared (the file on disk, or the step's workflow_additions) when it
   *  differs from its composed section; absent when the two are the same bytes. */
  raw?: string;
  /** How the composed section differs from `raw` (frontmatter stripped / wrapped / trimmed). */
  rawDiff?: string;
  /** Where to change it — a seed changes only through `forge upgrade`. */
  edit: string;
};

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function rawDiff(raw: string, composed: string): string {
  const fm = raw.match(FRONTMATTER);
  const body = fm ? raw.slice(fm[0].length) : raw;
  const reasons: string[] = [];
  if (fm) reasons.push("frontmatter stripped");
  if (!composed.startsWith(body.trim())) reasons.push("wrapped");
  if (body !== body.trim() || composed !== composed.trimEnd()) reasons.push("trimmed");
  return reasons.join(" / ") || "differs";
}

/** A constraint id → the file that declared it, host layer first (host wins on id, as
 *  resolveEffectiveConstraints does). */
function constraintFilesById(dirs: Array<{ dir: string; layer: "host" | "project" }>): Map<string, { path: string; layer: "host" | "project" }> {
  const out = new Map<string, { path: string; layer: "host" | "project" }>();
  for (const { dir, layer } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const path = join(dir, f);
      try {
        const id = parseConstraintFile(path).id;
        if (!out.has(id)) out.set(id, { path, layer });
      } catch {
        // compose throws on a malformed file before we get here; nothing to list.
      }
    }
  }
  return out;
}

/** Every source that composed the role's instructions, one per composed section in
 *  composition order: the generation's protocol, the seed CLAUDE.md (the entry), the
 *  project addendum, the workflow additions, then each constraint. Each carries its
 *  section's exact composed bytes, so no source is invented or dropped and the files
 *  plus the `---` separators and the framing account for every byte of the prompt. */
export function instructionFiles(opts: {
  role: string;
  prompt: string;
  sections: PromptSection[];
  agentDir: string;
  constraintsDir: string;
  protocolSource: string | null;
  workflowAdditions: string | undefined;
  stepId: string;
  project?: { key: string; dir: string };
}): InstructionFile[] {
  const byId = constraintFilesById([
    { dir: opts.constraintsDir, layer: "host" },
    ...(opts.project ? [{ dir: projectConstraintsDir(opts.project.dir), layer: "project" as const }] : []),
  ]);
  const read = (path: string | null) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);
  const files: InstructionFile[] = [];
  for (const section of opts.sections) {
    if (section.kind === "framing") continue;
    const start = opts.prompt.startsWith(SEP, section.start) ? section.start + SEP.length : section.start;
    const markdown = opts.prompt.slice(start, section.end);
    const at = (f: Pick<InstructionFile, "id" | "kind" | "label" | "path" | "edit">, raw: string | null): InstructionFile => ({
      ...f,
      markdown,
      start,
      end: section.end,
      bytes: Buffer.byteLength(markdown, "utf8"),
      ...(raw !== null && raw !== markdown ? { raw, rawDiff: rawDiff(raw, markdown) } : {}),
    });
    if (section.kind === "protocol") {
      files.push(at({
        id: "protocol", kind: "protocol", label: `agent-protocols/${opts.role}.md`, path: opts.protocolSource,
        edit: `Forge-owned: seeds/agent-protocols/${opts.role}.md in the forge release, published into the seed generation by forge upgrade`,
      }, read(opts.protocolSource)));
    } else if (section.kind === "base") {
      const entry = join(opts.agentDir, "CLAUDE.md");
      files.push(at({
        id: "entry", kind: "entry", label: "CLAUDE.md", path: entry,
        edit: `seeds/agents/${opts.role}/CLAUDE.md in the forge release, installed to ${entry} by forge upgrade`,
      }, read(entry)));
    } else if (section.kind === "addendum") {
      const addendum = opts.project ? join(opts.project.dir, ".forge", "agents", opts.role, "CLAUDE.md") : null;
      files.push(at({
        id: "addendum", kind: "addendum", label: `.forge/agents/${opts.role}/CLAUDE.md`, path: addendum,
        edit: `${addendum} — project ${opts.project?.key}'s own file, committed in the project (forge upgrade does not publish it)`,
      }, read(addendum)));
    } else if (section.kind === "workflow") {
      files.push(at({
        id: "workflow", kind: "workflow", label: `workflow additions (step: ${opts.stepId})`, path: null,
        edit: "the synthetic forge invoke step (src/v2/invoke-shape.ts); a workflow step's workflow_additions live in its workflow YAML, published by forge upgrade",
      }, opts.workflowAdditions ?? null));
    } else {
      const id = section.id ?? "";
      const hit = byId.get(id);
      files.push(at({
        id: `constraint:${id}`, kind: "constraint", label: hit ? basename(hit.path) : `${id}.md`, path: hit?.path ?? null,
        edit: !hit
          ? "the constraint file could not be located in the host or project constraint dirs"
          : hit.layer === "host"
            ? `seeds/constraints/${basename(hit.path)} in the forge release, installed to ${hit.path} by forge upgrade`
            : `${hit.path} — the project's constraint layer, committed in the project`,
      }, read(hit?.path ?? null)));
    }
  }
  return files;
}

/** A SKILL.md's YAML frontmatter (`name`, `description`), or nulls when it has none. */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return { name: null, description: null };
  let data: unknown;
  try {
    data = parseYaml(m[1]!);
  } catch {
    return { name: null, description: null };
  }
  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().replace(/\s+/g, " ") : null);
  return { name: str(rec.name), description: str(rec.description) };
}

/** `${VAR}` / `${VAR:-default}` against an env, then `~` — or null when a variable with
 *  no default is unset. The same template grammar a runtime's mount hosts use. */
export function resolveHostTemplate(template: string, env: NodeJS.ProcessEnv, home: string): string | null {
  let unresolved = false;
  const out = template.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    unresolved = true;
    return "";
  });
  if (unresolved) return null;
  return out === "~" ? home : out.startsWith("~/") ? join(home, out.slice(2)) : out;
}

export type ResultContractField = { name: string; source: string };
export type ResultContract = { declared: boolean; fields: ResultContractField[]; source: string | null };

/** The top-level keys of the first fenced block under an `## Output schema` / `## Output
 *  contract` heading — the result.json shape the seed or protocol declares, read from its
 *  schema block rather than from prose. Null when the text declares no such block. */
export function outputSchemaFields(markdown: string): string[] | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^#{2,3} Output (schema|contract)\b/i.test(l));
  if (at === -1) return null;
  let i = at + 1;
  while (i < lines.length && !lines[i]!.startsWith("```")) {
    if (/^#{1,3} /.test(lines[i]!)) return null;
    i += 1;
  }
  if (i >= lines.length) return null;
  const body: string[] = [];
  for (i += 1; i < lines.length && !lines[i]!.startsWith("```"); i += 1) body.push(lines[i]!);
  const keyed = body.map((l) => l.match(/^(\s*)"([A-Za-z_][A-Za-z0-9_]*)"\s*:/)).filter((m): m is RegExpMatchArray => m !== null);
  if (keyed.length === 0) return null;
  const top = Math.min(...keyed.map((m) => m[1]!.length));
  const names = keyed.filter((m) => m[1]!.length === top).map((m) => m[2]!);
  return [...new Set(names)];
}

/** What the role's result.json must carry: the composed output contract's `status`, then
 *  each field the protocol (tier 0) or else the seed's schema block declares. */
export function roleResultContract(files: Array<{ kind: string; path: string | null; markdown: string }>): ResultContract {
  for (const kind of ["protocol", "entry"]) {
    const f = files.find((x) => x.kind === kind);
    const names = f ? outputSchemaFields(f.markdown) : null;
    if (f && names) {
      const src = `${f.path ?? kind} § Output schema`;
      const fields: ResultContractField[] = names.map((name) => ({ name, source: src }));
      if (!names.includes("status")) fields.unshift({ name: "status", source: "the composed output contract (src/v2/compose.ts)" });
      return { declared: true, fields, source: src };
    }
  }
  return { declared: false, fields: [], source: null };
}

export type RoleConstraint = { id: string; file: string; level: "suggest" | "force"; heading: string | null; scope: string; active: boolean; note: string | null };

/** The constraints that apply to `role` — host union project, as dispatch resolves them —
 *  by file name, level and first heading. A toggled-off one is listed inactive with why. */
export function roleConstraints(opts: { role: string; hostDir: string; projectDir?: string }): RoleConstraint[] {
  const effective = resolveEffectiveConstraints({ hostDir: opts.hostDir, projectDir: opts.projectDir });
  const byId = constraintFilesById([
    { dir: opts.hostDir, layer: "host" },
    ...(opts.projectDir ? [{ dir: projectConstraintsDir(opts.projectDir), layer: "project" as const }] : []),
  ]);
  const skipped = new Map(effective.skipped.map((s) => [s.id, s.reason]));
  const all = [...effective.constraints, ...loadAllConstraints(opts.hostDir).filter((c) => skipped.has(c.id))];
  return all
    .filter((c) => c.roles.length === 0 || c.roles.includes(opts.role))
    .map((c) => {
      const path = byId.get(c.id)?.path ?? "";
      const heading = c.body.split("\n").find((l) => /^#\s/.test(l))?.replace(/^#\s+/, "").trim() ?? null;
      const scope = [
        c.roles.length === 0 ? "every role" : `roles: ${c.roles.join(", ")}`,
        ...(c.workflows.length > 0 ? [`workflows: ${c.workflows.join(", ")}`] : []),
        ...(c.phases && c.phases.length > 0 ? [`steps: ${c.phases.join(", ")}`] : []),
      ].join("; ");
      return { id: c.id, file: path, level: c.level, heading, scope, active: !skipped.has(c.id), note: skipped.get(c.id) ?? null };
    })
    .sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === "force" ? -1 : 1));
}

export type ToolchainEntry = { name: string; version: string | null; via: string };

/** The tools an agent image's Dockerfile installs: nodesource's Node major, `npm install
 *  -g` packages, `apt-get install` packages (runtime libraries and fonts omitted), Go from
 *  its tarball, and the scripts it COPYs onto /usr/local/bin. Versions are the file's own
 *  ARG/ENV values. */
export function dockerfileToolchain(dockerfile: string): ToolchainEntry[] {
  const text = dockerfile.replace(/\\\n/g, " ");
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/^(?:ARG|ENV)\s+([A-Z0-9_]+)=(\S+)/gm)) vars.set(m[1]!, m[2]!.replace(/^"|"$/g, ""));
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n: string) => vars.get(n) ?? `\${${n}}`);
  const out: ToolchainEntry[] = [];
  const seen = new Set<string>();
  const add = (e: ToolchainEntry) => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    out.push(e);
  };
  for (const m of text.matchAll(/setup_(\d+)\.x/g)) add({ name: "node", version: `${m[1]}.x`, via: "nodesource" });
  if (seen.has("node")) add({ name: "npm", version: null, via: "bundled with node" });
  for (const line of text.split("\n")) {
    for (const seg of line.split(/&&|;/)) {
      const apt = seg.match(/apt-get install\s+(.*)$/);
      if (apt) {
        for (const pkg of apt[1]!.split(/\s+/)) {
          if (!pkg || pkg.startsWith("-") || /^(lib|fonts-)/.test(pkg) || pkg === "ca-certificates" || pkg === "nodejs" || pkg === "xdg-utils") continue;
          add({ name: pkg, version: null, via: "apt" });
        }
      }
      const npm = seg.match(/npm install -g\s+(.*)$/);
      if (npm) {
        for (const spec of npm[1]!.split(/\s+/)) {
          if (!spec || spec.startsWith("-")) continue;
          const expanded = expand(spec);
          const at = expanded.lastIndexOf("@");
          const [name, version] = at > 0 ? [expanded.slice(0, at), expanded.slice(at + 1)] : [expanded, null];
          add({ name, version, via: "npm -g" });
        }
      }
    }
  }
  if (vars.has("GOLANG_VERSION") && /go\.dev\/dl\//.test(text)) add({ name: "go", version: vars.get("GOLANG_VERSION")!, via: "go.dev tarball" });
  if (/ln -sf "\$CHROME_PATH" \/usr\/local\/bin\/chromium/.test(text)) add({ name: "chromium", version: null, via: "playwright install" });
  for (const m of text.matchAll(/^COPY\s+\S+\s+(\/usr\/local\/bin\/(\S+))/gm)) add({ name: m[2]!, version: null, via: `COPY → ${m[1]}` });
  return out;
}

/** The activities a role can be dispatched with: its built-in default first, then every
 *  activity the model policy maps to a profile, then `default`. Legacy mode (no policy)
 *  has only the built-in default. */
export function roleActivities(defaultActivity: string, policyActivities: string[] | null): string[] {
  if (policyActivities === null) return [defaultActivity];
  return [...new Set([defaultActivity, ...policyActivities, "default"])];
}
