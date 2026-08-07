// FG-689 D1 — completeness is PER SHARD.
//
// This is the most important decision in the ticket, and it is a decision about a fail-open
// that does not exist yet: the moment a lens is dispatched as several shards, the existing
// lens-granular assessor — which accepts the FIRST complete outcome for a lens — lets ONE
// surviving shard satisfy a lens whose other shards crashed. The review then reads complete
// while most of the code in that lens's scope was never read by anyone, which is precisely
// the "an unreviewed panel reads clean" failure the whole evidence-led model exists to close.
//
// So the tests here are all one shape: something plausible arrives that COULD be read as
// discharging a shard's debt, and the assertion is that it does not, and that the refusal
// NAMES what is still owed. The four routes that plausibility arrives by:
//
//   1. a sibling shard's authored outcome (the D1 case itself)
//   2. an outcome or a record carrying no shard identity at all
//   3. an operator acceptance that names the lens but not the shard
//   4. any of the above bound to a partition that no longer exists (D17)
//
// The one route that DOES discharge a lens's debt without evidence is the intentionally-
// skipped lens, and it gets the opposite test: it must satisfy, and it must be structurally
// incapable of being read as evidence — asserted by feeding the panel to `collectObservations`
// and proving the skip contributes nothing to the finding ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessLens,
  assessShardCompleteness,
  collectObservations,
  type LensOutcome,
} from "./review-discovery.js";
import { STALE_PROTOCOL_FAILURE_KIND } from "./agent-protocol.js";
import type { RiskLens } from "./review-contract.js";
import type { LensAcceptance, LensSkipRecord, ShardPlan } from "../store/reviews.js";

const DIGEST = "sha256:partition-current";
const OLD_DIGEST = "sha256:partition-superseded";
const CANDIDATE = "c4fe691a";
const OLD_CANDIDATE = "11c2b561";

function plan(over: Partial<ShardPlan> = {}): ShardPlan {
  return {
    derivation: {
      baseSha: "11c2b561",
      candidateSha: CANDIDATE,
      renderingId: "fg689-pinned-v1",
      budget: 600_000,
      unit: "characters",
      envelopes: {},
      budgetValidatedRuntime: "claude-oauth",
      scopesDigest: "sha256:scopes",
    },
    digest: DIGEST,
    fanoutWidth: 4,
    lenses: [],
    skipped: [],
    recordedAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

function shard(index: number, of: number, paths: string[] = [`src/f${index}.ts`]) {
  return { index, of, paths, chars: 1000 * index };
}

function authored(lens: RiskLens, index: number, of: number, derivationDigest = DIGEST): LensOutcome {
  return assessLens({
    lens,
    role: `red-${lens}`,
    dispatched: true,
    result: { outcome: "pass", findings: [] },
    shard: { index, of },
    derivationDigest,
  });
}

function crashed(lens: RiskLens, index: number, of: number, derivationDigest = DIGEST): LensOutcome {
  return assessLens({
    lens,
    role: `red-${lens}`,
    dispatched: false,
    failureKind: "container_crash",
    result: undefined,
    shard: { index, of },
    derivationDigest,
  });
}

function acceptance(over: Partial<LensAcceptance> = {}): LensAcceptance {
  return {
    kind: "lens_acceptance",
    lens: "wide",
    shard: 1,
    derivationDigest: DIGEST,
    missingEvidence: "the wide lens never read the queue command surface",
    rationale: "shipping the hotfix; the surface is covered by the narrow lens",
    candidateSha: CANDIDATE,
    acceptedBy: "operator",
    acceptedAt: "2026-08-07T01:00:00Z",
    ...over,
  };
}

function skipRecord(over: Partial<LensSkipRecord> = {}): LensSkipRecord {
  return {
    kind: "lens_skipped",
    lens: "frontend",
    reason: "zero_in_scope_paths",
    derivationDigest: DIGEST,
    candidateSha: CANDIDATE,
    at: "2026-08-07T00:30:00Z",
    ...over,
  };
}

// ─── D1: one surviving shard never satisfies a lens whose others crashed ────

test("FG-689 D1: a plan naming 2 shards for `wide` with shard 1 authored and shard 2 crashed is INCOMPLETE", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 2), shard(2, 2)] }] });
  const c = assessShardCompleteness(p, [authored("wide", 1, 2), crashed("wide", 2, 2)]);

  assert.equal(c.complete, false, "the surviving shard must not stand in for the crashed one");
  assert.equal(c.missing.length, 1);
  assert.equal(c.missing[0]?.lens, "wide");
  assert.equal(c.missing[0]?.shard, 2, "the refusal names WHICH shard is owed");
  assert.equal(c.missing[0]?.of, 2, "and how many there are, so nobody reads it as the whole lens");
  assert.equal(c.missing[0]?.reason, "crashed");
});

test("FG-689 D1: every shard authored is complete, and one lens's shards do not cover another's", () => {
  const p = plan({
    lenses: [
      { lens: "wide", shards: [shard(1, 2), shard(2, 2)] },
      { lens: "security", shards: [shard(1, 1)] },
    ],
  });

  const partial = assessShardCompleteness(p, [authored("wide", 1, 2), authored("wide", 2, 2)]);
  assert.equal(partial.complete, false, "security is owed an outcome of its own");
  assert.deepEqual(
    partial.missing.map((m) => `${m.lens}:${m.shard}`),
    ["security:1"],
  );

  const full = assessShardCompleteness(p, [
    authored("wide", 1, 2),
    authored("wide", 2, 2),
    authored("security", 1, 1),
  ]);
  assert.equal(full.complete, true);
  assert.deepEqual(full.missing, []);
});

test("FG-689 D1: a shard that produced NOTHING is reported by name, not silently satisfied", () => {
  const p = plan({ lenses: [{ lens: "backend", shards: [shard(1, 3), shard(2, 3), shard(3, 3)] }] });
  const c = assessShardCompleteness(p, [authored("backend", 1, 3), authored("backend", 3, 3)]);

  assert.equal(c.complete, false);
  assert.deepEqual(
    c.missing.map((m) => ({ lens: m.lens, shard: m.shard, of: m.of, reason: m.reason })),
    [{ lens: "backend", shard: 2, of: 3, reason: "no_outcome" }],
  );
  assert.match(c.missing[0]!.detail, /backend shard 2 of 3/);
});

test("FG-689: a RETRIED shard that later authors an outcome clears its own shard and only its own", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 2), shard(2, 2)] }] });
  const c = assessShardCompleteness(p, [
    crashed("wide", 2, 2),
    authored("wide", 2, 2),
    authored("wide", 1, 2),
  ]);
  assert.equal(c.complete, true);
});

// ─── an outcome with no shard identity satisfies nothing ────────────────────

test("FG-689: a lens-granular outcome carrying NO shard identity satisfies no shard, and is named", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 2), shard(2, 2)] }] });
  const unSharded = assessLens({
    lens: "wide",
    role: "red-wide",
    dispatched: true,
    result: { outcome: "pass", findings: [] },
  });

  const c = assessShardCompleteness(p, [unSharded]);
  assert.equal(c.complete, false, "one un-sharded outcome standing in for every shard IS the fail-open");
  assert.deepEqual(
    c.missing.map((m) => m.shard),
    [1, 2],
  );
  assert.equal(c.superseded.length, 1);
  assert.equal(c.superseded[0]?.kind, "outcome");
  assert.match(c.superseded[0]!.detail, /carries no shard identity/);
});

// ─── D16: an acceptance clears exactly the shard it names ───────────────────

test("FG-689 D16: an acceptance naming shard 1 of 2 leaves shard 2 BLOCKING", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 2), shard(2, 2)] }] });
  const c = assessShardCompleteness(p, [crashed("wide", 1, 2), crashed("wide", 2, 2)], {
    acceptances: [acceptance({ shard: 1 })],
    candidateSha: CANDIDATE,
  });

  assert.equal(c.complete, false);
  assert.equal(c.accepted.length, 1, "the named shard clears through the acceptance route");
  assert.equal(c.accepted[0]?.shard, 1);
  assert.deepEqual(
    c.missing.map((m) => ({ lens: m.lens, shard: m.shard })),
    [{ lens: "wide", shard: 2 }],
    "an acceptance of one shard is not an acceptance of the lens",
  );
});

test("FG-689 D16: an acceptance naming NO shard clears no shard of a sharded lens, and says so", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 2), shard(2, 2)] }] });
  const c = assessShardCompleteness(p, [crashed("wide", 1, 2), crashed("wide", 2, 2)], {
    acceptances: [acceptance({ shard: undefined, derivationDigest: undefined })],
    candidateSha: CANDIDATE,
  });

  assert.equal(c.complete, false);
  assert.deepEqual(c.accepted, []);
  assert.deepEqual(
    c.missing.map((m) => m.shard),
    [1, 2],
  );
  for (const m of c.missing) {
    assert.match(m.detail, /names no shard, so it clears none of them/);
  }
  assert.equal(
    c.superseded.filter((s) => s.kind === "acceptance").length,
    2,
    "the operator's decision is named against every shard it failed to clear, not dropped",
  );
});

test("FG-689: an acceptance of one LENS does not reach another lens's shards", () => {
  const p = plan({
    lenses: [
      { lens: "wide", shards: [shard(1, 1)] },
      { lens: "security", shards: [shard(1, 1)] },
    ],
  });
  const c = assessShardCompleteness(p, [], {
    acceptances: [acceptance({ lens: "wide", shard: 1 })],
    candidateSha: CANDIDATE,
  });
  assert.equal(c.complete, false);
  assert.deepEqual(
    c.missing.map((m) => m.lens),
    ["security"],
  );
});

// ─── FG-654 precedence: stale_protocol is unclearable ───────────────────────

test("FG-689 / FG-654: a stale_protocol shard is NOT clearable by an acceptance naming it", () => {
  const p = plan({ lenses: [{ lens: "security", shards: [shard(1, 1)] }] });
  const refused = assessLens({
    lens: "security",
    role: "red-security",
    dispatched: false,
    failureKind: STALE_PROTOCOL_FAILURE_KIND,
    result: undefined,
    shard: { index: 1, of: 1 },
    derivationDigest: DIGEST,
  });

  const c = assessShardCompleteness(p, [refused], {
    acceptances: [acceptance({ lens: "security", shard: 1 })],
    candidateSha: CANDIDATE,
  });

  assert.equal(c.complete, false, "a stale-protocol refusal is not a narrower review, so there is nothing to accept");
  assert.equal(c.missing[0]?.reason, "stale_protocol");
  assert.equal(c.missing[0]?.shard, 1);
  assert.deepEqual(c.accepted, [], "the acceptance route must not be consulted at all here");
  assert.match(c.missing[0]!.detail, /forge upgrade/);
});

// ─── D17: a decision bound to a partition that no longer exists ─────────────

test("FG-689 D17: an OUTCOME authored against a superseded partition is named and satisfies nothing", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 1)] }] });
  const c = assessShardCompleteness(p, [authored("wide", 1, 1, OLD_DIGEST)]);

  assert.equal(c.complete, false, "a shard of a partition that no longer exists reviewed a different path set");
  assert.equal(c.missing[0]?.shard, 1);
  assert.equal(c.missing[0]?.reason, "no_outcome");
  assert.equal(c.superseded.length, 1);
  assert.equal(c.superseded[0]?.kind, "outcome");
  assert.equal(c.superseded[0]?.recordedDigest, OLD_DIGEST);
  assert.match(c.superseded[0]!.detail, /wide shard 1 of 1/);
  assert.match(c.superseded[0]!.detail, new RegExp(DIGEST));
});

test("FG-689 D17: an ACCEPTANCE made against a superseded partition is named and clears nothing", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 1)] }] });
  const c = assessShardCompleteness(p, [crashed("wide", 1, 1)], {
    acceptances: [acceptance({ shard: 1, derivationDigest: OLD_DIGEST })],
    candidateSha: CANDIDATE,
  });

  assert.equal(c.complete, false);
  assert.deepEqual(c.accepted, []);
  assert.equal(c.superseded[0]?.kind, "acceptance");
  assert.equal(c.superseded[0]?.recordedDigest, OLD_DIGEST);
  assert.match(c.missing[0]!.detail, new RegExp(`acceptance of wide shard 1 of 1 exists but it was made against partition ${OLD_DIGEST}`));
});

test("FG-689 / FG-640: an acceptance whose CANDIDATE moved is still named, as it was before sharding", () => {
  const p = plan({ lenses: [{ lens: "wide", shards: [shard(1, 1)] }] });
  const c = assessShardCompleteness(p, [crashed("wide", 1, 1)], {
    acceptances: [acceptance({ shard: 1, candidateSha: OLD_CANDIDATE })],
    candidateSha: CANDIDATE,
  });

  assert.equal(c.complete, false);
  assert.deepEqual(c.accepted, []);
  assert.equal(c.superseded[0]?.kind, "acceptance");
  assert.match(c.superseded[0]!.detail, new RegExp(`candidate ${OLD_CANDIDATE}`));
});

test("FG-689 D17: a SKIP record made under a superseded partition does not satisfy the lens", () => {
  const p = plan({ skipped: [{ lens: "frontend", reason: "zero_in_scope_paths" }] });
  const c = assessShardCompleteness(p, [], { skips: [skipRecord({ derivationDigest: OLD_DIGEST })] });

  assert.equal(c.complete, false, "a re-partition can legitimately give a lens paths");
  assert.deepEqual(c.skipped, []);
  assert.equal(c.missing[0]?.lens, "frontend");
  assert.equal(c.missing[0]?.reason, "skip_unrecorded");
  assert.equal(c.superseded[0]?.kind, "skip");
  assert.equal(c.superseded[0]?.recordedDigest, OLD_DIGEST);
});

test("FG-689 D17: a skip record for a lens THIS partition gives shards to is named superseded", () => {
  const p = plan({ lenses: [{ lens: "frontend", shards: [shard(1, 1)] }] });
  const c = assessShardCompleteness(p, [authored("frontend", 1, 1)], { skips: [skipRecord({ derivationDigest: OLD_DIGEST })] });

  assert.equal(c.complete, true, "the shard authored, so nothing is owed");
  assert.deepEqual(c.skipped, [], "a superseded skip is not a current skip");
  assert.equal(c.superseded[0]?.kind, "skip");
  assert.match(c.superseded[0]!.detail, /gives it 1 shard\(s\)/);
});

// ─── the intentionally-skipped lens: satisfying, and never evidence ─────────

test("FG-689 AC3: a lens recorded skipped with a MATCHING record clears completeness and appears in `skipped`", () => {
  const p = plan({
    lenses: [{ lens: "backend", shards: [shard(1, 1)] }],
    skipped: [{ lens: "frontend", reason: "zero_in_scope_paths" }],
  });
  const outcomes = [authored("backend", 1, 1)];
  const c = assessShardCompleteness(p, outcomes, { skips: [skipRecord()] });

  assert.equal(c.complete, true);
  assert.deepEqual(c.skipped, [{ lens: "frontend", reason: "zero_in_scope_paths" }]);
  assert.deepEqual(
    c.missing.filter((m) => m.lens === "frontend"),
    [],
    "an intentionally-skipped lens is never an absence",
  );

  // AND IT IS NEVER EVIDENCE. The skip lives in its own array and never becomes an outcome,
  // so the finding ledger cannot learn about it: `collectObservations` reads outcomes, and a
  // skip recorded as a `complete: true, authored: true` outcome would have contributed one.
  const observations = collectObservations(outcomes);
  assert.deepEqual(
    observations.filter((o) => o.finding.risk_lens === "frontend"),
    [],
    "a review that did not happen must contribute nothing to the finding ledger",
  );
  const asRecord = c.skipped[0] as Record<string, unknown>;
  for (const key of ["complete", "authored", "outcome", "findings"]) {
    assert.equal(key in asRecord, false, `a skip must not be shaped like an outcome (${key})`);
  }
});

test("FG-689: a plan-skipped lens with NO ledger record blocks by name — an unrecorded skip is a vanished lens", () => {
  const p = plan({ skipped: [{ lens: "frontend", reason: "zero_in_scope_paths" }] });
  const c = assessShardCompleteness(p, [], {});

  assert.equal(c.complete, false);
  assert.deepEqual(c.skipped, []);
  assert.equal(c.missing[0]?.lens, "frontend");
  assert.equal(c.missing[0]?.reason, "skip_unrecorded");
  assert.equal(c.missing[0]?.shard, undefined, "a skipped lens has no shard to name");
  assert.match(c.missing[0]!.detail, /left the panel with nothing saying so/);
});

test("FG-689 AC3: a skipped lens and a lens with no outcome are two DIFFERENT reported states", () => {
  const p = plan({
    lenses: [{ lens: "backend", shards: [shard(1, 1)] }],
    skipped: [{ lens: "frontend", reason: "zero_in_scope_paths" }],
  });
  const c = assessShardCompleteness(p, [], { skips: [skipRecord()] });

  assert.deepEqual(c.skipped, [{ lens: "frontend", reason: "zero_in_scope_paths" }]);
  assert.deepEqual(
    c.missing.map((m) => m.lens),
    ["backend"],
    "the skip satisfies; the absent outcome blocks — they are not the same fact and never share an array",
  );
  assert.equal(c.complete, false);
});

// ─── an empty plan ──────────────────────────────────────────────────────────

test("FG-689: a plan that owes nothing is complete, and owes nothing only because it names nothing", () => {
  const c = assessShardCompleteness(plan(), []);
  assert.equal(c.complete, true);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.skipped, []);
});
