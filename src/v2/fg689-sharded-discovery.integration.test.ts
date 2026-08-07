// FG-689 step 8: DISCOVERY, SCOPED AND SHARDED AND BOUNDED, through the real stage machine
// and the real store.
//
// Every test here is about an ORDERING or a DISTINCTION that a passing review would otherwise
// be able to fake:
//
//   * THE PLAN IS RECORDED BEFORE THE FIRST CONTAINER. What is OWED and what was DELIVERED
//     have different lifecycles, and the gate reads the first one. Recorded after the fan-out
//     it would not exist at the only moment it matters: a lens whose every shard crashed
//     delivers nothing, and an absence cannot say how many shards were expected. Proved by a
//     fake dispatcher that reads the review ROW mid-dispatch.
//   * ONE SURVIVING SHARD DOES NOT SATISFY A LENS (D1). The refusal names every shard that is
//     still owed, by lens and index.
//   * A SKIP IS NOT AN ABSENCE (AC3). A lens whose authored scope matched no changed path is
//     recorded intentionally skipped, satisfies completeness, contributes no observation, and
//     is a different rendered line at the gate from a lens that produced nothing.
//   * FAIL BY MEASUREMENT (AC6). A single file bigger than one shard's budget stops the review
//     citing the path, the measurement, the budget and the unit — before any container starts,
//     and with nothing truncated to make it fit.
//   * A RETRY PRESERVES COVERAGE (D7/D12). Re-entering discovery after one shard crashed
//     re-dispatches ONLY that shard and leaves the authored one byte-identical.
//   * THE FAN-OUT IS BOUNDED (D9). lens x shard is a bigger fan-out than one-per-lens ever
//     was, and this one does not route through the runner's limit.
//
// The dispatcher is a fake, deliberately: the subject is the stage's sequencing and its
// durable writes, not the container. What a real container is handed is covered at the wiring
// seam (review-wiring.test.ts).

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
  lensSkipRecordsOf,
  recordStageEvidence,
  type Review,
} from "../store/reviews.js";
import { runNextStage, type CoordinatorDeps, type LensContext } from "./review-run.js";
import { assessReviewDisposition } from "./review-gate.js";
import { nextTransition } from "./review-coordinator.js";
import { REVIEW_DIFF_RENDERING_ID, REVIEW_DIFF_SIZE_UNIT, type ReviewDiffFile, type ReviewDiffResult } from "./review-diff.js";
import { DEFAULT_SHARD_BUDGET } from "./review-shards.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg689-shard",
  workflow: "feature",
  title: "sharded discovery",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-shard";
const BASE = "base689";
const CONF = "conf689";

/** `wide` owns everything under src/, `backend` owns only the store. The fixtures below choose
 *  a rendering that makes one or the other own nothing, which is how the skip cases are
 *  reached without inventing a second contract. */
const CONTRACT = {
  threat_model: "a reviewer that cannot see the whole change reads its absence as evidence",
  protected_invariants: ["completeness is owed per shard"],
  acceptance_refs: ["FG-689 AC4", "FG-689 AC7"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: { wide: ["src/"], backend: ["src/store/"] },
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** A rendered per-file body of a chosen SIZE, so a test can put a file either side of a
 *  budget without a fixture the size of the thing it is measuring. The body is structurally a
 *  real one — header, index line, hunk — padded inside the hunk. */
function fileOf(path: string, chars: number): ReviewDiffFile {
  const head =
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1,1 +1,1 @@\n` +
    `-before\n` +
    `+`;
  const body = `${head}${"x".repeat(Math.max(1, chars - head.length - 1))}\n`;
  return { path, body, chars: Buffer.byteLength(body, "utf8"), utf16Chars: body.length };
}

function rendering(files: ReviewDiffFile[]): ReviewDiffResult {
  return {
    ok: true,
    rendering: {
      renderingId: REVIEW_DIFF_RENDERING_ID,
      unit: REVIEW_DIFF_SIZE_UNIT,
      baseSha: BASE,
      candidateSha: CONF,
      files,
      paths: files.map((f) => f.path),
      totalChars: files.reduce((n, f) => n + f.chars, 0),
      totalUtf16Chars: files.reduce((n, f) => n + f.utf16Chars, 0),
    },
  };
}

/** A review parked exactly where discovery is the next transition: entry verification and
 *  contract confirmation both recorded at the confirmed sha. */
function parkAtDiscovery(contract: unknown = CONTRACT): void {
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-689",
    reviewMode: "evidence_led",
    baseSha: BASE,
    candidateSha: CONF,
    contractConfirmedSha: CONF,
    contract,
    state: "discovering",
  });
  recordStageEvidence(REVIEW, "verified_entry", { sha: CONF, detail: "green" });
  recordStageEvidence(REVIEW, "contract_confirmed", { sha: CONF, detail: "confirmed unchanged" });
}

type LensBehaviour = (ctx: LensContext) => { ok: boolean; result?: unknown };

type Harness = {
  deps: CoordinatorDeps;
  /** Every dispatch, in the order the coordinator issued it. */
  calls: Array<{ lens: string; shard: number; of: number; paths: string[]; chars: number; digest: string }>;
  /** The greatest number of dispatches in flight at once. */
  peak: () => number;
  /** The shard plan as the review ROW held it when the FIRST dispatch began. */
  planAtFirstDispatch: () => Review["shardPlan"];
};

function harness(opts: {
  files: ReviewDiffFile[];
  lens?: LensBehaviour;
  budget?: number;
  /** Held open until released, so several dispatches can be genuinely in flight at once. */
  gate?: { wait: Promise<void> };
}): Harness {
  const calls: Harness["calls"] = [];
  let inFlight = 0;
  let peak = 0;
  let planAtFirst: Review["shardPlan"];
  const behaviour: LensBehaviour = opts.lens ?? (() => ({ ok: true, result: { outcome: "pass", findings: [] } }));

  const deps: CoordinatorDeps = {
    headSha: () => CONF,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "green" }),
    reviewDiff: () => rendering(opts.files),
    ...(opts.budget !== undefined ? { shardBudget: opts.budget } : {}),
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: async (ctx) => {
      if (calls.length === 0) planAtFirst = getReview(REVIEW)?.shardPlan;
      calls.push({
        lens: ctx.lens,
        shard: ctx.shard.index,
        of: ctx.shard.of,
        paths: [...ctx.paths],
        chars: Buffer.byteLength(ctx.diff, "utf8"),
        digest: ctx.derivationDigest,
      });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (opts.gate !== undefined) await opts.gate.wait;
      inFlight -= 1;
      const out = behaviour(ctx);
      return {
        lens: ctx.lens,
        role: ctx.role,
        dispatched: out.ok,
        ...(out.ok ? {} : { failureKind: "container_crash" }),
        taskId: `task-${ctx.lens}-${ctx.shard.index}`,
        result: out.result,
      };
    },
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: () => ({ ok: false, taskId: "", error: "unreachable" }),
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

  return { deps, calls, peak: () => peak, planAtFirstDispatch: () => planAtFirst };
}

const SMALL = 400;

// ─── the plan is written BEFORE the first container ─────────────────────────

test("FG-689: the shard plan is recorded BEFORE the first dispatch, and the dispatch is told the same digest", async () => {
  parkAtDiscovery();
  const h = harness({
    files: [fileOf("src/store/reviews.ts", SMALL), fileOf("src/v2/review-run.ts", SMALL)],
  });
  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "advanced", outcome.message);

  const seen = h.planAtFirstDispatch();
  assert.ok(seen, "the plan must already be on the review ROW when the first container starts");
  assert.deepEqual(
    seen!.lenses.map((l) => ({ lens: l.lens, shards: l.shards.length })),
    [
      { lens: "backend", shards: 1 },
      { lens: "wide", shards: 1 },
    ],
  );
  // Every dispatch is bound to THAT partition, not to one the seam invented.
  assert.deepEqual([...new Set(h.calls.map((c) => c.digest))], [seen!.digest]);
  assert.equal(getReview(REVIEW)?.shardPlan?.digest, seen!.digest, "and the recorded plan did not move under it");
});

test("FG-689: a lens's shards partition its owned paths exactly — nothing dropped, nothing doubled", async () => {
  parkAtDiscovery();
  const files = [
    fileOf("src/store/reviews.ts", SMALL),
    fileOf("src/store/schema.ts", SMALL),
    fileOf("src/v2/review-run.ts", SMALL),
  ];
  const h = harness({ files, budget: SMALL + 50 });
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const plan = getReview(REVIEW)!.shardPlan!;
  for (const lens of plan.lenses) {
    const union = lens.shards.flatMap((s) => s.paths);
    assert.equal(new Set(union).size, union.length, `${lens.lens}: a path appears in two shards`);
    // `wide` owns all three, `backend` the two under src/store.
    const owned = lens.lens === "wide" ? files.map((f) => f.path) : ["src/store/reviews.ts", "src/store/schema.ts"];
    assert.deepEqual([...union].sort(), [...owned].sort(), `${lens.lens}: the shards are not its owned set`);
  }
  // NOTHING WAS TRUNCATED to make a shard fit: each dispatch carried exactly its files' bytes.
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const call of h.calls) {
    const expected = call.paths.reduce((n, p) => n + (byPath.get(p)?.chars ?? 0), 0);
    assert.equal(call.chars, expected, `${call.lens} shard ${call.shard} was not handed its files whole`);
    assert.ok(call.chars <= SMALL + 50, "and no shard exceeded the budget as the host measures it");
  }
});

// ─── D1: one surviving shard does not satisfy a lens ────────────────────────

test("FG-689 D1: shard 1 authored and shard 2 crashed leaves the review INCOMPLETE, naming shard 2", async () => {
  parkAtDiscovery();
  const h = harness({
    files: [fileOf("src/store/reviews.ts", SMALL), fileOf("src/store/schema.ts", SMALL)],
    budget: SMALL + 50,
    lens: (ctx) =>
      ctx.lens === "wide" && ctx.shard.index === 2
        ? { ok: false }
        : { ok: true, result: { outcome: "pass", findings: [] } },
  });

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused", "one surviving shard must never satisfy a lens whose other shard crashed");
  assert.match(outcome.message, /wide shard 2 of 2/);
  assert.match(outcome.message, /Completeness is owed PER SHARD/);
  assert.ok(!outcome.message.includes("wide shard 1 of 2"), "the shard that DID come back is not blamed");

  // Nothing synthesized, nothing ingested, no stage record — discovery is re-entered.
  assert.equal(findingsForReview(REVIEW).length, 0);
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery, undefined);
  assert.equal(nextTransition({ review: getReview(REVIEW)!, findings: [], batches: [] }).kind, "discover");
});

test("FG-689 D1: a lens whose EVERY shard crashes names every one of them", async () => {
  parkAtDiscovery();
  const h = harness({
    files: [fileOf("src/store/reviews.ts", SMALL), fileOf("src/store/schema.ts", SMALL)],
    budget: SMALL + 50,
    lens: (ctx) => (ctx.lens === "backend" ? { ok: false } : { ok: true, result: { outcome: "pass", findings: [] } }),
  });

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /backend shard 1 of 2/);
  assert.match(outcome.message, /backend shard 2 of 2/);

  // ...and the gate says the same thing, from the durable row alone.
  const assessment = assessReviewDisposition({ review: getReview(REVIEW)!, findings: [] });
  const missing = assessment.conditions.find((c) => c.id === "lens_outcome_missing");
  assert.ok(missing, "an absent shard outcome still BLOCKS");
  assert.match(missing!.detail, /backend shard 1 of 2/);
  assert.match(missing!.detail, /backend shard 2 of 2/);
});

// ─── D7/D12: a retry preserves the coverage that already happened ────────────

test("FG-689 D7/D12: re-entering discovery re-dispatches ONLY the crashed shard and preserves the authored one", async () => {
  parkAtDiscovery();
  const files = [fileOf("src/store/reviews.ts", SMALL), fileOf("src/store/schema.ts", SMALL)];
  let crash = true;
  const first = harness({
    files,
    budget: SMALL + 50,
    lens: (ctx) =>
      crash && ctx.lens === "backend" && ctx.shard.index === 2
        ? { ok: false }
        : { ok: true, result: { outcome: "pass", findings: [] } },
  });
  assert.equal((await runNextStage(REVIEW, first.deps)).status, "refused");

  const authoredBefore = lensOutcomeRecordsOf(getReview(REVIEW)!).filter(
    (r) => (r as { lens: string; shard?: { index: number } }).lens === "backend" &&
      (r as { shard?: { index: number } }).shard?.index === 1,
  );
  assert.equal(authoredBefore.length, 1, "precondition: backend shard 1 authored an outcome");

  // The retry. Same inputs, so the same partition — the crashed shard is the only debt left.
  crash = false;
  const second = harness({ files, budget: SMALL + 50, lens: () => ({ ok: true, result: { outcome: "pass", findings: [] } }) });
  const outcome = await runNextStage(REVIEW, second.deps);
  assert.equal(outcome.status, "advanced", outcome.message);

  assert.deepEqual(
    second.calls.map((c) => `${c.lens} ${c.shard}`),
    ["backend 2"],
    "only the shard that still owed an outcome was re-dispatched",
  );
  const authoredAfter = lensOutcomeRecordsOf(getReview(REVIEW)!).filter(
    (r) => (r as { lens: string; shard?: { index: number } }).lens === "backend" &&
      (r as { shard?: { index: number } }).shard?.index === 1,
  );
  assert.deepEqual(authoredAfter, authoredBefore, "the already-authored shard's outcome survived BYTE-FOR-BYTE");
});

// ─── AC3: intentionally skipped is a third state ────────────────────────────

test("FG-689 AC3: a lens with no in-scope path is recorded skipped, satisfies completeness, and is never dispatched", async () => {
  parkAtDiscovery();
  // Only a path under src/v2 changed: `wide` owns it, `backend` (src/store/) owns nothing.
  const h = harness({ files: [fileOf("src/v2/review-run.ts", SMALL)] });
  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "advanced", outcome.message);
  assert.match(outcome.message, /backend.*intentionally skipped/);

  assert.deepEqual(h.calls.map((c) => c.lens), ["wide"], "a zero-path lens is never dispatched");

  const review = getReview(REVIEW)!;
  assert.deepEqual(review.shardPlan?.skipped, [{ lens: "backend", reason: "zero_in_scope_paths" }]);
  const skips = lensSkipRecordsOf(review);
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.lens, "backend");
  assert.equal(skips[0]?.derivationDigest, review.shardPlan?.digest, "the skip is bound to the partition it was decided under");

  // NOT AN OUTCOME. Nothing that reads outcomes can mistake it for a review that happened.
  assert.equal(
    lensOutcomeRecordsOf(review).some((r) => (r as { lens?: string }).lens === "backend"),
    false,
    "a skip must be invisible to every outcome consumer",
  );
  // ...and it contributed no finding.
  assert.equal(findingsForReview(REVIEW).length, 0);
});

test("FG-689 AC3: at the gate a skip and an absence are two different lines", async () => {
  parkAtDiscovery();
  const h = harness({ files: [fileOf("src/v2/review-run.ts", SMALL)] });
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const assessment = assessReviewDisposition({ review: getReview(REVIEW)!, findings: [] });
  assert.equal(
    assessment.conditions.some((c) => c.id === "lens_outcome_missing"),
    false,
    "a skipped lens is owed nothing, so nothing about it blocks",
  );
  const line = assessment.nonBlocking.find((a) => a.id === "lens_intentionally_skipped");
  assert.ok(line, "and it is REPORTED rather than being a silent absence");
  assert.match(line!.detail, /backend \(zero_in_scope_paths\)/);
  assert.match(line!.detail, /NOT a lens that produced no outcome/);
});

// ─── AC6: fail by measurement, before any container ─────────────────────────

test("FG-689 AC6: a single file larger than one shard's budget refuses, citing path, size, budget and unit", async () => {
  parkAtDiscovery();
  const oversize = fileOf("src/store/reviews.ts", 5_000);
  const h = harness({ files: [oversize, fileOf("src/v2/review-run.ts", SMALL)], budget: 1_000 });

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /src\/store\/reviews\.ts/, "the path is named");
  assert.match(outcome.message, new RegExp(String(oversize.chars)), "the HOST's measurement is cited");
  assert.match(outcome.message, /1000/, "against the budget");
  assert.match(outcome.message, /utf8_bytes/, "and the unit travels with it");
  assert.match(outcome.message, /NO container was started/);

  // NOTHING happened: no container, no plan, no stage record.
  assert.equal(h.calls.length, 0, "a measurement refusal must start no container");
  assert.equal(getReview(REVIEW)?.shardPlan, undefined, "and record no plan");
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery, undefined);
});

test("FG-689 AC5: nothing is truncated to make an oversize file fit — the review stops instead", async () => {
  parkAtDiscovery();
  const h = harness({ files: [fileOf("src/store/reviews.ts", 5_000)], budget: 1_000 });
  await runNextStage(REVIEW, h.deps);
  // The one observable proof at this layer: no dispatch happened at all, so no reviewer was
  // handed a partial file. (The packing code carries no slice/summarize path — see
  // fg689-sharding.test.ts, which greps it.)
  assert.equal(h.calls.length, 0);
  assert.equal(findingsForReview(REVIEW).length, 0);
});

// ─── D9: the fan-out is bounded ─────────────────────────────────────────────

test("FG-689 D9: concurrent dispatch never exceeds the plan's recorded fanoutWidth", async () => {
  parkAtDiscovery();
  // Twelve small files under src/store: `wide` and `backend` both own them, and a tight budget
  // cuts each lens into several shards — comfortably more dispatches than the width.
  const files = Array.from({ length: 12 }, (_, i) => fileOf(`src/store/f${i}.ts`, SMALL));
  let release = (): void => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const h = harness({ files, budget: SMALL * 2 + 50, gate: { wait } });

  const running = runNextStage(REVIEW, h.deps);
  // Let the lanes fill: every microtask that can start has started before anything completes.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  release();
  const outcome = await running;
  assert.equal(outcome.status, "advanced", outcome.message);

  const width = getReview(REVIEW)!.shardPlan!.fanoutWidth;
  assert.equal(width, 4, "the recorded default mirrors the runner's own fan-out limit");
  assert.ok(h.calls.length > width, `fixture: ${h.calls.length} dispatches must exceed the width to test it`);
  assert.ok(h.peak() <= width, `at most ${width} dispatches in flight; peaked at ${h.peak()}`);
  // ...and the bound is a CEILING that was actually reached, not a limit nothing approached —
  // otherwise this test would pass just as well against a fan-out of one.
  assert.equal(h.peak(), width, "the fixture must genuinely saturate the width it is testing");
});

// ─── the derivation the plan records ────────────────────────────────────────

test("FG-689 D10: the recorded derivation carries the budget WITH its unit and the runtime it was validated against", async () => {
  parkAtDiscovery();
  const h = harness({ files: [fileOf("src/v2/review-run.ts", SMALL), fileOf("src/store/reviews.ts", SMALL)] });
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const d = getReview(REVIEW)!.shardPlan!.derivation;
  assert.equal(d.budget, DEFAULT_SHARD_BUDGET, "the configured default, not one derived from a provider cap");
  assert.equal(d.unit, "utf8_bytes", "600,000 read as tokens is a 4x overshoot straight back into the crash");
  assert.equal(d.budgetValidatedRuntime, "unvalidated", "and it says plainly that no real dispatch has proven it yet");
  assert.equal(d.baseSha, BASE);
  assert.equal(d.candidateSha, CONF);
  assert.equal(d.renderingId, REVIEW_DIFF_RENDERING_ID, "the partition names the pinned flag set it was cut under");
});

test("FG-689: a rendering refusal dispatches NOTHING and records no plan", async () => {
  parkAtDiscovery();
  const h = harness({ files: [] });
  const deps: CoordinatorDeps = {
    ...h.deps,
    reviewDiff: () => ({ ok: false, reason: "diff_unreadable", refusal: "git exploded." }),
  };
  const outcome = await runNextStage(REVIEW, deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /git exploded\./);
  assert.match(outcome.message, /NO container was started/);
  assert.equal(h.calls.length, 0);
  assert.equal(getReview(REVIEW)?.shardPlan, undefined);
});

test("FG-689: discovery over a diff with an UNCOVERED path refuses and names it — no owner is invented", async () => {
  parkAtDiscovery();
  const h = harness({ files: [fileOf("dashboard/src/App.tsx", SMALL)] });
  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /dashboard\/src\/App\.tsx/);
  assert.match(outcome.message, /does not infer an owner from a filename/);
  assert.equal(h.calls.length, 0);
  assert.equal(getReview(REVIEW)?.shardPlan, undefined);
});
