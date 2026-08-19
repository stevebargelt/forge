// FG-689 AC6, FAIL BY MEASUREMENT: an input that still cannot fit stops the review, citing the
// host's own measurement against the budget and naming the unit.
//
// WHY THIS FIXTURE IS SYNTHETIC, AND WHY THAT MUST BE SAID OUT LOUD. FG-689's dogfood candidate
// CANNOT reach this path: the largest single file in the pinned rendering of
// `11c2b561..c4fe691a` is `src/cli/commands/queue.ts` at 80,462 bytes, an order of magnitude
// inside the 600,000-byte budget, and a shard can never be made smaller than one file. So a
// green dogfood proves multi-shard review end to end and proves NOTHING about this criterion.
// The first assertion below locks that gap open on purpose, so nobody can later report AC6 as
// covered by the dogfood run.
//
// WHAT WOULD MAKE THIS FAIL SILENTLY, which is what the tests are shaped around. The tempting
// fix for a file that does not fit is to make it fit — head/tail it, sample its hunks, hand the
// reviewer a summary. Every one of those produces a reviewer who authors an honest, schema-valid
// `pass` over a change they did not see, which clears the disposition gate. That is precisely
// the failure FG-689 exists to remove, so the refusal here is asserted to be TOTAL: no
// container, no plan, no stage record, no finding, and a gate that still blocks afterwards.
//
// The last two tests make the refusal falsifiable. It is about the MEASUREMENT, not about the
// file: the same fixture at a budget one byte below the file refuses, and at exactly the file's
// size reviews to completion. If the refusal fired for some other reason, both would behave the
// same and the pair would fail.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import {
  findingsForReview,
  getReview,
  insertReview,
  lensOutcomeRecordsOf,
  recordStageEvidence,
  type Review,
} from "../store/reviews.js";
import { runNextStage, type CoordinatorDeps, type LensContext } from "./review-run.js";
import { nextTransition } from "./review-coordinator.js";
import { assessReviewDisposition } from "./review-gate.js";
import {
  REVIEW_DIFF_RENDERING_ID,
  REVIEW_DIFF_SIZE_UNIT,
  type ReviewDiffFile,
  type ReviewDiffResult,
} from "./review-diff.js";
import { DEFAULT_SHARD_BUDGET } from "./review-shards.js";
import type { Run } from "../types/index.js";

/** The largest single file in FG-689's dogfood candidate (`src/cli/commands/queue.ts` in the
 *  pinned rendering of `11c2b561..c4fe691a`). Recorded here as the reason this file exists. */
const LARGEST_DOGFOOD_FILE_BYTES = 80_462;

/** One file, deliberately larger than the shipped budget. Nothing about this size is special
 *  beyond being over — the point is that it is a SINGLE file, so no partition of the change can
 *  put it in a shard that fits. */
const OVERSIZE_BYTES = 742_301;
const OVERSIZE_PATH = "src/store/generated-schema.ts";

const RUN: Run = {
  id: "run-fg689-unfittable",
  workflow: "feature",
  title: "one file bigger than a shard",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-unfittable";
const BASE = "base689u";
const CONF = "conf689u";

/** Both lenses own the oversize file: an unfittable file blocks every lens that owns it, and a
 *  refusal that named only the first would leave an operator raising the budget, re-running, and
 *  meeting the same wall from the other side. */
const CONTRACT = {
  threat_model: "a file made to fit is a review of something that is not the change",
  protected_invariants: ["no diff is truncated, sampled or summarized to make it fit"],
  acceptance_refs: ["FG-689 AC5", "FG-689 AC6"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: { wide: ["src"], backend: ["src/store"] },
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-689",
    reviewMode: "evidence_led",
    baseSha: BASE,
    candidateSha: CONF,
    contractConfirmedSha: CONF,
    contract: CONTRACT,
    state: "discovering",
  });
  recordStageEvidence(REVIEW, "verified_entry", { sha: CONF, detail: "green" });
  recordStageEvidence(REVIEW, "contract_confirmed", { sha: CONF, detail: "confirmed unchanged" });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** A rendered body of exactly `chars` UTF-8 bytes, structurally a real per-file diff. The bytes
 *  are real bytes so the size the refusal cites is a size the host actually measured. */
function fileOf(path: string, chars: number): ReviewDiffFile {
  const head =
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1,1 +1,1 @@\n` +
    `-before\n` +
    `+`;
  const body = `${head}${"x".repeat(chars - head.length - 1)}\n`;
  return { path, body, chars: Buffer.byteLength(body, "utf8"), utf16Chars: body.length };
}

const OVERSIZE = fileOf(OVERSIZE_PATH, OVERSIZE_BYTES);
const SMALL = fileOf("src/v2/review-run.ts", 4_096);
const FILES = [OVERSIZE, SMALL];

function rendering(): ReviewDiffResult {
  return {
    ok: true,
    rendering: {
      renderingId: REVIEW_DIFF_RENDERING_ID,
      unit: REVIEW_DIFF_SIZE_UNIT,
      baseSha: BASE,
      candidateSha: CONF,
      files: FILES,
      paths: FILES.map((f) => f.path),
      totalChars: FILES.reduce((n, f) => n + f.chars, 0),
      totalUtf16Chars: FILES.reduce((n, f) => n + f.utf16Chars, 0),
    },
  };
}

type Dispatched = { lens: string; shard: number; paths: string[]; bytes: number };

function harness(budget?: number): { deps: CoordinatorDeps; calls: Dispatched[] } {
  const calls: Dispatched[] = [];
  const deps: CoordinatorDeps = {
    headSha: () => CONF,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "green" }),
    reviewDiff: () => rendering(),
    ...(budget !== undefined ? { shardBudget: budget } : {}),
    // FG-689 RF-1: an explicit ZERO dispatch envelope — this harness is not exercising the
    // composed-input reserve, and an ABSENT measurement refuses by design.
    measureLensEnvelope: () => 0,
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx: LensContext) => {
      calls.push({
        lens: ctx.lens,
        shard: ctx.shard.index,
        paths: [...ctx.paths],
        bytes: Buffer.byteLength(ctx.diff, "utf8"),
      });
      return {
        lens: ctx.lens,
        role: ctx.role,
        dispatched: true,
        taskId: `task-${ctx.lens}-${ctx.shard.index}`,
        result: { outcome: "pass", findings: [] },
      };
    },
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: () => ({ ok: false, taskId: "", error: "unreachable" }),
    captureFixWorkspace: () => ({ diffPatch: "", porcelainStatus: "" }),
    dispatchFixRepair: () => ({ ok: false, taskId: "", error: "no repair in this test" }),
    commitFixCycle: () => ({ kind: "no_change", sha: CONF }),
    dispatchDocs: () => {
      throw new Error("unreachable");
    },
    docsDelivery: () => {
      throw new Error("unreachable");
    },
    commitDocsCycle: () => {
      throw new Error("unreachable");
    },
    dispatchRechecker: () => {
      throw new Error("unreachable");
    },
    shippingInput: () => {
      throw new Error("unreachable");
    },
  };
  return { deps, calls };
}

// ─── the dogfood provably cannot cover this criterion ───────────────────────

test("FG-689 AC6: the dogfood candidate CANNOT exercise this path, so the fixture is synthetic", () => {
  assert.ok(
    LARGEST_DOGFOOD_FILE_BYTES < DEFAULT_SHARD_BUDGET,
    `the largest file in 11c2b561..c4fe691a is ${LARGEST_DOGFOOD_FILE_BYTES} bytes against a ${DEFAULT_SHARD_BUDGET}-byte ` +
      `budget — every file in the dogfood fits by an order of magnitude, so a green dogfood says nothing about AC6`,
  );
  assert.ok(
    OVERSIZE.chars > DEFAULT_SHARD_BUDGET,
    "this file's fixture must be over the SHIPPED budget, not over a shrunken test one",
  );
  assert.equal(OVERSIZE.chars, OVERSIZE_BYTES, "and the body really is the size the fixture claims");
});

// ─── AC6: the refusal cites the measurement, the budget and the unit ─────────

test("FG-689 AC6: a single file larger than one shard refuses, citing the path, the measurement, the budget and the unit", async () => {
  const h = harness();
  const outcome = await runNextStage(REVIEW, h.deps);

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, new RegExp(OVERSIZE_PATH.replace(/[/.]/g, "\\$&")), "the path is named");
  assert.match(
    outcome.message,
    new RegExp(String(OVERSIZE.chars)),
    "the HOST's own measurement is cited — not an estimate, and not the provider's number",
  );
  assert.match(outcome.message, new RegExp(String(DEFAULT_SHARD_BUDGET)), "against the budget it was measured against");
  assert.match(outcome.message, new RegExp(REVIEW_DIFF_SIZE_UNIT), "and the unit travels with both numbers (D10)");

  // The refusal states the thing it refuses to do, so an operator reading it cannot conclude
  // that forge quietly shortened the file and carried on.
  assert.match(outcome.message, /truncated, sampled or summarized/);
  assert.match(outcome.message, /No container was started/);

  // BOTH owning lenses are named: raising the budget for one and re-running would otherwise walk
  // straight into the same wall from the other side.
  assert.match(outcome.message, /wide/);
  assert.match(outcome.message, /backend/);
});

test("FG-689 AC6: the refusal is TOTAL — no container, no plan, no stage record, no finding", async () => {
  const h = harness();
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "refused");

  const review = getReview(REVIEW) as Review;
  assert.deepEqual(h.calls, [], "a measurement refusal must start no container");
  assert.equal(review.shardPlan, undefined, "and record no shard plan — nothing was owed because nothing was planned");
  assert.equal(review.stageEvidence?.discovery, undefined, "and write no discovery stage record");
  assert.deepEqual(lensOutcomeRecordsOf(review), [], "and record no outcome");
  assert.equal(findingsForReview(REVIEW).length, 0);

  // The one file that DOES fit was not reviewed either. A partial panel over the fittable
  // remainder is the same fail-open in a smaller costume: it would report a completed review of
  // a change one of whose files nobody read.
  assert.equal(nextTransition({ review, findings: [], batches: [] }).kind, "discover");
});

test("FG-689 AC5: a diff that could not fit never becomes a clean review — the gate still blocks", async () => {
  const h = harness();
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "refused");

  const review = getReview(REVIEW) as Review;
  const gate = assessReviewDisposition({ review, findings: findingsForReview(REVIEW) });
  assert.equal(gate.blocked, true, "a review that never dispatched must not read as dispositionable");
  const blocking = gate.conditions.find((c) => c.id === "shard_plan_absent");
  assert.ok(blocking, "a readable contract with no recorded plan is its own blocking condition");
  assert.match(blocking!.detail, /unrecorded expectation is unestablished coverage/);

  // Re-entering does not wear the refusal down. The same measurement produces the same refusal,
  // and no amount of retrying converges on a dispatch.
  const again = await runNextStage(REVIEW, harness().deps);
  assert.equal(again.status, "refused");
  assert.match(again.message, new RegExp(String(OVERSIZE.chars)));
  assert.equal(getReview(REVIEW)?.shardPlan, undefined);
});

// ─── the refusal is about the MEASUREMENT, not about the file ───────────────

test("FG-689 AC6: at a budget one byte below the file it refuses; at exactly the file's size it reviews", async () => {
  const tight = harness(OVERSIZE.chars - 1);
  const refused = await runNextStage(REVIEW, tight.deps);
  assert.equal(refused.status, "refused", "one byte over is over");
  assert.match(refused.message, new RegExp(String(OVERSIZE.chars - 1)), "the refusal cites the budget in force");
  assert.deepEqual(tight.calls, []);

  const exact = harness(OVERSIZE.chars);
  const advanced = await runNextStage(REVIEW, exact.deps);
  assert.equal(advanced.status, "advanced", advanced.message);

  // The SAME file, whole, in one shard — the refusal was about the measurement against the
  // budget and nothing else, and nothing was shaved off to reach this.
  const wide = exact.calls.filter((c) => c.lens === "wide");
  assert.equal(wide.length, 2, "wide owns both files; at this budget the oversize one fills a shard by itself");
  const carrying = wide.find((c) => c.paths.includes(OVERSIZE_PATH));
  assert.ok(carrying);
  assert.deepEqual(carrying!.paths, [OVERSIZE_PATH], "the file that could not share a shard gets its own");
  assert.equal(carrying!.bytes, OVERSIZE.chars, "and it is handed over WHOLE, byte for byte");
});

test("FG-689 AC6: raising the budget is the only remedy the refusal offers, and it is an operator decision", async () => {
  const refused = await runNextStage(REVIEW, harness().deps);
  assert.equal(refused.status, "refused");
  // The remedy is named, and it is named as something that must be VALIDATED — the budget is a
  // configured number with reserve against an envelope the host cannot see, so raising it is a
  // measurement of a provider, not an arithmetic adjustment.
  assert.match(refused.message, /--shard-budget/);
  assert.match(refused.message, /only if a real dispatch validates the larger number, or split the file/);
});
