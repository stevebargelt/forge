// FG-791 (AC3): a LATER pipeline phase must never publish a STALE-BASED artifact
// onto the reviewed branch.
//
// THE DEFECT (observed on run-fg-784, fc881287): after an evidence-led review
// settles, the run's current candidate is the reviewed tip (C2). A verify/docs
// phase that derived its worktree from the pre-review integration head (C0) — code
// the review already replaced — validated a stale tree in-container, and
// publication merged it onto the reviewed branch, where it failed deterministically
// on the host and in CI.
//
// The guard: publishIntegration REFUSES before the lane / the worktree / the mutex /
// any ref write when the publishing task's recorded base is NOT an ancestor of the
// run's current candidate. Nothing is merged; the reviewed branch is byte-for-byte
// unchanged; a `publication.refused{reason:'stale_base_not_ancestor'}` names C0 and C2.
//
// This is a DISTINCT invariant from the fast-forward ancestry proof + CAS in
// publication-target.ts (fg425-publication-*.worktree.test.ts). The incident PASSED
// that proof — C0 was an ancestor of the target it merged onto — and still had to be
// refused. The positive control below proves the new guard is ORTHOGONAL: a phase
// whose base IS an ancestor of the reviewed candidate publishes and fast-forwards the
// target exactly as before.
//
// These tests drive the REAL publishIntegration over real git. setPlatform("darwin")
// keeps them on the darwin-gated worktree tier (the host runs it via test:worktree /
// test:extended; the standard unit gate never does), matching every sibling
// *.worktree.test.ts — see fg584-ordered-fanout.worktree.test.ts.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getPublicationAttempt, activeLaneForProject } from "../store/publications.js";
import { insertRun } from "../store/runs.js";
import { insertTask, setTaskWorkspace } from "../store/tasks.js";
import { projectIdentity } from "./project-identity.js";
import { insertReview, setReviewState } from "../store/reviews.js";
import { eventsForRun } from "../store/events.js";
import type { Task } from "../types/index.js";
import { publishIntegration } from "./integration-publisher.js";
import { readTargetSha, localTargetFor, isAncestor } from "./publication-target.js";

let prevDb: DatabaseInstance | null;
const cleanup: string[] = [];
const realPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  // Darwin-gated worktree tier: the publisher does real `git worktree add` work, and
  // this file rides the same tier convention as its siblings.
  setPlatform("darwin");
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  setPlatform(realPlatform);
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A fixture repo. realpathSync at the ROOT so every derived path is canonical on
 *  both sides of every comparison (FG-556) — projectIdentity records the physical
 *  path via realpath, and a fixture spelled through a symlinked tmpdir (macOS
 *  /var → /private/var) would otherwise never match the durable target it asserts. */
function initRepo(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fg791-refuse-${label}-`)));
  cleanup.push(dir);
  git(dir, ["init", "-b", "main"]);
  return dir;
}

/** A run whose authority model is evidence-led, plus one later-phase task carrying a
 *  recorded base_sha — the exact shape the AC3 preflight reads: getTask(taskId).baseSha
 *  vs latestSettledReviewCandidateForRun(runId). */
function seedRun(runId: string, projectDir: string): void {
  insertRun({
    id: runId,
    workflow: "fg791",
    title: "fg791 stale-base refusal",
    status: "active",
    projectDir,
    createdAt: new Date().toISOString(),
    metadata: {},
    reviewMode: "evidence_led",
  });
}

function laterPhaseTask(runId: string, taskId: string, baseSha: string): void {
  const task: Task = {
    id: taskId,
    runId,
    phase: "verify",
    agentRole: "test-engineer",
    status: "running",
    taskPackage: {
      taskId,
      runId,
      phase: "verify",
      role: "test-engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);
  // base_sha is written with the workspace handle in production (setTaskWorkspace);
  // do the same here so getTask(taskId).baseSha is the recorded phase base.
  setTaskWorkspace(taskId, `/tmp/forge-worktrees/${taskId}`, baseSha);
}

/** A later-phase task carrying NO recorded base_sha — the RF-2 shape: getTask(taskId)
 *  returns a row whose baseSha is undefined (setTaskWorkspace was never called). */
function laterPhaseTaskNoBase(runId: string, taskId: string): void {
  const task: Task = {
    id: taskId,
    runId,
    phase: "verify",
    agentRole: "test-engineer",
    status: "running",
    taskPackage: {
      taskId,
      runId,
      phase: "verify",
      role: "test-engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);
}

/** Settle an evidence-led review at `candidateSha` — the reviewed tip the run's
 *  post-review phases must base on. setReviewState('settled') stamps settled_at, which
 *  is what latestSettledReviewCandidateForRun orders on. */
function settleReviewAt(runId: string, reviewId: string, candidateSha: string): void {
  insertReview({
    id: reviewId,
    reviewMode: "evidence_led",
    runId,
    candidateSha,
    ticketId: "FG-784",
  });
  setReviewState(reviewId, "settled");
}

// ── AC3: the stale-based publish is refused, nothing is merged ──────────────────

test("FG-791 (AC3): a later phase whose base is NOT an ancestor of the reviewed candidate is REFUSED — nothing merged, the reviewed branch is byte-for-byte unchanged", async () => {
  const runId = "run-stale";
  const dir = initRepo("stale");

  // S — the shared root.
  commit(dir, "seed.txt", "seed\n");

  // C0 — the PRE-REVIEW integration head, on its own branch. This is the stale base a
  // verify/docs phase wrongly derived its worktree from.
  git(dir, ["checkout", "-q", "-b", "prebuild"]);
  const c0 = commit(dir, "build.txt", "build integration head\n");

  // C2 — the reviewed candidate, on a DIVERGENT line off S (the review's fix cycle ran
  // on the run's clone branch). C0 is deliberately not in its history.
  git(dir, ["checkout", "-q", "-b", "reviewed", "main"]);
  const c2 = commit(dir, "fix.txt", "review fix RF-5 refuses a dotted Access team\n");

  // main becomes the reviewed tip — the published candidate the later phase would merge onto.
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["reset", "-q", "--hard", c2]);

  // The later phase's source branch, built (wrongly) on the stale C0.
  git(dir, ["checkout", "-q", "-b", "verify-phase", c0]);
  commit(dir, "stale-test.txt", "a test authored against PRE-fix semantics\n");
  git(dir, ["checkout", "-q", "main"]);

  assert.equal(isAncestor(dir, c0, c2), false, "precondition: the stale base C0 is NOT in the reviewed candidate's history");

  seedRun(runId, dir);
  laterPhaseTask(runId, "task-verify-1", c0);
  settleReviewAt(runId, "rev-1", c2);

  const targetBefore = readTargetSha(localTargetFor(dir));
  assert.equal(targetBefore, c2, "precondition: the reviewed branch (target) is at the reviewed candidate C2");

  const out = await publishIntegration({
    runId,
    taskId: "task-verify-1",
    projectDir: dir,
    sources: [{ branch: "verify-phase", label: "verify" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => {
      assert.fail("validation must NEVER run — the refusal fires before the lane, the worktree and any validation");
    },
  });

  assert.equal(out.kind, "refused", `expected a named refusal; got ${out.kind}`);
  if (out.kind !== "refused") return;

  // The refusal message names the stale base, the reviewed candidate and the remedy.
  assert.match(out.error, /is NOT an ancestor of the run's current candidate/);
  assert.match(out.error, new RegExp(c0.slice(0, 12)), "names the stale phase base C0");
  assert.match(out.error, new RegExp(c2.slice(0, 12)), "names the reviewed candidate C2");
  assert.match(out.error, /FG-791/);
  assert.equal(out.candidateWorktree, undefined, "refused before any worktree was created");

  // NOTHING was merged: the reviewed branch is byte-for-byte where it started.
  assert.equal(readTargetSha(localTargetFor(dir)), c2, "the target ref must not have moved — refused before any ref write");
  assert.equal(existsSync(join(dir, "stale-test.txt")), false, "the stale phase's file must NOT be on the reviewed branch");
  assert.equal(existsSync(join(dir, "build.txt")), false, "and neither is the pre-review head's content");

  // The attempt is recorded failed (the intent row was minted, then failed on refusal).
  const attempt = getPublicationAttempt(out.attemptId);
  assert.equal(attempt?.state, "failed", "the refused attempt is recorded failed");
  assert.equal(attempt?.publishedSha, undefined, "nothing was published");

  // The distinct, named refusal event carries the two shas the operator needs.
  const refused = eventsForRun(runId).filter((e) => e.eventType === "publication.refused");
  assert.equal(refused.length, 1, "exactly one publication.refused event");
  const payload = refused[0]!.payload as Record<string, unknown>;
  assert.equal(payload["reason"], "stale_base_not_ancestor", "the refusal reason is NAMED and distinct from the FF/CAS refusals");
  assert.equal(payload["phaseBase"], c0);
  assert.equal(payload["currentCandidate"], c2);

  assert.equal(
    eventsForRun(runId).some((e) => e.eventType === "publication.published"),
    false,
    "no publication.published event — a refused stale-based artifact never lands",
  );
});

// ── The positive control: an ancestor base publishes and fast-forwards as before ──
//
// The new guard must be ORTHOGONAL to the existing fast-forward proof + CAS: a later
// phase correctly based on (an ancestor of) the reviewed candidate publishes and
// advances the target exactly as it did before FG-791.

test("FG-791 (AC3): a later phase whose base IS an ancestor of the reviewed candidate publishes and fast-forwards the target — the guard does not disturb the FF/CAS proof", async () => {
  const runId = "run-ancestor";
  const dir = initRepo("ancestor");

  // S → Ca → C2 all on main: Ca is a PROPER ancestor of the reviewed candidate C2
  // (not equal to it), so the preflight exercises isAncestor(base, candidate) === true
  // rather than the base===candidate short-circuit.
  commit(dir, "seed.txt", "seed\n");
  const ca = commit(dir, "base.txt", "pre-fix work\n");
  const c2 = commit(dir, "fix.txt", "review fix\n");
  assert.notEqual(ca, c2);
  assert.equal(isAncestor(dir, ca, c2), true, "precondition: the phase base Ca is a proper ancestor of the reviewed candidate C2");

  // main is the reviewed tip; the later phase's source correctly descends from C2, so
  // its candidate fast-forwards the target that sits at C2.
  git(dir, ["checkout", "-q", "-b", "docs-phase", c2]);
  const docsTip = commit(dir, "docs.txt", "docs artifact for the reviewed candidate\n");
  git(dir, ["checkout", "-q", "main"]);
  assert.equal(readTargetSha(localTargetFor(dir)), c2, "precondition: the target is at the reviewed candidate C2");

  seedRun(runId, dir);
  laterPhaseTask(runId, "task-docs-1", ca);
  settleReviewAt(runId, "rev-1", c2);

  let validatedDir: string | undefined;
  const out = await publishIntegration({
    runId,
    taskId: "task-docs-1",
    projectDir: dir,
    sources: [{ branch: "docs-phase", label: "docs" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (candidateDir) => {
      // The guard let this through — validation runs, exactly as on the ordinary path.
      validatedDir = candidateDir;
      return { ok: true };
    },
  });

  assert.equal(out.kind, "published", `an ancestor-based phase must publish; got ${out.kind}`);
  if (out.kind !== "published") return;

  assert.ok(validatedDir?.includes("publications"), "validation ran in the per-attempt candidate worktree, not on the target");
  assert.equal(out.baseSha, c2, "the FF/CAS proof captured the target's base (C2) unchanged");
  assert.equal(out.publishedSha, out.candidateSha, "AD-6: publishedSha === candidateSha");
  assert.equal(out.publishedSha, docsTip, "a clean fast-forward onto the unmoved base lands the docs-phase tip");
  assert.equal(readTargetSha(localTargetFor(dir)), docsTip, "the reviewed branch fast-forwarded to the published artifact");
  assert.equal(readFileSync(join(dir, "docs.txt"), "utf8"), "docs artifact for the reviewed candidate\n");

  assert.equal(getPublicationAttempt(out.attemptId)?.state, "published");
  assert.equal(
    eventsForRun(runId).some((e) => e.eventType === "publication.refused"),
    false,
    "the orthogonal guard raised no refusal on a legitimately-based phase",
  );
});

// ── RF-1: a stale-base refusal must NOT leave its enqueued lane entry live ───────
//
// recordPublicationIntent atomically enqueues a `queued` publication_lane row before
// the preflight runs. The refusal used to return before the try/finally that calls
// leaveLane, so the row stayed live and every later publication for the run queued
// behind a phantom. The refusal now returns through that finally: the lane is empty
// after the refusal, and a subsequent valid publication proceeds.

test("FG-791 (RF-1): a stale-base refusal releases its lane entry — the lane is empty afterward and a subsequent valid publication proceeds", async () => {
  const runId = "run-rf1";
  const dir = initRepo("rf1");
  const key = projectIdentity(dir).key;

  // S → C2 on main; C2 is the reviewed tip the target sits at.
  commit(dir, "seed.txt", "seed\n");
  git(dir, ["checkout", "-q", "-b", "prebuild"]);
  const c0 = commit(dir, "build.txt", "pre-review integration head\n");
  git(dir, ["checkout", "-q", "-b", "reviewed", "main"]);
  const c2 = commit(dir, "fix.txt", "review fix\n");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["reset", "-q", "--hard", c2]);
  assert.equal(isAncestor(dir, c0, c2), false, "precondition: the stale base C0 is not in the reviewed candidate's history");

  // The stale phase, wrongly based on C0.
  git(dir, ["checkout", "-q", "-b", "stale-phase", c0]);
  commit(dir, "stale-test.txt", "a test authored against pre-fix semantics\n");
  git(dir, ["checkout", "-q", "main"]);

  seedRun(runId, dir);
  settleReviewAt(runId, "rev-1", c2);
  laterPhaseTask(runId, "task-stale", c0);

  assert.equal(activeLaneForProject(key).length, 0, "precondition: the lane starts empty");

  const refused = await publishIntegration({
    runId,
    taskId: "task-stale",
    projectDir: dir,
    sources: [{ branch: "stale-phase", label: "verify" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => assert.fail("validation must never run on a refused stale-based phase"),
  });
  assert.equal(refused.kind, "refused", `expected a refusal; got ${refused.kind}`);

  // THE RF-1 ASSERTION: the refusal released the lane entry it enqueued.
  assert.equal(
    activeLaneForProject(key).length,
    0,
    "the stale-base refusal must leave NO active lane entry — a phantom would queue every later publication behind it",
  );

  // And a subsequent VALID publication proceeds rather than blocking on the phantom. A
  // docs phase correctly based on the reviewed tip C2 fast-forwards the target.
  git(dir, ["checkout", "-q", "-b", "docs-phase", c2]);
  const docsTip = commit(dir, "docs.txt", "docs for the reviewed candidate\n");
  git(dir, ["checkout", "-q", "main"]);
  laterPhaseTask(runId, "task-docs", c2);

  const published = await publishIntegration({
    runId,
    taskId: "task-docs",
    projectDir: dir,
    sources: [{ branch: "docs-phase", label: "docs" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ({ ok: true }),
  });
  assert.equal(published.kind, "published", `the subsequent valid publication must proceed; got ${published.kind}`);
  assert.equal(readTargetSha(localTargetFor(dir)), docsTip, "the valid phase fast-forwarded the reviewed branch");
  assert.equal(activeLaneForProject(key).length, 0, "the successful publication also left the lane clean");
});

// ── RF-2: a settled candidate with an UNRECORDED phase base must REFUSE, not fail open ─
//
// The guard used to require a truthy phaseBase before it could refuse, so a task with
// no recorded base_sha under a settled candidate published unchecked — the exact
// unknown-provenance case the guard exists for. It now refuses with its own reason.

test("FG-791 (RF-2): a missing phase base under a SETTLED candidate is refused — no ref written, its own named reason", async () => {
  const runId = "run-rf2-refuse";
  const dir = initRepo("rf2-refuse");

  commit(dir, "seed.txt", "seed\n");
  const c2 = commit(dir, "fix.txt", "review fix\n");
  git(dir, ["checkout", "-q", "-b", "verify-phase", c2]);
  commit(dir, "verify.txt", "a later-phase artifact whose base was never recorded\n");
  git(dir, ["checkout", "-q", "main"]);

  seedRun(runId, dir);
  settleReviewAt(runId, "rev-1", c2);
  laterPhaseTaskNoBase(runId, "task-nobase"); // NO base_sha recorded

  const before = readTargetSha(localTargetFor(dir));
  const out = await publishIntegration({
    runId,
    taskId: "task-nobase",
    projectDir: dir,
    sources: [{ branch: "verify-phase", label: "verify" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => assert.fail("validation must never run — the fail-open path is closed"),
  });

  assert.equal(out.kind, "refused", `a missing base under a settled candidate must refuse; got ${out.kind}`);
  if (out.kind !== "refused") return;
  assert.match(out.error, /NO recorded base/);
  assert.match(out.error, new RegExp(c2.slice(0, 12)), "names the settled candidate");

  assert.equal(readTargetSha(localTargetFor(dir)), before, "refused before any ref write — the target is unchanged");
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "failed");
  assert.equal(activeLaneForProject(projectIdentity(dir).key).length, 0, "the refusal released its lane entry (RF-1 applies here too)");

  const refused = eventsForRun(runId).filter((e) => e.eventType === "publication.refused");
  assert.equal(refused.length, 1, "exactly one publication.refused event");
  assert.equal(
    (refused[0]!.payload as Record<string, unknown>)["reason"],
    "base_unrecorded_under_settled_candidate",
    "the reason is distinct from stale_base_not_ancestor",
  );
});

// ── RF-2 no-op control: a missing base with NO current candidate still proceeds ──
//
// The pre-settlement / legacy path (first mutating task, verdict-mode run) has no
// candidate to be stale against, so an unrecorded base there is a clean no-op, not a
// refusal — only a REAL current candidate turns a missing base into an unknown-provenance
// refusal.

test("FG-791 (RF-2): a missing phase base with NO current candidate proceeds — the guard stays a no-op on the legacy path", async () => {
  const runId = "run-rf2-noop";
  const dir = initRepo("rf2-noop");

  const base = commit(dir, "seed.txt", "seed\n");
  git(dir, ["checkout", "-q", "-b", "build-phase"]);
  const buildTip = commit(dir, "build.txt", "first mutating task, no review settled yet\n");
  git(dir, ["checkout", "-q", "main"]);

  seedRun(runId, dir); // NO settled review, and no prior publication → no current candidate
  laterPhaseTaskNoBase(runId, "task-build"); // NO base_sha recorded

  assert.equal(base, readTargetSha(localTargetFor(dir)), "precondition: the target sits at the shared root");

  let validated = false;
  const out = await publishIntegration({
    runId,
    taskId: "task-build",
    projectDir: dir,
    sources: [{ branch: "build-phase", label: "build" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => {
      validated = true;
      return { ok: true };
    },
  });

  assert.equal(out.kind, "published", `a missing base with no candidate must proceed as before; got ${out.kind}`);
  assert.equal(validated, true, "validation ran — the guard did not refuse the legacy path");
  assert.equal(readTargetSha(localTargetFor(dir)), buildTip, "the build phase published onto the target");
  assert.equal(
    eventsForRun(runId).some((e) => e.eventType === "publication.refused"),
    false,
    "no refusal on the no-candidate path",
  );
});
