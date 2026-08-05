// FG-650: the lens validators' ROOT tolerance, over the REAL wiring and a REAL on-disk ledger.
//
// WHAT THIS TIER ADDS OVER review-discovery.test.ts / review-recheck.test.ts / review-run.test.ts.
// Those bind `dispatchLens` and `dispatchRechecker` to closures that hand the validator a
// hand-written object. But the defect FG-650 fixes is not in the object — it is in the SEAM:
// every composed agent prompt carries the harness output contract, which REQUIRES result.json
// to hold `status`. So the shape that reached `assessLens` in the live pilot was
// `{status, verdict, confidence, notes, outcome, findings}` — and a `.strict()` root refused it
// whole, for a key the reviewer had no choice about. This file therefore drives
// `buildCoordinatorDeps` with only the container `invoke` stubbed, so the reviewer's result.json
// travels the real dispatch path (invoke → InvokeResult.result → assessLens) exactly as a
// container's does.
//
// The second thing it adds is DURABILITY. "Tolerate-and-record" is only worth anything if the
// record outlives the process that wrote it: an operator reading the review later must be able
// to see which keys were stripped from which lens. An in-memory DB cannot prove that, so the
// store here is a real SQLite file that is closed and reopened — a genuine process restart.
//
// What stays strict is asserted on the same real path: a missing required ROOT field, an unknown
// key INSIDE a finding, and the rechecker's per-id omission are all still whole-result refusals
// that ingest nothing and record no stage.
//
// Two deps beyond the container dispatches are stubbed, deliberately and narrowly (the same pair
// fg649-fix-cycle-candidate.integration.test.ts stubs): `verify`, which would run the host
// verification machinery against a two-file fixture, and `shippingInput`, which fetches a remote
// tip that does not exist here. Everything FG-650 changes is real.
//
// Per the tier rule in docs/how-to-testing.md: real repos and an on-disk DB are integration-tier
// fixtures, and no test here creates a git worktree.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { applyMigrations, setDbForTest } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { insertRun } from "../store/runs.js";
import { insertTask, markTaskComplete } from "../store/tasks.js";
import {
  findingsForReview,
  getReview,
  insertReview,
  recordDisposition,
  type Review,
  type ReviewFinding,
} from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { lensForRole } from "./review-contract.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run } from "../types/index.js";

const RUN_ID = "run-fg650";
const REVIEW = "review-fg650";
const TICKET = "FG-650";
const GUARD = "if (!committed) throw new Error('refusing a partial write');";
const AC_TEST = "the reconcile path refuses a partial write";
const EXECUTED = `ok 1 - ${AC_TEST}`;

/** The keys the HARNESS output contract puts on every agent's result.json. Not optional
 *  reviewer garnish — this is the shape a composed prompt mandates, which is exactly why the
 *  root cannot be strict. Sorted, because `toleratedRootKeys` records them sorted. */
const HARNESS_KEYS = ["confidence", "notes", "status", "verdict"];

const RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "fg650",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

const CONTRACT = {
  threat_model: "an operator-trusted candidate reviewed by composed agent prompts",
  protected_invariants: ["a reviewer outcome is never refused for a key the harness mandates"],
  acceptance_refs: ["FG-650 AC 1"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["relaxing nested strictness"],
};

let dbFile: string;
let openDbs: DatabaseInstance[] = [];
let prev: DatabaseInstance | null = null;
let repo: string;
let tmpDirs: string[] = [];
let baseSha: string;
let entrySha: string;

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

const head = (): string => git(["rev-parse", "HEAD"]).trim();

/** A REAL on-disk store, so a close/reopen below is a genuine process restart rather than a
 *  same-handle read of an object that never left memory. */
function openStore(): DatabaseInstance {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  openDbs.push(db);
  const previous = setDbForTest(db);
  if (prev === null) prev = previous;
  return db;
}

/** Close the store and open the same FILE again — what a later forge process does. */
function restartProcess(): void {
  openDbs.pop()?.close();
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  openDbs.push(db);
  setDbForTest(db);
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "fg650-store-"));
  tmpDirs.push(home);
  dbFile = join(home, "forge.db");
  openStore();
  insertRun(RUN);

  repo = mkdtempSync(join(tmpdir(), "fg650-repo-"));
  tmpDirs.push(repo);
  git(["init", "-q", "-b", "main", "."]);
  // Identity is LOCAL on purpose: src/test-setup.ts neutralizes the global git config, so a
  // commit borrowing the operator's identity would fail on CI and prove nothing.
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"candidate","private":true}\n`);
  writeFileSync(join(repo, "src", "reconcile.ts"), "export function reconcile() {\n  write(rowA);\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed the candidate"]);
  baseSha = head();
  appendFileSync(
    join(repo, "src", "reconcile.ts"),
    "\nexport function reconcileBoth() {\n  write(rowA);\n  write(rowB);\n}\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "reconcile: write both rows in one path"]);
  entrySha = head();

  insertReview({
    id: REVIEW,
    runId: RUN_ID,
    ticketId: TICKET,
    reviewMode: "evidence_led",
    baseSha,
    candidateSha: entrySha,
    contract: CONTRACT,
    state: "confirming_contract",
  });
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed by restartProcess
    }
  }
  openDbs = [];
  if (prev !== null) setDbForTest(prev);
  prev = null;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── the fixture harness ────────────────────────────────────────────────────

function finding(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: `the reconcile path can write partially (${n})`,
    evidence: `line ${n} writes before the guard`,
    severity: "high",
    risk_lens: "backend",
    reachability: "demonstrated",
    challenges_contract: false,
    remediation_advice: "guard it",
    file: "src/reconcile.ts",
    line: n,
    ...over,
  };
}

/** A reviewer result.json in the shape the HARNESS mandates: the agent output contract's own
 *  root keys, plus the lens payload. This is what a real container writes. */
function reviewerResult(body: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "complete",
    verdict: body["outcome"] === "fail" ? "fail" : "pass",
    confidence: 0.9,
    notes: "reviewed the reconcile path against the contract",
    ...body,
  };
}

type LensBehaviour = (lens: string) => unknown;
type RecheckBehaviour = (ids: string[], candidateSha: string) => unknown;

type Harness = {
  deps: CoordinatorDeps;
  calls: InvokeArgs[];
  dispatches: (role: string) => InvokeArgs[];
};

/** The default panel: `wide` passes, `backend` fails with two findings — both carrying the
 *  harness's mandated root keys. */
const defaultLens: LensBehaviour = (lens) =>
  reviewerResult(
    lens === "backend"
      ? { outcome: "fail", findings: [finding(1), finding(2)] }
      : { outcome: "pass", findings: [] },
  );

/** Every recheck entry resolved, under a result that also carries extra root keys. */
const defaultRecheck: RecheckBehaviour = (ids, candidateSha) => ({
  status: "complete",
  notes: "rechecked every id against the post-fix tree",
  review_id: REVIEW,
  candidate_sha: candidateSha,
  rechecked: ids.map((id) => ({
    finding_id: id,
    result: "resolved",
    evidence_kind: "regression_test",
    evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
  })),
  new_findings: [],
});

function harness(over: { lens?: LensBehaviour; recheck?: RecheckBehaviour } = {}): Harness {
  const calls: InvokeArgs[] = [];
  const lensBehaviour = over.lens ?? defaultLens;
  const recheckBehaviour = over.recheck ?? defaultRecheck;

  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    calls.push(args);
    const taskId = `task-${args.agentRole}-${calls.length}`;
    const done = (result: unknown): InvokeResult => ({ runId: RUN_ID, taskId, status: "complete", result });

    const lens = lensForRole(args.agentRole);
    if (lens !== undefined) return done(lensBehaviour(lens));

    switch (args.agentRole) {
      case "engineer": {
        // The "fixer container": it EDITS THE REAL WORKTREE and does not commit, which is the
        // pilot's shape. The coordinator authors the fix-cycle commit itself (FG-649).
        const raw = args.taskFiles?.["fix-batch/payload.json"];
        assert.ok(raw !== undefined, "the fixer's bundle must ride the task dir");
        const payload = JSON.parse(raw) as { fix_batch_id: string; revision: number; findings: Array<{ finding_id: string }> };
        appendFileSync(join(repo, "src", "reconcile.ts"), `\n${GUARD}\n`);
        writeFileSync(join(repo, "src", "reconcile.test.ts"), `// ${EXECUTED}\n`);
        return done({
          fix_batch_id: payload.fix_batch_id,
          revision: payload.revision,
          findings: payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: "guarded the partial write",
            files_changed: ["src/reconcile.ts", "src/reconcile.test.ts"],
            evidence: EXECUTED,
          })),
        });
      }

      case "documentation-maintainer": {
        // FG-655: Stage 6 binds its dispatch to the HOST-MINTED identity at mint time, and
        // reads the agent's own `docs_updated` declaration off the DURABLE task record — so
        // the stub honours both halves of the invoke contract it stands in for. Reconciles
        // nothing in this fixture and, like the real docs phase when there is nothing to
        // write, leaves the worktree alone: an empty declaration against a clean tree is the
        // legitimate no-op, so the candidate correctly does not move.
        args.onTaskMinted?.({ runId: RUN_ID, taskId });
        insertTask({
          id: taskId,
          runId: RUN_ID,
          phase: "task",
          agentRole: args.agentRole,
          status: "pending",
          taskPackage: {
            taskId,
            runId: RUN_ID,
            phase: "task",
            role: args.agentRole,
            inputs: { task: args.task },
            composedSystemPrompt: "(stubbed container)",
          },
          createdAt: RUN.createdAt,
        });
        // The declaration is EXPLICIT: an absent `docs_updated` is a contract violation the
        // coordinator refuses by name, not a claim that nothing changed (FG-655 RF-3).
        markTaskComplete(taskId, { docs_updated: [] });
        return done({ docs_updated: [] });
      }

      case "review-rechecker": {
        // The candidate the stub answers under is THE ONE THE PROMPT NAMED — `ingestRecheck`
        // refuses a verdict bound to any other sha, so a mis-anchored prompt fails here.
        const named = /final candidate ([0-9a-f]{7,40})/.exec(args.task)?.[1];
        assert.ok(named !== undefined, "the rechecker prompt must name the candidate it is about");
        const ids = [...new Set([...args.task.matchAll(/"finding_id": "([^"<]+)"/g)].map((m) => m[1] as string))];
        return done(recheckBehaviour(ids, named));
      }

      default:
        throw new Error(`the fixture dispatched an unexpected role: ${args.agentRole}`);
    }
  };

  const wiring = buildCoordinatorDeps({
    projectDir: repo,
    ticketId: TICKET,
    runId: RUN_ID,
    invokeFn,
    evaluatedNoDrift: "the implementation diff touches src/reconcile.ts only; the selected lenses already cover it",
  });

  const deps: CoordinatorDeps = {
    ...wiring,
    verify: (sha: string) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    shippingInput: ({ review, candidateSha }: { review: Review; candidateSha: string }) => ({
      verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
      acceptance: [
        {
          ref: "FG-650 AC 1",
          verdict: "met" as const,
          evidence: { kind: "regression_test" as const, test_name: AC_TEST, runner_output: EXECUTED },
        },
      ],
      tipTrust: { kind: "trusted" as const, reviewedSha: candidateSha, remoteSha: candidateSha },
      identity: { continuous: head() === candidateSha, detail: `head ${head()} vs candidate ${candidateSha}` },
      contractCoverage: {
        confirmedSha: review.contractConfirmedSha ?? candidateSha,
        finalSha: candidateSha,
        postConfirmationPaths: [],
        deltaReviewed: review.stageEvidence?.recheck?.sha === candidateSha,
      },
      docsCloseout: { assessed: true, gaps: [], detail: "the ticket requires no doc update" },
    }),
  };

  return { deps, calls, dispatches: (role) => calls.filter((c) => c.agentRole === role) };
}

/** The next transition as a FRESH process would read it — from the persisted rows only. */
function pending() {
  return nextTransition({
    review: getReview(REVIEW) as Review,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
}

function dispositionAll(rationale: string): void {
  for (const f of findingsForReview(REVIEW)) {
    if (f.disposition !== "untriaged") continue;
    assert.equal(recordDisposition(f.id, { decision: "fix_now", rationale, operator: false }).ok, true);
  }
}

/** Drive real stages until the PERSISTED next transition is `target`, dispositioning whenever
 *  the machine stops for one. Leaves the review parked exactly at that boundary. */
async function parkAt(deps: CoordinatorDeps, target: TransitionKind, max = 24): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (pending().kind === target) return;
    if (pending().kind === "await_disposition") {
      dispositionAll("remediate this cycle");
      continue;
    }
    const outcome = await runNextStage(REVIEW, deps);
    assert.notEqual(outcome.status, "refused", `parking at ${target}: ${outcome.transition.kind} — ${outcome.message}`);
  }
  assert.fail(`never reached ${target} (stuck at ${pending().kind}: ${pending().reason})`);
}

function discoveryMeta(): Record<string, unknown> | undefined {
  return getReview(REVIEW)?.stageEvidence?.discovery?.meta;
}

function toleratedInDiscovery(): Array<{ lens: string; keys: string[] }> {
  return (discoveryMeta()?.["toleratedRootKeys"] ?? []) as Array<{ lens: string; keys: string[] }>;
}

function persistedOutcomes(): Array<Record<string, unknown>> {
  return (getReview(REVIEW)?.lensOutcomes ?? []) as Array<Record<string, unknown>>;
}

function outcomeFor(lens: string): Record<string, unknown> {
  const found = persistedOutcomes().find((o) => o["lens"] === lens);
  assert.ok(found !== undefined, `no persisted outcome for the ${lens} lens`);
  return found;
}

// ─── discovery: the tolerance, end to end and durable ───────────────────────

test("integ FG-650: a reviewer result.json in the HARNESS's own output shape ingests, and the tolerance survives the process that wrote it", async () => {
  // THE DEFECT THIS FILE EXISTS FOR. Every composed agent prompt requires `status` in
  // result.json, so this is the only shape a real reviewer container can produce.
  //
  // RED baseline: restore `.strict()` on LensResultSchema (review-discovery.ts) and discovery
  // refuses INCOMPLETE for both lenses with `malformed_output`, ingesting nothing — the live
  // pilot's failure exactly.
  const h = harness();
  await parkAt(h.deps, "discover");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);
  assert.equal(h.dispatches("red-wide").length, 1, "the panel really ran through the invoke seam");
  assert.equal(h.dispatches("red-backend").length, 1);

  const refs = findingsForReview(REVIEW).map((f) => f.findingRef);
  assert.deepEqual(refs, ["RF-1", "RF-2"], "the findings survived the root tolerance intact");
  assert.equal(
    findingsForReview(REVIEW)[0]?.evidence,
    "line 1 writes before the guard",
    "and the payload was not mangled on the way through",
  );

  // The tolerance is RECORDED, per lens, in the durable stage record.
  const tolerated = toleratedInDiscovery();
  assert.deepEqual(tolerated.map((t) => t.lens).sort(), ["backend", "wide"], "every lens that carried extras is named");
  for (const t of tolerated) assert.deepEqual(t.keys, HARNESS_KEYS, `${t.lens} records exactly the stripped keys, sorted`);

  // STRIPPED, not passed through: the tolerated keys are named on the outcome and are not
  // fields of it. A validator that merely stopped refusing would leave `status` sitting on the
  // persisted outcome, unnamed, and this is what tells the two apart.
  const backend = outcomeFor("backend");
  assert.deepEqual(backend["toleratedRootKeys"], HARNESS_KEYS);
  assert.equal(backend["outcome"], "fail");
  for (const key of HARNESS_KEYS) {
    assert.equal(backend[key], undefined, `'${key}' was stripped from the validated outcome, not carried on it`);
  }

  // DURABILITY: the forge process that recorded it exits. Another one opens the same file —
  // which is the only way this record is ever useful to an operator reading the review later.
  restartProcess();
  const rehydrated = toleratedInDiscovery();
  assert.deepEqual(rehydrated, tolerated, "the tolerance outlived the process that recorded it");
  assert.deepEqual(outcomeFor("backend")["toleratedRootKeys"], HARNESS_KEYS);
  assert.deepEqual(findingsForReview(REVIEW).map((f) => f.findingRef), ["RF-1", "RF-2"]);
});

test("integ FG-650: a lens that carries NO extra root key records no tolerance at all", async () => {
  // The record must mean something: absent when nothing was stripped, so a reader can tell a
  // clean output from a tolerated one rather than seeing an empty list on every lens.
  const h = harness({
    lens: (lens) =>
      lens === "backend" ? { outcome: "fail", findings: [finding(1)] } : { outcome: "pass", findings: [] },
  });
  await parkAt(h.deps, "discover");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);
  assert.deepEqual(toleratedInDiscovery(), [], "no lens is named when nothing was stripped");
  assert.equal(outcomeFor("backend")["toleratedRootKeys"], undefined, "and the key is absent, not an empty array");
  assert.equal(findingsForReview(REVIEW).length, 1);
});

// ─── discovery: what stays strict ───────────────────────────────────────────

test("integ FG-650: a MISSING required root field is still refused whole — the tolerance is not a relaxation", async () => {
  // `outcome` absent, harness keys present. The tempting failure mode of a tolerant root is
  // that `status: "complete"` starts reading as the outcome; it must not.
  const h = harness({
    lens: (lens) =>
      lens === "backend"
        ? reviewerResult({ findings: [finding(1)] })
        : reviewerResult({ outcome: "pass", findings: [] }),
  });
  await parkAt(h.deps, "discover");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /discovery is INCOMPLETE/);
  assert.match(out.message, /backend \(malformed_output/);
  assert.match(out.message, /outcome/, "the refusal names the field that was missing");

  assert.equal(findingsForReview(REVIEW).length, 0, "nothing was ingested from a refused panel");
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery, undefined, "and no stage was recorded");
  assert.equal(getReview(REVIEW)?.state, "discovering");

  // The refusal is durable too, and it is recorded as an INCOMPLETE lens — never as a pass.
  restartProcess();
  const backend = outcomeFor("backend");
  assert.equal(backend["complete"], false);
  assert.equal(backend["reason"], "malformed_output");
  assert.equal(backend["outcome"], undefined, "a status key is never read as the lens outcome");
});

test("integ FG-650: an unknown key INSIDE a finding is still refused — the tolerance is ROOT-only", async () => {
  // NESTED STRICTNESS IS THE HALF THAT MUST NOT MOVE. A finding is the reviewer's actual claim;
  // an unrecognized key there is a claim the host does not understand, and swallowing it would
  // silently drop evidence into the ledger.
  const h = harness({
    lens: (lens) =>
      lens === "backend"
        ? reviewerResult({ outcome: "fail", findings: [finding(1, { confidence: 0.4 })] })
        : reviewerResult({ outcome: "pass", findings: [] }),
  });
  await parkAt(h.deps, "discover");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /backend \(malformed_output/);
  assert.match(out.message, /findings\.0/, "the refusal anchors to the finding that carried it");
  assert.match(out.message, /confidence/, "and names the offending key");

  assert.equal(findingsForReview(REVIEW).length, 0, "the whole result is refused — not the finding alone");
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery, undefined);
  assert.equal(
    toleratedInDiscovery().length,
    0,
    "a refused panel records no tolerance — `confidence` at the ROOT is tolerated, inside a finding it is not",
  );
});

// ─── recheck: the same two halves, on the same real path ────────────────────

test("integ FG-650: the rechecker's extra root keys are tolerated, recorded in the recheck stage evidence, and durable", async () => {
  // RED baseline: the pre-FG-650 root was `.passthrough()`, so these keys reached the ingestion
  // unnamed and nothing downstream could report them. `toleratedRootKeys` below is empty.
  const h = harness();
  await parkAt(h.deps, "recheck");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);
  assert.equal(h.dispatches("review-rechecker").length, 1);

  const recheck = getReview(REVIEW)?.stageEvidence?.recheck;
  assert.equal(recheck?.sha, head(), "the recheck is anchored to the post-fix candidate");
  assert.deepEqual(recheck?.meta?.["toleratedRootKeys"], ["notes", "status"], "sorted, and exactly what was stripped");
  for (const f of findingsForReview(REVIEW)) {
    assert.equal(f.resolution, "resolved", `${f.findingRef} was applied from the tolerated result`);
  }

  restartProcess();
  assert.deepEqual(
    getReview(REVIEW)?.stageEvidence?.recheck?.meta?.["toleratedRootKeys"],
    ["notes", "status"],
    "the recheck tolerance outlived the process that recorded it",
  );
});

test("integ FG-650: a rechecker that OMITS an expected id is still refused, extra root keys or not", async () => {
  // Omission is never resolution. The tolerant root must not become a way for a result that
  // answered half the question to be accepted because it looked well-formed.
  const h = harness({
    recheck: (ids, candidateSha) => ({
      status: "complete",
      notes: "answered only the first id",
      review_id: REVIEW,
      candidate_sha: candidateSha,
      rechecked: ids.slice(0, 1).map((id) => ({
        finding_id: id,
        result: "resolved",
        evidence_kind: "regression_test",
        evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
      })),
      new_findings: [],
    }),
  });
  await parkAt(h.deps, "recheck");
  const before = findingsForReview(REVIEW).map((f) => f.resolution);

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /omits RF-2/);
  assert.match(out.message, /omission is a schema failure, never resolution/);
  assert.match(out.message, /Nothing was written/);

  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck, undefined, "no recheck stage was recorded");
  assert.deepEqual(
    findingsForReview(REVIEW).map((f) => f.resolution),
    before,
    "not even the id it DID answer was applied — the result is refused whole",
  );
});

test("integ FG-650: a recheck missing a required root field is refused, and nothing is applied", async () => {
  // The root tolerates unknown keys; it did not stop REQUIRING the known ones. A result with no
  // `candidate_sha` cannot be bound to a candidate at all, which is the check that keeps a
  // recheck from being read as evidence about the wrong tree.
  const h = harness({
    recheck: (ids) => ({
      status: "complete",
      review_id: REVIEW,
      rechecked: ids.map((id) => ({
        finding_id: id,
        result: "resolved",
        evidence_kind: "regression_test",
        evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
      })),
      new_findings: [],
    }),
  });
  await parkAt(h.deps, "recheck");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /recheck result\.json invalid/);
  assert.match(out.message, /candidate_sha/);
  assert.match(out.message, /Nothing was written/);
  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck, undefined);
  for (const f of findingsForReview(REVIEW) as ReviewFinding[]) {
    assert.equal(f.resolution, undefined, `${f.findingRef} keeps no resolution from a refused result`);
  }
});
