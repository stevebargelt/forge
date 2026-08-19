// FG-682 (bounded late-docs amendment, Step 1): the durable amendment ledger.
//
// What these tests hold:
//   - a late-docs amendment records as a DEDICATED record — supersededSha, amendedSha,
//     the declared documentation paths, the rationale and who discovered it — read back
//     with lineage intact (AC6);
//   - the emitted `review.docs_amended` event carries the fromSha/toSha lineage;
//   - the record is INVISIBLE to every outcome consumer (it is not a review that
//     happened), and it survives a later whole-column outcomes write;
//   - the write is idempotent on the (superseded -> amended) pair, so a crash-replay
//     between the irreversible commit and this ledger write re-states rather than
//     double-records (the shape step 3's RF-2 recovery relies on);
//   - it does NOT touch the candidate_sha or contract_confirmed_sha columns — this step
//     is the ledger only, never candidate movement.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { eventsForRun } from "./events.js";
import {
  insertReview,
  getReview,
  recordDocsAmendment,
  amendmentRecordsOf,
  lensOutcomeRecordsOf,
  replaceLensOutcomes,
} from "./reviews.js";
import type { Run, Task } from "../types/index.js";

const RUN: Run = {
  id: "run-fg682",
  workflow: "feature",
  title: "amendment ledger",
  status: "active",
  createdAt: "2026-08-19T00:00:00Z",
  reviewMode: "evidence_led",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

function task(id: string): Task {
  return {
    id,
    runId: RUN.id,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-08-19T00:00:00Z",
  };
}

function newReview(id = "review-1"): string {
  insertReview({
    id,
    runId: RUN.id,
    subjectTaskId: "task-subject",
    ticketId: "FG-682",
    reviewMode: "evidence_led",
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: "1fa62358",
    contract: {
      threat_model: "operator_trusted_candidate",
      risk_lenses: ["backend", "security"],
      lens_scopes: { backend: ["src/"], security: ["src/store/"] },
    },
    state: "shipping_review",
  });
  return id;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(task("task-subject"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-682: an amendment records and reads back with full lineage intact", () => {
  newReview();
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md", "docs/dispatch.md"],
    rationale: "the batch collapsed all three dispatch lanes into one resolver, falsifying the dependencyEnvironment receipt prose",
    discoveredBy: "orchestrator",
  });

  const records = amendmentRecordsOf(getReview("review-1")!);
  assert.equal(records.length, 1);
  const a = records[0]!;
  assert.equal(a.kind, "docs_amendment");
  assert.equal(a.supersededSha, "1fa62358");
  assert.equal(a.amendedSha, "c6a3b8c2");
  assert.deepEqual(a.paths, ["docs/SCHEMA-CONTRACT.md", "docs/dispatch.md"]);
  assert.match(a.rationale, /falsifying the dependencyEnvironment receipt/);
  assert.equal(a.discoveredBy, "orchestrator");
  assert.equal(typeof a.at, "string");
  assert.notEqual(a.at, "");
});

test("FG-682: the emitted event carries fromSha/toSha", () => {
  newReview();
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "three-line prose correction discovered after the docs stage",
    discoveredBy: "reviewer",
  });

  const events = eventsForRun(RUN.id).filter((e) => e.eventType === "review.docs_amended");
  assert.equal(events.length, 1, "exactly one amendment event");
  const payload = events[0]!.payload as {
    reviewId: string;
    fromSha: string;
    toSha: string;
    paths: string[];
    rationale: string;
    discoveredBy: string;
  };
  assert.equal(payload.reviewId, "review-1");
  assert.equal(payload.fromSha, "1fa62358");
  assert.equal(payload.toSha, "c6a3b8c2");
  assert.deepEqual(payload.paths, ["docs/SCHEMA-CONTRACT.md"]);
  assert.equal(payload.discoveredBy, "reviewer");
});

test("FG-682: an amendment is NOT a review outcome — invisible to outcome consumers", () => {
  newReview();
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "prose delta",
    discoveredBy: "orchestrator",
  });

  // A reviewer-authored outcome sits in the same column; the amendment must never be
  // counted as one — an amendment is a candidate move, not a review that happened.
  assert.deepEqual(
    lensOutcomeRecordsOf(getReview("review-1")!),
    [],
    "the amendment record must not read back as a lens outcome",
  );
});

test("FG-682: the amendment survives a later whole-column outcomes write", () => {
  newReview();
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "prose delta",
    discoveredBy: "orchestrator",
  });

  // replaceLensOutcomes rewrites the reviewer-authored half of the column; it must
  // PRESERVE the amendment (a non-outcome record), or the ledger would lose lineage the
  // next time discovery outcomes are written.
  const outcome = { lens: "backend", complete: true, authored: true };
  replaceLensOutcomes("review-1", [outcome]);

  const after = getReview("review-1")!;
  assert.equal(amendmentRecordsOf(after).length, 1, "the amendment survives the outcomes rewrite");
  assert.deepEqual(lensOutcomeRecordsOf(after), [outcome], "the new outcome is the only outcome");
});

test("FG-682: idempotent on the (superseded -> amended) pair — a replay re-states, never double-records", () => {
  newReview();
  const args = {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "prose delta",
    discoveredBy: "orchestrator",
  };
  recordDocsAmendment("review-1", { ...args });
  recordDocsAmendment("review-1", { ...args });

  assert.equal(amendmentRecordsOf(getReview("review-1")!).length, 1, "the replay adds no second record");
  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.docs_amended").length,
    1,
    "the replay emits no second event",
  );
});

test("FG-682 RF-1: recordDocsAmendment signals recorded, then duplicate, on a replay of the same pair", () => {
  newReview();
  const args = {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "prose delta",
    discoveredBy: "orchestrator",
  };
  const first = recordDocsAmendment("review-1", { ...args });
  assert.equal(first.persisted, "recorded", "the first write persisted the record");
  const replay = recordDocsAmendment("review-1", { ...args });
  assert.equal(replay.persisted, "duplicate", "the idempotent replay is a benign duplicate, lineage already present");
  assert.equal(amendmentRecordsOf(getReview("review-1")!).length, 1, "still exactly one record");
});

test("FG-682 RF-1: a NON-ARRAY outcomes column is LEFT ALONE and signalled skipped_nonarray — never clobbered", () => {
  newReview();
  // The no-clobber refusal: a non-array outcomes column holds something this writer must not
  // overwrite. It writes NOTHING and says so, so the caller can refuse to advance (RF-3).
  db.prepare(`UPDATE reviews SET lens_outcomes_json = ? WHERE id = ?`).run(JSON.stringify({ corrupt: true }), "review-1");
  const before = getReview("review-1")!.lensOutcomes;

  const write = recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "would lose lineage if it clobbered the column",
    discoveredBy: "orchestrator",
  });

  assert.equal(write.persisted, "skipped_nonarray", "the write reports that it persisted nothing");
  assert.deepEqual(getReview("review-1")!.lensOutcomes, before, "the non-array column is untouched");
  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.docs_amended").length,
    0,
    "no amendment event was emitted for a write that did not persist",
  );
});

test("FG-682: a DIFFERENT amended sha is a distinct amendment — lineage is a chain", () => {
  newReview();
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/a.md"],
    rationale: "first correction",
    discoveredBy: "orchestrator",
  });
  recordDocsAmendment("review-1", {
    supersededSha: "c6a3b8c2",
    amendedSha: "9d0e1f22",
    paths: ["docs/b.md"],
    rationale: "second correction",
    discoveredBy: "reviewer",
  });

  const records = amendmentRecordsOf(getReview("review-1")!);
  assert.equal(records.length, 2, "two distinct amendments");
  // Oldest first: the chain walks superseded -> amended across the list.
  assert.equal(records[0]!.supersededSha, "1fa62358");
  assert.equal(records[0]!.amendedSha, "c6a3b8c2");
  assert.equal(records[1]!.supersededSha, "c6a3b8c2");
  assert.equal(records[1]!.amendedSha, "9d0e1f22");
});

test("FG-682: recording an amendment touches neither candidate_sha nor contract_confirmed_sha", () => {
  newReview();
  const before = getReview("review-1")!;
  recordDocsAmendment("review-1", {
    supersededSha: "1fa62358",
    amendedSha: "c6a3b8c2",
    paths: ["docs/SCHEMA-CONTRACT.md"],
    rationale: "the ledger records the move; it does not perform it",
    discoveredBy: "orchestrator",
  });
  const after = getReview("review-1")!;
  // Step 1 is the ledger ONLY. Candidate movement and the frozen anchor are out of scope
  // here (step 3 advances the candidate; contractConfirmedSha is never touched by the
  // amendment at all).
  assert.equal(after.candidateSha, before.candidateSha, "candidate_sha unmoved by the ledger write");
  assert.equal(after.contractConfirmedSha, before.contractConfirmedSha, "contract_confirmed_sha untouched");
});
