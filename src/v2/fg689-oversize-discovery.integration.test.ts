// FG-689 AC7, the regression for the crash this ticket exists to fix: A DIFF LARGER THAN ONE
// REVIEWER'S BUDGET, driven end to end through discovery.
//
// FG-591's review died with `input_too_large` — 1,174,814 characters against a 1,048,576 cap —
// on all five selected lenses at once, because each lens was handed the WHOLE unscoped diff and
// the diff alone measured 1,170,885 bytes. That is the input class this file re-runs. The
// fixture is not a scaled-down stand-in: it is the measured per-file byte distribution of the
// pinned rendering of `11c2b561..c4fe691a`, 46 files totalling 1,170,885 bytes, reviewed at the
// REAL `DEFAULT_SHARD_BUDGET`. A test that shrank both the diff and the budget would exercise
// the arithmetic and prove nothing about the number the system actually ships with.
//
// The four properties FG-689's AC7 names, and why each is here rather than assumed:
//
//   1. EVERY SELECTED LENS AUTHORED AN OUTCOME FOR EVERY SHARD. Not "the review advanced" —
//      advancing is what the old code did too. Every shard the plan named is matched against a
//      ledger record that is `complete`, `authored`, and carries that shard's identity and the
//      partition it was cut under.
//   2. NO SHARD'S COMPOSED INPUT EXCEEDED THE BUDGET, measured the way the HOST measures it
//      (`Buffer.byteLength` of the bytes actually handed to the dispatch), not the way the plan
//      predicted it would. The plan's arithmetic being right and the dispatch's bytes being
//      right are two claims, and only the second one is what crashed.
//   3. THE SHARD PATH UNION IS EXACTLY THE PINNED CHANGED-PATH SET. A dropped path is a surface
//      nobody reviewed, reported as a completed review — the failure mode that survives every
//      other check in this file.
//   4. NOTHING WAS TRUNCATED, SAMPLED OR SUMMARIZED. Asserted by REASSEMBLY, not by grep: the
//      lens that owns the whole change is handed shards which, concatenated in index order,
//      reproduce the rendering byte for byte. A truncation of any single byte fails it.
//
// And the regression is FALSIFIABLE — the last three tests make it fail on a partial panel, on
// a reviewer that never authored, and on output that is not schema-valid. A green regression
// that cannot go red is the thing being tested here, so it is tested.
//
// The dispatcher is a fake: the subject is what the coordinator COMPOSES and RECORDS at this
// scale, not the container. What a real container is handed is the wiring seam's test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import {
  findingsForReview,
  getReview,
  insertReview,
  lensAcceptancesOf,
  lensOutcomeRecordsOf,
  lensSkipRecordsOf,
  recordStageEvidence,
  type Review,
} from "../store/reviews.js";
import { runNextStage, type CoordinatorDeps, type LensContext } from "./review-run.js";
import { assessReviewDisposition } from "./review-gate.js";
import { assessShardCompleteness, LENS_OUTCOMES, type LensOutcome } from "./review-discovery.js";
import {
  REVIEW_DIFF_RENDERING_ID,
  REVIEW_DIFF_SIZE_UNIT,
  type ReviewDiffFile,
  type ReviewDiffResult,
} from "./review-diff.js";
import { DEFAULT_SHARD_BUDGET } from "./review-shards.js";
import type { Run } from "../types/index.js";

/** The provider cap FG-591's dispatch hit, and the size it reported hitting it with. Recorded
 *  here as the thing this regression is about: every dispatch below is asserted to be comfortably
 *  under the first number, and the fixture is asserted to be larger than it in total — so a
 *  system that stopped sharding would fail this file rather than quietly re-crashing in the
 *  field. */
const PROVIDER_CAP_THAT_CRASHED = 1_048_576;
const FG591_REPORTED_INPUT = 1_174_814;

/** [path, utf8 bytes] for every file in the pinned rendering of `11c2b561..c4fe691a` —
 *  FG-591's candidate, the review that could not be reviewed. Measured, not invented. */
const FG591_FILES: [string, number][] = [
  ["dashboard/browser-tests/fg591-queue-board.test.ts", 29618],
  ["dashboard/client/main.js", 3375],
  ["dashboard/client/queue-board-state.d.ts", 4972],
  ["dashboard/client/queue-board-state.js", 21743],
  ["dashboard/client/queue-board.js", 22511],
  ["dashboard/client/view-routing.js", 533],
  ["dashboard/src/fg591-queue-board-state.test.ts", 25287],
  ["dashboard/src/fg591-queue-mutation.integration.test.ts", 32566],
  ["dashboard/src/fg591-queue-projection.test.ts", 13443],
  ["dashboard/src/fg591-queue-routes.integration.test.ts", 27720],
  ["dashboard/src/fg642-browser-tier-fail-first.integration.test.ts", 2229],
  ["dashboard/src/queries.ts", 55506],
  ["dashboard/src/queue-mutation.ts", 30791],
  ["dashboard/src/server.ts", 10024],
  ["dashboard/src/shell.ts", 7814],
  ["docs/SCHEMA-CONTRACT.md", 31488],
  ["docs/concepts.md", 14886],
  ["docs/invariants.md", 5515],
  ["docs/quick-start.md", 7715],
  ["learnings/decisions/2026-08-06_queue-dispatch-capacity-and-authorization.md", 17739],
  ["src/cli/commands/fg591-dispatcher-cli.integration.test.ts", 37144],
  ["src/cli/commands/fg591-docs-parity.test.ts", 18922],
  ["src/cli/commands/fg591-queue-cli.integration.test.ts", 30179],
  ["src/cli/commands/queue.ts", 80462],
  ["src/cli/program.ts", 928],
  ["src/queue/compatibility.ts", 31344],
  ["src/queue/dispatch-cycle.ts", 24562],
  ["src/queue/dispatch-execution.ts", 52974],
  ["src/queue/dispatcher-loop.ts", 47188],
  ["src/queue/fg591-compatibility.test.ts", 37879],
  ["src/queue/fg591-dispatch-cycle.test.ts", 31556],
  ["src/queue/fg591-dispatch-execution.test.ts", 46590],
  ["src/queue/fg591-dispatch-worker.ts", 18928],
  ["src/queue/fg591-dispatch.integration.test.ts", 54943],
  ["src/queue/fg591-dispatcher-loop.test.ts", 41142],
  ["src/queue/fg591-falsification-worker.ts", 10422],
  ["src/queue/fg591-falsification.integration.test.ts", 31818],
  ["src/store/dispatcher-evidence.ts", 31173],
  ["src/store/dispatcher-policy.ts", 33031],
  ["src/store/fg591-dispatcher-evidence.test.ts", 31710],
  ["src/store/fg591-dispatcher-policy.test.ts", 31697],
  ["src/store/fg591-migration-aged-shape.test.ts", 28722],
  ["src/store/fg591-queue-relative-rank.test.ts", 19768],
  ["src/store/queue.ts", 15328],
  ["src/store/schema.ts", 14387],
  ["src/util/fg642-browser-tier-consistency.test.ts", 2613],
];

/** A rendered body of exactly `chars` UTF-8 bytes, structurally a real per-file diff — header,
 *  index line, hunk — padded inside the hunk. The bytes have to be REAL bytes: the reassembly
 *  assertion below compares what the dispatch was handed against what the rendering held, and a
 *  fixture whose bodies were placeholders would compare two placeholders. */
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

const FILES: ReviewDiffFile[] = FG591_FILES.map(([p, c]) => fileOf(p, c));
const TOTAL_BYTES = FILES.reduce((n, f) => n + f.chars, 0);

const RUN: Run = {
  id: "run-fg689-oversize",
  workflow: "feature",
  title: "a diff larger than one reviewer's budget",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-oversize";
const BASE = "11c2b561";
const CONF = "c4fe691a";

/** `wide` owns the whole change (2 shards at the real budget); `backend` owns the two server
 *  trees (2 shards). Two lenses with more than one shard each is the shape AC7 is about: a
 *  single-shard lens would satisfy every assertion below without the sharding ever being
 *  exercised. */
const CONTRACT = {
  threat_model: "a reviewer handed more than it can read reads nothing and says so with a crash",
  protected_invariants: ["every shard of every selected lens owes an authored outcome"],
  acceptance_refs: ["FG-689 AC7", "FG-689 AC8"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: {
    wide: ["dashboard", "docs", "learnings", "src"],
    backend: ["src/queue", "src/store"],
  },
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
      totalChars: TOTAL_BYTES,
      totalUtf16Chars: FILES.reduce((n, f) => n + f.utf16Chars, 0),
    },
  };
}

type Dispatched = {
  lens: string;
  shard: number;
  of: number;
  paths: string[];
  /** What the HOST measures of the bytes it handed over — not what the plan predicted. */
  bytes: number;
  diff: string;
  digest: string;
};

type Reviewer = (ctx: LensContext) => { ok: boolean; result?: unknown };

const PASS: Reviewer = () => ({ ok: true, result: { outcome: "pass", findings: [] } });

function harness(reviewer: Reviewer = PASS): { deps: CoordinatorDeps; calls: Dispatched[] } {
  const calls: Dispatched[] = [];
  const deps: CoordinatorDeps = {
    headSha: () => CONF,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "green" }),
    reviewDiff: () => rendering(),
    // FG-689 RF-1: an explicit ZERO dispatch envelope — this harness is not exercising the
    // composed-input reserve, and an ABSENT measurement refuses by design.
    measureLensEnvelope: () => 0,
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx) => {
      calls.push({
        lens: ctx.lens,
        shard: ctx.shard.index,
        of: ctx.shard.of,
        paths: [...ctx.paths],
        bytes: Buffer.byteLength(ctx.diff, "utf8"),
        diff: ctx.diff,
        digest: ctx.derivationDigest,
      });
      const out = reviewer(ctx);
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
  return { deps, calls };
}

/** Every reviewer-authored outcome the ledger holds, typed. Acceptances, skip records and
 *  protocol receipts are filtered by the accessor, so nothing that is not an outcome arrives. */
function outcomes(review: Review): LensOutcome[] {
  return lensOutcomeRecordsOf(review) as LensOutcome[];
}

function completeness(review: Review) {
  return assessShardCompleteness(review.shardPlan!, outcomes(review), {
    acceptances: lensAcceptancesOf(review),
    skips: lensSkipRecordsOf(review),
    candidateSha: CONF,
  });
}

// ─── the fixture is genuinely the crashing input class ──────────────────────

test("FG-689 AC7 fixture: the change is FG-591's — 46 files, 1,170,885 bytes, larger than the cap that crashed", () => {
  assert.equal(FILES.length, 46);
  assert.equal(TOTAL_BYTES, 1_170_885, "the measured rendering of 11c2b561..c4fe691a");
  assert.ok(
    TOTAL_BYTES > PROVIDER_CAP_THAT_CRASHED,
    `the whole change (${TOTAL_BYTES}) must exceed the ${PROVIDER_CAP_THAT_CRASHED}-byte cap FG-591 hit, or this ` +
      `file is not the regression it claims to be`,
  );
  assert.ok(TOTAL_BYTES > DEFAULT_SHARD_BUDGET, "and exceed one reviewer's budget, so it CANNOT be one dispatch");
  assert.ok(
    FILES.every((f) => f.chars <= DEFAULT_SHARD_BUDGET),
    "no single file is unfittable here — that path is a different criterion and has its own fixture " +
      "(fg689-unfittable-refusal.test.ts)",
  );
  // The host measured 1,170,885 and the provider reported 1,174,814 for the same dispatch. The
  // ~4k gap is forge's envelope and the provider's own, and it is why the budget is a configured
  // number with reserve rather than one derived from the cap.
  assert.ok(FG591_REPORTED_INPUT > TOTAL_BYTES);
});

// ─── AC7: every selected lens, every shard, an authored outcome ──────────────

test("FG-689 AC7: a diff larger than one reviewer's budget reviews END TO END, every lens x shard authored", async () => {
  const h = harness((ctx) =>
    // One shard authors a real finding, so the end-to-end path includes ingestion rather than
    // only the empty-pass path.
    ctx.lens === "wide" && ctx.shard.index === 1
      ? {
          ok: true,
          result: {
            outcome: "fail",
            findings: [
              {
                summary: "the dispatcher can start a cycle it cannot finish",
                evidence: "capacity is read before the lock is taken",
                severity: "high",
                risk_lens: "wide",
                reachability: "demonstrated",
                challenges_contract: false,
                remediation_advice: "take the lock first",
                file: "src/cli/commands/queue.ts",
                line: 12,
              },
            ],
          },
        }
      : { ok: true, result: { outcome: "pass", findings: [] } },
  );

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "advanced", outcome.message);

  const review = getReview(REVIEW) as Review;
  const plan = review.shardPlan!;

  // The change really was cut up: more dispatches than lenses, and every lens sharded.
  assert.deepEqual(
    plan.lenses.map((l) => [l.lens, l.shards.length]),
    [
      ["backend", 2],
      ["wide", 2],
    ],
    "both lenses' scopes exceed one budget, so both are sharded",
  );
  assert.equal(h.calls.length, 4, "one dispatch per lens x shard");

  // EVERY PLANNED SHARD HAS A SCHEMA-VALID, REVIEWER-AUTHORED OUTCOME. Checked shard by shard
  // against the plan, not by counting: four outcomes for four shards would also be satisfied by
  // two lenses each authoring twice for shard 1.
  const recorded = outcomes(review);
  for (const lens of plan.lenses) {
    for (const shard of lens.shards) {
      const match = recorded.filter(
        (o) => o.lens === lens.lens && o.shard?.index === shard.index && o.derivationDigest === plan.digest,
      );
      assert.equal(match.length, 1, `${lens.lens} shard ${shard.index} of ${shard.of}: expected exactly one outcome`);
      const o = match[0] as LensOutcome;
      assert.equal(o.complete, true, `${lens.lens} shard ${shard.index}: not a completed outcome`);
      if (!o.complete) continue;
      assert.equal(o.authored, true, `${lens.lens} shard ${shard.index}: not reviewer-authored`);
      assert.ok(LENS_OUTCOMES.includes(o.outcome), `${lens.lens} shard ${shard.index}: ${o.outcome} is not an outcome`);
      assert.equal(o.shard?.of, shard.of, "the outcome names how many shards there were, not just which one");
    }
  }

  const assessed = completeness(review);
  assert.equal(assessed.complete, true);
  assert.deepEqual(assessed.missing, []);
  assert.deepEqual(assessed.accepted, [], "nothing here was cleared by an operator acceptance");
  assert.deepEqual(assessed.superseded, []);

  // ...and the gate agrees from the durable row alone.
  const gate = assessReviewDisposition({ review, findings: findingsForReview(REVIEW) });
  for (const id of ["lens_outcome_missing", "shard_plan_absent", "shard_plan_stale"]) {
    assert.equal(
      gate.conditions.some((c) => c.id === id),
      false,
      `${id} must not fire on a fully delivered sharded review`,
    );
  }

  // The authored evidence reached the ledger — a review that produced findings, not one that
  // merely finished.
  const findings = findingsForReview(REVIEW);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.summary, /cannot finish/);
});

// ─── AC7: no shard's composed input exceeded the budget ─────────────────────

test("FG-689 AC7: no shard's composed input exceeds the budget as the HOST measures it", async () => {
  const h = harness();
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const plan = (getReview(REVIEW) as Review).shardPlan!;
  const budget = plan.derivation.budget;
  assert.equal(budget, DEFAULT_SHARD_BUDGET, "measured against the number that ships, not a shrunken test budget");
  assert.equal(plan.derivation.unit, REVIEW_DIFF_SIZE_UNIT, "and the unit travels with it");

  for (const call of h.calls) {
    assert.ok(
      call.bytes <= budget,
      `${call.lens} shard ${call.shard} of ${call.of} was handed ${call.bytes} ${plan.derivation.unit} against a ` +
        `budget of ${budget}`,
    );
    assert.ok(
      call.bytes < PROVIDER_CAP_THAT_CRASHED,
      `${call.lens} shard ${call.shard} would have hit the cap FG-591 crashed on`,
    );
  }

  // The PLAN's arithmetic and the DISPATCH's bytes are two separate claims. Both are checked,
  // because a plan that adds up while the seam composes something else is the crash returning.
  for (const lens of plan.lenses) {
    for (const shard of lens.shards) {
      const call = h.calls.find((c) => c.lens === lens.lens && c.shard === shard.index);
      assert.ok(call, `${lens.lens} shard ${shard.index} was never dispatched`);
      assert.equal(call!.bytes, shard.chars, "the plan predicted a size the dispatch did not carry");
      assert.ok(shard.chars <= budget);
    }
  }

  // The fixture must genuinely force the packing to cut: at least one lens whose shards sum to
  // more than one budget. Otherwise every assertion above passes vacuously.
  const wide = plan.lenses.find((l) => l.lens === "wide")!;
  assert.equal(wide.shards.reduce((n, s) => n + s.chars, 0), TOTAL_BYTES);
  assert.ok(wide.shards.length >= 2);
});

// ─── AC7: the shard path union is exactly the pinned changed-path set ────────

test("FG-689 AC7: the union of every shard's paths is EXACTLY the pinned changed-path set", async () => {
  const h = harness();
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const rendered = rendering();
  assert.equal(rendered.ok, true);
  const pinnedPaths = rendered.ok ? rendered.rendering.paths : [];
  const plan = (getReview(REVIEW) as Review).shardPlan!;

  // Per lens: the shards partition the lens's scope — no path dropped, no path in two shards.
  for (const lens of plan.lenses) {
    const union = lens.shards.flatMap((s) => s.paths);
    assert.equal(new Set(union).size, union.length, `${lens.lens}: a path appears in more than one shard`);
    const dispatched = h.calls.filter((c) => c.lens === lens.lens).flatMap((c) => c.paths);
    assert.deepEqual(
      [...dispatched].sort(),
      [...union].sort(),
      `${lens.lens}: the paths dispatched are not the paths planned`,
    );
  }

  // Across the panel: every changed path was read by at least one lens, and no path was invented.
  const covered = [...new Set(h.calls.flatMap((c) => c.paths))].sort();
  assert.deepEqual(covered, [...pinnedPaths].sort(), "the shard path union must equal the pinned changed-path set");
  assert.equal(covered.length, 46);

  // The whole-change lens saw the whole change — the specific claim FG-591's review could not make.
  const wide = h.calls.filter((c) => c.lens === "wide").flatMap((c) => c.paths);
  assert.deepEqual([...wide].sort(), [...pinnedPaths].sort());
});

// ─── AC5: nothing was truncated, sampled or summarized ──────────────────────

test("FG-689 AC5: the shards REASSEMBLE the pinned rendering byte for byte — nothing was cut to make it fit", async () => {
  const h = harness();
  assert.equal((await runNextStage(REVIEW, h.deps)).status, "advanced");

  const bodyOf = new Map(FILES.map((f) => [f.path, f.body]));

  // Each dispatch carried exactly its paths' rendered bodies, concatenated in the plan's order.
  for (const call of h.calls) {
    const expected = call.paths.map((p) => bodyOf.get(p) as string).join("");
    assert.equal(call.diff, expected, `${call.lens} shard ${call.shard} was not handed its files whole`);
  }

  // ...and the lens that owns everything, read shard by shard in index order, reproduces the
  // rendering EXACTLY. One truncated byte, one sampled hunk, one summarized file fails this.
  const wholeRendering = FILES.map((f) => f.body).join("");
  const reassembled = h.calls
    .filter((c) => c.lens === "wide")
    .sort((a, b) => a.shard - b.shard)
    .map((c) => c.diff)
    .join("");
  assert.equal(reassembled.length, wholeRendering.length, "the reassembled shards are a different length");
  assert.equal(reassembled, wholeRendering, "the reassembled shards are not the rendering");
  assert.equal(Buffer.byteLength(reassembled, "utf8"), TOTAL_BYTES, "every measured byte reached a reviewer");
});

// ─── the regression must be able to FAIL ────────────────────────────────────

test("FG-689 AC7 falsification: one crashed shard leaves the review INCOMPLETE — a partial panel never passes", async () => {
  const h = harness((ctx) =>
    ctx.lens === "wide" && ctx.shard.index === 2 ? { ok: false } : { ok: true, result: { outcome: "pass", findings: [] } },
  );
  const outcome = await runNextStage(REVIEW, h.deps);

  assert.equal(outcome.status, "refused", "one surviving shard must never satisfy a lens whose other shard crashed");
  assert.match(outcome.message, /wide shard 2 of 2/);

  const review = getReview(REVIEW) as Review;
  assert.equal(completeness(review).complete, false);
  assert.deepEqual(
    completeness(review).missing.map((m) => `${m.lens} ${m.shard}/${m.of}`),
    ["wide 2/2"],
    "and exactly the shard that crashed is what is still owed",
  );
  assert.equal(findingsForReview(REVIEW).length, 0, "nothing was ingested from a panel that did not complete");
  assert.equal(review.stageEvidence?.discovery, undefined, "and no discovery stage record was written");

  const gate = assessReviewDisposition({ review, findings: [] });
  assert.match(
    gate.conditions.find((c) => c.id === "lens_outcome_missing")?.detail ?? "",
    /wide shard 2 of 2/,
    "an absent shard outcome still BLOCKS",
  );
});

test("FG-689 AC7 falsification: a shard whose reviewer output is not schema-valid is not an authored outcome", async () => {
  // Structurally a review — it says `pass` — but its finding is missing the fields that make a
  // finding falsifiable. An outcome that validated loosely is exactly how a review that did not
  // happen reads as one.
  const h = harness((ctx) =>
    ctx.lens === "backend" && ctx.shard.index === 1
      ? { ok: true, result: { outcome: "pass", findings: [{ summary: "looks fine to me" }] } }
      : { ok: true, result: { outcome: "pass", findings: [] } },
  );
  const outcome = await runNextStage(REVIEW, h.deps);

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /backend shard 1 of 2/);
  assert.match(outcome.message, /malformed_output/);

  const review = getReview(REVIEW) as Review;
  const authored = outcomes(review).filter((o) => o.lens === "backend" && o.shard?.index === 1 && o.complete);
  assert.deepEqual(authored, [], "malformed output must never be recorded as a completed outcome");
  assert.equal(findingsForReview(REVIEW).length, 0);
});

test("FG-689 AC7 falsification: a lens that was never dispatched at all leaves every one of its shards owed", async () => {
  const h = harness((ctx) => (ctx.lens === "backend" ? { ok: false } : { ok: true, result: { outcome: "pass", findings: [] } }));
  const outcome = await runNextStage(REVIEW, h.deps);

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /backend shard 1 of 2/);
  assert.match(outcome.message, /backend shard 2 of 2/);
  assert.match(outcome.message, /Completeness is owed PER SHARD/);
  assert.ok(
    !outcome.message.includes("wide shard"),
    "the lens that did author for every shard is not blamed for the one that did not",
  );
});
