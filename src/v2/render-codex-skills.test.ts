// FG-253 step 3 — the Codex rendering carries the WHOLE definition and NOTHING
// but the definition plus invocation mechanics.
//
// Every coverage assertion below iterates the step-1 definition rather than a
// copied list, so adding a rule to src/v2/operator-workflows.ts fails here until
// it is actually rendered. The provenance assertions run the other direction:
// they walk the rendered parts and check each one against the source its tag
// claims, so a behavioral sentence cannot be added to the renderer without
// mislabeling it as decor, a section heading, or an invocation mechanic — each of
// which is separately constrained.

import { test } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import {
  ADAPTER_MARKER_NOTICE,
  OPERATOR_WORKFLOWS,
  OPERATOR_WORKFLOW_IDS,
  operatorWorkflow,
  parseAdapterMarker,
  renderAdapterMarker,
  workflowClaims,
  type OperatorWorkflowDefinition,
  type OperatorWorkflowId,
} from "./operator-workflows.js";
import {
  CODEX_ACTIVATION_PHRASES,
  CODEX_DECOR_PATTERN,
  CODEX_DEPRECATED_PROMPT_DIRS,
  CODEX_RENDER_TOKENS,
  CODEX_SKILLS_ROOT,
  FORGE_OWNED_CODEX_SKILL_DIRS,
  codexInvocationMechanics,
  codexSkillBodyParts,
  codexSkillDescription,
  codexSkillDirPath,
  codexSkillName,
  codexSkillTargetPath,
  codexStructureTokens,
  isCodexRenderToken,
  isForgeOwnedCodexSkillDir,
  renderCodexSkill,
  renderCodexSkills,
} from "./render-codex-skills.js";

const STAMP = "fg253-rel-0001";

// ---- Paths and ownership ---------------------------------------------------

test("both workflows render to .agents/skills/forge-<name>/SKILL.md", () => {
  assert.equal(codexSkillTargetPath("orient"), ".agents/skills/forge-orient/SKILL.md");
  assert.equal(codexSkillTargetPath("handoff"), ".agents/skills/forge-handoff/SKILL.md");
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.equal(codexSkillTargetPath(id), `${CODEX_SKILLS_ROOT}/${codexSkillName(id)}/SKILL.md`);
    assert.equal(codexSkillDirPath(id), `${CODEX_SKILLS_ROOT}/forge-${id}`);
  }
});

test("the Forge-owned skill directory set is exactly {forge-orient, forge-handoff}", () => {
  assert.deepEqual([...FORGE_OWNED_CODEX_SKILL_DIRS].sort(), ["forge-handoff", "forge-orient"]);
  assert.ok(isForgeOwnedCodexSkillDir("forge-orient"));
  assert.ok(isForgeOwnedCodexSkillDir("forge-handoff"));
  // The operator's own skills, and the parent directory itself, are not Forge's.
  for (const foreign of ["my-own-skill", "forge", "forge-orientation", "orient", "", ".agents/skills"]) {
    assert.equal(isForgeOwnedCodexSkillDir(foreign), false, `'${foreign}' must not be claimed as Forge-owned`);
  }
});

test("no rendered path is under a Codex custom-prompts directory", () => {
  assert.ok(CODEX_DEPRECATED_PROMPT_DIRS.length > 0, "the deprecated locations must be named to be checkable");
  for (const { path } of renderCodexSkills(STAMP)) {
    assert.ok(path.startsWith(`${CODEX_SKILLS_ROOT}/`), `${path} is not a repository-scoped skill path`);
    for (const deprecated of CODEX_DEPRECATED_PROMPT_DIRS) {
      assert.ok(!path.includes(deprecated), `${path} is under the deprecated custom-prompts dir ${deprecated}`);
    }
    assert.ok(!/prompts/i.test(path), `${path} names a prompts directory; custom prompts are deprecated`);
  }
});

test("renderCodexSkills renders every workflow exactly once, matching the single-file renderer", () => {
  const rendered = renderCodexSkills(STAMP);
  assert.deepEqual(
    rendered.map((r) => r.workflow),
    [...OPERATOR_WORKFLOW_IDS],
  );
  for (const r of rendered) {
    assert.equal(r.skillName, codexSkillName(r.workflow));
    assert.equal(r.path, codexSkillTargetPath(r.workflow));
    assert.equal(r.contents, renderCodexSkill(r.workflow, STAMP));
  }
});

// ---- Ownership marker ------------------------------------------------------

test("each rendered skill carries the ownership marker with the running release stamp", () => {
  for (const { contents } of renderCodexSkills(STAMP)) {
    assert.equal(parseAdapterMarker(contents), STAMP);
    assert.ok(contents.includes(renderAdapterMarker(STAMP)), "the full marker region must be present verbatim");
    assert.ok(contents.includes(ADAPTER_MARKER_NOTICE), "a human opening the file must learn it is generated");
  }
});

test("an invalid stamp is refused rather than sanitized into a lying marker", () => {
  assert.throws(() => renderCodexSkill("orient", "has space"), /invalid adapter stamp/);
  assert.throws(() => renderCodexSkills("ends--><script>"), /invalid adapter stamp/);
});

// ---- Frontmatter -----------------------------------------------------------

test("frontmatter parses, and its name is the directory the file lives in", () => {
  for (const { path, contents, skillName } of renderCodexSkills(STAMP)) {
    const parsed = matter(contents);
    const data = parsed.data as { name?: unknown; description?: unknown };
    assert.equal(data.name, skillName);
    assert.equal(path, `${CODEX_SKILLS_ROOT}/${data.name as string}/SKILL.md`);
    assert.equal(typeof data.description, "string");
    assert.ok((data.description as string).trim().length > 0);
    assert.ok(parsed.content.trim().length > 0, "frontmatter must be followed by a body");
  }
});

test("the description carries every natural-language activation phrase and names the skill", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const phrases = CODEX_ACTIVATION_PHRASES[id];
    assert.ok(phrases.length >= 3, `${id} lists too few activation phrases to match on`);
    const description = codexSkillDescription(id);
    for (const phrase of phrases) {
      assert.ok(description.includes(phrase), `${id}: description omits the activation phrase '${phrase}'`);
    }
    assert.ok(description.includes(codexSkillName(id)), `${id}: description does not name the skill`);
    assert.ok(description.includes(operatorWorkflow(id).title), `${id}: description does not say what the skill is`);

    // It survives into the file, through YAML quoting, unchanged.
    const parsed = matter(renderCodexSkill(id, STAMP));
    assert.equal((parsed.data as { description?: string }).description, description);
  }
});

test("the two skills activate on different phrases — one description cannot answer for both", () => {
  const orient = new Set(CODEX_ACTIVATION_PHRASES.orient);
  const overlap = CODEX_ACTIVATION_PHRASES.handoff.filter((p) => orient.has(p));
  assert.deepEqual(overlap, [], `orient and handoff share activation phrases: ${overlap.join(", ")}`);
});

// ---- Explicit invocation ---------------------------------------------------

test("each skill states an explicit by-name invocation, so activation never depends only on prose matching", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const skill = codexSkillName(id);
    const mechanics = codexInvocationMechanics(id);
    const explicit = mechanics.filter((m) => /invoke/i.test(m) && m.includes(skill));
    assert.ok(explicit.length >= 1, `${id} has no explicit-invocation line naming ${skill}`);
    assert.ok(
      mechanics.some((m) => CODEX_ACTIVATION_PHRASES[id].every((p) => m.includes(p))),
      `${id} does not state its natural-language activation phrases in the body`,
    );
    for (const sentence of mechanics) {
      assert.ok(renderCodexSkill(id, STAMP).includes(sentence), `${id}: mechanics sentence never reached the file`);
    }
  }
});

test("no rendering claims the skill is active — installation is not activation", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const contents = renderCodexSkill(id, STAMP);
    assert.match(contents, /unverified/i, `${id} must say activation is unverified`);
    assert.match(contents, /forge CLI is the interface/i, `${id} must name the CLI fallback when the skill is ignored`);
    assert.ok(
      !/(verified|guaranteed|confirmed)[^.]{0,40}(active|loaded)/i.test(contents),
      `${id} claims verified activation`,
    );
  }
});

// ---- Body coverage, iterated FROM the step-1 definition --------------------

test("every claim the definition makes is present in the rendered skill", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const contents = renderCodexSkill(def.id, STAMP);
    for (const claim of workflowClaims(def)) {
      assert.ok(
        contents.includes(claim.text),
        `${def.id}: rendered skill omits claim '${claim.id}':\n  ${claim.text}`,
      );
    }
  }
});

test("rationales are rendered too — a rule whose reason is invisible is a rule a session talks itself out of", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const contents = renderCodexSkill(def.id, STAMP);
    for (const rule of def.rules) {
      if (rule.rationale) assert.ok(contents.includes(rule.rationale), `${def.id}/${rule.id}: rationale dropped`);
    }
    for (const prohibition of def.prohibitions) {
      if (prohibition.rationale) {
        assert.ok(contents.includes(prohibition.rationale), `${def.id}/${prohibition.id}: rationale dropped`);
      }
    }
    assert.ok(contents.includes(def.boundedCli.rationale), `${def.id}: the bounded-CLI reason is missing`);
  }
});

test("the report and notes-block orderings survive the rendering", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const contents = renderCodexSkill(def.id, STAMP);
    const positions = def.report.map((s) => contents.indexOf(`**${s.label}**`));
    for (const [i, at] of positions.entries()) {
      assert.ok(at >= 0, `${def.id}: report section '${def.report[i]?.id}' is not rendered as a labelled entry`);
      if (i > 0) assert.ok(at > (positions[i - 1] ?? -1), `${def.id}: report section ${i} rendered out of order`);
    }
    const notes = def.notesBlock;
    if (!notes) continue;
    const sectionAt = notes.sections.map((s) => contents.indexOf(s.heading));
    for (const [i, at] of sectionAt.entries()) {
      assert.ok(at >= 0, `${def.id}: notes section '${notes.sections[i]?.id}' is missing`);
      if (i > 0) assert.ok(at > (sectionAt[i - 1] ?? -1), `${def.id}: notes section ${i} rendered out of order`);
    }
  }
});

test("orientation renders no notes block — it is a read, and it applies nothing", () => {
  const orient = renderCodexSkill("orient", STAMP);
  assert.ok(!orient.includes("## Notes block"));
  assert.ok(!orient.includes("forge backlog notes replace"), "orientation must not carry handoff's durable write");
});

// ---- Provenance: mechanics and frontmatter only ----------------------------

/** Every string the definition contributes. Built from the definition itself, so
 *  the check below stays honest as the definition grows. */
function definitionStrings(def: OperatorWorkflowDefinition): Set<string> {
  const out = new Set<string>([
    def.purpose,
    def.maintainedProse.path,
    def.maintainedProse.statement,
    def.boundedCli.statement,
    def.boundedCli.drillIn,
    def.boundedCli.rationale,
  ]);
  for (const p of def.boundedCli.forbiddenDirectAccess) out.add(p);
  for (const p of def.probes) {
    out.add(p.command);
    out.add(p.purpose);
  }
  for (const s of def.report) {
    out.add(s.label);
    out.add(s.content);
  }
  for (const r of def.rules) {
    out.add(r.statement);
    if (r.rationale) out.add(r.rationale);
  }
  for (const p of def.prohibitions) {
    out.add(p.statement);
    if (p.rationale) out.add(p.rationale);
  }
  const notes = def.notesBlock;
  if (notes) {
    out.add(notes.applyCommand);
    out.add(notes.heredocForm);
    out.add(notes.headerLine);
    for (const s of notes.sections) {
      out.add(s.heading);
      out.add(s.content);
    }
  }
  return out;
}

test("every rendered part is traceable to its declared source", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const def = operatorWorkflow(id);
    const fromDefinition = definitionStrings(def);
    const structure = new Set(codexStructureTokens(codexSkillName(id)));
    const mechanics = new Set(codexInvocationMechanics(id));

    for (const p of codexSkillBodyParts(id, STAMP)) {
      switch (p.kind) {
        case "definition":
          assert.ok(fromDefinition.has(p.text), `${id}: part tagged 'definition' is not in the definition:\n  ${p.text}`);
          break;
        case "marker":
          assert.equal(p.text, renderAdapterMarker(STAMP));
          break;
        case "structure":
          assert.ok(structure.has(p.text), `${id}: undeclared section heading '${p.text}'`);
          break;
        case "mechanics":
          assert.ok(mechanics.has(p.text), `${id}: undeclared mechanics sentence:\n  ${p.text}`);
          break;
        case "token":
          assert.ok(isCodexRenderToken(p.text), `${id}: undeclared renderer label '${p.text}'`);
          break;
        case "decor":
          assert.match(p.text, CODEX_DECOR_PATTERN, `${id}: decor '${p.text}' carries words, so it can carry behavior`);
          break;
      }
    }
  }
});

test("the renderer's own wording budget stays small, and states no command of its own", () => {
  const tokens = Object.values(CODEX_RENDER_TOKENS);
  assert.ok(tokens.length <= 10, `the renderer label set has grown to ${tokens.length}; behavior belongs in the definition`);
  assert.equal(new Set(tokens).size, tokens.length, "duplicate renderer label");

  const definitionCommands = new Set(OPERATOR_WORKFLOWS.flatMap((d) => d.probes.map((p) => p.command)));
  const rendererProse = [
    ...tokens,
    ...OPERATOR_WORKFLOW_IDS.flatMap((id) => [
      ...codexInvocationMechanics(id),
      ...codexStructureTokens(codexSkillName(id)),
      codexSkillDescription(id),
    ]),
  ];
  // "a forge orchestrator" is the role the workflows serve, not a command line.
  const nonCommandPhrases = ["forge orchestrator"];

  for (const text of rendererProse) {
    // A renderer-authored `forge <verb>` or `git <verb>` would be a probe the
    // definition never sanctioned — exactly the drift this module exists to stop.
    const invented = [...text.matchAll(/\b(?:forge|git) [a-z][a-z-]*/g)]
      .map((m) => m[0])
      .filter((cmd) => !nonCommandPhrases.includes(cmd))
      .filter((cmd) => ![...definitionCommands].some((known) => known.startsWith(cmd)));
    assert.deepEqual(invented, [], `renderer prose invents a command: ${invented.join(", ")} in:\n  ${text}`);
  }
});

test("section headings are labels, not claims", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    for (const t of codexStructureTokens(codexSkillName(id))) {
      assert.match(t, /^#{1,2} \S/, `'${t}' is not a heading`);
      assert.ok(t.length <= 40, `heading '${t}' is long enough to be smuggling a sentence`);
    }
  }
});

// ---- Determinism -----------------------------------------------------------

test("rendering is byte-identical for a fixed stamp, and differs only in the marker across stamps", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.equal(renderCodexSkill(id, STAMP), renderCodexSkill(id, STAMP));

    const other = "fg253-rel-0002";
    const a = renderCodexSkill(id, STAMP);
    const b = renderCodexSkill(id, other);
    assert.notEqual(a, b, "a stamp bump must change the bytes, or a refresh is undetectable");
    assert.equal(
      a.replace(renderAdapterMarker(STAMP), renderAdapterMarker(other)),
      b,
      "two releases differ outside the marker region",
    );
    assert.equal(parseAdapterMarker(b), other);
  }
});
