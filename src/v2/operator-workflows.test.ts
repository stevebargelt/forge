// FG-253 step 1 — the provider-neutral operator-workflow core is COMPLETE, and
// its ownership marker is a round-trippable, MISMATCH-DETECTING stamp.
//
// Every assertion below is structural: it iterates the definition's own data and
// asserts the shape holds. Nothing here compares against a copied blob of the
// Claude prose these definitions replace — a test that pins prose would pass
// forever while the behavior it claims to protect rotted, and would have to be
// rewritten by hand the first time a rule is added.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_MARKER_NOTICE,
  ADAPTER_MARKER_VERSION,
  ADAPTER_STAMP_PATTERN,
  MAINTAINED_PROSE,
  OPERATOR_SURFACE_REGIONS,
  OPERATOR_SURFACES,
  REGION_OWNERS,
  regionsForSurface,
  regionsOwning,
  OPERATOR_WORKFLOWS,
  OPERATOR_WORKFLOW_IDS,
  OPERATOR_WORKFLOW_RULE_COVERAGE,
  isDocumentedAbsence,
  isForgeOwnedAdapter,
  isValidAdapterStamp,
  operatorSurface,
  operatorWorkflow,
  parseAdapterMarker,
  renderAdapterMarker,
  workflowClaims,
  type OperatorWorkflowDefinition,
  type OperatorWorkflowId,
  type SurfaceRegion,
} from "./operator-workflows.js";
import { ORCHESTRATOR_ADAPTER_IDS } from "./orchestrator-capabilities.js";
import { CLAUDE_COMMANDS_DIR, claudeCommandPath } from "./render-claude-commands.js";
import { CODEX_SKILLS_ROOT, codexSkillTargetPath } from "./render-codex-skills.js";

// ---- Membership ------------------------------------------------------------

test("both workflows are defined exactly once, in the declared order", () => {
  assert.deepEqual(
    OPERATOR_WORKFLOWS.map((w) => w.id),
    [...OPERATOR_WORKFLOW_IDS],
  );
  assert.equal(new Set(OPERATOR_WORKFLOWS.map((w) => w.id)).size, OPERATOR_WORKFLOW_IDS.length);
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.equal(operatorWorkflow(id).id, id);
  }
  assert.throws(() => operatorWorkflow("nope" as OperatorWorkflowId), /no operator workflow/);
});

// ---- Rule coverage: every kind the workflow owes, named ---------------------
//
// The coverage table is the contract. Both directions are asserted, so neither a
// dropped rule (missing kind) nor a rule smuggled in under a kind the workflow
// never declared (undeclared kind) survives.

test("each workflow names a rule for every kind its coverage contract declares, and no others", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const declared = new Set(OPERATOR_WORKFLOW_RULE_COVERAGE[def.id]);
    const present = new Set(def.rules.map((r) => r.kind));
    for (const kind of declared) {
      assert.ok(present.has(kind), `${def.id} declares rule kind '${kind}' but names no rule of that kind`);
    }
    for (const kind of present) {
      assert.ok(declared.has(kind), `${def.id} carries a rule of kind '${kind}' its coverage contract never declares`);
    }
  }
});

test("orientation reconciles and surfaces; handoff reconciles and applies", () => {
  // The two kinds this ticket exists to preserve, keyed by kind rather than by
  // sentence: a stale-ticket check on both sides, an ops surfacing on orient, a
  // durable-write discipline on handoff.
  const orient = new Set(OPERATOR_WORKFLOW_RULE_COVERAGE.orient);
  const handoff = new Set(OPERATOR_WORKFLOW_RULE_COVERAGE.handoff);
  assert.ok(orient.has("reconciliation") && handoff.has("reconciliation"));
  assert.ok(orient.has("surfacing"), "orient must surface ops incidents");
  assert.ok(handoff.has("apply-discipline"), "handoff must state how the notes block is applied");
  assert.ok(!handoff.has("surfacing"));
  assert.ok(!orient.has("apply-discipline"), "orientation is a read; it applies nothing");
});

// The named rules the ticket contract requires by ID. Ids, not prose — renaming a
// rule is a deliberate act; rewording its statement is ordinary maintenance.
const REQUIRED_RULE_IDS: Record<OperatorWorkflowId, readonly string[]> = {
  orient: [
    "bounded-cli-only",
    "parallel-probe-batch",
    "report-ordering",
    "stale-ticket-reconciliation",
    "ops-incident-surfacing",
    "end-with-one-question",
  ],
  handoff: [
    "bounded-cli-only",
    "parallel-probe-batch",
    "notes-block-shape",
    "heredoc-apply-discipline",
    "picked-up-next-reconciliation",
  ],
};

const REQUIRED_PROHIBITION_IDS: Record<OperatorWorkflowId, readonly string[]> = {
  orient: ["no-whole-backlog-read", "no-auto-recommend", "no-padding-empty-sections"],
  handoff: ["no-whole-backlog-read", "no-auto-push", "no-padding-empty-sections"],
};

test("every required rule and prohibition is named by id", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const ruleIds = new Set(def.rules.map((r) => r.id));
    for (const id of REQUIRED_RULE_IDS[def.id]) {
      assert.ok(ruleIds.has(id), `${def.id} is missing required rule '${id}'`);
    }
    const prohibitionIds = new Set(def.prohibitions.map((p) => p.id));
    for (const id of REQUIRED_PROHIBITION_IDS[def.id]) {
      assert.ok(prohibitionIds.has(id), `${def.id} is missing required prohibition '${id}'`);
    }
  }
});

// ---- Well-formedness -------------------------------------------------------

function assertUniqueIds(ids: readonly string[], what: string): void {
  assert.equal(new Set(ids).size, ids.length, `${what} carries a duplicate id: ${ids.join(", ")}`);
}

test("every definition is structurally well-formed", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    assert.ok(def.title.trim().length > 0, `${def.id} has no title`);
    assert.ok(def.purpose.trim().length > 0, `${def.id} has no purpose`);
    assert.ok(def.probes.length > 0, `${def.id} names no probes`);
    assert.ok(def.report.length > 0, `${def.id} renders no report`);
    assert.ok(def.rules.length > 0, `${def.id} names no rules`);
    assert.ok(def.prohibitions.length > 0, `${def.id} names no prohibitions`);

    assertUniqueIds(def.probes.map((p) => p.id), `${def.id} probes`);
    assertUniqueIds(def.report.map((s) => s.id), `${def.id} report`);
    assertUniqueIds(def.rules.map((r) => r.id), `${def.id} rules`);
    assertUniqueIds(def.prohibitions.map((p) => p.id), `${def.id} prohibitions`);

    for (const p of def.probes) {
      assert.ok(p.command.trim().length > 0, `${def.id}/${p.id} has an empty command`);
      assert.ok(p.purpose.trim().length > 0, `${def.id}/${p.id} says nothing about what it is for`);
    }
    for (const s of def.report) {
      assert.ok(s.label.trim().length > 0, `${def.id}/${s.id} has no label`);
      assert.ok(s.content.trim().length > 0, `${def.id}/${s.id} says nothing about its content`);
    }
    for (const r of def.rules) {
      assert.ok(r.statement.trim().length > 0, `${def.id}/${r.id} has an empty statement`);
    }
    for (const p of def.prohibitions) {
      assert.ok(p.statement.trim().length > 0, `${def.id}/${p.id} has an empty statement`);
      assert.match(p.statement, /^Do not /, `${def.id}/${p.id} is not phrased as a prohibition`);
    }
  }
});

// ---- The bounded-CLI rule: the backlog file is never opened directly --------

test("every workflow bounds backlog access to the CLI and names the file it must not open", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    assert.ok(def.boundedCli.statement.includes("forge backlog"), `${def.id} does not name the bounded interface`);
    assert.ok(def.boundedCli.forbiddenDirectAccess.length > 0, `${def.id} forbids no direct read`);
    assert.ok(
      def.boundedCli.forbiddenDirectAccess.some((p) => p.includes("BACKLOG.md")),
      `${def.id} does not forbid direct access to BACKLOG.md`,
    );
    assert.ok(def.boundedCli.drillIn.startsWith("forge backlog show"), `${def.id}'s drill-in is not the CLI`);
    assert.ok(def.boundedCli.rationale.trim().length > 0, `${def.id}'s bounded-CLI rule states no reason`);
  }
});

test("no probe reaches around the CLI — every probe is a forge or git command, and none names a backlog file", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    for (const p of def.probes) {
      assert.match(
        p.command,
        /^(forge|git) /,
        `${def.id}/${p.id} probes with '${p.command}', which is neither the forge CLI nor git`,
      );
      for (const forbidden of def.boundedCli.forbiddenDirectAccess) {
        assert.ok(
          !p.command.includes(forbidden),
          `${def.id}/${p.id} names '${forbidden}', which the bounded-CLI rule forbids reading directly`,
        );
      }
    }
  }
});

// ---- Report ordering is data, and survives into the render surface ----------

test("the report is an ORDERED list, and workflowClaims preserves that order", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const claims = workflowClaims(def);
    const reportClaimIds = claims.filter((c) => c.id.startsWith("report:")).map((c) => c.id);
    assert.deepEqual(
      reportClaimIds,
      def.report.map((s) => `report:${s.id}`),
      `${def.id}: the claim set reorders the report, so a renderer iterating claims would render out of order`,
    );
  }
});

test("workflowClaims covers every rule, prohibition, probe and report section exactly once", () => {
  for (const def of OPERATOR_WORKFLOWS) {
    const claims = workflowClaims(def);
    assertUniqueIds(claims.map((c) => c.id), `${def.id} claims`);
    for (const c of claims) {
      assert.ok(c.text.trim().length > 0, `${def.id}: claim '${c.id}' has empty text`);
    }
    const ids = new Set(claims.map((c) => c.id));
    for (const p of def.probes) assert.ok(ids.has(`probe:${p.id}`), `claim set drops probe ${p.id}`);
    for (const r of def.rules) assert.ok(ids.has(`rule:${r.id}`), `claim set drops rule ${r.id}`);
    for (const p of def.prohibitions) assert.ok(ids.has(`prohibition:${p.id}`), `claim set drops prohibition ${p.id}`);
    for (const s of def.report) assert.ok(ids.has(`report:${s.id}`), `claim set drops report section ${s.id}`);
    for (const s of def.notesBlock?.sections ?? []) {
      assert.ok(ids.has(`notes-block:section:${s.id}`), `claim set drops notes section ${s.id}`);
    }
  }
});

// ---- The notes block: shape + heredoc discipline ---------------------------

test("handoff carries the notes-block contract; orientation writes nothing", () => {
  const handoff = operatorWorkflow("handoff");
  const notes = handoff.notesBlock;
  assert.ok(notes, "handoff must carry a notes-block contract");
  assert.equal(notes.applyCommand, "forge backlog notes replace -");
  assert.ok(notes.headerLine.trim().length > 0);
  assert.ok(notes.sections.length >= 3, "the notes block is a multi-section shape, not a free paragraph");
  assertUniqueIds(notes.sections.map((s) => s.id), "notes-block sections");

  // The quoted delimiter is the whole point: an unquoted one lets the shell
  // expand backticks and `$` inside the drafted block.
  assert.ok(
    notes.heredocForm.includes(`<<'${notes.heredocDelimiter}'`),
    `the heredoc form must quote its delimiter, got: ${notes.heredocForm}`,
  );
  assert.ok(notes.heredocForm.includes(notes.applyCommand), "the heredoc form must pipe into the apply command");
  assert.ok(
    notes.heredocForm.trimEnd().endsWith(notes.heredocDelimiter),
    "the heredoc form must close with its delimiter",
  );

  // Forward-looking first, shipped last — the ordering the definition exists to fix.
  const sectionIds = notes.sections.map((s) => s.id);
  assert.ok(sectionIds.includes("shipped"), "the notes block must have a shipped punch list");
  assert.equal(sectionIds.at(-1), "shipped", "the shipped list is reference, so it goes last");
  assert.ok(sectionIds.indexOf("picked-up-next") < sectionIds.indexOf("shipped"));

  // Optional sections are declared optional, so a renderer never emits "nothing to report".
  assert.ok(
    notes.sections.some((s) => s.omitWhenEmpty === true),
    "at least one notes section must be omittable — padding empty sections is prohibited",
  );

  assert.equal(operatorWorkflow("orient").notesBlock, undefined, "orientation is a read; it applies no write");
});

// ---- Ownership marker + stamp round trip -----------------------------------

test("parseAdapterMarker round-trips the stamp renderAdapterMarker wrote", () => {
  for (const stamp of ["fg253-0001", "2026-08-09T00:00:00", "release:abc123", "gen_01HZ.9+a@b"]) {
    assert.equal(parseAdapterMarker(renderAdapterMarker(stamp)), stamp, `stamp ${stamp} did not round-trip`);
  }
});

test("a marker embedded in a real file body is still found, and carries its human notice", () => {
  const marker = renderAdapterMarker("rel-7");
  const file = `---\nname: forge-orient\n---\n\n${marker}\n\n# Orientation\n\nbody text\n`;
  assert.equal(parseAdapterMarker(file), "rel-7");
  assert.ok(isForgeOwnedAdapter(file));
  assert.ok(marker.includes(ADAPTER_MARKER_NOTICE), "the marker must tell a human the file is generated");
  assert.ok(marker.includes(ADAPTER_MARKER_VERSION), "the marker must carry its version token");
});

test("unmarked bytes parse as null — an operator's own file is never claimed as forge-owned", () => {
  for (const bytes of [
    "",
    "# my own orient command\n\ndo whatever I say\n",
    "<!-- forge:something-else v1 stamp=rel-7 -->\n",
    "<!-- forge:operator-adapter v9 stamp=rel-7 -->\n", // a future marker version is FOREIGN, not ours
    "<!-- forge:operator-adapter v1 -->\n", // marker shape without a stamp
  ]) {
    assert.equal(parseAdapterMarker(bytes), null, `bytes were wrongly claimed as forge-owned: ${bytes}`);
    assert.equal(isForgeOwnedAdapter(bytes), false);
  }
});

test("a DIFFERENT release's stamp parses as that other stamp — mismatch is detectable, not merely absent", () => {
  const installed = renderAdapterMarker("release-a");
  const running = "release-b";
  const found = parseAdapterMarker(installed);
  assert.equal(found, "release-a");
  assert.notEqual(found, running);
  assert.ok(found !== null, "a stale adapter must still be recognized as forge-owned so upgrade can refresh it");
});

test("a stamp that could escape the HTML comment is refused, never sanitized", () => {
  for (const bad of ["", " ", "has space", "line\nbreak", "ends--><script>", "-leading-dash", "a".repeat(201)]) {
    assert.equal(isValidAdapterStamp(bad), false, `${JSON.stringify(bad)} should be an invalid stamp`);
    assert.throws(() => renderAdapterMarker(bad), /invalid adapter stamp/, `renderAdapterMarker accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(ADAPTER_STAMP_PATTERN.test("ok-stamp.1"));
});

// ---- Surfaces: the generic fallback is a documented ABSENCE -----------------

test("the generic surface renders zero files and answers with the CLI", () => {
  const generic = operatorSurface("generic");
  assert.deepEqual(generic.renders, []);
  assert.ok(isDocumentedAbsence(generic));
  assert.ok(generic.operatorAnswer.includes("forge CLI"), "the generic answer must name the CLI as the interface");
  assert.ok(
    /no provider files/i.test(generic.operatorAnswer),
    "the generic answer must say forge writes no files, so the absence reads as deliberate",
  );
});

test("every orchestrator adapter has a surface, and every non-generic surface renders both workflows", () => {
  const byId = new Map(OPERATOR_SURFACES.map((s) => [s.id, s]));
  assert.equal(byId.size, OPERATOR_SURFACES.length, "duplicate surface id");
  for (const adapter of ORCHESTRATOR_ADAPTER_IDS) {
    const surface = byId.get(adapter);
    assert.ok(surface, `adapter '${adapter}' has no operator surface`);
    assert.deepEqual(
      [...surface.renders].sort(),
      [...OPERATOR_WORKFLOW_IDS].sort(),
      `adapter '${adapter}' does not render both workflows`,
    );
    assert.ok(!isDocumentedAbsence(surface));
  }
  assert.ok(byId.has("generic"), "the generic fallback must be declared");
  assert.throws(() => operatorSurface("nope" as "generic"), /no operator surface/);
});

test("no surface claims a Codex skill is verified-active", () => {
  const codex = operatorSurface("codex");
  assert.ok(
    /unverified/i.test(codex.operatorAnswer),
    "installing a file is not evidence the provider loaded it — the codex answer must say activation is unverified",
  );
});

// ---- The module stays pure -------------------------------------------------

test("definitions are shared data, and the same definition object is returned every call", () => {
  const a: OperatorWorkflowDefinition = operatorWorkflow("orient");
  const b: OperatorWorkflowDefinition = operatorWorkflow("orient");
  assert.equal(a, b);
});

// ---- The ownership inventory (FG-253, absorbing FG-347) ---------------------
//
// The requirement is "no prose without an explicit maintenance owner", and the
// only way to make that enforceable rather than aspirational is TOTALITY: a
// surface added later without an owner must fail to compile (the
// `_allSurfacesOwned` check inside the module) or fail here. So every assertion
// below iterates a PRODUCER — the renderers' own path functions, the declared
// owner set, the surface list — never a copied list of paths, which would keep
// passing after a renderer moved a file out from under its owner.

test("every file forge renders is owned by exactly one forge-generated region", () => {
  const rendered = [
    ...OPERATOR_WORKFLOW_IDS.map((id) => ({ path: claudeCommandPath(id), surface: "claude-code" as const })),
    ...OPERATOR_WORKFLOW_IDS.map((id) => ({ path: codexSkillTargetPath(id), surface: "codex" as const })),
  ];
  assert.ok(rendered.length >= 4, "the scrape below would check almost nothing");
  for (const { path, surface } of rendered) {
    const owning = regionsOwning(path);
    assert.equal(owning.length, 1, `${path} is owned by ${owning.length} regions — expected exactly one`);
    const region = owning[0]!;
    assert.equal(region.owner, "forge-generated", `${path} is rendered by forge but owned by '${region.owner}'`);
    assert.equal(region.discipline, "refuse-foreign-preserve");
    assert.ok(
      (region.surfaces as readonly string[]).includes(surface),
      `${path} is rendered for '${surface}' but its region does not claim that surface`,
    );
  }
});

test("the inventory's generated-path roots are the renderers' roots, not a copy that can drift", () => {
  const claudeRegion = regionsOwning(claudeCommandPath("orient"))[0]!;
  assert.ok(claudeRegion.path.startsWith(`${CLAUDE_COMMANDS_DIR}/`), `${claudeRegion.path} left CLAUDE_COMMANDS_DIR`);
  const codexRegion = regionsOwning(codexSkillTargetPath("orient"))[0]!;
  assert.ok(codexRegion.path.startsWith(`${CODEX_SKILLS_ROOT}/`), `${codexRegion.path} left CODEX_SKILLS_ROOT`);
});

test("every region is well-formed, and every declared owner is actually used", () => {
  const ids = OPERATOR_SURFACE_REGIONS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate region id");
  for (const r of OPERATOR_SURFACE_REGIONS) {
    assert.ok(r.path.length > 0, `${r.id}: empty path`);
    assert.ok(r.why.trim().length > 0, `${r.id}: no reason given for its owner`);
    assert.ok(r.surfaces.length > 0, `${r.id}: belongs to no surface`);
    assert.ok((REGION_OWNERS as readonly string[]).includes(r.owner), `${r.id}: undeclared owner`);
  }
  for (const owner of REGION_OWNERS) {
    assert.ok(
      OPERATOR_SURFACE_REGIONS.some((r) => r.owner === owner),
      `no region is owned by '${owner}' — an owner class nothing uses is a class that does not exist`,
    );
  }
});

test("every provider surface has at least one owned region", () => {
  for (const surface of OPERATOR_SURFACES) {
    assert.ok(
      regionsForSurface(surface.id).length > 0,
      `surface '${surface.id}' has no ownership region — its prose has no owner`,
    );
    // A surface that renders files must own them; one that renders nothing must
    // own no generated region, or the documented absence is not an absence.
    const generated = regionsForSurface(surface.id).filter((r) => r.owner === "forge-generated");
    assert.equal(
      generated.length > 0,
      !isDocumentedAbsence(surface),
      `surface '${surface.id}': generated regions and rendered files disagree`,
    );
  }
});

test("a mixed file is labelled region-by-region — the two halves partition it", () => {
  const byPath = new Map<string, SurfaceRegion[]>();
  for (const r of OPERATOR_SURFACE_REGIONS as readonly SurfaceRegion[]) {
    byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  }
  let mixed = 0;
  for (const [path, regions] of byPath) {
    if (regions.length === 1) {
      assert.equal(regions[0]!.scope, "whole-file", `${path} has one region, so it must claim the whole file`);
      continue;
    }
    mixed++;
    assert.deepEqual(
      regions.map((r) => r.scope).sort(),
      ["forge-region", "outside-forge-region"],
      `${path} is split into ${regions.length} regions that do not partition it into forge's part and the rest`,
    );
    for (const r of regions) {
      assert.ok(r.regionLabel && r.regionLabel.trim().length > 0, `${r.id}: a partial region must name its part`);
    }
  }
  assert.ok(mixed >= 1, "no mixed file is inventoried — CLAUDE.md is one, so this test has lost its subject");
  // CLAUDE.md by name: it is the file FG-347 was opened about, and an inventory
  // that labelled it with one owner would not have answered the ticket.
  const claudeMd = regionsOwning("CLAUDE.md");
  assert.equal(claudeMd.length, 2, "CLAUDE.md must be inventoried as two regions, not one file");
  const block = claudeMd.find((r) => r.owner === "forge-generated");
  const prose = claudeMd.find((r) => r.owner === "orchestrator");
  assert.ok(block && prose, "CLAUDE.md needs a forge-generated block region AND an orchestrator-owned region");
  // The two Forge disciplines are NOT the same refusal, and the inventory says so.
  assert.equal(block.discipline, "deterministic-re-render");
  assert.equal(regionsOwning(claudeCommandPath("orient"))[0]!.discipline, "refuse-foreign-preserve");
});

test("the maintained-prose document is owned by the documentation-maintainer, and the link is one place", () => {
  const owning = regionsOwning(MAINTAINED_PROSE.path);
  assert.equal(owning.length, 1, `${MAINTAINED_PROSE.path} is owned by ${owning.length} regions`);
  assert.equal(owning[0]!.owner, "documentation-maintainer");
  assert.equal(owning[0]!.owner, MAINTAINED_PROSE.owner, "the link's declared owner and the inventory disagree");
  // Both workflows carry the SAME link object — two copies could drift apart, and
  // the renderers derive the path from here rather than hardcoding it.
  for (const def of OPERATOR_WORKFLOWS) assert.equal(def.maintainedProse, MAINTAINED_PROSE);
  assert.ok(MAINTAINED_PROSE.statement.includes(MAINTAINED_PROSE.path), "the rendered sentence must name the path");
});

test("operator-owned surfaces are external, including a skill dir forge knows nothing about", () => {
  for (const path of ["AGENTS.md", ".agents/skills/somebody-elses/SKILL.md", ".codex/prompts/orient.md"]) {
    const owning = regionsOwning(path);
    assert.equal(owning.length, 1, `${path} is owned by ${owning.length} regions`);
    assert.equal(owning[0]!.owner, "external", `${path} must be operator-owned`);
    assert.equal(owning[0]!.discipline, "byte-untouched");
  }
  // The exclusion is what keeps the two apart: forge's own skill dir sits under
  // the same parent and is NOT external.
  assert.equal(regionsOwning(codexSkillTargetPath("orient"))[0]!.owner, "forge-generated");
});

test("an unowned path is reported as unowned rather than defaulted to somebody", () => {
  assert.deepEqual(regionsOwning("src/v2/operator-workflows.ts"), []);
});
