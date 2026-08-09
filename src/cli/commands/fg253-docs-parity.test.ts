// FG-253 step 11 — the rendered operator-adapter surface is DOCUMENTED, and the
// documentation names only paths Forge actually installs.
//
// ─── WHY THIS TEST HAS TO EXIST ──────────────────────────────────────────────
// `/orient` and `/handoff` are defined once as provider-neutral data
// (src/v2/operator-workflows.ts) and rendered onto two provider surfaces
// (src/v2/render-claude-commands.ts, src/v2/render-codex-skills.ts). None of
// that guarantees an operator can find the rendered files on disk, or that a
// Codex skill's activation claim stays honest: a renamed skill directory, a
// moved Claude command path, or a doc edit that quietly upgrades "unverified"
// to "verified" would all leave docs/concepts.md, docs/quick-start.md and
// docs/how-to-orchestrator-launcher.md describing a surface that no longer
// matches — which is worse than no docs, because a reader trusts them.
//
// ─── WHY IT IS NOT VACUOUS ───────────────────────────────────────────────────
// Every expected path/name below is derived from the renderer EXPORTS —
// claudeCommandPath, codexSkillName, codexSkillTargetPath — never a hardcoded
// list copied by hand. A hardcoded list would keep passing after a renderer
// moved a target; scraping the real producer is what makes a rename fail here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATOR_WORKFLOW_IDS, isDocumentedAbsence, operatorSurface } from "../../v2/operator-workflows.js";
import { CLAUDE_COMMANDS_DIR, claudeCommandPath } from "../../v2/render-claude-commands.js";
import { codexSkillName, codexSkillTargetPath } from "../../v2/render-codex-skills.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

const CONCEPTS = "docs/concepts.md";
const QUICK_START = "docs/quick-start.md";
const LAUNCHER = "docs/how-to-orchestrator-launcher.md";
const UPGRADE = "docs/how-to-upgrade.md";

const DOC_PATHS = [CONCEPTS, QUICK_START, LAUNCHER, UPGRADE] as const;
const docs = new Map<string, string>(DOC_PATHS.map((p) => [p, read(p)]));

function doc(path: string): string {
  const text = docs.get(path);
  assert.ok(text !== undefined, `never read ${path}`);
  return text!;
}

test("FG-253: OPERATOR_WORKFLOW_IDS is non-empty (guards a silently-vacuous scrape)", () => {
  assert.ok(OPERATOR_WORKFLOW_IDS.length >= 2, `only ${OPERATOR_WORKFLOW_IDS.length} operator workflow(s) — the scrape below would check almost nothing`);
});

// ─── every rendered Claude command path is named where it matters ────────────

test("FG-253: every Claude command path forge renders is named in concepts.md and quick-start.md", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const path = claudeCommandPath(id);
    for (const d of [CONCEPTS, QUICK_START]) {
      assert.ok(
        doc(d).includes(path),
        `${d} never names ${path} (rendered by render-claude-commands.ts for workflow '${id}')`,
      );
    }
  }
});

// ─── every rendered Codex skill path AND name is named where it matters ──────

test("FG-253: every Codex skill this release renders is named by path in concepts.md, and by name in concepts.md + the launcher doc", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    const path = codexSkillTargetPath(id);
    const name = codexSkillName(id);
    assert.ok(
      doc(CONCEPTS).includes(path),
      `${CONCEPTS} never names ${path} (rendered by render-codex-skills.ts for workflow '${id}')`,
    );
    for (const d of [CONCEPTS, LAUNCHER]) {
      assert.ok(doc(d).includes(name), `${d} never names the Codex skill '${name}'`);
    }
  }
});

// ─── reverse direction: no doc names an adapter path forge does not install ──

test("FG-253: no doc names a `.claude/commands/*.md` or `.agents/skills/*/SKILL.md` path forge does not actually render", () => {
  const validClaudePaths = new Set(OPERATOR_WORKFLOW_IDS.map(claudeCommandPath));
  const validCodexPaths = new Set(OPERATOR_WORKFLOW_IDS.map(codexSkillTargetPath));
  const bogus: string[] = [];
  for (const d of DOC_PATHS) {
    const text = doc(d);
    for (const m of text.matchAll(/\.claude\/commands\/[a-zA-Z0-9_-]+\.md/g)) {
      if (!validClaudePaths.has(m[0])) bogus.push(`${d}: ${m[0]}`);
    }
    for (const m of text.matchAll(/\.agents\/skills\/[a-zA-Z0-9_-]+\/SKILL\.md/g)) {
      if (!validCodexPaths.has(m[0])) bogus.push(`${d}: ${m[0]}`);
    }
  }
  assert.deepEqual(bogus, [], `doc(s) name an adapter path forge does not render: ${bogus.join(", ")}`);
});

// ─── CLAUDE_COMMANDS_DIR is the root every doc's Claude command paths sit under ──

test("FG-253: every Claude command path named in the docs sits under the real CLAUDE_COMMANDS_DIR", () => {
  for (const id of OPERATOR_WORKFLOW_IDS) {
    assert.ok(claudeCommandPath(id).startsWith(`${CLAUDE_COMMANDS_DIR}/`), `claudeCommandPath('${id}') moved out from under CLAUDE_COMMANDS_DIR — update this test's premise deliberately`);
  }
});

// ─── the generic-fallback surface is a documented ABSENCE, and the docs say so ──

test("FG-253: the generic-fallback surface renders nothing, and concepts.md says Forge writes no files for it", () => {
  const generic = operatorSurface("generic");
  assert.ok(
    isDocumentedAbsence(generic),
    "operator-workflows.ts no longer defines 'generic' as a documented absence — this test's premise moved",
  );
  assert.match(
    doc(CONCEPTS),
    /writes\s*\*{0,2}no files\*{0,2}/i,
    `${CONCEPTS} does not say Forge writes no files for the generic-fallback surface`,
  );
});

// ─── Codex activation is never claimed as verified, anywhere it is discussed ──

function assertActivationAlwaysUnverified(path: string): void {
  const text = doc(path);
  const idxs = [...text.matchAll(/activation/gi)].map((m) => m.index!);
  assert.ok(idxs.length > 0, `${path} never mentions activation at all — the Codex activation-unverified claim is missing`);
  for (const i of idxs) {
    const window = text.slice(Math.max(0, i - 200), i + 200);
    assert.match(
      window,
      /unverified|not evidence|no positive (probe|evidence)|never claimed|doesn'?t happen|does not happen/i,
      `${path}: an "activation" mention near offset ${i} is not qualified as unverified — nearby text: ${JSON.stringify(window)}`,
    );
  }
}

test("FG-253: docs/concepts.md never claims Codex skill activation is verified", () => {
  assertActivationAlwaysUnverified(CONCEPTS);
});

test("FG-253: docs/how-to-orchestrator-launcher.md never claims Codex skill activation is verified", () => {
  assertActivationAlwaysUnverified(LAUNCHER);
});

// ─── FG-347 is named as DEFERRED, not answered, with the specific scope stated ──

test("FG-253 step 11: the launcher doc states FG-347 is deferred (not answered) and names what stays untouched", () => {
  const text = doc(LAUNCHER);
  const at = text.indexOf("FG-347");
  assert.ok(at >= 0, `${LAUNCHER} never names FG-347`);
  const window = text.slice(Math.max(0, at - 400), at + 900);
  assert.match(window, /deferred/i, "the FG-347 mention is not described as deferred");
  assert.match(window, /AGENTS\.md/, "the FG-347 mention does not name AGENTS.md staying untouched");
  assert.match(window, /marker discipline/i, "the FG-347 mention does not say no marker discipline is introduced");
  assert.match(window, /documentation-maintainer/i, "the FG-347 mention does not name the documentation-maintainer's correction path");
});

// ─── docs/how-to-upgrade.md names the whole-adapter-set --json fields ─────────

test("FG-253 step 5 docs impact: how-to-upgrade.md documents adapterSurfaces and adapterOverrides on --json", () => {
  const text = doc(UPGRADE);
  assert.match(text, /adapterSurfaces/, `${UPGRADE} never mentions the adapterSurfaces --json field`);
  assert.match(text, /adapterOverrides/, `${UPGRADE} never mentions the adapterOverrides --json field`);
});
