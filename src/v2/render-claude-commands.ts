// FG-253 step 2 — the Claude Code surface, RENDERED from the provider-neutral
// operator-workflow definition.
//
// THE DEFECT THIS CLOSES. `/orient` and `/handoff` were hand-authored Claude prose
// (scripts/claude-commands/*.md) SYMLINKED into a project's .claude/commands/. Two
// problems, both fatal to this ticket: the prose was the only carrier of the
// semantics (so a second provider could only copy it), and a symlink cannot carry
// a release stamp — an absolute link is dead in every other clone, and a link's
// bytes are somebody else's, so forge could never tell whether the project's
// command matched the release the session is running.
//
// THE FIX. This module produces BYTES. Every behavioral line comes from
// operator-workflows.ts; the only thing added here is Claude-specific invocation
// mechanics (slash-command framing) and structural chrome. That constraint is
// enforced structurally, not by review: the renderer can only emit
//   - a `marker` segment (the ownership marker + stamp),
//   - a `definition` segment, which must declare the exact definition strings it is
//     built from, or
//   - a `mechanics` segment, which must name an id declared by claudeMechanics(),
// and the rendered bytes are exactly the segments joined — so nothing in the file
// is unaccounted for. render-claude-commands.test.ts asserts the residue of every
// definition segment (its text minus its declared parts and labels) contains no
// word at all, which is what makes "carries no behavioral claim absent from the
// definition" a checkable property rather than a promise.
//
// SCOPE. Pure functions over the definition + a caller-supplied stamp. No I/O, no
// clock, no provider knowledge beyond the two things Claude Code needs: where the
// file goes and how it is invoked. The installer (src/cli/commands/init.ts, step 4)
// owns bytes on disk; this module never writes.
//
// NO FRONTMATTER, deliberately. A Claude Code custom command works as plain
// markdown, and the ownership marker must be the FIRST region of the file so
// ownership is decidable from the head of the bytes. YAML frontmatter is only
// frontmatter when it is first, so the two requirements are exclusive and the
// marker wins — nothing forge needs to say here needs frontmatter to say it.

import {
  OPERATOR_WORKFLOW_IDS,
  operatorWorkflow,
  renderAdapterMarker,
  type AdapterStamp,
  type OperatorWorkflowDefinition,
  type OperatorWorkflowId,
} from "./operator-workflows.js";

// ─────────────────────────────────────────────────────────────────────────────
// Where the rendered files go, and how they are invoked
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-relative, POSIX-separated. Repo-relative because the installer resolves it
 *  against a project dir it was handed, and POSIX because this string is also an
 *  identity — it appears in drift reports, `--json` output and docs, where a
 *  backslash on one host and a slash on another would read as two different files. */
export const CLAUDE_COMMANDS_DIR = ".claude/commands";

export function claudeCommandPath(id: OperatorWorkflowId): string {
  return `${CLAUDE_COMMANDS_DIR}/${id}.md`;
}

/** In declaration order, so callers that print or diff the set are stable. */
export const CLAUDE_COMMAND_TARGETS: readonly string[] = OPERATOR_WORKFLOW_IDS.map(claudeCommandPath);

/** The invocation an operator actually types. The file name and the slash command
 *  are the same identity in Claude Code; deriving both from the workflow id is what
 *  keeps them from drifting apart. */
export function claudeSlashCommand(id: OperatorWorkflowId): string {
  return `/${id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — the mechanism that keeps behavior out of the rendering
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeRenderSegment =
  /** The ownership marker + release stamp. Always first. */
  | { origin: "marker"; text: string }
  /** Text built from the definition. `parts` are the definition strings it is
   *  composed of, verbatim; `labels` are declared chrome words allowed to appear
   *  between them. Anything else in `text` is a smuggled claim, and the test says so. */
  | { origin: "definition"; text: string; parts: readonly string[]; labels: readonly ClaudeRenderLabel[] }
  /** Claude-specific invocation mechanics or structural chrome, by declared id. */
  | { origin: "mechanics"; id: string; text: string };

/** The complete set of chrome words this rendering may place around definition
 *  text. Typed, so adding one is a deliberate edit here rather than an
 *  accidentally-plausible sentence inside a template literal. */
export const CLAUDE_RENDER_LABELS = [
  "Off limits to direct file reads and edits:",
  "Drill in with:",
  "Why it matters:",
  "(may be empty)",
  "(omit when empty)",
  "Apply form:",
  "Block shape:",
] as const;

export type ClaudeRenderLabel = (typeof CLAUDE_RENDER_LABELS)[number];

/** The invocation mechanics and section chrome, per workflow. Exported so the test
 *  can assert this set carries no behavior — and so the renderer resolves every
 *  mechanics string THROUGH it, making an undeclared one a thrown error rather than
 *  a line that quietly ships. */
export function claudeMechanics(def: OperatorWorkflowDefinition): readonly { id: string; text: string }[] {
  const entries: { id: string; text: string }[] = [
    { id: "heading", text: `# ${claudeSlashCommand(def.id)}` },
    {
      id: "invocation",
      text:
        `Installed by forge as a Claude Code slash command. Type \`${claudeSlashCommand(def.id)}\` ` +
        `in a session to run it.`,
    },
    { id: "section:interface", text: "## Bounded interface" },
    { id: "section:probes", text: "## Probes" },
    { id: "section:report", text: "## Report" },
    { id: "section:rules", text: "## Rules" },
    { id: "section:prohibitions", text: "## Prohibitions" },
    { id: "section:maintained-prose", text: "## Maintained prose" },
  ];
  // Orientation is a read; only a workflow with a durable write renders an apply
  // section, so this chrome exists exactly where the definition has content for it.
  if (def.notesBlock) entries.push({ id: "section:apply", text: "## Applying the block" });
  return entries;
}

function mechanics(def: OperatorWorkflowDefinition, id: string): ClaudeRenderSegment {
  const found = claudeMechanics(def).find((m) => m.id === id);
  if (!found) {
    throw new Error(`forge: render-claude-commands has no declared mechanics '${id}' for workflow '${def.id}'`);
  }
  return { origin: "mechanics", id: found.id, text: found.text };
}

function fromDefinition(
  text: string,
  parts: readonly string[],
  labels: readonly ClaudeRenderLabel[] = [],
): ClaudeRenderSegment {
  return { origin: "definition", text, parts, labels };
}

// ─────────────────────────────────────────────────────────────────────────────
// The rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Segments in file order. Exported so the renderer's provenance is testable —
 *  `renderClaudeCommand` is just these joined. */
export function claudeCommandSegments(id: OperatorWorkflowId, stamp: AdapterStamp): readonly ClaudeRenderSegment[] {
  const def = operatorWorkflow(id);
  const segments: ClaudeRenderSegment[] = [];

  // 1. Ownership marker FIRST — this is what makes the installed file's ownership
  //    and release decidable from its own bytes.
  segments.push({ origin: "marker", text: renderAdapterMarker(stamp) });

  // 2. Claude framing + what this workflow is.
  segments.push(mechanics(def, "heading"));
  segments.push(mechanics(def, "invocation"));
  segments.push(fromDefinition(`**${def.title}**`, [def.title]));
  segments.push(fromDefinition(def.purpose, [def.purpose]));

  // 3. The bounded-CLI rule, stated before anything that could tempt a file read.
  segments.push(mechanics(def, "section:interface"));
  segments.push(fromDefinition(def.boundedCli.statement, [def.boundedCli.statement]));
  segments.push(
    fromDefinition(
      ["Off limits to direct file reads and edits:", ...def.boundedCli.forbiddenDirectAccess.map((p) => `- \`${p}\``)].join(
        "\n",
      ),
      def.boundedCli.forbiddenDirectAccess,
      ["Off limits to direct file reads and edits:"],
    ),
  );
  segments.push(
    fromDefinition(`Drill in with: \`${def.boundedCli.drillIn}\``, [def.boundedCli.drillIn], ["Drill in with:"]),
  );
  segments.push(
    fromDefinition(`Why it matters: ${def.boundedCli.rationale}`, [def.boundedCli.rationale], ["Why it matters:"]),
  );

  // 4. Probes, verbatim. A probe rewritten per provider is a probe whose results
  //    differ per provider, so the command line is copied and never reformatted.
  segments.push(mechanics(def, "section:probes"));
  segments.push(
    fromDefinition(
      def.probes.map((p) => `- \`${p.command}\` — ${p.purpose}${p.tolerateEmpty ? " (may be empty)" : ""}`).join("\n"),
      def.probes.flatMap((p) => [p.command, p.purpose]),
      def.probes.some((p) => p.tolerateEmpty) ? ["(may be empty)"] : [],
    ),
  );

  // 5. Report sections, in definition order — the order IS the contract, so the
  //    rendering preserves it rather than restating it in prose.
  segments.push(mechanics(def, "section:report"));
  segments.push(
    fromDefinition(
      def.report.map((s) => `- **${s.label}:** ${s.content}${s.omitWhenEmpty ? " (omit when empty)" : ""}`).join("\n"),
      def.report.flatMap((s) => [s.label, s.content]),
      def.report.some((s) => s.omitWhenEmpty) ? ["(omit when empty)"] : [],
    ),
  );

  // 6. Rules and prohibitions, each with the reason it exists — a rule whose
  //    rationale is invisible is a rule the next session talks itself out of.
  segments.push(mechanics(def, "section:rules"));
  segments.push(
    fromDefinition(
      def.rules
        .map((r) => `- ${r.statement}${r.rationale ? `\n  Why it matters: ${r.rationale}` : ""}`)
        .join("\n"),
      def.rules.flatMap((r) => (r.rationale ? [r.statement, r.rationale] : [r.statement])),
      def.rules.some((r) => r.rationale) ? ["Why it matters:"] : [],
    ),
  );
  segments.push(mechanics(def, "section:prohibitions"));
  segments.push(
    fromDefinition(
      def.prohibitions
        .map((p) => `- ${p.statement}${p.rationale ? `\n  Why it matters: ${p.rationale}` : ""}`)
        .join("\n"),
      def.prohibitions.flatMap((p) => (p.rationale ? [p.statement, p.rationale] : [p.statement])),
      def.prohibitions.some((p) => p.rationale) ? ["Why it matters:"] : [],
    ),
  );

  // 7. The durable write, when the workflow has one. Fenced verbatim: the whole
  //    point of the quoted heredoc is that the block lands unexpanded, and a
  //    reflowed apply form would defeat it.
  const notes = def.notesBlock;
  if (notes) {
    segments.push(mechanics(def, "section:apply"));
    // Two fenced blocks that mean different things — the pipe, and what goes down
    // it. Labelled, because an unlabelled pair reads as one thing shown twice.
    segments.push(fromDefinition(`Apply form:\n\n${fence(notes.heredocForm)}`, [notes.heredocForm], ["Apply form:"]));
    const shape = [
      notes.headerLine,
      ...notes.sections.map((s) => `${s.heading} ${s.content}${s.omitWhenEmpty ? " (omit when empty)" : ""}`),
    ].join("\n\n");
    segments.push(
      fromDefinition(
        `Block shape:\n\n${fence(shape)}`,
        [notes.headerLine, ...notes.sections.flatMap((s) => [s.heading, s.content])],
        notes.sections.some((s) => s.omitWhenEmpty) ? ["(omit when empty)", "Block shape:"] : ["Block shape:"],
      ),
    );
  }

  // 8. Where the durable, maintainer-owned prose lives. The link comes from the
  //    definition, not from this renderer, so the Codex rendering points at the
  //    same document — a path hardcoded per renderer is the duplicated-claim
  //    defect this ticket removes, one level down.
  segments.push(mechanics(def, "section:maintained-prose"));
  segments.push(fromDefinition(def.maintainedProse.statement, [def.maintainedProse.statement]));

  return segments;
}

function fence(body: string): string {
  return `\`\`\`\n${body}\n\`\`\``;
}

/** The bytes to install at `claudeCommandPath(id)`. Deterministic: a pure function
 *  of the definition and the stamp, so two renders of the same release are
 *  byte-identical and a drift check means what it says. */
export function renderClaudeCommand(id: OperatorWorkflowId, stamp: AdapterStamp): string {
  return `${claudeCommandSegments(id, stamp)
    .map((s) => s.text)
    .join("\n\n")}\n`;
}

export type RenderedClaudeCommand = {
  workflow: OperatorWorkflowId;
  /** The invocation an operator types, e.g. `/orient`. */
  slashCommand: string;
  /** Repo-relative, POSIX-separated target path. */
  path: string;
  bytes: string;
};

/** The whole Claude surface for one release. The installer, the drift detector and
 *  the launch-boundary stamp check all read this — one producer, so they cannot
 *  disagree about what "installed and current" means. */
export function renderClaudeCommands(stamp: AdapterStamp): readonly RenderedClaudeCommand[] {
  return OPERATOR_WORKFLOW_IDS.map((id) => ({
    workflow: id,
    slashCommand: claudeSlashCommand(id),
    path: claudeCommandPath(id),
    bytes: renderClaudeCommand(id, stamp),
  }));
}
