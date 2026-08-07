// FG-689 step 5, unit tier: the pure deciders — scope resolution, coverage, and deterministic
// size-bounded sharding with fail-by-measurement.
//
// The properties this file exists to keep true, in the order they can fail:
//
//   1. NO PATH IS EVER LOST. The union of a lens's shard path lists equals its owned set
//      exactly — no drop, no duplicate, no reorder. A dropped path is a surface nobody
//      reviewed, reported as a completed review.
//   2. THE PARTITION IS REPRODUCIBLE. Same inputs, same plan, byte for byte, in this process
//      and in any other. A durable decision bound to "shard 2 of 3" is meaningless if shard 2
//      of 3 cannot be re-derived, so the digests below are locked by VALUE, not by
//      recomputing them the same way the implementation does.
//   3. NOTHING IS EVER MADE TO FIT. A file bigger than one shard refuses, citing the host's
//      measurement, the budget and the unit. It never truncates, samples or summarizes.
//   4. NOTHING IS INFERRED FROM A FILENAME. The matcher owns literal paths and directory
//      prefixes and nothing else — no globs, no extensions, no negation (D5).
//
// The dogfood numbers below are MEASURED, not invented: DOGFOOD_FILES is the exact per-file
// UTF-8 byte distribution of the pinned rendering of 11c2b561..c4fe691a (FG-591's candidate),
// 46 files totalling 1,170,885 bytes, largest src/cli/commands/queue.ts at 80,462. That lets
// the unit tier assert FG-689's dogfood shard counts without spawning git — the rendering
// itself is proven against a real repository in fg689-pinned-rendering.worktree.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVIEW_DIFF_RENDERING_ID, REVIEW_DIFF_SIZE_UNIT, type ReviewDiffFile } from "./review-diff.js";
import type { RiskLens } from "./review-contract.js";
import type { PlannedLens, PlannedShard, ShardDerivation, SkippedLens } from "../store/reviews.js";
import {
  DEFAULT_FANOUT_WIDTH,
  DEFAULT_SHARD_BUDGET,
  SHARD_BUDGET_UNIT,
  UNVALIDATED_BUDGET_RUNTIME,
  matchesScopePattern,
  planShards,
  resolveScopes,
  scopesDigestOf,
  shardPlanDigest,
  type ScopedContract,
} from "./review-shards.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Digests produced by a DIFFERENT process than the one asserting them, locked by value.
 *  Recomputing them here the way the implementation does would assert nothing: the point is
 *  that a review whose plan was recorded last week still matches the digest computed today.
 *  A change to the canonical serialization, the hash, the prefix or the truncation breaks
 *  these, which is exactly the noise it should make. */
const SCOPES_DIGEST_LOCK = "f76c9471f5b558ca15225b863a54599a";
const PLAN_DIGEST_LOCK = "shard-plan-1-a9f1ecd85d5df3992fe1ec484ade1540";
/** A fixed rendering id for the lock, so these values test THIS module's canonicalization
 *  rather than re-locking `review-diff.ts`'s pinned flag list from a second place. */
const LOCK_RENDERING_ID = "review-diff-1-0000000000000000";

/** [path, utf8 bytes] for every file in the pinned rendering of 11c2b561..c4fe691a. */
const DOGFOOD_FILES: [string, number][] = [
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

/** Bodies are irrelevant to every decision this module makes — see the `.body` assertion
 *  below — so the fixture fills them with a body of exactly the measured byte length. */
function file(path: string, chars: number): ReviewDiffFile {
  return { path, body: "x".repeat(chars), chars, utf16Chars: chars };
}

const DOGFOOD: ReviewDiffFile[] = DOGFOOD_FILES.map(([p, c]) => file(p, c));
const DOGFOOD_PATHS = DOGFOOD.map((f) => f.path);

function derivation(over: Partial<ShardDerivation> = {}): ShardDerivation {
  return {
    baseSha: "11c2b561aa00000000000000000000000000000a",
    candidateSha: "c4fe691a0000000000000000000000000000000b",
    renderingId: REVIEW_DIFF_RENDERING_ID,
    budget: DEFAULT_SHARD_BUDGET,
    unit: SHARD_BUDGET_UNIT,
    budgetValidatedRuntime: UNVALIDATED_BUDGET_RUNTIME,
    scopesDigest: "0".repeat(32),
    ...over,
  };
}

function contract(lens_scopes: Record<string, string[]>): ScopedContract {
  return {
    risk_lenses: Object.keys(lens_scopes) as RiskLens[],
    lens_scopes: lens_scopes as ScopedContract["lens_scopes"],
  };
}

function ok(result: ReturnType<typeof planShards>) {
  assert.equal(result.ok, true, result.ok ? "" : `unexpected refusal: ${result.refusal}`);
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

// ---------------------------------------------------------------------------
// 1. the unit and the budget travel together (D4, D10)
// ---------------------------------------------------------------------------

test("the default budget is a configured number carried with its unit and the runtime it was validated on", () => {
  assert.equal(DEFAULT_SHARD_BUDGET, 600_000);
  assert.equal(SHARD_BUDGET_UNIT, REVIEW_DIFF_SIZE_UNIT);
  assert.equal(SHARD_BUDGET_UNIT, "utf8_bytes");
  // Step 11 replaces this with the runtime one real dispatch validated. Until then the honest
  // value is that nothing validated it — a runtime name here that no dispatch proved is
  // exactly the untested number D4 forbids.
  assert.equal(UNVALIDATED_BUDGET_RUNTIME, "unvalidated");
  assert.equal(DEFAULT_FANOUT_WIDTH, 4);

  // NOT derived from the provider cap that crashed FG-591. Locked by value so a later edit
  // to "cap * 0.6" or similar has to argue with a test.
  const CRASHING_CAP = 1_048_576;
  assert.ok(DEFAULT_SHARD_BUDGET < CRASHING_CAP * 0.6, "the budget must keep real margin below the observed cap");
  const src = readFileSync(fileURLToPath(new URL("./review-shards.ts", import.meta.url)), "utf8");
  assert.ok(!/1_?048_?576\s*[*/]/.test(src), "the budget must not be computed from the provider cap");
});

// ---------------------------------------------------------------------------
// 2. scope resolution: authored only, no inference, no exclusion form
// ---------------------------------------------------------------------------

test("a scope pattern is a literal path or a directory prefix — and nothing else", () => {
  assert.equal(matchesScopePattern("src/queue/loop.ts", "src/queue/loop.ts"), true);
  assert.equal(matchesScopePattern("src/queue/loop.ts", "src/queue"), true);
  assert.equal(matchesScopePattern("src/queue/loop.ts", "src/queue/"), true);
  assert.equal(matchesScopePattern("src/queue/deep/nested/x.ts", "src/queue"), true);

  // A prefix owns a DIRECTORY, not a string prefix.
  assert.equal(matchesScopePattern("src/queue-board.ts", "src/queue"), false);
  assert.equal(matchesScopePattern("src/queueing.ts", "src/queue"), false);

  // No glob expansion: `*` is an ordinary character, so a globbed pattern owns nothing and
  // its paths surface as uncovered, which refuses. Failing this way round is deliberate.
  assert.equal(matchesScopePattern("src/a.ts", "src/*.ts"), false);
  assert.equal(matchesScopePattern("src/a.ts", "src/**"), false);

  // NO NEGATION / EXCLUSION FORM (D5). `review-contract.ts` refuses a leading `!` at the
  // schema; nothing here would honour one if it arrived anyway.
  assert.equal(matchesScopePattern("src/a.ts", "!src/a.ts"), false);
  assert.equal(matchesScopePattern("src/a.ts", "!src"), false);
});

test("resolveScopes reports every path no selected lens owns as uncovered", () => {
  const res = resolveScopes(contract({ backend: ["src/store"], security: ["src/v2/review-contract.ts"] }), [
    "src/store/reviews.ts",
    "src/v2/review-contract.ts",
    "dashboard/client/main.js",
    "docs/concepts.md",
  ]);

  assert.deepEqual(res.owned.get("backend"), ["src/store/reviews.ts"]);
  assert.deepEqual(res.owned.get("security"), ["src/v2/review-contract.ts"]);
  assert.deepEqual(res.uncovered, ["dashboard/client/main.js", "docs/concepts.md"]);
  assert.deepEqual(res.skipped, []);
});

test("a generated artifact is owned like any other path — there is no exclusion route (D5)", () => {
  // The dogfood's dashboard/client/*.js build outputs are ~53k bytes of low-evidence budget.
  // They are owned, they are paid for, and the only alternative forge offers is leaving them
  // uncovered — which refuses. There is deliberately no third option.
  const generated = DOGFOOD_PATHS.filter((p) => p.startsWith("dashboard/client/"));
  const unowned = resolveScopes(contract({ backend: ["src"] }), DOGFOOD_PATHS);
  for (const p of generated) assert.ok(unowned.uncovered.includes(p), `${p} must surface as uncovered`);

  const owned = resolveScopes(contract({ frontend: ["dashboard/client"], backend: ["src"] }), DOGFOOD_PATHS);
  assert.deepEqual(owned.owned.get("frontend"), generated.sort());
  const bytes = DOGFOOD.filter((f) => generated.includes(f.path)).reduce((n, f) => n + f.chars, 0);
  assert.equal(bytes, 53_134);
});

test("overlap between lenses is allowed and expected", () => {
  const res = resolveScopes(contract({ wide: ["src"], backend: ["src/store"], security: ["src/store/reviews.ts"] }), [
    "src/store/reviews.ts",
    "src/v2/review-run.ts",
  ]);
  assert.deepEqual(res.owned.get("wide"), ["src/store/reviews.ts", "src/v2/review-run.ts"]);
  assert.deepEqual(res.owned.get("backend"), ["src/store/reviews.ts"]);
  assert.deepEqual(res.owned.get("security"), ["src/store/reviews.ts"]);
  assert.deepEqual(res.uncovered, []);
});

test("a lens owning nothing in this change is recorded skipped, never dispatched with zero paths", () => {
  const res = resolveScopes(contract({ backend: ["src/store"], frontend: ["dashboard"] }), ["src/store/reviews.ts"]);
  assert.deepEqual(res.owned.get("frontend"), []);
  assert.deepEqual(res.skipped, [{ lens: "frontend", reason: "zero_in_scope_paths" }]);

  const plan = ok(
    planShards({
      files: [file("src/store/reviews.ts", 1200)],
      owned: res.owned,
      skipped: res.skipped,
      derivation: derivation(),
    }),
  );
  assert.deepEqual(
    plan.lenses.map((l) => l.lens),
    ["backend"],
    "a skipped lens gets ZERO shards, not an empty shard list in `lenses`",
  );
  assert.deepEqual(plan.skipped, [{ lens: "frontend", reason: "zero_in_scope_paths" }]);
});

// ---------------------------------------------------------------------------
// 3. determinism and partition identity (D17)
// ---------------------------------------------------------------------------

test("the same inputs produce a byte-identical plan across 100 calls", () => {
  const res = resolveScopes(contract({ wide: DOGFOOD_PATHS }), DOGFOOD_PATHS);
  const args = { files: DOGFOOD, owned: res.owned, skipped: res.skipped, derivation: derivation() };
  const first = JSON.stringify(ok(planShards(args)));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(ok(planShards(args))), first, `call ${i} differed`);
  }
  // No clock reading escaped into the plan — `recordedAt` is the store's to stamp.
  assert.ok(!("recordedAt" in JSON.parse(first)), "the plan must carry no timestamp");
});

test("the plan is reproducible ACROSS PROCESSES — digests locked by value, not recomputed", () => {
  assert.equal(scopesDigestOf({ wide: ["src"], backend: ["src/store", "src/v2"] }), SCOPES_DIGEST_LOCK);
  assert.equal(
    scopesDigestOf({ backend: ["src/v2", "src/store", "src/store"], wide: ["src"] }),
    SCOPES_DIGEST_LOCK,
    "the digest is over the NORMALIZED scopes — key order, duplicates and pattern order do not move it",
  );
  assert.equal(
    shardPlanDigest(derivation({ scopesDigest: SCOPES_DIGEST_LOCK, renderingId: LOCK_RENDERING_ID })),
    PLAN_DIGEST_LOCK,
  );
});

test("every input that determines the partition moves the digest; nothing else does", () => {
  const base = derivation();
  const d0 = shardPlanDigest(base);
  assert.equal(shardPlanDigest(derivation()), d0, "identical derivations must agree");

  for (const [label, over] of [
    ["budget", { budget: DEFAULT_SHARD_BUDGET - 1 }],
    ["baseSha", { baseSha: `${"1".repeat(40)}` }],
    ["candidateSha", { candidateSha: `${"2".repeat(40)}` }],
    ["scopesDigest", { scopesDigest: "f".repeat(32) }],
    ["unit", { unit: "tokens" }],
    ["renderingId", { renderingId: "review-diff-1-deadbeefdeadbeef" }],
  ] as [string, Partial<ShardDerivation>][]) {
    assert.notEqual(shardPlanDigest(derivation(over)), d0, `changing ${label} must change the digest`);
  }

  // Re-validating the same budget against a new runtime moves no byte between shards.
  // Digesting it would supersede every operator acceptance for an identical partition.
  assert.equal(shardPlanDigest(derivation({ budgetValidatedRuntime: "codex-subscription" })), d0);
});

test("fanoutWidth is recorded with the plan and does not change the partition", () => {
  const res = resolveScopes(contract({ backend: ["src"] }), ["src/a.ts"]);
  const args = { files: [file("src/a.ts", 10)], owned: res.owned, skipped: res.skipped, derivation: derivation() };
  assert.equal(ok(planShards(args)).fanoutWidth, DEFAULT_FANOUT_WIDTH);
  const wide = ok(planShards({ ...args, fanoutWidth: 2 }));
  assert.equal(wide.fanoutWidth, 2);
  assert.equal(wide.digest, ok(planShards(args)).digest);
  assert.deepEqual(wide.lenses, ok(planShards(args)).lenses);

  const bad = planShards({ ...args, fanoutWidth: 0 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "fanout_width_invalid");
});

// ---------------------------------------------------------------------------
// 4. NO PATH IS EVER LOST
// ---------------------------------------------------------------------------

test("for every lens the union of its shards' paths equals its owned set exactly", () => {
  // A deterministic generator, not Math.random: a property test that cannot be re-run on the
  // input that failed is not evidence.
  let seed = 0x689;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let iteration = 0; iteration < 200; iteration++) {
    const count = 1 + rnd(40);
    const files: ReviewDiffFile[] = [];
    for (let i = 0; i < count; i++) {
      // Deliberately unsorted generation order, so a packer that trusted input order breaks.
      files.push(file(`src/${String(rnd(1000)).padStart(4, "0")}-${i}.ts`, 1 + rnd(9000)));
    }
    const budget = 500 + rnd(20000);
    const scopes = contract({ wide: ["src"], backend: files.filter((_, i) => i % 3 === 0).map((f) => f.path) });
    const res = resolveScopes(scopes, files.map((f) => f.path));

    const result = planShards({ files, owned: res.owned, skipped: res.skipped, derivation: derivation({ budget }) });
    if (!result.ok) {
      // The only legitimate refusal over this generator is a file bigger than the budget.
      assert.equal(result.reason, "file_exceeds_budget", `iteration ${iteration}: ${result.refusal}`);
      assert.ok(files.some((f) => f.chars > budget));
      continue;
    }

    for (const lens of ["wide", "backend"] as RiskLens[]) {
      const expected = res.owned.get(lens) ?? [];
      const planned: PlannedLens | undefined = result.plan.lenses.find((l) => l.lens === lens);
      if (expected.length === 0) {
        assert.equal(planned, undefined, `a lens owning nothing must get no shards`);
        continue;
      }
      // Annotated, not inferred: `assert.ok` below is a TS assertion function, and a `const`
      // whose type is still being inferred across one of those degrades to `any`.
      const shards: PlannedShard[] = (planned as PlannedLens).shards;

      const union: string[] = shards.flatMap((s) => s.paths);
      assert.deepEqual(union, [...expected].sort(), `iteration ${iteration}, lens ${lens}: path union differs`);
      assert.equal(new Set(union).size, union.length, "no path may appear in two shards of one lens");

      const sizes: Map<string, number> = new Map(files.map((f) => [f.path, f.chars]));
      for (const shard of shards) {
        assert.ok(shard.chars <= budget, `iteration ${iteration}: shard exceeds budget`);
        assert.equal(
          shard.chars,
          shard.paths.reduce((n, p) => n + (sizes.get(p) as number), 0),
          "a shard's recorded size must be the sum of its files' measured sizes",
        );
      }
      assert.deepEqual(
        shards.map((s) => s.index),
        shards.map((_, i) => i + 1),
        "shard indices are 1-based and contiguous",
      );
      assert.ok(shards.every((s) => s.of === shards.length));
    }
  }
});

test("a path owned but absent from the pinned rendering refuses rather than being dropped", () => {
  const res = resolveScopes(contract({ backend: ["src"] }), ["src/a.ts", "src/gone.ts"]);
  const r = planShards({ files: [file("src/a.ts", 10)], owned: res.owned, skipped: res.skipped, derivation: derivation() });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "owned_path_not_rendered");
  assert.match(r.refusal, /src\/gone\.ts/);
});

test("the plan and the skip list can never disagree about a lens", () => {
  const owned = new Map<RiskLens, string[]>([["backend", []]]);
  const unrecorded = planShards({ files: [], owned, skipped: [], derivation: derivation() });
  assert.equal(unrecorded.ok, false);
  if (!unrecorded.ok) assert.equal(unrecorded.reason, "skipped_lens_disagreement");

  const both = planShards({
    files: [file("src/a.ts", 10)],
    owned: new Map<RiskLens, string[]>([["backend", ["src/a.ts"]]]),
    skipped: [{ lens: "backend", reason: "zero_in_scope_paths" }] as SkippedLens[],
    derivation: derivation(),
  });
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.refusal, /recorded as intentionally skipped but owns 1 path/);
});

// ---------------------------------------------------------------------------
// 5. fail by measurement — nothing is ever made to fit (AC5, AC6)
// ---------------------------------------------------------------------------

test("a single file larger than the budget refuses, naming the path, the measurement, the budget and the unit", () => {
  const res = resolveScopes(contract({ backend: ["src"] }), ["src/cli/commands/queue.ts", "src/cli/program.ts"]);
  const r = planShards({
    files: [file("src/cli/commands/queue.ts", 80_462), file("src/cli/program.ts", 928)],
    owned: res.owned,
    skipped: res.skipped,
    derivation: derivation({ budget: 60_000 }),
  });

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "file_exceeds_budget");
  assert.match(r.refusal, /src\/cli\/commands\/queue\.ts/);
  assert.match(r.refusal, /80462/);
  assert.match(r.refusal, /60000/);
  assert.match(r.refusal, /utf8_bytes/);
  // The unit is spelled out against FG-689's own wording, so a reader of the refusal cannot
  // read the recorded "characters" measurements as anything but byte counts (D10).
  assert.match(r.refusal, /characters/);
  assert.deepEqual(r.unfittable, [{ path: "src/cli/commands/queue.ts", chars: 80_462, lenses: ["backend"] }]);
  assert.match(r.refusal, /No container was started/);
});

test("every oversize file is named, not just the first", () => {
  const res = resolveScopes(contract({ backend: ["src"], wide: ["src/b.ts"] }), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  const r = planShards({
    files: [file("src/a.ts", 90_000), file("src/b.ts", 70_000), file("src/c.ts", 100)],
    owned: res.owned,
    skipped: res.skipped,
    derivation: derivation({ budget: 60_000 }),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(
    r.unfittable?.map((f) => [f.path, f.chars, f.lenses]),
    [
      ["src/a.ts", 90_000, ["backend"]],
      ["src/b.ts", 70_000, ["backend", "wide"]],
    ],
    "an oversize file blocks EVERY lens that owns it, and all offenders report at once",
  );
});

test("the packing code never touches a file body, so it cannot truncate one", () => {
  // FG-689's acceptance suggests grepping the packing code for slice/substring/summarize.
  // That grep is BOTH too weak and too strong: too weak because a synonym defeats it, and too
  // strong because the refusal message legitimately contains the sentence "nothing is
  // truncated, sampled or summarized" — the prose promising the property would fail the test
  // asserting it. The structural property is stronger than either: this module reads only
  // `path` and `chars`, so whatever it might do to a body, it does not have one to do it to.
  const src = readFileSync(fileURLToPath(new URL("./review-shards.ts", import.meta.url)), "utf8");
  assert.ok(!/\.body\b/.test(src), "review-shards.ts must never dereference a rendered body");
  assert.ok(!/\bsubstr(ing)?\s*\(/.test(src), "packing code must not cut a string");

  // And behaviourally: the plan reproduces every owned byte exactly once.
  const res = resolveScopes(contract({ wide: DOGFOOD_PATHS }), DOGFOOD_PATHS);
  const plan = ok(planShards({ files: DOGFOOD, owned: res.owned, skipped: res.skipped, derivation: derivation() }));
  const total = (plan.lenses[0] as PlannedLens).shards.reduce((n, s) => n + s.chars, 0);
  assert.equal(total, 1_170_885, "the shard set accounts for every measured byte of the change");
});

test("a non-positive budget refuses rather than planning a shard per file", () => {
  const res = resolveScopes(contract({ backend: ["src"] }), ["src/a.ts"]);
  for (const budget of [0, -1, 1.5]) {
    const r = planShards({
      files: [file("src/a.ts", 10)],
      owned: res.owned,
      skipped: res.skipped,
      derivation: derivation({ budget }),
    });
    assert.equal(r.ok, false, `budget ${budget} must refuse`);
    if (!r.ok) assert.equal(r.reason, "budget_not_positive");
  }
});

// ---------------------------------------------------------------------------
// 6. the dogfood, at the measured sizes (AC8)
// ---------------------------------------------------------------------------

test("the dogfood fixture is FG-591's measured candidate: 46 files, 1,170,885 bytes, largest 80,462", () => {
  assert.equal(DOGFOOD.length, 46);
  assert.equal(
    DOGFOOD.reduce((n, f) => n + f.chars, 0),
    1_170_885,
  );
  const largest = [...DOGFOOD].sort((a, b) => b.chars - a.chars)[0] as ReviewDiffFile;
  assert.deepEqual([largest.path, largest.chars], ["src/cli/commands/queue.ts", 80_462]);
});

test("a wide scope owning the whole 1,170,885-byte change plans exactly 2 shards at a 600,000 budget", () => {
  const res = resolveScopes(contract({ wide: ["dashboard", "docs", "learnings", "src"] }), DOGFOOD_PATHS);
  assert.deepEqual(res.uncovered, [], "the scope must cover every changed path");
  assert.equal((res.owned.get("wide") as string[]).length, 46);

  const plan = ok(planShards({ files: DOGFOOD, owned: res.owned, skipped: res.skipped, derivation: derivation() }));
  const shards = (plan.lenses[0] as PlannedLens).shards;
  assert.equal(shards.length, 2);
  assert.deepEqual(
    shards.map((s) => [s.index, s.of, s.chars, s.paths.length]),
    [
      [1, 2, 589_016, 27],
      [2, 2, 581_869, 19],
    ],
  );
  assert.ok(shards.every((s) => s.chars <= DEFAULT_SHARD_BUDGET));
});

test("a narrower src/queue scope at 429,346 bytes plans exactly 1 shard", () => {
  const res = resolveScopes(contract({ backend: ["src/queue"] }), DOGFOOD_PATHS);
  const owned = res.owned.get("backend") as string[];
  assert.equal(owned.length, 12);
  assert.equal(
    DOGFOOD.filter((f) => owned.includes(f.path)).reduce((n, f) => n + f.chars, 0),
    429_346,
  );

  const plan = ok(
    planShards({
      files: DOGFOOD,
      owned: new Map([["backend", owned]] as [RiskLens, string[]][]),
      skipped: [],
      derivation: derivation(),
    }),
  );
  const shards = (plan.lenses[0] as PlannedLens).shards;
  assert.deepEqual(
    shards.map((s) => [s.index, s.of, s.chars]),
    [[1, 1, 429_346]],
  );
});
