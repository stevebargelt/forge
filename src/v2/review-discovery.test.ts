// FG-639: Stage 2 discovery completeness and Stage 3 normalization.
//
// The discovery half is a FAIL-CLOSED test suite: for each way a lens can fail to produce
// a review — crash, timeout, missing output, malformed output, forge-synthesized verdict —
// the assertion is that no pass and no empty finding set appears, and that the panel is
// reported INCOMPLETE by name. The authored `inconclusive` case is the mirror image: it
// COUNTS as completion and becomes a finding that has to be dispositioned.
//
// The normalization half tests the two directions dedup can be wrong in. Merging two
// distinct defects is the expensive mistake, so same-anchor-different-invariant stays
// separate, differing quotes stay separate, and unanchored observations never merge at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessLens,
  assessShardCompleteness,
  collectObservations,
  normalizeObservations,
  LENS_INCOMPLETE_REASONS,
  type DiscoveryFinding,
  type LensDispatch,
  type LensOutcome,
} from "./review-discovery.js";
import type { ShardPlan } from "../store/reviews.js";

function finding(over: Partial<DiscoveryFinding> = {}): DiscoveryFinding {
  return {
    summary: "the guard is skipped when the map is empty",
    evidence: "src/store/x.ts:12 returns before the guard",
    severity: "high",
    risk_lens: "backend",
    reachability: "demonstrated",
    challenges_contract: false,
    remediation_advice: "advice: move the guard above the early return",
    ...over,
  };
}

function dispatch(over: Partial<LensDispatch> = {}): LensDispatch {
  return {
    lens: "backend",
    role: "red-backend",
    dispatched: true,
    result: { outcome: "pass", findings: [] },
    ...over,
  };
}

const DIGEST = "shard-plan-1-fixture";

/** FG-689 step 8: the FG-639 completeness rules below are now expressed against the ONE
 *  assessor, which is shard-granular. A lens that fits in a single dispatch is the 1-of-1
 *  case, so the rules read the same — which is the point: per-shard completeness SHARPENS the
 *  fail-closed rule rather than replacing it. */
function planOf(...lenses: string[]): ShardPlan {
  return {
    derivation: {
      baseSha: "base000",
      candidateSha: "cand111",
      renderingId: "review-diff-fixture",
      budget: 600_000,
      unit: "utf8_bytes",
      envelopes: {},
      budgetValidatedRuntime: "unvalidated",
      scopesDigest: "scopes-fixture",
    },
    digest: DIGEST,
    fanoutWidth: 4,
    lenses: lenses.map((lens) => ({ lens, shards: [{ index: 1, of: 1, paths: [`src/${lens}.ts`], chars: 100 }] })),
    skipped: [],
    recordedAt: "2026-08-07T00:00:00Z",
  };
}

/** One 1-of-1 dispatch, carrying the identity the coordinator stamps on it. */
function only(over: Partial<LensDispatch> = {}): LensOutcome {
  return assessLens({ ...dispatch(over), shard: { index: 1, of: 1 }, derivationDigest: DIGEST });
}

// ─── fail-closed lens outcomes ──────────────────────────────────────────────

test("FG-639: an authored pass with no findings is a completed outcome", () => {
  const o = assessLens(dispatch());
  assert.equal(o.complete, true);
  if (!o.complete) return;
  assert.equal(o.outcome, "pass");
  assert.equal(o.authored, true);
});

test("FG-639 / PRD #9: a reviewer CRASH yields no pass and no empty finding set", () => {
  const o = assessLens(dispatch({ dispatched: false, failureKind: "container_crash", result: undefined }));
  assert.equal(o.complete, false);
  if (o.complete) return;
  assert.equal(o.reason, "crashed");
  assert.equal("outcome" in o, false, "a crashed lens must not carry an outcome at all");
  assert.equal("findings" in o, false, "a crashed lens must not carry a finding set — not even an empty one");
});

test("FG-639 / PRD #9: a reviewer TIMEOUT is classified distinctly and is not completion", () => {
  const o = assessLens(dispatch({ dispatched: false, failureKind: "idle_timeout", result: undefined }));
  assert.equal(o.complete, false);
  assert.equal(o.complete ? "" : o.reason, "timed_out");
});

test("FG-639 / PRD #9: a lens with no result.json at all is missing_output, not a pass", () => {
  const o = assessLens(dispatch({ result: undefined }));
  assert.equal(o.complete, false);
  assert.equal(o.complete ? "" : o.reason, "missing_output");
});

test("FG-639 / PRD #22: a SYNTHESIZED outcome is never completion, even when it parses", () => {
  const o = assessLens(dispatch({ synthesized: true, result: { outcome: "inconclusive", inconclusive_reason: "no review" } }));
  assert.equal(o.complete, false);
  if (o.complete) return;
  assert.equal(o.reason, "synthesized");
  assert.match(o.detail, /synthesized by forge, not authored by a reviewer/);
});

test("FG-639 / PRD #10: a finding missing a required field invalidates the whole lens result", () => {
  const o = assessLens(
    dispatch({
      result: { outcome: "fail", findings: [{ summary: "something", severity: "high", risk_lens: "backend" }] },
    }),
  );
  assert.equal(o.complete, false);
  if (o.complete) return;
  assert.equal(o.reason, "malformed_output");
  assert.match(o.detail, /reachability|evidence|challenges_contract|remediation_advice/);
});

test("FG-639: a fail outcome with an EMPTY finding set is malformed — a fail must carry a finding", () => {
  const o = assessLens(dispatch({ result: { outcome: "fail", findings: [] } }));
  assert.equal(o.complete, false);
  assert.equal(o.complete ? "" : o.reason, "malformed_output");
});

test("FG-639 / PRD #22: an authored inconclusive IS completion and must state why", () => {
  const withReason = assessLens(
    dispatch({ result: { outcome: "inconclusive", inconclusive_reason: "could not reach the write path" } }),
  );
  assert.equal(withReason.complete, true);
  assert.equal(withReason.complete ? withReason.outcome : "", "inconclusive");

  const withoutReason = assessLens(dispatch({ result: { outcome: "inconclusive" } }));
  assert.equal(withoutReason.complete, false, "a reasonless inconclusive is indistinguishable from a synthesized one");
});

// ─── FG-650: tolerate-and-record at the root, unchanged strictness everywhere else ──

test("FG-650: extra ROOT keys the harness contract mandates are tolerated, and every finding survives", () => {
  const o = assessLens(
    dispatch({
      result: {
        status: "complete",
        verdict: "fail",
        confidence: 0.9,
        notes: "reviewed the reconcile path",
        outcome: "fail",
        findings: [finding({ file: "src/a.ts", line: 12 })],
      },
    }),
  );
  assert.equal(o.complete, true, "an honest outcome carrying `status` is not malformed");
  if (!o.complete) return;
  assert.equal(o.outcome, "fail");
  assert.equal(o.findings.length, 1);
  assert.equal(o.findings[0]?.file, "src/a.ts", "the findings pass through the root tolerance intact");
  assert.deepEqual(
    o.toleratedRootKeys,
    ["confidence", "notes", "status", "verdict"],
    "tolerance is recorded on the outcome by name, never silent",
  );
  assert.equal("status" in (o as Record<string, unknown>), false, "the unknown key is stripped from the validated value");
});

test("FG-650: an outcome with nothing extra records no tolerance at all", () => {
  const o = assessLens(dispatch());
  assert.equal(o.complete ? o.toleratedRootKeys : "unset", undefined);
});

test("FG-650: root tolerance does NOT relax the required root fields", () => {
  const o = assessLens(dispatch({ result: { status: "complete", findings: [finding()] } }));
  assert.equal(o.complete, false, "a missing `outcome` is still malformed");
  assert.equal(o.complete ? "" : o.reason, "malformed_output");
  assert.match(o.complete ? "" : o.detail, /outcome/);
});

test("FG-650: root tolerance does NOT reach inside a finding — an unknown finding key is still refused", () => {
  const o = assessLens(
    dispatch({
      result: { status: "complete", outcome: "fail", findings: [{ ...finding(), certainty: "high" }] },
    }),
  );
  assert.equal(o.complete, false, "nested strictness is the trust surface and must not weaken");
  assert.equal(o.complete ? "" : o.reason, "malformed_output");
  assert.match(o.complete ? "" : o.detail, /certainty/);
});

test("FG-639 / PRD #21: one crashed lens leaves discovery incomplete while the others pass", () => {
  const outcomes: LensOutcome[] = [
    only({ lens: "wide", role: "red-wide" }),
    only({ lens: "security", role: "red-security", dispatched: false, failureKind: "container_crash", result: undefined }),
  ];
  const c = assessShardCompleteness(planOf("wide", "security"), outcomes);
  assert.equal(c.complete, false);
  assert.deepEqual(
    c.missing.map((m) => m.lens),
    ["security"],
  );
  assert.equal(c.missing[0]?.reason, "crashed");
});

test("FG-639: a selected lens that was never dispatched is reported as having no outcome", () => {
  const c = assessShardCompleteness(planOf("wide", "frontend"), [only({ lens: "wide", role: "red-wide" })]);
  assert.equal(c.complete, false);
  assert.equal(c.missing[0]?.lens, "frontend");
  assert.equal(c.missing[0]?.reason, "no_outcome");
});

test("FG-639: a RETRIED lens that later authors an outcome clears the earlier failure", () => {
  const outcomes: LensOutcome[] = [
    only({ lens: "wide", role: "red-wide", dispatched: false, failureKind: "container_crash", result: undefined }),
    only({ lens: "wide", role: "red-wide" }),
  ];
  assert.equal(assessShardCompleteness(planOf("wide"), outcomes).complete, true);
});

// ─── FG-689: shard identity travels with the outcome, on BOTH branches ──────

test("FG-689: an authored outcome carries the shard identity and the partition it was cut under", () => {
  const o = assessLens(
    dispatch({ lens: "wide", role: "red-wide", shard: { index: 2, of: 3 }, derivationDigest: "sha256:p" }),
  );
  assert.equal(o.complete, true);
  assert.deepEqual(o.shard, { index: 2, of: 3 });
  assert.equal(o.derivationDigest, "sha256:p");
});

test("FG-689: a CRASHED shard keeps its identity — the shard that failed is the one that has to be named", () => {
  const o = assessLens(
    dispatch({
      lens: "wide",
      role: "red-wide",
      dispatched: false,
      failureKind: "container_crash",
      result: undefined,
      shard: { index: 2, of: 3 },
      derivationDigest: "sha256:p",
    }),
  );
  assert.equal(o.complete, false);
  assert.deepEqual(o.shard, { index: 2, of: 3 }, "an identity only successful outcomes keep names nothing when it matters");
  assert.equal(o.derivationDigest, "sha256:p");
});

test("FG-689: a dispatch with no shard records none — nothing here invents an identity", () => {
  const o = assessLens(dispatch({ lens: "wide", role: "red-wide" }));
  assert.equal(o.shard, undefined);
  assert.equal(o.derivationDigest, undefined);
  assert.equal("shard" in (o as Record<string, unknown>), false);
});

test("FG-689 step 8: there is exactly ONE completeness assessor, and it is the shard-granular one", async () => {
  // The lens-granular assessor is DELETED, not left beside this one. Two answers to "is
  // discovery complete" is the D1 fail-open with a longer fuse: any call site that kept the old
  // one — or any new one that reached for it — would let one surviving shard satisfy a lens
  // whose other shards crashed. This asserts the module exports no second assessor, which is
  // the only form of that guarantee a test can hold.
  //
  // Its name is built by concatenation so THIS file does not itself contain the literal a
  // repo-wide grep must not find (the same device fg654-agent-protocol uses for its banned
  // exports).
  const removed = "assessDiscovery" + "Completeness";
  const mod = (await import("./review-discovery.js")) as Record<string, unknown>;
  assert.equal(mod[removed], undefined, `the lens-granular assessor ${removed} must not exist`);
  assert.equal(typeof mod["assessShardCompleteness"], "function");

  // ...and the case that made it wrong: shard 1 authored, shard 2 crashed, lens INCOMPLETE.
  const outcomes: LensOutcome[] = [
    assessLens(dispatch({ lens: "wide", role: "red-wide", shard: { index: 1, of: 2 }, derivationDigest: DIGEST })),
    assessLens(
      dispatch({
        lens: "wide",
        role: "red-wide",
        dispatched: false,
        failureKind: "container_crash",
        result: undefined,
        shard: { index: 2, of: 2 },
        derivationDigest: DIGEST,
      }),
    ),
  ];
  const two: ShardPlan = {
    ...planOf("wide"),
    lenses: [
      {
        lens: "wide",
        shards: [
          { index: 1, of: 2, paths: ["src/a.ts"], chars: 10 },
          { index: 2, of: 2, paths: ["src/b.ts"], chars: 10 },
        ],
      },
    ],
  };
  const c = assessShardCompleteness(two, outcomes);
  assert.equal(c.complete, false);
  assert.deepEqual(
    c.missing.map((m) => `${m.lens} ${m.shard} of ${m.of}`),
    ["wide 2 of 2"],
  );
});

test("FG-639 / PRD #22: an authored inconclusive normalizes into a lens_inconclusive finding", () => {
  const outcomes = [
    assessLens(dispatch({ lens: "security", role: "red-security", result: { outcome: "inconclusive", inconclusive_reason: "no reachable path" } })),
  ];
  const obs = collectObservations(outcomes);
  assert.equal(obs.length, 1);
  assert.equal(obs[0]?.finding.finding_type, "lens_inconclusive");
  assert.match(obs[0]?.finding.summary ?? "", /security lens returned inconclusive: no reachable path/);
});

test("FG-639: observations from an INCOMPLETE lens are never collected", () => {
  const outcomes = [assessLens(dispatch({ synthesized: true, result: { outcome: "fail", findings: [finding()] } }))];
  assert.deepEqual(collectObservations(outcomes), []);
});

// ─── normalization / deduplication ──────────────────────────────────────────

test("FG-639 / PRD #2: the same anchored mechanism from two reviewers becomes ONE finding, both sources kept", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, invariant_ref: "no partial write" }), source: { redRole: "red-wide" } },
    {
      finding: finding({ summary: "worded differently", file: "src/a.ts", line: 12, invariant_ref: "no partial write" }),
      source: { redRole: "red-backend" },
    },
  ]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0]?.mergedFrom, 2);
  assert.deepEqual(
    r.observations[0]?.sources?.map((s) => s.redRole),
    ["red-wide", "red-backend"],
    "every source reviewer survives the merge as provenance",
  );
  assert.equal(r.merges.length, 1);
});

test("FG-639 / PRD #2: a merge does NOT escalate severity or reachability — correlated is not independent", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, severity: "low", reachability: "speculative" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, severity: "critical", reachability: "demonstrated" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0]?.severity, "low", "agreement between correlated reviewers must not raise severity");
  assert.equal(r.observations[0]?.reachability, "speculative", "nor reachability");
});

test("FG-639 / PRD #3: superficially similar findings with DIFFERENT invariants stay separate", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, invariant_ref: "no partial write" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, invariant_ref: "only forge publishes" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 2, "different affected invariants are claims about different promises");
  assert.equal(r.merges.length, 0);
});

test("FG-639 / PRD #3: same anchor and invariant but DIFFERENT quoted text stays separate — unsure means both", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, quoted_text: "if (!guard) return;" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, quoted_text: "log.debug(secret)" }), source: { redRole: "red-security" } },
  ]);
  assert.equal(r.observations.length, 2);
});

test("FG-639: quoted text differing only in whitespace still merges", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, quoted_text: "if (!guard)   return;" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, quoted_text: "if (!guard) return;" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 1);
});

test("FG-639 / PRD #3: UNANCHORED observations never merge — there is no mechanism to compare", () => {
  const r = normalizeObservations([
    { finding: finding({ summary: "same words", invariant_ref: "inv" }), source: { redRole: "red-wide" } },
    { finding: finding({ summary: "same words", invariant_ref: "inv" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 2);
});

test("FG-639: a file-only observation (no line) is unanchored for dedup purposes", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 2);
});

test("FG-639 / PRD #3: an invariant named on ONE side only stays separate — a shared anchor is not a shared claim", () => {
  const r = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, invariant_ref: "no partial write" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12 }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(r.observations.length, 2, "one reviewer named the affected promise and the other did not — unsure keeps both");
  assert.equal(r.merges.length, 0);
});

test("FG-639 / PRD #2: acceptance_ref stands in for the affected invariant when that is how the lens named it", () => {
  const same = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, acceptance_ref: "FG-639 AC 1" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, acceptance_ref: "FG-639 AC 1" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(same.observations.length, 1);
  assert.equal(same.observations[0]?.mergedFrom, 2);

  const different = normalizeObservations([
    { finding: finding({ file: "src/a.ts", line: 12, acceptance_ref: "FG-639 AC 1" }), source: { redRole: "red-wide" } },
    { finding: finding({ file: "src/a.ts", line: 12, acceptance_ref: "FG-639 AC 4" }), source: { redRole: "red-backend" } },
  ]);
  assert.equal(different.observations.length, 2, "different acceptance refs are claims about different promises");
});

test("FG-639 / PRD #2 + #3: at ONE anchor, a shared invariant merges while a different one stays — dedup is not keyed on the mechanism alone", () => {
  const at = { file: "src/store/reviews.ts", line: 88 };
  const r = normalizeObservations([
    { finding: finding({ ...at, invariant_ref: "no partial write" }), source: { redRole: "red-wide" } },
    { finding: finding({ ...at, invariant_ref: "no partial write" }), source: { redRole: "red-backend" } },
    { finding: finding({ ...at, invariant_ref: "only forge publishes" }), source: { redRole: "red-security" } },
  ]);
  // All three name the SAME mechanism. A mechanism-only key would have collapsed them into
  // one row carrying three sources, which is the silent merge Stage 3 exists to refuse.
  assert.equal(r.observations.length, 2, "keyed on the mechanism alone all three would have become one finding");
  const merged = r.observations.find((o) => o.invariantRef === "no partial write");
  assert.equal(merged?.mergedFrom, 2);
  assert.deepEqual(merged?.sources?.map((s) => s.redRole), ["red-wide", "red-backend"]);
  const separate = r.observations.find((o) => o.invariantRef === "only forge publishes");
  assert.equal(separate?.mergedFrom, 1);
  assert.deepEqual(separate?.sources?.map((s) => s.redRole), ["red-security"]);
  assert.deepEqual(r.merges, [{ mechanism: "src/store/reviews.ts:88", invariant: "no partial write", sources: 2 }]);
});

test("FG-639 / PRD #2: THREE correlated sources become one finding carrying all three, and the merge arithmetic says so", () => {
  const at = { file: "src/store/reviews.ts", line: 88, invariant_ref: "no partial write" };
  const r = normalizeObservations([
    { finding: finding({ ...at }), source: { redRole: "red-wide", verdictId: "v1" } },
    { finding: finding({ ...at }), source: { redRole: "red-backend", verdictId: "v2" } },
    { finding: finding({ ...at }), source: { redRole: "red-security", verdictId: "v3" } },
  ]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0]?.mergedFrom, 3);
  assert.deepEqual(r.observations[0]?.sources?.map((s) => s.verdictId), ["v1", "v2", "v3"], "every verdict survives as provenance");
  assert.equal(r.merges.length, 2, "two merge events, not an independent review count");
  assert.equal(r.merges[1]?.sources, 3);
});

test("FG-639: the model's own finding id is carried as provenance, never as identity", () => {
  const obs = collectObservations([
    assessLens(dispatch({ result: { outcome: "fail", findings: [finding({ finding_id: "CVE-1" })] } })),
  ]);
  assert.equal(obs[0]?.source.modelFindingId, "CVE-1");
  const r = normalizeObservations(obs, { discoveredSha: "sha1" });
  assert.equal(r.observations[0]?.sources?.[0]?.modelFindingId, "CVE-1");
  assert.equal(r.observations[0]?.discoveredSha, "sha1");
});

// ─── FG-654: the `stale_protocol` reason ────────────────────────────────────

test("FG-654: invariant 17 holds — the vocabulary GREW, no existing reason was removed or renamed", () => {
  for (const reason of ["not_dispatched", "crashed", "timed_out", "missing_output", "malformed_output", "synthesized"]) {
    assert.ok((LENS_INCOMPLETE_REASONS as readonly string[]).includes(reason), `${reason} must not disappear`);
  }
  assert.ok((LENS_INCOMPLETE_REASONS as readonly string[]).includes("stale_protocol"));
});

test("FG-654: `stale_protocol` is matched on the exact literal, not by the loose crash/timeout regexes", () => {
  const of = (failureKind: string) =>
    assessLens({ lens: "wide", role: "red-wide", dispatched: false, failureKind });
  const stale = of("stale_protocol");
  assert.equal(stale.complete, false);
  if (!stale.complete) assert.equal(stale.reason, "stale_protocol");
  // The neighbours keep their classification.
  const crash = of("container_crash");
  if (!crash.complete) assert.equal(crash.reason, "crashed");
  const idle = of("idle_timeout");
  if (!idle.complete) assert.equal(idle.reason, "timed_out");
});

test("FG-654: the per-dispatch protocol record rides the lens OUTCOME, so two lenses carry two shas", () => {
  const a = assessLens({
    lens: "wide",
    role: "red-wide",
    dispatched: true,
    result: { outcome: "clean", findings: [] },
    taskId: "task-a",
    protocol: { role: "red-wide", sha256: "a".repeat(64), taskId: "task-a" },
  });
  const b = assessLens({
    lens: "backend",
    role: "red-backend",
    dispatched: true,
    result: { outcome: "clean", findings: [] },
    taskId: "task-b",
    protocol: { role: "red-backend", sha256: "b".repeat(64), taskId: "task-b" },
  });
  assert.equal(a.protocol?.sha256, "a".repeat(64));
  assert.equal(b.protocol?.sha256, "b".repeat(64));
  assert.notEqual(a.protocol?.sha256, b.protocol?.sha256);
  assert.equal(a.protocol?.taskId, "task-a");
});
