// FG-253 — the provider-neutral operator-workflow core, as DATA.
//
// THE DEFECT THIS CLOSES. The orientation and handoff semantics an orchestrator
// session runs — the bounded-CLI rule, the probe set, the report order, the
// stale-ticket reconciliation, the heredoc apply discipline, the prohibitions —
// existed in exactly one place: hand-authored Claude prose at
// scripts/claude-commands/{orient,handoff}.md. A second provider surface could
// only be built by copying that prose, and two copies of a behavior specification
// drift the first time one is edited. Worse, a Codex dogfood found NO installed
// orientation workflow at all, because the only carrier of these semantics was a
// Claude-shaped file.
//
// THE FIX. The semantics live here, once, as structured data. Every provider
// surface is RENDERED from this module and may add only invocation mechanics —
// slash-command framing, skill frontmatter — never behavior. A rule that is not
// in this file is not a rule Forge ships; a rendering that carries a behavioral
// claim absent from here is the bug this ticket exists to prevent.
//
// SCOPE. This module is DATA + pure functions. No I/O, no argv, no filesystem, no
// clock, no provider paths. Renderers (src/v2/render-claude-commands.ts,
// src/v2/render-codex-skills.ts) own paths and mechanics; the installer
// (src/cli/commands/init.ts) owns bytes on disk.

import type { OrchestratorAdapterId } from "./orchestrator-capabilities.js";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow identity
// ─────────────────────────────────────────────────────────────────────────────

export type OperatorWorkflowId = "orient" | "handoff";

export const OPERATOR_WORKFLOW_IDS = ["orient", "handoff"] as const satisfies readonly OperatorWorkflowId[];

/** The kinds of behavioral rule a workflow can carry. A closed union so a rule
 *  added without a kind fails to compile, and so the coverage contract below can
 *  state — structurally, not in prose — which kinds each workflow must name. */
export type OperatorRuleKind =
  /** what the session may read/write, and through which interface. */
  | "bounded-cli"
  /** how the probe set is executed (batch shape, tolerance of absent commands). */
  | "probe-execution"
  /** the ordering/compactness of the operator-facing output. */
  | "report-shape"
  /** reconciling a stated claim against live state before reporting it. */
  | "reconciliation"
  /** surfacing a signal that is present only sometimes. */
  | "surfacing"
  /** how a durable write is applied. */
  | "apply-discipline"
  /** how the workflow ends and who steers next. */
  | "closing";

export type ProbeCommand = {
  /** Stable id — renderers and tests iterate these; never reuse one for a
   *  different command. */
  id: string;
  /** The exact command line, verbatim. Renderers copy it; they never rewrite it,
   *  because a probe that differs per provider is a probe whose results differ
   *  per provider. */
  command: string;
  /** Why the session runs it — what the output is FOR. */
  purpose: string;
  /** True when the command may legitimately produce nothing (older install, no
   *  remote, project forge does not know about). A tolerated probe's silence is
   *  never reported as a finding. */
  tolerateEmpty?: boolean;
};

export type ReportSection = {
  id: string;
  /** The operator-facing label, in the order declared. */
  label: string;
  /** What belongs under it. */
  content: string;
  /** Omit the whole section rather than emit "nothing to report". */
  omitWhenEmpty?: boolean;
};

export type WorkflowRule = {
  id: string;
  kind: OperatorRuleKind;
  /** The rule itself, as an imperative the rendered adapter states directly. */
  statement: string;
  /** Why it exists. Rendered too — a rule whose reason is invisible is a rule the
   *  next session talks itself out of. */
  rationale?: string;
};

export type Prohibition = {
  id: string;
  /** What the session must NOT do. */
  statement: string;
  rationale?: string;
};

export type NotesBlockSection = {
  id: string;
  /** The literal heading line the drafted block carries. */
  heading: string;
  content: string;
  omitWhenEmpty?: boolean;
};

/** The durable-write shape a workflow applies, when it applies one. Present on
 *  handoff, absent on orient — orientation is a read; it writes nothing. */
export type NotesBlockContract = {
  /** The command the drafted block is piped INTO. */
  applyCommand: string;
  /** The quoted heredoc delimiter that makes the pipe verbatim. */
  heredocDelimiter: string;
  /** The full apply form, so a renderer never has to assemble shell itself. */
  heredocForm: string;
  /** Leading line of the block (the dated header), before the sections. */
  headerLine: string;
  sections: readonly NotesBlockSection[];
};

/** The maintainer-owned document a rendered adapter points at.
 *
 *  FG-347's defect was prose with no owner: volatile repo-specific orientation
 *  text sat in `CLAUDE.md`, which the documentation-maintainer declines (the
 *  rendered block) and which `upgrade` only ever re-renders between the markers.
 *  The relocation arm moves that prose to a document the maintainer already owns
 *  and routes to. The LINK to it belongs here, in the step-1 definition, so both
 *  renderers derive it from one place — a path hardcoded in two renderers is the
 *  same duplicated-claim defect one level down. */
export type MaintainedProseLink = {
  /** Repo-relative, POSIX. Also an identity: it appears in rendered adapters. */
  path: string;
  /** Who corrects it. Not decorative — this is the answer to "who fixes this?". */
  owner: RegionOwner;
  /** The sentence every rendered adapter carries, verbatim. */
  statement: string;
};

export const MAINTAINED_PROSE: MaintainedProseLink = {
  path: "docs/repo-guide.md",
  owner: "documentation-maintainer",
  statement:
    "Repo-specific prose — what this codebase is, its layout, its conventions, its auth modes — is maintained at " +
    "`docs/repo-guide.md` by the documentation-maintainer, and a correction to it belongs there. This adapter file " +
    "is generated; describing the repo here, or in CLAUDE.md, puts that description where the maintainer does not " +
    "route, which is how it drifts.",
};

export type OperatorWorkflowDefinition = {
  id: OperatorWorkflowId;
  /** Operator-facing title. */
  title: string;
  /** One paragraph: what this workflow is and what it is not. */
  purpose: string;
  /** Where the durable, maintainer-owned prose lives. Same link on every
   *  workflow: it is a property of the repo, not of orientation vs handoff. */
  maintainedProse: MaintainedProseLink;
  /** The bounded-interface rule. Stated as structure, not prose, so a renderer
   *  cannot soften it and a test can assert the forbidden reads by name. */
  boundedCli: {
    statement: string;
    /** Paths that must never be read or edited directly. */
    forbiddenDirectAccess: readonly string[];
    /** The only sanctioned way to fetch one ticket's body. */
    drillIn: string;
    rationale: string;
  };
  /** Run as ONE parallel batch — see the probe-execution rule. */
  probes: readonly ProbeCommand[];
  /** The operator-facing output, in the order it is rendered. */
  report: readonly ReportSection[];
  rules: readonly WorkflowRule[];
  prohibitions: readonly Prohibition[];
  notesBlock?: NotesBlockContract;
};

// ─────────────────────────────────────────────────────────────────────────────
// /orient — start-of-session orientation
// ─────────────────────────────────────────────────────────────────────────────

const ORIENT: OperatorWorkflowDefinition = {
  id: "orient",
  title: "Start-of-session orientation",
  purpose:
    "Start-of-session orientation for a forge orchestrator. Execute the start-of-session protocol and report a " +
    "compact state-of-play. Orientation is a pre-condition for work, not work itself: it reads, reconciles, " +
    "reports, and stops.",
  maintainedProse: MAINTAINED_PROSE,
  boundedCli: {
    statement:
      "Use the `forge backlog` CLI for all backlog reads. Never open the backlog file directly with a file-read " +
      "or file-edit tool.",
    forbiddenDirectAccess: ["BACKLOG.md", "backlog/notes.md"],
    drillIn: "forge backlog show <id>",
    rationale:
      "The backlog file is thousands of lines and grows; the CLI is the bounded interface that returns the same " +
      "data at a fraction of the context, and in a DB-store project it is the ONLY interface that returns truth.",
  },
  probes: [
    {
      id: "backlog-notes-show",
      command: "forge backlog notes show",
      purpose: "the narrative handoff written by the prior session",
    },
    {
      id: "backlog-list-active",
      command: "forge backlog list --status active",
      purpose: "currently-open tickets, titles only",
    },
    {
      id: "backlog-list-done",
      command: "forge backlog list --status done 2>&1 | head -30",
      purpose: "recently closed tickets, for reconciling against the notes' priorities",
    },
    {
      id: "git-status",
      command: "git status",
      purpose: "working-tree state",
    },
    {
      id: "git-log-unpushed",
      command: "git log --oneline origin/main..HEAD 2>/dev/null",
      purpose: "commits ahead of origin",
      tolerateEmpty: true,
    },
    {
      id: "forge-projects-show",
      command: 'forge projects show "$(basename "$PWD")" 2>/dev/null',
      purpose: "this project's run history and live sessions",
      tolerateEmpty: true,
    },
    {
      id: "forge-ops-check",
      command: "forge ops check --json 2>/dev/null",
      purpose: "read-only operational incidents scoped to this project",
      tolerateEmpty: true,
    },
  ],
  report: [
    { id: "project", label: "Project", content: "name + path" },
    {
      id: "picking-up",
      label: "Picking up",
      content: 'the "Picked up next" line from the notes block, plus the most recent commit subject',
    },
    { id: "state", label: "State", content: "current branch · N commits ahead of origin · dirty/clean" },
    { id: "active-tickets", label: "Active tickets", content: "total count + the top 3 by sticky number" },
    {
      id: "needs-attention",
      label: "Needs attention",
      content:
        "unpushed commits older than a day, in-flight forge runs that are not this session, stale notes (a notes " +
        "block with no \"Picked up next\" section), stale ticket refs, and ops incidents",
      omitWhenEmpty: true,
    },
  ],
  rules: [
    {
      id: "bounded-cli-only",
      kind: "bounded-cli",
      statement:
        "Every backlog read goes through `forge backlog`; `forge backlog show <id>` is the only way to fetch a " +
        "specific ticket body.",
      rationale: "The CLI is the bounded interface; the file is unbounded and, after a DB cutover, stale.",
    },
    {
      id: "parallel-probe-batch",
      kind: "probe-execution",
      statement:
        "Run the probe set as ONE parallel batch, not sequentially, and treat a tolerated probe's empty output as " +
        "absence of signal rather than a finding.",
      rationale:
        "The probes are independent reads; serializing them spends session latency for nothing, and an older " +
        "install legitimately has no `forge ops check`.",
    },
    {
      id: "report-ordering",
      kind: "report-shape",
      statement:
        "Synthesize and report in the declared section order, compact — no headers padded with whitespace, no " +
        "restatement of the raw probe output.",
      rationale: "The report is the deliverable; a transcript of commands is not orientation.",
    },
    {
      id: "stale-ticket-reconciliation",
      kind: "reconciliation",
      statement:
        'Before reporting, extract every `#<number>` reference from the notes\' "Picked up next" section and check ' +
        "each against the active list. A ref that is absent from the active list — closed, merged, or gone — is " +
        'STALE: surface it under "Needs attention" as "notes list #N as a next step, but it is no longer active ' +
        '(closed/merged) — likely already shipped; the live next move is elsewhere", citing the closing commit sha ' +
        "when it is visible in the git log output.",
      rationale:
        "The notes' priority list is a claim from the prior session, not live state; treating it as live is how a " +
        "session spends itself re-doing shipped work.",
    },
    {
      id: "ops-incident-surfacing",
      kind: "surfacing",
      statement:
        'When the ops probe returns a non-empty array, surface it under "Needs attention" as "Ops attention: N ' +
        'incident(s) — <kind>, e.g. retry_orphan (run-x / task-y)", highest severity first, naming the kind plus ' +
        "run/task ids. Omit the line entirely when the array is empty. These are read-only signals scoped to this " +
        "project: orientation reports them, it does not act on them.",
      rationale:
        "An incident the operator never sees is an incident nobody owns; an incident orientation ACTS on is work " +
        "the operator did not authorize.",
    },
    {
      id: "end-with-one-question",
      kind: "closing",
      statement: 'End with exactly one question — "What do we forge next?" — and let the operator steer.',
      rationale: "Orientation establishes state; choosing the next move is the operator's decision, not the session's.",
    },
  ],
  prohibitions: [
    {
      id: "no-whole-backlog-read",
      statement: "Do not read the backlog file whole — use the CLI.",
    },
    {
      id: "no-role-restatement",
      statement: 'Do not re-state "you are a forge orchestrator".',
      rationale: "Performing the protocol is stronger than declaring the role.",
    },
    {
      id: "no-context-preload",
      statement:
        "Do not pre-load context the operator did not ask for — no `git log -p`, no diffing recent commits, no " +
        "reading source files.",
    },
    {
      id: "no-auto-recommend",
      statement: "Do not recommend or start the next ticket.",
      rationale: "Which ticket comes next is a planning decision the operator owns.",
    },
    {
      id: "no-padding-empty-sections",
      statement: 'Do not pad a section with "nothing to report" — omit an empty section entirely.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// /handoff — end-of-session closeout
// ─────────────────────────────────────────────────────────────────────────────

const HANDOFF: OperatorWorkflowDefinition = {
  id: "handoff",
  title: "End-of-session handoff",
  purpose:
    "End-of-session handoff for a forge orchestrator. Update the backlog notes block so the next session has a real " +
    "starting point, and surface anything that needs human attention before stopping. The value of the notes block " +
    "is forward-looking context git cannot give you — where the thread left off, what was deliberately NOT done, " +
    'external state to remember. "What shipped" is incidental; git log is the canonical record.',
  maintainedProse: MAINTAINED_PROSE,
  boundedCli: {
    statement:
      "Use the `forge backlog` CLI for all backlog reads AND writes. Never open or edit the backlog file directly " +
      "with a file tool.",
    forbiddenDirectAccess: ["BACKLOG.md", "backlog/notes.md"],
    drillIn: "forge backlog show <id>",
    rationale:
      "The CLI is the bounded interface for reads and the only sanctioned writer; a direct edit bypasses the store " +
      "the next session will actually read.",
  },
  probes: [
    {
      id: "git-log-unpushed",
      command: "git log --oneline origin/main..HEAD 2>/dev/null",
      purpose: "commits ahead of origin since the last push",
      tolerateEmpty: true,
    },
    { id: "git-status", command: "git status", purpose: "uncommitted changes" },
    {
      id: "backlog-notes-show",
      command: "forge backlog notes show",
      purpose: "the current notes block — the one about to be replaced",
    },
    {
      id: "backlog-list-done",
      command: "forge backlog list --status done 2>&1 | head -30",
      purpose: "tickets closed recently, most-recent first",
    },
  ],
  report: [
    {
      id: "final-status",
      label: "Final status",
      content:
        "branch ahead-of-origin count + uncommitted file count; when commits are unpushed, ASK whether to push",
    },
  ],
  rules: [
    {
      id: "bounded-cli-only",
      kind: "bounded-cli",
      statement:
        "Every backlog read and write goes through `forge backlog`; drill into a ticket body only via " +
        "`forge backlog show <id>`.",
      rationale: "The CLI is the bounded interface and the only writer the next session's reads will agree with.",
    },
    {
      id: "parallel-probe-batch",
      kind: "probe-execution",
      statement: "Run the probe set as ONE parallel batch to collect session state before drafting.",
      rationale: "The probes are independent reads; the draft depends on all of them.",
    },
    {
      id: "notes-block-shape",
      kind: "report-shape",
      statement:
        "Draft the notes block in the declared section order, leading with the forward-looking sections and " +
        "keeping the shipped punch list tight and last.",
      rationale:
        'A block that leads with "what shipped" buries the only content git cannot reproduce.',
    },
    {
      id: "heredoc-apply-discipline",
      kind: "apply-discipline",
      statement:
        "Apply the drafted block immediately by piping it to `forge backlog notes replace -` through a " +
        "QUOTED-delimiter heredoc. Do not carry the old content forward unchanged, and do not present the draft " +
        "for review before applying.",
      rationale:
        "Handoff blocks contain backticks, `$` and quotes that a plain double-quoted argument would let the shell " +
        "expand or mangle; the quoted delimiter disables all expansion so the block lands verbatim. `replace` " +
        "rejects empty input, so a botched pipe errors instead of silently wiping the block. The operator trusts " +
        "the synthesis and will catch a wrong one at the next orientation.",
    },
    {
      id: "picked-up-next-reconciliation",
      kind: "reconciliation",
      statement:
        'Before listing any ticket under "Picked up next", verify it still appears in the active list, is not in ' +
        "the done list, and is not referenced by a merge commit from this session. A ticket that closed or landed " +
        'this session belongs under "Shipped (for reference)", never under "Picked up next". A next move that is ' +
        "not a ticket — an external review, hardware verification, a manual deploy step — is stated explicitly as " +
        "a non-ticket thread with no `#number` ref.",
      rationale:
        "A stale ref in the handoff becomes the next session's false starting point, and a non-ticket thread given " +
        "a fake ref is lost the moment ticket refs are pruned.",
    },
  ],
  prohibitions: [
    { id: "no-whole-backlog-read", statement: "Do not read the backlog file whole — use the CLI." },
    {
      id: "no-auto-push",
      statement: "Do not push commits automatically — always ask.",
      rationale: "Publishing is the operator's call; a session that pushes on its own removes the decision.",
    },
    {
      id: "no-auto-memory-edit",
      statement:
        "Do not update CLAUDE.md, AGENTS.md, or any durable memory surface without flagging the proposed change " +
        "first and getting an explicit yes.",
    },
    {
      id: "no-reviewed-stamp",
      statement:
        "Do not write or refresh a `reviewed:` stamp when flagging a memory this session may have invalidated — " +
        "flag the file and a proposed correction only.",
      rationale:
        "Handoff's flag is cheap and unverified; a reviewed stamp asserts the claim was re-checked against current " +
        "sources, which is /memory-review's job. Letting handoff stamp would forge that assurance and erode the " +
        "reviewed-stamp integrity the audit cadence depends on.",
    },
    {
      id: "no-shipped-first",
      statement: 'Do not lead the notes with "what shipped" — the forward-looking sections are the value.',
    },
    {
      id: "no-padding-empty-sections",
      statement: 'Do not pad a section with "nothing to report here" — omit empty sections entirely.',
    },
  ],
  notesBlock: {
    applyCommand: "forge backlog notes replace -",
    heredocDelimiter: "NOTES",
    heredocForm: "forge backlog notes replace - <<'NOTES'\n<draft block goes here>\nNOTES",
    headerLine: "**Last session ended <YYYY-MM-DD>.**",
    sections: [
      {
        id: "where-we-left-off",
        heading: "**Where we left off:**",
        content: "one sentence on the mid-conversation thread or the last operator direction",
      },
      {
        id: "picked-up-next",
        heading: "**Picked up next:**",
        content: "2-3 concrete starting moves the next session can take, ordered by priority",
      },
      {
        id: "external-state",
        heading: "**External state to remember:**",
        content: "off-repo items: third-party approvals, deployments, manual steps pending",
        omitWhenEmpty: true,
      },
      {
        id: "decisions",
        heading: "**Decisions worth not relitigating:**",
        content:
          "items considered and closed/deferred this session, one line each, so future-self does not re-debate " +
          "settled calls",
        omitWhenEmpty: true,
      },
      {
        id: "invalidated-memories",
        heading: "**Memories this session may have invalidated:**",
        content:
          "memory files this session's OWN changes or decisions contradict — name each specific file and give a " +
          "bounded one-line proposed correction. Consider ONLY memory implicated by changes or decisions made this " +
          "session; do not scan or re-review the whole memory corpus. Propose only: do not edit any memory file, " +
          "touch CLAUDE.md, or write a reviewed stamp — verifying the correction and owning the stamp is " +
          "/memory-review's job",
        omitWhenEmpty: true,
      },
      {
        id: "shipped",
        heading: "**Shipped (for reference):**",
        content: "punch list of ticket ids + one-liners; git log is canonical, so keep it tight",
      },
    ],
  },
};

export const OPERATOR_WORKFLOWS: readonly OperatorWorkflowDefinition[] = [ORIENT, HANDOFF];

export function operatorWorkflow(id: OperatorWorkflowId): OperatorWorkflowDefinition {
  const found = OPERATOR_WORKFLOWS.find((w) => w.id === id);
  if (!found) throw new Error(`forge: no operator workflow named '${id}'`);
  return found;
}

/** The rule kinds each workflow MUST name. This is the coverage contract: drop a
 *  rule and the unit test fails by kind, not by a copied string. Orientation has
 *  no durable write (`apply-discipline`) and handoff ends by asking about push
 *  inside its final-status section rather than with a steering question, so the
 *  two sets differ on purpose. */
export const OPERATOR_WORKFLOW_RULE_COVERAGE: Record<OperatorWorkflowId, readonly OperatorRuleKind[]> = {
  orient: ["bounded-cli", "probe-execution", "report-shape", "reconciliation", "surfacing", "closing"],
  handoff: ["bounded-cli", "probe-execution", "report-shape", "reconciliation", "apply-discipline"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Renderable claims — the surface every provider rendering must carry
// ─────────────────────────────────────────────────────────────────────────────

/** One behavioral claim a rendering must carry, with a stable id. Renderer tests
 *  iterate THIS rather than a hand-kept list, so a rule added to a definition
 *  fails every renderer's coverage assertion until it is rendered. */
export type WorkflowClaim = { id: string; text: string };

export function workflowClaims(def: OperatorWorkflowDefinition): readonly WorkflowClaim[] {
  const claims: WorkflowClaim[] = [
    { id: "purpose", text: def.purpose },
    { id: "bounded-cli:statement", text: def.boundedCli.statement },
    { id: "bounded-cli:drill-in", text: def.boundedCli.drillIn },
  ];
  for (const path of def.boundedCli.forbiddenDirectAccess) {
    claims.push({ id: `bounded-cli:forbidden:${path}`, text: path });
  }
  claims.push({ id: "maintained-prose:path", text: def.maintainedProse.path });
  claims.push({ id: "maintained-prose:statement", text: def.maintainedProse.statement });
  for (const p of def.probes) claims.push({ id: `probe:${p.id}`, text: p.command });
  for (const s of def.report) claims.push({ id: `report:${s.id}`, text: s.label });
  for (const r of def.rules) claims.push({ id: `rule:${r.id}`, text: r.statement });
  for (const p of def.prohibitions) claims.push({ id: `prohibition:${p.id}`, text: p.statement });
  if (def.notesBlock) {
    claims.push({ id: "notes-block:apply-command", text: def.notesBlock.applyCommand });
    claims.push({ id: "notes-block:heredoc", text: def.notesBlock.heredocForm });
    claims.push({ id: "notes-block:header", text: def.notesBlock.headerLine });
    for (const s of def.notesBlock.sections) {
      claims.push({ id: `notes-block:section:${s.id}`, text: s.heading });
    }
  }
  return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces — including the generic fallback, which is a documented ABSENCE
// ─────────────────────────────────────────────────────────────────────────────

/** Surface ids are the orchestrator adapter ids plus `generic`. Derived from the
 *  capability matrix's adapter ids by TYPE so the two cannot drift into naming
 *  different providers; no adapter behavior is imported or implied. */
export type OperatorSurfaceId = OrchestratorAdapterId | "generic";

export type OperatorSurface = {
  id: OperatorSurfaceId;
  /** The workflows this surface renders as FILES. Empty means Forge writes
   *  nothing for this surface — a documented absence, never a placeholder file. */
  renders: readonly OperatorWorkflowId[];
  /** The honest answer to "how do I orient in this session?" for this surface. */
  operatorAnswer: string;
};

export const OPERATOR_SURFACES: readonly OperatorSurface[] = [
  {
    id: "claude-code",
    renders: OPERATOR_WORKFLOW_IDS,
    operatorAnswer: "Invoke the installed slash command; the workflow is rendered into the project's command dir.",
  },
  {
    id: "codex",
    renders: OPERATOR_WORKFLOW_IDS,
    operatorAnswer:
      "Invoke the installed repository-scoped skill by name, or ask for it in natural language. Installation is " +
      "not evidence the running build loaded the skill — activation is unverified.",
  },
  {
    id: "generic",
    renders: [],
    operatorAnswer:
      "The forge CLI is the interface: run the workflow's commands directly (`forge backlog notes show`, " +
      "`forge backlog list --status active`, …). Forge writes NO provider files for this surface — the absence is " +
      "the answer, not a missing feature.",
  },
];

export function operatorSurface(id: OperatorSurfaceId): OperatorSurface {
  const found = OPERATOR_SURFACES.find((s) => s.id === id);
  if (!found) throw new Error(`forge: no operator surface named '${id}'`);
  return found;
}

/** True when a surface deliberately renders nothing. Callers report this state
 *  rather than treating it as a failed install. */
export function isDocumentedAbsence(surface: OperatorSurface): boolean {
  return surface.renders.length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ownership inventory — every provider-specific surface REGION, and who
// maintains it (FG-253, absorbing FG-347)
// ─────────────────────────────────────────────────────────────────────────────
//
// FG-347's defect was a file nobody owned: `CLAUDE.md` carries a Forge-rendered
// block AND hand-authored prose, so "who maintains CLAUDE.md?" has no single
// answer — and the half that fell between the two answers drifted for months.
// The lesson generalizes: ownership is a property of a REGION, not of a file. An
// inventory that labels `CLAUDE.md` with one owner has not answered the question
// it exists to answer.
//
// So this list is region-by-region, and it is the ONE place the ownership rule is
// expressed — every provider rendering, doc and test reads it rather than
// restating it. The totality of it is checked in operator-workflows.test.ts
// against the paths the renderers actually produce: a surface added without an
// owner fails to compile (see `_allSurfacesOwned` below), and a rendered file no
// region covers fails the suite.

export const REGION_OWNERS = [
  /** The renderer owns the bytes. Foreign content at these paths is refused —
   *  reported and preserved, never overwritten. */
  "forge-generated",
  /** Durable prose the documentation-maintainer routes to and corrects. */
  "documentation-maintainer",
  /** Policy surfaces the orchestrator authors directly. */
  "orchestrator",
  /** Operator/user-owned. Forge does not read, splice, or write these bytes. */
  "external",
] as const;

export type RegionOwner = (typeof REGION_OWNERS)[number];

/** Which part of a path a region covers. A file with a Forge-written part and an
 *  operator-written part MUST appear twice — once as `forge-region`, once as
 *  `outside-forge-region` — so the two halves are labelled separately and the
 *  pair is provably a partition. `whole-file` is for paths with one owner. */
export type RegionScope = "whole-file" | "forge-region" | "outside-forge-region";

/** What happens to content at this region that its owner did not write. The two
 *  Forge-generated disciplines are NOT the same refusal, and conflating them is
 *  the mistake this union exists to prevent:
 *
 *   - `refuse-foreign-preserve`: an edited adapter file has lost its ownership
 *     marker, so the installer classifies it FOREIGN, leaves the bytes alone and
 *     reports an override. The edit survives; the refresh is what is declined.
 *   - `deterministic-re-render`: the marker block in `CLAUDE.md` is spliced
 *     wholesale on every render. An edit inside it does NOT survive the next
 *     `forge upgrade` — it is destroyed, not preserved. */
export type RegionDiscipline =
  | "refuse-foreign-preserve"
  | "deterministic-re-render"
  | "merge-forge-entries"
  | "owner-edits-directly"
  | "byte-untouched";

export type SurfaceRegion = {
  /** Stable id — reports and tests name regions by this. */
  id: string;
  /** Repo-relative, POSIX. `*` matches within one path segment, `**` matches
   *  across segments. */
  path: string;
  /** Paths matching any of these are NOT this region's — how the operator's own
   *  `.agents/skills/<name>/` stays external while Forge's own dirs do not. */
  except?: readonly string[];
  scope: RegionScope;
  /** Non-empty when the scope is a part of a mixed file: names the part in the
   *  terms an operator can see in the file. */
  regionLabel?: string;
  owner: RegionOwner;
  discipline: RegionDiscipline;
  /** Which provider surfaces this region belongs to. */
  surfaces: readonly OperatorSurfaceId[];
  /** Why the owner is who it is. */
  why: string;
};

export const OPERATOR_SURFACE_REGIONS = [
  {
    id: "claude-command-files",
    path: ".claude/commands/*.md",
    scope: "whole-file",
    owner: "forge-generated",
    discipline: "refuse-foreign-preserve",
    surfaces: ["claude-code"],
    why:
      "Rendered from the operator-workflow definition and stamped. Hand-editing one strips the ownership marker, " +
      "which makes it foreign — forge then declines to refresh it and reports the override.",
  },
  {
    id: "claude-md-forge-block",
    path: "CLAUDE.md",
    scope: "forge-region",
    regionLabel: "the fenced <!-- forge:orchestrator-start --> … <!-- forge:orchestrator-end --> block",
    owner: "forge-generated",
    discipline: "deterministic-re-render",
    surfaces: ["claude-code"],
    why:
      "Spliced wholesale from seeds/orchestrator-template.md on every init/upgrade. An edit made here is destroyed " +
      "by the next render, so the correction path is the seed, never the block.",
  },
  {
    id: "claude-md-orchestrator-policy",
    path: "CLAUDE.md",
    scope: "outside-forge-region",
    regionLabel: "everything outside the forge block",
    owner: "orchestrator",
    discipline: "owner-edits-directly",
    surfaces: ["claude-code"],
    why:
      "The orchestrator's own operating policy. Forge never reads or splices it; the orchestrator edits it directly. " +
      "Volatile repo description does NOT belong here — that is FG-347's defect, and it lives in the " +
      "documentation-maintainer's document instead.",
  },
  {
    id: "claude-settings-local-forge-hooks",
    path: ".claude/settings.local.json",
    scope: "forge-region",
    regionLabel: "forge's own heartbeat hook entries under `hooks`",
    owner: "forge-generated",
    discipline: "merge-forge-entries",
    surfaces: ["claude-code"],
    why:
      "forge init/upgrade rewrite the command on their OWN hook entries, matched by the forge heartbeat marker, and " +
      "merge them into whatever is already there.",
  },
  {
    id: "claude-settings-local-operator-keys",
    path: ".claude/settings.local.json",
    scope: "outside-forge-region",
    regionLabel: "every other key, and every hook entry that is not forge's",
    owner: "external",
    discipline: "byte-untouched",
    surfaces: ["claude-code"],
    why: "Per-developer local settings. The merge preserves them; nothing here is forge's to author.",
  },
  {
    id: "codex-forge-skills",
    path: ".agents/skills/forge-*/SKILL.md",
    scope: "whole-file",
    owner: "forge-generated",
    discipline: "refuse-foreign-preserve",
    surfaces: ["codex"],
    why: "Rendered and stamped exactly like the Claude commands, with the same foreign-content refusal.",
  },
  {
    id: "codex-operator-skills",
    path: ".agents/skills/**",
    except: [".agents/skills/forge-*/**"],
    scope: "whole-file",
    owner: "external",
    discipline: "byte-untouched",
    surfaces: ["codex"],
    why:
      "`.agents/skills/` is the operator's directory; forge owns only the per-directory set it renders. Treating the " +
      "parent as forge's would un-commit somebody else's skills.",
  },
  {
    id: "codex-config",
    path: ".codex/**",
    scope: "whole-file",
    owner: "external",
    discipline: "byte-untouched",
    surfaces: ["codex"],
    why:
      "Codex's own configuration, including the deprecated custom-prompt dirs. Forge renders nothing here — see " +
      "CODEX_DEPRECATED_PROMPT_DIRS.",
  },
  {
    id: "agents-md",
    path: "AGENTS.md",
    scope: "whole-file",
    owner: "external",
    discipline: "byte-untouched",
    surfaces: ["claude-code", "codex"],
    why:
      "The operator's instruction carrier. FG-253 deliberately did NOT introduce marker discipline here — relocating " +
      "the unowned prose to a maintained document is what gave it an owner instead.",
  },
  {
    id: "maintained-docs",
    path: "docs/**",
    scope: "whole-file",
    owner: "documentation-maintainer",
    discipline: "owner-edits-directly",
    surfaces: ["claude-code", "codex", "generic"],
    why:
      "Durable prose the documentation-maintainer already routes to and corrects — which is why the volatile " +
      "repo-specific prose was relocated to MAINTAINED_PROSE.path and linked from every rendered adapter.",
  },
] as const satisfies readonly SurfaceRegion[];

/** Compile-time totality over surfaces: a provider surface added to
 *  `OperatorSurfaceId` with no region in the inventory above makes this line a
 *  type error naming the unowned surface. "No prose without an owner" is only
 *  enforceable if adding a surface cannot skip the question. */
type CoveredSurface = (typeof OPERATOR_SURFACE_REGIONS)[number]["surfaces"][number];
type UnownedSurface = Exclude<OperatorSurfaceId, CoveredSurface>;
const _allSurfacesOwned: [UnownedSurface] extends [never] ? true : { unownedSurface: UnownedSurface } = true;
void _allSurfacesOwned;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("**")
    .map((chunk) => chunk.split("*").map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function regionMatchesPath(region: SurfaceRegion, repoRelPath: string): boolean {
  if (!globToRegExp(region.path).test(repoRelPath)) return false;
  return !(region.except ?? []).some((ex) => globToRegExp(ex).test(repoRelPath));
}

/** Every region covering `repoRelPath`. One entry for a single-owner file; two —
 *  a `forge-region` and an `outside-forge-region` — for a mixed one. Empty means
 *  the path has NO declared owner, which is the state this inventory exists to
 *  make visible. */
export function regionsOwning(repoRelPath: string): readonly SurfaceRegion[] {
  return OPERATOR_SURFACE_REGIONS.filter((r) => regionMatchesPath(r, repoRelPath));
}

export function regionsForSurface(id: OperatorSurfaceId): readonly SurfaceRegion[] {
  return OPERATOR_SURFACE_REGIONS.filter((r) => (r.surfaces as readonly OperatorSurfaceId[]).includes(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership marker + release stamp
// ─────────────────────────────────────────────────────────────────────────────

/** The release/generation identity embedded in a rendered adapter file. Opaque on
 *  purpose: this module does not know how a release names itself, and inventing a
 *  fallback here (a bare "dev", say) would make two unrelated trees compare EQUAL,
 *  which is the one comparison the stamp exists to get right. The caller that
 *  resolves the executing release supplies it. */
export type AdapterStamp = string;

/** Conservative on purpose: a stamp is embedded inside an HTML comment, so any
 *  byte that could terminate the comment or wrap a line would let a stamp forge
 *  content around the marker. Alphanumerics plus a few separators is enough for
 *  every identity forge actually mints (release ids, generation dir names, shas). */
export const ADAPTER_STAMP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,199}$/;

export function isValidAdapterStamp(stamp: string): boolean {
  return ADAPTER_STAMP_PATTERN.test(stamp);
}

/** Marker shape. The version token is part of the match: a future v2 marker parses
 *  as `null` here, which classifies the file FOREIGN and therefore
 *  never-overwritten. That is the safe direction — an older forge declining to
 *  clobber a newer forge's file loses a refresh; the other direction loses bytes. */
export const ADAPTER_MARKER_VERSION = "v1";
const ADAPTER_MARKER_TAG = "forge:operator-adapter";
const ADAPTER_MARKER_RE = new RegExp(
  `<!--\\s*${ADAPTER_MARKER_TAG}\\s+${ADAPTER_MARKER_VERSION}\\s+stamp=([A-Za-z0-9][A-Za-z0-9._:+@-]{0,199})\\s*-->`,
);

/** The human-readable half of the marker: whoever opens the file learns it is
 *  generated and how to take ownership of it. Not parsed — the machine half is the
 *  line above it. */
export const ADAPTER_MARKER_NOTICE =
  "<!-- Generated by forge from the provider-neutral operator-workflow definition. " +
  "`forge upgrade` overwrites this file. To own it yourself, delete the marker line above. -->";

/** Render the ownership marker carrying `stamp`. Throws on a stamp that could
 *  escape the comment, because a silently-sanitized stamp would produce a file
 *  whose marker says one release and whose bytes came from another. */
export function renderAdapterMarker(stamp: AdapterStamp): string {
  if (!isValidAdapterStamp(stamp)) {
    throw new Error(
      `forge: invalid adapter stamp ${JSON.stringify(stamp)} — a stamp is embedded in an HTML comment and must ` +
        `match ${ADAPTER_STAMP_PATTERN.source} (no whitespace, no comment terminators).`,
    );
  }
  return `<!-- ${ADAPTER_MARKER_TAG} ${ADAPTER_MARKER_VERSION} stamp=${stamp} -->\n${ADAPTER_MARKER_NOTICE}`;
}

/** Read the marker's stamp back out of arbitrary bytes.
 *
 *  Returns the stamp for Forge-owned bytes, `null` for anything else. A file
 *  carrying a DIFFERENT release's stamp returns THAT stamp — mismatch is
 *  detectable, not merely absent, which is what makes the host/project version
 *  split reportable at the launch boundary instead of silent. */
export function parseAdapterMarker(bytes: string): AdapterStamp | null {
  const m = ADAPTER_MARKER_RE.exec(bytes);
  return m?.[1] ?? null;
}

/** Ownership, decided from the bytes on disk and nothing else — never from a
 *  record of what forge previously wrote, because projects are cloned and forge is
 *  reinstalled at new paths. */
export function isForgeOwnedAdapter(bytes: string): boolean {
  return parseAdapterMarker(bytes) !== null;
}
