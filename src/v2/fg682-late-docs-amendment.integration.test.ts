// FG-682: the BOUNDED late-docs amendment, replayed end to end against a REAL repository and the
// REAL ledger — the AC7 proof.
//
// THE DEFECT THIS TIER EXISTS FOR (FG-678, 2026-08-05). A review batch-fixed its findings by
// collapsing three dispatch lanes into one shared resolver. That FALSIFIED a documentation
// statement the same review had already reconciled — docs still asserted the old lane topology.
// The orchestrator found the falsehood AFTER the docs stage had completed and recorded its
// result, and there was no supported way to amend the three-line prose correction into the pinned
// candidate. Committing it out of band left the candidate pinned while the branch tip drifted
// ahead, so the shipping review reported `✗ tip_equality` (local_only) and `✗ docs_closeout`
// (the docs ARE stale at the candidate). The operator shipped by OVERRIDING both checks (BD-13),
// because a full second discovery pass over a prose delta would have been ceremony, not risk
// reduction. This ticket removes that choice: a bounded coordinator verb amends the correction IN,
// advances the candidate, re-runs only what the move invalidated, and lets those two checks pass
// on their OWN terms.
//
// WHY IT NEEDS THIS TIER, not review-run.test.ts. The amendment is a candidate-moving, commit-
// authoring path: its whole contract is about a REAL git commit landing on top of the pinned
// candidate, the candidate advancing to the sha the coordinator AUTHORED, and the bounded delta
// the next recheck is handed being cut from the REAL superseded→amended range. A closure-variable
// `headSha` seam cannot distinguish the amendment from a bare re-anchor. So this binds the seams
// to a real repository (mkdtemp + git init + real commits), the real store, the real
// `buildCoordinatorDeps`, the real `runDocsAmendment`, and only the container dispatches stubbed —
// exactly the fg649 / fg655 shape, one lifecycle window later.
//
// Two deps are stubbed beyond the container dispatches, deliberately and narrowly: `verify`
// (Stages 1/7/9 would run the host verification machinery against a fixture) and `shippingInput`
// (it fetches a remote tip that does not exist here). `verify` RECORDS the sha it is asked about,
// so the AC4 claim — CI is required at the AMENDED sha — is checked, not assumed. Everything
// FG-682 changes is real: the amendment commit, the candidate advance, the ledger record and its
// event, the bounded recheck delta, and every stage record's sha.
//
// NOTE ON THE DONE CONDITION: no arm re-anchors the candidate by hand. `updateReview`,
// `recordStageEvidence`, `recordDocsAmendment` and `advanceCandidate` are never called from this
// file — the coordinator does all candidate movement — and the last test asserts that mechanically.

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
import { insertTask, markTaskComplete } from "../store/tasks.js";
import { amendmentRecordsOf, findingsForReview, getReview, recordDisposition, type Review } from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { eventsForRun } from "../store/events.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { runDocsAmendment, runNextStage, type CoordinatorDeps } from "./review-run.js";
import { assessShippingReview, type ShippingInput } from "./review-shipping.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run } from "../types/index.js";

const RUN_ID = "run-fg682";
const REVIEW = "review-fg682";
const TICKET = "FG-682";

// The finding the batch fixes, and the executed assertion the fixer names and the rechecker
// re-runs (RF-5). Kept out of every file's CONTENT so a delta assertion below can tell the fixer's
// CODE change apart from the evidence text that always rides the rechecker prompt.
const AC_TEST = "the three lanes resolve through one shared resolver";
const EXECUTED = `ok 1 - ${AC_TEST}`;

// Distinctive markers, each present in exactly ONE commit's file bytes, so the bounded-delta
// assertion can prove the post-amendment recheck delta covers ONLY the amended prose.
const FIX_MARKER = "COLLAPSED_LANES_INTO_ONE_RESOLVER"; // rides the fix commit's src/resolver.ts
const DOCS_MARKER = "DOCS_STAGE_RECONCILED_THE_TOPOLOGY"; // rides the docs commit's docs/DEV-NOTES.md
const AMEND_MARKER = "RECEIPT_NO_LONGER_DISTINGUISHES_THE_LANES"; // rides the amendment's docs/SCHEMA-CONTRACT.md

const DOC_AMEND_PATH = "docs/SCHEMA-CONTRACT.md";

const RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "fg682",
  status: "active",
  createdAt: "2026-08-05T00:00:00Z",
  reviewMode: "evidence_led",
};

const CONTRACT = {
  threat_model: "an operator-trusted candidate the coordinator authors a late-docs amendment commit in",
  protected_invariants: ["only declared documentation lands in the amendment; the candidate never re-anchors to HEAD"],
  acceptance_refs: ["FG-682 AC 1"],
  risk_lenses: ["backend"],
  non_goals: ["a general re-anchor verb", "re-running full discovery over the implementation"],
  // FG-689 AC2: the scope owns what THIS fixture's repository changes — src/ and docs/.
  lens_scopes: { backend: ["src/", "docs/"] },
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
const pathsAt = (sha: string): string[] =>
  git(["show", "--name-only", "--format=", sha]).split("\n").filter((l) => l.trim() !== "").sort();

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);

  repo = mkdtempSync(join(tmpdir(), "fg682-repo-"));
  git(["init", "-q", "-b", "main", "."]);
  // Identity is LOCAL: src/test-setup.ts neutralizes the global git config, so a commit that
  // borrowed the operator's identity would fail on CI and this fixture would prove nothing about
  // the commit forge itself authors.
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"candidate","private":true}\n`);
  writeFileSync(join(repo, "src", "resolver.ts"), "export function resolve() {\n  return laneA();\n}\n");
  // The FG-678 statement the batch will falsify — the prose the amendment ultimately corrects.
  writeFileSync(
    join(repo, "docs", "SCHEMA-CONTRACT.md"),
    "# Schema contract\n\nThe dependencyEnvironment receipt exists because a writable invoke and a\n" +
      "read-write non-worktree dispatch cross the same resolver as a reviewer — three distinct lanes.\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "seed the candidate"]);
  baseSha = head();
  // The implementation commit under review — the confirmed sha discovery anchors to.
  appendFileSync(join(repo, "src", "resolver.ts"), "\nexport function resolveWorktree() {\n  return laneC();\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "resolver: add the worktree lane"]);
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

type Harness = {
  deps: CoordinatorDeps;
  calls: InvokeArgs[];
  dispatches: (role: string) => InvokeArgs[];
  /** Every sha `verify` was asked about, in order — the AC4 evidence that CI runs at the
   *  amended sha, not merely that the OLD verification was invalidated. */
  verifyCalls: string[];
};

function harness(over: { deps?: Partial<CoordinatorDeps> } = {}): Harness {
  const calls: InvokeArgs[] = [];
  const verifyCalls: string[] = [];

  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    calls.push(args);
    const taskId = `task-${args.agentRole}-${calls.length}`;
    const done = (result: unknown): InvokeResult => ({ runId: RUN_ID, taskId, status: "complete", result });

    switch (args.agentRole) {
      case "red-backend":
        // Discovery finds the pre-fix defect: the lanes resolve independently. ONE finding keeps
        // the fixture small; the point of this tier is the amendment, not discovery breadth.
        return done({
          outcome: "fail",
          findings: [
            {
              summary: "the dispatch lanes each resolve independently rather than through one resolver",
              evidence: "laneA and laneC resolve on separate paths",
              severity: "high",
              risk_lens: "backend",
              reachability: "demonstrated",
              challenges_contract: false,
              remediation_advice: "collapse the lanes into one shared resolver",
              file: "src/resolver.ts",
              line: 2,
            },
          ],
        });

      case "engineer": {
        // The batch fix: collapse the lanes into one resolver. It EDITS the real worktree and does
        // NOT commit — the coordinator authors the fix commit. FIX_MARKER rides only these bytes.
        const raw = args.taskFiles?.["fix-batch/payload.json"];
        assert.ok(raw !== undefined, "the fixer's bundle must ride the task dir");
        const payload = JSON.parse(raw) as { fix_batch_id: string; revision: number; findings: Array<{ finding_id: string }> };
        writeFileSync(
          join(repo, "src", "resolver.ts"),
          `export function resolve() {\n  // ${FIX_MARKER}\n  return oneResolver();\n}\n`,
        );
        writeFileSync(join(repo, "src", "resolver.test.ts"), `// ${EXECUTED}\n`);
        return done({
          fix_batch_id: payload.fix_batch_id,
          revision: payload.revision,
          findings: payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: "collapsed the lanes into one resolver",
            files_changed: ["src/resolver.ts", "src/resolver.test.ts"],
            evidence: EXECUTED,
            executed_assertion: AC_TEST,
          })),
        });
      }

      case "documentation-maintainer": {
        // The docs stage RECONCILES its own note and DECLARES it, so the coordinator authors a real
        // docs commit — the FG-678 shape, where the docs stage ran and completed BEFORE the
        // correction was discovered. DOCS_MARKER rides only this commit. (It leaves SCHEMA-CONTRACT
        // alone: that is the statement the batch falsified, discovered only afterwards.)
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
        writeFileSync(join(repo, "docs", "DEV-NOTES.md"), `# dev notes\n\n${DOCS_MARKER}\n`);
        markTaskComplete(taskId, { docs_updated: ["docs/DEV-NOTES.md"] });
        return done({ docs_updated: ["docs/DEV-NOTES.md"] });
      }

      case "review-rechecker": {
        // Answer under the candidate the PROMPT named — ingestRecheck refuses a verdict bound to
        // any other sha, so a prompt still anchored to the superseded candidate would fail here
        // rather than quietly pass. Resolve every finding the prompt asks about (the fix landed).
        const named = /final candidate ([0-9a-f]{7,40})/.exec(args.task)?.[1];
        assert.ok(named !== undefined, "the rechecker prompt must name the candidate it is about");
        const ids = [...args.task.matchAll(/"finding_id": "([^"<]+)"/g)].map((m) => m[1] as string);
        return done({
          review_id: REVIEW,
          candidate_sha: named,
          rechecked: [...new Set(ids)].map((id) => ({
            finding_id: id,
            result: "resolved",
            evidence_kind: "regression_test",
            evidence: { kind: "regression_test", test_name: AC_TEST, runner_output: EXECUTED },
          })),
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
    evaluatedNoDrift: "the implementation diff touches src/resolver.ts only; the backend lens already covers it",
  });

  const deps: CoordinatorDeps = {
    ...wiring,
    verify: (sha) => {
      verifyCalls.push(sha);
      return { ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" };
    },
    shippingInput: ({ review, candidateSha }: { review: Review; candidateSha: string }) => {
      // Identity continuity is computed from the REAL repository head — knowing the amended sha
      // must not turn this check into a tautology. The amended candidate is treated as PUBLISHED
      // (tipTrust trusted, reviewed == remote), the precondition the verb documents: publication
      // is the orchestrator's, tip_equality is remote equality.
      const continuous = head() === candidateSha;
      return {
        verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
        acceptance: [
          {
            ref: "FG-682 AC 1",
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
        // The docs closeout re-runs at the amended candidate. With the correction now IN the
        // candidate, the docs are NOT stale — an honest `gaps: []` rather than the FG-678 override.
        docsCloseout: { assessed: true, gaps: [], detail: "the receipt prose was corrected in the candidate" },
      };
    },
    ...(over.deps ?? {}),
  };

  return { deps, calls, verifyCalls, dispatches: (role) => calls.filter((c) => c.agentRole === role) };
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

/** Drive real stages until the PERSISTED next transition is `target`, dispositioning at every
 *  stop. Leaves the review parked exactly at that boundary. */
async function parkAt(deps: CoordinatorDeps, target: TransitionKind, max = 30): Promise<void> {
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

function docsRecord() {
  return getReview(REVIEW)?.stageEvidence?.docs;
}

/** Drive the FG-678 shape up to the boundary the correction is discovered at: past discovery, a
 *  batch fix committed, the docs stage committed and complete, verify_final and recheck done — the
 *  review parked at shipping_review on a CLEAN tree. Returns the superseded candidate. */
async function driveToShippingBoundary(h: Harness): Promise<string> {
  await parkAt(h.deps, "shipping_review");
  const superseded = getReview(REVIEW)?.candidateSha as string;
  assert.equal(head(), superseded, "HEAD is the pinned candidate the review is about");
  assert.equal(porcelain(), "", "and the tree is clean — the docs stage is over, nothing stranded");
  // The FG-678 history is real: a fix commit carrying FIX_MARKER and a docs commit carrying
  // DOCS_MARKER both sit between the confirmed sha and the pinned candidate.
  assert.notEqual(superseded, entrySha, "the candidate advanced through the fix and docs commits");
  assert.equal(docsRecord()?.sha, superseded, "the docs stage completed at the pinned candidate");
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_final?.sha, superseded, "and so did final verification");
  return superseded;
}

// ─── AC1 / AC3 / AC6: the amendment commits, advances, and records its lineage ───

test("integ FG-682: the coordinator amends the correction into the candidate, advancing it and recording the lineage", async () => {
  const h = harness();
  const superseded = await driveToShippingBoundary(h);

  // THE CORRECTION IS DISCOVERED AFTER THE DOCS STAGE: the batch falsified SCHEMA-CONTRACT's lane
  // topology, and only now does the orchestrator find it. Three lines of prose, in the worktree.
  writeFileSync(
    join(repo, DOC_AMEND_PATH),
    "# Schema contract\n\nThe dependencyEnvironment receipt no longer distinguishes the lanes:\n" +
      `all three now cross one shared resolver. ${AMEND_MARKER}.\n`,
  );

  const rationale = "the batch collapsed all three lanes into one resolver, falsifying the receipt prose";
  const outcome = await runDocsAmendment(REVIEW, [DOC_AMEND_PATH], rationale, h.deps, { discoveredBy: "orchestrator" });

  assert.equal(outcome.status, "amended", JSON.stringify(outcome));
  if (outcome.status !== "amended") return; // narrow the union for the compiler
  const amended = head();
  assert.equal(outcome.supersededSha, superseded, "the outcome names the superseded candidate");
  assert.equal(outcome.amendedSha, amended, "and the amended one");
  assert.equal(getReview(REVIEW)?.candidateSha, amended, "AC3: the COORDINATOR advanced the candidate");
  assert.notEqual(amended, superseded, "the candidate MOVED off the pinned sha");
  assert.equal(git(["rev-parse", "HEAD^"]).trim(), superseded, "the amended candidate is a child of the superseded one");

  // AC2 by construction here: ONLY the declared documentation landed, read off the COMMIT.
  assert.deepEqual(pathsAt("HEAD"), [DOC_AMEND_PATH], "the amendment commit carries only the declared documentation");
  assert.deepEqual(outcome.committedPaths, [DOC_AMEND_PATH]);
  assert.equal(porcelain(), "", "the coordinator committed the correction — nothing is left stranded");
  assert.doesNotMatch(
    git(["log", "-1", "--format=%s"]),
    /FG-682/,
    "the subject must not reference the ticket — resolveReviewBase infers a LATER review's base from it",
  );

  // AC6: the dedicated ledger record is the durable home of the lineage and the rationale — the
  // amendment reads AS an amendment, not as if the pinned candidate had always contained the prose.
  const records = amendmentRecordsOf(getReview(REVIEW) as Review);
  assert.equal(records.length, 1, "exactly one amendment record");
  const rec = records[0]!;
  assert.equal(rec.supersededSha, superseded, "lineage: the superseded candidate every prior stage bound to");
  assert.equal(rec.amendedSha, amended, "lineage: the amended candidate CI must now re-run at");
  assert.deepEqual(rec.paths, [DOC_AMEND_PATH], "the record names exactly what moved");
  assert.equal(rec.rationale, rationale, "the rationale is preserved verbatim");
  assert.equal(rec.discoveredBy, "orchestrator", "and who found it after the stage");

  // The docs stage record is re-bound to the AMENDED sha and MARKED an amendment, so Stage 6 stays
  // complete at the new candidate and is not re-opened, while a reader can tell this docs record
  // apart from the ordinary Stage-6 completion at the superseded sha.
  assert.equal(docsRecord()?.sha, amended, "the docs record binds to the amended candidate (Stage 6 stays complete)");
  assert.equal(docsRecord()?.meta?.["amendment"], true, "and is marked an amendment");
  assert.equal(docsRecord()?.meta?.["supersededSha"], superseded, "the docs record itself carries the lineage");

  // AC6, the event half: review.docs_amended carries fromSha/toSha so an append-only reader sees
  // the move without reading the row.
  const amendEvents = eventsForRun(RUN_ID).filter((e) => e.eventType === "review.docs_amended");
  assert.equal(amendEvents.length, 1, "one amendment event");
  const payload = amendEvents[0]!.payload as { fromSha: string; toSha: string; paths: string[]; rationale: string };
  assert.equal(payload.fromSha, superseded, "the event's fromSha is the superseded candidate");
  assert.equal(payload.toSha, amended, "and its toSha is the amended one");
  assert.deepEqual(payload.paths, [DOC_AMEND_PATH]);
});

test("integ FG-682 RF-2: a candidate advance racing the amendment loses the compare-and-set — no unadopted commit on the tip", async () => {
  const h = harness();
  const superseded = await driveToShippingBoundary(h);

  // The correction is in the worktree, ready to commit.
  writeFileSync(
    join(repo, DOC_AMEND_PATH),
    "# Schema contract\n\nThe dependencyEnvironment receipt no longer distinguishes the lanes:\n" +
      `all three now cross one shared resolver. ${AMEND_MARKER}.\n`,
  );

  // A `git` seam that reproduces the race window the finding names: the committer has already
  // checked HEAD == the candidate; between that check and the ref move — during "the worktree
  // scan and staging" — ANOTHER writer advances the branch tip. We land that racer on the
  // committer's first porcelain scan (after the candidate check, before staging, so the racer's
  // `--allow-empty` commit stays genuinely empty and never sweeps the un-staged correction in),
  // then let the real commit proceed. The CAS `update-ref HEAD <new> <candidate>` must refuse,
  // because HEAD is no longer the candidate.
  let raced = false;
  const raceGit = (args: string[]): string => {
    if (!raced && args[0] === "status") {
      raced = true;
      git(["commit", "--allow-empty", "-qm", "a concurrent writer advanced the candidate first"]);
    }
    return git(args);
  };
  const racedWiring = buildCoordinatorDeps({ projectDir: repo, ticketId: TICKET, runId: RUN_ID, git: raceGit });
  const racedDeps: CoordinatorDeps = { ...h.deps, commitDocsAmendment: racedWiring.commitDocsAmendment };
  const racerTip = () => head();

  const outcome = await runDocsAmendment(REVIEW, [DOC_AMEND_PATH], "the receipt prose is now false", racedDeps);

  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") return;
  assert.equal(outcome.reason, "docs_amendment_commit_raced", "the CAS refusal names the race");

  // THE POINT OF RF-2: the branch tip is the racer's commit, NOT an unadopted amendment commit
  // left dangling on it. The amendment moved nothing an amendment must not.
  assert.equal(raced, true, "the race actually fired");
  assert.equal(head(), git(["rev-parse", "HEAD"]).trim());
  assert.deepEqual(pathsAt("HEAD"), [], "the branch tip is the racer's empty commit — no amendment commit on it");
  assert.equal(git(["rev-parse", "HEAD^"]).trim(), superseded, "and the racer sits directly on the superseded candidate");
  assert.notEqual(racerTip(), superseded, "HEAD advanced (to the racer), never to the amendment");

  // Records nothing, candidate unmoved.
  assert.equal(getReview(REVIEW)?.candidateSha, superseded, "the review candidate is unmoved");
  assert.equal(amendmentRecordsOf(getReview(REVIEW) as Review).length, 0, "no amendment record");
  // The correction is still in the worktree — nothing lost.
  assert.match(porcelain(), /SCHEMA-CONTRACT\.md/, "the correction stays in the worktree for a clean re-run");
});

// ─── RF-4: the amendment tree is cut from the candidate + declared blobs ONLY ───

test("integ FG-682 RF-4: the amendment commit carries ONLY the declared documentation — an undeclared path staged into the index after the scan is neither committed nor lost", async () => {
  const h = harness();
  const superseded = await driveToShippingBoundary(h);

  const UNDECLARED = "src/unrelated.ts";
  const STAGED = "STAGED_UNDECLARED\n";

  // The declared documentation correction, in the worktree.
  writeFileSync(
    join(repo, DOC_AMEND_PATH),
    `# Schema contract\n\nCorrected: one shared resolver for all three lanes. ${AMEND_MARKER}.\n`,
  );

  // A `git` seam that reproduces the index-dirtying window the defect names: an UNDECLARED path is
  // staged into the SHARED index AFTER the committer's porcelain scan (so `outside` never sees it,
  // exactly as a path staged between the scan and the write would not) but BEFORE the tree is
  // built. `write-tree` over the WHOLE index would ride it into the documentation-labelled commit;
  // a tree cut from the candidate + the declared blobs alone cannot. env is forwarded, so the fix's
  // GIT_INDEX_FILE scratch index still lands where the fix points it.
  let injected = false;
  const gitEnv = (args: string[], env?: Record<string, string>): string => {
    const res = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
    });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout;
  };
  const seam = (args: string[], env?: Record<string, string>): string => {
    if (!injected && args[0] === "status") {
      const out = gitEnv(args, env); // the porcelain scan — WITHOUT the undeclared path
      injected = true;
      writeFileSync(join(repo, UNDECLARED), STAGED);
      gitEnv(["add", "--", UNDECLARED]); // stage it into the SHARED index, after the scan
      return out;
    }
    return gitEnv(args, env);
  };

  const seamWiring = buildCoordinatorDeps({ projectDir: repo, ticketId: TICKET, runId: RUN_ID, git: seam });
  const deps: CoordinatorDeps = { ...h.deps, commitDocsAmendment: seamWiring.commitDocsAmendment };

  const outcome = await runDocsAmendment(REVIEW, [DOC_AMEND_PATH], "correct the falsified receipt prose", deps, {
    discoveredBy: "orchestrator",
  });

  assert.equal(injected, true, "the undeclared path was actually staged in the scan→write window");
  assert.equal(outcome.status, "amended", JSON.stringify(outcome));

  // AC2 / RF-4: the amendment commit's tree contains the declared doc change and does NOT contain
  // the undeclared path — read off the COMMIT the coordinator authored (HEAD).
  const amended = head();
  assert.deepEqual(pathsAt(amended), [DOC_AMEND_PATH], "the amendment commit carries ONLY the declared documentation");
  assert.ok(git(["show", `${amended}:${DOC_AMEND_PATH}`]).includes(AMEND_MARKER), "and it does carry the declared correction");
  const shown = spawnSync("git", ["show", `${amended}:${UNDECLARED}`], { cwd: repo, encoding: "utf8" });
  assert.notEqual(shown.status, 0, "the undeclared path is ABSENT from the amendment commit tree");

  // RF-4, the other half: the undeclared path's STAGED index content is unchanged after the
  // amendment — still staged, same blob, neither modified, committed, nor lost. The commit was
  // built from a temporary index, so the real one was never read for it and never mutated.
  assert.match(git(["diff", "--cached", "--name-only"]), /src\/unrelated\.ts/, "the undeclared path is still staged in the shared index");
  assert.equal(git(["cat-file", "blob", `:${UNDECLARED}`]), STAGED, "with its original staged blob intact — the real index was never touched");
  assert.equal(getReview(REVIEW)?.candidateSha, amended, "the candidate advanced to the amendment commit");
  assert.notEqual(amended, superseded, "off the superseded candidate");
});

// ─── AC4 / AC5: what the move re-opens, and what it does NOT ─────────────────

test("integ FG-682: the amendment re-opens verification and a BOUNDED recheck at the amended sha, and full discovery does NOT re-run", async () => {
  const h = harness();
  const superseded = await driveToShippingBoundary(h);

  const confirmedSha = getReview(REVIEW)?.contractConfirmedSha as string;
  const discoveryBefore = getReview(REVIEW)?.stageEvidence?.discovery?.sha;
  const redDispatchesBefore = h.dispatches("red-backend").length;
  const rechecksBefore = h.dispatches("review-rechecker").length;

  writeFileSync(
    join(repo, DOC_AMEND_PATH),
    `# Schema contract\n\nCorrected: all three lanes cross one resolver. ${AMEND_MARKER}.\n`,
  );
  const outcome = await runDocsAmendment(REVIEW, [DOC_AMEND_PATH], "correct the falsified receipt prose", h.deps, {
    discoveredBy: "orchestrator",
  });
  assert.equal(outcome.status, "amended", JSON.stringify(outcome));
  const amended = getReview(REVIEW)?.candidateSha as string;

  // AC4: the verification recorded at the SUPERSEDED sha does not carry onto the amended one.
  assert.equal(
    getReview(REVIEW)?.stageEvidence?.verified_final?.sha,
    superseded,
    "final verification is still bound to the SUPERSEDED sha the moment the amendment lands",
  );
  assert.equal(pending().kind, "verify_final", "so the amended candidate re-opens deterministic verification — CI is required there");

  // AC5, the frozen half: discovery is anchored to contractConfirmedSha, which the amendment never
  // wrote, so full discovery over the implementation does NOT re-run.
  assert.equal(getReview(REVIEW)?.contractConfirmedSha, confirmedSha, "contractConfirmedSha is untouched by the amendment");
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery?.sha, discoveryBefore, "the discovery record stays bound to the confirmed sha");
  assert.notEqual(pending().kind, "discover", "discovery does not re-open");

  // Drive the re-opened stages. verify_final runs FIRST, and `verify` is asked about the AMENDED
  // sha — the concrete AC4 evidence that CI runs at the new candidate, not merely that the old
  // evidence was invalidated.
  assert.ok(!h.verifyCalls.includes(amended), "verify has not yet been asked about the amended sha");
  await parkAt(h.deps, "recheck");
  assert.ok(h.verifyCalls.includes(amended), "AC4: deterministic verification RAN at the amended sha");
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_final?.sha, amended, "and recorded final verification there");

  // AC5, the bounded half: the recheck's delta is cut from the amendment's OWN range
  // (superseded..amended), so it covers ONLY the amended prose — not the earlier fix and docs
  // commits, which are already-settled remediation. Run the recheck and read the delta it handed
  // the rechecker off the REAL prompt.
  const recheck = await runNextStage(REVIEW, h.deps);
  assert.equal(recheck.status, "advanced", recheck.message);
  const rechecksAfter = h.dispatches("review-rechecker");
  assert.ok(rechecksAfter.length > rechecksBefore, "a recheck was dispatched at the amended candidate");
  const prompt = rechecksAfter.at(-1)?.task ?? "";
  assert.match(prompt, new RegExp(`final candidate ${amended}`), "the rechecker is told which candidate it is about");
  assert.ok(prompt.includes(AMEND_MARKER), "AC5: the bounded delta CONTAINS the amended prose");
  assert.ok(!prompt.includes(FIX_MARKER), "AC5: and EXCLUDES the earlier fix commit — settled remediation is not re-reviewed");
  assert.ok(!prompt.includes(DOCS_MARKER), "AC5: and EXCLUDES the earlier docs commit");

  // AC5, the anti-tautology: the DEFAULT (non-amendment) recheck base is confirmedSha..candidate,
  // which WOULD have spanned the fix and docs commits. The narrowing is what excludes them.
  const wouldHaveSpanned = git(["diff", "--name-only", `${confirmedSha}..${amended}`]);
  assert.match(wouldHaveSpanned, /src\/resolver\.ts/, "the confirmedSha..amended range does span the fix commit");
  assert.match(wouldHaveSpanned, /docs\/DEV-NOTES\.md/, "and the docs commit — so the bounded base is doing real work");

  // AC5, the frozen half again, mechanically: no second discovery pass ran across the whole amend.
  assert.equal(h.dispatches("red-backend").length, redDispatchesBefore, "no red-backend was re-dispatched — full discovery did not re-run");
});

// ─── AC7: tip_equality and docs_closeout pass on their own terms, no override ───

test("integ FG-682: the amended review settles with tip_equality and docs_closeout GREEN on their own terms — no override", async () => {
  const h = harness();
  await driveToShippingBoundary(h);

  writeFileSync(
    join(repo, DOC_AMEND_PATH),
    `# Schema contract\n\nCorrected: one shared resolver for all three lanes. ${AMEND_MARKER}.\n`,
  );
  const outcome = await runDocsAmendment(REVIEW, [DOC_AMEND_PATH], "correct the falsified receipt prose", h.deps, {
    discoveredBy: "reviewer",
  });
  assert.equal(outcome.status, "amended", JSON.stringify(outcome));
  const amended = getReview(REVIEW)?.candidateSha as string;

  // Drive the re-opened stages to the shipping review and run it. Nothing here overrides a check:
  // the amended candidate is treated as PUBLISHED (trusted tip) and the correction is IN it, so
  // the two checks FG-678 had to override (BD-13) pass on their own terms.
  await parkAt(h.deps, "shipping_review");
  const shipped = await runNextStage(REVIEW, h.deps);
  assert.equal(shipped.status, "advanced", `the shipping review should pass at the amended sha: ${shipped.message}`);
  assert.equal(getReview(REVIEW)?.state, "settled", "the review settled at the amended candidate");

  const assessment = shipped.shipping;
  assert.ok(assessment !== undefined, "the shipping outcome carries its assessment");
  assert.equal(assessment.ok, true, "every shipping check is green — the review ships without any override");
  const tip = assessment.checks.find((c) => c.id === "tip_equality");
  const docs = assessment.checks.find((c) => c.id === "docs_closeout");
  assert.equal(tip?.ok, true, `AC7: tip_equality passes on its own terms — ${tip?.detail}`);
  assert.equal(docs?.ok, true, `AC7: docs_closeout passes on its own terms — ${docs?.detail}`);
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping?.sha, amended, "and the shipping record binds to the amended candidate");
});

// ─── AC7, the contrast: the amendment flips exactly the two checks FG-678 overrode ───

test("integ FG-682: the amendment turns the FG-678 six-of-eight shipping shape into eight green — the two checks it flips are exactly the overridden ones", () => {
  // A focused, deterministic contrast on assessShippingReview itself. The `before` is the FG-678
  // state BD-13 recorded: the correction landed OUTSIDE the pinned candidate, so the reviewed tip
  // is not the branch tip (tip_equality local_only) and the docs ARE stale at the candidate
  // (docs_closeout with gaps). Six of eight are green; the operator overrode the two. The `after`
  // is the same review once the amendment brought the correction INTO the candidate.
  const shared = {
    candidateSha: "amended0000000000000000000000000000000000",
    findings: [],
    verification: { ok: true, sha: "amended0000000000000000000000000000000000", executedRequiredChecks: true, detail: "green CI" },
    acceptance: [
      {
        ref: "FG-682 AC 1",
        verdict: "met" as const,
        evidence: { kind: "regression_test" as const, test_name: AC_TEST, runner_output: EXECUTED },
      },
    ],
    identity: { continuous: true, detail: "identity chain continuous" },
    contractCoverage: {
      confirmedSha: "confirmed000000000000000000000000000000000",
      finalSha: "amended0000000000000000000000000000000000",
      postConfirmationPaths: [DOC_AMEND_PATH],
      deltaReviewed: true,
    },
  } satisfies Partial<ShippingInput>;

  // BEFORE — the correction committed out of band; the pinned candidate is stale and behind the tip.
  const before = assessShippingReview({
    ...shared,
    tipTrust: { kind: "local_only", reviewedSha: shared.candidateSha, detail: "the reviewed candidate is not the branch tip" },
    docsCloseout: { assessed: true, gaps: ["docs/SCHEMA-CONTRACT.md asserts a lane topology the batch falsified"] },
  } as ShippingInput);

  const overridden = new Set(["tip_equality", "docs_closeout"]);
  const failedBefore = before.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual([...failedBefore].sort(), [...overridden].sort(), "before: EXACTLY the two checks FG-678 overrode fail");
  assert.equal(before.checks.filter((c) => c.ok).length, 6, "and the other six are green — the BD-13 shape");
  assert.equal(before.ok, false, "so the review cannot ship WITHOUT an override");

  // AFTER — the amendment brought the correction into the candidate and it is published.
  const after = assessShippingReview({
    ...shared,
    tipTrust: { kind: "trusted", reviewedSha: shared.candidateSha, remoteSha: shared.candidateSha },
    docsCloseout: { assessed: true, gaps: [] },
  } as ShippingInput);

  assert.equal(after.ok, true, "after: the review ships with no override");
  assert.equal(after.checks.find((c) => c.id === "tip_equality")?.ok, true, "tip_equality is green on its own terms");
  assert.equal(after.checks.find((c) => c.id === "docs_closeout")?.ok, true, "docs_closeout is green on its own terms");
});

// ─── the done condition, asserted mechanically ──────────────────────────────

test("integ FG-682: this suite moves the candidate ONLY through the coordinator — no hand re-anchor", () => {
  // The ticket's non-negotiable: a late-docs amendment is not a re-anchor, and this file proves it
  // WITHOUT reaching past the coordinator to move the candidate or write a stage record itself.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(source, /updateReview\(/, "no arm may move the candidate itself");
  assert.doesNotMatch(source, /advanceCandidate\(/, "no arm may advance the candidate itself");
  assert.doesNotMatch(source, /recordStageEvidence\(/, "no arm may hand-write a stage record");
  assert.doesNotMatch(source, /recordDocsAmendment\(/, "no arm may forge an amendment ledger record");
});
