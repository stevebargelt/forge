// FG-640: the acceptance criteria name seven PRD scenarios; this proves each one is an
// EXECUTING test, by name, and keeps the mapping from rotting.
//
// "PRD scenarios as tests" is the ticket's first acceptance criterion, and it is the one kind of
// claim a normal suite cannot make about itself: every individual scenario test can pass while a
// scenario nobody wrote is quietly absent, and a scenario test that is renamed or deleted takes
// its own evidence with it. So the mapping is derived from the tree rather than asserted in a
// comment — the same discipline fg640-fg541-evidence-mapping.test.ts applies to the FG-541 table.
//
// What this guards, precisely: for each required scenario there is at least one `test(...)` title
// in the repo that names BOTH FG-640 and that scenario number. It is a coverage guard, not a
// correctness guard — the tests it points at are what prove the behavior. Its value is that
// deleting one of them turns a silent gap into a red test naming the missing scenario.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = resolve(repoRoot, "src");

/** The seven scenarios FG-640's acceptance criteria enumerate, with what each one is FOR — so a
 *  reader who lands here from a failure knows what has to be written, not only that something is. */
const REQUIRED: Array<{ scenario: number; what: string }> = [
  { scenario: 16, what: "`feature` selects only the contract's declared risk lenses" },
  { scenario: 17, what: "shipping review cannot pass with an unmet/unproven AC even on a clean ledger" },
  { scenario: 18, what: "clean ledger + green verification + trusted-tip equality advances without --force" },
  { scenario: 21, what: "one crashed selected lens keeps the gate blocked — no reviewer authored an outcome" },
  { scenario: 22, what: "an authored inconclusive completes discovery and must be dispositioned; a synthesized one does not" },
  { scenario: 23, what: "drift beyond the approved lenses needs contract confirmation/amendment, never path-guessing" },
  { scenario: 27, what: "a lens may be added with evidence; removing one or changing the threat model returns to the approving authority" },
];

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      testFiles(full, out);
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `test("…")` title in the tree, with the file it lives in. Reads the source rather than a
 *  runner's output on purpose: this must be true of the REPOSITORY, not of one invocation's
 *  filtered selection. */
function testTitles(): Array<{ file: string; title: string }> {
  const out: Array<{ file: string; title: string }> = [];
  for (const file of testFiles(srcRoot)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*test\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)")/gm)) {
      out.push({ file: relative(repoRoot, file), title: (m[1] ?? m[2] ?? "").replace(/\\"/g, '"') });
    }
  }
  return out;
}

const TITLES = testTitles();

test("FG-640: the scenario-coverage guard is reading a real tree", () => {
  assert.ok(TITLES.length > 500, `only ${TITLES.length} test titles found — the walker is not seeing the suite`);
  assert.ok(
    TITLES.some((t) => t.file === "src/v2/fg640-gate-wiring.test.ts"),
    "the FG-640 wiring suite must be among the files scanned",
  );
});

for (const { scenario, what } of REQUIRED) {
  test(`FG-640 AC: PRD #${scenario} is an executing test — ${what}`, () => {
    const pattern = new RegExp(`#${scenario}\\b`);
    const matches = TITLES.filter((t) => /FG-640/.test(t.title) && pattern.test(t.title));
    assert.ok(
      matches.length > 0,
      `no FG-640 test names PRD #${scenario} (${what}). Every scenario in the acceptance criteria has to be ` +
        `a test that runs, not a claim in a commit message.`,
    );
  });
}

test("FG-640: PRD #22 is covered on BOTH halves — authored counts, synthesized does not", () => {
  // The one scenario whose two halves can be written independently, and whose second half is the
  // one an incomplete implementation passes: `complete: false, reason: "synthesized"` must not
  // read as a completed outcome. A file that only tested the authored half would satisfy the
  // per-scenario guard above while leaving the dangerous half unproven.
  const relevant = TITLES.filter((t) => /FG-640/.test(t.title) && /#22\b/.test(t.title));
  assert.ok(
    relevant.some((t) => /authored/i.test(t.title)),
    `no FG-640 #22 test names the AUTHORED half; got ${JSON.stringify(relevant.map((t) => t.title))}`,
  );
  assert.ok(
    relevant.some((t) => /synthesi[sz]ed/i.test(t.title)),
    `no FG-640 #22 test names the SYNTHESIZED half; got ${JSON.stringify(relevant.map((t) => t.title))}`,
  );
});
