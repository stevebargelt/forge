// FG-689 — the durable shapes sharding reads and writes, at the store layer.
//
// Three facts this file exists to keep true, each of which a plausible simpler design
// gets wrong:
//
//   1. WHAT IS OWED AND WHAT WAS DELIVERED ARE TWO RECORDS. The shard plan is written
//      before any container starts and lives in its own column; the outcomes are written
//      after. Neither is derivable from the other — a lens whose every shard crashed
//      delivers nothing, and an absence cannot say how many shards were expected.
//
//   2. AN INTENTIONALLY-SKIPPED LENS IS A THIRD STATE. Not an outcome (it would count as
//      reviewer-produced evidence), not an incompleteness (it would block, and would be
//      clearable by an operator verb that means something else). Its own record kind,
//      invisible to every outcome read, readable only through its own accessor.
//
//   3. A SHARD-GRANULARITY RETRY PRESERVES WHAT ALREADY SUCCEEDED. The whole-column
//      replace-all that discovery uses today would, under sharding, write back only the
//      shards one pass produced and erase the rest — the exact coverage the retry exists
//      to preserve, destroyed by the verb meant to preserve it.
//
// The cross-process proof that this column's writers do not lose each other's records
// lives in fg689-shard-plan-migration.integration.test.ts; BEGIN IMMEDIATE is inert in a
// single-process tier, so it cannot be proven here.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { eventsForRun } from "./events.js";
import {
  agentProtocolRecordsOf,
  getReview,
  insertReview,
  lensAcceptancesOf,
  lensOutcomeRecordsOf,
  lensSkipRecordsOf,
  mergeLensOutcomesByShard,
  plannedShardsFor,
  recordAgentProtocol,
  recordLensAcceptance,
  recordLensSkipped,
  recordShardPlan,
  recordShardBudgetValidation,
  replaceLensOutcomes,
  updateReview,
  type ShardPlan,
} from "./reviews.js";
import { shardPlanDigest } from "../v2/review-shards.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg689",
  workflow: "feature",
  title: "shard plan",
  status: "active",
  createdAt: "2026-08-06T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689";

const DERIVATION = {
  baseSha: "base000",
  candidateSha: "conf222",
  renderingId: "fg689-pinned-v1",
  budget: 600_000,
  unit: "characters",
  envelopes: {},
  budgetValidatedRuntime: "codex-subscription",
  scopesDigest: "scopes-aaa",
};

type DraftPlan = Omit<ShardPlan, "recordedAt"> & { recordedAt?: string };

/** A plan giving `wide` two shards and `backend` one, unless told otherwise. */
function draft(digest: string, over: Partial<ShardPlan> = {}): DraftPlan {
  return {
    derivation: { ...DERIVATION },
    digest,
    fanoutWidth: 4,
    lenses: [
      {
        lens: "wide",
        shards: [
          { index: 1, of: 2, paths: ["src/a.ts"], chars: 400_000 },
          { index: 2, of: 2, paths: ["src/b.ts"], chars: 350_000 },
        ],
      },
      { lens: "backend", shards: [{ index: 1, of: 1, paths: ["src/store/x.ts"], chars: 1200 }] },
    ],
    skipped: [],
    ...over,
  };
}

function shardOutcome(lens: string, index: number, of: number, digest: string, extra: object = {}): object {
  return {
    lens,
    role: `red-${lens}`,
    complete: true,
    outcome: "pass",
    authored: true,
    findings: [],
    shard: { index, of },
    derivationDigest: digest,
    ...extra,
  };
}

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
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: "conf222",
    contract: {
      threat_model: "operator_trusted_candidate",
      risk_lenses: ["wide", "backend"],
      lens_scopes: { wide: ["src/"], backend: ["src/store/"] },
    },
    state: "discovering",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── the shard plan is its own column, written before dispatch ──────────────

test("a review with no recorded plan reads shardPlan as undefined — not null, not an empty plan", () => {
  const review = getReview(REVIEW);
  assert.equal(review?.shardPlan, undefined);
  assert.ok(
    !("shardPlan" in (review as object) && review?.shardPlan === null),
    "null is the shape that survives `?? ` checks and fails later; the accessor must never surface it",
  );
  assert.deepEqual(plannedShardsFor(review?.shardPlan, "wide"), [], "and nothing is owed against a plan nobody wrote");
});

test("recordShardPlan persists the whole derivation, the digest, the fan-out width and the shard set", () => {
  const write = recordShardPlan(REVIEW, draft("digest-1"));
  assert.equal(write.recorded, true);
  assert.equal(write.previous, undefined);

  const plan = getReview(REVIEW)?.shardPlan as ShardPlan;
  assert.equal(plan.digest, "digest-1");
  assert.equal(plan.fanoutWidth, 4);
  assert.deepEqual(plan.derivation, DERIVATION, "the inputs the partition is a function of are recorded WHOLE");
  assert.equal(plan.derivation.unit, "characters", "the unit travels with the budget, never assumed (D10)");
  assert.equal(plan.derivation.budgetValidatedRuntime, "codex-subscription");
  assert.notEqual(plan.recordedAt, undefined);
  assert.deepEqual(
    plannedShardsFor(plan, "wide").map((s) => `${s.index} of ${s.of}`),
    ["1 of 2", "2 of 2"],
  );
  assert.equal(plannedShardsFor(plan, "frontend").length, 0, "a lens the plan does not name is owed nothing");
});

test("recordShardPlan called twice with the SAME digest is a no-op — same inputs, same partition", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const firstAt = getReview(REVIEW)?.shardPlan?.recordedAt;

  const again = recordShardPlan(REVIEW, draft("digest-1", { fanoutWidth: 99 }));
  assert.equal(again.recorded, false, "an equal digest means the same partition of the same bytes");
  const plan = getReview(REVIEW)?.shardPlan as ShardPlan;
  assert.equal(plan.recordedAt, firstAt, "re-entered discovery must not look like a re-partition to what keys on it");
  assert.equal(plan.fanoutWidth, 4, "and the recorded plan is not quietly rewritten");

  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.shard_plan_recorded").length,
    1,
    "a no-op records no second event",
  );
});

test("recordShardPlan with a DIFFERENT digest replaces the plan and hands back the one it superseded", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const write = recordShardPlan(REVIEW, draft("digest-2", { fanoutWidth: 2 }));

  assert.equal(write.recorded, true);
  assert.equal(
    write.previous?.digest,
    "digest-1",
    "the caller needs the superseded plan to NAME the decisions a re-partition invalidates (D17)",
  );
  const plan = getReview(REVIEW)?.shardPlan as ShardPlan;
  assert.equal(plan.digest, "digest-2");
  assert.equal(plan.fanoutWidth, 2);
});

test("recording a plan emits one event carrying the digest, what it supersedes, and what is expected", () => {
  recordShardPlan(REVIEW, draft("digest-1", { skipped: [{ lens: "frontend", reason: "zero_in_scope_paths" }] }));
  recordShardPlan(REVIEW, draft("digest-2"));

  const events = eventsForRun(RUN.id).filter((e) => e.eventType === "review.shard_plan_recorded");
  assert.equal(events.length, 2);
  const first = events[0]?.payload as { digest: string; supersedes: string | null; expected: unknown; skipped: unknown };
  assert.equal(first.digest, "digest-1");
  assert.equal(first.supersedes, null);
  assert.deepEqual(first.expected, [
    { lens: "wide", shards: 2 },
    { lens: "backend", shards: 1 },
  ]);
  assert.deepEqual(first.skipped, [{ lens: "frontend", reason: "zero_in_scope_paths" }]);
  assert.equal((events[1]?.payload as { supersedes: string }).supersedes, "digest-1");
});

test("the shard plan survives an unrelated updateReview — a patch must not erase what is owed", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  updateReview(REVIEW, { candidateSha: "moved333", lensOutcomes: [] });
  assert.equal(getReview(REVIEW)?.shardPlan?.digest, "digest-1");
});

// ─── the fourth record kind: intentionally skipped ──────────────────────────

test("a lens_skipped record is INVISIBLE to every outcome read and readable only through its own accessor", () => {
  recordLensSkipped(REVIEW, {
    lens: "frontend",
    reason: "zero_in_scope_paths",
    derivationDigest: "digest-1",
    candidateSha: "conf222",
  });

  const review = getReview(REVIEW) as never;
  assert.deepEqual(lensOutcomeRecordsOf(review), [], "a skip must never be counted as a review that happened");
  assert.deepEqual(lensAcceptancesOf(review), [], "nor as an operator's acceptance of missing evidence");
  assert.deepEqual(agentProtocolRecordsOf(review), []);

  const skips = lensSkipRecordsOf(review);
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.lens, "frontend");
  assert.equal(skips[0]?.reason, "zero_in_scope_paths");
  assert.equal(skips[0]?.derivationDigest, "digest-1");
  assert.equal(skips[0]?.candidateSha, "conf222");
  assert.notEqual(skips[0]?.at, undefined);
});

test("a skip is NOT shaped like an outcome — nothing that reads outcomes could mistake it for one", () => {
  recordLensSkipped(REVIEW, {
    lens: "frontend",
    reason: "zero_in_scope_paths",
    derivationDigest: "digest-1",
    candidateSha: "conf222",
  });
  const raw = (getReview(REVIEW)?.lensOutcomes as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(raw["kind"], "lens_skipped");
  assert.equal(raw["complete"], undefined, "recording a skip as complete/authored would make it EVIDENCE");
  assert.equal(raw["authored"], undefined);
  assert.equal(raw["outcome"], undefined);
  assert.equal(raw["findings"], undefined);
});

test("re-recording the same skip under the same derivation is idempotent; a new derivation appends", () => {
  const rec = { lens: "frontend", reason: "zero_in_scope_paths", derivationDigest: "digest-1", candidateSha: "conf222" } as const;
  recordLensSkipped(REVIEW, rec);
  recordLensSkipped(REVIEW, rec);
  assert.equal(lensSkipRecordsOf(getReview(REVIEW) as never).length, 1, "re-entry re-states the same fact, and adds nothing");

  recordLensSkipped(REVIEW, { ...rec, derivationDigest: "digest-2" });
  const skips = lensSkipRecordsOf(getReview(REVIEW) as never);
  assert.deepEqual(
    skips.map((s) => s.derivationDigest),
    ["digest-1", "digest-2"],
    "a skip under a DIFFERENT partition is a different fact; the earlier one stays as history",
  );
  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.lens_skipped").length,
    2,
    "and only the writes that happened are on the timeline",
  );
});

test("replaceLensOutcomes preserves skip records exactly as it preserves acceptances and protocol receipts", () => {
  recordLensSkipped(REVIEW, {
    lens: "frontend",
    reason: "zero_in_scope_paths",
    derivationDigest: "digest-1",
    candidateSha: "conf222",
  });
  recordAgentProtocol(REVIEW, { role: "engineer", sha256: "abc", taskId: "task-fix", stage: "fix_batch" });

  replaceLensOutcomes(REVIEW, [shardOutcome("wide", 1, 2, "digest-1")]);

  const review = getReview(REVIEW) as never;
  assert.equal(lensSkipRecordsOf(review).length, 1, "discovery's wholesale replace must not erase a skip");
  assert.equal(agentProtocolRecordsOf(review).length, 1);
  assert.equal(lensOutcomeRecordsOf(review).length, 1);
});

// ─── the shard-granularity writer ───────────────────────────────────────────

test("mergeLensOutcomesByShard writing shard 2 of 2 leaves the shard-1 outcome intact", () => {
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 1, 2, "digest-1", { taskId: "task-wide-1" })]);
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 2, 2, "digest-1", { taskId: "task-wide-2" })]);

  const outcomes = lensOutcomeRecordsOf(getReview(REVIEW) as never) as Array<{
    shard: { index: number };
    taskId: string;
  }>;
  assert.deepEqual(
    outcomes.map((o) => [o.shard.index, o.taskId]),
    [
      [1, "task-wide-1"],
      [2, "task-wide-2"],
    ],
    "a retry of one shard must not erase the coverage the other already produced",
  );
});

test("mergeLensOutcomesByShard preserves every acceptance, protocol receipt and skip in the same column", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 1, 2, "digest-1")]);
  recordAgentProtocol(REVIEW, { role: "engineer", sha256: "abc", taskId: "task-fix", stage: "fix_batch" });
  recordLensSkipped(REVIEW, {
    lens: "frontend",
    reason: "zero_in_scope_paths",
    derivationDigest: "digest-1",
    candidateSha: "conf222",
  });
  const accepted = recordLensAcceptance(REVIEW, {
    lens: "backend",
    shard: 1,
    missingEvidence: "the store layer's transaction shapes",
    rationale: "accepted for the pilot",
    operator: true,
  });
  assert.equal(accepted.ok, true);

  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 2, 2, "digest-1")]);

  const review = getReview(REVIEW) as never;
  assert.equal(lensOutcomeRecordsOf(review).length, 2);
  assert.equal(agentProtocolRecordsOf(review).length, 1, "an agent_protocol receipt survives a shard write");
  assert.equal(lensSkipRecordsOf(review).length, 1);
  assert.equal(lensAcceptancesOf(review).length, 1);
});

test("re-writing the SAME (lens, shard, derivation) replaces that record in place rather than duplicating it", () => {
  mergeLensOutcomesByShard(REVIEW, [
    shardOutcome("wide", 1, 2, "digest-1", { taskId: "task-first" }),
    shardOutcome("wide", 2, 2, "digest-1", { taskId: "task-two" }),
  ]);
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 1, 2, "digest-1", { taskId: "task-retried" })]);

  const outcomes = lensOutcomeRecordsOf(getReview(REVIEW) as never) as Array<{
    shard: { index: number };
    taskId: string;
  }>;
  assert.equal(outcomes.length, 2, "a retried shard is one record, not two");
  assert.deepEqual(
    outcomes.map((o) => [o.shard.index, o.taskId]),
    [
      [1, "task-retried"],
      [2, "task-two"],
    ],
    "and it lands IN PLACE, so the column's order is stable across retries",
  );
});

test("an outcome from a SUPERSEDED derivation is kept beside the current one, not silently overwritten", () => {
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 1, 2, "digest-old")]);
  mergeLensOutcomesByShard(REVIEW, [shardOutcome("wide", 1, 2, "digest-1")]);

  const outcomes = lensOutcomeRecordsOf(getReview(REVIEW) as never) as Array<{ derivationDigest: string }>;
  assert.deepEqual(
    outcomes.map((o) => o.derivationDigest),
    ["digest-old", "digest-1"],
    "the stale record has to survive for the assessor to report it as superseded BY NAME",
  );
});

test("a record with no readable lens has no identity to merge on and is appended untouched", () => {
  mergeLensOutcomesByShard(REVIEW, [{ note: "not an outcome shape" }]);
  mergeLensOutcomesByShard(REVIEW, [{ note: "not an outcome shape" }]);
  assert.equal(lensOutcomeRecordsOf(getReview(REVIEW) as never).length, 2, "nothing here drops what it cannot classify");
});

// ─── D16: an acceptance clears exactly the shard it names ───────────────────

test("D16: an acceptance with NO shard against a lens the plan sharded is refused BY NAME and writes nothing", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const res = recordLensAcceptance(REVIEW, {
    lens: "wide",
    missingEvidence: "the wide sweep",
    rationale: "time-boxed",
    operator: true,
  });

  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.refusal : "", /was dispatched as 2 shard\(s\)/);
  assert.match(res.ok === false ? res.refusal : "", /--shard <1\.\.2>/);
  assert.match(res.ok === false ? res.refusal : "", /crashed and were never read/);
  assert.match(res.ok === false ? res.refusal : "", /Nothing was written/);
  assert.equal(getReview(REVIEW)?.lensOutcomes, undefined, "and nothing WAS written");
  assert.equal(eventsForRun(RUN.id).some((e) => e.eventType === "review.lens_accepted"), false);
});

test("D16: an acceptance naming shard 1 of 2 is recorded, stamped with the plan's digest", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const res = recordLensAcceptance(REVIEW, {
    lens: "wide",
    shard: 1,
    missingEvidence: "shard 1's files were never reviewed",
    rationale: "accepted for the pilot",
    operator: true,
  });

  assert.equal(res.ok, true);
  const acceptance = res.ok === true ? res.acceptance : undefined;
  assert.equal(acceptance?.shard, 1);
  assert.equal(acceptance?.derivationDigest, "digest-1", "so a re-partition makes this decision detectably superseded");
  assert.equal(acceptance?.candidateSha, "conf222");
  const payload = eventsForRun(RUN.id).find((e) => e.eventType === "review.lens_accepted")?.payload as {
    shard: number;
    derivationDigest: string;
  };
  assert.equal(payload.shard, 1);
  assert.equal(payload.derivationDigest, "digest-1");
});

test("D16: a shard the plan does not name is refused — 0, 3 of 2, and a fractional index alike", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  for (const shard of [0, 3, 1.5]) {
    const res = recordLensAcceptance(REVIEW, {
      lens: "wide",
      shard,
      missingEvidence: "x",
      rationale: "y",
      operator: true,
    });
    assert.equal(res.ok, false, `--shard ${shard} must not be accepted`);
    assert.match(res.ok === false ? res.refusal : "", /the recorded plan names 1\.\.2/);
  }
  assert.equal(lensAcceptancesOf(getReview(REVIEW) as never).length, 0);
});

test("D16: --shard against a review with NO recorded plan names a shard that does not exist", () => {
  const res = recordLensAcceptance(REVIEW, {
    lens: "wide",
    shard: 1,
    missingEvidence: "x",
    rationale: "y",
    operator: true,
  });
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.refusal : "", /has no recorded shard plan/);
});

test("D16: a lens the plan gives NO shards refuses a --shard acceptance naming its own absence", () => {
  recordShardPlan(
    REVIEW,
    draft("digest-1", {
      lenses: [{ lens: "wide", shards: [{ index: 1, of: 1, paths: ["src/a.ts"], chars: 10 }] }],
      skipped: [{ lens: "backend", reason: "zero_in_scope_paths" }],
    }),
  );
  const res = recordLensAcceptance(REVIEW, {
    lens: "backend",
    shard: 1,
    missingEvidence: "x",
    rationale: "y",
    operator: true,
  });
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.refusal : "", /gives the backend lens no shards/);
});

test("with no plan recorded, an acceptance behaves EXACTLY as it did before FG-689", () => {
  const res = recordLensAcceptance(REVIEW, {
    lens: "wide",
    missingEvidence: "the wide sweep never ran",
    rationale: "accepted for the pilot",
    operator: true,
  });
  assert.equal(res.ok, true);
  const acceptance = res.ok === true ? res.acceptance : undefined;
  assert.equal(acceptance?.shard, undefined, "there is no shard to name, so none is invented");
  assert.equal(acceptance?.derivationDigest, undefined);
  assert.equal(acceptance?.candidateSha, "conf222");
  assert.equal(lensAcceptancesOf(getReview(REVIEW) as never).length, 1);
});

test("the pre-FG-689 refusals are unchanged: no --operator, unnamed evidence, an unselected lens", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const noOperator = recordLensAcceptance(REVIEW, {
    lens: "wide",
    shard: 1,
    missingEvidence: "x",
    rationale: "y",
    operator: false,
  });
  assert.match(noOperator.ok === false ? noOperator.refusal : "", /requires operator authority/);

  const unnamed = recordLensAcceptance(REVIEW, {
    lens: "wide",
    shard: 1,
    missingEvidence: "  ",
    rationale: "y",
    operator: true,
  });
  assert.match(unnamed.ok === false ? unnamed.refusal : "", /must NAME the missing evidence/);

  const unselected = recordLensAcceptance(REVIEW, {
    lens: "frontend",
    missingEvidence: "x",
    rationale: "y",
    operator: true,
  });
  assert.match(unselected.ok === false ? unselected.refusal : "", /is not a lens this review's contract selected/);
});

// ---------------------------------------------------------------------------
// FG-689 D10 / RF-1: the budget's validation is an OBSERVATION, recorded after the fact
// ---------------------------------------------------------------------------

test("recordShardBudgetValidation replaces `unvalidated` with the runtime a real dispatch resolved", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  recordShardBudgetValidation(REVIEW, { digest: "digest-1", runtime: "claude-oauth", composedChars: 512_345 });

  const d = (getReview(REVIEW)?.shardPlan as ShardPlan).derivation;
  assert.equal(d.budgetValidatedRuntime, "claude-oauth");
  assert.equal(d.budgetValidatedChars, 512_345, "and how close to the budget the proof actually ran");

  const ev = eventsForRun(RUN.id).filter((e) => e.eventType === "review.shard_budget_validated");
  assert.equal(ev.length, 1);
  assert.deepEqual((ev[0]?.payload as { runtime: string; supersedes: string }).supersedes, "codex-subscription");
});

test("the validation is MONOTONE — a later, smaller dispatch never walks the evidence back", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  recordShardBudgetValidation(REVIEW, { digest: "digest-1", runtime: "claude-oauth", composedChars: 512_345 });
  recordShardBudgetValidation(REVIEW, { digest: "digest-1", runtime: "claude-oauth", composedChars: 12 });

  const d = (getReview(REVIEW)?.shardPlan as ShardPlan).derivation;
  assert.equal(d.budgetValidatedChars, 512_345, "the LARGEST input a runtime took is the interesting number");
  assert.equal(
    eventsForRun(RUN.id).filter((e) => e.eventType === "review.shard_budget_validated").length,
    1,
    "and a validation that proves nothing new records nothing",
  );
});

test("a validation for a partition that has moved on is DISCARDED, never stamped onto the current one", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  recordShardPlan(REVIEW, draft("digest-2"));
  recordShardBudgetValidation(REVIEW, { digest: "digest-1", runtime: "claude-oauth", composedChars: 512_345 });

  const d = (getReview(REVIEW)?.shardPlan as ShardPlan).derivation;
  assert.equal(
    d.budgetValidatedRuntime,
    "codex-subscription",
    "evidence is about the partition it was collected under — a re-partition is not validated by it",
  );
  assert.equal(d.budgetValidatedChars, undefined);
});

test("recording the validation moves NO digest — it supersedes no operator decision (D17)", () => {
  recordShardPlan(REVIEW, draft("digest-1"));
  const before = getReview(REVIEW)?.shardPlan as ShardPlan;
  recordShardBudgetValidation(REVIEW, { digest: "digest-1", runtime: "claude-oauth", composedChars: 9 });
  const after = getReview(REVIEW)?.shardPlan as ShardPlan;

  assert.equal(after.digest, before.digest);
  assert.equal(
    shardPlanDigest(after.derivation),
    shardPlanDigest(before.derivation),
    "re-validating the same budget against a new runtime moves no byte between shards",
  );
  assert.deepEqual(after.lenses, before.lenses);
});
