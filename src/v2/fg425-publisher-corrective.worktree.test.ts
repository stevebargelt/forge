// FG-425 corrective (VERIFY): the three fixes driven through the REAL publication
// path — publishIntegration and the run-path recovery sweep as runNext invokes them,
// against a real git target — rather than through the helpers in isolation.
//
// What this file pins that a focused unit/worktree test does not:
//
//   (1) THE MULTI-ATTEMPT SHAPE. A loses the window mid-publication; the run-path
//       sweep (what runNext.ts:183 actually calls) converges it; B then publishes on
//       top through the ordinary path. The target must converge on ONE sha, with a
//       clean `git status --porcelain` — never dirty, never divergent — and A's work
//       must be in the history of what B published.
//   (2) RECOVERY RE-ENTRANCY. The sweep run twice, and recovery run against a record
//       another publisher is concurrently converging. A `published` record's
//       publishedSha is never rewritten.
//   (3) THE RECORD vs REALITY. Across every disposition one project can produce, the
//       `publications` row tells the TRUTH about the target: a `published` record's
//       sha is reachable from the target ref, and a record that is NOT `published`
//       has no candidate on it.
//   (4) AD-3 PREFLIGHT ORDERING, in both directions — and the other half of that
//       contract: prefix-awareness must not become OVER-refusal. An untracked file
//       that does NOT collide must still publish, or AD-3 would block every repo
//       with an untracked file next to a path the candidate writes.
//   (5) THE ROLLBACK BOUNDARY. A checkout that genuinely fails WHILE ownership is
//       proven still rolls back by CAS — the complement of AC1's "a publisher that
//       lost the mutex mutates nothing". Both halves, or the invariant is a
//       one-sided rule that quietly forbids the rollback it depends on.
//
// The DB here is the real on-disk one (no in-memory override): (2)'s crash is a real
// SIGKILL in a real second process, which has to see the same durable state. Each
// test gets its own project dir, so the project identity keys never cross-talk.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "../store/db.js";
import {
  getPublicationAttempt,
  publicationAttemptsForProject,
  releasePublicationMutex,
  setPublicationClockOffsetForTest,
  tryAcquirePublicationMutex,
  type PublicationAttempt,
} from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";
import {
  MUTEX_TTL_MS,
  publishIntegration,
  recoverPublicationAttempt,
  recoverPublicationAttemptForOperator,
  recoverUnfinishedPublications,
  type PublishOutcome,
  type ValidationResult,
} from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";

const V2_DIR = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const readOnly: string[] = [];

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  for (const d of readOnly.splice(0)) {
    try { chmodSync(d, 0o700); } catch { /* already gone */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ok = (): ValidationResult => ({ ok: true });

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A project on `main`, plus one task branch carrying `file` — the shape a real
 *  publication attempt consumes (a branch to fold into the candidate). */
function makeProject(prefix: string): { dir: string; base: string } {
  const dir = tmp(prefix);
  git(dir, ["init", "-b", "main"]);
  const base = commit(dir, "seed.txt", "seed\n");
  return { dir, base };
}

function taskBranch(dir: string, runId: string, file: string, body: string): string {
  const branch = `forge/${runId}/task`;
  git(dir, ["checkout", "-q", "-b", branch, "main"]);
  commit(dir, file, body);
  git(dir, ["checkout", "-q", "main"]);
  return branch;
}

/** Reachable from the target ref — "this commit IS on the target", the only question
 *  a durable `published` claim can be checked against. */
function onTarget(dir: string, sha: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "refs/heads/main"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** THE RECORD MUST NOT LIE. For every attempt this project recorded: a `published`
 *  row's sha is on the target ref (and is the candidate it validated — AD-6), and a
 *  row that is NOT `published` has landed nothing. Run at the END of a scenario,
 *  after every convergence path has had its chance — an attempt still `publishing`
 *  is an unfinished window, not a lie, and is asserted separately where it arises. */
function assertRecordsTellTheTruth(dir: string, key: string): PublicationAttempt[] {
  const attempts = publicationAttemptsForProject(key);
  for (const a of attempts) {
    if (a.state === "published") {
      assert.ok(a.publishedSha, `a published record must carry its publishedSha (${a.attemptId})`);
      assert.equal(
        a.publishedSha,
        a.candidateSha,
        `AD-6: a published record's sha IS the candidate it validated (${a.attemptId})`,
      );
      assert.ok(
        onTarget(dir, a.publishedSha!),
        `RECORD vs REALITY: attempt ${a.attemptId} claims it published ${a.publishedSha?.slice(0, 12)}, but that ` +
          `commit is NOT reachable from the target ref. A durable 'published' row that nothing on the target ` +
          `carries is a lie about what forge did.`,
      );
      continue;
    }
    if (a.state === "publishing" || !a.candidateSha) continue;
    assert.equal(
      onTarget(dir, a.candidateSha),
      false,
      `RECORD vs REALITY: attempt ${a.attemptId} is recorded as '${a.state}'${a.parkReason ? `/${a.parkReason}` : ""} ` +
        `— it published NOTHING — yet its candidate ${a.candidateSha.slice(0, 12)} is reachable from the target ` +
        `ref. A candidate that silently landed under a non-published record is the worst shape of all: the ` +
        `operator is told nothing shipped while the tree says otherwise.`,
    );
  }
  return attempts;
}

/** Publishes in its own process and SIGKILLs itself inside the AD-5 window — the ref
 *  has advanced, the working tree has not. A throw-based hook would run the `finally`
 *  blocks a real crash never runs; this is the durable state a real crash leaves. */
function writeCrashDriver(dir: string): string {
  const path = join(dir, "crash-driver.mjs");
  writeFileSync(
    path,
    `
import { publishIntegration } from ${JSON.stringify(join(V2_DIR, "integration-publisher.ts"))};

const [projectDir, runId, branch] = process.argv.slice(2);

await publishIntegration({
  runId,
  taskId: "task-" + runId,
  projectDir,
  sources: [{ branch, label: runId }],
  lane: { pollMs: 25, log: () => {} },
  alsoValidate: () => ({ ok: true }),
  afterRefAdvance: () => { process.kill(process.pid, "SIGKILL"); },
});
process.stdout.write("UNREACHABLE\\n");
`,
  );
  return path;
}

function crashInsideWindow(project: string, runId: string, branch: string): void {
  getDb(); // materialize the shared on-disk DB before the child opens it
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", writeCrashDriver(tmp("fg425-corr-drv-")), project, runId, branch],
    { encoding: "utf8", env: process.env, timeout: 120_000 },
  );
  assert.equal(child.signal, "SIGKILL", `the driver must have died by SIGKILL (stderr: ${child.stderr})`);
  assert.doesNotMatch(child.stdout ?? "", /UNREACHABLE/);
}

// ─── (1) the multi-attempt shape: lose the window, converge, publish on top ────
//
// AC1 says a publisher that loses the mutex after its ref advance mutates NOTHING and
// leaves the durable intent for the window's owner to converge. That is a statement
// about a SEQUENCE, and the sequence has to end somewhere: the target converges on one
// sha, clean, and the next publication builds on it. A rollback executed without
// ownership is exactly what would break that — ref=base with the tree already at the
// candidate is a target no later publication can pass AD-3 against.

test("FG-425 (AC1): A loses the window mid-publication, the run-path sweep converges it, B publishes on top — the target converges on ONE sha and is never dirty", async () => {
  const { dir, base } = makeProject("fg425-corr-converge-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);
  const branchA = taskBranch(dir, "run-a", "a.txt", "A's work\n");
  const branchB = taskBranch(dir, "run-b", "b.txt", "B's work\n");

  let candidateA = "";
  const outA = await publishIntegration({
    runId: "run-a",
    taskId: "task-a",
    projectDir: dir,
    sources: [{ branch: branchA, label: "a" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_d, sha) => { candidateA = sha; return ok(); },
    // A's ref advance has LANDED and its tree update has not. Its lease lapses here,
    // and the OTHER forge process does exactly what runNext does at the top of a run:
    // it sweeps for unfinished publications. That sweep takes the window from A's
    // lapsed lease, converges the tree onto A's candidate, and records the truth.
    afterRefAdvance: () => {
      setPublicationClockOffsetForTest(MUTEX_TTL_MS + 60_000);
      recoverUnfinishedPublications(dir, "run-b");
    },
  });

  // A resumes with no window. It must not roll its ref advance back — the sweep has
  // already synchronized the tree onto that very candidate.
  assert.equal(outA.kind, "published", `A must report the durable truth the sweep recorded: ${JSON.stringify(outA)}`);
  assert.equal(readTargetSha(target), candidateA, "the ref still carries A's candidate — no unowned rollback");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "and the target is CLEAN: ref, index and worktree agree");

  // ── B now publishes through the ordinary path, on the base A left behind ─────
  const outB = await publishIntegration({
    runId: "run-b",
    taskId: "task-b",
    projectDir: dir,
    sources: [{ branch: branchB, label: "b" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });
  assert.equal(outB.kind, "published", `B must publish on top of the converged target: ${JSON.stringify(outB)}`);
  if (outB.kind !== "published") return;

  assert.equal(outB.baseSha, candidateA, "B built on A's published candidate — the ref is the base, and it converged");
  assert.equal(readTargetSha(target), outB.publishedSha, "the target ref carries exactly ONE sha: B's candidate");
  assert.equal(git(dir, ["rev-parse", "HEAD"]), outB.publishedSha, "HEAD, the index and the worktree all agree");
  assert.equal(
    git(dir, ["status", "--porcelain"]),
    "",
    "and `git status` is EMPTY. A target left dirty or divergent is the failure mode this whole ticket exists to " +
      "prevent — every later publication's AD-3 pre-check would read forge's own half-publication as operator dirt.",
  );

  // Neither run's work was lost, and neither record lies about it.
  assert.ok(onTarget(dir, candidateA), "A's work is in the history of what B published — nothing was un-published");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A's work\n");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "B's work\n");
  assert.notEqual(readTargetSha(target), base, "the target moved off the original base");
  assertRecordsTellTheTruth(dir, key);
});

// ─── (2) recovery is RE-ENTRANT ───────────────────────────────────────────────
//
// AC2 makes a terminal record immutable. The property that matters operationally is
// re-entrancy: the sweep runs at the top of EVERY run, so a converged attempt gets
// recovered again and again for as long as it sits in the table. The second pass must
// converge nothing and rewrite nothing — above all it must never rewrite publishedSha.

test("FG-425 (AC2): the run-path sweep is re-entrant — it converges an interrupted attempt ONCE, then reports the recorded truth byte-for-byte", () => {
  const { dir } = makeProject("fg425-corr-reentrant-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);
  const branch = taskBranch(dir, "run-crash", "work.txt", "the crashed run's work\n");

  crashInsideWindow(dir, "run-crash", branch);

  const crashed = publicationAttemptsForProject(key)[0]!;
  assert.equal(crashed.state, "publishing", "precondition: the crash caught it inside the window");
  assert.equal(readTargetSha(target), crashed.candidateSha, "precondition: the ref advance landed");
  assert.equal(existsSync(join(dir, "work.txt")), false, "precondition: the checkout did not run");

  // The dead owner's lease lapses; the next run sweeps.
  setPublicationClockOffsetForTest(10 * 60 * 1000);
  recoverUnfinishedPublications(dir, "run-next");

  const converged = getPublicationAttempt(crashed.attemptId)!;
  assert.equal(converged.state, "published", "the sweep converged the interrupted attempt from the three SHAs");
  assert.equal(converged.publishedSha, crashed.candidateSha, "AD-6: it published the RECORDED candidate");
  assert.equal(readFileSync(join(dir, "work.txt"), "utf8"), "the crashed run's work\n", "and finished the checkout");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "leaving the target clean");

  // ── every later run sweeps again. Nothing may move. ─────────────────────────
  const refAfterFirst = readTargetSha(target);
  recoverUnfinishedPublications(dir, "run-third");
  recoverUnfinishedPublications(dir, "run-fourth");

  assert.deepEqual(
    getPublicationAttempt(crashed.attemptId),
    converged,
    "a re-run sweep must leave the converged record BYTE-FOR-BYTE unchanged — the sweep runs at the top of every " +
      "run, so a record that drifts on re-recovery drifts on every run forever",
  );

  // And by hand, twice more: `forge publish recover` is documented as idempotent.
  const byHand = recoverPublicationAttempt(crashed.attemptId);
  assert.equal(byHand.kind, "published", `recovery REPORTS the recorded publication: ${JSON.stringify(byHand)}`);
  if (byHand.kind === "published") {
    assert.equal(byHand.publishedSha, crashed.candidateSha, "with its recorded publishedSha, never a re-derived one");
  }
  assert.deepEqual(getPublicationAttempt(crashed.attemptId), converged, "and still writes nothing");
  recoverPublicationAttempt(crashed.attemptId);
  assert.deepEqual(getPublicationAttempt(crashed.attemptId), converged, "however many times it runs");

  assert.equal(readTargetSha(target), refAfterFirst, "no repeat recovery touched the target ref");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "or its working tree");
  assertRecordsTellTheTruth(dir, key);
});

// ─── (3) recovery vs a publisher that owns the window RIGHT NOW ────────────────
//
// Recovery re-runs the checkout — it is a WRITE to the target's working tree, and it
// can converge a record. Run while another publisher owns the window, it would put two
// processes in one tree. The record must survive that untouched, and converge exactly
// once when the window frees.

test("FG-425 (AC2): recovery REFUSES to converge a record while another publisher owns the window — and converges it exactly once when the window frees", () => {
  const { dir } = makeProject("fg425-corr-concurrent-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);
  const branch = taskBranch(dir, "run-crash", "work.txt", "the crashed run's work\n");

  crashInsideWindow(dir, "run-crash", branch);
  const crashed = publicationAttemptsForProject(key)[0]!;
  assert.equal(crashed.state, "publishing", "precondition: interrupted inside the window");

  setPublicationClockOffsetForTest(10 * 60 * 1000);

  // Another publisher is inside the window RIGHT NOW, with a live lease.
  const holder = "attempt-in-window";
  assert.equal(
    tryAcquirePublicationMutex({ projectKey: key, attemptId: holder, runId: "run-holder", ttlMs: MUTEX_TTL_MS })
      .acquired,
    true,
    "setup: the other publisher owns the window",
  );

  // The run-path sweep must leave the recovery to the next wave rather than write to
  // a tree someone else is inside.
  recoverUnfinishedPublications(dir, "run-sweeper");
  assert.deepEqual(
    getPublicationAttempt(crashed.attemptId),
    crashed,
    "the sweep must not converge (or otherwise rewrite) a record while another publisher holds the window",
  );
  assert.equal(existsSync(join(dir, "work.txt")), false, "and must run NO checkout into the tree that holder owns");

  // The operator's own `forge publish recover` refuses too — and names the holder.
  const byHand = recoverPublicationAttemptForOperator(crashed.attemptId);
  assert.equal(byHand.kind, "blocked", `operator recovery must be BLOCKED, not racing: ${JSON.stringify(byHand)}`);
  if (byHand.kind === "blocked") {
    assert.match(byHand.error, /run-holder|attempt-in-window/, "the refusal names who holds the window");
  }
  assert.deepEqual(getPublicationAttempt(crashed.attemptId), crashed, "and a blocked recovery writes nothing at all");

  // The window frees. Now — and only now — the record converges, exactly once.
  releasePublicationMutex(key, holder);
  recoverUnfinishedPublications(dir, "run-sweeper");

  const converged = getPublicationAttempt(crashed.attemptId)!;
  assert.equal(converged.state, "published", "with the window free, the sweep converges the interrupted attempt");
  assert.equal(converged.publishedSha, crashed.candidateSha, "onto the RECORDED candidate");
  assert.equal(readTargetSha(target), crashed.candidateSha);
  assert.equal(git(dir, ["status", "--porcelain"]), "", "and the target is clean");

  recoverUnfinishedPublications(dir, "run-sweeper-again");
  assert.deepEqual(getPublicationAttempt(crashed.attemptId), converged, "and a second sweep changes nothing");
  assertRecordsTellTheTruth(dir, key);
});

// ─── (4) the durable record never lies about the target ───────────────────────
//
// One project, four dispositions, through the real path. The `publications` table is
// forge's account of what it did to the operator's repo; the repo is the only thing
// that can contradict it. Every row is checked against the ref.

test("FG-425: across published / validation-failed / dirty-parked attempts, every publication record tells the TRUTH about the target ref", async () => {
  const { dir, base } = makeProject("fg425-corr-truth-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);

  const shipped = taskBranch(dir, "run-ship", "shipped.txt", "this one lands\n");
  const rejected = taskBranch(dir, "run-reject", "rejected.txt", "this one is rejected\n");
  const blocked = taskBranch(dir, "run-blocked", "blocked.txt", "this one hits a dirty target\n");

  // (a) a clean publication.
  const published = await publishIntegration({
    runId: "run-ship", taskId: "task-ship", projectDir: dir,
    sources: [{ branch: shipped, label: "ship" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });
  assert.equal(published.kind, "published", `setup: ${JSON.stringify(published)}`);
  if (published.kind !== "published") return;

  // (b) validation rejects the candidate — nothing may reach the target.
  const failed = await publishIntegration({
    runId: "run-reject", taskId: "task-reject", projectDir: dir,
    sources: [{ branch: rejected, label: "reject" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ({ ok: false, error: "a red rejected the candidate" }),
  });
  assert.equal(failed.kind, "validation_failed", `setup: ${JSON.stringify(failed)}`);
  assert.equal(readTargetSha(target), published.publishedSha, "a rejected candidate must not move the ref");

  // (c) the operator dirties the target; the next attempt parks before any mutation.
  writeFileSync(join(dir, "shipped.txt"), "the operator is editing this\n");
  const parked = await publishIntegration({
    runId: "run-blocked", taskId: "task-blocked", projectDir: dir,
    sources: [{ branch: blocked, label: "blocked" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });
  assert.equal(parked.kind, "parked", `setup: ${JSON.stringify(parked)}`);
  assert.equal(parked.kind === "parked" && parked.reason, "dirty_publish_target");
  assert.equal(readTargetSha(target), published.publishedSha, "AD-3 refused BEFORE any mutation — the ref is unmoved");
  assert.equal(
    readFileSync(join(dir, "shipped.txt"), "utf8"),
    "the operator is editing this\n",
    "and the operator's uncommitted edit is byte-for-byte untouched",
  );

  // ── the audit ───────────────────────────────────────────────────────────────
  const attempts = assertRecordsTellTheTruth(dir, key);
  assert.equal(attempts.length, 3, "three attempts, three durable records");
  assert.equal(attempts.filter((a) => a.state === "published").length, 1, "exactly ONE of them published");
  assert.ok(onTarget(dir, base), "and the target's history still contains the base it started from");
  assert.equal(
    existsSync(join(dir, "rejected.txt")),
    false,
    "the rejected candidate's file is not on the target — a record that says 'failed' means nothing landed",
  );
  assert.equal(existsSync(join(dir, "blocked.txt")), false, "nor is the parked attempt's");
});

// ─── (5) AD-3 preflight: a deeper prefix collision, refused before the ref moves ─
//
// The two shapes the fix names are `foo` vs `foo/bar` at one level. Git's file-vs-
// directory rule is not depth-limited: a candidate that writes `a/b/c.txt` needs `a/b`
// to be a DIRECTORY, and an untracked FILE there collides just as hard — two levels
// down, where an exact-equality check and a one-level prefix check both miss it.

test("FG-425 (AC3): candidate writes `a/b/c.txt`; the operator holds an untracked FILE at `a/b` — refused BEFORE the ref moves", async () => {
  const { dir, base } = makeProject("fg425-corr-deep-");
  const key = projectIdentity(dir).key;
  const branch = taskBranch(dir, "run-deep", "a/b/c.txt", "the candidate's nested file\n");

  // The operator's own FILE sits where the candidate needs a directory, two deep.
  mkdirSync(join(dir, "a"), { recursive: true });
  const operatorFile = join(dir, "a", "b");
  writeFileSync(operatorFile, "the operator's UNTRACKED note — never destroy this\n");

  const out = await publishIntegration({
    runId: "run-deep", taskId: "task-deep", projectDir: dir,
    sources: [{ branch, label: "deep" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });

  assert.equal(out.kind, "parked", `a file/directory collision is AD-3's named blocker: ${JSON.stringify(out)}`);
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "dirty_publish_target", "classified dirty_publish_target, not a fallback refusal");
  assert.match(out.error, /a\/b/, "and it names the operator's offending path");
  assert.doesNotMatch(
    out.error,
    /could not be updated|ROLLED BACK/,
    "it must NOT be a CheckoutSyncError in disguise — that one is discovered on the FAR SIDE of the ref advance, " +
      "which is the bug AC3 exists to close",
  );
  assert.equal(
    readTargetSha(localTargetFor(dir)),
    base,
    "THE ORDERING: the ref is provably UNCHANGED. The collision is caught by the preflight, before the CAS.",
  );
  assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=no"]), "", "nothing staged, nothing to clean up");
  assert.equal(
    readFileSync(operatorFile, "utf8"),
    "the operator's UNTRACKED note — never destroy this\n",
    "and the operator's file is byte-for-byte untouched — never deleted, stashed, moved, or checked out over",
  );
  assertRecordsTellTheTruth(dir, key);
});

// ─── (6) prefix-awareness must not become OVER-refusal ─────────────────────────
//
// The other half of AC3, and the one a collision-hunting test can quietly break: an
// untracked file that does NOT collide must still publish. `git ls-files --others`
// lists FILES, so a sibling in a directory the candidate writes into shares a path
// PREFIX with it and nothing more. If prefix-awareness refused on that, AD-3 would
// park every publication in any repo with a stray untracked file next to the work —
// a "fix" that trades a rare corruption for a permanent blocker.

test("FG-425 (AC3): an untracked SIBLING in a directory the candidate writes into does NOT collide — the publication lands and the operator's file survives", async () => {
  const { dir } = makeProject("fg425-corr-sibling-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);
  const branch = taskBranch(dir, "run-sibling", "pkg/new.ts", "export const shipped = 1;\n");

  // The operator's untracked scratch file, in the very directory the candidate writes
  // into. It shares the prefix `pkg` with the candidate's path — and collides with
  // nothing: git puts both in the same directory happily.
  mkdirSync(join(dir, "pkg"), { recursive: true });
  const operatorFile = join(dir, "pkg", "notes.md");
  writeFileSync(operatorFile, "the operator's scratch notes\n");

  const out = await publishIntegration({
    runId: "run-sibling", taskId: "task-sibling", projectDir: dir,
    sources: [{ branch, label: "sibling" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });

  assert.equal(
    out.kind,
    "published",
    "a NON-colliding untracked file must not block a publication. Prefix-awareness is about git's file-vs-directory " +
      "rule, not about sharing a parent directory — refusing here would park every publication in any repo that " +
      `has a stray untracked file next to the candidate's work: ${JSON.stringify(out)}`,
  );
  if (out.kind !== "published") return;

  assert.equal(readTargetSha(target), out.publishedSha, "the candidate landed");
  assert.equal(readFileSync(join(dir, "pkg", "new.ts"), "utf8"), "export const shipped = 1;\n", "and its file is there");
  assert.equal(
    readFileSync(operatorFile, "utf8"),
    "the operator's scratch notes\n",
    "next to the operator's untracked file, byte-for-byte intact — the checkout wrote around it",
  );
  assert.equal(
    git(dir, ["status", "--porcelain"]),
    "?? pkg/notes.md",
    "and the ONLY thing `git status` reports is the operator's own untracked file: nothing of forge's is left behind",
  );
  assertRecordsTellTheTruth(dir, key);
});

// ─── (7) the rollback boundary — the complement of AC1 ─────────────────────────
//
// AC1 forbids a target mutation once ownership is lost, INCLUDING the rollback of the
// publisher's own ref advance. It does not forbid the rollback itself: while ownership
// is currently proven, a checkout that genuinely fails must still be undone by CAS, or
// the ref would keep a candidate whose tree never landed and every later publication
// would read the difference as operator dirt.
//
// The failure here is REAL, not injected: the target holds a tracked directory the
// operator has made read-only, so `read-tree -m -u` cannot create the file the
// candidate adds inside it. AD-3's preflight cannot see this — the tree is clean and
// there are no untracked files — so it is exactly the post-CAS checkout failure the
// rollback exists for.

test("FG-425 (AC1, complement): a checkout that fails while ownership IS proven rolls the ref back by CAS — the target is left byte-for-byte where it started", async () => {
  const { dir, base } = makeProject("fg425-corr-rollback-");
  const key = projectIdentity(dir).key;
  const target = localTargetFor(dir);

  // A tracked directory on the target...
  commit(dir, "locked/keep.txt", "tracked\n");
  const baseWithDir = git(dir, ["rev-parse", "HEAD"]);
  // ...into which the candidate adds a file...
  const branch = taskBranch(dir, "run-rollback", "locked/added.txt", "the candidate's file\n");
  // ...and which the operator has made read-only. The checkout will fail on it.
  const lockedDir = join(dir, "locked");
  chmodSync(lockedDir, 0o500);
  readOnly.push(lockedDir);

  const out = await publishIntegration({
    runId: "run-rollback", taskId: "task-rollback", projectDir: dir,
    sources: [{ branch, label: "rollback" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });

  assert.equal(out.kind, "refused", `a checkout that cannot be applied is a REFUSAL: ${JSON.stringify(out)}`);
  if (out.kind !== "refused") return;
  assert.match(out.error, /ROLLED BACK|rolled back/i, "and it reports the ref advance as rolled back");

  assert.equal(
    readTargetSha(target),
    baseWithDir,
    "THE ROLLBACK RAN: ownership was proven for it, so the publisher undid its own ref advance by CAS. Leaving the " +
      "ref at the candidate with the tree at the base is the wedge — every later AD-3 pre-check reads the diff as " +
      "operator dirt and refuses forever.",
  );
  assert.equal(
    git(dir, ["status", "--porcelain"]),
    "",
    "the target is byte-for-byte where it started — nothing published, nothing staged, nothing to clean up",
  );
  assert.equal(existsSync(join(dir, "locked", "added.txt")), false, "the candidate's file is not on the target");
  assert.notEqual(readTargetSha(target), base, "(the pre-existing tracked directory is still there, of course)");

  const attempt = publicationAttemptsForProject(key)[0]!;
  assert.equal(attempt.state, "failed", "the record says the attempt failed");
  assert.equal(attempt.publishedSha, undefined, "and claims no publication");
  assertRecordsTellTheTruth(dir, key);

  // The next publication is NOT blocked — that is what "rolled back" has to mean.
  chmodSync(lockedDir, 0o700);
  const clean = taskBranch(dir, "run-after", "after.txt", "the next run's work\n");
  const next = await publishIntegration({
    runId: "run-after", taskId: "task-after", projectDir: dir,
    sources: [{ branch: clean, label: "after" }],
    lane: { pollMs: 10, log: () => {} }, alsoValidate: ok,
  });
  assert.equal(next.kind, "published", `the rolled-back target must not block the next publication: ${JSON.stringify(next)}`);
  assert.equal(git(dir, ["status", "--porcelain"]), "", "and it publishes onto a clean target");
  assertRecordsTellTheTruth(dir, key);
});
