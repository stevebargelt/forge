// FG-640: the orchestrator's operating policy IS the evidence-led review — on BOTH surfaces.
//
// `orchestrator-block-parity.test.ts` already proves the rendered CLAUDE.md block is byte-equal
// to what the installer would render from the seed. That catches drift BETWEEN the two; it says
// nothing about what they say. This file pins the content, because the interim Change 0 policy
// was explicitly temporary and "temporary" text is exactly what survives its own retirement:
// a future edit that reinstates the repeated-loop default, or that quietly re-documents
// `review-loop` as the transport, reddens here on whichever surface it touched.
//
// The fg565-style discipline is that both files are asserted independently, not one via the
// other — so a change that edits only CLAUDE.md fails on the seed, and vice versa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SURFACES = [
  { name: "seeds/orchestrator-template.md", text: readFileSync(resolve(repoRoot, "seeds", "orchestrator-template.md"), "utf8") },
  { name: "CLAUDE.md (rendered block)", text: readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8") },
];

for (const surface of SURFACES) {
  test(`FG-640: ${surface.name} states the evidence-led review is the DEFAULT, not an interim policy`, () => {
    const t = surface.text;
    assert.match(t, /### Reviewing implemented work — the evidence-led review \(the DEFAULT\)/);
    assert.match(t, /standing policy for landed implementation work, not an interim one/i);
    assert.match(t, /Change 0 operating policy that stood here is RETIRED/i);
  });

  test(`FG-640: ${surface.name} carries no live "interim"/Change 0 policy framing`, () => {
    // The one legal mention is the sentence that RETIRES it. Anything else is the old policy
    // still describing itself as in force.
    const t = surface.text;
    const stale = t
      .split("\n")
      .filter((l) => /interim evidence-led|Change 0(,| ) below|in force until|Change 0 is NOT retired/i.test(l))
      .filter((l) => !/is RETIRED/i.test(l));
    assert.deepEqual(stale, [], `stale interim-policy framing survives in ${surface.name}`);
  });

  test(`FG-640: ${surface.name} documents \`forge review\` as the transport and DEPRECATES review-loop`, () => {
    const t = surface.text;
    assert.match(t, /forge review start <ticket-id> --contract/);
    assert.match(t, /forge review continue <review-id>/);
    assert.match(t, /`forge review-loop` is DEPRECATED \(FG-640\) and is no longer the documented default/);
    assert.match(t, /retains its old `--max-rounds` semantics|keeps its existing semantics|retains its old `--max-rounds`/);
  });

  test(`FG-640: ${surface.name} names the review_disposition gate, its conditions, and that --force is not the path`, () => {
    const t = surface.text;
    assert.match(t, /`review_disposition` gate/);
    // Every blocking condition the ticket enumerates has to be readable here by name, or the
    // orchestrator cannot tell an operator WHY a gate is withholding.
    for (const id of [
      "lens_outcome_missing",
      "finding_untriaged",
      "architecture_question_open",
      "rejected_premise_unproven",
      "fix_now_unresolved",
      "fix_now_evidence_insufficient",
      "verification_absent_or_red",
      "acceptance_unmet",
      "tip_not_trusted",
      "review_absent",
      "mixed_authority_model",
      "contract_unreadable",
      "review_mode_drift",
    ]) {
      assert.match(t, new RegExp(`\`${id}\``), `${surface.name} never names the '${id}' gate condition`);
    }
    assert.match(t, /it is not the ordinary settlement path/i);
    assert.match(t, /there is no new task status|no new task status/i);
  });

  test(`FG-640: ${surface.name} states the explicit non-blocking half — advisory reds and settled dispositions`, () => {
    const t = surface.text;
    assert.match(t, /does NOT block on: a raw advisory red `fail` whose findings are dispositioned/);
    assert.match(t, /settled `accepted_risk` \/ `deferred` \/ `rejected_premise` \/ `duplicate`/);
    assert.match(t, /superseded sha/i);
  });

  test(`FG-640: ${surface.name} keeps the evidence rules that outlive the interim policy`, () => {
    // These four survived Change 0's retirement because they were never interim — they are the
    // lifecycle's actual content. A rewrite that drops one has lost the point of the rewrite.
    const t = surface.text;
    assert.match(t, /Absence from a later reviewer's output is NEVER resolution/i);
    assert.match(t, /never synthesize a pass|Never synthesize a pass/);
    assert.match(t, /skipped test is never evidence|A skipped test is never evidence|never evidence: a resolution/i);
    assert.match(t, /one review_mode settles a run|one run, one authority model|Exactly one review_mode settles a run/i);
  });
}
