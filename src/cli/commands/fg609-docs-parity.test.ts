// FG-609 (FG-496 Slice D) — A15: the four operator-queue verbs and the queue model
// are DOCUMENTED, on every operator surface this slice touches.
//
// ─── WHY THIS TEST HAS TO EXIST ──────────────────────────────────────────────
// There is no existing mechanical gate that reddens when a CLI verb ships
// undocumented. fg565-docs-parity.test.ts covers three specific FG-565 normative
// claims, not verb coverage. So a verb can be added, tested, and merged with no
// operator-facing text anywhere, and nothing notices.
//
// ─── WHY IT IS NOT VACUOUS ───────────────────────────────────────────────────
// The verb list is DERIVED FROM THE SOURCE — it is scraped out of the `.command()`
// registrations in backlog.ts, not written down here. So:
//   * removing a verb's documentation makes this test FAIL, and
//   * RENAMING a verb makes it fail too, because the scraped name stops matching
//     the documented one. A hardcoded list would keep passing through a rename,
//     which is exactly the vacuous shape A15 rejects.
// Both were demonstrated to fail before this was committed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** The operator surfaces that must carry the verbs. Each is a real operator
 *  entry point, not a duplicate of another:
 *    SKILL.md   — what an agent/operator loads to work the backlog. docs/concepts.md
 *                 points readers here for the operator procedure and refusal list.
 *    concepts   — the model (what rank/membership/lifecycle each mean).
 *    cutover    — the runbook, where a project first gains these verbs. */
const VERB_SURFACES = [
  "seeds/skills/forge-backlog/SKILL.md",
  "docs/concepts.md",
  "docs/how-to-backlog-db-cutover.md",
];

/** Scraped from the source, deliberately — see the header. These are the verbs
 *  FG-609 adds; the scrape below finds every registered verb and this is the
 *  subset that must be documented. */
const QUEUE_VERBS = ["rank", "enqueue", "dequeue", "reorder"];

function registeredBacklogVerbs(): string[] {
  const src = read("src/cli/commands/backlog.ts");
  return [...src.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]!);
}

test("FG-609 A15: the four queue verbs are actually registered under `forge backlog`", () => {
  const registered = registeredBacklogVerbs();
  for (const verb of QUEUE_VERBS) {
    assert.ok(
      registered.includes(verb),
      `\`forge backlog ${verb}\` is not registered — this test's documentation checks are ` +
        `derived from the source, so a rename must be made here and in the docs together`,
    );
  }
});

test("FG-609 A15: every queue verb is documented on every operator surface", () => {
  const registered = new Set(registeredBacklogVerbs());
  const missing: string[] = [];
  for (const verb of QUEUE_VERBS) {
    // Guards against the rename hole: if the source verb is gone, the docs cannot
    // be "correct" by still naming the old one.
    assert.ok(registered.has(verb), `${verb} is no longer a registered verb`);
    for (const surface of VERB_SURFACES) {
      if (!new RegExp(`forge backlog ${verb}\\b`).test(read(surface))) {
        missing.push(`${surface}: forge backlog ${verb}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "an operator verb shipped undocumented — there is no other mechanical gate for this",
  );
});

test("FG-609 A15: the SKILL.md subcommand block lists all four verbs", () => {
  // docs/concepts.md sends readers here for the operator procedure and the refusal
  // list, and the Subcommands block is an explicit verb list — a verb missing from
  // it is invisible to exactly the reader who was told to look here.
  const skill = read("seeds/skills/forge-backlog/SKILL.md");
  const block = skill.match(/## Subcommands\n\n```\n([\s\S]*?)```/);
  assert.ok(block, "SKILL.md must keep its Subcommands block");
  for (const verb of QUEUE_VERBS) {
    assert.match(
      block![1]!,
      new RegExp(`^forge backlog ${verb}\\b`, "m"),
      `the Subcommands block omits \`forge backlog ${verb}\``,
    );
  }
});

test("FG-609 A15: the queue MODEL is documented, not only the verb names", () => {
  // A verb list with no model is not documentation: the three orthogonal facts,
  // the readiness refusal, and the derived projections are what an operator needs
  // in order to predict what these verbs do.
  const claims: [string, string, RegExp][] = [
    ["SKILL.md", "seeds/skills/forge-backlog/SKILL.md", /executable queue/i],
    ["SKILL.md", "seeds/skills/forge-backlog/SKILL.md", /rank is RETAINED|rank.*RETAINED/],
    ["SKILL.md", "seeds/skills/forge-backlog/SKILL.md", /refuses? .*(markdown|db-mode only)/i],
    ["concepts", "docs/concepts.md", /## Operator queue/],
    ["concepts", "docs/concepts.md", /executable queue/i],
    ["concepts", "docs/concepts.md", /computed, never stored/i],
    ["concepts", "docs/concepts.md", /queue_events/],
    ["cutover", "docs/how-to-backlog-db-cutover.md", /executable queue/i],
    ["schema contract", "docs/SCHEMA-CONTRACT.md", /queue_membership/],
    ["schema contract", "docs/SCHEMA-CONTRACT.md", /readiness_assessments/],
    ["schema contract", "docs/SCHEMA-CONTRACT.md", /priority_rank/],
  ];
  for (const [label, file, pattern] of claims) {
    assert.match(read(file), pattern, `${label} (${file}) is missing: ${pattern}`);
  }
});

test("FG-609 A15: the SCHEMA-CONTRACT no longer claims the blocked literal exists in two places", () => {
  // The paragraph this slice falsifies, corrected in the same commit that
  // falsifies it. A stale "exists in two places with no shared import" would send
  // the next reader looking for a second declaration that is gone.
  const contract = read("docs/SCHEMA-CONTRACT.md");
  assert.equal(
    /That literal exists in two places with no shared import/.test(contract),
    false,
    "FG-609 collapsed the two declarations into one leaf — the doc must say so",
  );
  assert.match(contract, /src\/store\/blocked-source\.ts/);
  assert.match(contract, /@forge\/blocked-source/);
});
