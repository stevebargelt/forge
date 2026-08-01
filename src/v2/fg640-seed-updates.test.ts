// FG-640: the SEED half of the cutover.
//
// The gate and the workflow migration are only half of Change 3. The other half is that the
// agents themselves are told what changed — a red whose seed still reads as if its verdict
// blocks will keep writing verdicts optimized for blocking rather than findings optimized for a
// ledger, and a shipping reviewer with no docs/closeout duty will keep omitting the field the
// eighth check now requires. Seeds drift silently, so each claim is asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RISK_LENSES } from "./review-contract.js";
import { deprecationNote } from "../cli/commands/review-loop.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seed = (p: string) => readFileSync(resolve(repoRoot, "seeds", p), "utf8");

/** FG-654: the Forge-owned protocol moved OUT of the operator-authored agent seed and
 *  into its own generation-published file. The contract a dispatched agent receives is
 *  both halves, in compose order, so that is the unit these assertions read. */
const roleContract = (role: string) =>
  `${seed(`agent-protocols/${role}.md`)}\n\n${seed(`agents/${role}/CLAUDE.md`)}`;

for (const lens of RISK_LENSES) {
  test(`FG-640: the red-${lens} seed says its verdict is EVIDENCE, not authority`, () => {
    const t = roleContract(`red-${lens}`);
    assert.match(t, /your verdict is EVIDENCE, not authority/i);
    assert.match(t, /gate_on_verdict.*false|`gate_on_verdict: false`/);
    assert.match(t, /disposition/i, "must say its findings go through disposition");
  });

  test(`FG-640: the red-${lens} seed carries the discovery fields, and its own lens name`, () => {
    const t = roleContract(`red-${lens}`);
    for (const field of ["risk_lens", "reachability", "challenges_contract", "remediation_advice"]) {
      assert.match(t, new RegExp(`\`${field}\``), `red-${lens} never names the '${field}' discovery field`);
    }
    assert.match(t, new RegExp(`\`risk_lens\`: \`${lens}\``), `red-${lens} must name ITS OWN lens, not the whole vocabulary`);
    // The reachability rule matters because it sets the bar for closing the finding.
    assert.match(t, /demonstrated/);
    assert.match(t, /model re-inspection will never close it|never close it/i);
  });

  test(`FG-640: the red-${lens} seed still forbids a synthesized or empty result`, () => {
    const t = roleContract(`red-${lens}`);
    assert.match(t, /empty or synthesized result/i);
  });
}

test("FG-640: the shipping-reviewer seed enumerates all six duties and the docs_closeout field", () => {
  const t = roleContract("shipping-reviewer");
  assert.match(t, /## Your six duties \(FG-640\)/);
  for (const duty of [
    /AC → evidence mapping/,
    /Verification presence/,
    /Ledger settlement/,
    /Identity continuity/,
    /Contract coverage/,
    /Ticket-required docs and closeout gaps/,
  ]) {
    assert.match(t, duty, `the shipping-reviewer seed is missing a duty: ${duty}`);
  }
  assert.match(t, /"docs_closeout"/, "the output contract must carry the docs_closeout field the eighth check reads");
  assert.match(t, /`assessed: false`.*is NOT the clean answer/is);
  assert.match(t, /Late findings carry no special authority/i);
  assert.match(t, /clean finding ledger is not evidence that the\s+work was done/i);
});

test("FG-640: the engineer (fixer) seed carries the batch-remediation rules", () => {
  const t = roleContract("engineer");
  assert.match(t, /## Batch remediation — when you are the review fixer \(FG-640\)/);
  assert.match(t, /An omission is never read\s*\n?\s*as a resolution|omission is never read as a resolution/i);
  assert.match(t, /scope_change/);
  assert.match(t, /immutable at its revision|new revision/i);
  assert.match(t, /re-checked by a dedicated rechecker|verified by a dedicated rechecker|rechecker/i);
});

test("FG-640: the forge-review-loop skill is deprecated in favour of `forge review`", () => {
  const t = seed("skills/forge-review-loop/SKILL.md");
  assert.match(t, /^description: DEPRECATED \(FG-640\)/m, "the frontmatter description is what an agent sees first");
  assert.match(t, /DEPRECATED \(FG-640\) — use `forge review`/);
  assert.match(t, /forge review start <ticket-id> --contract/);
  assert.match(t, /`--max-rounds` keeps its existing semantics until removal/);
  assert.match(t, /keeps no ledger|not a durable finding ledger|never a durable finding ledger/i);
});

test("FG-640: the review-loop CLI's deprecation note names forge review and preserves --max-rounds", () => {
  // The note is the operator-facing half of the same claim the skill makes — asserted against
  // the exported string so the CLI cannot drift from the doc that describes it.
  const note = deprecationNote();
  assert.match(note, /DEPRECATED \(FG-640\)/);
  assert.match(note, /forge review start/);
  assert.match(note, /forge review continue/);
  assert.match(note, /--max-rounds keeps its existing semantics/);
  assert.match(note, /stop reason is never the completion signal/);
});
