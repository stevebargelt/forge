// FG-639: the coordinator's host wiring, at the one seam that can silently skip a check.
//
// Stage 2a confirms the approved contract AGAINST THE FINAL IMPLEMENTATION DIFF. The wiring
// used to forward the changed paths into the confirmation record and then always propose the
// unchanged contract, so the diff was recorded and never evaluated — drift classification was
// inert unless an operator typed --drift, and every candidate auto-confirmed. This suite pins
// the fail-closed replacement: an unevaluated nonempty diff refuses and surfaces its summary;
// a recorded evaluation proceeds; an empty diff confirms.
//
// It drives `proposeContract` through the REAL `confirmContract`, because the claim that
// matters is the confirmation outcome, not the shape of the proposal object in between.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  buildCoordinatorDeps,
  parseLensWidening,
  resolveReviewBase,
  FIX_BATCH_ENVELOPE_PATH,
  FIX_BATCH_PAYLOAD_PATH,
} from "./review-wiring.js";
import { confirmContract, validateReviewContract, type ReviewContract } from "../../v2/review-contract.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import {
  findingsForReview,
  getReview,
  ingestFindings,
  insertReview,
  markDocsDispatchDelivered,
  openDocsDispatch,
  recordDisposition,
  type Review,
} from "../../store/reviews.js";
import { ensureFixBatch, renderFixBatchEnvelope, serializeFixBatchPayload } from "../../store/fix-batches.js";
import { fixBatchBundleDir } from "../../util/paths.js";
import { runNextStage, type CoordinatorDeps, type FixerContext } from "../../v2/review-run.js";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";

const CONTRACT = validateReviewContract({
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["no partial write"],
  acceptance_refs: ["FG-639 AC 1"],
  risk_lenses: ["wide"],
  non_goals: ["protect the host from malicious candidate code"],
  lens_scopes: { wide: ["src/"] },
});
const APPROVED = (CONTRACT.ok ? CONTRACT.contract : undefined) as ReviewContract;

const REVIEW = {
  id: "review-fg639-wiring",
  reviewMode: "evidence_led",
  ticketId: "FG-639",
  baseSha: "base000",
  candidateSha: "cand111",
  contract: APPROVED,
  state: "confirming_contract",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
} as unknown as Review;

/** Confirm exactly as `runContractConfirmation` does: the wiring proposes, the pure module
 *  decides, and the candidate sha comes from the coordinator rather than the proposal. */
async function confirmVia(
  changedPaths: string[],
  over: { addLenses?: never[] | Parameters<typeof buildCoordinatorDeps>[0]["addLenses"]; unclassifiableDrift?: string } = {},
) {
  const deps = buildCoordinatorDeps({
    projectDir: "/nonexistent-project",
    ticketId: "FG-639",
    git: () => "",
    ...over,
  });
  const proposal = await deps.proposeContract({ review: REVIEW, candidateSha: "cand111", changedPaths });
  return confirmContract(APPROVED, { ...proposal, candidateSha: "cand111", changedPaths });
}

test("FG-639: a NONEMPTY final diff with no recorded drift evaluation refuses to auto-confirm", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts", "src/v2/review-run.ts"]);

  assert.notEqual(outcome.kind, "confirmed", "silently proposing the unchanged contract is the forbidden outcome");
  const refusal = outcome.kind === "confirmed" ? "" : outcome.refusal;
  assert.match(refusal, /no drift evaluation has been recorded for the final implementation diff/);
  assert.match(refusal, /2 changed path\(s\): src\/store\/reviews\.ts, src\/v2\/review-run\.ts/, "the diff summary is surfaced");
  assert.match(refusal, /--add-lens/, "and so is the way to record an evaluation");
  assert.match(refusal, /--drift/);
});

test("FG-639: the surfaced summary names the paths it can and says how many more there are", async () => {
  const paths = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
  const outcome = await confirmVia(paths);
  const refusal = outcome.kind === "confirmed" ? "" : outcome.refusal;
  assert.match(refusal, /14 changed path\(s\)/);
  assert.match(refusal, /\+4 more/, "a long diff is summarized, not reproduced");
});

test("FG-639: a RECORDED evaluation proceeds — the confirmation widens with its evidence", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts"], {
    addLenses: [
      {
        lens: "backend",
        reason: "the diff moves a store write path",
        diffEvidence: ["src/store/reviews.ts"],
        scopePaths: ["src/store/reviews.ts"],
      },
    ],
  });

  assert.equal(outcome.kind, "confirmed", outcome.kind === "confirmed" ? "" : outcome.refusal);
  if (outcome.kind !== "confirmed") return;
  assert.deepEqual(outcome.addedLenses, ["backend"]);
  assert.deepEqual(outcome.changedPaths, ["src/store/reviews.ts"]);
  assert.equal(outcome.confirmedSha, "cand111");
});

test("FG-639: an EMPTY final diff confirms the approved contract unchanged", async () => {
  const outcome = await confirmVia([]);

  assert.equal(outcome.kind, "confirmed");
  if (outcome.kind !== "confirmed") return;
  assert.deepEqual(outcome.addedLenses, [], "nothing was widened and nothing was inferred");
  assert.deepEqual(outcome.contract.risk_lenses, ["wide"]);
});

test("FG-639: operator-named drift still returns to plan rather than confirming", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts"], {
    unclassifiableDrift: "the diff adds a publication path I cannot map to a lens",
  });

  assert.equal(outcome.kind, "returns_to_plan");
  assert.match(
    outcome.kind === "returns_to_plan" ? outcome.refusal : "",
    /cannot map to a lens/,
    "the operator's own words survive — the fail-closed summary does not overwrite them",
  );
});

// ─── the stage, over the real base-sha path ─────────────────────────────────
//
// The cases above drive `proposeContract` directly, so they cannot see the seam BEFORE it:
// runContractConfirmation computes the changed paths itself, and it used to default them to
// [] whenever the review recorded no base sha. An empty diff is precisely what makes the
// fail-closed guard inert, so the review with no base auto-confirmed over a real change.
// These drive `runNextStage` against the real store, the real wiring and the real
// confirmation, which is the only place that defaulting is visible.

const RUN_ID = "run-fg639-wiring";
const STAGED_REVIEW = "review-fg639-wiring-staged";

let db: DatabaseInstance;
let prevDb: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prevDb = setDbForTest(db);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(
    RUN_ID,
    "feature",
    "wiring",
    "active",
    "2026-07-30T00:00:00Z",
    "evidence_led",
  );
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  db.close();
});

/** A review parked exactly at Stage 2a: entry verification recorded, contract approved,
 *  nothing confirmed yet. `base` is the whole variable under test. */
function parkAtConfirmation(base: string | undefined): void {
  insertReview({
    id: STAGED_REVIEW,
    runId: RUN_ID,
    ticketId: "FG-639",
    reviewMode: "evidence_led",
    ...(base !== undefined ? { baseSha: base } : {}),
    candidateSha: "cand111",
    contract: APPROVED,
    state: "confirming_contract",
    stageEvidence: { verified_entry: { sha: "cand111", at: "2026-07-30T00:00:01Z" } },
  });
}

/** The real host wiring over a git that reports `paths` as the base..candidate diff, with
 *  the container-dispatching deps stubbed out — Stage 2a dispatches nothing, and a stage
 *  that tried to would fail loudly here rather than silently pass. */
function stagedDeps(paths: string[], over: Partial<Parameters<typeof buildCoordinatorDeps>[0]> = {}): CoordinatorDeps {
  const git = (args: string[]): string => {
    if (args[0] === "rev-parse") return "cand111\n";
    if (args[0] === "diff" && args[1] === "--name-only") return paths.join("\n");
    return "";
  };
  return {
    ...buildCoordinatorDeps({ projectDir: "/nonexistent-project", ticketId: "FG-639", git, ...over }),
    verify: () => {
      throw new Error("Stage 2a must not verify");
    },
    dispatchLens: () => {
      throw new Error("Stage 2a must not dispatch a lens");
    },
  };
}

test("FG-639: a review with NO base sha REFUSES confirmation — it cannot name the diff it would confirm against", async () => {
  parkAtConfirmation(undefined);
  const outcome = await runNextStage(STAGED_REVIEW, stagedDeps(["src/store/reviews.ts"]));

  assert.equal(outcome.transition.kind, "confirm_contract");
  assert.equal(outcome.status, "refused", "an unnameable base must not become an empty diff and an auto-confirm");
  assert.match(outcome.message, /records no base sha/);
  assert.match(outcome.message, /cannot name its base cannot confirm a contract/);
  assert.equal(getReview(STAGED_REVIEW)?.contractConfirmedSha, undefined, "nothing was confirmed");
  assert.equal(getReview(STAGED_REVIEW)?.stageEvidence?.contract_confirmed, undefined, "and no stage was recorded");
});

test("FG-639: with a base sha, a nonempty diff and NOTHING recorded still refuses through the stage", async () => {
  parkAtConfirmation("base000");
  const outcome = await runNextStage(STAGED_REVIEW, stagedDeps(["src/store/reviews.ts", "src/v2/review-run.ts"]));

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /no drift evaluation has been recorded/);
  assert.match(outcome.message, /2 changed path\(s\)/, "the diff the stage computed from the base is the one surfaced");
  assert.equal(getReview(STAGED_REVIEW)?.contractConfirmedSha, undefined);
});

test("FG-639: a recorded no_drift evaluation ADVANCES the confirmation and is persisted with the diff it examined", async () => {
  parkAtConfirmation("base000");
  const statement = "all four paths are inside the wide lens already selected; no lens change is needed";
  const outcome = await runNextStage(
    STAGED_REVIEW,
    stagedDeps(["src/store/reviews.ts", "src/v2/review-run.ts"], { evaluatedNoDrift: statement }),
  );

  assert.equal(outcome.status, "advanced", outcome.message);
  assert.match(outcome.message, /no_drift/, "the outcome names the evaluation it rests on");

  const review = getReview(STAGED_REVIEW);
  assert.equal(review?.contractConfirmedSha, "cand111");
  const stage = review?.stageEvidence?.contract_confirmed;
  assert.equal(stage?.sha, "cand111");
  assert.match(stage?.detail ?? "", new RegExp(statement.slice(0, 30)), "the evaluator's statement is the record");
  const meta = stage?.meta as { evaluation?: string; noDrift?: { diffSummary: string; statement: string } };
  assert.equal(meta.evaluation, "no_drift");
  assert.equal(meta.noDrift?.statement, statement);
  assert.match(
    meta.noDrift?.diffSummary ?? "",
    /2 changed path\(s\): src\/store\/reviews\.ts, src\/v2\/review-run\.ts/,
    "the diff the evaluator examined is recorded beside the statement — not just that they said so",
  );
});

test("FG-639: no_drift and a widening claim in the same confirmation contradict and are refused", async () => {
  parkAtConfirmation("base000");
  const outcome = await runNextStage(
    STAGED_REVIEW,
    stagedDeps(["src/store/reviews.ts"], {
      evaluatedNoDrift: "nothing to widen",
      addLenses: [{ lens: "backend", reason: "the diff moves a store write path", diffEvidence: ["src/store/reviews.ts"] }],
    }),
  );

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /no_drift AND proposes a contract change/);
  assert.match(outcome.message, /a diff that needs a lens is drift, not no_drift/);
});

// ─── the fixer's bundle, delivered INSIDE the container ─────────────────────
//
// The live pilot's Stage 5 defect. dispatchFixer materialized the hash-verified bundle at
// ~/.forge/reviews/<review>/<batch>/ on the HOST and then named THAT path in the prompt.
// No mount carried it, so the fixer searched every mount, honestly reported the
// authoritative handoff undelivered, and the host correctly refused its empty findings
// array. These pin the delivery: the bundle rides the task dir that already carries
// CLAUDE.md and package.md, the prompt names the in-container path and no other, and a
// payload tampered after materialization never reaches a container at all.

const FIX_REVIEW = "review-fg639-fixer";

function parkAtFix(): FixerContext {
  insertReview({
    id: FIX_REVIEW,
    runId: RUN_ID,
    ticketId: "FG-639",
    reviewMode: "evidence_led",
    baseSha: "base000",
    candidateSha: "cand111",
    contract: APPROVED,
    state: "fixing",
  });
  const observed = ingestFindings(FIX_REVIEW, [
    {
      summary: "the reconcile path can write partially",
      evidence: "line 42 writes before the guard",
      riskLens: "backend",
      reachability: "demonstrated",
    },
  ])[0]!;
  const disposed = recordDisposition(observed.id, {
    decision: "fix_now",
    rationale: "in scope this cycle",
    operator: false,
  });
  assert.equal(disposed.ok, true);
  const { batch } = ensureFixBatch(FIX_REVIEW, "cand111", findingsForReview(FIX_REVIEW));
  return {
    review: getReview(FIX_REVIEW) as Review,
    batch,
    payload: serializeFixBatchPayload(batch.payload),
  };
}

function capturingInvoke(): { invokeFn: (a: InvokeArgs) => Promise<InvokeResult>; calls: InvokeArgs[] } {
  const calls: InvokeArgs[] = [];
  return {
    calls,
    invokeFn: async (a: InvokeArgs): Promise<InvokeResult> => {
      calls.push(a);
      return { runId: RUN_ID, taskId: "task-fixer-1", status: "complete", result: {} };
    },
  };
}

function fixerDeps(invokeFn: (a: InvokeArgs) => Promise<InvokeResult>): CoordinatorDeps {
  return buildCoordinatorDeps({
    projectDir: "/nonexistent-project",
    ticketId: "FG-639",
    git: () => "",
    invokeFn,
  });
}

test("FG-639: the fixer's bundle is DELIVERED into the container, byte for byte", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  const files = calls[0]?.taskFiles ?? {};
  assert.equal(
    files["fix-batch/payload.json"],
    ctx.payload,
    "the hash-verified bytes ride the task dir — the mount the container already has",
  );
  assert.equal(
    JSON.parse(files["fix-batch/envelope.json"] ?? "{}").payload_sha256,
    ctx.batch.payloadSha256,
    "the envelope rides along naming the batch identity the fixer's result is validated against",
  );
});

test("FG-639: the fixer prompt names the IN-CONTAINER path and never the host bundle dir", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  await deps.dispatchFixer(ctx);

  const task = calls[0]?.task ?? "";
  assert.equal(task.includes(FIX_BATCH_PAYLOAD_PATH), true, "the payload is named where the fixer can open it");
  assert.equal(task.includes(FIX_BATCH_ENVELOPE_PATH), true);
  assert.equal(
    task.includes(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id)),
    false,
    "a host path no mount delivers is exactly what made the pilot's fixer report the handoff undelivered",
  );
});

// FG-639 F3: the bundle rides /task, which the agent can write. The prompt must not sell
// those copies as a tamper-proof record — what actually holds is that the HOST's batch is
// authoritative and the result is validated against it either way.
test("FG-639: the fixer prompt claims no tamper-evidence and names the host record as authoritative", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  await deps.dispatchFixer(ctx);

  const task = calls[0]?.task ?? "";
  assert.match(task, /AUTHORITATIVE handoff is the batch the HOST has persisted/);
  assert.match(task, /not a tamper-proof\s+record/);
  assert.match(task, /validated against the[\s\S]*host's expected finding set/);
  assert.doesNotMatch(task, /sha256sum/, "inviting re-verification implies the copies are evidence of something");
});

test("FG-639: a payload tampered AFTER materialization refuses BEFORE the container starts", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const payloadPath = join(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id), "payload.json");
  writeFileSync(payloadPath, readFileSync(payloadPath, "utf8").replace("line 42", "line 43"));

  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, "the bytes it would have delivered are the bytes it re-hashed");
  assert.match(out.error ?? "", /refusing to start the fixer on an unverified delivery snapshot/);
  assert.equal(out.taskId, "", "a refusal from before the container names no task");
});

// FG-639 F2: the envelope is not trusted from disk either. It carries the batch identity the
// fixer reports back under, so an envelope rewritten after materialization would point a real
// fixer at a revision the host will not validate its result against. Verified byte-for-byte
// against a rendering re-derived from the row.
const ENVELOPE_TAMPERS: { label: string; from: string | RegExp; to: string }[] = [
  { label: "the revision", from: `"revision": 1`, to: `"revision": 2` },
  { label: "the payload hash", from: /"payload_sha256": "[0-9a-f]+"/, to: `"payload_sha256": "${"0".repeat(64)}"` },
  { label: "the batch id", from: /"fix_batch_id": "[^"]+"/, to: `"fix_batch_id": "fb-somebody-elses"` },
];

for (const tamper of ENVELOPE_TAMPERS) {
  test(`FG-639: an envelope with ${tamper.label} rewritten on disk refuses BEFORE the container starts`, async () => {
    const ctx = parkAtFix();
    const { invokeFn, calls } = capturingInvoke();
    const deps = fixerDeps(invokeFn);

    await deps.materializeFixBatch(ctx);
    const envelopePath = join(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id), "envelope.json");
    const rewritten = readFileSync(envelopePath, "utf8").replace(tamper.from, tamper.to);
    assert.notEqual(rewritten, readFileSync(envelopePath, "utf8"), "the tamper must actually change the bytes");
    writeFileSync(envelopePath, rewritten);

    const out = await deps.dispatchFixer(ctx);

    assert.equal(out.ok, false);
    assert.equal(calls.length, 0, "no container starts on an envelope the store does not vouch for");
    assert.match(out.error ?? "", /the materialized envelope does not match the persisted batch/);
    assert.equal(out.taskId, "", "a refusal from before the container names no task");
  });
}

test("FG-639: the untampered envelope the wiring delivers IS the row-derived rendering", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, true);
  assert.equal(
    calls[0]?.taskFiles?.["fix-batch/envelope.json"],
    renderFixBatchEnvelope(ctx.batch),
    "one rendering for delivery and verification — two would drift while both looked verified",
  );
});

// ─── FG-649: the fix cycle's COMMIT, which the coordinator now owns ─────────
//
// The live FG-649 loop: the orchestrator committed the fixer's output AFTER the coordinator
// process exited, so Stage 5's `headSha()` read was a guaranteed no-op, the fix stage recorded
// the PRE-fix candidate, and the rechecker was handed a tree without the fixes it was
// rechecking — it honestly reported still_present forever. The commit is the coordinator's now,
// which makes the post-fix sha one forge CREATED. These pin the scope guard and the refusals;
// the end-to-end evidence against a real repository is
// src/v2/fg649-fix-cycle-candidate.integration.test.ts.

/** A git seam that records every invocation and answers `status`/`rev-parse` from a script.
 *
 *  `rev-parse` answers the CANDIDATE until a commit lands and the new head after — the two reads
 *  commitFixCycle makes are about different moments, and collapsing them into one answer would
 *  hide whichever of them was wrong.
 *
 *  FG-649 RF-2/RF-6 grew three more reads, and the fake answers them ABOUT THE COMMIT IT
 *  PRETENDS TO HAVE MADE: `log -1 --format=%s` its subject, `rev-list -1 --parents` its parent,
 *  `diff-tree --name-only` its paths. `subject`/`parent`/`paths` override those for a commit the
 *  fake did NOT author on this pass — which is exactly the crash-recovery and concurrent-writer
 *  state the two findings are about. */
function scriptedGit(script: {
  status?: string;
  preHead?: string;
  head?: string;
  failOn?: string;
  /** The subject `log` reports for a sha the fake did not just author. Default: none. */
  subject?: (sha: string) => string;
  /** The parent `rev-list` reports for such a sha. Default: none. */
  parent?: (sha: string) => string;
  /** The paths `diff-tree` reports. Default: the paths `status` reported. */
  paths?: string[];
  /** Paths `git add` cannot MATCH — a staged rename's original, or a path git never knew. */
  unaddable?: string[];
  /** Paths `git diff --cached` reports as already fully staged, which is the ONLY excuse the
   *  committer accepts for an add that matched nothing. */
  staged?: string[];
}) {
  const calls: string[][] = [];
  let committed = false;
  let authoredSubject: string | undefined;
  const preHead = script.preHead ?? "cand111";
  const head = script.head ?? "postfix9";
  // What a real `diff-tree` would report for a commit of everything `status` listed — the
  // rename ORIGIN is a bare field, so it is taken whole rather than sliced past a status code.
  const statusPaths = ((): string[] => {
    const fields = (script.status ?? "").split("\0").filter((f) => f !== "");
    const out: string[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i] as string;
      out.push(entry.slice(3));
      if (entry[0] === "R" || entry[1] === "R") {
        i += 1;
        if (fields[i] !== undefined) out.push(fields[i] as string);
      }
    }
    return out;
  })();
  const git = (args: string[]): string => {
    calls.push(args);
    if (script.failOn !== undefined && args[0] === script.failOn) {
      throw new Error(`git ${args[0]} exited 1: nothing to commit`);
    }
    if (args[0] === "add") {
      const unmatched = (script.unaddable ?? []).find((p) => args.includes(`:/${p}`));
      if (unmatched !== undefined) throw new Error(`fatal: pathspec ':/${unmatched}' did not match any files`);
    }
    if (args[0] === "diff") {
      const probed = (args[args.length - 1] as string).replace(/^:\//, "");
      return (script.staged ?? []).includes(probed) ? `${probed}\0` : "";
    }
    if (args[0] === "commit") {
      authoredSubject = args[2];
      committed = true;
    }
    if (args[0] === "status") return script.status ?? "";
    if (args[0] === "rev-parse") return `${committed ? head : preHead}\n`;
    const sha = args[args.length - 1] as string;
    // An explicit override wins even for the commit the fake just authored — that is how a
    // race (a foreign parent, a smuggled path) is scripted at all.
    const isOwn = sha === head && authoredSubject !== undefined;
    if (args[0] === "log") {
      return `${script.subject !== undefined ? script.subject(sha) : isOwn ? (authoredSubject as string) : ""}\n`;
    }
    if (args[0] === "rev-list") {
      const parent = script.parent !== undefined ? script.parent(sha) : isOwn ? preHead : "";
      return `${sha}${parent !== "" ? ` ${parent}` : ""}\n`;
    }
    if (args[0] === "diff-tree") return `${(script.paths ?? statusPaths).join("\0")}\0`;
    return "";
  };
  return { git, calls };
}

function commitDeps(git: (args: string[]) => string): CoordinatorDeps {
  return buildCoordinatorDeps({ projectDir: "/nonexistent-project", ticketId: "FG-639", git, invokeFn: async () => {
    throw new Error("a fix-cycle commit dispatches no container");
  } });
}

function commitCtx(declaredFiles: string[], candidateSha?: string) {
  const fixCtx = parkAtFix();
  const review = candidateSha === undefined ? fixCtx.review : { ...fixCtx.review, candidateSha };
  return { review, batch: fixCtx.batch, results: [], declaredFiles };
}

/** The subject the coordinator writes for a batch revision — the per-revision idempotency key
 *  RF-2's recovery matches on. Spelled out here rather than imported so a change to the shipped
 *  key has to be made twice, deliberately, instead of silently agreeing with itself. */
function subjectFor(batch: { id: string; revision: number }): string {
  return `fix(review): fix batch ${batch.id} revision ${batch.revision}`;
}

test("FG-649: the fix-cycle commit stages ONLY the declared paths and names the batch, never the ticket", async () => {
  // RED baseline: there is no commitFixCycle dep before this change — Stage 5 read
  // deps.headSha() (review-run.ts:470) and committed nothing.
  const { git, calls } = scriptedGit({
    status: "M  src/a.ts\0?? src/a.test.ts\0",
    head: "committed7",
  });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts", "src/a.test.ts"]));

  assert.equal(commit.kind, "committed");
  assert.equal(commit.kind === "committed" ? commit.sha : "", "committed7", "the sha the commit CREATED");
  const add = calls.find((c) => c[0] === "add");
  assert.deepEqual(add, ["add", "--", ":/src/a.ts", ":/src/a.test.ts"], "never `git add -A`, and root-relative");
  const message = calls.find((c) => c[0] === "commit")?.[2] ?? "";
  assert.match(message, /^fix\(review\): fix batch .+ revision 1$/);
  // THE SUBJECT IS AN INTERFACE: resolveCommitRange infers a later review's base from the
  // OLDEST commit whose subject references the ticket. A ticket id here would make a later
  // review's base its own remediation commit, and a review with no usable base can never
  // confirm its contract.
  assert.doesNotMatch(message, /FG-639/, "the subject must not reference the ticket");
});

test("FG-649: a tree that moved OUTSIDE the declared set is named, never swept into the commit", async () => {
  const { git, calls } = scriptedGit({ status: "M  src/a.ts\0 M docs/unrelated.md\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_tree_dirty_outside_declared_scope");
  assert.match(commit.kind === "refused" ? commit.detail : "", /docs\/unrelated\.md/);
  assert.equal(calls.some((c) => c[0] === "add" || c[0] === "commit"), false, "nothing was staged or committed");
});

test("FG-649: results that declare files against a CLEAN tree refuse — the fixer's claim contradicts the tree", async () => {
  const { git, calls } = scriptedGit({ status: "" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_declared_changes_absent");
  assert.equal(calls.some((c) => c[0] === "commit"), false);
});

test("FG-649: a cycle that declares NOTHING against a clean tree is a legitimate no_change", async () => {
  const { git, calls } = scriptedGit({ status: "" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx([]));

  assert.equal(commit.kind, "no_change");
  assert.equal(commit.kind === "no_change" ? commit.sha : "", "cand111", "the candidate legitimately does not move");
  assert.equal(calls.some((c) => c[0] === "commit"), false);
});

test("FG-649: a git commit that fails is a NAMED refusal, not a thrown stack trace", async () => {
  const { git } = scriptedGit({ status: "M  src/a.ts\0", failOn: "commit" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_failed");
  assert.match(commit.kind === "refused" ? commit.detail : "", /nothing to commit/);
});

test("FG-649: a head that is NOT the candidate refuses BEFORE anything is staged", async () => {
  // The fix cycle is a WRITE now, so the HEAD-vs-candidate comparison has to be made again at
  // the moment of the write: a commit authored on a foreign head would give the review a
  // candidate whose parent is not the tree it reviewed, and mis-anchor the whole ledger
  // silently instead of stopping. Same name as the verify-stage refusal, on purpose.
  const { git, calls } = scriptedGit({ status: "M  src/a.ts\0", preHead: "somebodyelse4" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "candidate_not_checked_out");
  assert.match(commit.kind === "refused" ? commit.detail : "", /is on somebodyelse4, not the candidate cand111/);
  assert.equal(calls.some((c) => c[0] === "add" || c[0] === "commit"), false, "nothing was staged or committed");
});

test("FG-649: the porcelain reader survives a path with a space and stages both halves of a rename", async () => {
  // -z, so no C-quoting to un-quote: a scope guard that mis-parses a path is a scope guard that
  // commits the wrong file. A rename reports its ORIGINAL path in the next field, and staging
  // the new name without it would leave the deletion uncommitted.
  const { git, calls } = scriptedGit({ status: "M  src/a file.ts\0R  src/new.ts\0src/old.ts\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a file.ts", "src/new.ts", "src/old.ts"]));

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.deepEqual(calls.find((c) => c[0] === "add"), [
    "add",
    "--",
    ":/src/a file.ts",
    ":/src/new.ts",
    ":/src/old.ts",
  ]);
});

test("FG-655/RF-5: a STAGED rename's original is unaddable but already in the index — staged, not refused", async () => {
  // `git mv` leaves the rename staged, so the original is gone from the worktree AND the index
  // and `git add -- :/src/old.ts` matches nothing anywhere — which failed the whole batch, and
  // with it a cycle whose commit would have carried the rename whole off the index.
  const { git, calls } = scriptedGit({
    status: "M  src/a.ts\0R  src/new.ts\0src/old.ts\0",
    unaddable: ["src/old.ts"],
    staged: ["src/old.ts"],
  });
  const ctx = commitCtx(["src/a.ts", "src/new.ts", "src/old.ts"]);
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  const adds = calls.filter((c) => c[0] === "add");
  assert.deepEqual(adds[0], ["add", "--", ":/src/a.ts", ":/src/new.ts", ":/src/old.ts"], "the batch add is still tried first");
  assert.deepEqual(adds.slice(1).map((c) => c[2]), [":/src/a.ts", ":/src/new.ts", ":/src/old.ts"], "then each path on its own");
  assert.deepEqual(
    calls.find((c) => c[0] === "commit"),
    ["commit", "-m", subjectFor(ctx.batch), "--", ":/src/a.ts", ":/src/new.ts", ":/src/old.ts"],
    "the ORIGINAL stays in the commit pathspecs — dropping it would leave the deletion behind",
  );
});

test("FG-655/RF-5: an add that fails for a path the index does NOT hold is still a NAMED refusal", async () => {
  // The tolerance is not silence: the index probe is what separates "already staged" from
  // "git has never heard of this path", and only the first is excused.
  const { git, calls } = scriptedGit({
    status: "M  src/a.ts\0?? src/ghost.ts\0",
    unaddable: ["src/ghost.ts"],
    staged: [],
  });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts", "src/ghost.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_failed");
  assert.match(commit.kind === "refused" ? commit.detail : "", /src\/ghost\.ts/);
  assert.equal(calls.some((c) => c[0] === "commit"), false, "nothing was committed");
});

// ─── FG-649 RF-2: recovering the commit the coordinator itself authored ─────
//
// The git commit is irreversible and external; the ledger writes that record it (candidate
// advance, resolution invalidation, stage record) are separate SQLite transactions AFTER it.
// A crash in between used to be terminal in both directions — refusing `candidate_not_checked_out`
// forever in one window and `fix_cycle_declared_changes_absent` forever in the other — and the
// only exits were the hand re-anchoring FG-649 exists to remove or a second real fixer container
// over already-fixed code. The subject is a per-revision idempotency key; these pin that it is
// USED as one, and that it is not usable by anything else.

test("FG-649/RF-2: a crash BEFORE the candidate advance is recovered — HEAD's parent is the candidate", async () => {
  const ctx = commitCtx(["src/a.ts"]);
  // HEAD is the fix commit an earlier pass authored; the review row still says cand111, and the
  // tree is clean because that commit took the changes. Pre-RF-2 this refused
  // `candidate_not_checked_out`, and checking the candidate out then refused
  // `fix_cycle_declared_changes_absent` — no exit.
  const { git, calls } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
    parent: (s) => (s === "postfix9" ? "cand111" : ""),
    paths: ["src/a.ts"],
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.equal(commit.kind === "committed" ? commit.sha : "", "postfix9");
  assert.deepEqual(commit.kind === "committed" ? commit.committedPaths : [], ["src/a.ts"]);
  assert.equal(commit.kind === "committed" ? commit.recognized : undefined, true, "RECOVERED, not re-authored");
  assert.equal(calls.some((c) => c[0] === "add" || c[0] === "commit"), false, "a second commit is never authored");
});

test("FG-649/RF-2: a crash AFTER the candidate advance is recovered — HEAD IS the candidate", async () => {
  const ctx = commitCtx(["src/a.ts"], "postfix9");
  const { git, calls } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
    parent: () => "cand111",
    paths: ["src/a.ts"],
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.equal(commit.kind === "committed" ? commit.recognized : undefined, true);
  assert.equal(calls.some((c) => c[0] === "commit"), false);
});

test("FG-649/RF-2: the subject alone recovers NOTHING — the commit must be anchored to the candidate", async () => {
  const ctx = commitCtx(["src/a.ts"]);
  // Someone else's head carrying this batch's subject. Adopting it on the subject alone would
  // let any commit spelling that text re-anchor the review's whole evidence ledger.
  const { git } = scriptedGit({
    status: "M  src/a.ts\0",
    preHead: "somebodyelse4",
    subject: () => subjectFor(ctx.batch),
    parent: () => "someotherbase",
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "candidate_not_checked_out");
});

test("FG-649/RF-2: an anchored commit that is NOT this batch revision recovers nothing either", async () => {
  const ctx = commitCtx(["src/a.ts"]);
  // The previous revision's fix commit, sitting exactly where this one would go. A key that
  // ignored the revision would read a completed cycle as this one's.
  const { git } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: () => `fix(review): fix batch ${ctx.batch.id} revision ${ctx.batch.revision + 1}`,
    parent: () => "cand111",
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "candidate_not_checked_out");
});

// ─── FG-649 RF-5: the declared/tree reconciliation runs BOTH ways ───────────

test("FG-649/RF-5: a declaration that reaches beyond the tree is NAMED on the outcome, not left silent", async () => {
  // Declared [a, b], only `a` moved. This committed `a` and recorded declaredFiles [a, b]
  // beside committedPaths [a] with nothing naming the disagreement — a partly-fabricated
  // files_changed ledger passing as evidence.
  //
  // It is named rather than refused ON PURPOSE. `committed ⊆ declared` still holds, so the
  // commit-only-declared-paths invariant is intact; and a refusal here would dead-end a
  // converging review — a second fix cycle re-writing a test file it already committed
  // declares it honestly and moves nothing, and no re-entry could ever change that.
  const { git } = scriptedGit({ status: "M  src/a.ts\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts", "src/b.ts"]));

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.deepEqual(commit.kind === "committed" ? commit.committedPaths : [], ["src/a.ts"], "only what moved");
  assert.deepEqual(
    commit.kind === "committed" ? commit.declaredNotMoved : undefined,
    ["src/b.ts"],
    "and the unsupported half of the declaration travels WITH the outcome",
  );
});

test("FG-649/RF-5: a declaration the tree supports in full carries no discrepancy at all", async () => {
  const { git } = scriptedGit({ status: "M  src/a.ts\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "committed");
  assert.equal(
    commit.kind === "committed" ? commit.declaredNotMoved : "set",
    undefined,
    "an honest ledger is the absence of the field, not an empty-array footnote to read past",
  );
});

// ─── FG-649 RF-6: the commit cannot carry what a concurrent writer staged ───

test("FG-649/RF-6: the commit is pathspec-limited, so a concurrently staged file cannot ride along", async () => {
  const { git, calls } = scriptedGit({ status: "M  src/a.ts\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  // `git commit -- <paths>` builds the tree from HEAD plus exactly these paths and ignores the
  // rest of the index. A bare `git commit` would take whatever the shared index held by then.
  assert.deepEqual(calls.find((c) => c[0] === "commit")?.slice(3), ["--", ":/src/a.ts"]);
});

test("FG-649/RF-6: a commit that lands on a foreign parent is NOT adopted as the candidate", async () => {
  // A concurrent writer advanced HEAD between the candidate check and the commit. No check made
  // BEFORE the write can see this; reading the parent off the commit that actually landed can.
  const { git } = scriptedGit({ status: "M  src/a.ts\0", parent: () => "somebodyelse4" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /parent is somebodyelse4, not the candidate cand111/);
});

test("FG-649/RF-6: a commit that landed carrying an undeclared path is NOT adopted either", async () => {
  const { git } = scriptedGit({ status: "M  src/a.ts\0", paths: ["src/a.ts", "infra/secrets.tf"] });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /infra\/secrets\.tf/);
});

// ─── FG-649 RF-7: recognition adopts on the SAME terms the commit path does ─
//
// RF-2's recovery arm and RF-6's post-commit check both decide the same thing — may this commit
// become the candidate — and recognition used to decide it on strictly less evidence: a subject
// match plus an anchor, with neither the exactly-one-parent guard nor the declared-paths guard.
// That made the RF-6 refusal non-durable. `fix_cycle_commit_raced` tells the operator to reset
// the checkout and re-run; re-running WITHOUT the reset landed on the recognition arm, which
// adopted the very commit the previous pass refused — undeclared paths and all — and that sha
// then anchored every candidate-bound resolution, verification and shipping check.

test("FG-649/RF-7: a RECOGNISED commit carrying an undeclared path is refused, exactly as the authored path refuses it", async () => {
  const ctx = commitCtx(["src/a.ts"]);
  // The RF-6 scenario one `continue` later: the smuggled commit is already HEAD, the tree is
  // clean because it took the changes, and the subject is this batch revision's.
  const { git, calls } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
    parent: () => "cand111",
    paths: ["src/a.ts", "infra/secrets.tf"],
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "refused", "a refused commit does not become adoptable by being re-read");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /infra\/secrets\.tf/);
  assert.equal(calls.some((c) => c[0] === "commit"), false, "and nothing is re-authored on top of it");
});

test("FG-649/RF-7: a RECOGNISED merge commit is refused — one parent is required of both arms", async () => {
  const ctx = commitCtx(["src/a.ts"]);
  // Anchored by its FIRST parent, so the old `parentsOf(at).includes(candidate)` arm adopted it;
  // the authored path has always refused any commit with parents.length !== 1.
  const { git } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
    parent: () => "cand111 someforeignbranch",
    paths: ["src/a.ts"],
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /parent is cand111 someforeignbranch/);
});

test("FG-649/RF-7: sharing the predicate does not lend the AUTHORED path recovery's self-anchor", async () => {
  // The predicate accepts a commit that IS the candidate, because after the candidate advance the
  // row points at it. On the authored path the row has not moved, so a HEAD back at the candidate
  // means a writer rewound the checkout and the commit git just reported is gone. Adopting it
  // would record the fix cycle complete against a tree the fixes are not in.
  const { git } = scriptedGit({ status: "M  src/a.ts\0", head: "cand111", paths: ["src/a.ts"] });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /HEAD is still the candidate/);
});

test("FG-649/RF-7: the predicate is CONTAINMENT, so RF-5's partial commit is still recoverable", async () => {
  // Where the two findings meet. RF-5 commits what moved and names what did not, so a legitimate
  // fix-cycle commit can carry FEWER paths than the batch declared. Tightening recognition to
  // declared-set EQUALITY would refuse exactly those commits on the retry after a crash — the
  // FG-649 stuck loop rebuilt out of a guard meant to close it. `committed ⊆ declared` is the
  // invariant, in both arms.
  const ctx = commitCtx(["src/a.ts", "src/b.ts"]);
  const { git } = scriptedGit({
    status: "",
    preHead: "postfix9",
    subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
    parent: () => "cand111",
    paths: ["src/a.ts"],
  });
  const commit = await commitDeps(git).commitFixCycle(ctx);

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.equal(commit.kind === "committed" ? commit.recognized : undefined, true);
});

test("FG-649/RF-7: the two arms give the SAME answer about the same commit", async () => {
  // The coherence statement itself, rather than two facts that happen to agree today: one commit
  // content, reached through the authored door and through the recovery door.
  const ctx = commitCtx(["src/a.ts"]);
  const smuggling = { paths: ["src/a.ts", "infra/secrets.tf"] };

  const authored = await commitDeps(scriptedGit({ status: "M  src/a.ts\0", ...smuggling }).git).commitFixCycle(ctx);
  const recognised = await commitDeps(
    scriptedGit({
      status: "",
      preHead: "postfix9",
      subject: (s) => (s === "postfix9" ? subjectFor(ctx.batch) : ""),
      parent: () => "cand111",
      ...smuggling,
    }).git,
  ).commitFixCycle(ctx);

  assert.equal(authored.kind, recognised.kind);
  assert.equal(
    authored.kind === "refused" ? authored.reason : "",
    recognised.kind === "refused" ? recognised.reason : "",
    "adoption is one question, so the recovery arm cannot answer it more permissively",
  );
});

// ─── FG-655: the docs cycle's COMMIT, and AC4's dirty-tree guard ────────────
//
// The live FG-655 failure: Stage 6 read HEAD after the docs agent returned, and when the agent
// had not committed, that read was a guaranteed no-op — the stage said "candidate unchanged"
// and advanced while the docs edits sat in the worktree. The commit is the coordinator's now,
// authored from the agent's own `docs_updated` declaration. These pin the scope guard, the
// named refusals and the recognition arm; the end-to-end evidence against a real repository is
// src/v2/fg655-docs-cycle-candidate.integration.test.ts.

function docsDeps(git: (args: string[]) => string): CoordinatorDeps {
  return buildCoordinatorDeps({ projectDir: "/nonexistent-project", ticketId: "FG-655", git, invokeFn: async () => {
    throw new Error("a docs-cycle commit dispatches no container");
  } });
}

function docsCtx(declaredFiles: string[], candidateSha?: string) {
  const fixCtx = parkAtFix();
  const review = candidateSha === undefined ? fixCtx.review : { ...fixCtx.review, candidateSha };
  const binding = markDocsDispatchDelivered(openDocsDispatch(fixCtx.review.id, "cand111").id, { taskId: "task-docs-1" });
  return { review, binding, declaredFiles };
}

/** The subject the coordinator writes for a docs cycle — the stage-scoped idempotency key the
 *  recovery arm matches on. Spelled out here rather than imported, for the same reason the fix
 *  cycle's is: a change to the shipped key has to be made twice, deliberately. */
function docsSubjectFor(binding: { id: string }): string {
  return `docs(review): docs cycle ${binding.id}`;
}

test("FG-655: the docs-cycle commit carries ONLY the declared paths and names the cycle, never the ticket", async () => {
  const { git, calls } = scriptedGit({ status: "M  docs/concepts.md\0?? docs/new.md\0", head: "postdocs7" });
  const ctx = docsCtx(["docs/concepts.md", "docs/new.md"]);
  const commit = await docsDeps(git).commitDocsCycle(ctx);

  assert.equal(commit.kind, "committed");
  assert.equal(commit.kind === "committed" ? commit.sha : "", "postdocs7", "the sha the commit CREATED");
  const commitCall = calls.find((c) => c[0] === "commit") as string[];
  assert.equal(commitCall[2], docsSubjectFor(ctx.binding));
  assert.doesNotMatch(commitCall[2] as string, /FG-655/, "resolveReviewBase infers a LATER review's base from a ticket subject");
  // THE PATHS REACH `commit` ITSELF, not merely `add` — the index is shared with whatever else
  // is running in the operator's checkout.
  assert.deepEqual(commitCall.slice(3), ["--", ":/docs/concepts.md", ":/docs/new.md"]);
  assert.ok(!commitCall.includes("-A") && !commitCall.includes("--all"), "never `git commit -a`");
  const addCall = calls.find((c) => c[0] === "add") as string[];
  assert.deepEqual(addCall.slice(1), ["--", ":/docs/concepts.md", ":/docs/new.md"]);
});

test("FG-655: a worktree that moved OUTSIDE the declared set refuses by name, names the paths, and stages nothing", async () => {
  const { git, calls } = scriptedGit({ status: "M  docs/concepts.md\0?? src/sneaky.ts\0" });
  const commit = await docsDeps(git).commitDocsCycle(docsCtx(["docs/concepts.md"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "docs_cycle_tree_dirty_outside_declared_scope");
  assert.match(commit.kind === "refused" ? commit.detail : "", /src\/sneaky\.ts/);
  assert.equal(calls.find((c) => c[0] === "add"), undefined, "nothing is staged");
  assert.equal(calls.find((c) => c[0] === "commit"), undefined);
});

test("FG-655: an undeclared-path refusal caps the list it names with a +N more", async () => {
  const status = Array.from({ length: 14 }, (_, i) => `?? docs/stray${i}.md`).join("\0") + "\0";
  const commit = await docsDeps(scriptedGit({ status }).git).commitDocsCycle(docsCtx([]));
  assert.equal(commit.kind === "refused" ? commit.reason : "", "docs_cycle_tree_dirty_outside_declared_scope");
  assert.match(commit.kind === "refused" ? commit.detail : "", /\+4 more/);
  assert.match(commit.kind === "refused" ? commit.detail : "", /declared: nothing/);
});

test("FG-655 RF-1: a DECLARATION against a clean tree refuses, authorises the retire, and names NO no-op remedy", async () => {
  // The soft reset the sibling refusals name is a no-op HERE — this branch is only reached
  // with HEAD already at the candidate and the tree clean — and the declaration is immutable,
  // so "correct the declaration" names nothing either. Both would have made the refusal
  // terminal, which is why the remedy is the caller's retire instead.
  const commit = await docsDeps(scriptedGit({ status: "" }).git).commitDocsCycle(docsCtx(["docs/concepts.md"]));
  assert.equal(commit.kind === "refused" ? commit.reason : "", "docs_cycle_declared_changes_absent");
  assert.equal(
    commit.kind === "refused" ? commit.treeCleanAtCandidate : undefined,
    true,
    "the clean tree at the candidate is what authorises retiring the spent binding",
  );
  assert.doesNotMatch(
    commit.kind === "refused" ? commit.detail : "",
    /git reset --soft/,
    "a remedy that is a no-op in the branch that prints it is worse than no remedy",
  );
  assert.doesNotMatch(commit.kind === "refused" ? commit.detail : "", /correct the declaration/);
});

test("FG-655 RF-1: every refusal that CANNOT prove a clean tree at the candidate withholds the retire authorisation", async () => {
  // The safety argument rests specifically on the tree being clean AT the candidate. A dirty
  // tree may hold that agent's stranded work, and a foreign head says nothing about it at all
  // — retiring on either would authorise a second docs agent over work nobody can attribute.
  const ctx = docsCtx(["docs/concepts.md"]);
  const dirty = await docsDeps(scriptedGit({ status: "?? src/sneaky.ts\0" }).git).commitDocsCycle(ctx);
  assert.equal(dirty.kind === "refused" ? dirty.reason : "", "docs_cycle_tree_dirty_outside_declared_scope");
  assert.equal(dirty.kind === "refused" ? dirty.treeCleanAtCandidate : undefined, undefined);

  const foreign = await docsDeps(scriptedGit({ status: "", preHead: "someoneelse9" }).git).commitDocsCycle(ctx);
  assert.equal(foreign.kind === "refused" ? foreign.reason : "", "candidate_not_checked_out");
  assert.equal(foreign.kind === "refused" ? foreign.treeCleanAtCandidate : undefined, undefined);
});

test("FG-655: a declaration that reaches beyond the tree commits what moved and NAMES what did not", async () => {
  const { git } = scriptedGit({ status: "M  docs/concepts.md\0", head: "postdocs7", paths: ["docs/concepts.md"] });
  const commit = await docsDeps(git).commitDocsCycle(docsCtx(["docs/concepts.md", "docs/never-written.md"]));
  assert.equal(commit.kind, "committed");
  assert.deepEqual(commit.kind === "committed" ? commit.committedPaths : [], ["docs/concepts.md"]);
  assert.deepEqual(commit.kind === "committed" ? commit.declaredNotMoved : [], ["docs/never-written.md"]);
});

test("FG-655: nothing declared and nothing moved is the LEGITIMATE no-op, at a clean tree", async () => {
  const commit = await docsDeps(scriptedGit({ status: "" }).git).commitDocsCycle(docsCtx([]));
  assert.equal(commit.kind, "no_change");
  assert.equal(commit.kind === "no_change" ? commit.sha : "", "cand111");
});

test("FG-655: a head that is not the candidate refuses candidate_not_checked_out with the soft-reset remedy", async () => {
  // Where a docs agent that COMMITTED ITS OWN WORK lands. Its commit is left alone; the remedy
  // names the reset that returns those edits to the worktree so the coordinator authors the
  // commit itself.
  const { git, calls } = scriptedGit({ status: "", preHead: "someoneelse9" });
  const commit = await docsDeps(git).commitDocsCycle(docsCtx([]));
  assert.equal(commit.kind === "refused" ? commit.reason : "", "candidate_not_checked_out");
  assert.match(commit.kind === "refused" ? commit.detail : "", /git reset --soft cand111/);
  assert.equal(calls.find((c) => c[0] === "commit"), undefined, "and it authors nothing on a foreign tree");
});

test("FG-655: a commit an earlier crashed pass authored is RECOGNIZED, not re-authored", async () => {
  // Both crash windows land on an anchored HEAD: before the candidate advance the commit's
  // PARENT is the candidate; after it, HEAD IS the candidate.
  const ctx = docsCtx([]);
  const subject = docsSubjectFor(ctx.binding);
  for (const window of [
    { label: "before the advance", preHead: "postdocs7", parent: () => "cand111", candidate: undefined },
    { label: "after the advance", preHead: "postdocs7", parent: () => "older000", candidate: "postdocs7" },
  ]) {
    const { git, calls } = scriptedGit({
      status: "",
      preHead: window.preHead,
      subject: () => subject,
      parent: window.parent,
      paths: ["docs/concepts.md"],
    });
    const at = { ...ctx, declaredFiles: ["docs/concepts.md"] };
    const review = window.candidate === undefined ? at.review : { ...at.review, candidateSha: window.candidate };
    const commit = await docsDeps(git).commitDocsCycle({ ...at, review });
    assert.equal(commit.kind, "committed", `${window.label}: ${commit.kind === "refused" ? commit.detail : ""}`);
    assert.equal(commit.kind === "committed" ? commit.recognized : false, true, window.label);
    assert.equal(calls.find((c) => c[0] === "commit"), undefined, `${window.label}: no SECOND commit was authored`);
  }
});

test("FG-655: recognition decides adoption on the SAME terms — an anchored commit carrying an undeclared path is still refused", async () => {
  // FG-649 RF-7, one stage over: a recognition test weaker than the adoption test is a refusal
  // one `forge review continue` away from being reversed.
  const ctx = docsCtx(["docs/concepts.md"]);
  const { git } = scriptedGit({
    status: "",
    preHead: "postdocs7",
    subject: () => docsSubjectFor(ctx.binding),
    parent: () => "cand111",
    paths: ["docs/concepts.md", "infra/secrets.tf"],
  });
  const commit = await docsDeps(git).commitDocsCycle(ctx);
  assert.equal(commit.kind === "refused" ? commit.reason : "", "docs_cycle_commit_raced");
  assert.match(commit.kind === "refused" ? commit.detail : "", /infra\/secrets\.tf/);
  assert.match(commit.kind === "refused" ? commit.detail : "", /git reset --soft cand111/);
});

test("FG-655 / AC4: the verify seam refuses a DIRTY tree at the right candidate, naming the paths and the action", async () => {
  // The seam checked head-vs-candidate ONLY, so a dirty tree at the right head passed it and
  // review-loop degraded to a local run — a green verification line computed against a tree
  // nobody reviewed. Stages 1 and 7 share this seam.
  const { git } = scriptedGit({ status: "M  docs/concepts.md\0?? docs/stranded.md\0" });
  const entry = await docsDeps(git).verify("cand111");
  assert.equal(entry.ok, false);
  assert.equal(entry.environmentRefusal?.reason, "workspace_dirty_at_candidate");
  assert.match(entry.environmentRefusal?.message ?? "", /docs\/stranded\.md/);
  assert.match(entry.environmentRefusal?.message ?? "", /Commit those changes/);
});

test("FG-655 / AC4: a head that is not the candidate keeps its OWN name at the verify seam", async () => {
  const { git } = scriptedGit({ status: "", preHead: "someoneelse9" });
  const entry = await docsDeps(git).verify("cand111");
  assert.equal(entry.environmentRefusal?.reason, "candidate_not_checked_out", "the two conditions stay distinct");
});

// ─── the comparison base, resolved AT OPEN ──────────────────────────────────
//
// Stage 2 refuses a review that records no base sha, and no verb supplies one afterwards or
// removes the row — so a review opened without a base was permanently stuck at contract
// confirmation. These pin the resolution that moved to open time: --since names the base,
// otherwise it is inferred from the ticket's landed range, and when neither can produce one
// the refusal happens BEFORE the row exists.

/** A git that answers only what resolveReviewBase asks: the subject log, the span count, and
 *  rev-parse for the revisions the fixture says exist.
 *
 *  IT MODELS REAL GIT'S PERMISSIVENESS ON PURPOSE. Bare `rev-parse <40-hex>` echoes the sha
 *  back with exit 0 without consulting the object store — demonstrated in a real repo — while
 *  `rev-parse --verify <rev>^{commit}` consults it and fails for a non-commit. A fake that
 *  simply threw for every unknown rev is what let the missing commit-ness check ship. */
function logGit(commits: Array<[string, string]>, resolvable: Record<string, string>) {
  return (args: string[]): string => {
    if (args[0] === "log" && args[1] === "--format=%H %s") {
      return commits.map(([sha, subject]) => `${sha} ${subject}`).join("\n");
    }
    if (args[0] === "log" && args[1] === "--format=%H") {
      return commits.map(([sha]) => sha).join("\n");
    }
    if (args[0] === "rev-parse") {
      const verify = args[1] === "--verify";
      const rev = (verify ? args[2] : args[1]) as string;
      const bare = rev.replace(/\^\{commit\}$/, "");
      const sha = resolvable[bare];
      if (sha !== undefined) return `${sha}\n`;
      if (!verify && /^[0-9a-f]{40}$/.test(bare)) return `${bare}\n`;
      throw new Error(`fatal: Needed a single revision`);
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

test("FG-639: with no --since the base is INFERRED from the oldest commit referencing the ticket", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit(
      [
        ["cccccccccccccccccccccccccccccccccccccccc", "FG-700: the second half"],
        ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the first half"],
      ],
      { "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb^": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  if (!base.ok) return;
  assert.equal(base.baseSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the parent of the oldest ticket commit");
  assert.equal(base.inferredFrom, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(base.spansUnmatched, false);
});

test("FG-639: an inferred range that spans unrelated commits is reported, not hidden", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit(
      [
        ["cccccccccccccccccccccccccccccccccccccccc", "FG-700: the second half"],
        ["dddddddddddddddddddddddddddddddddddddddd", "chore: an unrelated commit in between"],
        ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the first half"],
      ],
      { "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb^": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.equal(base.ok ? base.spansUnmatched : undefined, true, "the confirmation diff will include them");
});

test("FG-639: NO commit referencing the ticket refuses AT OPEN, naming --since", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit([["cccccccccccccccccccccccccccccccccccccccc", "chore: something else"]], {}),
  });

  assert.equal(base.ok, false, "a review that cannot name its base must never be opened");
  if (base.ok) return;
  assert.match(base.refusal, /no commit subject in \/repo references FG-700/);
  assert.match(base.refusal, /--since <sha>/);
  assert.match(base.refusal, /Nothing was written/);
});

test("FG-639: a ticket range starting at a ROOT commit refuses rather than opening unusably", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    // No `<oldest>^` in the resolvable set — the oldest ticket commit is the root.
    git: logGit([["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the whole thing"]], {}),
  });

  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /has no parent/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

test("FG-639: an unreadable git log refuses AT OPEN instead of leaving a stuck review behind", () => {
  const base = resolveReviewBase({
    projectDir: "/not-a-repo",
    ticketId: "FG-700",
    git: () => {
      throw new Error("fatal: not a git repository");
    },
  });

  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /could not be read \(fatal: not a git repository\)/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

test("FG-639: --since is RESOLVED to a full sha, and an unresolvable one is refused", () => {
  const git = logGit([], { "v1.2.0": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  const named = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "v1.2.0", git });
  assert.equal(named.ok, true, named.ok ? "" : named.refusal);
  assert.equal(named.ok ? named.baseSha : "", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "a tag is stored as its sha");
  assert.equal(named.ok ? named.inferredFrom : "unset", undefined, "an explicitly named base is not an inference");

  const bogus = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "nope", git });
  assert.equal(bogus.ok, false);
  assert.match(bogus.ok ? "" : bogus.refusal, /--since nope does not name a commit/);
});

// RF-7: the second input into the permanently-stuck review class RF-2 closed. `git rev-parse
// <40-hex>` echoes any 40-hex string back with exit 0 without consulting the object store, so
// a sha rebased away, gc'd, or pasted from another repo passed the --since branch, the row was
// inserted with it, and Stage 2's `git diff --name-only <base>..<candidate>` then threw a raw
// stack trace out of execFileSync — with no verb to supply a base afterwards and none to
// remove the review.
//
// RED baseline: revert revParseCommit to bare `["rev-parse", rev]` and this test fails,
// because logGit models git's echo exactly.
test("FG-639 / RF-7: a 40-hex --since that is NOT a commit in this repo is refused AT OPEN, not echoed through", () => {
  const git = logGit([["cccccccccccccccccccccccccccccccccccccccc", "FG-700: landed"]], {
    "cccccccccccccccccccccccccccccccccccccccc": "cccccccccccccccccccccccccccccccccccccccc",
  });
  const gone = "0000000000000000000000000000000000000000";

  assert.equal(git(["rev-parse", gone]).trim(), gone, "the fake echoes bare rev-parse, exactly as real git does");

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: gone, git });
  assert.equal(base.ok, false, "a base that no diff can name must never reach the insert");
  if (base.ok) return;
  assert.match(base.refusal, /--since 0{40} does not name a commit in \/repo/);
  assert.match(base.refusal, /Nothing was written/);
});

test("FG-639 / RF-7: commit-ness is required of the INFERRED parent too, not just of --since", () => {
  // The oldest ticket commit's parent resolves as an object but is not a commit — a tag or a
  // tree. Inferring it would open the same stuck review by the other door.
  const git = (args: string[]): string => {
    if (args[0] === "log") {
      return args[1] === "--format=%H %s"
        ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb FG-700: the whole thing"
        : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      throw new Error("fatal: Needed a single revision");
    }
    if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", git });
  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /has no parent/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

// ─── FG-674: the base is resolved by the FIRST RULE THAT APPLIES, and the rule is recorded ──
//
// The shipped defect: with no --since the base was the oldest commit whose SUBJECT referenced
// the ticket, minus one. An orchestrator's own session hygiene defeats that — "plan: FG-666
// shipped; FG-648 to Now ahead of FG-609" names FG-609 as a QUEUE POSITION, is by construction
// the oldest commit mentioning it, and anchored the FG-609 review three commits too early. The
// confirmation diff became 32 paths of already-merged FG-648/FG-661/FG-666 work and the
// coordinator refused to auto-confirm against it, so the review stopped before discovery.
//
// RED baseline for the regression arm: neuter `changesOnlyPlanningPaths` and the base walks back
// to a planning commit's parent, exactly as the incident. (Verified, not asserted: with the
// filter stubbed to `false` this arm reddens and the refusal arm below reddens with it.)

type FixtureCommit = { sha: string; subject: string; paths: string[] };

/** A git over a fixture history — newest-first commits, their changed paths, and the branch
 *  topology rule 2 reads. It answers ONLY what resolveReviewBase asks and throws otherwise, so
 *  a rule reaching for something the fixture didn't model is a loud failure, not a silent pass. */
function historyGit(opts: {
  commits: FixtureCommit[];
  /** `rev-parse --verify <rev>^{commit}` targets: "<sha>^", "HEAD", "refs/heads/main", … */
  refs?: Record<string, string>;
  currentBranch?: string;
  originHead?: string;
  /** ref → the merge base of HEAD and that ref. */
  mergeBase?: Record<string, string>;
}) {
  const { commits, refs = {}, mergeBase = {} } = opts;
  const indexOf = (sha: string): number => commits.findIndex((c) => c.sha === sha);
  return (args: string[]): string => {
    if (args[0] === "log" && args[1] === "--format=%H %s") {
      return commits.map((c) => `${c.sha} ${c.subject}`).join("\n");
    }
    if (args[0] === "log" && args[1] === "--format=%H") {
      const range = args[2];
      if (range === undefined) return commits.map((c) => c.sha).join("\n");
      const m = /^(.+)\^\.\.(.+)$/.exec(range);
      if (m === null) throw new Error(`unmodelled range ${range}`);
      const from = indexOf(m[1] as string);
      const to = indexOf(m[2] as string);
      if (from === -1 || to === -1) throw new Error(`unmodelled range ${range}`);
      return commits.slice(to, from + 1).map((c) => c.sha).join("\n");
    }
    if (args[0] === "show" && args[1] === "--name-only" && args[2] === "--format=") {
      const commit = commits[indexOf(args[3] as string)];
      if (commit === undefined) throw new Error(`fatal: bad object ${args[3]}`);
      return `${commit.paths.join("\n")}\n`;
    }
    if (args[0] === "symbolic-ref") {
      const ref = args[args.length - 1];
      const answer = ref === "HEAD" ? opts.currentBranch : opts.originHead;
      if (answer === undefined) throw new Error(`fatal: ref ${ref} is not a symbolic ref`);
      return `${answer}\n`;
    }
    if (args[0] === "merge-base") {
      const found = mergeBase[args[2] as string];
      if (found === undefined) throw new Error(`fatal: no merge base`);
      return `${found}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const bare = (args[2] as string).replace(/\^\{commit\}$/, "");
      const resolved = refs[bare] ?? (indexOf(bare) !== -1 ? bare : undefined);
      if (resolved === undefined) throw new Error(`fatal: Needed a single revision`);
      return `${resolved}\n`;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const IMPL = "cccccccccccccccccccccccccccccccccccccccc";
const CHART = "dddddddddddddddddddddddddddddddddddddddd";
const NOTES = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILED = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const EARLIER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The FG-609 incident's history: a backlog-notes commit naming the ticket lands BEFORE any
 *  implementation of it, with unrelated shipped work in between — plus the ticket-filing commit
 *  that names it in the CONVENTIONAL prefix form. The filing commit is what makes the
 *  planning-path filter load-bearing rather than redundant with the prefix preference: neutered
 *  (`changesOnlyPlanningPaths` → false) the base becomes the filing commit's parent, three
 *  commits too early, exactly as the incident. */
function fg609History(overrides: Partial<Parameters<typeof historyGit>[0]> = {}) {
  return historyGit({
    commits: [
      { sha: IMPL, subject: "FG-609: durable operator-queue primitives", paths: ["src/store/queue.ts"] },
      { sha: CHART, subject: "FG-661: localize the runtime chart's periods", paths: ["dashboard/src/chart.ts"] },
      { sha: NOTES, subject: "plan: FG-666 shipped; FG-648 to Now ahead of FG-609", paths: ["backlog/PLAN.md"] },
      { sha: FILED, subject: "FG-609: file the queue-primitives story", paths: ["backlog/stories/FG-609.md"] },
      { sha: EARLIER, subject: "chore: earlier work", paths: ["README.md"] },
    ],
    refs: {
      HEAD: IMPL,
      [`${IMPL}^`]: CHART,
      [`${NOTES}^`]: FILED,
      [`${FILED}^`]: EARLIER,
      "refs/heads/main": IMPL,
    },
    currentBranch: "main",
    originHead: "origin/main",
    mergeBase: { "refs/heads/main": IMPL },
    ...overrides,
  });
}

test("FG-674: a backlog-notes commit that names the ticket FIRST does not anchor the base", () => {
  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-609", git: fg609History() });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  if (!base.ok) return;
  assert.equal(base.baseSha, CHART, "the base is the implementation commit's parent, not a planning commit's");
  assert.equal(base.inferredFrom, IMPL, "the notes and filing commits change only backlog/ paths");
  assert.equal(base.basis, "ticket-range");
  assert.equal(base.spansUnmatched, false, "the narrowed range no longer drags in the already-merged work");
});

test("FG-674: a ticket whose ONLY references are backlog commits refuses by name and names --since", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-666",
    git: fg609History(),
  });

  assert.equal(base.ok, false, "silently widening to the notes commit is the defect, not the fallback");
  if (base.ok) return;
  assert.match(base.refusal, /every commit whose subject references FG-666 in \/repo changes only backlog\//);
  assert.match(base.refusal, /--since <sha>/);
  assert.match(base.refusal, /Nothing was written/);
});

test("FG-674: on a feature branch the base is the MERGE BASE with the default branch, named as such", () => {
  const head = "1111111111111111111111111111111111111111";
  const mid = "2222222222222222222222222222222222222222";
  const point = "3333333333333333333333333333333333333333";
  const base = resolveReviewBase({
    projectDir: "/repo",
    // No commit subject references the ticket at all — so this base can ONLY have come from
    // the branch point. Rule 3 would refuse here.
    ticketId: "FG-674",
    git: historyGit({
      commits: [
        { sha: head, subject: "wire the second half", paths: ["src/b.ts"] },
        { sha: mid, subject: "wire the first half", paths: ["src/a.ts"] },
        { sha: point, subject: "chore: the branch point", paths: ["README.md"] },
      ],
      refs: { HEAD: head, "refs/heads/main": point },
      currentBranch: "feature/queue",
      originHead: "origin/main",
      mergeBase: { "refs/heads/main": point },
    }),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  if (!base.ok) return;
  assert.equal(base.baseSha, point, "the branch point needs no text heuristics at all");
  assert.equal(base.basis, "merge-base");
  assert.equal(base.defaultBranch, "main");
  assert.equal(base.inferredFrom, undefined, "a branch point is not a ticket-range inference");
});

test("FG-674: the default branch is RESOLVED, not assumed to be `main`", () => {
  const head = "1111111111111111111111111111111111111111";
  const point = "3333333333333333333333333333333333333333";
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-674",
    git: historyGit({
      commits: [
        { sha: head, subject: "wire it", paths: ["src/b.ts"] },
        { sha: point, subject: "chore: the branch point", paths: ["README.md"] },
      ],
      refs: { HEAD: head, "refs/heads/trunk": point },
      currentBranch: "feature/queue",
      originHead: "origin/trunk",
      mergeBase: { "refs/heads/trunk": point },
    }),
  });

  assert.equal(base.ok && base.defaultBranch, "trunk");
  assert.equal(base.ok && base.baseSha, point);
});

test("FG-674: an unresolvable default branch degrades to ticket-range inference", () => {
  // No origin/HEAD, main, or master ref is available. This must be a fall-through, not an
  // exception (or a hidden assumption that every repository calls its default `main`).
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-609",
    git: fg609History({ refs: { HEAD: IMPL, [`${IMPL}^`]: CHART }, originHead: undefined }),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.equal(base.ok && base.basis, "ticket-range");
  assert.equal(base.ok && base.baseSha, CHART);
});

test("FG-674: already-merged work does NOT take the merge-base rule — it would compute an empty range", () => {
  // HEAD is the default branch, so its merge base with the default branch IS HEAD. Rule 2 must
  // fall through to ticket-range inference rather than returning HEAD..HEAD.
  const onDefaultBranch = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-609", git: fg609History() });
  assert.equal(onDefaultBranch.ok, true, onDefaultBranch.ok ? "" : onDefaultBranch.refusal);
  if (!onDefaultBranch.ok) return;
  assert.equal(onDefaultBranch.basis, "ticket-range");
  assert.notEqual(onDefaultBranch.baseSha, IMPL, "an empty range is exactly what this guard exists to prevent");

  // The same shape with a DETACHED head: there is no branch name to compare, and the guard that
  // catches it is `merge base === HEAD` rather than the name check.
  const detached = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-609",
    git: fg609History({ currentBranch: undefined }),
  });
  assert.equal(detached.ok && detached.basis, "ticket-range");
  assert.equal(detached.ok && detached.baseSha, CHART);
});

test("FG-674: a conventional `FG-NNN:` subject prefix outranks an incidental mid-sentence mention", () => {
  const prefixed = "1111111111111111111111111111111111111111";
  const mention = "2222222222222222222222222222222222222222";
  const before = "3333333333333333333333333333333333333333";
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-674",
    git: historyGit({
      commits: [
        { sha: prefixed, subject: "FG-674: infer the review base", paths: ["src/cli/commands/review-wiring.ts"] },
        { sha: mention, subject: "chore: tidy the log reader noticed while reading FG-674", paths: ["src/util/log.ts"] },
        { sha: before, subject: "chore: earlier", paths: ["README.md"] },
      ],
      refs: { HEAD: prefixed, [`${prefixed}^`]: mention, "refs/heads/main": prefixed },
      currentBranch: "main",
      mergeBase: { "refs/heads/main": prefixed },
    }),
  });

  assert.equal(base.ok && base.inferredFrom, prefixed, "the drive-by mention is not where the ticket's work began");
  assert.equal(base.ok && base.baseSha, mention);
});

test("FG-674: planning filtering narrows only on positive path evidence", () => {
  const code = "1111111111111111111111111111111111111111";
  const plan = "2222222222222222222222222222222222222222";
  const prior = "3333333333333333333333333333333333333333";
  const fixture = {
    commits: [
      { sha: code, subject: "FG-674: implementation also updates the plan", paths: ["backlog/FG-674.md", "src/review.ts"] },
      { sha: plan, subject: "FG-674: planning only", paths: ["backlog/FG-674.md"] },
      { sha: prior, subject: "chore: before", paths: ["README.md"] },
    ],
    refs: { HEAD: code, [`${code}^`]: plan, [`${plan}^`]: prior },
  };
  const mixed = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-674", git: historyGit(fixture) });
  assert.equal(mixed.ok && mixed.inferredFrom, code, "a commit touching source is not planning-only merely because it also touches backlog/");
  assert.equal(mixed.ok && mixed.baseSha, plan);

  const pathless = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-674",
    git: historyGit({
      commits: [{ sha: code, subject: "FG-674: merge implementation", paths: [] }, { sha: prior, subject: "chore: before", paths: ["README.md"] }],
      refs: { HEAD: code, [`${code}^`]: prior },
    }),
  });
  assert.equal(pathless.ok && pathless.inferredFrom, code, "a path-less merge read is not positive evidence of planning-only work");

  const showFails = historyGit(fixture);
  const unreadable = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-674",
    git: (args) => (args[0] === "show" && args[3] === code ? (() => { throw new Error("show failed"); })() : showFails(args)),
  });
  assert.equal(unreadable.ok && unreadable.inferredFrom, code, "an unreadable path list must degrade, never silently exclude code");
});

test("FG-674: prefix and ticket matching reject numeric and hyphen continuations", () => {
  const actual = "1111111111111111111111111111111111111111";
  const before = "2222222222222222222222222222222222222222";
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-674",
    git: historyGit({
      commits: [
        { sha: "3333333333333333333333333333333333333333", subject: "FG-6740: a different ticket", paths: ["src/other.ts"] },
        { sha: "4444444444444444444444444444444444444444", subject: "FG-674-a: a different ticket", paths: ["src/other.ts"] },
        { sha: actual, subject: "FG-674: actual implementation", paths: ["src/review.ts"] },
        { sha: before, subject: "chore: before", paths: ["README.md"] },
      ],
      refs: { HEAD: actual, [`${actual}^`]: before },
    }),
  });

  assert.equal(base.ok && base.inferredFrom, actual);
  assert.equal(base.ok && base.baseSha, before);
});

test("FG-674: failed symbolic-ref and merge-base probes degrade instead of escaping the resolver", () => {
  const ticketFallback = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-609", git: fg609History({ originHead: undefined }) });
  assert.equal(ticketFallback.ok && ticketFallback.basis, "ticket-range", "symbolic-ref failure falls through");

  const mergeFails = historyGit({
    commits: [
      { sha: IMPL, subject: "FG-609: implementation", paths: ["src/queue.ts"] },
      { sha: CHART, subject: "chore: before", paths: ["README.md"] },
    ],
    refs: { HEAD: IMPL, [`${IMPL}^`]: CHART, "refs/heads/main": CHART },
    currentBranch: "feature/fg-609",
    originHead: "origin/main",
  });
  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-609", git: mergeFails });
  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.equal(base.ok && base.basis, "ticket-range", "merge-base failure falls through rather than throwing");
});

test("FG-674: --since wins over the branch point, and the basis says so", () => {
  const head = "1111111111111111111111111111111111111111";
  const point = "3333333333333333333333333333333333333333";
  const named = "4444444444444444444444444444444444444444";
  const git = historyGit({
    commits: [
      { sha: head, subject: "FG-674: wire it", paths: ["src/b.ts"] },
      { sha: point, subject: "chore: the branch point", paths: ["README.md"] },
    ],
    refs: { HEAD: head, "refs/heads/main": point, "v1.2.0": named },
    currentBranch: "feature/queue",
    originHead: "origin/main",
    mergeBase: { "refs/heads/main": point },
  });

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-674", since: "v1.2.0", git });
  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.equal(base.ok && base.baseSha, named, "an operator-named base is never second-guessed by inference");
  assert.equal(base.ok && base.basis, "since");

  const bogus = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-674", since: "nope", git });
  assert.equal(bogus.ok, false, "and its own refusal is unchanged by the new rules");
  assert.match(bogus.ok ? "" : bogus.refusal, /--since nope does not name a commit/);
});

test("FG-639 / RF-7: the commit-ness idiom is the one real git honors — `rev-parse --verify <rev>^{commit}`", () => {
  const asked: string[][] = [];
  const git = (args: string[]): string => {
    asked.push(args);
    if (args[0] === "rev-parse") return "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "v1.2.0", git });
  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.deepEqual(
    asked[0],
    ["rev-parse", "--verify", "v1.2.0^{commit}"],
    "bare rev-parse consults no object store; --verify <rev>^{commit} does, and requires a commit",
  );
});

// ─── FG-689: `--add-lens` carries the authored scope, or it carries nothing ──
//
// The operator surface for the widening asymmetry, and since FG-689 every widening claim
// names paths: adding a lens without saying what it owns is a reviewer with no surface, and
// widening an already-selected lens IS the claim about paths. There is no spelling of this
// flag that broadens the panel without saying what the new reviewer reads.
//
// The exact-segment-count rule below is the part worth pinning. The old parser destructured
// three names off `split(":")` and dropped everything after the third colon on the floor —
// silently, with no refusal. With a fourth meaningful segment that silence would start eating
// SCOPE PATHS, quietly narrowing what a reviewer is handed, which is the failure this ticket
// exists to close. A malformed spec is now a named refusal rather than a truncation.

test("FG-689: --add-lens parses the lens, reason, evidence AND the authored scope paths", () => {
  const parsed = parseLensWidening([
    "security:a credential path appeared:src/util/creds.ts,src/auth/token.ts:src/util/,src/auth/",
  ]);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.refusal);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.widening, [
    {
      lens: "security",
      reason: "a credential path appeared",
      diffEvidence: ["src/util/creds.ts", "src/auth/token.ts"],
      scopePaths: ["src/util/", "src/auth/"],
    },
  ]);
});

test("FG-689: --add-lens with NO scope segment refuses by name, naming the form", () => {
  const parsed = parseLensWidening(["security:a credential path appeared:src/util/creds.ts"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.refusal, /--add-lens expects <lens>:<reason>:<diff-evidence>:<scope-paths>/);
  assert.match(parsed.refusal, /the authored paths it owns/);
});

test("FG-689: an EMPTY scope segment is refused too — an empty claim is not a claim", () => {
  for (const spec of ["security:reason:evidence:", "security:reason:evidence:   ", "security:reason::src/"]) {
    const parsed = parseLensWidening([spec]);
    assert.equal(parsed.ok, false, `'${spec}' must be refused`);
  }
});

test("FG-689: a spec with EXTRA colons is refused, not silently truncated", () => {
  // The old parser answered this by dropping `:42:src/util/` and proceeding. A widening
  // claim that quietly loses its scope paths is exactly the silent narrowing FG-689 forbids.
  const parsed = parseLensWidening(["security:a reason:src/util/creds.ts:42:src/util/"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.refusal, /Exactly four ':'-separated segments/);
  assert.match(parsed.refusal, /no ':' inside them/);
});

test("FG-689: the fail-closed diff summary tells the coordinator the scope-carrying form", async () => {
  // The refusal an unevaluated diff produces is where an operator learns the flag. If it
  // still taught the three-segment form, every operator who followed it would be refused.
  const outcome = await confirmVia(["src/store/reviews.ts"]);
  const refusal = outcome.kind === "confirmed" ? "" : outcome.refusal;
  assert.match(refusal, /--add-lens <lens>:<reason>:<diff-evidence>:<scope-paths>/);
});

test("FG-689: a widening claim parsed from the CLI confirms end to end, scope and all", async () => {
  const parsed = parseLensWidening(["backend:the diff moves a store write path:src/store/reviews.ts:src/store/"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const outcome = await confirmVia(["src/store/reviews.ts"], { addLenses: parsed.widening });
  assert.equal(outcome.kind, "confirmed", outcome.kind === "confirmed" ? "" : outcome.refusal);
  if (outcome.kind !== "confirmed") return;
  assert.deepEqual(outcome.addedLenses, ["backend"]);
  assert.deepEqual(
    outcome.contract.lens_scopes.backend,
    ["src/store/"],
    "the flag's scope segment reaches the confirmed contract — the added lens owns a surface",
  );
  assert.equal(validateReviewContract(outcome.contract).ok, true, "and the widened contract reads back");
});

test("FG-689: --add-lens refuses an unknown lens name at the boundary it is typed at", () => {
  // The name used to be cast straight to `RiskLens`. That was survivable while a widening
  // claim only touched `risk_lenses` — an unknown name made the confirmed contract
  // unreadable, and selection fails closed WIDER on one of those. FG-689 makes the same
  // string a key in `lens_scopes` on the one path that builds a contract without re-parsing
  // it, so the typo would now write an unreadable contract that also owns paths.
  const parsed = parseLensWidening(["vibes:it felt risky:src/x.ts:src/"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.refusal, /'vibes', which is not a risk lens/);
  assert.match(parsed.refusal, /wide, narrow, frontend, backend, security/);
});
