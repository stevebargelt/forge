import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOrchestratorBlock, renderOrchestratorTemplate } from "./init.js";

// FG-563: Seed -> generated CLAUDE.md orchestrator-block parity is TESTED, not
// assumed. This locks the invariant that the committed CLAUDE.md orchestrator
// block is byte-for-byte what the REAL installer (applyOrchestratorBlock) would
// render from the current seed. It catches both directions of drift:
//   (a) a seeds/orchestrator-template.md edit not propagated into CLAUDE.md, and
//   (b) a hand-edit to the CLAUDE.md block that diverged from the seed.
// Pure string function over two real repo files — stays in the fast unit tier.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const seedPath = resolve(repoRoot, "seeds", "orchestrator-template.md");
const claudeMdPath = resolve(repoRoot, "CLAUDE.md");
const constraintPath = resolve(repoRoot, "seeds", "constraints", "no-ai-attribution.md");

/** The double-quoted provider names inside `clause` (a single sentence/bullet). */
function quotedProviders(text: string, clause: RegExp, what: string): string[] {
  const m = text.match(clause);
  assert.ok(m?.[1], `could not locate the ${what} bare-mention clause`);
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1] ?? "");
  assert.ok(names.length > 0, `no quoted provider names in the ${what} clause`);
  return names.sort();
}

test("committed CLAUDE.md orchestrator block is in parity with the seed (no drift)", () => {
  // FG-799: the seed now carries ai_attribution block-conditionals; the committed
  // CLAUDE.md is the RENDERED block, and this forge repo stays `suppress`. Render
  // the template the same way the installer does before comparing.
  const seed = renderOrchestratorTemplate(readFileSync(seedPath, "utf8"), "suppress");
  const claudeMd = readFileSync(claudeMdPath, "utf8");

  const result = applyOrchestratorBlock(claudeMd, seed);

  assert.equal(
    result.action,
    "unchanged",
    `CLAUDE.md orchestrator block has drifted from seeds/orchestrator-template.md ` +
      `(installer would '${result.action}' it). Re-render the block via the forge-dev ` +
      `upgrade path so the committed CLAUDE.md matches the current seed, then re-run this test.`,
  );
});

// FG-799 (RF-2): the suppress bullet's bare-mention prohibition and the injected
// no-ai-attribution constraint's bare-mention rule enforce the SAME commit text, so
// their provider lists must not drift. The old test locked only the trailer set; this
// derives BOTH bare-mention lists and pins them equal — an orchestrator can no longer be
// told to omit a provider (Gemini/Copilot) that the constraint and hook still reject.
test("suppress bare-mention provider set matches the no-ai-attribution constraint (RF-2)", () => {
  const suppressBlock = renderOrchestratorTemplate(readFileSync(seedPath, "utf8"), "suppress");
  const constraint = readFileSync(constraintPath, "utf8");

  const templateProviders = quotedProviders(
    suppressBlock,
    /No mentioning (.*?) in commit messages/,
    "orchestrator suppress bullet",
  );
  const constraintProviders = quotedProviders(
    constraint,
    /Do not mention (.*?)\*\* in commit messages/,
    "no-ai-attribution constraint",
  );

  assert.deepEqual(
    templateProviders,
    constraintProviders,
    "the suppress bullet must prohibit exactly the constraint's bare-mention provider set",
  );
  for (const provider of ["Gemini", "Copilot"]) {
    assert.ok(templateProviders.includes(provider), `suppress bare-mention set must include ${provider} (RF-2)`);
  }
});
