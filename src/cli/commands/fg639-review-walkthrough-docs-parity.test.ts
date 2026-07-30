import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// FG-639 / RF-5: docs-parity for the review-coordinator walkthrough's comparison-base claims.
//
// The defect this guards: concepts.md showed `forge review start FG-700 --contract
// contract.json` running verification, confirming the contract, dispatching the lens reds and
// stopping at await_disposition — while the same section, a few paragraphs earlier, stated
// that "a review that records no base sha refuses here" and the implementation recorded a base
// sha only from `--since`. The worked example could not occur: it dead-ended at Stage 2. An
// operator following the pilot's primary entry point was told it works when it did not.
//
// Prose alone is not what makes that true again, which is why this test exists rather than a
// prose fix alone: the claim's reachability is `demonstrated`, so it needs `regression_test`
// evidence. Same discipline as fg565-docs-parity.test.ts (which guards the prose docs against
// the seed) — but this file holds the PROSE against the SHIPPED CODE, since here the two
// sources that must agree are docs/concepts.md and the command it documents.
//
// RED baseline (falsifiable, and it is the pre-fix tree): restore the FG-639-era walkthrough —
// a `forge review start` example with no `--since` and no resolved `base sha:` line, advancing
// through confirm_contract to the disposition stop — and TRANSCRIPTS_NAME_THEIR_BASE fails.
// Delete base-sha inference from resolveReviewBase and SOURCE_PARITY fails. Neither redden by
// coincidence: each names the exact source it read.
//
// Pure string functions over four real repo files — stays in the fast unit tier.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const CONCEPTS = resolve(repoRoot, "docs", "concepts.md");
const REVIEW_CMD = resolve(repoRoot, "src", "cli", "commands", "review.ts");
const REVIEW_WIRING = resolve(repoRoot, "src", "cli", "commands", "review-wiring.ts");
const REVIEW_RUN = resolve(repoRoot, "src", "v2", "review-run.ts");

/** Whitespace-normalized, lowercased, with markdown emphasis and code ticks stripped — so a
 *  claim survives reflow and re-emphasis and only a genuine wording change flips a predicate. */
function normalize(text: string): string {
  return text.replace(/[*`]/g, "").replace(/\s+/g, " ").toLowerCase();
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The fenced blocks of a markdown file, verbatim. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string);
}

// A transcript that shows the coordinator getting PAST contract confirmation is a claim that
// the review had a comparison base — Stage 2 computes the final implementation diff from it
// and refuses outright without one. So the same transcript has to show the base it resolved.
test("FG-639 / RF-5: every review-start transcript that advances past confirm_contract names the base sha it resolved", () => {
  const blocks = fencedBlocks(read(CONCEPTS)).filter((b) => /confirm_contract|await_disposition/.test(b));

  assert.ok(
    blocks.length > 0,
    `docs/concepts.md carries no review-coordinator walkthrough transcript any more — this parity test is ` +
      `asserting nothing. Restore the worked example or delete this test deliberately.`,
  );

  for (const block of blocks) {
    assert.match(
      block,
      /base sha:/,
      `A concepts.md walkthrough transcript advances past contract confirmation without showing the base sha ` +
        `it resolved:\n${block}\nStage 2 refuses a review that records no base sha (src/v2/review-run.ts), so ` +
        `an example that reaches discovery or the disposition stop is claiming a base was resolved. Show it, ` +
        `or the example documents an invocation that dead-ends.`,
    );
  }
});

// The two claims that make the walkthrough coherent: the base is resolved AT OPEN, and the
// Stage 2 refusal is the backstop behind that rather than a state `start` can leave you in.
// Dropping either one is how the contradiction came back.
const BASE_RESOLUTION_CLAIMS: { label: string; anyOf: RegExp[] }[] = [
  {
    label: "states the base is resolved when the review is OPENED",
    anyOf: [/comparison base is resolved when the review is opened/, /base is resolved at open/],
  },
  {
    label: "names the no---since inference from the ticket's landed range",
    anyOf: [
      /inferred from the ticket's landed commit range/,
      /inferred from the commits whose subject references the ticket/,
    ],
  },
  {
    label: "says start refuses AT OPEN when no base can be produced, naming --since",
    anyOf: [/start refuses at open/, /refuses at open, names --since/],
  },
  {
    label: "keeps the Stage 2 refusal as the backstop it is",
    anyOf: [/a review that records no base sha refuses here/, /refusal is a backstop/],
  },
];

test("FG-639 / RF-5: concepts.md states base resolution at open AND the Stage 2 backstop, without contradiction", () => {
  const text = normalize(read(CONCEPTS));

  for (const claim of BASE_RESOLUTION_CLAIMS) {
    assert.ok(
      claim.anyOf.some((re) => re.test(text)),
      `docs/concepts.md no longer expresses a load-bearing comparison-base claim — missing: ${claim.label}. ` +
        `Without all four, the walkthrough and the fail-closed base-sha rule read as contradicting each other ` +
        `again (claim-agreement, not verbatim wording).`,
    );
  }
});

// The prose is held to the CODE, not just to itself. Each predicate names the shipped string
// or branch the doc is describing, so removing the behavior reddens the parity test even if
// nobody touches the doc.
const SOURCE_PARITY: { label: string; path: string; anyOf: RegExp[] }[] = [
  {
    label: "`forge review start` prints the base sha it resolved",
    path: REVIEW_CMD,
    anyOf: [/base sha: \$\{base\.baseSha\}/],
  },
  {
    label: "and labels an inferred one with the commit it was inferred from",
    path: REVIEW_CMD,
    anyOf: [/inferred from the oldest commit referencing/],
  },
  {
    label: "the base is resolved BEFORE the review row is inserted",
    path: REVIEW_CMD,
    anyOf: [/resolveReviewBase\([\s\S]{0,200}?\}\);[\s\S]{0,200}?if \(!base\.ok\)[\s\S]{0,400}?insertReview/],
  },
  {
    label: "resolveReviewBase infers from the ticket's landed range when --since is absent",
    path: REVIEW_WIRING,
    anyOf: [/resolveCommitRange\(ctx\.ticketId/],
  },
  {
    label: "and refuses AT OPEN, naming --since, when inference is impossible",
    path: REVIEW_WIRING,
    anyOf: [/cannot be inferred — name it with --since <sha>/],
  },
  {
    label: "Stage 2 still refuses a review that records no base sha — the documented backstop",
    path: REVIEW_RUN,
    anyOf: [/review\.baseSha === undefined/],
  },
];

test("FG-639 / RF-5: the walkthrough's comparison-base claims match the shipped command, not just each other", () => {
  for (const predicate of SOURCE_PARITY) {
    const text = read(predicate.path);
    assert.ok(
      predicate.anyOf.some((re) => re.test(text)),
      `Docs-parity broke against the code: ${predicate.path.slice(repoRoot.length + 1)} no longer shows ` +
        `"${predicate.label}", which docs/concepts.md's review-coordinator walkthrough documents. Either the ` +
        `behavior moved and the walkthrough is now wrong, or this predicate needs re-anchoring — do not ` +
        `delete the assertion to make it pass.`,
    );
  }
});
