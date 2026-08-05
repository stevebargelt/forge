// FG-655: the DOCS stage's candidate, against a REAL repository and the REAL ledger.
//
// THE DEFECT THIS TIER EXISTS FOR. Stage 6 dispatched the documentation-maintainer and then
// did `const head = await deps.headSha(); advanceCandidate(reviewId, head)` — the bare-HEAD
// read the fix cycle's own comment forbids in as many words, and which FG-649 removed from
// Stage 5 while leaving Stage 6 on it. When the docs agent did not commit (observed live nine
// or more times, across three distinct docs agents) the stage reported "docs reconciliation
// complete; candidate unchanged at <sha>" and ADVANCED. True about HEAD, false about the
// work, which sat as modified files in the workspace. Final verification then silently
// degraded to a dirty-tree local run, and committing the stranded edits by hand moved HEAD
// while the ledger candidate stayed put — so the next stage refused
// `candidate_not_checked_out` and the review could only proceed by DISCARDING the docs work.
// One stranded occurrence shipped documentation asserting the OPPOSITE of shipped behaviour;
// one stranded fragment was lost outright.
//
// WHY IT NEEDS THIS TIER. review-run.test.ts binds `headSha` to a closure variable, so a
// stubbed docs agent that assigns `head = "afterdocs3"` simulates a sha the real path could
// never have observed. That suite cannot distinguish this bug from its fix. So this file
// binds the seams to a REAL git repository: mkdtemp + git init + real commits, the real
// store, the real `buildCoordinatorDeps`, and only the container dispatch stubbed — with the
// stubbed "docs container" WRITING FILES INTO THE REPO, declaring them in `docs_updated`, and
// NOT committing them. That is the live shape, and it is only meaningful against a real tree.
//
// Two deps are stubbed beyond the container dispatch, deliberately and narrowly: `verify`
// (Stages 1/7 would otherwise run the host verification machinery against a two-file fixture)
// and `shippingInput` (it fetches a remote tip that does not exist here). The AC4 arms at the
// bottom deliberately use the REAL ones, because the guard they assert is what runs BEFORE
// either of those does any work.
//
// NOTE ON THE DONE CONDITION: no arm below re-anchors anything by hand, and the last test
// asserts that mechanically.

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
import { getTask, insertTask, markTaskComplete, markTaskFailed, markTaskRunning } from "../store/tasks.js";
import { getReview, pendingDocsDispatch, type Review } from "../store/reviews.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run, Task } from "../types/index.js";

const RUN_ID = "run-fg655";
const REVIEW = "review-fg655";
const TICKET = "FG-655";

const RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "fg655",
  status: "active",
  createdAt: "2026-08-05T00:00:00Z",
  reviewMode: "evidence_led",
};

const CONTRACT = {
  threat_model: "an operator-trusted candidate the coordinator now authors DOCS commits in",
  protected_invariants: ["the candidate is never adopted from a bare HEAD read, in any stage"],
  acceptance_refs: ["FG-655 AC 1"],
  risk_lenses: ["backend"],
  non_goals: ["FG-682's late-docs amendment path"],
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
const subjectAt = (sha: string): string => git(["log", "-1", "--format=%s", sha]).trim();
const pathsAt = (sha: string): string[] =>
  git(["show", "--name-only", "--format=", sha]).split("\n").filter((l) => l.trim() !== "").sort();

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);

  repo = mkdtempSync(join(tmpdir(), "fg655-repo-"));
  git(["init", "-q", "-b", "main", "."]);
  // Identity is LOCAL: src/test-setup.ts neutralizes the global git config, so a commit that
  // borrowed the operator's identity would fail on CI and this fixture would prove nothing
  // about the commit forge itself authors.
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"candidate","private":true}\n`);
  writeFileSync(join(repo, "src", "reconcile.ts"), "export function reconcile() {\n  write(rowA);\n}\n");
  writeFileSync(join(repo, "docs", "concepts.md"), "# concepts\n\nThe docs stage reads HEAD.\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed the candidate"]);
  baseSha = head();
  appendFileSync(join(repo, "src", "reconcile.ts"), "\nexport function reconcileBoth() {\n  write(rowB);\n}\n");
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

/** What the stubbed docs container does to the real worktree, and what it DECLARES. The two
 *  are independent on purpose: every FG-655 shape is a disagreement between them. */
type DocsBehaviour = () => { docs_updated?: unknown; [k: string]: unknown };

type Harness = {
  deps: CoordinatorDeps;
  /** The REAL wiring, verify and shippingInput included — for the AC4 arms. */
  wiring: CoordinatorDeps;
  calls: InvokeArgs[];
  dispatches: (role: string) => InvokeArgs[];
};

/** The default "docs container": it EDITS THE REAL WORKTREE, DECLARES what it edited, and
 *  does NOT commit — the live shape, and the one the pre-FG-655 coordinator could not see. */
function declaringDocsAgent(): { docs_updated: string[] } {
  appendFileSync(join(repo, "docs", "concepts.md"), "\nThe docs stage commits what the agent declares.\n");
  writeFileSync(join(repo, "docs", "review-docs-stage.md"), "# the docs stage\n");
  return { docs_updated: ["docs/concepts.md", "docs/review-docs-stage.md"] };
}

/** A docs agent that changed nothing and says so — the legitimate no-op (AC2). */
function noopDocsAgent(): { docs_updated: string[] } {
  return { docs_updated: [] };
}

function harness(
  over: { docs?: DocsBehaviour; deps?: Partial<CoordinatorDeps>; failDocs?: boolean; killDocsMidDispatch?: boolean } = {},
): Harness {
  const calls: InvokeArgs[] = [];
  const docs = over.docs ?? declaringDocsAgent;

  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    calls.push(args);
    const taskId = `task-${args.agentRole}-${calls.length}`;
    // The REAL invoke mints the identity and surfaces it through this hook before any
    // container write, and review-wiring's dispatchDocs binds there. The stub honours the
    // same contract — the durable binding is what the re-entry short-circuit reads, so a
    // fixture that skipped it would be testing a path production does not have.
    args.onTaskMinted?.({ runId: RUN_ID, taskId });
    // And the task ROW is what `docsDelivery` reads the declaration off, so the stub writes
    // one exactly as invoke does rather than handing the result back out of band.
    const task: Task = {
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
    };
    insertTask(task);

    switch (args.agentRole) {
      case "red-backend": {
        const result = { outcome: "pass", findings: [] };
        markTaskComplete(taskId, result);
        return { runId: RUN_ID, taskId, status: "complete", result };
      }

      case "documentation-maintainer": {
        // A CLI killed between the mint and the container's return. The task row is left
        // `running` and nothing reaps it, which is the durable state RF-2 is about.
        if (over.killDocsMidDispatch === true) {
          markTaskRunning(taskId);
          throw new Error("the CLI was killed mid-dispatch");
        }
        const result = docs();
        if (over.failDocs === true) {
          markTaskFailed(taskId, "the maintainer container crashed", result);
          return { runId: RUN_ID, taskId, status: "failed", error: "the maintainer container crashed" };
        }
        markTaskComplete(taskId, result);
        return { runId: RUN_ID, taskId, status: "complete", result };
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
    shippingInput: ({ review, candidateSha }: { review: Review; candidateSha: string }) => ({
      verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
      acceptance: [],
      tipTrust: { kind: "trusted" as const, reviewedSha: candidateSha, remoteSha: candidateSha },
      identity: { continuous: head() === candidateSha, detail: `head ${head()}` },
      contractCoverage: {
        confirmedSha: review.contractConfirmedSha ?? candidateSha,
        finalSha: candidateSha,
        postConfirmationPaths: [],
        deltaReviewed: true,
      },
      docsCloseout: { assessed: true, gaps: [], detail: "the ticket requires no doc update" },
    }),
    ...(over.deps ?? {}),
  };

  return { deps, wiring, calls, dispatches: (role) => calls.filter((c) => c.agentRole === role) };
}

/** The next transition as a FRESH process would read it — from the persisted rows only. */
function pending() {
  return nextTransition({
    review: getReview(REVIEW) as Review,
    findings: [],
    batches: [],
  });
}

/** Drive real stages until the PERSISTED next transition is `target`. */
async function parkAt(deps: CoordinatorDeps, target: TransitionKind, max = 12): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (pending().kind === target) return;
    const outcome = await runNextStage(REVIEW, deps);
    assert.notEqual(outcome.status, "refused", `parking at ${target}: ${outcome.transition.kind} — ${outcome.message}`);
  }
  assert.fail(`never reached ${target} (stuck at ${pending().kind}: ${pending().reason})`);
}

function docsRecord() {
  return getReview(REVIEW)?.stageEvidence?.docs;
}

function docsCommitMeta() {
  const rec = docsRecord();
  assert.ok(rec !== undefined, "no docs stage record");
  return rec.meta?.["docsCommit"] as {
    kind: string;
    sha: string;
    committedPaths: string[];
    recognized: boolean;
    declaredNotMoved: string[];
  };
}

/** Every refusal's shared contract: NOTHING recorded, the candidate unmoved, the binding
 *  still live so re-entry dispatches no second docs agent, and a re-enterable stage. */
function assertRefusedCleanly(h: Harness, at: string): void {
  assert.equal(docsRecord(), undefined, "a refused stage records no evidence");
  assert.equal(getReview(REVIEW)?.candidateSha, at, "and moves the candidate nowhere");
  assert.notEqual(pendingDocsDispatch(REVIEW), undefined, "the binding is NOT retired by a refusal");
  assert.equal(pending().kind, "docs", "Stage 6 stays open — `forge review continue` re-enters it");
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "and no second docs agent was started");
}

// ─── AC1: the non-committing agent ──────────────────────────────────────────

test("integ FG-655 / AC1: a docs agent that does not commit still lands its edits in the candidate, automatically", async () => {
  // The whole FG-655 done condition. RED baseline: restore
  // `const head = await deps.headSha(); advanceCandidate(reviewId, head)` in runDocs and
  // every assertion from `postDocs !== preDocs` down fails — the agent's work stays
  // uncommitted, the candidate stays put, and the stage still says it completed.
  const h = harness();
  await parkAt(h.deps, "docs");

  const preDocs = getReview(REVIEW)?.candidateSha as string;
  assert.equal(preDocs, entrySha, "the review is anchored to the candidate that is checked out");
  assert.equal(porcelain(), "", "and the tree is clean before the docs agent runs");

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);

  const postDocs = head();
  assert.notEqual(postDocs, preDocs, "the coordinator itself created a commit for the docs cycle");
  assert.equal(getReview(REVIEW)?.candidateSha, postDocs, "reviews.candidate_sha IS `git rev-parse HEAD`");
  assert.equal(porcelain(), "", "the agent's work is committed — nothing is left stranded behind the stage");

  // THE RECORD'S SHA IS THE POST-ADVANCE ONE. A pre-docs record would leave Stage 6
  // incomplete at the new candidate and the review would loop on its own docs stage.
  assert.equal(docsRecord()?.sha, postDocs, "the docs record binds to the sha the stage PRODUCED");
  assert.notEqual(pending().kind, "docs", "so the review walks on rather than re-entering Stage 6");

  // The commit is the coordinator's own, on top of the pre-docs candidate, naming the cycle.
  const bindingId = docsRecord()?.meta?.["docsDispatchId"] as string;
  assert.match(bindingId, /^docs-dispatch-/);
  assert.equal(subjectAt("HEAD"), `docs(review): docs cycle ${bindingId}`);
  assert.doesNotMatch(
    subjectAt("HEAD"),
    /FG-655/,
    "the subject must not reference the ticket — resolveReviewBase infers a LATER review's base from it",
  );
  assert.equal(git(["rev-parse", "HEAD^"]).trim(), preDocs, "the post-docs candidate is a child of the pre-docs one");

  // ONLY THE DECLARED PATHS, read off the COMMIT rather than off the index.
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md", "docs/review-docs-stage.md"]);
  const meta = docsCommitMeta();
  assert.equal(meta.kind, "committed");
  assert.equal(meta.sha, postDocs);
  assert.equal(meta.recognized, false, "authored on this pass, not recovered");
  assert.deepEqual([...meta.committedPaths].sort(), ["docs/concepts.md", "docs/review-docs-stage.md"]);
  assert.deepEqual(docsRecord()?.meta?.["declaredFiles"], ["docs/concepts.md", "docs/review-docs-stage.md"]);

  assert.equal(h.dispatches("documentation-maintainer").length, 1);
  assert.equal(pendingDocsDispatch(REVIEW), undefined, "the spent binding is retired once the stage completes");
});

// ─── AC2: the genuine no-op, and its distinguishable stranded twin ───────────

test("integ FG-655 / AC2: a docs agent that genuinely changed nothing records candidate-unchanged AND a clean tree", async () => {
  const h = harness({ docs: noopDocsAgent });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);
  assert.match(out.message, /the docs agent changed nothing, the tree is clean/);
  assert.equal(getReview(REVIEW)?.candidateSha, at, "the candidate does not move");
  assert.equal(head(), at, "and nothing was committed");
  assert.equal(porcelain(), "", "AC2's second half: a legitimate no-op leaves a CLEAN tree");
  assert.equal(docsRecord()?.sha, at);
  assert.equal(docsCommitMeta().kind, "no_change");
  assert.notEqual(pending().kind, "docs", "the stage completed");
});

test("integ FG-655 / AC2: a docs agent that declares nothing but LEAVES the tree dirty refuses — the stranded shape is distinguishable", async () => {
  // This is the FG-655 failure itself, and the point of AC2 is that it must not look like the
  // legitimate no-op above. Same declaration (`docs_updated: []`), opposite outcome, because
  // the tree is what adjudicates the claim.
  //
  // RED baseline: the pre-FG-655 stage ADVANCED here with the message "candidate unchanged at
  // <sha>" — a true statement about HEAD and a false one about the work.
  const h = harness({
    docs: () => {
      appendFileSync(join(repo, "docs", "concepts.md"), "\nthe round that nobody committed\n");
      writeFileSync(join(repo, "docs", "protocol-drift.md"), "# the fragment that was lost\n");
      return { docs_updated: [] };
    },
  });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /docs_cycle_tree_dirty_outside_declared_scope/);
  assert.match(out.message, /docs\/concepts\.md/, "the specific undeclared paths are NAMED");
  assert.match(out.message, /docs\/protocol-drift\.md/);
  assert.match(out.message, /declared: nothing/);
  assert.match(out.message, /forge review continue/, "and the refusal names a concrete way forward");
  assert.equal(head(), at, "nothing was committed");
  assert.equal(staged(), "", "and forge staged NOTHING");
  assert.match(porcelain(), /protocol-drift\.md/, "the work is left exactly where the agent put it, not discarded");
  assertRefusedCleanly(h, at);

  // The two AC2 outcomes are DIFFERENT, which is the whole acceptance item.
  assert.notEqual(out.status, "advanced");
});

// ─── the named refusals ─────────────────────────────────────────────────────

test("integ FG-655: an undeclared dirty path beside a declared one is NAMED, never swept into the commit", async () => {
  const h = harness({
    docs: () => {
      appendFileSync(join(repo, "docs", "concepts.md"), "\ndeclared\n");
      // The concurrent writer sharing this checkout. Nothing declares it.
      writeFileSync(join(repo, "src", "sneaky.ts"), "// nobody declared this\n");
      return { docs_updated: ["docs/concepts.md"] };
    },
  });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /docs_cycle_tree_dirty_outside_declared_scope/);
  assert.match(out.message, /src\/sneaky\.ts/);
  assert.doesNotMatch(out.message, /^[^]*committed[^]*docs\/concepts\.md/m);
  assert.equal(staged(), "", "an undeclared change is never staged, let alone committed");
  assertRefusedCleanly(h, at);
});

test("integ FG-655: a declaration that reaches BEYOND the tree commits what moved and NAMES what did not", async () => {
  const h = harness({
    docs: () => {
      appendFileSync(join(repo, "docs", "concepts.md"), "\nonly this one actually moved\n");
      return { docs_updated: ["docs/concepts.md", "docs/never-written.md"] };
    },
  });
  await parkAt(h.deps, "docs");
  const preDocs = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "advanced", out.message);
  assert.match(out.message, /docs\/never-written\.md/, "the unsupported half of the claim is said out loud");
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md"], "committed ⊆ declared still holds");
  assert.deepEqual(docsCommitMeta().declaredNotMoved, ["docs/never-written.md"]);
  assert.equal(getReview(REVIEW)?.candidateSha, head());
  assert.notEqual(head(), preDocs);
});

test("integ FG-655 / RF-1: a declaration against a wholly CLEAN tree refuses by name, RETIRES the spent dispatch, and the review still makes progress", async () => {
  // THE WEDGE THIS ARM USED TO BE. The refusal retired nothing and the declaration is read
  // off the IMMUTABLE task record every pass, so every subsequent `forge review continue`
  // reproduced this refusal verbatim — forever. Both remedies it printed were unreachable:
  // the branch is only entered with HEAD already at the candidate and the tree clean, so
  // `git reset --soft <candidate>` is a no-op, and no verb can edit a task result.
  //
  // RED baseline: drop the `treeCleanAtCandidate` retire in runDocs and the dispatch count
  // below stays at 1 while the second outcome is the identical refusal.
  const h = harness({ docs: () => ({ docs_updated: ["docs/concepts.md"] }) });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /docs_cycle_declared_changes_absent/);
  assert.doesNotMatch(out.message, /git reset --soft/, "a remedy that is a no-op in the branch that prints it is worse than none");
  assert.match(out.message, /RETIRED/, "the refusal says what it did instead");
  assert.equal(head(), at, "nothing was committed");
  assert.equal(porcelain(), "", "and the tree was clean throughout — nothing is stranded by the retire");
  assert.equal(docsRecord(), undefined, "a refused stage records no evidence");
  assert.equal(getReview(REVIEW)?.candidateSha, at, "and moves the candidate nowhere");
  assert.equal(pending().kind, "docs", "Stage 6 stays open — `forge review continue` re-enters it");
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "the refusing pass started exactly one agent");
  assert.equal(
    pendingDocsDispatch(REVIEW),
    undefined,
    "the SPENT binding is retired: a clean tree at the candidate proves that delivery left nothing behind",
  );

  // AND THE FOLLOWING `continue` MAKES PROGRESS. Same misbehaving agent, driven through the
  // real sequence again: it runs exactly ONE more docs agent rather than reproducing the
  // identical refusal against a binding no operator action can clear.
  const second = await runNextStage(REVIEW, h.deps);
  assert.equal(second.status, "refused");
  assert.equal(h.dispatches("documentation-maintainer").length, 2, "one MORE docs agent — the state moved");

  // And a docs agent that behaves closes the stage, with no operator surgery anywhere.
  const good = harness();
  const third = await runNextStage(REVIEW, good.deps);
  assert.equal(third.status, "advanced", third.message);
  assert.equal(good.dispatches("documentation-maintainer").length, 1);
  assert.notEqual(head(), at, "the coordinator authored the docs commit");
  assert.equal(getReview(REVIEW)?.candidateSha, head());
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md", "docs/review-docs-stage.md"]);
  assert.equal(porcelain(), "");
  assert.equal(pendingDocsDispatch(REVIEW), undefined);
  assert.notEqual(pending().kind, "docs", "the review walks on");
});

test("integ FG-655 / RF-2: a docs task still RUNNING is not a dead delivery — re-entry refuses in flight and starts NO second agent", async () => {
  // A clean tree proves a DEAD delivery left nothing behind. It cannot tell a dead agent from
  // a LIVE one that has not written yet — and a `running` row is durable and unreaped, so a
  // CLI killed mid-dispatch leaves one behind permanently.
  //
  // RED baseline: classify a non-terminal task as `unreadable` again and the clean-tree probe
  // below retires the binding and dispatches a SECOND documentation-maintainer into a checkout
  // the first container may still be writing.
  const h = harness({ docs: noopDocsAgent, killDocsMidDispatch: true });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  await assert.rejects(() => runNextStage(REVIEW, h.deps), /killed mid-dispatch/);
  const binding = pendingDocsDispatch(REVIEW);
  assert.notEqual(binding, undefined, "the dispatch is bound before anything can start a container");
  assert.equal(getTask(binding?.taskId as string)?.status, "running", "and its task row stays `running` — nothing reaps it");
  assert.equal(porcelain(), "", "the tree is CLEAN, which is exactly what used to authorise retiring it");

  const resumed = harness({ docs: noopDocsAgent });
  const out = await runNextStage(REVIEW, resumed.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /docs_dispatch_in_flight/);
  assert.match(out.message, /forge cancel/, "the remedy names how the operator confirms or clears it");
  assert.equal(resumed.dispatches("documentation-maintainer").length, 0, "no second agent over a live one");
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "exactly ONE docs dispatch across the re-entry");
  assert.equal(pendingDocsDispatch(REVIEW)?.id, binding?.id, "and the live binding was NOT retired");
  assert.equal(docsRecord(), undefined);
  assert.equal(getReview(REVIEW)?.candidateSha, at);
  assert.equal(head(), at);
  assert.equal(pending().kind, "docs");

  // Once the operator clears it — `forge cancel <task>` marks it failed — it becomes a DEAD
  // delivery, and the clean-tree arm retires it and runs ONE more docs agent. The in-flight
  // refusal is a stop, not a gravestone.
  markTaskFailed(binding?.taskId as string, "forge cancel: the container was gone");
  const after = await runNextStage(REVIEW, resumed.deps);
  assert.equal(after.status, "advanced", after.message);
  assert.equal(resumed.dispatches("documentation-maintainer").length, 1, "exactly one more, and only after the operator cleared it");
  assert.equal(pendingDocsDispatch(REVIEW), undefined);
});

test("integ FG-655 / RF-3: a docs result that OMITS docs_updated is a contract violation, never a no-op declaration", async () => {
  // `docs_updated: []` is the agent's positive claim that it changed nothing (AC2 above, which
  // ADVANCES). An absent field is nobody being able to tell what the agent claims — the
  // documentation-maintainer contract requires it — so it fails closed by name instead.
  const h = harness({ docs: () => ({ status: "complete" }) });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /no docs_updated/);
  assert.match(out.message, /requires the field/, "the refusal says WHICH contract was violated");
  assert.equal(head(), at, "nothing is committed against a declaration nobody can read");
  assertRefusedCleanly(h, at);

  // And it terminates: the delivery is unreadable over a clean tree, so the next pass retires
  // the dead dispatch and runs ONE more docs agent, exactly as a crashed container does.
  const resumed = harness();
  const after = await runNextStage(REVIEW, resumed.deps);
  assert.equal(after.status, "advanced", after.message);
  assert.equal(resumed.dispatches("documentation-maintainer").length, 1);
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md", "docs/review-docs-stage.md"]);
});

test("integ FG-655 / AC2: a MALFORMED docs_updated member is a contract violation, never an empty declaration", async () => {
  // The ABSENT and NON-ARRAY cases already fail closed. A malformed MEMBER was silently
  // filtered away instead, so `docs_updated: [42]` became `[]` — the positive no-op claim the
  // arm above ADVANCES on — and a contract violation reached the clean-tree no_change path as
  // a legitimate no-op. RED baseline: restore `raw.filter((p) => typeof p === "string")` in
  // review-wiring's `docsDelivery` and this arm advances instead of refusing.
  const h = harness({ docs: () => ({ docs_updated: [42] }) });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /non-string member/);
  assert.match(out.message, /\[0\]=42/, "the refusal names the member nobody can read");
  assert.match(out.message, /requires a list of paths/, "and WHICH contract was violated");
  assert.equal(head(), at, "nothing is committed against a declaration nobody can read");
  assertRefusedCleanly(h, at);

  // And it terminates on the same clean-tree evidence every unreadable delivery does.
  const resumed = harness();
  const after = await runNextStage(REVIEW, resumed.deps);
  assert.equal(after.status, "advanced", after.message);
  assert.equal(resumed.dispatches("documentation-maintainer").length, 1);
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md", "docs/review-docs-stage.md"]);
});

test("integ FG-655: a docs agent that COMMITS its own work refuses candidate_not_checked_out and its commit is left alone", async () => {
  // The prompt tells the agent not to commit, but one that does anyway moves HEAD off the
  // candidate. Adopting it would adopt a sha the coordinator did not author — and one that may
  // carry changes nothing declared. FG-649 already pinned this case under this name for the
  // fix stage; the docs stage reuses it rather than inventing a second vocabulary.
  const h = harness({
    docs: () => {
      appendFileSync(join(repo, "docs", "concepts.md"), "\nthe agent committed this itself\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "the docs agent committed its own work"]);
      return { docs_updated: ["docs/concepts.md"] };
    },
  });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /candidate_not_checked_out/);
  assert.doesNotMatch(out.message, /docs_cycle_declared_changes_absent/, "the real reason, not the clean-tree one");
  assert.match(out.message, /git reset --soft/, "the remedy names the soft reset that returns the edits to the worktree");
  assert.equal(subjectAt("HEAD"), "the docs agent committed its own work", "its commit is left exactly alone");
  assertRefusedCleanly(h, at);
});

test("integ FG-655: a docs dispatch that FAILED refuses, records nothing, and re-entry dispatches no second agent", async () => {
  const h = harness({ docs: noopDocsAgent, failDocs: true });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;

  const out = await runNextStage(REVIEW, h.deps);
  assert.equal(out.status, "refused");
  assert.match(out.message, /docs reconciliation failed/);
  assertRefusedCleanly(h, at);

  // The delivery is UNREADABLE (the task is `failed`, not a terminal successful delivery).
  // The tree is clean at the candidate, which is provable evidence the dead delivery left
  // nothing behind — and THAT is what authorises retiring the spent binding and running ONE
  // more agent, with no new operator verb.
  assert.equal(porcelain(), "", "the crashed container wrote nothing here");
  const resumed = await runNextStage(REVIEW, harness({ docs: noopDocsAgent }).deps);
  assert.equal(resumed.status, "advanced", resumed.message);
  assert.equal(getReview(REVIEW)?.candidateSha, at);
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "the FIRST harness still saw exactly one");
});

test("integ FG-655: a dead delivery over a DIRTY tree refuses rather than retiring the binding on a guess", async () => {
  // A crashed container that left edits behind. The clean-tree proof is unavailable, so the
  // binding stays live: retiring it here would authorise a second agent on top of a tree whose
  // contents nobody can attribute.
  const h = harness({
    docs: () => {
      writeFileSync(join(repo, "docs", "half-written.md"), "# the container died mid-write\n");
      return { docs_updated: [] };
    },
    failDocs: true,
  });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;
  await runNextStage(REVIEW, h.deps);

  const second = await runNextStage(REVIEW, h.deps);
  assert.equal(second.status, "refused");
  assert.match(second.message, /docs_cycle_tree_dirty_outside_declared_scope/);
  assert.match(second.message, /docs\/half-written\.md/);
  assert.match(second.message, /could not be read/, "and it says the delivery is unreadable, not merely dirty");
  assert.match(second.message, /git stash|git reset --soft/, "with a concrete way back to a clean candidate");
  assertRefusedCleanly(h, at);
});

// ─── resumability: the two crash windows ────────────────────────────────────

test("integ FG-655: a crash BEFORE the commit re-enters, commits, and starts NO second docs agent", async () => {
  const h = harness();
  await parkAt(h.deps, "docs");
  const preDocs = getReview(REVIEW)?.candidateSha as string;

  const crashing: CoordinatorDeps = {
    ...h.deps,
    commitDocsCycle: () => {
      throw new Error("the orchestrator died between the delivery and the commit");
    },
  };
  await assert.rejects(() => runNextStage(REVIEW, crashing), /died between the delivery and the commit/);

  assert.equal(h.dispatches("documentation-maintainer").length, 1);
  assert.equal(docsRecord(), undefined, "a stage records itself only on success");
  assert.equal(getReview(REVIEW)?.candidateSha, preDocs);
  assert.equal(head(), preDocs, "nothing was committed");
  assert.notEqual(porcelain(), "", "the agent's edits are still sitting in the worktree");
  assert.equal(pending().kind, "docs");

  // A fresh process picks it up — and dispatches nothing, because the binding is durable.
  const resumed = await runNextStage(REVIEW, harness().deps);
  assert.equal(resumed.status, "advanced", resumed.message);
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "NO second docs container for this binding");
  assert.equal(docsRecord()?.meta?.["resumedFromBinding"], true);
  assert.equal(getReview(REVIEW)?.candidateSha, head());
  assert.notEqual(head(), preDocs);
  assert.equal(porcelain(), "");
  assert.deepEqual(pathsAt("HEAD"), ["docs/concepts.md", "docs/review-docs-stage.md"]);
});

test("integ FG-655: a crash between the COMMIT and the candidate advance RECOVERS the coordinator's own commit", async () => {
  // The git commit is irreversible; the ledger writes that record it are separate transactions
  // after it. Without the recognition arm this window is terminal in both directions — exactly
  // the FG-649 stuck loop, one stage over.
  const h = harness();
  await parkAt(h.deps, "docs");
  const preDocs = getReview(REVIEW)?.candidateSha as string;

  const crashAfterCommit: CoordinatorDeps = {
    ...h.deps,
    commitDocsCycle: async (ctx) => {
      await h.deps.commitDocsCycle(ctx); // the REAL commit lands
      throw new Error("the coordinator died after the git commit, before the ledger writes");
    },
  };
  await assert.rejects(() => runNextStage(REVIEW, crashAfterCommit), /died after the git commit/);

  const authored = head();
  assert.notEqual(authored, preDocs, "the commit landed");
  assert.equal(porcelain(), "", "and took the agent's edits with it");
  assert.equal(getReview(REVIEW)?.candidateSha, preDocs, "but the ledger never learned about it");
  assert.equal(docsRecord(), undefined);
  assert.equal(pending().kind, "docs");

  const resumed = await runNextStage(REVIEW, harness().deps);
  assert.equal(resumed.status, "advanced", resumed.message);
  assert.equal(head(), authored, "no SECOND commit was authored");
  assert.equal(getReview(REVIEW)?.candidateSha, authored, "the post-docs candidate is recorded AUTOMATICALLY");
  assert.equal(docsCommitMeta().recognized, true, "the audit trail says RECOVERED, not authored-on-this-pass");
  assert.match(docsRecord()?.detail ?? "", /RECOVERED rather than re-authored/);
  assert.equal(h.dispatches("documentation-maintainer").length, 1);
});

test("integ FG-655: a crash between the candidate ADVANCE and the stage record recovers without re-authoring", async () => {
  // The other half of the window, and the one FG-652 is open about for the fix stage. There is
  // no seam BETWEEN the advance and the record — they are adjacent statements — so the crash is
  // injected by making the stage-record write itself fail, which is the only place a test can
  // stand inside it. What matters is the durable state it produces: HEAD == candidate == the
  // coordinator's own docs commit, a live binding at the PARENT, and no stage record.
  const h = harness();
  await parkAt(h.deps, "docs");
  const preDocs = getReview(REVIEW)?.candidateSha as string;

  const poison = { toJSON() { throw new Error("the coordinator died between the advance and the stage record"); } };
  const crashAfterAdvance: CoordinatorDeps = {
    ...h.deps,
    commitDocsCycle: async (ctx) => {
      const real = await h.deps.commitDocsCycle(ctx);
      assert.equal(real.kind, "committed");
      // An unserializable committedPaths makes recordStageEvidence throw AFTER
      // advanceCandidate has already run. Nothing else about the outcome is altered.
      return { ...(real as { kind: "committed"; sha: string; committedPaths: string[] }), committedPaths: [poison as unknown as string] };
    },
  };
  await assert.rejects(() => runNextStage(REVIEW, crashAfterAdvance), /died between the advance and the stage record/);

  const authored = head();
  assert.notEqual(authored, preDocs);
  assert.equal(getReview(REVIEW)?.candidateSha, authored, "the advance landed");
  assert.equal(docsRecord(), undefined, "the record did not");
  const binding = pendingDocsDispatch(REVIEW);
  assert.notEqual(binding, undefined, "the binding is still live");
  assert.equal(binding?.candidateSha, preDocs, "and still names the candidate it was dispatched for");
  assert.equal(pending().kind, "docs", "Stage 6 is incomplete at the NEW candidate, so it re-opens");

  const resumed = await runNextStage(REVIEW, harness().deps);
  assert.equal(resumed.status, "advanced", resumed.message);
  assert.equal(head(), authored, "no second commit — the self-anchored commit was RECOGNIZED");
  assert.equal(getReview(REVIEW)?.candidateSha, authored);
  assert.equal(docsRecord()?.sha, authored);
  assert.equal(docsCommitMeta().recognized, true);
  assert.equal(h.dispatches("documentation-maintainer").length, 1, "exactly ONE docs dispatch across the whole sequence");
  assert.equal(pendingDocsDispatch(REVIEW), undefined, "and the binding is retired only now, by the completed stage");
});

// ─── AC4: verification never silently runs against a dirty tree ─────────────

test("integ FG-655 / AC4: the coordinator's verify seam REFUSES a dirty tree at the candidate", async () => {
  // Stages 1 and 7 share this seam, and it used to check head-vs-candidate ONLY — so a dirty
  // tree at the RIGHT head passed it, review-loop degraded to `dirty tree -- local
  // verification`, and CI-evidence reuse was lost silently. The guard runs before any
  // verification work, which is why the REAL `verify` can be used here without a fixture
  // running npm scripts.
  const h = harness({ docs: noopDocsAgent });
  await parkAt(h.deps, "verify_final");
  const at = getReview(REVIEW)?.candidateSha as string;

  writeFileSync(join(repo, "docs", "left-behind.md"), "# a prior stage left this here\n");

  const real: CoordinatorDeps = { ...h.deps, verify: h.wiring.verify };
  const out = await runNextStage(REVIEW, real);
  assert.equal(out.status, "stopped");
  assert.match(out.message, /blocked_environment \(workspace_dirty_at_candidate\)/);
  assert.match(out.message, /docs\/left-behind\.md/, "the refusal names the paths");
  assert.match(out.message, /Commit those changes/, "and the action");
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_final, undefined, "nothing was recorded as verified");
  assert.equal(getReview(REVIEW)?.candidateSha, at);

  // Clean it up and the guard stops firing — it is a stop, not a gravestone. (Whether the
  // project's own checks then pass is a different question, and one this two-file fixture is
  // not the place to ask; what matters is that the REFUSAL is gone and the stage re-enters.)
  rmSync(join(repo, "docs", "left-behind.md"));
  const entry = await h.wiring.verify(at);
  assert.notEqual(
    entry.environmentRefusal?.reason,
    "workspace_dirty_at_candidate",
    "a clean tree at the candidate clears the guard",
  );
  const after = await runNextStage(REVIEW, h.deps);
  assert.equal(after.status, "advanced", after.message);
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_final?.sha, at);
});

test("integ FG-655 / AC4: the Stage 9 shipping reader REFUSES a dirty tree too — it bypasses the verify seam entirely", async () => {
  // `shippingInput` calls loop verification DIRECTLY, so the guard above does not cover it,
  // and its result is the verification block operators read as authoritative.
  //
  // RED baseline: drop the workspaceRefusal call from shippingInput and `verification.ok`
  // reads whatever a dirty-tree local run happened to produce.
  const h = harness({ docs: noopDocsAgent });
  await parkAt(h.deps, "docs");
  const at = getReview(REVIEW)?.candidateSha as string;
  writeFileSync(join(repo, "docs", "left-behind.md"), "# a prior stage left this here\n");

  const input = await h.wiring.shippingInput({ review: getReview(REVIEW) as Review, candidateSha: at });
  assert.equal(input.verification.ok, false, "a dirty tree can never produce a green shipping verification");
  assert.equal(input.verification.executedRequiredChecks, false);
  assert.match(input.verification.detail, /workspace_dirty_at_candidate/);
  assert.match(input.verification.detail, /docs\/left-behind\.md/);
  // FG-655 AC4: and it keeps its NAME across the seam, so the stage can tell an environment
  // that could not run verification from work that failed it.
  assert.equal(input.verification.environmentRefusal?.reason, "workspace_dirty_at_candidate");
});

test("integ FG-655 / AC4: a dirty candidate STOPS Stage 9 as blocked_environment — it is not an ordinary shipping refusal", async () => {
  // The two readers must be symmetric. Stage 1/7 above stops `blocked_environment` on this
  // exact condition; Stage 9 turned the same refusal into a not-ok verification, which reads
  // as the WORK having failed review — a review cycle, a disposition, and a fixer sent to
  // remediate a dirty tree.
  //
  // RED baseline: drop the `classifyVerification` read at the top of `runShippingReview` and
  // this arm returns `refused` with `verification_green:` in its message instead of stopping.
  const h = harness({ docs: noopDocsAgent });
  await parkAt(h.deps, "shipping_review");
  const at = getReview(REVIEW)?.candidateSha as string;
  writeFileSync(join(repo, "docs", "left-behind.md"), "# a prior stage left this here\n");

  const real: CoordinatorDeps = { ...h.deps, shippingInput: h.wiring.shippingInput };
  const out = await runNextStage(REVIEW, real);
  assert.equal(out.status, "stopped", out.message);
  assert.match(out.message, /blocked_environment \(workspace_dirty_at_candidate\)/);
  assert.match(out.message, /docs\/left-behind\.md/, "the stop names the paths");
  assert.doesNotMatch(out.message, /verification_green/, "an unfit environment is not a failed check");
  assert.equal(getReview(REVIEW)?.state, "blocked_environment");
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping, undefined, "nothing was recorded as shipped");
  assert.equal(getReview(REVIEW)?.trustedRemoteSha, undefined, "and no tip was trusted off an unverifiable tree");
  assert.equal(getReview(REVIEW)?.candidateSha, at);
  assert.equal(pending().kind, "shipping_review", "it is a stop, not a gravestone — Stage 9 re-enters");
});

// ─── the done condition, asserted mechanically ──────────────────────────────

test("integ FG-655: this suite proves the done condition WITHOUT re-anchoring or committing anything by hand", () => {
  // AC1's "no manual commit and no manual re-anchoring" is the operator's non-negotiable
  // condition, so it is checked rather than trusted. The two arms that DO call git commit are
  // fixtures for agents that misbehave (the self-committing docs agent), never remediation.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(source, /updateReview\(/, "no arm may move the candidate itself");
  assert.doesNotMatch(source, /recordStageEvidence\(/, "no arm may hand-write a stage record");
  assert.doesNotMatch(source, /retireDocsDispatch\(/, "no arm may retire a binding by hand");
  assert.doesNotMatch(source, /openDocsDispatch\(/, "and no arm may forge a dispatch binding");
});
