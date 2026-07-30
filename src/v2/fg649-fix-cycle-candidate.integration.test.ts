// FG-649: the fix cycle's POST-FIX CANDIDATE, against a REAL repository and the REAL ledger.
//
// THE DEFECT THIS TIER EXISTS FOR. The coordinator recorded the fix stage and then read
// `deps.headSha()` to learn where the candidate had moved to. When the ORCHESTRATOR was the
// committer — the documented sequence until this change — it committed AFTER the coordinator
// process exited, so that read returned the PRE-fix sha every time. The candidate stayed
// pinned pre-fix, Stage 8 diffed the delta against it, and the rechecker examined a tree
// WITHOUT the fixes it was rechecking. It honestly reported still_present, the review returned
// to disposition, and no amount of re-dispatching could ever resolve it: the live loop on
// review-29d1000750b0 (fixes in 46dcc229/7ac3269a against a recorded candidate of 0194cc58).
//
// WHY IT SURVIVED 1868 LINES OF UNIT TESTS. review-run.test.ts binds the seam to a closure
// variable (`headSha: () => head`), and a stubbed fixer that assigns `head = "afterfix2"`
// simulates a sha the real path could never have observed. That suite cannot distinguish this
// bug from its fix. So this tier binds the seam to a REAL git repository: mkdtemp + git init +
// real commits, the real store, the real `buildCoordinatorDeps`, and only the container
// dispatches stubbed — with the stubbed "fixer container" WRITING FILES INTO THE REPO and
// returning a schema-valid result.json, and NOT committing them. That is the pilot's exact
// shape, and it is only meaningful against a real tree.
//
// Two deps are stubbed beyond the container dispatches, deliberately and narrowly:
// `verify` (Stage 1/7 would run the host verification machinery — npm scripts, CI probes —
// against a two-file fixture) and `shippingInput` (it fetches a remote tip that does not
// exist here). Everything FG-649 changes is real: the git seam, `commitFixCycle`, the
// candidate advance, the delta the rechecker is handed, and every stage record. The
// identity-continuity input is still computed from the REAL repository head, so that check
// cannot become a tautology here either.
//
// NOTE ON THE DONE CONDITION: no arm below re-anchors anything by hand. `updateReview` is
// never called from this file, and the last test asserts that mechanically.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import {
  findingsForReview,
  getReview,
  recordDisposition,
  type Review,
  type ReviewFinding,
} from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { runNextStage, type CoordinatorDeps, type StageOutcome } from "./review-run.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run } from "../types/index.js";

const RUN_ID = "run-fg649";
const REVIEW = "review-fg649";
const TICKET = "FG-649";
const GUARD = "if (!committed) throw new Error('refusing a partial write');";
const AC_TEST = "the reconcile path refuses a partial write";
const EXECUTED = `ok 1 - ${AC_TEST}`;

const RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "fg649",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

const CONTRACT = {
  threat_model: "an operator-trusted candidate; the coordinator now authors commits in it",
  protected_invariants: ["the candidate is never adopted from a bare HEAD read"],
  acceptance_refs: ["FG-649 AC 1"],
  risk_lenses: ["backend"],
  non_goals: ["migrating the already-stuck pilot review row"],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let repo: string;
let baseSha: string;
let entrySha: string;

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

const head = (): string => git(["rev-parse", "HEAD"]).trim();
const porcelain = (): string => git(["status", "--porcelain"]).trim();
const staged = (): string => git(["diff", "--cached", "--name-only"]).trim();

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);

  repo = mkdtempSync(join(tmpdir(), "fg649-repo-"));
  git(["init", "-q", "-b", "main", "."]);
  // Identity is LOCAL, on purpose: src/test-setup.ts neutralizes the global git config, so a
  // commit that borrowed the operator's identity would fail on CI and this fixture would prove
  // nothing about the commit forge itself authors.
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"candidate","private":true}\n`);
  writeFileSync(join(repo, "src", "reconcile.ts"), "export function reconcile() {\n  write(rowA);\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed the candidate"]);
  baseSha = head();
  appendFileSync(join(repo, "src", "reconcile.ts"), "\nexport function reconcileBoth() {\n  write(rowA);\n  write(rowB);\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "reconcile: write both rows in one path"]);
  entrySha = head();

  db.prepare(
    `INSERT INTO reviews (id, run_id, ticket_id, review_mode, base_sha, candidate_sha, contract_json, state,
                          created_at, updated_at)
     VALUES (?, ?, ?, 'evidence_led', ?, ?, ?, 'confirming_contract', ?, ?)`,
  ).run(REVIEW, RUN_ID, TICKET, baseSha, entrySha, JSON.stringify(CONTRACT), RUN.createdAt, RUN.createdAt);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

// ─── the fixture harness ────────────────────────────────────────────────────

type FixerBehaviour = (payload: FixPayload) => unknown;

type FixPayload = {
  fix_batch_id: string;
  revision: number;
  findings: Array<{ finding_id: string; finding_ref: string }>;
};

type RecheckVerdict = (ref: string) => "resolved" | "still_present";

type Harness = {
  deps: CoordinatorDeps;
  calls: InvokeArgs[];
  dispatches: (role: string) => InvokeArgs[];
};

/** The default "fixer container": it EDITS THE REAL WORKTREE and does not commit — the pilot's
 *  exact shape, and the one the pre-FG-649 coordinator could not see. */
function editingFixer(payload: FixPayload): unknown {
  appendFileSync(join(repo, "src", "reconcile.ts"), `\n${GUARD}\n`);
  writeFileSync(join(repo, "src", "reconcile.test.ts"), `// ${EXECUTED}\n`);
  return {
    fix_batch_id: payload.fix_batch_id,
    revision: payload.revision,
    findings: payload.findings.map((f) => ({
      finding_id: f.finding_id,
      result: "fixed",
      remediation_summary: "guarded the partial write",
      files_changed: ["src/reconcile.ts", "src/reconcile.test.ts"],
      evidence: EXECUTED,
    })),
  };
}

function harness(over: { fixer?: FixerBehaviour; verdict?: RecheckVerdict; deps?: Partial<CoordinatorDeps> } = {}): Harness {
  const calls: InvokeArgs[] = [];
  const fixer = over.fixer ?? editingFixer;
  const verdict = over.verdict ?? (() => "resolved" as const);

  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    calls.push(args);
    const taskId = `task-${args.agentRole}-${calls.length}`;
    const done = (result: unknown): InvokeResult => ({ runId: RUN_ID, taskId, status: "complete", result });

    switch (args.agentRole) {
      case "red-backend":
        return done({
          outcome: "fail",
          findings: [1, 2].map((n) => ({
            summary: `the reconcile path can write partially (${n})`,
            evidence: `line ${n} writes before the guard`,
            severity: "high",
            risk_lens: "backend",
            reachability: "demonstrated",
            challenges_contract: false,
            remediation_advice: "guard it",
            file: "src/reconcile.ts",
            line: n,
          })),
        });

      case "engineer": {
        // The payload the HOST delivered into the task dir is the fixer's own input, so the
        // stub reads it the way a real container would rather than being handed the batch.
        const raw = args.taskFiles?.["fix-batch/payload.json"];
        assert.ok(raw !== undefined, "the fixer's bundle must ride the task dir");
        return done(fixer(JSON.parse(raw) as FixPayload));
      }

      case "documentation-maintainer":
        // Reconciles nothing in this fixture, and — like the real docs phase when there is
        // nothing to write — leaves the worktree alone.
        return done({});

      case "review-rechecker": {
        // The candidate the stub answers under is THE ONE THE PROMPT NAMED, not one it looked
        // up. `ingestRecheck` refuses a verdict bound to any sha but the current candidate, so
        // a prompt still anchored to the pre-fix candidate — the FG-649 loop — makes this
        // fixture fail rather than quietly pass.
        const named = /final candidate ([0-9a-f]{7,40})/.exec(args.task)?.[1];
        assert.ok(named !== undefined, "the rechecker prompt must name the candidate it is about");
        const ids = [...args.task.matchAll(/"finding_id": "([^"<]+)"/g)].map((m) => m[1] as string);
        const findings = findingsForReview(REVIEW);
        return done({
          review_id: REVIEW,
          candidate_sha: named,
          rechecked: [...new Set(ids)].map((id) => {
            const ref = findings.find((f) => f.id === id)?.findingRef ?? "";
            return verdict(ref) === "resolved"
              ? {
                  finding_id: id,
                  result: "resolved",
                  evidence_kind: "regression_test",
                  evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
                }
              : { finding_id: id, result: "still_present", evidence_kind: "anchored_verification", evidence: {} };
          }),
          new_findings: [],
        });
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
    evaluatedNoDrift: "the implementation diff touches src/reconcile.ts only; the backend lens already covers it",
  });

  const deps: CoordinatorDeps = {
    ...wiring,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    shippingInput: ({ review, candidateSha }: { review: Review; candidateSha: string }) => {
      // Identity continuity is computed from the REAL repository head — the protected invariant
      // is that knowing the sha it committed must not turn this check into a tautology.
      const continuous = head() === candidateSha;
      return {
        verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
        acceptance: [
          {
            ref: "FG-649 AC 1",
            verdict: "met" as const,
            evidence: { kind: "regression_test" as const, test_name: AC_TEST, runner_output: EXECUTED },
          },
        ],
        tipTrust: { kind: "trusted" as const, reviewedSha: candidateSha, remoteSha: candidateSha },
        identity: {
          continuous,
          detail: continuous
            ? `candidate ${candidateSha} is the current head`
            : `the working tree head is ${head()}, not the reviewed candidate ${candidateSha}`,
        },
        contractCoverage: {
          confirmedSha: review.contractConfirmedSha ?? candidateSha,
          finalSha: candidateSha,
          postConfirmationPaths:
            review.contractConfirmedSha !== undefined && review.contractConfirmedSha !== candidateSha
              ? git(["diff", "--name-only", `${review.contractConfirmedSha}..${candidateSha}`])
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l !== "")
              : [],
          deltaReviewed: review.stageEvidence?.recheck?.sha === candidateSha,
        },
        docsCloseout: { assessed: true, gaps: [], detail: "the ticket requires no doc update" },
      };
    },
    ...(over.deps ?? {}),
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

/** Drive to settlement, dispositioning at every stop. Returns every outcome, so a caller can
 *  count the cycles it took — the convergence claim is about a BOUND, not just an end state. */
async function settle(deps: CoordinatorDeps, max = 30): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  for (let i = 0; i < max; i += 1) {
    if (getReview(REVIEW)?.state === "settled") return outcomes;
    if (pending().kind === "await_disposition") {
      dispositionAll("remediate this cycle");
      continue;
    }
    const outcome = await runNextStage(REVIEW, deps);
    outcomes.push(outcome);
    assert.notEqual(outcome.status, "refused", `driving to settlement: ${outcome.transition.kind} — ${outcome.message}`);
  }
  assert.fail(`the review never settled (at ${pending().kind}: ${pending().reason})`);
}

function fixRecord() {
  const rec = getReview(REVIEW)?.stageEvidence?.fix;
  assert.ok(rec !== undefined, "no fix stage record");
  return rec;
}

// ─── the done condition ─────────────────────────────────────────────────────

test("integ FG-649: the fix cycle records the POST-FIX candidate automatically, and the recheck examines exactly it", async () => {
  // The whole FG-649 done condition, on a fresh review reproducing the pilot's state: fix_now
  // findings dispositioned, a fixer that edits the real worktree, and NOBODY else committing.
  //
  // RED baseline: restore `const head = await deps.headSha(); advanceCandidate(reviewId, head)`
  // (review-run.ts:470-471) with no commitFixCycle, and every assertion from `postFix !== preFix`
  // down fails — the fixer's work stays uncommitted, the candidate stays at the pre-fix sha, and
  // the rechecker's delta is empty.
  const h = harness();
  await parkAt(h.deps, "batch_fix");

  const preFix = getReview(REVIEW)?.candidateSha as string;
  assert.equal(preFix, entrySha, "the review is anchored to the candidate that is checked out");
  assert.equal(porcelain(), "", "and the tree is clean before the fixer runs");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "advanced", fix.message);

  const postFix = head();
  assert.notEqual(postFix, preFix, "the coordinator itself created a commit for the fix cycle");
  assert.equal(getReview(REVIEW)?.candidateSha, postFix, "reviews.candidate_sha IS `git rev-parse HEAD`");
  assert.equal(fixRecord().meta?.["candidateAfter"], postFix, "and the stage record agrees with the row");
  assert.equal(fixRecord().sha, preFix, "the fix record's OWN sha stays the PRE-fix candidate");
  assert.equal(porcelain(), "", "the fixer's work is committed — nothing is left dirty behind the cycle");

  // The commit is the coordinator's own, on top of the pre-fix candidate, naming the batch.
  const batch = fixBatchesForReview(REVIEW).at(-1);
  assert.equal(git(["log", "-1", "--format=%s"]).trim(), `fix(review): fix batch ${batch?.id} revision 1`);
  assert.doesNotMatch(
    git(["log", "-1", "--format=%s"]),
    /FG-649/,
    "the subject must not reference the ticket — resolveCommitRange infers a LATER review's base from it",
  );
  assert.equal(git(["rev-parse", "HEAD^"]).trim(), preFix, "the post-fix candidate is a child of the pre-fix one");
  assert.deepEqual(
    git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter((l) => l !== "").sort(),
    ["src/reconcile.test.ts", "src/reconcile.ts"],
    "only the paths the fixer's own results declared",
  );
  const commitMeta = fixRecord().meta?.["fixCommit"] as { kind: string; sha: string; committedPaths: string[] };
  assert.equal(commitMeta.kind, "committed");
  assert.equal(commitMeta.sha, postFix);
  assert.deepEqual([...commitMeta.committedPaths].sort(), ["src/reconcile.test.ts", "src/reconcile.ts"]);

  // Stage 8 now binds to the sha the commit produced, and the delta it hands the rechecker
  // CONTAINS the fix. The pre-FG-649 loop is exactly the absence of this.
  await parkAt(h.deps, "recheck");
  const recheck = await runNextStage(REVIEW, h.deps);
  assert.equal(recheck.status, "advanced", recheck.message);
  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck?.sha, postFix);

  const prompt = h.dispatches("review-rechecker").at(-1)?.task ?? "";
  assert.match(prompt, new RegExp(`final candidate ${postFix}`), "the rechecker was told which candidate it is about");
  assert.ok(prompt.includes(GUARD), "and was handed a delta that CONTAINS the fix it is rechecking");
  assert.doesNotMatch(prompt, new RegExp(`final candidate ${preFix}`));

  for (const f of findingsForReview(REVIEW)) {
    assert.equal(f.resolution, "resolved", `${f.findingRef} was rechecked against the tree that has the fix`);
    assert.equal(f.resolvedSha, postFix);
  }

  // And it SHIPS, with no manual re-anchoring anywhere.
  await settle(h.deps);
  assert.equal(getReview(REVIEW)?.state, "settled");
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping?.sha, head());
  assert.equal(h.dispatches("engineer").length, 1, "one fix cycle was enough — the loop is gone");
});

// ─── resumability: a crash between the ingest and the commit ─────────────────

test("integ FG-649: a crash between ingestion and the commit starts NO second fixer and still records the post-fix candidate", async () => {
  // Stage 5 used to dispatch before checking whether this revision had already ingested, so a
  // crash here ran a SECOND real fixer container over already-fixed code.
  //
  // RED baseline: remove the ingested-results short-circuit in runBatchFix and the
  // engineer-dispatch count below reads 2; remove `fixCycleAwaitingRecord` from
  // fixStageSatisfied and the review walks to `docs` at the PRE-fix candidate with the fixer's
  // work uncommitted forever.
  const h = harness();
  await parkAt(h.deps, "batch_fix");
  const preFix = getReview(REVIEW)?.candidateSha as string;

  const crashing: CoordinatorDeps = {
    ...h.deps,
    commitFixCycle: () => {
      throw new Error("the orchestrator died between ingestion and the commit");
    },
  };
  await assert.rejects(() => runNextStage(REVIEW, crashing), /died between ingestion and the commit/);

  assert.equal(h.dispatches("engineer").length, 1);
  assert.equal(fixBatchesForReview(REVIEW).at(-1)?.state, "ingested", "the results are in the ledger");
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined, "a stage records itself only on success");
  assert.equal(getReview(REVIEW)?.candidateSha, preFix);
  assert.equal(head(), preFix, "nothing was committed");
  assert.notEqual(porcelain(), "", "the fixer's edits are still sitting in the worktree");
  assert.equal(pending().kind, "batch_fix", "an ingested cycle with no record re-opens Stage 5, not docs");

  // A fresh process picks it up.
  const resumed = await runNextStage(REVIEW, harness().deps);
  assert.equal(resumed.status, "advanced", resumed.message);
  assert.equal(h.dispatches("engineer").length, 1, "NO second fixer container was started for this revision");
  assert.equal(fixRecord().meta?.["resumedFromIngested"], true);
  assert.equal(getReview(REVIEW)?.candidateSha, head());
  assert.equal(fixRecord().meta?.["candidateAfter"], head());
  assert.notEqual(head(), preFix, "the resumed cycle committed the work the crashed one had ingested");
  assert.equal(porcelain(), "");
  assert.equal(fixBatchesForReview(REVIEW).length, 1, "and it did not mint a second revision");
});

// ─── the named refusals ─────────────────────────────────────────────────────

test("integ FG-649: a fixer that DECLARES files against a clean tree refuses by name and records nothing", async () => {
  // The fixer's own ledger claim contradicts the tree. Deliberately NOT collapsed into the
  // legitimate resolved-without-a-code-change case, which declares no files and is `no_change`.
  const h = harness({
    fixer: (payload) => ({
      fix_batch_id: payload.fix_batch_id,
      revision: payload.revision,
      findings: payload.findings.map((f) => ({
        finding_id: f.finding_id,
        result: "fixed",
        remediation_summary: "claims a guard it never wrote",
        files_changed: ["src/reconcile.ts"],
        evidence: EXECUTED,
      })),
    }),
  });
  await parkAt(h.deps, "batch_fix");
  const preFix = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /fix_cycle_declared_changes_absent/);
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined, "no fix stage record");
  assert.equal(getReview(REVIEW)?.candidateSha, preFix, "the candidate did not move");
  assert.equal(head(), preFix, "and nothing was committed");
  assert.equal(pending().kind, "batch_fix", "the row is not parked mid-stage — continue re-enters Stage 5");

  const again = await runNextStage(REVIEW, h.deps);
  assert.equal(again.status, "refused");
  assert.equal(h.dispatches("engineer").length, 1, "re-entry does not run a second fixer for an ingested revision");
});

test("integ FG-649: a tree that moved OUTSIDE the declared set refuses by name and stages nothing", async () => {
  const h = harness({
    fixer: (payload) => {
      appendFileSync(join(repo, "src", "reconcile.ts"), `\n${GUARD}\n`);
      writeFileSync(join(repo, "src", "sneaky.ts"), "// nobody declared this\n");
      return {
        fix_batch_id: payload.fix_batch_id,
        revision: payload.revision,
        findings: payload.findings.map((f) => ({
          finding_id: f.finding_id,
          result: "fixed",
          remediation_summary: "guarded, plus something it did not declare",
          files_changed: ["src/reconcile.ts"],
          evidence: EXECUTED,
        })),
      };
    },
  });
  await parkAt(h.deps, "batch_fix");
  const preFix = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /fix_cycle_tree_dirty_outside_declared_scope/);
  assert.match(out.message, /src\/sneaky\.ts/);
  assert.equal(head(), preFix);
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined);
  assert.equal(staged(), "", "forge staged NOTHING — an undeclared change is never swept in");
  assert.match(porcelain(), /sneaky\.ts/, "and the undeclared change is left exactly where it was");
});

test("integ FG-649: a fixer that COMMITS its own work refuses by name rather than adopting a sha forge did not author", async () => {
  // The fixer prompt never asks for a commit, but an agent that makes one anyway moves HEAD off
  // the candidate. Adopting it would adopt a sha the coordinator did not author — and one that
  // may carry changes no result declared, which is exactly the blast radius the declared-files
  // guard exists to bound. So the write refuses, under the same name the verify stage uses, and
  // the refusal is checked BEFORE the clean-tree arm so the operator is told the real reason.
  const h = harness({
    fixer: (payload) => {
      appendFileSync(join(repo, "src", "reconcile.ts"), `\n${GUARD}\n`);
      git(["add", "-A"]);
      git(["commit", "-qm", "the fixer committed its own work"]);
      return {
        fix_batch_id: payload.fix_batch_id,
        revision: payload.revision,
        findings: payload.findings.map((f) => ({
          finding_id: f.finding_id,
          result: "fixed",
          remediation_summary: "guarded and committed",
          files_changed: ["src/reconcile.ts"],
          evidence: EXECUTED,
        })),
      };
    },
  });
  await parkAt(h.deps, "batch_fix");
  const preFix = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /candidate_not_checked_out/);
  assert.doesNotMatch(out.message, /fix_cycle_declared_changes_absent/, "the real reason, not the clean-tree one");
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined);
  assert.equal(getReview(REVIEW)?.candidateSha, preFix, "the candidate is NOT adopted from the fixer's commit");
  assert.equal(git(["log", "-1", "--format=%s"]).trim(), "the fixer committed its own work", "and its commit is left alone");
});

test("integ FG-649 / RF-8: an all-resolved fix_now set is never handed to a fixer and the row is never moved to fixing", async () => {
  // The empty-unresolved-set escape. Before change 3 the selecting predicate had no resolution
  // term, so this state re-dispatched a fixer over findings that were already proven fixed —
  // and `ensureFixBatch` throws on an empty list, so the narrowed version had to make the
  // transition unselectable rather than let Stage 5 be entered and die mid-stage. runBatchFix
  // carries the named `fix_cycle_empty_unresolved_set` refusal as the cross-process backstop.
  const h = harness();
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);
  const candidate = getReview(REVIEW)?.candidateSha as string;
  for (const f of findingsForReview(REVIEW)) {
    assert.equal(f.disposition, "fix_now", "still fix_now — a resolution is not a disposition change");
    assert.equal(f.resolution, "resolved");
    assert.equal(f.resolvedSha, candidate);
  }

  const batchesBefore = fixBatchesForReview(REVIEW).length;
  const fixersBefore = h.dispatches("engineer").length;
  assert.notEqual(pending().kind, "batch_fix", pending().reason);

  await settle(h.deps);
  assert.equal(getReview(REVIEW)?.state, "settled");
  assert.equal(fixBatchesForReview(REVIEW).length, batchesBefore, "no further batch was created");
  assert.equal(h.dispatches("engineer").length, fixersBefore, "and no further fixer was dispatched");
});

// ─── membership, invalidation, convergence ──────────────────────────────────

test("integ FG-649 / RF-8: the batch carries the UNRESOLVED findings only, and a no-change cycle preserves the other's proof", async () => {
  // RED baseline: drop the resolution term from `unresolvedFixNow` and revision 2's payload
  // carries RF-1 again — at which point the fix-cycle invalidation, which is scoped to batch
  // membership, clears the very proof that made it un-dispatchable.
  const h = harness({ verdict: (ref) => (ref === "RF-1" ? "resolved" : "still_present") });
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);

  const candidate = getReview(REVIEW)?.candidateSha as string;
  const rf1 = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1") as ReviewFinding;
  const rf2 = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2") as ReviewFinding;
  assert.equal(rf1.resolution, "resolved");
  assert.equal(rf1.resolvedSha, candidate);
  assert.equal(rf2.resolution, "still_present");

  // A fresh decision on RF-2 opens revision 2. This cycle changes NOTHING in the tree, so the
  // candidate legitimately stays put and RF-1's proof is not touched by a candidate advance —
  // which isolates the RF-8 claim from scenario #14.
  assert.equal(
    recordDisposition(rf2.id, { decision: "fix_now", rationale: "second attempt: guard the caller", operator: false }).ok,
    true,
  );
  const noChangeFixer: FixerBehaviour = (payload) => ({
    fix_batch_id: payload.fix_batch_id,
    revision: payload.revision,
    findings: payload.findings.map((f) => ({
      finding_id: f.finding_id,
      result: "fixed",
      remediation_summary: "the existing guard already covers this caller",
      files_changed: [],
      evidence: EXECUTED,
    })),
  });
  const h2 = harness({ fixer: noChangeFixer, verdict: () => "resolved" });

  assert.equal(pending().kind, "batch_fix", pending().reason);
  const secondFix = await runNextStage(REVIEW, h2.deps);
  assert.equal(secondFix.status, "advanced", secondFix.message);

  const revision2 = fixBatchesForReview(REVIEW).at(-1);
  assert.equal(revision2?.revision, 2);
  assert.deepEqual(
    revision2?.payload.findings.map((f) => f.finding_ref),
    ["RF-2"],
    "the batch carries the UNRESOLVED fix_now findings only",
  );
  assert.equal(fixRecord().meta?.["candidateAfter"], candidate, "a no-change cycle does not move the candidate");
  assert.equal((fixRecord().meta?.["fixCommit"] as { kind: string }).kind, "no_change");
  assert.equal(head(), candidate);

  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1")?.resolution,
    "resolved",
    "a cycle that did not carry RF-1 cannot clear its proof (RF-8)",
  );
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2")?.resolution,
    undefined,
    "the carried finding's stale verdict IS cleared — that cycle is about it",
  );

  // Convergence: a second cycle at an unmoved candidate earns its own recheck and the review
  // settles, with no oscillation between Stage 5 and Stage 8.
  await settle(h2.deps);
  assert.equal(getReview(REVIEW)?.state, "settled");
  assert.equal(fixBatchesForReview(REVIEW).length, 2, "two revisions, not an unbounded chain");
});

test("integ FG-649 / PRD #14: a proof from the PRE-fix candidate is invalidated when the cycle's commit moves it, and the review still converges", async () => {
  // The other half of the same rule: RF-8 preserves a proof a cycle did not touch, and scenario
  // #14 still invalidates a proof the candidate MOVED away from. The commit the coordinator
  // authors is what makes that move real — it is the same `advanceCandidate` the docs stage
  // uses, so no new invalidation key exists.
  const h = harness({ verdict: (ref) => (ref === "RF-1" ? "resolved" : "still_present") });
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);

  const provenAt = getReview(REVIEW)?.candidateSha as string;
  const rf2 = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2") as ReviewFinding;
  assert.equal(findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1")?.resolvedSha, provenAt);
  assert.equal(
    recordDisposition(rf2.id, { decision: "fix_now", rationale: "second attempt: guard the caller", operator: false }).ok,
    true,
  );

  const h2 = harness({ verdict: () => "resolved" });
  const secondFix = await runNextStage(REVIEW, h2.deps);
  assert.equal(secondFix.status, "advanced", secondFix.message);
  assert.notEqual(getReview(REVIEW)?.candidateSha, provenAt, "the cycle's commit moved the candidate");
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1")?.resolution,
    undefined,
    "a proof recorded at the sha the review LEFT is not evidence about the one it is on",
  );

  // It converges: the invalidated finding costs at most one further cycle, and the review ships.
  const outcomes = await settle(h2.deps);
  assert.equal(getReview(REVIEW)?.state, "settled");
  assert.ok(
    fixBatchesForReview(REVIEW).length <= 3,
    `bounded fix revisions, got ${fixBatchesForReview(REVIEW).length}`,
  );
  assert.ok(
    outcomes.filter((o) => o.transition.kind === "recheck").length <= 3,
    "bounded recheck cycles — the key is monotone and converges",
  );
  for (const f of findingsForReview(REVIEW)) {
    assert.equal(f.resolution, "resolved");
    assert.equal(f.resolvedSha, head());
  }
});

test("integ FG-649: this suite proves the done condition WITHOUT re-anchoring anything by hand", () => {
  // "No manual re-anchoring workaround" is the operator's non-negotiable condition, so it is
  // asserted mechanically rather than trusted: a future edit that reached for the store's
  // review-patch verb to set a candidate sha — or hand-wrote a stage record — fails here.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(source, /updateReview\(/, "no arm may move the candidate itself");
  assert.doesNotMatch(source, /recordStageEvidence\(/, "no arm may hand-write a stage record");
});
