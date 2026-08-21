// FG-253 step 2 — the Claude rendering is DERIVED, deterministic, and stamped.
//
// The three properties this file exists to hold, in order of what they protect:
//
//  1. COVERAGE, iterated FROM the definition. Every claim `workflowClaims()` names
//     must appear in the rendered bytes. Nothing here lists rules by hand, so a rule
//     added to operator-workflows.ts fails this suite until it is rendered — which is
//     the whole reason the definition is the single source.
//
//  2. NO SMUGGLED BEHAVIOR. Bytes are exactly the renderer's segments joined, every
//     definition segment declares the definition strings it was built from, and every
//     mechanics segment names a declared id. Strip a definition segment's declared
//     parts and labels from its own text and NO WORD may remain — that is the
//     mechanical form of "the rendering adds invocation mechanics and nothing else".
//     A sentence of new behavior cannot pass: it is either an undeclared mechanics id
//     (throws), or residue with letters in it (fails here).
//
//  3. STAMPED AND DETERMINISTIC. The marker is the file's first region, two renders
//     of one release are byte-identical, and two releases differ ONLY inside the
//     marker — so a drift check that compares bytes is comparing content, not noise.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATOR_WORKFLOWS,
  OPERATOR_WORKFLOW_IDS,
  operatorWorkflow,
  parseAdapterMarker,
  renderAdapterMarker,
  workflowClaims,
  type OperatorWorkflowId,
} from "./operator-workflows.js";
import {
  CLAUDE_COMMANDS_DIR,
  CLAUDE_COMMAND_TARGETS,
  CLAUDE_RENDER_LABELS,
  claudeCommandPath,
  claudeCommandSegments,
  claudeMechanics,
  claudeSlashCommand,
  renderClaudeCommand,
  renderClaudeCommands,
} from "./render-claude-commands.js";

const STAMP = "fg253-rel-0001";
const OTHER_STAMP = "fg253-rel-0002";

// ---- Target paths ----------------------------------------------------------

test("the exported target paths are exactly the two Claude command files", () => {
  assert.deepEqual([...CLAUDE_COMMAND_TARGETS], [".claude/commands/orient.md", ".claude/commands/handoff.md"]);
  assert.equal(claudeCommandPath("orient"), ".claude/commands/orient.md");
  assert.equal(claudeCommandPath("handoff"), ".claude/commands/handoff.md");
  assert.equal(CLAUDE_COMMANDS_DIR, ".claude/commands");
  // POSIX separators are part of the contract: this string is an identity that
  // shows up in drift reports and --json, and a backslash on one host would read
  // as a different file.
  for (const p of CLAUDE_COMMAND_TARGETS) {
    assert.ok(!p.includes("\\"), `${p} is not POSIX-separated`);
    assert.ok(!p.startsWith("/"), `${p} is not repo-relative`);
  }
});

test("the file name and the slash command are the same identity", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.equal(claudeSlashCommand(id), `/${id}`);
    assert.equal(claudeCommandPath(id), `${CLAUDE_COMMANDS_DIR}/${id}.md`);
  }
});

test("renderClaudeCommands covers every workflow once, with matching paths and bytes", () => {
  const rendered = renderClaudeCommands(STAMP);
  assert.deepEqual(
    rendered.map((r) => r.workflow),
    [...OPERATOR_WORKFLOW_IDS],
  );
  for (const r of rendered) {
    assert.equal(r.path, claudeCommandPath(r.workflow));
    assert.equal(r.slashCommand, claudeSlashCommand(r.workflow));
    assert.equal(r.bytes, renderClaudeCommand(r.workflow, STAMP));
  }
});

// ---- The marker is the first region, and carries the running stamp ----------

test("each rendered command opens with the ownership marker carrying the release stamp", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const bytes = renderClaudeCommand(id, STAMP);
    const marker = renderAdapterMarker(STAMP);
    assert.ok(bytes.startsWith(marker), `${id} does not open with the ownership marker`);
    assert.equal(parseAdapterMarker(bytes), STAMP, `${id}'s marker does not parse back to the stamp it was given`);
    // Exactly once: a second marker would make ownership ambiguous, and a stamp
    // refresh that rewrote only the first would ship a file claiming two releases.
    assert.equal(bytes.split("forge:operator-adapter").length - 1, 1, `${id} carries more than one marker`);
    // First SEGMENT, not merely first bytes.
    const first = claudeCommandSegments(id, STAMP)[0];
    assert.equal(first?.origin, "marker");
  }
});

test("an unusable stamp is refused rather than sanitized into the file", () => {
  for (const bad of ["", "has space", "ends--><script>"]) {
    assert.throws(() => renderClaudeCommand("orient", bad), /invalid adapter stamp/);
  }
});

test("rendered bytes carry no host path — the symlink model is what this replaces", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const bytes = renderClaudeCommand(id, STAMP);
    assert.ok(
      !bytes.includes("scripts/claude-commands"),
      `${id} still references the old symlink source, which is dead in every other clone`,
    );
    assert.ok(!/\/(Users|home)\//.test(bytes), `${id} embeds an absolute host path`);
  }
});

// ---- Coverage, iterated FROM the definition ---------------------------------

test("every claim the definition names appears in the rendered bytes", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const bytes = renderClaudeCommand(def.id, STAMP);
    const claims = workflowClaims(def);
    assert.ok(claims.length > 0);
    for (const claim of claims) {
      assert.ok(
        bytes.includes(claim.text),
        `${def.id}: claim '${claim.id}' is not rendered — add it to render-claude-commands.ts:\n  ${claim.text}`,
      );
    }
  }
});

test("the report renders in the definition's declared order", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const bytes = renderClaudeCommand(def.id, STAMP);
    const positions = def.report.map((s) => bytes.indexOf(`**${s.label}:**`));
    for (const [i, at] of positions.entries()) {
      assert.ok(at >= 0, `${def.id}: report section '${def.report[i]?.id}' is not rendered as a labelled line`);
      if (i > 0) {
        const prev = positions[i - 1] ?? -1;
        assert.ok(at > prev, `${def.id}: report section '${def.report[i]?.id}' renders out of declared order`);
      }
    }
  }
});

test("probe commands render verbatim, in order, and nothing reaches around the CLI", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const bytes = renderClaudeCommand(def.id, STAMP);
    let cursor = -1;
    for (const p of def.probes) {
      const at = bytes.indexOf(`\`${p.command}\``);
      assert.ok(at > cursor, `${def.id}: probe '${p.id}' is missing or renders out of order`);
      cursor = at;
    }
    for (const forbidden of def.boundedCli.forbiddenDirectAccess) {
      // The forbidden paths ARE named — as things not to open — but never inside a
      // probe command line.
      assert.ok(bytes.includes(forbidden), `${def.id} does not name '${forbidden}' as off limits`);
    }
  }
});

test("FG-588: the canonical /orient adapter performs one bounded Forge read and keeps bulk detail conditional", () => {
  const orient = operatorWorkflow("orient");
  const rendered = renderClaudeCommand("orient", STAMP);

  assert.deepEqual(
    orient.probes.map((probe) => probe.command),
    ["forge orient snapshot --json", "git status", "git log --oneline origin/main..HEAD 2>/dev/null"],
    "ordinary orientation must use the compact snapshot plus the two Git reads",
  );
  for (const oldBulkRead of [
    "forge backlog notes show",
    "forge backlog list --status active",
    "forge backlog list --status done",
    "forge projects show",
    "forge ops check --json",
  ]) {
    assert.ok(!orient.probes.some((probe) => probe.command.includes(oldBulkRead)), `ordinary orient still probes '${oldBulkRead}'`);
  }

  // The rendered command is the canonical project-installed adapter, not a
  // per-project copy. Its ordinary probe block stays compact, while the workflow
  // explicitly retains the full-detail commands only as attention-driven drills.
  assert.match(rendered, /`forge orient snapshot --json`/);
  const drillDown = orient.rules.find((rule) => rule.id === "conditional-drilldown");
  assert.ok(drillDown, "orient must declare when full detail is allowed");
  assert.match(drillDown.statement, /forge backlog show <id>/);
  assert.match(drillDown.statement, /forge ops check --json/);
  assert.match(drillDown.statement, /forge projects show/);
  assert.match(rendered, /The snapshot is the whole ordinary read/);
});

test("only the workflow with a durable write renders an apply section", () => {
  const handoff = renderClaudeCommand("handoff", STAMP);
  const notes = operatorWorkflow("handoff").notesBlock;
  assert.ok(notes);
  assert.ok(handoff.includes("## Applying the block"));
  // Fenced verbatim: the quoted delimiter is the entire mechanism, so a reflowed
  // apply form would silently defeat it.
  assert.ok(handoff.includes(`\`\`\`\n${notes.heredocForm}\n\`\`\``), "the heredoc form is not fenced verbatim");
  assert.ok(handoff.includes(`<<'${notes.heredocDelimiter}'`));

  const orient = renderClaudeCommand("orient", STAMP);
  assert.equal(operatorWorkflow("orient").notesBlock, undefined);
  assert.ok(!orient.includes("## Applying the block"), "orientation is a read; it renders no apply section");
  assert.ok(!orient.includes("notes replace"), "orientation must not render a write command");
});

// ---- No smuggled behavior ---------------------------------------------------

test("the rendered bytes are exactly the declared segments — nothing is unaccounted for", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const segments = claudeCommandSegments(id, STAMP);
    assert.equal(
      `${segments.map((s) => s.text).join("\n\n")}\n`,
      renderClaudeCommand(id, STAMP),
      `${id}: rendered bytes are not reconstructible from the segments, so provenance proves nothing`,
    );
    for (const s of segments) assert.ok(s.text.trim().length > 0, `${id} renders an empty segment`);
  }
});

/** Every definition string reachable in the workflow, so a segment cannot declare a
 *  `part` it invented. Deep walk rather than a field list: a field added to the
 *  definition types is covered without editing this test. */
function definitionStrings(id: OperatorWorkflowId): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(operatorWorkflow(id));
  return out;
}

test("every definition segment declares real definition strings, and adds no word of its own", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const known = definitionStrings(id);
    for (const segment of claudeCommandSegments(id, STAMP)) {
      if (segment.origin !== "definition") continue;
      assert.ok(segment.parts.length > 0, `${id}: a definition segment declares no parts`);
      for (const part of segment.parts) {
        assert.ok(
          known.has(part),
          `${id}: segment declares a 'part' that is not a string in the definition:\n  ${part}`,
        );
      }
      for (const label of segment.labels) {
        assert.ok(
          (CLAUDE_RENDER_LABELS as readonly string[]).includes(label),
          `${id}: segment uses an undeclared label '${label}'`,
        );
      }
      // Strip longest-first so a short part cannot eat a longer one's letters.
      const strip = [...segment.parts, ...segment.labels].sort((a, b) => b.length - a.length);
      let residue = segment.text;
      for (const s of strip) residue = residue.split(s).join("");
      assert.ok(
        !/[A-Za-z]/.test(residue),
        `${id}: a definition segment carries wording that is not in the definition and not a declared label.\n` +
          `  residue: ${JSON.stringify(residue)}\n  segment: ${JSON.stringify(segment.text)}`,
      );
    }
  }
});

/** Vocabulary that would constitute behavior in this domain. Chrome and invocation
 *  mechanics may not use any of it: a heading like "## Probes — run them in
 *  parallel" is a rule, and rules live in the definition. Names of definition
 *  FIELDS (probes, report, rules) are deliberately absent — a heading that names the
 *  section it introduces states no behavior; the modal verbs and domain nouns do. */
const BEHAVIORAL_VOCABULARY =
  /\b(backlog|BACKLOG|git|ticket|tickets|push|pushed|commit|commits|incident|incidents|stale|heredoc|parallel|verbatim|sha|do not|never|must|always)\b/i;

test("mechanics segments carry invocation and chrome only — never behavior", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const declared = claudeMechanics(def);
    assert.equal(new Set(declared.map((m) => m.id)).size, declared.length, `${def.id}: duplicate mechanics id`);
    for (const m of declared) {
      assert.ok(m.text.trim().length > 0, `${def.id}: mechanics '${m.id}' is empty`);
      assert.ok(m.text.length <= 140, `${def.id}: mechanics '${m.id}' is long enough to be hiding a rule`);
      const behavioral = BEHAVIORAL_VOCABULARY.exec(m.text);
      assert.equal(
        behavioral,
        null,
        `${def.id}: mechanics '${m.id}' states behavior ('${behavioral?.[0]}') — put it in the definition instead`,
      );
    }

    // Used AND declared, both directions: an emitted string that is not declared
    // throws inside the renderer, and declared chrome that is never used is dead.
    const used = claudeCommandSegments(def.id, STAMP).filter((s) => s.origin === "mechanics");
    const usedIds = new Set(used.map((s) => (s.origin === "mechanics" ? s.id : "")));
    for (const m of declared) assert.ok(usedIds.has(m.id), `${def.id}: declared mechanics '${m.id}' is never rendered`);
    for (const s of used) {
      if (s.origin !== "mechanics") continue;
      const match = declared.find((m) => m.id === s.id);
      assert.ok(match, `${def.id}: rendered an undeclared mechanics id '${s.id}'`);
      assert.equal(s.text, match.text, `${def.id}: mechanics '${s.id}' was rewritten at render time`);
    }
  }
});

test("declared labels are chrome, not rules", () => {
  for (const label of CLAUDE_RENDER_LABELS) {
    assert.ok(label.length <= 60, `label '${label}' is long enough to be a sentence of behavior`);
    const behavioral = BEHAVIORAL_VOCABULARY.exec(label);
    assert.equal(behavioral, null, `label '${label}' states behavior ('${behavioral?.[0]}')`);
  }
  assert.equal(new Set(CLAUDE_RENDER_LABELS).size, CLAUDE_RENDER_LABELS.length, "duplicate render label");
});

test("the renderer refuses an undeclared mechanics id rather than emitting it", () => {
  // The guard that makes property 2 structural rather than reviewed: chrome is
  // resolved through claudeMechanics(), so an id that was never declared throws.
  const orient = operatorWorkflow("orient");
  assert.equal(orient.notesBlock, undefined);
  assert.ok(
    !claudeMechanics(orient).some((m) => m.id === "section:apply"),
    "orientation must not declare apply-section chrome it has no content for",
  );
});

test("provider specificity lives only in the mechanics", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    for (const s of claudeCommandSegments(id, STAMP)) {
      if (s.origin === "definition") {
        // The neutral core legitimately NAMES CLAUDE.md — it is one of the durable
        // memory surfaces handoff must not edit unasked, and that is a rule about a
        // file, not a provider mechanic. What may never appear in a definition
        // segment is the invocation framing: how a Claude session runs this.
        assert.ok(
          !/claude code|slash command/i.test(s.text),
          `${id}: a definition segment carries Claude invocation framing, so the core is not provider-neutral`,
        );
      }
    }
    // …and it IS present: the file has to tell the operator how to run it.
    assert.ok(renderClaudeCommand(id, STAMP).includes("Claude Code slash command"));
  }
});

// ---- Determinism and stamp isolation ---------------------------------------

test("rendering twice with the same stamp is byte-identical", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.equal(renderClaudeCommand(id, STAMP), renderClaudeCommand(id, STAMP));
  }
});

test("a different stamp changes the marker region and nothing else", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const a = renderClaudeCommand(id, STAMP);
    const b = renderClaudeCommand(id, OTHER_STAMP);
    assert.notEqual(a, b, `${id}: two releases render identically, so a stale adapter is undetectable`);

    const markerA = renderAdapterMarker(STAMP);
    const markerB = renderAdapterMarker(OTHER_STAMP);
    assert.equal(a.replace(markerA, markerB), b, `${id}: the stamp leaked outside the marker region`);
    // Stated the other way: strip the first segment and the files are equal.
    assert.equal(a.slice(markerA.length), b.slice(markerB.length));
    assert.equal(parseAdapterMarker(a), STAMP);
    assert.equal(parseAdapterMarker(b), OTHER_STAMP);
  }
});

test("the rendered file ends with exactly one newline", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const bytes = renderClaudeCommand(id, STAMP);
    assert.ok(bytes.endsWith("\n"));
    assert.ok(!bytes.endsWith("\n\n"), `${id}: trailing blank line — an install and a re-render would differ`);
  }
});
