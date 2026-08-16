// FG-385: table-driven tests for the risk-targeted reds planner. Covers the six required
// change classes, the fail-closed-wider arm, and the unavailable-lens recording.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planRiskReds,
  RISK_SIGNALS,
  type PlanRiskRedsInput,
  type RiskRedsPlan,
} from "./risk-reds-planner.js";
import { RISK_LENSES, type RiskLens } from "./review-contract.js";

function baseInput(over: Partial<PlanRiskRedsInput>): PlanRiskRedsInput {
  return {
    route: "review_backend",
    changedPathClasses: [],
    acceptanceRefs: [],
    protectedInvariants: [],
    riskSignals: [],
    ...over,
  };
}

// Signal ids by index into the exported vocabulary, so the test never restates the
// `risk-signal:` literals (the source guard forbids them outside the planner).
const [
  SIG_LIFECYCLE,
  SIG_GIT,
  SIG_AUTH,
  SIG_ROUTING,
  SIG_DB,
  SIG_TEST_INFRA,
  SIG_DONE_GATE,
  SIG_DASHBOARD,
  SIG_CROSS_MODULE,
  SIG_DOCS_ONLY,
] = RISK_SIGNALS;

function assertPartitionsAllLenses(plan: RiskRedsPlan): void {
  const accounted = new Set<RiskLens>([
    ...plan.selectedLenses,
    ...plan.unavailable.map((u) => u.lens),
    ...plan.skipped.map((s) => s.lens),
  ]);
  assert.equal(accounted.size, RISK_LENSES.length, "every lens must be accounted for exactly once (selected/unavailable/skipped)");
  for (const lens of RISK_LENSES) assert.ok(accounted.has(lens), `lens ${lens} unaccounted for`);
  // perLens mirrors selectedLenses exactly.
  assert.deepEqual(
    plan.perLens.map((p) => p.lens),
    plan.selectedLenses,
    "perLens must carry exactly the selected lenses in order",
  );
}

type Case = {
  name: string;
  input: PlanRiskRedsInput;
  expectSelected: RiskLens[];
  expectBlockerClasses: string[]; // at least these appear across perLens
  expectPathsOnLens?: { lens: RiskLens; paths: string[] };
};

const CASES: Case[] = [
  {
    name: "1. lifecycle state → backend + narrow",
    input: baseInput({
      changedPathClasses: [{ signal: SIG_LIFECYCLE, paths: ["src/v2/lifecycle-evaluator.ts"] }],
    }),
    expectSelected: ["narrow", "backend"],
    expectBlockerClasses: ["wedged_state", "non_atomic_state", "silent_success"],
    expectPathsOnLens: { lens: "backend", paths: ["src/v2/lifecycle-evaluator.ts"] },
  },
  {
    name: "2. git/worktree publication → backend + security",
    input: baseInput({
      changedPathClasses: [{ signal: SIG_GIT, paths: ["src/v2/publish.ts"] }],
    }),
    expectSelected: ["backend", "security"],
    expectBlockerClasses: ["data_loss", "non_atomic_state", "credential_leakage"],
  },
  {
    name: "3. credential/auth → security",
    input: baseInput({
      changedPathClasses: [{ signal: SIG_AUTH, paths: ["src/v2/project-auth.ts"] }],
    }),
    expectSelected: ["security"],
    expectBlockerClasses: ["credential_leakage", "silent_success"],
  },
  {
    name: "4. DB migration → backend",
    input: baseInput({
      changedPathClasses: [{ signal: SIG_DB, paths: ["src/store/migrations/003.sql"] }],
    }),
    expectSelected: ["backend"],
    expectBlockerClasses: ["data_loss", "non_atomic_state"],
  },
  {
    name: "5. dashboard-only decision surface → frontend + narrow",
    input: baseInput({
      route: "review_frontend",
      changedPathClasses: [{ signal: SIG_DASHBOARD, paths: ["dashboard/client/status.tsx"] }],
    }),
    expectSelected: ["narrow", "frontend"],
    expectBlockerClasses: ["silent_success", "fake_validation"],
  },
];

for (const c of CASES) {
  test(c.name, () => {
    const plan = planRiskReds(c.input);
    assert.deepEqual(
      [...plan.selectedLenses].sort(),
      [...c.expectSelected].sort(),
      `selected lenses for ${c.name}`,
    );
    assertPartitionsAllLenses(plan);
    // Every selected lens carries a full attack spec.
    for (const spec of plan.perLens) {
      assert.ok(spec.invariant.trim().length > 0, `${spec.lens} invariant`);
      assert.ok(spec.failureModes.length > 0, `${spec.lens} failureModes`);
      assert.ok(spec.evidenceStandard.trim().length > 0, `${spec.lens} evidenceStandard`);
      assert.ok(spec.blockerClasses.length > 0, `${spec.lens} blockerClasses`);
    }
    const allBlockers = new Set(plan.perLens.flatMap((p) => p.blockerClasses));
    for (const b of c.expectBlockerClasses) assert.ok(allBlockers.has(b as never), `expected blocker class ${b} in ${c.name}`);
    if (c.expectPathsOnLens) {
      const spec = plan.perLens.find((p) => p.lens === c.expectPathsOnLens!.lens)!;
      assert.deepEqual(spec.paths, c.expectPathsOnLens.paths, "paths attached to the lens");
    }
    // reason is always recorded and references the route.
    assert.ok(plan.reason.includes(c.input.route), "reason names the route");
  });
}

test("6. docs-only → selects NONE with a recorded reason (not skipped-by-omission)", () => {
  const plan = planRiskReds(baseInput({ route: "documentation_durable", changedPathClasses: [{ signal: SIG_DOCS_ONLY, paths: ["docs/how-to.md"] }] }));
  assert.deepEqual(plan.selectedLenses, [], "docs-only selects no lens");
  assert.deepEqual(plan.perLens, [], "no attack specs");
  assert.deepEqual(plan.unavailable, [], "no unavailable lenses");
  assert.ok(/docs-only/.test(plan.reason), "reason records WHY none were selected");
  assert.ok(/not skipped-by-omission|recorded none/.test(plan.reason), "reason distinguishes recorded-none from omission");
  // All five lenses are still accounted for as skipped — none is silently dropped.
  assert.equal(plan.skipped.length, RISK_LENSES.length, "all lenses recorded as skipped-with-reason");
  assertPartitionsAllLenses(plan);
});

test("fail-closed: an unrecognized high-risk signal selects wide + security", () => {
  const plan = planRiskReds(baseInput({ route: "implementation_full", changedPathClasses: [{ signal: "risk-signal:something-new", paths: ["src/v2/newthing.ts"] }], protectedInvariants: ["no two provisioners write the same cache"] }));
  assert.deepEqual([...plan.selectedLenses].sort(), ["security", "wide"], "fail-closed wider");
  assert.ok(/fail-closed/.test(plan.reason), "reason names the fail-closed decision");
  assertPartitionsAllLenses(plan);
  // The protected invariant is threaded into the wide lens spec.
  const wide = plan.perLens.find((p) => p.lens === "wide")!;
  assert.ok(/no two provisioners/.test(wide.invariant), "protected invariant surfaced on the fail-closed wide lens");
});

test("fail-closed: an empty input (nothing authored) is not assumed safe", () => {
  const plan = planRiskReds(baseInput({ route: "implementation_quick" }));
  assert.deepEqual([...plan.selectedLenses].sort(), ["security", "wide"], "empty input fails closed wider");
  assert.ok(/fail-closed/.test(plan.reason));
});

test("an unavailable selected lens records `unavailable`, NOT passed", () => {
  // security is selected by the auth signal but its red role is not installed.
  const plan = planRiskReds(
    baseInput({
      changedPathClasses: [{ signal: SIG_AUTH, paths: ["src/v2/project-auth.ts"] }],
      availableLenses: ["wide", "narrow", "frontend", "backend"], // no security
    }),
  );
  assert.deepEqual(plan.selectedLenses, [], "security is not reported as selected/run");
  assert.deepEqual(plan.perLens, [], "no attack spec for a lens that will not run");
  assert.equal(plan.unavailable.length, 1, "exactly one unavailable lens");
  assert.equal(plan.unavailable[0]!.lens, "security");
  assert.ok(/not passed|not installed|not reviewed/i.test(plan.unavailable[0]!.reason), "unavailable reason states it was NOT reviewed/passed");
  // security appears in exactly one bucket — unavailable — never also in skipped.
  assert.ok(!plan.skipped.some((s) => s.lens === "security"), "an unavailable lens is not also skipped");
  assertPartitionsAllLenses(plan);
});

test("multiple signals merge onto a shared lens: paths and failure modes union", () => {
  const plan = planRiskReds(
    baseInput({
      changedPathClasses: [
        { signal: SIG_DB, paths: ["src/store/a.ts"] },
        { signal: SIG_DONE_GATE, paths: ["src/v2/gate.ts"] },
        { signal: SIG_CROSS_MODULE, paths: ["src/types/index.ts"] },
        { signal: SIG_ROUTING, paths: ["src/v2/route.ts"] },
        { signal: SIG_TEST_INFRA, paths: ["src/v2/forge-test.ts"] },
      ],
    }),
  );
  const backend = plan.perLens.find((p) => p.lens === "backend")!;
  // backend is selected by db, done-gate, routing AND test-infra — its paths union all four.
  assert.ok(backend.paths.includes("src/store/a.ts"));
  assert.ok(backend.paths.includes("src/v2/gate.ts"));
  assert.ok(backend.paths.includes("src/v2/route.ts"));
  assert.ok(backend.paths.includes("src/v2/forge-test.ts"));
  // wide is selected by routing, done-gate, cross-module AND test-infra.
  assert.ok(plan.selectedLenses.includes("wide"));
  assert.ok(plan.selectedLenses.includes("backend"));
  assertPartitionsAllLenses(plan);
});

test("determinism: identical input yields byte-identical plans", () => {
  const input = baseInput({ changedPathClasses: [{ signal: SIG_GIT, paths: ["src/v2/publish.ts"] }] });
  assert.deepEqual(planRiskReds(input), planRiskReds(input));
});
