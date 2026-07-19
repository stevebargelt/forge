import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOrchestratorBlock } from "./init.js";

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

test("committed CLAUDE.md orchestrator block is in parity with the seed (no drift)", () => {
  const seed = readFileSync(seedPath, "utf8");
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
