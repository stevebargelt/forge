// FG-655 follow-up: exercise the docs committer through runNextStage with the path forms
// porcelain -z exists to protect.  This is intentionally separate from the main FG-655
// candidate suite: it proves the coordinator's declared-path boundary rather than repeating
// its normal commit and crash paths.
//
// FG-655 RF-5 added the three cases a rename actually has.  A rename made with plain `mv` is
// an unstaged deletion git adds happily; a rename made with `git mv` is STAGED, which removes
// the original from the worktree AND the index, so `git add -- :/<original>` matches nothing
// anywhere and used to fail the whole docs cycle with an unexitable refusal.  Both must
// commit, carrying the deletion with the addition — and a path git genuinely does not know
// must still refuse BY NAME, or the tolerance has become silence.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, markTaskComplete } from "../store/tasks.js";
import { getReview, type Review } from "../store/reviews.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { nextTransition } from "./review-coordinator.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run, Task } from "../types/index.js";

const runId = "run-fg655-paths";
const reviewId = "review-fg655-paths";
const createdAt = "2026-08-05T00:00:00Z";
const renamed = 'docs/review "guide".md';
let db: DatabaseInstance;
let previous: DatabaseInstance | null;
let repo: string;
let dispatches = 0;
/** How the fixture's documentation-maintainer renames `docs/source.md`. */
let renameStyle: "staged" | "unstaged" = "staged";
/** A path the WORKTREE SCAN reports that git can never match — the only way to reach a real
 *  `git add` failure through the real coordinator, since every path that reaches the add came
 *  from porcelain in the first place. Only the status observation is fabricated; the add that
 *  fails, and the index probe that decides whether to tolerate it, are real git. */
let phantom: string | null = null;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

const head = () => git(["rev-parse", "HEAD"]).trim();
/** `status path` pairs for HEAD, with rename detection OFF so the deletion is visible as its
 *  own entry rather than folded into the addition it travels with. */
const commitPaths = (): string[] => {
  const fields = git(["show", "--name-status", "--no-renames", "--format=", "-z", "HEAD"]).split("\0").filter(Boolean);
  const pairs: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) pairs.push(`${fields[i]} ${fields[i + 1]}`);
  return pairs.sort();
};

beforeEach(() => {
  db = makeInMemoryDb();
  previous = setDbForTest(db);
  const run: Run = { id: runId, workflow: "feature", title: "fg655 paths", status: "active", createdAt, reviewMode: "evidence_led" };
  insertRun(run);
  repo = mkdtempSync(join(tmpdir(), "fg655-paths-"));
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fg655-paths","private":true}\n');
  writeFileSync(join(repo, "docs", "concepts.md"), "# concepts\n");
  writeFileSync(join(repo, "docs", "source.md"), "# source\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  const base = head();
  appendFileSync(join(repo, "docs", "concepts.md"), "candidate content\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "candidate"]);
  const candidate = head();
  db.prepare(`INSERT INTO reviews (id, run_id, ticket_id, review_mode, base_sha, candidate_sha, contract_json, state, created_at, updated_at)
              VALUES (?, ?, 'FG-655', 'evidence_led', ?, ?, ?, 'confirming_contract', ?, ?)`)
    .run(reviewId, runId, base, candidate, JSON.stringify({ threat_model: "path scope", protected_invariants: ["declared paths"], acceptance_refs: ["FG-655"], risk_lenses: ["backend"], non_goals: [], lens_scopes: { backend: ["src/", "docs/"] } }), createdAt, createdAt);
  dispatches = 0;
  renameStyle = "staged";
  phantom = null;
});

afterEach(() => {
  setDbForTest(previous as DatabaseInstance);
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

function deps(): CoordinatorDeps {
  const seam = (args: string[]): string => {
    const out = execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    if (phantom !== null && args[0] === "status") return `${out}?? ${phantom}\0`;
    return out;
  };
  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    const taskId = `task-${args.agentRole}-${dispatches + 1}`;
    if (args.agentRole === "red-backend") {
      return { runId, taskId, status: "complete", result: { outcome: "pass", findings: [] } };
    }
    assert.equal(args.agentRole, "documentation-maintainer");
    dispatches += 1;
    args.onTaskMinted?.({ runId, taskId });
    // A leading ./, a filename containing both a space and a quote, and both sides of a
    // rename all reach the real worktree parser and the real coordinator committer.
    appendFileSync(join(repo, "docs", "concepts.md"), "docs change\n");
    if (renameStyle === "staged") git(["mv", "docs/source.md", renamed]);
    else renameSync(join(repo, "docs", "source.md"), join(repo, renamed));
    writeFileSync(join(repo, "docs", "guide space.md"), "# space\n");
    const task: Task = { id: taskId, runId, phase: "task", agentRole: args.agentRole, status: "pending", taskPackage: { taskId, runId, phase: "task", role: args.agentRole, inputs: { task: args.task }, composedSystemPrompt: "stub" }, createdAt };
    insertTask(task);
    const docs_updated = ["./docs/concepts.md", renamed, "docs/source.md", "docs/guide space.md", "docs/does not exist.md"];
    if (phantom !== null) docs_updated.push(phantom);
    const result = { docs_updated };
    markTaskComplete(taskId, result);
    return { runId, taskId, status: "complete", result };
  };
  const real = buildCoordinatorDeps({ projectDir: repo, ticketId: "FG-655", runId, git: seam, invokeFn, evaluatedNoDrift: "fixture candidate only" });
  return {
    ...real,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "fixture" }),
    shippingInput: ({ candidateSha }) => ({ verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "fixture" }, acceptance: [], tipTrust: { kind: "trusted" as const, reviewedSha: candidateSha, remoteSha: candidateSha }, identity: { continuous: head() === candidateSha, detail: "fixture" }, contractCoverage: { confirmedSha: candidateSha, finalSha: candidateSha, postConfirmationPaths: [], deltaReviewed: true }, docsCloseout: { assessed: true, gaps: [], detail: "fixture" } }),
  };
}

async function parkAtDocs(coordinator: CoordinatorDeps): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const review = getReview(reviewId) as Review;
    if (nextTransition({ review, findings: [], batches: [] }).kind === "docs") return;
    const outcome = await runNextStage(reviewId, coordinator);
    assert.notEqual(outcome.status, "refused", outcome.message);
  }
  assert.fail("did not reach docs stage");
}

/** The shape both rename cases must land: ONE commit carrying the deletion beside the
 *  addition, over a clean tree, with nothing undeclared swept in. */
function assertRenameCommitted(before: string): void {
  assert.notEqual(head(), before, "the docs cycle advanced the candidate");
  assert.equal(getReview(reviewId)?.candidateSha, head(), "the candidate row moved to the commit");
  assert.deepEqual(
    commitPaths(),
    ["M docs/concepts.md", "A docs/guide space.md", `A ${renamed}`, "D docs/source.md"].sort(),
    "the deletion travels with the addition",
  );
  assert.equal(git(["status", "--porcelain"]).trim(), "", "the whole declared delivery is committed, none stranded");
}

test("integ FG-655: a STAGED rename (git mv) commits, carrying the deletion with the addition", async () => {
  const coordinator = deps();
  await parkAtDocs(coordinator);
  const before = head();

  const outcome = await runNextStage(reviewId, coordinator);

  // `git mv` removes the original from the worktree AND the index, so the original pathspec
  // matches nothing for `git add` — the index already represents it, and the partial commit
  // takes it from there. Refusing here wedged the review forever: the refusal retires nothing,
  // the declaration is immutable, and a staged tree is never clean enough to authorise
  // retiring the binding.
  assert.notEqual(outcome.status, "refused", outcome.message);
  assert.equal(dispatches, 1, "one binding starts exactly one docs dispatch");
  assertRenameCommitted(before);
  assert.match(outcome.message, /does not exist\.md/, "a declared path the tree never moved is still NAMED");
});

test("integ FG-655: an UNSTAGED rename (plain mv) commits — the case that already worked, pinned", async () => {
  renameStyle = "unstaged";
  const coordinator = deps();
  await parkAtDocs(coordinator);
  const before = head();

  const outcome = await runNextStage(reviewId, coordinator);

  assert.notEqual(outcome.status, "refused", outcome.message);
  assert.equal(dispatches, 1);
  assertRenameCommitted(before);
});

test("integ FG-655: a path git cannot know is REFUSED BY NAME with a remedy that terminates", async () => {
  phantom = "docs/never existed.md";
  const coordinator = deps();
  await parkAtDocs(coordinator);
  const before = head();

  const outcome = await runNextStage(reviewId, coordinator);

  // Tolerating the staged rename must not tolerate THIS: the index says nothing about a path
  // that never existed, so its add error is re-thrown rather than swallowed.
  assert.equal(outcome.status, "refused", outcome.message);
  assert.match(outcome.message, /docs_cycle_commit_failed/);
  assert.match(outcome.message, /never existed\.md/, "git's own error names the path it could not match");
  assert.match(outcome.message, /clean at the candidate|CLEAN at the candidate/, "the remedy names a state that terminates");
  assert.equal(head(), before, "the coordinator refuses before advancing the candidate");
  assert.equal(getReview(reviewId)?.stageEvidence?.docs, undefined, "no partial docs stage is recorded");
  assert.deepEqual(commitPaths(), ["M docs/concepts.md"], "the failed cycle authored no partial commit");

  // TERMINATION, NOT JUST A MESSAGE. The operator follows the remedy: the phantom path cannot
  // be made committable, so the delivery is discarded, leaving a clean tree at the candidate.
  phantom = null;
  git(["reset", "-q", "--hard", "HEAD"]);
  git(["clean", "-qfd"]);

  const retire = await runNextStage(reviewId, coordinator);
  assert.equal(retire.status, "refused", retire.message);
  assert.match(retire.message, /docs_cycle_declared_changes_absent/);
  assert.match(retire.message, /RETIRED/, "the spent dispatch is retired, so the next pass is not the same pass");

  const progress = await runNextStage(reviewId, coordinator);
  assert.notEqual(progress.status, "refused", progress.message);
  assert.equal(dispatches, 2, "exactly ONE more documentation-maintainer runs");
  assertRenameCommitted(before);
});
