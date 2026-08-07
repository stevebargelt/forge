// FG-689 step 9: SHARD-GRANULARITY RETRY AND THE RE-PARTITION REFUSAL, through the real stage
// machine and the real store.
//
// Two operator verbs are the subject, and each exists to close a specific way a large review
// goes wrong:
//
//   * `--retry-shard <lens>:<index>` (D7). Without it the cheapest unblock for one crashed
//     container is "run discovery again", and the moment that pass writes through anything
//     coarser than a shard it destroys the coverage that already happened. So a retry
//     dispatches EXACTLY the named shard, leaves every already-authored outcome
//     BYTE-IDENTICAL, and leaves the review incomplete until the retried shard authors. A
//     selector naming a shard that owes nothing is REFUSED rather than re-dispatched: silently
//     re-reviewing an authored shard would overwrite evidence through the verb that exists to
//     preserve it.
//   * `--shard-budget <n>` (D4/D17). A shard's identity is a function of its derivation, so
//     changing the budget re-partitions and every durable shard-scoped decision — acceptances,
//     skip records, shard outcomes — starts describing a partition that no longer exists.
//     Those are NAMED, all of them, and none is dropped: the operator who decided something
//     once has to be able to read that it no longer applies.
//
// The dispatcher is a fake and the diff is a fixture: the subject is the coordinator's dispatch
// SET and its durable writes, not the container. What one container is handed is covered at the
// wiring seam.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import {
  getReview,
  ingestFindings,
  insertReview,
  lensOutcomeRecordsOf,
  recordLensAcceptance,
  recordStageEvidence,
  setReviewState,
} from "../../store/reviews.js";
import { runNextStage, type CoordinatorDeps, type LensContext, type ShardSelector } from "../../v2/review-run.js";
import { REVIEW_DIFF_RENDERING_ID, REVIEW_DIFF_SIZE_UNIT, type ReviewDiffFile, type ReviewDiffResult } from "../../v2/review-diff.js";
import { registerReview } from "./review.js";
import type { Run } from "../../types/index.js";

const RUN: Run = {
  id: "run-fg689-retry",
  workflow: "feature",
  title: "shard retry",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-retry";
const BASE = "base689retry";
const CONF = "conf689retry";

/** `wide` owns everything under src/, `backend` only the store, and `security` owns a path the
 *  rendering below never contains — which is how the intentionally-skipped state is reached
 *  without a second contract. */
const CONTRACT = {
  threat_model: "a retry that writes coarser than a shard destroys the coverage it exists to keep",
  protected_invariants: ["a shard retry preserves every already-authored shard outcome"],
  acceptance_refs: ["FG-689 D7", "FG-689 D12", "FG-689 D17"],
  risk_lenses: ["wide", "backend", "security"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: {
    wide: ["src/"],
    backend: ["src/store/"],
    security: ["src/util/creds.ts"],
  },
};

const SMALL = 400;
/** One file per shard: `wide` gets 3 shards, `backend` 2. Small enough to reason about, big
 *  enough that "one surviving shard" is a real distinction. */
const ONE_FILE_BUDGET = SMALL + 60;

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
  process.exitCode = undefined;
});

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

const FILES = [
  fileOf("src/store/reviews.ts", SMALL),
  fileOf("src/store/schema.ts", SMALL),
  fileOf("src/v2/review-run.ts", SMALL),
];

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

function parkAtDiscovery(): void {
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
}

type Dispatched = { lens: string; shard: number; of: number };

function deps(opts: {
  calls: Dispatched[];
  crash?: (ctx: LensContext) => boolean;
  budget?: number;
  retryShards?: readonly ShardSelector[];
}): CoordinatorDeps {
  const crash = opts.crash ?? (() => false);
  return {
    headSha: () => CONF,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "green" }),
    reviewDiff: () => rendering(),
    shardBudget: opts.budget ?? ONE_FILE_BUDGET,
    ...(opts.retryShards !== undefined ? { retryShards: opts.retryShards } : {}),
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx) => {
      opts.calls.push({ lens: ctx.lens, shard: ctx.shard.index, of: ctx.shard.of });
      const dead = crash(ctx);
      return {
        lens: ctx.lens,
        role: ctx.role,
        dispatched: !dead,
        ...(dead ? { failureKind: "container_crash" } : {}),
        taskId: `task-${ctx.lens}-${ctx.shard.index}`,
        ...(dead ? {} : { result: { outcome: "pass", findings: [] } }),
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
}

/** The ledger record for one shard, as bytes. "Byte-identical" is the only assertion that can
 *  see a retry that rewrote an authored outcome with an equal-looking one. */
function outcomeBytes(lens: string, shard: number): string | undefined {
  const review = getReview(REVIEW);
  if (!review) return undefined;
  const rec = (lensOutcomeRecordsOf(review) as { lens?: string; shard?: { index?: number } }[]).find(
    (o) => o.lens === lens && o.shard?.index === shard,
  );
  return rec === undefined ? undefined : JSON.stringify(rec);
}

// ─── the retry dispatches exactly what it names ─────────────────────────────

test("FG-689 D7: retrying ONE crashed shard dispatches exactly one container and preserves every authored outcome", async () => {
  parkAtDiscovery();

  // Pass 1: wide shards 2 and 3 crash; everything else authors.
  const first: Dispatched[] = [];
  const pass1 = await runNextStage(
    REVIEW,
    deps({ calls: first, crash: (c) => c.lens === "wide" && c.shard.index >= 2 }),
  );
  assert.equal(pass1.status, "refused", pass1.message);
  assert.equal(first.length, 5, "wide has 3 shards and backend 2 at this budget");
  assert.match(pass1.message, /wide shard 2 of 3/);
  assert.match(pass1.message, /wide shard 3 of 3/);

  const preserved = {
    wide1: outcomeBytes("wide", 1),
    backend1: outcomeBytes("backend", 1),
    backend2: outcomeBytes("backend", 2),
  };
  assert.ok(preserved.wide1 !== undefined && preserved.backend1 !== undefined && preserved.backend2 !== undefined);

  // Pass 2: retry ONLY wide shard 2.
  const second: Dispatched[] = [];
  const pass2 = await runNextStage(
    REVIEW,
    deps({ calls: second, retryShards: [{ lens: "wide", index: 2 }] }),
  );
  assert.deepEqual(second, [{ lens: "wide", shard: 2, of: 3 }], "a retry must dispatch exactly the shard it names");
  assert.equal(pass2.status, "refused", "wide shard 3 is still owed, so the review stays incomplete");
  assert.match(pass2.message, /wide shard 3 of 3/);
  assert.doesNotMatch(pass2.message, /wide shard 2 of 3/, "the retried shard authored and no longer blocks");

  assert.equal(outcomeBytes("wide", 1), preserved.wide1, "the authored shard-1 outcome was rewritten by the retry");
  assert.equal(outcomeBytes("backend", 1), preserved.backend1);
  assert.equal(outcomeBytes("backend", 2), preserved.backend2);

  // Pass 3: retry the last one — now the review completes.
  const third: Dispatched[] = [];
  const pass3 = await runNextStage(
    REVIEW,
    deps({ calls: third, retryShards: [{ lens: "wide", index: 3 }] }),
  );
  assert.deepEqual(third, [{ lens: "wide", shard: 3, of: 3 }]);
  assert.equal(pass3.status, "advanced", pass3.message);
  assert.equal(outcomeBytes("wide", 1), preserved.wide1, "completing the review must not rewrite earlier shards");
});

test("FG-689: several --retry-shard selectors dispatch exactly those shards, and repeats are collapsed", async () => {
  parkAtDiscovery();
  const first: Dispatched[] = [];
  await runNextStage(REVIEW, deps({ calls: first, crash: () => true }));
  assert.equal(first.length, 5);

  const second: Dispatched[] = [];
  await runNextStage(
    REVIEW,
    deps({
      calls: second,
      retryShards: [
        { lens: "wide", index: 1 },
        { lens: "backend", index: 2 },
        { lens: "wide", index: 1 },
      ],
    }),
  );
  assert.deepEqual(
    second.map((c) => `${c.lens}:${c.shard}`).sort(),
    ["backend:2", "wide:1"],
    "a repeated selector must not dispatch two containers for one shard",
  );
});

// ─── the retry refuses rather than destroying evidence ──────────────────────

test("FG-689 D7: retrying a shard that owes nothing refuses BY NAME and starts no container", async () => {
  parkAtDiscovery();
  const first: Dispatched[] = [];
  await runNextStage(REVIEW, deps({ calls: first, crash: (c) => c.lens === "wide" && c.shard.index === 3 }));
  const authored = outcomeBytes("wide", 1);

  const second: Dispatched[] = [];
  const refused = await runNextStage(REVIEW, deps({ calls: second, retryShards: [{ lens: "wide", index: 1 }] }));

  assert.equal(refused.status, "refused");
  assert.match(refused.message, /--retry-shard wide:1 names a shard that owes nothing/);
  assert.match(refused.message, /already carries a schema-valid reviewer-authored outcome under partition/);
  assert.match(refused.message, /No container was started\./);
  assert.deepEqual(second, [], "a refused retry must dispatch nothing");
  assert.equal(outcomeBytes("wide", 1), authored, "and must not touch the ledger");
});

test("FG-689: retrying a shard cleared by an authorized acceptance refuses, naming the acceptance", async () => {
  parkAtDiscovery();
  await runNextStage(REVIEW, deps({ calls: [], crash: (c) => c.lens === "backend" && c.shard.index === 1 }));

  const accepted = recordLensAcceptance(REVIEW, {
    lens: "backend",
    shard: 1,
    operator: true,
    missingEvidence: "the store writers in shard 1 were never read",
    rationale: "accepting a narrower review for this candidate",
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.refusal);

  const calls: Dispatched[] = [];
  const refused = await runNextStage(REVIEW, deps({ calls, retryShards: [{ lens: "backend", index: 1 }] }));
  assert.match(refused.message, /it was cleared by an authorized operator acceptance naming that shard/);
  assert.deepEqual(calls, []);
});

test("FG-689: retrying an out-of-range index, an unplanned lens, or a SKIPPED lens each refuses by name", async () => {
  parkAtDiscovery();
  await runNextStage(REVIEW, deps({ calls: [], crash: () => true }));

  const outOfRange: Dispatched[] = [];
  const a = await runNextStage(REVIEW, deps({ calls: outOfRange, retryShards: [{ lens: "backend", index: 9 }] }));
  assert.match(a.message, /--retry-shard backend:9 names a shard that does not exist/);
  assert.match(a.message, /the backend lens shards 1\.\.2/);
  assert.deepEqual(outOfRange, []);

  // `security`'s authored scope matches no changed path, so the plan gives it ZERO shards and
  // records it intentionally skipped. There is nothing to retry, and the refusal must say WHY
  // rather than reporting an unknown lens.
  const skipped: Dispatched[] = [];
  const b = await runNextStage(REVIEW, deps({ calls: skipped, retryShards: [{ lens: "security", index: 1 }] }));
  assert.match(b.message, /--retry-shard security:1 names a lens this review's recorded shard plan gives no shards to/);
  assert.match(b.message, /recorded as INTENTIONALLY SKIPPED \(zero_in_scope_paths\)/);
  assert.match(b.message, /Widening its scope is the contract's approving authority's decision, not a retry/);
  assert.deepEqual(skipped, []);
});

// ─── the budget override re-partitions, and names what it superseded ────────

test("FG-689 D17: a --shard-budget change names EVERY superseded acceptance, skip record and shard outcome", async () => {
  parkAtDiscovery();

  // Pass 1 at the one-file budget: wide 1 authors, everything else crashes.
  await runNextStage(
    REVIEW,
    deps({ calls: [], crash: (c) => !(c.lens === "wide" && c.shard.index === 1) }),
  );
  const oldDigest = getReview(REVIEW)?.shardPlan?.digest as string;
  assert.ok(oldDigest);

  const accepted = recordLensAcceptance(REVIEW, {
    lens: "wide",
    shard: 2,
    operator: true,
    missingEvidence: "shard 2 crashed twice",
    rationale: "recorded before the budget changed",
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.refusal);

  // Pass 2 with a budget that fits every lens in ONE shard: a different partition entirely.
  const calls: Dispatched[] = [];
  const repartitioned = await runNextStage(REVIEW, deps({ calls, budget: 5_000 }));
  const newDigest = getReview(REVIEW)?.shardPlan?.digest as string;
  assert.notEqual(newDigest, oldDigest, "changing the budget must change the partition's identity");
  assert.equal(repartitioned.status, "advanced", repartitioned.message);

  const m = repartitioned.message;
  assert.match(m, /The shard partition CHANGED/);
  assert.match(m, new RegExp(`${oldDigest} \\(budget ${ONE_FILE_BUDGET} `));
  assert.match(m, new RegExp(`replaced by ${newDigest} \\(budget 5000 `));
  assert.match(m, /are REFUSED — retained in the ledger as history, satisfying nothing/);

  // EVERY kind, and every record of each kind. Five shard outcomes (wide 1..3, backend 1..2),
  // one operator acceptance, one skip record — none of them dropped.
  assert.match(m, /the operator acceptance of wide shard 2 recorded against partition/);
  assert.match(m, /the security lens's intentionally-skipped record \(zero_in_scope_paths\) made under partition/);
  for (const [lens, of] of [["wide", 3], ["backend", 2]] as const) {
    for (let i = 1; i <= of; i += 1) {
      assert.match(
        m,
        new RegExp(`the ${lens} shard ${i} of ${of} outcome authored against partition ${oldDigest}`),
        `${lens} shard ${i} of ${of} was dropped from the supersession report`,
      );
    }
  }

  // NOTHING WAS DELETED: the superseded records are still in the column, as history.
  const records = getReview(REVIEW)?.lensOutcomes as { derivationDigest?: string }[];
  assert.ok(
    records.filter((r) => r.derivationDigest === oldDigest).length >= 7,
    "the superseded records must be retained, not dropped",
  );

  // ...and the durable stage record carries the same list, not only the sentence the operator
  // happened to be looking at.
  const meta = getReview(REVIEW)?.stageEvidence?.discovery?.meta as {
    shardPlan?: { supersededPlan?: string; supersededDecisions?: string[] };
  };
  assert.equal(meta.shardPlan?.supersededPlan, oldDigest);
  assert.ok((meta.shardPlan?.supersededDecisions ?? []).length >= 7);
});

test("FG-689: re-entering discovery with the SAME budget re-partitions nothing and reports no supersession", async () => {
  parkAtDiscovery();
  await runNextStage(REVIEW, deps({ calls: [], crash: (c) => c.lens === "wide" && c.shard.index === 2 }));
  const digest = getReview(REVIEW)?.shardPlan?.digest;

  const again = await runNextStage(REVIEW, deps({ calls: [], retryShards: [{ lens: "wide", index: 2 }] }));
  assert.equal(again.status, "advanced", again.message);
  assert.equal(getReview(REVIEW)?.shardPlan?.digest, digest, "an unchanged derivation must not move the partition");
  assert.doesNotMatch(again.message, /partition CHANGED/);
});

// ─── the CLI refuses --retry-shard when discovery is not what is next ───────

test("FG-689: `forge review continue --retry-shard` refuses when the next transition is not discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fg689-retry-"));
  try {
    execFileSync("git", ["init", "-q", dir]);

    parkAtDiscovery();
    // Park the review at the disposition stop instead: discovery is done, a finding is open.
    await runNextStage(REVIEW, deps({ calls: [] }));
    ingestFindings(REVIEW, [{ summary: "an untriaged finding parks the review at disposition", severity: "high" }]);
    setReviewState(REVIEW, "awaiting_disposition", { reason: "findings await disposition" });

    const err: string[] = [];
    mock.method(console, "error", (...a: unknown[]) => {
      err.push(a.map(String).join(" "));
    });
    mock.method(console, "log", () => {});
    try {
      const program = new Command();
      registerReview(program);
      await program.parseAsync(
        ["review", "continue", REVIEW, "--project", dir, "--retry-shard", "wide:1"],
        { from: "user" },
      );
    } finally {
      mock.restoreAll();
    }

    const message = err.join("\n");
    assert.match(message, /--retry-shard names a shard of the DISCOVERY stage/);
    assert.match(message, /one valid next transition is 'await_disposition'/);
    assert.match(message, /Nothing was dispatched and nothing was written/);
    assert.equal(process.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
