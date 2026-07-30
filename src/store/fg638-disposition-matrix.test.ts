// FG-638 — the disposition refusal matrix, and what "nothing was written" means.
//
// Every refusal in this vocabulary ends with "Nothing was written." That sentence is
// a claim about the whole ledger, not about the one column a reader thinks to check,
// so every case below asserts it the strongest available way: the review_findings,
// reviews and events tables are captured raw BEFORE the call and must be BYTE-
// IDENTICAL after. A refusal that quietly stamped decided_at, or absorbed a source
// into the canonical row, or logged an event, fails here regardless of which field
// a future reader remembers to look at.
//
// fg638-review-ledger.test.ts covers the same preconditions with a per-field
// `unchanged()` helper. What this file adds:
//
//   - THE AUTHORITY DERIVATION, MARKER BY MARKER. acceptedRiskNeedsOperator fires on
//     four independent markers. The existing suite proves the PREDICATE for all four
//     but drives only the security-lens case through a refusing recordDisposition.
//     Each marker here is a finding carrying EXACTLY that one marker, refused, with
//     the refusal naming that specific trigger — so a derivation that collapsed to
//     "security lens only" would pass over there and fail here.
//   - --operator ON A ROUTINE DECISION. Untested behavior: the flag is not refused as
//     unnecessary, it is honored and recorded. Pinned, because "the operator confirmed
//     this" is a durable claim about a human act and silently dropping it would be as
//     wrong as silently inventing it.
//   - THE CROSS-REVIEW DUPLICATE, which is the one refusal with a second row to
//     damage: the canonical must not absorb sources on a refused absorption.
//   - the vacuity guard: the snapshot helper is shown to DETECT a real write.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun } from "./runs.js";
import {
  insertReview,
  ingestFindings,
  getFinding,
  recordDisposition,
  acceptedRiskNeedsOperator,
  type Disposition,
  type DispositionRequest,
  type Observation,
  type ReviewFinding,
} from "./reviews.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg638-matrix",
  workflow: "feature",
  title: "disposition matrix",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

/** The whole ledger, raw. Compared with deepEqual, so any write anywhere shows up. */
function ledgerSnapshot(): unknown {
  const d = getDb();
  return {
    findings: d.prepare(`SELECT * FROM review_findings ORDER BY id`).all(),
    reviews: d.prepare(`SELECT * FROM reviews ORDER BY id`).all(),
    events: d.prepare(`SELECT * FROM events ORDER BY id`).all(),
  };
}

function review(id: string, candidateSha: string | null = "cand111"): string {
  insertReview({
    id,
    runId: RUN.id,
    reviewMode: "evidence_led",
    candidateSha: candidateSha ?? undefined,
    state: "awaiting_disposition",
  });
  return id;
}

function ingestOne(reviewId: string, o: Observation): ReviewFinding {
  const [f] = ingestFindings(reviewId, [o]);
  return f as ReviewFinding;
}

function req(partial: Partial<DispositionRequest> & { decision: Disposition }): DispositionRequest {
  return { rationale: "because the evidence says so", operator: false, ...partial };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── the authority markers, one at a time ───────────────────────────────────

// Each entry carries EXACTLY ONE marker, so nothing else can be what triggers the
// requirement, and the refusal must name that marker specifically.
const AUTHORITY_MARKERS: { label: string; observation: Observation; names: RegExp }[] = [
  { label: "a protected invariant", observation: { summary: "widens a protected invariant", invariantRef: "INV-14" }, names: /protected invariant INV-14/ },
  { label: "an acceptance criterion", observation: { summary: "misses an acceptance criterion", acceptanceRef: "AC-3" }, names: /acceptance criterion AC-3/ },
  { label: "the security lens", observation: { summary: "found through the security lens", riskLens: "security" }, names: /security lens/ },
  { label: "a data-integrity defect", observation: { summary: "corrupts a stored row", findingType: "data_integrity" }, names: /data-integrity finding/ },
];

for (const marker of AUTHORITY_MARKERS) {
  test(`FG-638: accepted_risk on a finding whose ONLY authority marker is ${marker.label} is refused without --operator, and writes nothing`, () => {
    const r = review(`review-${marker.label.replace(/\W+/g, "-")}`);
    const finding = ingestOne(r, marker.observation);

    // The derivation is mechanical, from the finding's own durable fields — a caller
    // cannot talk its way out of it by declaring the decision routine.
    assert.equal(acceptedRiskNeedsOperator(finding), true, `${marker.label} alone must trigger the operator requirement`);

    const before = ledgerSnapshot();
    const outcome = recordDisposition(finding.id, req({ decision: "accepted_risk" }));

    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && marker.names.test(outcome.refusal), `the refusal must name ${marker.label}: ${outcome.ok === false ? outcome.refusal : ""}`);
    assert.ok(outcome.ok === false && /requires operator authority/.test(outcome.refusal));
    assert.ok(outcome.ok === false && /Nothing was written/.test(outcome.refusal));
    assert.deepEqual(ledgerSnapshot(), before, "a refused authority-requiring decision must leave the ledger byte-identical");
  });

  test(`FG-638: the same decision WITH --operator is recorded as the operator's (${marker.label})`, () => {
    const r = review(`review-op-${marker.label.replace(/\W+/g, "-")}`);
    const finding = ingestOne(r, marker.observation);

    const outcome = recordDisposition(finding.id, req({ decision: "accepted_risk", operator: true, rationale: "accepted deliberately, tracked in the risk log" }));
    assert.equal(outcome.ok, true);

    const after = getFinding(finding.id) as ReviewFinding;
    assert.equal(after.disposition, "accepted_risk");
    assert.equal(after.decidedBy, "operator");
    assert.equal(after.dispositionRationale, "accepted deliberately, tracked in the risk log");
    assert.equal(after.decidedCandidateSha, "cand111", "the decision is bound to the candidate it was made against");

    const events = getDb()
      .prepare(`SELECT payload FROM events WHERE event_type = 'review.finding_dispositioned'`)
      .all() as { payload: string }[];
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0]?.payload as string) as { decidedBy: string; disposition: string; candidateSha: string };
    assert.deepEqual(
      [payload.disposition, payload.decidedBy, payload.candidateSha],
      ["accepted_risk", "operator", "cand111"],
      "the append-only event must carry the same authority record as the row",
    );
  });
}

test("FG-638: a finding with NO authority marker does not need the operator — the derivation is not blanket", () => {
  const r = review("review-routine");
  const plain = ingestOne(r, { summary: "a cosmetic label is wrong", riskLens: "frontend", severity: "low" });

  assert.equal(acceptedRiskNeedsOperator(plain), false);
  const outcome = recordDisposition(plain.id, req({ decision: "accepted_risk", rationale: "cosmetic, not worth a fix batch" }));
  assert.equal(outcome.ok, true);
  assert.equal(getFinding(plain.id)?.decidedBy, "orchestrator", "a routine disposition is the orchestrator's, not the operator's");
});

// ─── --operator where it is not required ────────────────────────────────────

// The flag says WHO decided. It is not a permission being spent, so it is never
// refused for being unnecessary — it is recorded. (This is an explicit confirmation
// under the single-user trust model, NOT authenticated identity: FG-597 and the
// FG-638 authority caveat. A test naming it "operator" is naming a CLI act.)
const ROUTINE_DECISIONS: { decision: Disposition; extra: Partial<DispositionRequest> }[] = [
  { decision: "fix_now", extra: {} },
  { decision: "architecture_question", extra: {} },
  {
    decision: "rejected_premise",
    extra: { evidence: JSON.stringify({ command: "npm test -- foo", output: "0 failures" }), evidenceKind: "replayed_command" },
  },
];

for (const c of ROUTINE_DECISIONS) {
  test(`FG-638: --operator on a NON-authority-changing ${c.decision} is accepted and recorded as operator`, () => {
    const r = review(`review-flagged-${c.decision}`);
    const finding = ingestOne(r, { summary: `a plain finding dispositioned ${c.decision}`, riskLens: "wide" });
    assert.equal(acceptedRiskNeedsOperator(finding), false, "precondition: this finding must NOT require authority");

    const outcome = recordDisposition(finding.id, req({ decision: c.decision, operator: true, ...c.extra }));
    assert.equal(outcome.ok, true, outcome.ok === false ? outcome.refusal : "");

    const after = getFinding(finding.id) as ReviewFinding;
    assert.equal(after.disposition, c.decision);
    assert.equal(
      after.decidedBy,
      "operator",
      "--operator is a record of who decided, honored on every decision — not a permission that only authority-requiring values consume",
    );
  });
}

// ─── the refusal matrix ─────────────────────────────────────────────────────

type Case = {
  name: string;
  /** Builds the finding under test; may create sibling rows the refusal must not touch. */
  arrange: () => ReviewFinding;
  request: DispositionRequest;
  refusal: RegExp;
};

const CASES: Case[] = [
  {
    name: "an empty rationale",
    arrange: () => ingestOne(review("review-c1"), { summary: "no rationale given" }),
    request: req({ decision: "fix_now", rationale: "" }),
    refusal: /--rationale/,
  },
  {
    name: "a whitespace-only rationale",
    arrange: () => ingestOne(review("review-c2"), { summary: "whitespace rationale" }),
    request: req({ decision: "duplicate", rationale: "   \t \n " }),
    refusal: /--rationale/,
  },
  {
    name: "rejected_premise on a review with no candidate sha to bind evidence to",
    arrange: () => ingestOne(review("review-c3", null), { summary: "nothing to bind to" }),
    request: req({ decision: "rejected_premise", evidence: "replayed the command", evidenceKind: "replayed_command" }),
    refusal: /no candidate sha to bind it to/,
  },
  {
    name: "rejected_premise with a rationale but no evidence",
    arrange: () => ingestOne(review("review-c4"), { summary: "argued, not disproved" }),
    request: req({ decision: "rejected_premise" }),
    refusal: /not a rationale alone/,
  },
  {
    name: "rejected_premise with evidence but no evidence kind",
    arrange: () => ingestOne(review("review-c5"), { summary: "unkinded evidence" }),
    request: req({ decision: "rejected_premise", evidence: "I ran it and it was fine" }),
    refusal: /not a rationale alone/,
  },
  {
    name: "rejected_premise with an evidence kind outside the three shapes of proof",
    arrange: () => ingestOne(review("review-c6"), { summary: "vibes as evidence" }),
    request: req({ decision: "rejected_premise", evidence: "trust me", evidenceKind: "vibes" }),
    refusal: /--evidence-kind must be one of/,
  },
  {
    name: "deferred with no durable destination",
    arrange: () => ingestOne(review("review-c7"), { summary: "deferred to nowhere" }),
    request: req({ decision: "deferred" }),
    refusal: /durable destination/,
  },
  {
    name: "deferred to an empty ticket id",
    arrange: () => ingestOne(review("review-c8"), { summary: "deferred to the empty string" }),
    request: req({ decision: "deferred", followupTicketId: "  " }),
    refusal: /durable destination/,
  },
  {
    name: "deferred to a ticket this store does not know, without --operator",
    arrange: () => ingestOne(review("review-c9"), { summary: "deferred to an invented ticket" }),
    request: req({ decision: "deferred", followupTicketId: "FG-9999" }),
    refusal: /not a ticket this store knows/,
  },
  {
    name: "duplicate citing no canonical finding",
    arrange: () => ingestOne(review("review-c10"), { summary: "duplicate of what?" }),
    request: req({ decision: "duplicate" }),
    refusal: /must cite the canonical finding/,
  },
  {
    name: "duplicate citing a canonical finding that does not exist",
    arrange: () => ingestOne(review("review-c11"), { summary: "duplicate of a ghost" }),
    request: req({ decision: "duplicate", duplicateOf: "RF-404" }),
    refusal: /no finding matches/,
  },
  {
    name: "duplicate citing itself",
    arrange: () => ingestOne(review("review-c12"), { summary: "its own duplicate" }),
    request: req({ decision: "duplicate", duplicateOf: "RF-1" }),
    refusal: /cannot duplicate itself/,
  },
  {
    name: "duplicate citing a canonical finding in ANOTHER review",
    arrange: () => {
      const other = review("review-c13-other");
      ingestOne(other, { summary: "the canonical row, in a different review", sources: [{ verdictId: "v-other" }] });
      return ingestOne(review("review-c13"), { summary: "cross-review duplicate", sources: [{ verdictId: "v-mine" }] });
    },
    request: req({ decision: "duplicate", duplicateOf: "review-c13-other/RF-1" }),
    refusal: /a duplicate is scoped to one review/,
  },
];

for (const c of CASES) {
  test(`FG-638: ${c.name} is refused and the whole ledger stays byte-identical`, () => {
    const finding = c.arrange();
    const before = ledgerSnapshot();

    const outcome = recordDisposition(finding.id, c.request);

    assert.equal(outcome.ok, false, `expected a refusal for: ${c.name}`);
    assert.ok(outcome.ok === false && c.refusal.test(outcome.refusal), `refusal must name what is missing, got: ${outcome.ok === false ? outcome.refusal : ""}`);
    assert.deepEqual(ledgerSnapshot(), before, `${c.name}: "Nothing was written" must be true of every table, not just the one column`);
  });
}

// ─── the shape of disproving evidence, kind by kind ─────────────────────────

// The precondition rejected_premise carries is CANDIDATE-BOUND DISPROVING EVIDENCE.
// Whether a payload actually disproves the finding it is attached to is SEMANTIC and
// belongs to FG-639's coordinator; what is enforced here is that the payload IS one
// of the three shapes of proof rather than a sentence wearing their label. Each kind
// below is driven through every incomplete variant (refused, byte-identical) and its
// complete one (settles, stored structured).
type EvidenceShape = {
  kind: string;
  complete: Record<string, unknown>;
  /** Each entry is a payload that is missing or malforms exactly one required field. */
  incomplete: { label: string; payload: unknown; names: RegExp }[];
};

const EVIDENCE_SHAPES: EvidenceShape[] = [
  {
    kind: "replayed_command",
    complete: { command: "npm test -- src/store/reviews.test.ts", output: "42 passing, 0 failing" },
    incomplete: [
      { label: "the command without its output", payload: { command: "npm test -- src/store" }, names: /missing or empty: output/ },
      { label: "the output without the command that produced it", payload: { output: "42 passing" }, names: /missing or empty: command/ },
      { label: "an empty output", payload: { command: "npm test", output: "   " }, names: /missing or empty: output/ },
      { label: "neither field", payload: { note: "I replayed it" }, names: /missing or empty: command, output/ },
    ],
  },
  {
    kind: "deterministic_reproduction",
    complete: { reproduction: "node --test src/store/fg638-review-ledger.test.ts", result: "the claimed failure does not occur" },
    incomplete: [
      { label: "the reproduction without its observed result", payload: { reproduction: "node --test x.test.ts" }, names: /missing or empty: result/ },
      { label: "a result with nothing that produced it", payload: { result: "it passed" }, names: /missing or empty: reproduction/ },
      { label: "neither field", payload: { detail: "reproduced fine" }, names: /missing or empty: reproduction, result/ },
    ],
  },
  {
    kind: "anchored_contradiction",
    complete: { file: "src/store/reviews.ts", line: 284, fact: "insertReview reads the run's mode before writing the copy" },
    incomplete: [
      { label: "an anchor with no line", payload: { file: "src/store/reviews.ts", fact: "the guard is right there" }, names: /missing or empty: line/ },
      { label: "a line with no file", payload: { line: 284, fact: "the guard is right there" }, names: /missing or empty: file/ },
      { label: "an anchor with no contradicting fact", payload: { file: "src/store/reviews.ts", line: 284 }, names: /missing or empty: fact/ },
      { label: "a line number that is not a number", payload: { file: "src/store/reviews.ts", line: "284", fact: "x" }, names: /missing or empty: line/ },
      { label: "a line number that is not a line", payload: { file: "src/store/reviews.ts", line: 0, fact: "x" }, names: /missing or empty: line/ },
    ],
  },
];

for (const shape of EVIDENCE_SHAPES) {
  for (const bad of shape.incomplete) {
    test(`FG-638: ${shape.kind} evidence carrying ${bad.label} is refused and the whole ledger stays byte-identical`, () => {
      const r = review(`review-ev-${shape.kind}-${bad.label.replace(/\W+/g, "-")}`);
      const finding = ingestOne(r, { summary: `a finding rejected with ${bad.label}` });
      const before = ledgerSnapshot();

      const outcome = recordDisposition(
        finding.id,
        req({ decision: "rejected_premise", evidence: JSON.stringify(bad.payload), evidenceKind: shape.kind }),
      );

      assert.equal(outcome.ok, false, `${shape.kind} / ${bad.label} must not settle the finding`);
      assert.ok(outcome.ok === false && bad.names.test(outcome.refusal), `the refusal must name the missing field, got: ${outcome.ok === false ? outcome.refusal : ""}`);
      assert.ok(outcome.ok === false && outcome.refusal.includes(shape.kind), "the refusal must name the kind whose shape was not met");
      assert.ok(outcome.ok === false && /Nothing was written/.test(outcome.refusal));
      assert.deepEqual(ledgerSnapshot(), before, `${shape.kind} / ${bad.label}: a refused disposition must write nothing anywhere`);
    });
  }

  test(`FG-638: a complete ${shape.kind} payload settles the finding and is stored structured, bound to the candidate`, () => {
    const r = review(`review-ev-ok-${shape.kind}`);
    const finding = ingestOne(r, { summary: `a finding disproved by a ${shape.kind}` });

    const outcome = recordDisposition(
      finding.id,
      req({ decision: "rejected_premise", evidence: JSON.stringify(shape.complete), evidenceKind: shape.kind }),
    );
    assert.equal(outcome.ok, true, outcome.ok === false ? outcome.refusal : "");

    const after = getFinding(finding.id) as ReviewFinding;
    assert.equal(after.disposition, "rejected_premise");
    const stored = JSON.parse(after.dispositionEvidence as string) as { kind: string; detail: unknown; candidateSha: string };
    assert.equal(stored.kind, shape.kind);
    assert.deepEqual(stored.detail, shape.complete, "the payload is persisted field-by-field, not as the free text it arrived in");
    assert.equal(stored.candidateSha, "cand111", "the binding to the candidate the evidence was gathered against survives the shape check");
  });
}

test("FG-638: free text labelled with a valid evidence kind no longer settles anything", () => {
  // The behavior this change closes: before the shape check, ANY nonempty string
  // labelled replayed_command settled the finding.
  const r = review("review-ev-freetext");
  const finding = ingestOne(r, { summary: "settled by assertion alone" });
  const before = ledgerSnapshot();

  for (const kind of ["replayed_command", "deterministic_reproduction", "anchored_contradiction"]) {
    const outcome = recordDisposition(finding.id, req({ decision: "rejected_premise", evidence: "I ran it and it was fine", evidenceKind: kind }));
    assert.equal(outcome.ok, false, `free text labelled ${kind} must not settle the finding`);
    assert.ok(outcome.ok === false && /not free text/.test(outcome.refusal));
  }
  // A JSON scalar or array is not a payload either.
  for (const raw of ['"just a string"', "42", '["command", "output"]', "null"]) {
    const outcome = recordDisposition(finding.id, req({ decision: "rejected_premise", evidence: raw, evidenceKind: "replayed_command" }));
    assert.equal(outcome.ok, false, `${raw} is not an evidence payload`);
  }
  assert.deepEqual(ledgerSnapshot(), before);
});

test("FG-638: an unknown finding id is refused by name and writes nothing", () => {
  const r = review("review-unknown-id");
  ingestOne(r, { summary: "the only real finding" });
  const before = ledgerSnapshot();

  for (const bogus of ["review-unknown-id/RF-99", "RF-1", "", "'; DROP TABLE review_findings; --"]) {
    const outcome = recordDisposition(bogus, req({ decision: "fix_now" }));
    assert.equal(outcome.ok, false, `expected a refusal for '${bogus}'`);
    assert.ok(outcome.ok === false && outcome.refusal.includes(bogus), `the refusal must name what was asked for: ${outcome.ok === false ? outcome.refusal : ""}`);
  }
  assert.deepEqual(ledgerSnapshot(), before);
  // Note: a BARE ref is deliberately not resolved here — recordDisposition takes the
  // full Forge-assigned id, and the operator-facing RF-n resolution (with its
  // ambiguity refusal) lives in lookupFinding, driven by the CLI.
});

test("FG-638: an unknown decision word writes nothing (the operator-facing name comes from the CLI's vocabulary check)", () => {
  const r = review("review-unknown-decision");
  const finding = ingestOne(r, { summary: "dispositioned with an invented word" });
  const before = ledgerSnapshot();

  for (const word of ["wont_fix", "won't fix", "FIX_NOW", "settled"]) {
    const outcome = recordDisposition(finding.id, req({ decision: word as Disposition }));
    assert.equal(outcome.ok, false, `'${word}' is not in the vocabulary and must not be recorded`);
  }
  assert.deepEqual(ledgerSnapshot(), before, "an out-of-vocabulary decision must not reach the row or the event log");
});

test("FG-638: the byte-identical assertion above can actually fail — a permitted decision DOES move the ledger", () => {
  // Vacuity guard. Every refusal test asserts a snapshot did not change; this one
  // proves the snapshot is sensitive enough for that to mean something.
  const r = review("review-sensitivity");
  const finding = ingestOne(r, { summary: "a routine finding" });
  const before = ledgerSnapshot();

  const outcome = recordDisposition(finding.id, req({ decision: "fix_now" }));
  assert.equal(outcome.ok, true);
  assert.notDeepEqual(ledgerSnapshot(), before, "a recorded disposition must change the ledger, or the refusal assertions are vacuous");
});
