// FG-689 AC2 (step 7): EVERY CHANGED PATH IS OWNED BY A SELECTED LENS, OR THE STAGE REFUSES.
//
// The guarantee this suite holds is a coverage guarantee, and coverage guarantees fail
// silently by default. The two ways it fails here are worth naming, because both were live
// possibilities before this step:
//
//   1. THE PATH SET AND THE BYTES DISAGREE. Coverage used to be checkable against a
//      `git diff --name-only` while the reviewer read a separate flagless `git diff`. Two
//      unpinned renderings of one range can differ — rename detection, quotepath, an
//      orderFile — so "every changed path is covered" could be true of the set nobody
//      dispatched and false of the bytes somebody read. `CoordinatorDeps.reviewDiff` is now
//      ONE seam returning ONE rendering, and the confirmation derives its path set from the
//      same bytes the shards will be cut from (D14). The test that matters is not that the
//      seam exists but that what the confirmation RECORDS equals what the renderer RETURNED.
//
//   2. AN UNOWNED PATH IS ASSIGNED AN OWNER. The moment forge picks a lens for a path nobody
//      assigned, it is the file-path classifier the PRD refuses — and it would be a classifier
//      wearing the coverage guarantee's clothes, reporting success. So an uncovered path is
//      `returns_to_plan`, the same decline the unclassifiable-drift arm already uses, and for
//      the same stated reason: forge does not infer risk lenses from file paths.
//
// WHY `returns_to_plan` AND NOT A FOURTH STATE. `confirmContract` has exactly three ways to
// decline. An uncovered path is the unclassifiable-drift case — the diff grew a surface nobody
// assigned — and a parallel state would be a second answer to a question that already has one.
//
// MODULE LOAD ORDER, deliberately. This file imports `review-contract.js` BEFORE
// `review-shards.js`. The two form a cycle (the contract's coverage check calls
// `resolveScopes`; the sharding module imports the contract's lens vocabulary and types), and
// the cycle is safe only because neither module touches the other's bindings at
// module-evaluation time. `fg689-sharding.test.ts` loads them the other way round in its own
// process, so between the two files both orders are exercised — a top-level reference across
// the cycle would fail one of them with a TDZ error before a single assertion ran.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { confirmContract, type ReviewContract } from "./review-contract.js";
import { resolveScopes } from "./review-shards.js";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { getReview, insertReview } from "../store/reviews.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { fakeRendering, fakeReviewDiff, refusingReviewDiff } from "./review-diff.testkit.js";
import type { Run } from "../types/index.js";

const APPROVED: ReviewContract = {
  threat_model: "a reviewer handed a surface nobody assigned reads as evidence anyway",
  protected_invariants: ["every changed path is owned by at least one selected lens"],
  acceptance_refs: ["FG-689 AC2"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: { wide: ["src/v2/"], backend: ["src/store/"] },
};

// ─── confirmContract: the decision itself ────────────────────────────────────

test("FG-689 AC2: a changed path no selected lens's scope owns returns to plan, naming the path", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    changedPaths: ["src/v2/review-run.ts", "src/store/reviews.ts", "dashboard/src/App.tsx"],
  });
  assert.equal(c.kind, "returns_to_plan");
  const refusal = c.kind === "returns_to_plan" ? c.refusal : "";
  assert.match(refusal, /dashboard\/src\/App\.tsx/, "the refusal names the path that has no owner");
  assert.match(refusal, /does not infer risk lenses from file paths/, "and says why forge will not pick one");
  assert.doesNotMatch(refusal, /src\/v2\/review-run\.ts/, "the covered paths are not reported as a problem");
});

test("FG-689 AC2: EVERY uncovered path is named — the list is not sampled", () => {
  const orphans = ["a-one.ts", "b-two.ts", "c-three.ts", "d-four.ts", "e-five.ts", "f-six.ts"];
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    changedPaths: ["src/v2/review-run.ts", ...orphans],
  });
  assert.equal(c.kind, "returns_to_plan");
  const refusal = c.kind === "returns_to_plan" ? c.refusal : "";
  for (const p of orphans) {
    assert.match(refusal, new RegExp(p.replace(".", "\\.")), `${p} was dropped from the refusal`);
  }
  assert.match(refusal, /^6 changed path\(s\)/, "and the count agrees with the list");
});

test("FG-689 AC2: a diff whose every path is covered confirms exactly as it did before", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    changedPaths: ["src/v2/review-run.ts", "src/v2/review-diff.ts", "src/store/reviews.ts"],
  });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, []);
  assert.deepEqual(c.contract.risk_lenses, ["wide", "backend"]);
  assert.deepEqual(c.changedPaths, ["src/v2/review-run.ts", "src/v2/review-diff.ts", "src/store/reviews.ts"]);
});

test("FG-689 AC2: an empty diff has no coverage question to answer", () => {
  const c = confirmContract(APPROVED, { candidateSha: "cand1", changedPaths: [] });
  assert.equal(c.kind, "confirmed");
});

// Coverage is checked against the CONFIRMED contract, not the approved one — otherwise the
// widening that exists to cover a new surface could never cover it, and the operator's only
// route would be back to the approving authority for a change they are allowed to make.
test("FG-689 AC2: a widening that brings the new surface's owner with it COVERS it", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [
      {
        lens: "frontend",
        reason: "the diff adds a rendered operator surface the approved contract did not cover",
        diffEvidence: ["dashboard/src/App.tsx (new file)"],
        scopePaths: ["dashboard/"],
      },
    ],
    changedPaths: ["src/v2/review-run.ts", "dashboard/src/App.tsx"],
  });
  assert.equal(c.kind, "confirmed", c.kind === "returns_to_plan" ? c.refusal : "");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, ["frontend"]);
});

test("FG-689 AC2: a widening that does NOT reach the new surface still returns to plan", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [
      {
        lens: "security",
        reason: "a credential path appeared",
        diffEvidence: ["src/util/creds.ts"],
        scopePaths: ["src/util/creds.ts"],
      },
    ],
    changedPaths: ["src/util/creds.ts", "dashboard/src/App.tsx"],
  });
  assert.equal(c.kind, "returns_to_plan");
  assert.match(c.kind === "returns_to_plan" ? c.refusal : "", /dashboard\/src\/App\.tsx/);
});

// ORDERING. A proposal that narrows a scope AND leaves a path uncovered must report the
// NARROWING: that is the weakening, it has a named authority route, and reporting the
// uncovered path instead would tell the operator to widen a scope they were in the middle of
// shrinking.
test("FG-689: a narrowing that also uncovers a path reports the NARROWING, not the coverage", () => {
  const alsoDocs: ReviewContract = {
    ...APPROVED,
    lens_scopes: { wide: ["src/v2/", "docs/"], backend: ["src/store/"] },
  };
  const c = confirmContract(alsoDocs, {
    candidateSha: "cand1",
    // `docs/` is dropped from wide's scope, and `docs/concepts.md` is in the diff — so this
    // proposal is a narrowing AND leaves a path uncovered. The narrowing is what gets reported.
    contract: { ...alsoDocs, lens_scopes: { wide: ["src/v2/"], backend: ["src/store/"] } },
    changedPaths: ["src/v2/review-run.ts", "docs/concepts.md"],
  });
  assert.equal(c.kind, "needs_approving_authority");
  assert.deepEqual(
    c.kind === "needs_approving_authority" ? c.narrowedScopes : [],
    [{ lens: "wide", removedPatterns: ["docs/"] }],
  );
  assert.doesNotMatch(
    c.kind === "needs_approving_authority" ? c.refusal : "",
    /owned by no selected lens/,
    "telling the operator to widen a scope they are shrinking is the wrong instruction",
  );
});

test("FG-689: unclassifiable drift still short-circuits ahead of the coverage check", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    unclassifiableDrift: "the diff adds an IPC surface I cannot map to a lens",
    changedPaths: ["dashboard/src/App.tsx"],
  });
  assert.equal(c.kind, "returns_to_plan");
  assert.match(c.kind === "returns_to_plan" ? c.refusal : "", /could not be classified safely/);
});

// The coverage check must not restate the ownership rule. If it did, the confirmation could
// call a path covered that the shard planner then finds nobody owns — the two-renderings
// defect one level up, in the matcher instead of in git.
test("FG-689 D14: the confirmation's coverage answer IS resolveScopes' answer", () => {
  const paths = ["src/v2/review-run.ts", "src/store/reviews.ts", "dashboard/src/App.tsx", "docker/Dockerfile"];
  const { uncovered } = resolveScopes(APPROVED, paths);
  assert.deepEqual(uncovered, ["dashboard/src/App.tsx", "docker/Dockerfile"]);

  const c = confirmContract(APPROVED, { candidateSha: "cand1", changedPaths: paths });
  assert.equal(c.kind, "returns_to_plan");
  for (const p of uncovered) {
    assert.match(c.kind === "returns_to_plan" ? c.refusal : "", new RegExp(p.replace(/[.\\/]/g, "\\$&")));
  }
});

// ─── the stage: nothing is recorded and nothing is dispatched ────────────────

const RUN: Run = {
  id: "run-fg689-coverage",
  workflow: "feature",
  title: "coverage",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-coverage";

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

function parkAtConfirmation(over: { baseSha?: string } = {}): void {
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-689",
    reviewMode: "evidence_led",
    ...("baseSha" in over ? (over.baseSha !== undefined ? { baseSha: over.baseSha } : {}) : { baseSha: "base000" }),
    candidateSha: "cand111",
    contract: APPROVED,
    state: "confirming_contract",
    stageEvidence: { verified_entry: { sha: "cand111", at: "2026-08-07T00:00:01Z" } },
  });
}

/** Stage 2a deps with every container seam wired to explode. Stage 2a dispatches nothing, and
 *  a refusal that dispatched anyway would fail here rather than pass quietly. */
function stageDeps(over: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    headSha: () => "cand111",
    verify: () => {
      throw new Error("Stage 2a must not verify");
    },
    reviewDiff: fakeReviewDiff(["src/v2/review-run.ts"]),
    proposeContract: ({ changedPaths }) => ({
      candidateSha: "",
      changedPaths,
      noDrift: { diffSummary: `${changedPaths.length} path(s)`, statement: "no lens change is needed" },
    }),
    dispatchLens: () => {
      throw new Error("an uncovered path must never reach a lens dispatch");
    },
    materializeFixBatch: () => {
      throw new Error("unreachable");
    },
    dispatchFixer: () => {
      throw new Error("unreachable");
    },
    commitFixCycle: () => {
      throw new Error("unreachable");
    },
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
    ...over,
  };
}

test("FG-689 AC2: an uncovered path refuses the stage, records NOTHING and dispatches nothing", async () => {
  parkAtConfirmation();
  const outcome = await runNextStage(
    REVIEW,
    stageDeps({ reviewDiff: fakeReviewDiff(["src/v2/review-run.ts", "dashboard/src/App.tsx"]) }),
  );

  assert.equal(outcome.transition.kind, "confirm_contract");
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /dashboard\/src\/App\.tsx/);
  const review = getReview(REVIEW);
  assert.equal(review?.contractConfirmedSha, undefined, "nothing was confirmed");
  assert.equal(review?.stageEvidence?.contract_confirmed, undefined, "and no stage record was written");
});

test("FG-689 D14: what the confirmation RECORDS is exactly what the rendering RETURNED", async () => {
  parkAtConfirmation();
  const paths = ["src/v2/review-run.ts", "src/v2/review-diff.ts", "src/store/reviews.ts"];
  const rendered = fakeRendering("base000", "cand111", paths);
  assert.equal(rendered.ok, true);

  const outcome = await runNextStage(REVIEW, stageDeps({ reviewDiff: () => rendered }));
  assert.equal(outcome.status, "advanced", outcome.message);

  const stage = getReview(REVIEW)?.stageEvidence?.contract_confirmed;
  const meta = stage?.meta as {
    changedPaths?: string[];
    rendering?: { renderingId: string; baseSha: string; candidateSha: string };
  };
  assert.deepEqual(
    meta.changedPaths,
    rendered.ok ? rendered.rendering.paths : [],
    "the recorded path set is the rendering's path set — one rendering, one set",
  );
  assert.equal(meta.rendering?.renderingId, rendered.ok ? rendered.rendering.renderingId : "");
  assert.equal(meta.rendering?.baseSha, "base000", "and it records WHICH base it was rendered against");
  assert.equal(meta.rendering?.candidateSha, "cand111");
});

test("FG-689 D15: a rendering that cannot be computed refuses the stage BY NAME", async () => {
  parkAtConfirmation();
  const outcome = await runNextStage(
    REVIEW,
    stageDeps({
      reviewDiff: refusingReviewDiff("diff_unreadable", "git exploded and nothing was rendered."),
    }),
  );

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /diff_unreadable/, "the refusal names the reason");
  assert.match(outcome.message, /git exploded/, "and carries the renderer's own statement");
  assert.match(outcome.message, /No contract confirmation was recorded/);
  const review = getReview(REVIEW);
  assert.equal(review?.contractConfirmedSha, undefined);
  assert.equal(review?.stageEvidence?.contract_confirmed, undefined, "no evidence over a diff nobody computed");
});

test("FG-689: a review with no base sha still refuses with the message it always did", async () => {
  parkAtConfirmation({ baseSha: undefined });
  const outcome = await runNextStage(
    REVIEW,
    stageDeps({
      reviewDiff: () => {
        throw new Error("the base check must fire BEFORE the rendering seam is reached");
      },
    }),
  );

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /records no base sha/);
  assert.match(outcome.message, /cannot name its base cannot confirm a contract/);
});
