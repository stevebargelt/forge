import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReadiness } from "./readiness.js";
import type { StructuredTicket } from "../backlog/structured.js";

function ticket(overrides: Partial<StructuredTicket> & { body: string }): StructuredTicket {
  return {
    id: "FG-000",
    type: "story",
    status: "active",
    title: "Test ticket",
    ...overrides,
  };
}

const FULL_BODY = `## Problem
Something is broken.

## Goal
Fix it.

## Acceptance Criteria
- Test passes.
- No regressions.
`;

test("ready: Problem + Goal + AC bullets → ready, refinementProposal null", () => {
  const result = evaluateReadiness(ticket({ body: FULL_BODY }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.refinementProposal, null);
});

test("needs_refinement: missing AC section → needs_refinement, gap mentions Acceptance Criteria", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix it.",
  }));
  assert.equal(result.outcome, "needs_refinement");
  assert.ok(result.gaps.some((g) => /acceptance criteria/i.test(g)));
  assert.ok(result.refinementProposal !== null);
  assert.ok(/acceptance criteria/i.test(result.refinementProposal!));
});

test("needs_refinement: AC section present but empty (no bullets) → needs_refinement", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n\n",
  }));
  assert.equal(result.outcome, "needs_refinement");
  assert.ok(result.gaps.some((g) => /acceptance criteria/i.test(g)));
});

test("needs_refinement: missing Goal → needs_refinement, gap mentions Goal", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Acceptance Criteria\n- Test.",
  }));
  assert.equal(result.outcome, "needs_refinement");
  assert.ok(result.gaps.some((g) => /goal/i.test(g)));
  assert.ok(result.refinementProposal !== null);
});

test("needs_refinement: missing Problem → needs_refinement, gap mentions Problem", () => {
  const result = evaluateReadiness(ticket({
    body: "## Goal\nFix.\n\n## Acceptance Criteria\n- Test.",
  }));
  assert.equal(result.outcome, "needs_refinement");
  assert.ok(result.gaps.some((g) => /problem/i.test(g)));
  assert.ok(result.refinementProposal !== null);
});

test("exploratory: type=idea → exploratory, no AC required", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Problem\nWe want to explore something.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.equal(result.refinementProposal, null);
  assert.deepEqual(result.gaps, []);
});

test("exploratory: spike in title → exploratory, no AC required", () => {
  const result = evaluateReadiness(ticket({
    title: "Spike: investigate auth flow",
    body: "## Goal\nUnderstand the auth flow.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.equal(result.refinementProposal, null);
});

test("exploratory: research in body → exploratory", () => {
  const result = evaluateReadiness(ticket({
    title: "Auth flow options",
    body: "## Problem\nWe need to research the best approach.\n\nThis is a research spike.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.equal(result.refinementProposal, null);
});

test("exploratory: idea type missing both Problem and Goal → exploratory with refinementProposal", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Non-Goals\nThis doesn't cover X.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.ok(result.gaps.length > 0);
  assert.ok(result.refinementProposal !== null);
});

test("blocked: status=blocked → blocked outcome, refinementProposal non-null", () => {
  const result = evaluateReadiness(ticket({
    status: "blocked",
    body: FULL_BODY,
  }));
  assert.equal(result.outcome, "blocked");
  assert.ok(result.gaps.length > 0);
  assert.ok(result.refinementProposal !== null);
});

test("blocked takes priority over exploratory", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    status: "blocked",
    body: "## Problem\nSomething.",
  }));
  assert.equal(result.outcome, "blocked");
});

test("AC with numbered list counts as having bullets", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n1. Test passes.\n2. No regressions.",
  }));
  assert.equal(result.outcome, "ready");
});

test("case-insensitive heading match for 'ACCEPTANCE CRITERIA'", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## GOAL\nFix.\n\n## ACCEPTANCE CRITERIA\n- Test.",
  }));
  assert.equal(result.outcome, "ready");
});

test("Expected behavior heading matches Goal requirement", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Expected behavior\nIt works.\n\n## Acceptance Criteria\n- Test.",
  }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
});

// ── heading robustness ────────────────────────────────────────────────────

test("heading: 'Acceptance criteria' (lowercase c) → ready", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance criteria\n- Test passes.",
  }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
});

test("heading: AC with * bullets → ready", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n* Test passes.\n* No regressions.",
  }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
});

test("heading: AC section present but empty → gap says 'no bullet points', not 'missing section'", () => {
  const result = evaluateReadiness(ticket({
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n\n",
  }));
  assert.equal(result.outcome, "needs_refinement");
  const acGap = result.gaps.find((g) => /acceptance criteria/i.test(g));
  assert.ok(acGap, "AC gap must exist");
  assert.ok(/bullet/i.test(acGap!), `gap should mention bullets, got: ${acGap}`);
  assert.ok(!/missing.*section/i.test(acGap!), `gap should not say 'missing section', got: ${acGap}`);
});

test("heading: sections in non-standard order (AC first, then Problem, then Goal) → ready", () => {
  const result = evaluateReadiness(ticket({
    body: "## Acceptance Criteria\n- Test.\n\n## Problem\nSomething.\n\n## Goal\nFix.",
  }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
});

test("heading: extra unknown sections are ignored", () => {
  const result = evaluateReadiness(ticket({
    body: "## Non-goals\nWe won't do X.\n\n## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n- Test.\n\n## Open questions\nTBD.",
  }));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.gaps, []);
});

test("heading: single-level h1 heading recognised", () => {
  const result = evaluateReadiness(ticket({
    body: "# Problem\nSomething.\n\n# Goal\nFix.\n\n# Acceptance Criteria\n- Test.",
  }));
  assert.equal(result.outcome, "ready");
});

// ── edge cases ────────────────────────────────────────────────────────────

test("edge: empty body → needs_refinement, all three gaps present", () => {
  const result = evaluateReadiness(ticket({ body: "" }));
  assert.equal(result.outcome, "needs_refinement");
  assert.ok(result.gaps.some((g) => /problem/i.test(g)), "should flag missing Problem");
  assert.ok(result.gaps.some((g) => /goal/i.test(g)), "should flag missing Goal");
  assert.ok(result.gaps.some((g) => /acceptance criteria/i.test(g)), "should flag missing AC");
  assert.equal(result.gaps.length, 3);
});

test("edge: body with only non-heading text (no markdown sections) → needs_refinement", () => {
  const result = evaluateReadiness(ticket({ body: "Just a freeform description with no headings." }));
  assert.equal(result.outcome, "needs_refinement");
  assert.equal(result.gaps.length, 3);
});

test("edge: all three gaps → refinementProposal mentions Problem, Goal, and Acceptance Criteria", () => {
  const result = evaluateReadiness(ticket({ body: "" }));
  assert.ok(result.refinementProposal !== null);
  assert.ok(/problem/i.test(result.refinementProposal!), "should mention Problem");
  assert.ok(/goal/i.test(result.refinementProposal!), "should mention Goal");
  assert.ok(/acceptance criteria/i.test(result.refinementProposal!), "should mention AC");
});

// ── exploratory variants ──────────────────────────────────────────────────

test("exploratory: idea with only Goal (no Problem, no AC) → exploratory, no gaps", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Goal\nExplore this new concept.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.refinementProposal, null);
});

test("exploratory: idea with only Problem (no Goal, no AC) → exploratory, no gaps", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Problem\nWe have this rough problem area.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.refinementProposal, null);
});

test("exploratory: 'exploration' marker in title (story type) → exploratory", () => {
  const result = evaluateReadiness(ticket({
    title: "Exploration: caching strategies",
    body: "## Problem\nCaching is slow.",
  }));
  assert.equal(result.outcome, "exploratory");
});

test("exploratory: 'investigation' marker in body (story type) → exploratory", () => {
  const result = evaluateReadiness(ticket({
    title: "Auth performance",
    body: "## Problem\nThis is an investigation into auth latency.",
  }));
  assert.equal(result.outcome, "exploratory");
});

test("exploratory: idea with AC bullets is still exploratory (AC not required but not penalised)", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Problem\nSomething.\n\n## Goal\nFix.\n\n## Acceptance Criteria\n- Bullet.",
  }));
  assert.equal(result.outcome, "exploratory");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.refinementProposal, null);
});

// ── refinementProposal precision ──────────────────────────────────────────

test("refinementProposal: null when ready", () => {
  const result = evaluateReadiness(ticket({ body: FULL_BODY }));
  assert.equal(result.refinementProposal, null);
});

test("refinementProposal: null for clean exploratory (idea with Problem)", () => {
  const result = evaluateReadiness(ticket({
    type: "idea",
    body: "## Problem\nWe want to explore this.",
  }));
  assert.equal(result.refinementProposal, null);
});

test("refinementProposal: missing only Problem → proposal mentions Problem instruction only", () => {
  const result = evaluateReadiness(ticket({
    body: "## Goal\nFix.\n\n## Acceptance Criteria\n- Test.",
  }));
  assert.ok(result.refinementProposal !== null);
  assert.ok(/problem/i.test(result.refinementProposal!), "should mention Problem");
  assert.ok(!/acceptance criteria/i.test(result.refinementProposal!), "should NOT mention AC");
  assert.ok(!/goal/i.test(result.refinementProposal!), "should NOT mention Goal");
});
