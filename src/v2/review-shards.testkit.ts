// FG-689 step 8: a `ShardPlan` fixture, shared by every suite whose subject is something
// OTHER than the sharding.
//
// WHY THIS EXISTS. Per-shard completeness made the recorded shard plan load-bearing at three
// call sites at once — the coordinator's transition, discovery's own assessment, and the
// disposition gate — and all three now fail closed when a review with a readable contract has
// no plan. That is the correct rule (the gate cannot detect the absence of a record it never
// knew to look for), and its cost is that every pre-FG-689 fixture that seeded a review with
// outcomes but no plan needs one. Eight suites needed the same three-line literal, and eight
// hand-written copies of "what a plan looks like" is eight places for a fixture to drift out
// of the shape `planShards` actually produces.
//
// The plans here are SYNTHETIC but structurally real: `digest` is a constant rather than a
// recomputed sha, because these suites are not testing the derivation — the suites that ARE
// (fg689-sharding.test.ts, fg689-per-shard-completeness.test.ts) build their own and must keep
// doing so. What matters to a consumer of this kit is that the plan names the lenses the
// contract selects, that a lens is either sharded or skipped, and that every outcome and
// acceptance beside it carries the SAME digest — which `shardOutcome` and `shardAcceptance`
// make hard to get wrong.

import type { LensAcceptance, LensSkipRecord, ShardPlan, SkippedLens } from "../store/reviews.js";

/** The partition identity these fixtures share. Any value works — what is load-bearing is
 *  that the plan, the outcomes and the acceptances all carry the SAME one, because a mismatch
 *  is exactly what `assessShardCompleteness` reports as superseded (D17). */
export const FIXTURE_DIGEST = "shard-plan-1-fixture0000000000000000";

export type ShardPlanFixture = {
  /** Lens -> its shard sizes, one entry per shard. `["a.ts"]` is a 1-of-1 lens. */
  lenses?: Record<string, string[][]>;
  /** Lenses the plan gives ZERO shards. */
  skipped?: readonly string[];
  digest?: string;
  baseSha?: string;
  candidateSha?: string;
  fanoutWidth?: number;
};

export function shardPlanFixture(fixture: ShardPlanFixture = {}): ShardPlan {
  const digest = fixture.digest ?? FIXTURE_DIGEST;
  const entries = Object.entries(fixture.lenses ?? {});
  return {
    derivation: {
      baseSha: fixture.baseSha ?? "base000",
      candidateSha: fixture.candidateSha ?? "cand111",
      renderingId: "review-diff-1-fixture",
      budget: 600_000,
      unit: "utf8_bytes",
      envelopes: {},
      budgetValidatedRuntime: "unvalidated",
      scopesDigest: "scopes-fixture",
    },
    digest,
    fanoutWidth: fixture.fanoutWidth ?? 4,
    lenses: entries.map(([lens, shards]) => ({
      lens,
      shards: shards.map((paths, i) => ({ index: i + 1, of: shards.length, paths: [...paths], chars: 100 })),
    })),
    skipped: (fixture.skipped ?? []).map((lens): SkippedLens => ({ lens, reason: "zero_in_scope_paths" })),
    recordedAt: "2026-08-07T00:00:00.000Z",
  };
}

/** The common case: every named lens gets exactly ONE shard. This is what a real plan looks
 *  like for any change small enough to fit one dispatch per lens, which is every fixture in
 *  the pre-FG-689 suites. */
export function oneShardPlan(lenses: readonly string[], over: ShardPlanFixture = {}): ShardPlan {
  const byLens: Record<string, string[][]> = {};
  for (const lens of lenses) byLens[lens] = [[`src/${lens}.ts`]];
  return shardPlanFixture({ lenses: byLens, ...over });
}

/** Stamp a raw lens-outcome record with the shard identity the coordinator would have given
 *  it. Takes the record as-is otherwise, so a fixture stays readable as the outcome it is. */
export function shardOutcome<T extends object>(
  record: T,
  shard: { index: number; of: number } = { index: 1, of: 1 },
  digest = FIXTURE_DIGEST,
): T & { shard: { index: number; of: number }; derivationDigest: string } {
  return { ...record, shard, derivationDigest: digest };
}

/** The same for an operator acceptance (D16: it names the shard it clears). */
export function shardAcceptance(
  acceptance: LensAcceptance,
  shard = 1,
  digest = FIXTURE_DIGEST,
): LensAcceptance {
  return { ...acceptance, shard, derivationDigest: digest };
}

/** The `lens_skipped` ledger record that satisfies a plan-skipped lens. Required beside the
 *  plan rather than inferred from it: the plan is what forge INTENDED, the record is what it
 *  durably decided, and a skip nobody recorded is a lens that silently left the panel. */
export function skipRecord(lens: string, candidateSha: string, digest = FIXTURE_DIGEST): LensSkipRecord {
  return {
    kind: "lens_skipped",
    lens,
    reason: "zero_in_scope_paths",
    derivationDigest: digest,
    candidateSha,
    at: "2026-08-07T00:00:00.000Z",
  };
}
