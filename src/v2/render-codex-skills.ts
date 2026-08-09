// FG-253 step 3 — the Codex repository-scoped surface, RENDERED from the
// provider-neutral operator-workflow definition.
//
// WHAT THIS IS. Codex discovers repository-scoped skills as
// `.agents/skills/<name>/SKILL.md`. This module turns each operator workflow
// into exactly one such file. It owns two things and nothing else: the PATHS
// Codex looks in, and the INVOCATION MECHANICS a Codex session needs (YAML
// frontmatter, an explicit by-name invocation line, natural-language activation
// phrases). Every behavioral claim in the rendered body comes from
// src/v2/operator-workflows.ts — a rule that is not there is not a rule Forge
// ships, and a rendering that states behavior the definition does not is the
// duplicated-prose defect this ticket exists to remove.
//
// HOW THAT IS ENFORCED. The body is built as a list of PARTS, each tagged with
// where its bytes came from (`definition`, the ownership `marker`, a section
// `structure` heading, a Codex `mechanics` sentence, a small fixed `token`
// label, or wordless `decor`). render-codex-skills.test.ts walks those parts and
// checks each tag against its source, so smuggling a behavioral sentence in
// requires tagging it — visibly — as something it is not.
//
// ACTIVATION IS NOT INSTALLATION. Writing this file proves only that a file was
// written. Repository-scoped skill discovery is a third-party, version-coupled
// surface an older build can ignore silently, so the rendered body says so and
// names the CLI fallback. Nothing here claims a skill is active.
//
// DEPRECATED CODEX CUSTOM PROMPTS ARE NOT USED. No path this module produces is
// under a Codex prompts directory; `CODEX_DEPRECATED_PROMPT_DIRS` exists so the
// installer, the drift detector and the tests can all assert that by name.
//
// SCOPE. Pure: no I/O, no clock, no argv. The installer
// (src/cli/commands/init.ts) owns bytes on disk.

import {
  OPERATOR_WORKFLOW_IDS,
  operatorWorkflow,
  renderAdapterMarker,
  type AdapterStamp,
  type OperatorWorkflowDefinition,
  type OperatorWorkflowId,
} from "./operator-workflows.js";

// ─────────────────────────────────────────────────────────────────────────────
// Paths and ownership
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-relative root Codex reads repository-scoped skills from. POSIX
 *  separators: these are repo-relative identities, not host paths. */
export const CODEX_SKILLS_ROOT = ".agents/skills";

export const CODEX_SKILL_FILENAME = "SKILL.md";

export type CodexSkillName = `forge-${OperatorWorkflowId}`;

export function codexSkillName(id: OperatorWorkflowId): CodexSkillName {
  return `forge-${id}`;
}

/** The directories under `.agents/skills/` Forge owns — and, by exclusion, the
 *  ones it must never touch. The installer and the drift detector both read
 *  THIS, so "is that directory mine?" has exactly one answer. Per-directory, not
 *  the parent: `.agents/skills/` itself belongs to the operator. */
export const FORGE_OWNED_CODEX_SKILL_DIRS: readonly CodexSkillName[] = OPERATOR_WORKFLOW_IDS.map(codexSkillName);

export function isForgeOwnedCodexSkillDir(dirName: string): boolean {
  return (FORGE_OWNED_CODEX_SKILL_DIRS as readonly string[]).includes(dirName);
}

export function codexSkillDirPath(id: OperatorWorkflowId): string {
  return `${CODEX_SKILLS_ROOT}/${codexSkillName(id)}`;
}

export function codexSkillTargetPath(id: OperatorWorkflowId): string {
  return `${codexSkillDirPath(id)}/${CODEX_SKILL_FILENAME}`;
}

/** Codex's deprecated custom-prompt locations. Forge renders NOTHING here. Named
 *  so the prohibition is checkable rather than a comment nobody re-reads. */
export const CODEX_DEPRECATED_PROMPT_DIRS: readonly string[] = [
  ".codex/prompts",
  "~/.codex/prompts",
  "$CODEX_HOME/prompts",
];

// ─────────────────────────────────────────────────────────────────────────────
// Invocation mechanics — the only Codex-specific additions
// ─────────────────────────────────────────────────────────────────────────────

/** The natural-language phrases a session actually uses to ask for each
 *  workflow. These live HERE, not in the provider-neutral core: they are a Codex
 *  discovery mechanic (the description field is matched against what the session
 *  said), not behavior. Claude reaches the same workflow through an explicit
 *  slash command and needs none of this. */
export const CODEX_ACTIVATION_PHRASES: Record<OperatorWorkflowId, readonly string[]> = {
  orient: ["orient me", "orient", "where are we", "start-of-session state", "catch me up"],
  handoff: ["hand off", "handoff", "wrap up", "wrap up the session", "end of session", "close out"],
};

function quotedPhrases(id: OperatorWorkflowId): string {
  return CODEX_ACTIVATION_PHRASES[id].map((p) => `"${p}"`).join(", ");
}

/** The invocation sentences the rendered body carries, in order. Exported so the
 *  renderer has exactly one source for them and the test can assert their
 *  PROPERTIES — that they name the skill, carry the activation phrases, refuse to
 *  claim activation, and introduce no command of their own. */
export function codexInvocationMechanics(id: OperatorWorkflowId): readonly string[] {
  const skill = codexSkillName(id);
  return [
    `Invoke this skill explicitly by name: ${skill}.`,
    `It also activates from natural language — a session saying ${quotedPhrases(id)} — but naming ${skill} is the ` +
      `reliable path, because prose matching is not a contract.`,
    `That this file exists is not evidence the running Codex build loaded it: repository-scoped skill discovery is ` +
      `version-coupled and an older build ignores it silently. Activation is therefore unverified. If ${skill} does ` +
      `not activate, follow the steps below by hand — the forge CLI is the interface either way.`,
  ];
}

/** One-line frontmatter description, written for natural-language activation. */
export function codexSkillDescription(id: OperatorWorkflowId): string {
  const def = operatorWorkflow(id);
  const skill = codexSkillName(id);
  return (
    `${def.title} for a forge orchestrator, driven entirely by the forge CLI. ` +
    `Use when the session says ${quotedPhrases(id)} — or invoke it explicitly by name as ${skill}.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance-tagged rendering
// ─────────────────────────────────────────────────────────────────────────────

export type CodexRenderPartKind =
  /** verbatim text from the provider-neutral definition. */
  | "definition"
  /** the Forge ownership marker carrying the release stamp. */
  | "marker"
  /** a section heading — a label, never a claim. */
  | "structure"
  /** a Codex invocation/activation sentence from codexInvocationMechanics(). */
  | "mechanics"
  /** a fixed label introducing definition data. Deliberately a tiny closed set. */
  | "token"
  /** punctuation, list markers, fences, newlines. Contains no words at all. */
  | "decor";

export type CodexRenderPart = { kind: CodexRenderPartKind; text: string };

/** Section headings the body uses, in order. */
export function codexStructureTokens(skillName: string): readonly string[] {
  return [
    `# ${skillName}`,
    "## Purpose",
    "## Bounded interface",
    "## Probes",
    "## Report",
    "## Rules",
    "## Do not",
    "## Notes block",
  ];
}

/** Fixed labels that introduce definition data. Every one of these restates
 *  something the definition already carries structurally (a flag, an ordering, a
 *  field name) — none of them adds a rule. Kept small on purpose: this set is the
 *  entire budget for renderer wording, and the test caps it. */
export const CODEX_RENDER_TOKENS = {
  forbidden: "Never read or edit these paths with a file tool:",
  drillIn: "Drill into one ticket with:",
  why: "Why:",
  tolerateEmpty: "may legitimately produce nothing — absence is not a finding",
  omitWhenEmpty: "omit this section entirely when empty",
  apply: "Apply the drafted block with:",
  header: "The block opens with:",
  sections: "Sections, in order:",
} as const;

const CODEX_RENDER_TOKEN_VALUES: readonly string[] = Object.values(CODEX_RENDER_TOKENS);

export function isCodexRenderToken(text: string): boolean {
  return CODEX_RENDER_TOKEN_VALUES.includes(text);
}

/** Decor carries no words — asserted by the test, and true by construction here.
 *  Anything with a letter in it has to be tagged with a real provenance. */
export const CODEX_DECOR_PATTERN = /^[\s`*_\-—:.,()<>|#0-9]*$/u;

const part = (kind: CodexRenderPartKind, text: string): CodexRenderPart => ({ kind, text });
const D = (text: string) => part("decor", text);
const DEF = (text: string) => part("definition", text);
const TOK = (text: string) => part("token", text);
const NL = D("\n");
const GAP = D("\n\n");

function heading(text: string): CodexRenderPart[] {
  return [part("structure", text), GAP];
}

/** The rendered body as provenance-tagged parts. `renderCodexSkill` is just this
 *  joined; the test walks the tags. */
export function codexSkillBodyParts(id: OperatorWorkflowId, stamp: AdapterStamp): readonly CodexRenderPart[] {
  const def: OperatorWorkflowDefinition = operatorWorkflow(id);
  const skill = codexSkillName(id);
  const p: CodexRenderPart[] = [];

  p.push(part("marker", renderAdapterMarker(stamp)), GAP);
  p.push(...heading(`# ${skill}`));

  for (const sentence of codexInvocationMechanics(id)) {
    p.push(part("mechanics", sentence), GAP);
  }

  p.push(...heading("## Purpose"));
  p.push(DEF(def.purpose), GAP);

  p.push(...heading("## Bounded interface"));
  p.push(DEF(def.boundedCli.statement), GAP);
  p.push(TOK(CODEX_RENDER_TOKENS.forbidden), GAP);
  for (const path of def.boundedCli.forbiddenDirectAccess) {
    p.push(D("- `"), DEF(path), D("`\n"));
  }
  p.push(NL);
  p.push(TOK(CODEX_RENDER_TOKENS.drillIn), D(" `"), DEF(def.boundedCli.drillIn), D("`"), GAP);
  p.push(TOK(CODEX_RENDER_TOKENS.why), D(" "), DEF(def.boundedCli.rationale), GAP);

  p.push(...heading("## Probes"));
  for (const probe of def.probes) {
    p.push(D("- `"), DEF(probe.command), D("` — "), DEF(probe.purpose));
    if (probe.tolerateEmpty) p.push(D(" ("), TOK(CODEX_RENDER_TOKENS.tolerateEmpty), D(")"));
    p.push(NL);
  }
  p.push(NL);

  p.push(...heading("## Report"));
  def.report.forEach((section, i) => {
    p.push(D(`${i + 1}. **`), DEF(section.label), D("** — "), DEF(section.content));
    if (section.omitWhenEmpty) p.push(D(" ("), TOK(CODEX_RENDER_TOKENS.omitWhenEmpty), D(")"));
    p.push(NL);
  });
  p.push(NL);

  p.push(...heading("## Rules"));
  for (const rule of def.rules) {
    p.push(D("- "), DEF(rule.statement), NL);
    if (rule.rationale) p.push(D("  "), TOK(CODEX_RENDER_TOKENS.why), D(" "), DEF(rule.rationale), NL);
  }
  p.push(NL);

  p.push(...heading("## Do not"));
  for (const prohibition of def.prohibitions) {
    p.push(D("- "), DEF(prohibition.statement), NL);
    if (prohibition.rationale) p.push(D("  "), TOK(CODEX_RENDER_TOKENS.why), D(" "), DEF(prohibition.rationale), NL);
  }

  const notes = def.notesBlock;
  if (notes) {
    p.push(NL);
    p.push(...heading("## Notes block"));
    p.push(TOK(CODEX_RENDER_TOKENS.apply), GAP);
    p.push(D("```\n"), DEF(notes.heredocForm), D("\n```"), GAP);
    p.push(TOK(CODEX_RENDER_TOKENS.header), GAP);
    p.push(DEF(notes.headerLine), GAP);
    p.push(TOK(CODEX_RENDER_TOKENS.sections), GAP);
    for (const section of notes.sections) {
      p.push(D("- "), DEF(section.heading), D(" "), DEF(section.content));
      if (section.omitWhenEmpty) p.push(D(" ("), TOK(CODEX_RENDER_TOKENS.omitWhenEmpty), D(")"));
      p.push(NL);
    }
  }

  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter + file
// ─────────────────────────────────────────────────────────────────────────────

/** Single-quoted YAML: the only escape is `''`, so a description carrying
 *  backticks, `$`, `#`, `:` or double quotes cannot change the document's shape. */
function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function codexSkillFrontmatter(id: OperatorWorkflowId): string {
  const description = codexSkillDescription(id);
  if (/[\r\n]/.test(description)) {
    throw new Error(`forge: codex skill description for '${id}' spans lines; it must be a single-line scalar`);
  }
  return ["---", `name: ${codexSkillName(id)}`, `description: ${yamlSingleQuoted(description)}`, "---"].join("\n");
}

export function renderCodexSkill(id: OperatorWorkflowId, stamp: AdapterStamp): string {
  const body = codexSkillBodyParts(id, stamp)
    .map((p) => p.text)
    .join("");
  return `${codexSkillFrontmatter(id)}\n\n${body}`;
}

export type RenderedCodexSkill = {
  workflow: OperatorWorkflowId;
  skillName: CodexSkillName;
  /** Repo-relative target path, POSIX separators. */
  path: string;
  contents: string;
};

/** Every Codex skill Forge renders for `stamp`, in workflow-declaration order. */
export function renderCodexSkills(stamp: AdapterStamp): readonly RenderedCodexSkill[] {
  return OPERATOR_WORKFLOW_IDS.map((id) => ({
    workflow: id,
    skillName: codexSkillName(id),
    path: codexSkillTargetPath(id),
    contents: renderCodexSkill(id, stamp),
  }));
}
