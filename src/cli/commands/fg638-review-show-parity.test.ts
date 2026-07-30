// FG-638 — `forge review show` and `forge review show --json` are two renderings of
// ONE projection. This file holds them to each other.
//
// The existing CLI tests assert each surface against the same fixture separately:
// the human test checks severity/lens/anchor/invariant, the JSON test checks ids and
// counts, and neither looks at what the other looked at. So a field added to
// summarizeReview and wired into only one surface passes today, and an operator who
// switches between `--json` and the human render gets two different answers about
// the same review.
//
// The mechanism here is a CLASSIFICATION, not a spot check: every key of the JSON
// projection must be declared either RENDERED (its value must appear in the human
// text) or JSON_ONLY (its value must NOT — the render deliberately summarizes). A new
// field in either list's absence fails the exhaustiveness assertion, so classifying it
// is a deliberate act rather than an omission nobody notices.
//
// The JSON_ONLY list is a real, current gap worth naming, not a design statement: the
// finding's own `evidence` and `hypothesis` — the substance of an evidence-led
// finding — are carried by `--json` and by no human surface (the dashboard projection
// omits them too). Change 1's AC is "render a review's summary and findings", which
// this satisfies; if a later change surfaces them, this list is the one line to move.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import {
  insertReview,
  ingestFindings,
  recordDisposition,
  setReviewState,
  updateReview,
  summarizeReview,
  type ReviewSummary,
} from "../../store/reviews.js";
import { renderReview } from "./review.js";
import type { Run, Task } from "../../types/index.js";

const RUN: Run = {
  id: "run-fg638-parity",
  workflow: "feature",
  title: "read-surface parity",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

const REVIEW_ID = "review-parity";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

// Every value below is distinctive on purpose: a substring assertion is only
// meaningful if the string cannot appear in the render by coincidence.
function fullyPopulatedReview(): ReviewSummary {
  insertReview({
    id: REVIEW_ID,
    runId: RUN.id,
    subjectTaskId: "task-parity-subject",
    ticketId: "FG-638",
    reviewMode: "evidence_led",
    baseSha: "basesha0000",
    contractConfirmedSha: "confsha1111",
    candidateSha: "candsha2222",
    trustedRemoteSha: "remotesha33",
    contract: { threat_model: "operator_trusted_candidate", risk_lenses: ["wide", "security"], marker: "contract-json-only-marker" },
    lensOutcomes: { security: "found", marker: "lens-outcomes-json-only-marker" },
    state: "awaiting_disposition",
  });

  const [canonical, dup, deferredOne, disproved] = ingestFindings(REVIEW_ID, [
    {
      summary: "unauthenticated write path on the admin route",
      fingerprint: "fingerprint-json-only-marker",
      severity: "high",
      riskLens: "security",
      findingType: "findingtype-json-only-marker",
      evidence: "evidence-json-only-marker: no session check in the handler",
      hypothesis: "hypothesis-json-only-marker: the middleware was never mounted",
      reachability: "demonstrated",
      file: "src/routes/admin.ts",
      line: 4242,
      quotedText: "app.post('/admin'",
      acceptanceRef: "AC-7",
      invariantRef: "INV-14",
      sources: [
        { verdictId: "verdict-sec-1", redRole: "red-security", authority: "authoritative" },
        { verdictId: "verdict-wide-2", redRole: "red-wide" },
      ],
    },
    { summary: "the same admin route, reported again", severity: "medium", riskLens: "wide", sources: [{ modelFindingId: "MODEL-SUPPLIED-77" }] },
    { summary: "a slow query worth tracking separately", severity: "low", riskLens: "backend" },
    { summary: "a claim the candidate disproves", severity: "medium", riskLens: "backend" },
  ]);

  // Drive the row through real decisions so decided_by / decided_at / evidence /
  // duplicate linkage / follow-up are all populated by the code that owns them.
  const ok = recordDisposition((canonical as { id: string }).id, {
    decision: "fix_now",
    rationale: "rationale-for-canonical: fix before ship",
    operator: false,
  });
  assert.equal(ok.ok, true);
  const dupOutcome = recordDisposition((dup as { id: string }).id, {
    decision: "duplicate",
    rationale: "rationale-for-duplicate: same mechanism as RF-1",
    operator: false,
    duplicateOf: "RF-1",
  });
  assert.equal(dupOutcome.ok, true);
  const deferredOutcome = recordDisposition((deferredOne as { id: string }).id, {
    decision: "deferred",
    rationale: "rationale-for-deferred: tracked separately",
    operator: true,
    followupTicketId: "FG-9001",
  });
  assert.equal(deferredOutcome.ok, true);

  // The candidate ADVANCED after those dispositions landed (remediation shipped), so
  // decided_candidate_sha and discovered_sha hold the OLD sha while the review's own
  // candidate line renders the new one. That is what makes "not rendered" a claim that
  // can actually fail rather than a coincidence of equal strings — and the
  // rejected_premise decision below is taken AFTER the advance, so the sha its
  // evidence blob embeds is the rendered one, not the old one.
  updateReview(REVIEW_ID, { candidateSha: "candsha5555" });

  // rejected_premise is the only decision that populates disposition_evidence, so the
  // 'evidence:' render line is only testable through it.
  const disprovedOutcome = recordDisposition((disproved as { id: string }).id, {
    decision: "rejected_premise",
    rationale: "rationale-for-rejected: the replay contradicts the claim",
    operator: false,
    evidence: JSON.stringify({ command: "disposition-evidence-marker: npm test -- admin", output: "0 failures" }),
    evidenceKind: "replayed_command",
  });
  assert.equal(disprovedOutcome.ok, true);

  // Resolution is a SEPARATE field from disposition; the render has a line for it, so
  // populate it (with its evidence) rather than leave the pair half-tested.
  db.prepare(
    `UPDATE review_findings SET resolution = 'resolved', resolution_evidence_kind = 'recheck',
        resolution_evidence = 'resolution-evidence-marker: red-security re-ran clean', resolved_sha = 'resolvedsha44'
      WHERE id = ?`,
  ).run((canonical as { id: string }).id);

  setReviewState(REVIEW_ID, "settled", { reason: "all findings settled" });

  return summarizeReview(REVIEW_ID) as ReviewSummary;
}

/** Fields the human render must carry. The value must appear verbatim in the text. */
const REVIEW_RENDERED = [
  "id",
  "runId",
  "subjectTaskId",
  "ticketId",
  "baseSha",
  "contractConfirmedSha",
  "candidateSha",
  "trustedRemoteSha",
  "reviewMode",
  "state",
  "settledAt",
] as const;

/** Fields `--json` carries that the human render deliberately does not. */
const REVIEW_JSON_ONLY = {
  contract: "only contract.risk_lenses is rendered, as the 'risk lenses' line",
  lensOutcomes: "per-lens outcomes are the coordinator's (FG-639) surface, not this summary's",
} as const;

/** JSON-only, but their VALUES cannot be asserted absent — a timestamp or a substring
 *  that legitimately occurs elsewhere in the render. Listed so the classification
 *  stays exhaustive without pretending to an assertion it cannot make. */
const REVIEW_JSON_ONLY_UNASSERTABLE = {
  createdAt: "a timestamp that can coincide with the rendered settled-at stamp",
  updatedAt: "a timestamp that can coincide with the rendered settled-at stamp",
} as const;

const FINDING_RENDERED = [
  "id",
  "findingRef",
  "summary",
  "severity",
  "riskLens",
  "reachability",
  "file",
  "line",
  "quotedText",
  "acceptanceRef",
  "invariantRef",
  "disposition",
  "dispositionRationale",
  "dispositionEvidence",
  "decidedBy",
  "decidedAt",
  "duplicateOf",
  "followupTicketId",
  "resolution",
  "resolutionEvidenceKind",
  "resolutionEvidence",
  "resolvedSha",
] as const;

const FINDING_JSON_ONLY = {
  fingerprint: "an internal identity key, not operator-facing",
  findingType: "the facets line renders severity/lens/reachability; type is not one of them",
  evidence: "GAP, named deliberately: the finding's own evidence text is --json-only today",
  hypothesis: "GAP, named deliberately: the finding's hypothesis is --json-only today",
  decidedCandidateSha: "the review's candidate line is rendered; the per-decision sha is not",
  discoveredSha: "not rendered — the review's four SHAs are the operator's frame",
} as const;

const FINDING_JSON_ONLY_UNASSERTABLE = {
  reviewId: "equals the review id, which the header renders",
  ordinal: "a small integer that appears throughout the text",
  sources: "an array — asserted structurally below, per source label",
  createdAt: "a timestamp that can coincide with a rendered stamp",
  updatedAt: "a timestamp that can coincide with a rendered stamp",
} as const;

const SUMMARY_KEYS = ["review", "findings", "countsByDisposition", "countsByResolution", "riskLenses", "unsettledCount"] as const;

function classify(actual: string[], rendered: readonly string[], jsonOnly: object, unassertable: object, what: string): void {
  const declared = new Set<string>([...rendered, ...Object.keys(jsonOnly), ...Object.keys(unassertable)]);
  const unclassified = actual.filter((k) => !declared.has(k)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `${what}: these fields are in the --json projection and classified in neither list. Decide deliberately: ` +
      `render them in forge review show (add to the RENDERED list) or declare them --json-only.`,
  );
  const stale = [...declared].filter((k) => !actual.includes(k)).sort();
  assert.deepEqual(stale, [], `${what}: classified fields that the projection no longer has`);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  const task: Task = {
    id: "task-parity-subject",
    runId: RUN.id,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: "task-parity-subject", runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-638: every field of the --json projection is classified as rendered-in-human or json-only", () => {
  const summary = fullyPopulatedReview();
  // What `--json` actually emits: JSON.stringify drops undefined, so this is the
  // projection's real wire shape rather than its TypeScript type.
  const json = JSON.parse(JSON.stringify(summary)) as {
    review: Record<string, unknown>;
    findings: Record<string, unknown>[];
    countsByDisposition: Record<string, number>;
    countsByResolution: Record<string, number>;
    riskLenses: string[];
    unsettledCount: number;
  };

  assert.deepEqual(Object.keys(json).sort(), [...SUMMARY_KEYS].sort(), "the summary's top-level shape changed — classify the new key below");
  classify(Object.keys(json.review), REVIEW_RENDERED, REVIEW_JSON_ONLY, REVIEW_JSON_ONLY_UNASSERTABLE, "review");

  // Every finding, not just the first: the richest row is fully populated, and the
  // union across rows is what the classification must cover.
  const findingKeys = [...new Set(json.findings.flatMap((f) => Object.keys(f)))];
  classify(findingKeys, FINDING_RENDERED, FINDING_JSON_ONLY, FINDING_JSON_ONLY_UNASSERTABLE, "finding");

  // Non-vacuity: the fixture must actually populate the fields being classified.
  assert.ok(json.findings.length >= 3, "the fixture needs several findings for the union to mean anything");
  const richest = json.findings[0] as Record<string, unknown>;
  for (const k of [...FINDING_RENDERED, ...Object.keys(FINDING_JSON_ONLY)]) {
    assert.ok(k in richest || json.findings.some((f) => k in f), `the fixture leaves ${k} unset, so classifying it proves nothing`);
  }
});

test("FG-638: every RENDERED field's value actually appears in the human render", () => {
  const summary = fullyPopulatedReview();
  const human = renderReview(summary);
  const json = JSON.parse(JSON.stringify(summary)) as { review: Record<string, unknown>; findings: Record<string, unknown>[] };

  for (const key of REVIEW_RENDERED) {
    const value = json.review[key];
    assert.ok(value !== undefined, `fixture gap: review.${key} is unset`);
    assert.ok(human.includes(String(value)), `forge review show omits review.${key} (${String(value)}) that --json carries`);
  }

  for (const finding of json.findings) {
    for (const key of FINDING_RENDERED) {
      if (!(key in finding)) continue; // not every finding has every field set
      const value = finding[key];
      assert.ok(
        human.includes(String(value)),
        `forge review show omits ${String(finding.findingRef)}.${key} (${String(value)}) that --json carries`,
      );
    }
    // sources are rendered as labels, not as JSON — every reviewer must still be named.
    for (const source of finding.sources as { redRole?: string; verdictId?: string; modelFindingId?: string }[]) {
      const label = source.redRole ?? source.verdictId ?? (source.modelFindingId !== undefined ? "model-supplied id" : "unattributed");
      assert.ok(human.includes(label), `the human render drops the source '${label}' — provenance must not be summarized away`);
    }
  }

  // The summary block: lenses and both count maps and the unsettled tally.
  for (const lens of summary.riskLenses) assert.ok(human.includes(lens), `risk lens ${lens} missing from the render`);
  for (const [k, n] of Object.entries(summary.countsByDisposition)) assert.ok(human.includes(`${k} ${n}`), `disposition count ${k} ${n} missing`);
  for (const [k, n] of Object.entries(summary.countsByResolution)) assert.ok(human.includes(`${k} ${n}`), `resolution count ${k} ${n} missing`);
  assert.match(human, new RegExp(`unsettled findings:\\s+${summary.unsettledCount}\\b`));
});

test("FG-638: JSON-only fields are genuinely absent from the human render, so the classification is not decorative", () => {
  const summary = fullyPopulatedReview();
  const human = renderReview(summary);
  const json = JSON.parse(JSON.stringify(summary)) as { review: Record<string, unknown>; findings: Record<string, unknown>[] };

  for (const key of Object.keys(REVIEW_JSON_ONLY)) {
    const value = json.review[key];
    assert.ok(value !== undefined, `fixture gap: review.${key} is unset`);
    // Compare on the distinctive marker inside the object rather than its serialization.
    const marker = (value as { marker?: string }).marker;
    assert.ok(marker !== undefined, `fixture gap: review.${key} needs a distinctive marker`);
    assert.equal(human.includes(marker), false, `review.${key} is classified --json-only but its value appears in the human render`);
  }

  const richest = json.findings[0] as Record<string, unknown>;
  for (const key of Object.keys(FINDING_JSON_ONLY)) {
    const value = richest[key];
    if (value === undefined) continue;
    assert.equal(
      human.includes(String(value)),
      false,
      `finding.${key} is classified --json-only but appears in the human render — move it to FINDING_RENDERED`,
    );
  }
});

test("FG-638: the human render's finding blocks match the projection's findings, in order and count", () => {
  const summary = fullyPopulatedReview();
  const human = renderReview(summary);

  const refs = [...human.matchAll(/^ {2}(RF-\d+) \[/gm)].map((m) => m[1]);
  assert.deepEqual(
    refs,
    summary.findings.map((f) => f.findingRef),
    "every projected finding must get exactly one block, in the projection's order",
  );
  assert.equal(refs.length, summary.findings.length);
});

test("FG-638: an empty review renders the no-findings case rather than an empty section", () => {
  insertReview({ id: "review-empty", runId: RUN.id, reviewMode: "evidence_led", state: "confirming_contract" });
  const summary = summarizeReview("review-empty") as ReviewSummary;
  const human = renderReview(summary);

  assert.match(human, /Findings: none ingested yet/);
  assert.match(human, /dispositions:\s+—/, "an empty count map renders the dash, not an empty line");
  assert.match(human, /unsettled findings: 0/);
  // The JSON surface agrees: empty maps, empty array, zero.
  const json = JSON.parse(JSON.stringify(summary)) as { findings: unknown[]; countsByDisposition: object; unsettledCount: number };
  assert.deepEqual(json.findings, []);
  assert.deepEqual(json.countsByDisposition, {});
  assert.equal(json.unsettledCount, 0);
});
