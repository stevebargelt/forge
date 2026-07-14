// FG-425 build-phase fixes: the correctness defects the build reds found in the
// first cut of the publisher, each pinned by the property it broke.
//
//   (1) the mutex wait renews the lane lease — a live holder blocked on the mutex
//       must never be taken over (the FIFO break the lease exists to prevent)
//   (2) an untracked file the candidate would clobber is REFUSED before ANY
//       mutation (AD-3), and the target ref is provably unchanged
//   (3) publishedSha IS the recorded candidateSha (AD-6) — never a readback of the
//       target, which an external writer can race
//   (4) a taken-over lane owner reaches a DEFINED terminal state: no TypeError, no
//       hang, a named reason
//   (5) AD-5 recovery reads the RECORDED target ref — it works on a detached HEAD,
//       and never re-derives the branch from the repo's current HEAD

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  getPublicationAttempt,
  laneForProject,
  laneTick,
  publicationMutexHolder,
  recordPublicationIntent,
  releasePublicationMutex,
  setPublicationClockOffsetForTest,
  storeNowMs,
  tryAcquirePublicationMutex,
  tryAcquirePublicationMutexAsLaneOwner,
  updatePublicationAttempt,
} from "../store/publications.js";
import { insertRun } from "../store/runs.js";
import { newAttemptId } from "../util/ids.js";
import { projectIdentity } from "./project-identity.js";
import {
  MUTEX_TTL_MS,
  publishIntegration,
  recoverPublicationAttempt,
  recoverUnfinishedPublications,
  type ValidationResult,
} from "./integration-publisher.js";
import { readTargetSha, localTargetFor, WINDOW_GIT_TIMEOUT_MS } from "./publication-target.js";
import { LANE_BASE_TTL_MS } from "./publication-lane.js";

let prevDb: DatabaseInstance | null;
const cleanup: string[] = [];

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prevDb as DatabaseInstance);
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function makeProject(runId: string, workFile = "agent-work.txt"): { dir: string; branch: string; taskSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "fg425-fix-"));
  cleanup.push(dir);
  git(dir, ["init", "-b", "main"]);
  commit(dir, "seed.txt", "seed\n");
  const branch = `forge/${runId}/task-build-1`;
  git(dir, ["checkout", "-q", "-b", branch]);
  const taskSha = commit(dir, workFile, "the agent's output\n");
  git(dir, ["checkout", "-q", "main"]);
  insertRun({
    id: runId,
    workflow: "fg425",
    title: "fg425 fix test",
    status: "active",
    projectDir: dir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
  return { dir, branch, taskSha };
}

const ok = (): ValidationResult => ({ ok: true });

// ─── (1) the mutex wait renews the lease ─────────────────────────────────────
//
// THE REGRESSION: the lease was renewed across the LANE wait and across the
// VALIDATION span, but NOT across the wait for the publication mutex. A holder
// that reached the mutex and blocked there — behind another project's slow
// checkout, behind a crashed holder's TTL — stopped renewing, lapsed, and was
// marked `abandoned` by the next attempt's tick. That is exactly the FIFO break
// the lease exists to prevent, reintroduced one span later.
//
// The proof holds the mutex out from under a live publisher for LONGER than a
// full lease TTL, then asserts it still published and its lane entry was never
// taken over.

test("FG-425 (finding 3): a lease holder BLOCKED on the publication mutex is not taken over — every blocking span renews", async () => {
  const runId = "run-mutexwait";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);

  // A squatter holds the mutex. It is NOT our attempt, and its TTL is long, so the
  // publisher below can only get in once we release it by hand.
  const squatter = "attempt-squatter";
  const got = tryAcquirePublicationMutex({ projectKey: key, attemptId: squatter, runId: "run-other", ttlMs: 600_000 });
  assert.equal(got.acquired, true, "the squatter takes the mutex first");

  const publishing = publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });

  // Wait until the publisher is demonstrably INSIDE the mutex wait: it has recorded
  // `publishing` (set immediately before acquireMutex) but cannot proceed.
  const attemptId = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const entry = laneForProject(key)[0];
      if (entry) {
        const a = getPublicationAttempt(entry.attemptId);
        if (a?.state === "publishing") return entry.attemptId;
      }
      assert.ok(Date.now() < deadline, "publisher never reached the mutex wait");
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  })();

  // Now sit in the mutex wait for longer than a whole lease TTL would survive
  // WITHOUT renewal. The publisher polls the mutex every 250ms; each poll must
  // push the lease out. We sample the lease twice, far enough apart to see it move.
  const leaseBefore = laneForProject(key).find((e) => e.attemptId === attemptId)!.leaseExpiresAtMs;
  await new Promise<void>((r) => setTimeout(r, 800));
  const leaseAtMutexWait = laneForProject(key).find((e) => e.attemptId === attemptId)!.leaseExpiresAtMs;
  assert.ok(
    leaseAtMutexWait > leaseBefore,
    "the lane lease must be RENEWED while the owner is blocked on the publication mutex — " +
      `it did not move (${leaseBefore} → ${leaseAtMutexWait}). An un-renewed blocking span lets a live ` +
      "holder lapse and be taken over: the FIFO break the lease exists to prevent.",
  );
  // And it is genuinely in the future — a lapsed lease is what a takeover keys on.
  assert.ok(leaseAtMutexWait > storeNowMs(), "the blocked owner's lease is still live, so it is not evictable");

  // A CONTENDING tick (what a second forge process does) must NOT take it over.
  const contender = newAttemptId();
  recordPublicationIntent({
    attemptId: contender,
    projectKey: key,
    canonicalDir: dir,
    runId: "run-contender",
    taskId: "t2",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  const turn = laneTick(contender, LANE_BASE_TTL_MS);
  assert.equal(turn.ready, false, "the contender is behind the live holder and must wait");
  assert.equal(
    laneForProject(key).find((e) => e.attemptId === attemptId)!.state,
    "holding",
    "the live holder must NOT have been marked abandoned while it waited on the mutex",
  );

  // Let it through; it must publish normally.
  releasePublicationMutex(key, squatter);
  const out = await publishing;
  assert.equal(out.kind, "published", `blocked-on-mutex publisher must still publish: ${JSON.stringify(out)}`);
  if (out.kind !== "published") return;
  assert.equal(out.publishedSha, out.candidateSha, "AD-6");
});

// ─── (2) an untracked file the candidate would clobber is REFUSED ─────────────
//
// THE DEFECT: `git read-tree -m -u` refuses to overwrite an UNTRACKED file, but
// the AD-3 dirty pre-check ignored untracked files entirely. So the ref advanced,
// the checkout sync then failed, publishedSha was never recorded, and the target
// was left with its ref ahead of its index — which every LATER publication's AD-3
// check reads as tracked dirt. One publication wedged the project permanently.
//
// The fix refuses BEFORE any mutation, with a named blocker. It never deletes,
// stashes, or checks out over the operator's file.

test("FG-425 (finding 4): an UNTRACKED file the candidate would clobber is refused BEFORE any mutation — the target ref is unchanged", async () => {
  const runId = "run-untracked";
  // The agent's branch adds `collide.txt`...
  const { dir, branch } = makeProject(runId, "collide.txt");
  const baseBefore = readTargetSha(localTargetFor(dir));

  // ...and the operator has an untracked file of the same name sitting in the target.
  writeFileSync(join(dir, "collide.txt"), "the operator's UNTRACKED work — never destroy this\n");

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });

  assert.equal(out.kind, "parked", `expected a named park, got ${JSON.stringify(out)}`);
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "dirty_publish_target", "AD-3's named blocker, not a generic failure");
  assert.match(out.error, /untracked/i, "the blocker must name WHAT it refused on");
  assert.match(out.error, /collide\.txt/, "the blocker must name the offending file");

  // NOTHING was mutated. This is the whole point of refusing before the window.
  assert.equal(
    readTargetSha(localTargetFor(dir)),
    baseBefore,
    "the target ref must be provably UNCHANGED — the refusal happens before any mutation",
  );
  assert.equal(
    readFileSync(join(dir, "collide.txt"), "utf8"),
    "the operator's UNTRACKED work — never destroy this\n",
    "the operator's untracked file must be byte-for-byte untouched — forge never deletes or stashes it",
  );
  // No staged dirt: the index is clean, so the NEXT publication is not blocked.
  assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=no"]), "", "no staged/tracked dirt left behind");

  // And the durable record says so.
  const attempt = getPublicationAttempt(out.attemptId);
  assert.equal(attempt?.state, "parked");
  assert.equal(attempt?.parkReason, "dirty_publish_target");
  assert.equal(attempt?.publishedSha, undefined, "nothing was published, so nothing is recorded as published");
});

// ─── (3) publishedSha is the RECORDED candidateSha, never a readback ──────────
//
// THE DEFECT: publishedSha was read BACK from the target after the CAS. An
// external writer landing between the CAS and the readback would make a
// publication that ACTUALLY LANDED look like one that didn't — parking it as
// publish_base_churn while its commit sat on the target. AD-6 is explicit:
// publication binds to the recorded immutable candidateSha.

test("FG-425 (finding 5): publishedSha === the RECORDED candidateSha even when the target is mutated concurrently", async () => {
  const runId = "run-readback";
  const { dir, branch } = makeProject(runId);

  let candidateAtValidation = "";
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_dir, candidateSha) => {
      candidateAtValidation = candidateSha;
      return ok();
    },
    // Fires inside the publication window, after the ref has advanced to our
    // candidate. An EXTERNAL writer moves the target off it, right where the old
    // readback would have looked.
    afterRefAdvance: () => {
      const external = commit(dir, "external-writer.txt", "someone else pushed\n");
      assert.notEqual(external, candidateAtValidation);
    },
  });

  assert.equal(out.kind, "published", `the publication DID land and must be reported as landed: ${JSON.stringify(out)}`);
  if (out.kind !== "published") return;
  assert.equal(
    out.publishedSha,
    candidateAtValidation,
    "publishedSha must BE the recorded candidateSha — never re-derived from the target, which an external " +
      "writer can race. A readback here would have parked a publication that actually landed.",
  );
  assert.equal(out.publishedSha, out.candidateSha, "AD-6, as the AC states it");

  const attempt = getPublicationAttempt(out.attemptId);
  assert.equal(attempt?.publishedSha, candidateAtValidation, "the durable record binds to the recorded SHA too");
  assert.notEqual(attempt?.parkReason, "publish_base_churn", "an external writer must not retro-park a landed publish");
});

// ─── (4) a taken-over lane owner reaches a DEFINED terminal state ─────────────
//
// THE DEFECT: laneTick asserted an invariant a takeover falsifies. An owner whose
// lease lapsed (but which is ALIVE) gets marked `abandoned` by another process. On
// its next tick it could neither become head nor exit: it either dereferenced an
// undefined `head` (TypeError) or waited forever — production passes no maxWaitMs,
// so "forever" is literal.

test("FG-425 (finding 6): an owner whose lane entry was TAKEN OVER parks with a named reason — no TypeError, no hang", async () => {
  const runId = "run-takenover";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);
  const baseBefore = readTargetSha(localTargetFor(dir));

  // Our attempt is on the lane and holding...
  const mine = newAttemptId();
  recordPublicationIntent({
    attemptId: mine,
    projectKey: key,
    canonicalDir: dir,
    runId,
    taskId: "task-build-1",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  assert.equal(laneTick(mine, LANE_BASE_TTL_MS).ready, true, "we are head of the lane");

  // ...and a later attempt finds our lease lapsed and takes the lane over. (Written
  // directly, because AD-7 forbids any liveness probe: a takeover is nothing but a
  // durable timestamp being in the past.)
  const later = newAttemptId();
  recordPublicationIntent({
    attemptId: later,
    projectKey: key,
    canonicalDir: dir,
    runId: "run-later",
    taskId: "t2",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  expireLease(mine);
  const laterTurn = laneTick(later, LANE_BASE_TTL_MS);
  assert.equal(laterTurn.ready, true, "the later attempt skips the expired entry and becomes head");
  assert.equal(
    laneForProject(key).find((e) => e.attemptId === mine)!.state,
    "abandoned",
    "our entry was marked abandoned by the takeover",
  );

  // Our own next tick must be TERMINAL and NAMED — not a throw, not a wait.
  const myTurn = laneTick(mine, LANE_BASE_TTL_MS);
  assert.equal(myTurn.ready, false);
  assert.equal(myTurn.ready === false && myTurn.takenOver, true, "a taken-over owner is told so, explicitly");

  // And end to end: a publisher that gets taken over PARKS with a named reason,
  // publishes nothing, and returns. It must not hang — production passes no
  // maxWaitMs, so a hang here would be a hang forever.
  const taken = newAttemptId();
  recordPublicationIntent({
    attemptId: taken,
    projectKey: key,
    canonicalDir: dir,
    runId: "run-victim",
    taskId: "t3",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  // Publish through the real path, but with our lane entry already stolen.
  const victim = publishIntegration({
    runId: "run-victim",
    taskId: "t3",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });
  // The publisher minted its OWN attempt; steal that one the moment it appears.
  const stolen = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const entry = laneForProject(key).find(
        (e) => e.runId === "run-victim" && e.attemptId !== taken && (e.state === "queued" || e.state === "holding"),
      );
      if (entry) return entry.attemptId;
      assert.ok(Date.now() < deadline, "the victim never enqueued");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  })();
  markLaneAbandoned(stolen);

  const out = await withTimeout(victim, 15_000, "a taken-over publisher HUNG — it must reach a terminal state");
  assert.equal(out.kind, "parked", `a taken-over owner must PARK, got ${JSON.stringify(out)}`);
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "lane_taken_over", "and the reason must be NAMED");
  assert.equal(
    readTargetSha(localTargetFor(dir)),
    baseBefore,
    "a taken-over attempt publishes NOTHING — every target mutation is downstream of the lane turn it lost",
  );
});

// ─── (5) AD-5 recovery reads the RECORDED target ref ──────────────────────────
//
// THE DEFECT: recovery re-derived the local target from the repo's CURRENT HEAD
// (localTargetFor → `git symbolic-ref HEAD`), discarding the branch RECORDED on the
// attempt. An operator who checked out another branch after the crash would have
// recovery read the WRONG ref and park a publication that actually landed; on a
// DETACHED HEAD it threw outright. AD-5 is explicit: recover from the recorded
// {baseSha, candidateSha, currentTargetSha} and the recorded TARGET.

test("FG-425 (finding 7): AD-5 recovery uses the RECORDED target ref — it works on a DETACHED HEAD", async () => {
  const runId = "run-detached";
  const { dir, branch } = makeProject(runId);

  // Crash INSIDE the publication window: the ref advances, the checkout never runs.
  let candidateSha = "";
  await assert.rejects(
    publishIntegration({
      runId,
      taskId: "task-build-1",
      projectDir: dir,
      sources: [{ branch, label: "task" }],
      lane: { pollMs: 10, log: () => {} },
      alsoValidate: (_d, sha) => { candidateSha = sha; return ok(); },
      afterRefAdvance: () => { throw new Error("simulated crash inside the publication window"); },
    }),
    /simulated crash/,
  );

  // The durable state a real crash leaves: ref advanced, attempt still `publishing`.
  assert.equal(readTargetSha(localTargetFor(dir)), candidateSha, "the ref advanced before the crash");
  const attemptId = laneForProject(projectIdentity(dir).key)[0]!.attemptId;
  assert.equal(getPublicationAttempt(attemptId)?.state, "publishing", "the attempt is stuck mid-window");
  assert.equal(getPublicationAttempt(attemptId)?.publishedSha, undefined, "publishedSha was never recorded");

  // Now the operator detaches HEAD — inspecting an old commit, say. The recorded
  // target ref (refs/heads/main) is untouched; the AMBIENT one is gone.
  git(dir, ["checkout", "-q", "--detach", "HEAD"]);
  assert.throws(() => localTargetFor(dir), /detached HEAD/, "the ambient target cannot even be resolved now");

  // Recovery must still converge, from the RECORDED target.
  const recovered = recoverPublicationAttempt(attemptId);
  assert.equal(recovered.kind, "published", `recovery must see the publication that LANDED: ${JSON.stringify(recovered)}`);
  if (recovered.kind !== "published") return;
  assert.equal(recovered.publishedSha, candidateSha, "AD-6: bound to the recorded candidateSha");
  assert.equal(getPublicationAttempt(attemptId)?.state, "published", "and the record converges on the truth the REF tells");
  assert.equal(getPublicationAttempt(attemptId)?.publishedSha, candidateSha);
});

// ─── (6) AD-5 recovery actually RUNS, without a human typing anything ─────────

test("FG-425 (finding 8): an attempt left mid-window is recovered ON THE RUN PATH, not left for a human to notice", async () => {
  const runId = "run-autorecover";
  const { dir, branch } = makeProject(runId);

  let candidateSha = "";
  await assert.rejects(
    publishIntegration({
      runId,
      taskId: "task-build-1",
      projectDir: dir,
      sources: [{ branch, label: "task" }],
      lane: { pollMs: 10, log: () => {} },
      alsoValidate: (_d, sha) => { candidateSha = sha; return ok(); },
      afterRefAdvance: () => { throw new Error("simulated crash inside the publication window"); },
    }),
    /simulated crash/,
  );

  const attemptId = laneForProject(projectIdentity(dir).key)[0]!.attemptId;
  assert.equal(getPublicationAttempt(attemptId)?.state, "publishing");
  // The working tree is BEHIND the ref — the AD-5 window, exactly.
  assert.equal(existsSync(join(dir, "agent-work.txt")), false, "the checkout never ran");

  // This is what runNext calls at the top of every wave. No operator, no command.
  recoverUnfinishedPublications(dir, runId);

  const attempt = getPublicationAttempt(attemptId);
  assert.equal(attempt?.state, "published", "the crashed attempt is converged automatically");
  assert.equal(attempt?.publishedSha, candidateSha, "AD-6");
  assert.equal(existsSync(join(dir, "agent-work.txt")), true, "and the outstanding checkout was completed");
  // Idempotent: running it again is a no-op, not a second publication.
  recoverUnfinishedPublications(dir, runId);
  assert.equal(getPublicationAttempt(attemptId)?.publishedSha, candidateSha);
});

// ─── (7) the recovery sweep never touches a LIVE attempt ─────────────────────
//
// The counterpart to the sweep: `publishing` means "the target MAY already have
// been mutated", and that is true both of an attempt whose owner CRASHED and of one
// whose owner is inside its window RIGHT NOW, in another forge process. Converging
// the second would run a checkout underneath a publisher that is still working, and
// could mark a live attempt `abandoned` before it had even advanced the ref.
//
// They are told apart the only way AD-7 permits: by the LEASE. Nothing is probed.

test("FG-425: the run-path recovery sweep skips a LIVE in-window attempt — only a lapsed lease is recoverable", async () => {
  const runId = "run-livewindow";
  const { dir } = makeProject(runId);
  const { key } = projectIdentity(dir);
  const base = readTargetSha(localTargetFor(dir));

  // An attempt that is `publishing` and whose owner is ALIVE (lease in the future,
  // lane entry holding) — the shape of a forge process inside its CAS window.
  const live = newAttemptId();
  recordPublicationIntent({
    attemptId: live,
    projectKey: key,
    canonicalDir: dir,
    runId,
    taskId: "task-live",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  laneTick(live, LANE_BASE_TTL_MS);
  updatePublicationAttempt(live, { baseSha: base, candidateSha: base, state: "publishing" });

  recoverUnfinishedPublications(dir, runId);

  assert.equal(
    getPublicationAttempt(live)?.state,
    "publishing",
    "a LIVE attempt inside its publication window must NOT be recovered out from under its owner — " +
      "its lease is current, and a lease is the only liveness signal AD-7 allows",
  );

  // Once its lease lapses, it IS recoverable: the owner is gone.
  expireLease(live);
  recoverUnfinishedPublications(dir, runId);
  assert.notEqual(
    getPublicationAttempt(live)?.state,
    "publishing",
    "an attempt whose lease has lapsed is abandoned, and the sweep converges it",
  );
});

// ─── the publication mutex covers the WHOLE window, not a fixed 120s ──────────
//
// THE DEFECT: the mutex was taken with a fixed 120s TTL and never renewed, while
// the window it covers (CAS → ref advance → `read-tree -m -u`) is a SYNCHRONOUS
// span with no ceiling — no timer can fire inside an execFileSync, so a heartbeat
// could not renew it either. A checkout slower than the TTL (a big tree, a slow
// disk, a loaded machine) left the holder mid-write with a lease that read as
// lapsed, and a second attempt would take the mutex over and enter its OWN
// CAS+checkout concurrently. The CAS still protects ref ancestry — but nothing
// serialized the two WORKING-TREE updates, which is exactly the same-project
// non-interleaving guarantee this ticket exists to provide.
//
// THE FIX, in two halves that only work together:
//   - every git op inside the window is BOUNDED (WINDOW_GIT_TIMEOUT_MS, enforced by
//     execFileSync, which kills the child)
//   - the holder RENEWS its lease before each op, and the TTL is DERIVED from that
//     per-op ceiling — so a live holder can never be inside the window when its
//     lease lapses, and a renewal that finds the mutex gone FAILS CLOSED.

test("FG-425: MUTEX_TTL_MS is derived from the per-op ceiling — a bounded op can never outlive the lease", () => {
  assert.ok(
    MUTEX_TTL_MS > WINDOW_GIT_TIMEOUT_MS,
    "the mutex TTL must exceed the ceiling on the longest single git op in the window " +
      `(${MUTEX_TTL_MS}ms vs ${WINDOW_GIT_TIMEOUT_MS}ms). The holder renews BETWEEN ops — it cannot renew ` +
      "DURING one, because the window is a synchronous span. So this inequality is the whole proof that a live " +
      "holder's lease cannot lapse mid-checkout and let a second attempt into the working tree.",
  );
});

test("FG-425: a checkout that outlives the OLD fixed TTL keeps the mutex — no second attempt can enter the tree", async () => {
  const runId = "run-slowcheckout";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);

  // Inside the window, with the ref advanced and the checkout still to run: age the
  // store clock past what the OLD fixed 120s TTL would have survived. This is a slow
  // `read-tree`, faithfully — the clock is the only thing a takeover ever reads.
  let holderStillOwnedIt: boolean | undefined;
  let contenderLockedOut: boolean | undefined;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
    afterRefAdvance: () => {
      setPublicationClockOffsetForTest(WINDOW_GIT_TIMEOUT_MS + 30_000);
      const holder = publicationMutexHolder(key);
      holderStillOwnedIt = !!holder && holder.expiresAtMs > storeNowMs();
      contenderLockedOut = !tryAcquirePublicationMutex({
        projectKey: key,
        attemptId: "attempt-contender",
        runId: "run-contender",
        ttlMs: MUTEX_TTL_MS,
      }).acquired;
    },
  });

  assert.equal(
    holderStillOwnedIt,
    true,
    "a publisher mid-checkout, 150s into its window, must STILL hold a live mutex lease — under the old fixed " +
      "120s TTL it had already lapsed, with the ref advanced and the working tree half-updated",
  );
  assert.equal(
    contenderLockedOut,
    true,
    "and a second attempt must therefore be REFUSED the mutex. The CAS protects ref ancestry; only the mutex " +
      "serializes the two working-tree updates, so a takeover here is the concurrency break itself.",
  );
  assert.equal(out.kind, "published", `the slow-but-live publisher still publishes: ${JSON.stringify(out)}`);
});

test("FG-425: a publisher that LOST the mutex fails closed — it never checks out over the attempt that took it", async () => {
  const runId = "run-mutexlost";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);
  const target = localTargetFor(dir);
  const base = readTargetSha(target);

  // Inside the window: push the clock past even the NEW TTL and let a contender take
  // the mutex over. The holder's next renewal — the one before `read-tree` — must
  // find the window gone and refuse to touch the tree.
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
    afterRefAdvance: () => {
      setPublicationClockOffsetForTest(MUTEX_TTL_MS + 60_000);
      const stolen = tryAcquirePublicationMutex({
        projectKey: key,
        attemptId: "attempt-thief",
        runId: "run-thief",
        ttlMs: MUTEX_TTL_MS,
      });
      assert.equal(stolen.acquired, true, "with the lease genuinely lapsed, a later attempt DOES take the window");
    },
  });

  assert.equal(out.kind, "refused", `a publisher that lost the mutex must refuse, not publish: ${JSON.stringify(out)}`);
  assert.match(
    (out as { error: string }).error,
    /no longer holds the publication mutex/,
    "and the refusal must NAME the lost window rather than surface as some incidental git error",
  );
  assert.notEqual(
    readTargetSha(target),
    base,
    "the ref advance is NOT rolled back: a rollback is a target mutation, and this attempt can no longer prove it " +
      "owns the window. The attempt that took the mutex may already have synchronized index and worktree onto the " +
      "candidate, and an unguarded CAS undo would strand the target at ref=base with the tree at the candidate.",
  );
  assert.equal(
    existsSync(join(dir, "agent-work.txt")),
    false,
    "and the working tree was NEVER updated: the checkout is the write the mutex exists to serialize",
  );
  assert.equal(
    getPublicationAttempt(attemptOf(key))?.state,
    "publishing",
    "the durable publishing intent STANDS — {baseSha, candidateSha, target} is what the mutex's current owner " +
      "converges the target from through AD-5 recovery. A record rewritten to `failed` here would tell recovery " +
      "there is nothing to converge, with the ref already carrying the candidate.",
  );
  assert.equal(
    publicationMutexHolder(key)?.attemptId,
    "attempt-thief",
    "releasing our own mutex must not unlink the holder that took it over from us",
  );
});

// ─── (9) AD-1 of the ownership invariant: an ACTIVE thief ─────────────────────
//
// THE DEFECT (FG-425 AC1): the checkout-failure path rolled the ref advance back by
// an UNGUARDED CAS, on the theory that a CAS on a ref we ourselves wrote is safe
// with or without the mutex. It is not — because the mutex is what serializes the
// WORKING TREE, and the attempt that takes it does not merely sit there:
//
//   1. A advances the ref from base to candidate C.
//   2. A's mutex lease lapses.
//   3. B takes the window and AD-5-recovers: index and worktree are synchronized
//      onto C, which is what the REF says is published.
//   4. A resumes; its renewal finds the window gone.
//   5. A's catch rolls the REF back to base — a mutation performed by a process that
//      demonstrably owns nothing.
//
// Final state: ref=base, index/worktree=C. Every file of the candidate now reads as
// tracked dirt, so every LATER publication's AD-3 pre-check refuses: the target is
// wedged, and the publication B legitimately converged has been un-published behind
// its back.
//
// The invariant is absolute: once a publisher discovers it no longer owns the mutex,
// it executes NO target-mutating command — not update-ref, not read-tree, not
// cleanup. It leaves the durable intent for the mutex's owner to converge.

test("FG-425 (AC1): a publisher that lost the mutex to an ACTIVE thief mutates NOTHING — no rollback, and the target converges on the candidate", async () => {
  const runId = "run-active-thief";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);
  const target = localTargetFor(dir);
  const base = readTargetSha(target);

  let candidateSha = "";
  let refAfterThief = "";
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_d, sha) => { candidateSha = sha; return ok(); },
    // Inside the window, with our ref advance ALREADY on the target: our lease
    // lapses, and B — a real publisher, not a squatter — takes over and does the
    // work the ref entitles it to. It runs the AD-5 sweep (which takes the window
    // from our lapsed lease, converges the tree onto C, and records the truth), then
    // holds the window as the current owner.
    afterRefAdvance: () => {
      setPublicationClockOffsetForTest(MUTEX_TTL_MS + 60_000);
      recoverUnfinishedPublications(dir, "run-thief");
      const stolen = tryAcquirePublicationMutex({
        projectKey: key,
        attemptId: "attempt-thief",
        runId: "run-thief",
        ttlMs: MUTEX_TTL_MS,
      });
      assert.equal(stolen.acquired, true, "setup: with the lease genuinely lapsed, B takes the window");
      refAfterThief = readTargetSha(target);
    },
  });

  // What B left: the ref carries C and the tree was synchronized onto it.
  assert.equal(refAfterThief, candidateSha, "setup: B recovered the tree onto the candidate the REF already carried");
  assert.equal(readFileSync(join(dir, "agent-work.txt"), "utf8"), "the agent's output\n", "setup: B's checkout ran");

  // ── A resumes with the window gone, and touches NOTHING ─────────────────────
  assert.equal(
    readTargetSha(target),
    candidateSha,
    "the ref must STILL carry the candidate. A rolled it back to the base here — an update-ref executed by a " +
      "process that had already discovered it owns nothing, un-publishing what B had just converged.",
  );
  assert.notEqual(readTargetSha(target), base, "the ref was NOT rolled back to the base");

  // ref, index and tracked worktree ALL converge on C. A dirty status is the exact
  // signature of the rollback: ref=base with the candidate's content on disk.
  assert.equal(
    git(dir, ["status", "--porcelain"]),
    "",
    "index and worktree agree with the ref — the target is clean and converged on the candidate, not left " +
      "divergent (ref=base, tree=candidate) by an unowned rollback",
  );
  assert.equal(git(dir, ["rev-parse", "HEAD"]), candidateSha, "HEAD, the index and the tree are all at C");

  // The durable record tells the truth: the candidate IS published, and A never
  // rewrote the record B converged.
  const attempt = getPublicationAttempt(attemptOf(key));
  assert.equal(attempt?.state, "published", "the record B converged must not be rewritten by the attempt that lost the window");
  assert.equal(attempt?.publishedSha, candidateSha, "AD-6: bound to the recorded candidateSha");
  assert.equal(attempt?.parkReason, undefined, "a landed publication is not retro-parked");

  // And the outcome A reports is that durable truth, not a fabricated failure.
  assert.equal(out.kind, "published", `A must report what the RECORD says, not rewrite it: ${JSON.stringify(out)}`);
  if (out.kind !== "published") return;
  assert.equal(out.publishedSha, candidateSha);

  assert.equal(
    publicationMutexHolder(key)?.attemptId,
    "attempt-thief",
    "and A's own release must not unlink the holder that took the window over from it",
  );
});

// ─── (8) a TAKEN-OVER owner can never enter the publication window ────────────
//
// THE DEFECT: renewal wrote the lease of whatever row it named, and the mutex was
// granted to whoever asked. So an owner taken over during validation — or while
// BLOCKED on the mutex, a span it enters only after the takeover could have landed
// — resurrected its own abandoned lease on the next renewal tick, took the window,
// and published. Two Forge-owned attempts would then be publishing out of FIFO
// order, moving each other's base: exactly what the lane exists to prevent.
//
// The fix fails closed in the same immediate txn that grants the window: renewal is
// scoped to an ACTIVE entry (so it cannot resurrect a terminal one), and the grant
// re-checks lane ownership itself, so a takeover cannot race the check.

test("FG-425 (finding 1): an owner TAKEN OVER while blocked on the mutex never enters the window — it parks", async () => {
  const runId = "run-takenover-at-mutex";
  const { dir, branch } = makeProject(runId);
  const { key } = projectIdentity(dir);
  const baseBefore = readTargetSha(localTargetFor(dir));

  // A squatter holds the window, so our publisher validates and then BLOCKS in the
  // mutex wait — the span where a takeover can land on an owner that is still alive.
  const squatter = "attempt-squatter";
  assert.equal(
    tryAcquirePublicationMutex({ projectKey: key, attemptId: squatter, runId: "run-other", ttlMs: 600_000 }).acquired,
    true,
    "setup: the squatter holds the window",
  );

  const publishing = publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });

  const attemptId = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const entry = laneForProject(key)[0];
      if (entry && getPublicationAttempt(entry.attemptId)?.state === "publishing") return entry.attemptId;
      assert.ok(Date.now() < deadline, "setup: the publisher never reached the mutex wait");
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  })();

  // A later attempt takes the lane over (written directly — AD-7 forbids any probe;
  // a takeover is nothing but a durable timestamp having lapsed).
  markLaneAbandoned(attemptId);
  const leaseAtTakeover = laneForProject(key).find((e) => e.attemptId === attemptId)!.leaseExpiresAtMs;

  // Now let it through the mutex. It must NOT publish: it is no longer in the lane.
  releasePublicationMutex(key, squatter);
  const out = await withTimeout(publishing, 15_000, "a taken-over publisher HUNG in the mutex wait");

  assert.equal(out.kind, "parked", `a taken-over owner must PARK, not publish: ${JSON.stringify(out)}`);
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "lane_taken_over", "and the reason must be NAMED");
  assert.equal(
    readTargetSha(localTargetFor(dir)),
    baseBefore,
    "a taken-over attempt publishes NOTHING — it lost the lane, so it may not move the base of the attempt " +
      "that stepped past it",
  );
  assert.equal(
    publicationMutexHolder(key)?.attemptId,
    undefined,
    "and it never took the publication window at all — the grant re-checks lane ownership in its own txn",
  );

  // The two halves of the fix, each pinned: a terminal entry's lease is NOT
  // resurrected by a renewal, and leaving the lane does not overwrite the takeover.
  assert.equal(
    laneForProject(key).find((e) => e.attemptId === attemptId)!.leaseExpiresAtMs,
    leaseAtTakeover,
    "renewal must not write to an abandoned row — a resurrected lease is a second live owner in the lane",
  );
  assert.equal(
    laneForProject(key).find((e) => e.attemptId === attemptId)!.state,
    "abandoned",
    "the takeover mark is durable evidence; leaving the lane must not paper over it with `done`",
  );
});

test("FG-425 (finding 1): the publisher's mutex grant is refused outright once the lane entry is gone", () => {
  const runId = "run-laneowner-grant";
  const { dir } = makeProject(runId);
  const { key } = projectIdentity(dir);

  const mine = newAttemptId();
  recordPublicationIntent({
    attemptId: mine,
    projectKey: key,
    canonicalDir: dir,
    runId,
    taskId: "task-build-1",
    target: `local:${dir}#main`,
    leaseTtlMs: LANE_BASE_TTL_MS,
  });
  assert.equal(laneTick(mine, LANE_BASE_TTL_MS).ready, true, "setup: we are head of the lane");
  assert.equal(
    tryAcquirePublicationMutexAsLaneOwner({ projectKey: key, attemptId: mine, runId, ttlMs: MUTEX_TTL_MS }).acquired,
    true,
    "an ACTIVE lane owner takes the window normally",
  );
  releasePublicationMutex(key, mine);

  markLaneAbandoned(mine);
  const got = tryAcquirePublicationMutexAsLaneOwner({ projectKey: key, attemptId: mine, runId, ttlMs: MUTEX_TTL_MS });
  assert.equal(got.acquired, false, "a taken-over attempt is refused the window even when NOBODY else holds it");
  assert.equal(got.acquired === false && got.reason, "lane_lost", "and the refusal is NAMED, not a generic contention");
  assert.equal(publicationMutexHolder(key), undefined, "a refused grant writes no lock row");
});

// ─── (10) recovery is IDEMPOTENT w.r.t. TERMINAL records ─────────────────────
//
// THE DEFECT (FG-425 AC2): recovery re-derived every attempt it was handed from the
// CURRENT ref, whatever the attempt's stored state said. So:
//
//   1. A publishes. Its record is `published`, publishedSha = C_a.
//   2. B publishes on top of A. The ref is now C_b.
//   3. Recovery runs for A. The ref is neither A's base nor A's candidate, so the
//      "external writer" branch REWRITES A into parked/publish_base_churn, claiming
//      "nothing from this attempt was published" — while A's commit sits on the
//      target, in the history of everything published since.
//
// That is corruption of durable publication history, and the durable record is the
// only account of what forge published. Only an UNFINISHED attempt (`publishing`) —
// the one state in which the target may already have been mutated — may be
// re-derived from the ref. Terminal records are reported, never rewritten.

test("FG-425 (AC2): recovering a PUBLISHED attempt after a later attempt published on top of it changes NOTHING", async () => {
  const runId = "run-terminal-a";
  const { dir, branch } = makeProject(runId);

  const first = await publishIntegration({
    runId,
    taskId: "task-a",
    projectDir: dir,
    sources: [{ branch, label: "a" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });
  assert.equal(first.kind, "published", `setup: A must publish: ${JSON.stringify(first)}`);
  if (first.kind !== "published") return;

  // B publishes on top of A: the target now carries neither A's base nor A's candidate.
  const secondBranch = "forge/run-terminal-b/task";
  git(dir, ["checkout", "-q", "-b", secondBranch, "main"]);
  commit(dir, "second.txt", "the second agent's output\n");
  git(dir, ["checkout", "-q", "main"]);
  insertRun({
    id: "run-terminal-b",
    workflow: "fg425",
    title: "fg425 fix test",
    status: "active",
    projectDir: dir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
  const second = await publishIntegration({
    runId: "run-terminal-b",
    taskId: "task-b",
    projectDir: dir,
    sources: [{ branch: secondBranch, label: "b" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });
  assert.equal(second.kind, "published", `setup: B must publish on top of A: ${JSON.stringify(second)}`);
  if (second.kind !== "published") return;

  const recordBefore = getPublicationAttempt(first.attemptId);
  const refBefore = readTargetSha(localTargetFor(dir));

  const recovered = recoverPublicationAttempt(first.attemptId);

  assert.deepEqual(
    getPublicationAttempt(first.attemptId),
    recordBefore,
    "A's TERMINAL record must be byte-for-byte unchanged. Re-deriving it from the current ref — which is now B's " +
      "candidate, so neither A's base nor A's candidate — rewrote a `published` attempt into a churn park claiming " +
      "nothing of A ever landed. A's commit is in the history of what B published.",
  );
  assert.equal(recovered.kind, "published", `recovery must REPORT the recorded publication: ${JSON.stringify(recovered)}`);
  if (recovered.kind !== "published") return;
  assert.equal(recovered.publishedSha, first.publishedSha, "including its recorded publishedSha");
  assert.equal(getPublicationAttempt(first.attemptId)?.state, "published", "and its terminal state");
  assert.equal(readTargetSha(localTargetFor(dir)), refBefore, "recovering a settled attempt touches no target either");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "and leaves the target clean");
});

test("FG-425 (AC2): recovery performs NO state transition on any other terminal record", async () => {
  const { dir } = makeProject("run-terminal-others");
  const { key, canonicalDir } = projectIdentity(dir);
  const base = readTargetSha(localTargetFor(dir));
  // A sha the target does NOT carry, so a ref-derived recovery would have something
  // to (wrongly) say about every one of these records.
  const stranger = commit(dir, "stranger.txt", "an external writer's commit\n");
  git(dir, ["reset", "-q", "--hard", base]);
  git(dir, ["clean", "-qfd"]);

  const terminal = [
    { attemptId: "att-failed", state: "failed" as const, candidateSha: base },
    { attemptId: "att-parked-dirty", state: "parked" as const, parkReason: "dirty_publish_target" as const, candidateSha: stranger },
    { attemptId: "att-parked-churn", state: "parked" as const, parkReason: "publish_base_churn" as const, candidateSha: stranger },
    { attemptId: "att-parked-lane", state: "parked" as const, parkReason: "lane_taken_over" as const, candidateSha: base },
    // candidateSha === the current ref: pre-fix, THIS is the record recovery would
    // have promoted to `published` — inventing a publication out of an attempt that
    // was already settled as abandoned.
    { attemptId: "att-abandoned", state: "abandoned" as const, candidateSha: base },
  ];

  for (const t of terminal) {
    recordPublicationIntent({
      attemptId: t.attemptId,
      projectKey: key,
      canonicalDir,
      runId: "run-terminal-others",
      taskId: `task-${t.attemptId}`,
      target: `local:${dir}#main`,
      leaseTtlMs: LANE_BASE_TTL_MS,
    });
    updatePublicationAttempt(t.attemptId, {
      baseSha: base,
      candidateSha: t.candidateSha,
      state: t.state,
      ...(t.parkReason ? { parkReason: t.parkReason } : {}),
    });
  }

  for (const t of terminal) {
    const before = getPublicationAttempt(t.attemptId);
    const outcome = recoverPublicationAttempt(t.attemptId);
    assert.deepEqual(
      getPublicationAttempt(t.attemptId),
      before,
      `recovering a ${t.state}${t.parkReason ? `/${t.parkReason}` : ""} attempt must perform NO state transition — ` +
        "a terminal record is the durable account of what forge did, and recovery is not licensed to rewrite it " +
        `(got ${JSON.stringify(getPublicationAttempt(t.attemptId))})`,
    );
    assert.notEqual(outcome.kind, "unknown_attempt", "and it is still a known attempt, reported with its recorded disposition");
    if (t.state === "parked") {
      assert.equal(outcome.kind, "parked", `a parked attempt reports its stable recorded disposition: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.kind === "parked" && outcome.reason, t.parkReason, "with its RECORDED park reason, not a re-derived one");
    } else {
      assert.equal(outcome.kind, "refused", `a ${t.state} attempt is reported as not recoverable: ${JSON.stringify(outcome)}`);
    }
  }

  assert.equal(readTargetSha(localTargetFor(dir)), base, "and no terminal recovery touched the target");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "or its working tree");
});

// ─── (11) AD-3 collisions are PREFIX-AWARE ───────────────────────────────────
//
// THE DEFECT (FG-425 AC3): the untracked-collision pre-check compared paths by exact
// EQUALITY, but git's collisions are file-vs-directory: a path is one or the other
// and cannot be both. So the two prefix shapes slipped past AD-3 entirely, the ref
// advanced, and `read-tree -m -u` discovered the collision on the FAR SIDE of the
// CAS — reaching the operator as a checkout failure rather than the named blocker,
// having already mutated the target it was supposed to refuse to touch.

test("FG-425 (AC3): candidate adds the FILE `conf`; the operator has untracked `conf/local.txt` — refused before any mutation", async () => {
  const runId = "run-collide-file-over-dir";
  const { dir, branch } = makeProject(runId, "conf");
  const baseBefore = readTargetSha(localTargetFor(dir));

  // The operator's own directory sits where the candidate wants a FILE.
  const operatorFile = join(dir, "conf", "local.txt");
  mkdirSync(join(dir, "conf"), { recursive: true });
  writeFileSync(operatorFile, "the operator's UNTRACKED config — never destroy this\n");

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });

  assertRefusedAsDirtyTarget(out, dir, baseBefore, "conf/local.txt");
  assert.equal(
    readFileSync(operatorFile, "utf8"),
    "the operator's UNTRACKED config — never destroy this\n",
    "the operator's file is byte-for-byte untouched — forge never deletes, stashes, moves, or checks out over it",
  );
});

test("FG-425 (AC3): candidate adds `conf/settings.json`; the operator has an untracked FILE at `conf` — refused before any mutation", async () => {
  const runId = "run-collide-dir-over-file";
  const { dir, branch } = makeProject(runId, "conf/settings.json");
  const baseBefore = readTargetSha(localTargetFor(dir));

  // The operator's own FILE sits where the candidate needs a DIRECTORY.
  const operatorFile = join(dir, "conf");
  writeFileSync(operatorFile, "the operator's UNTRACKED note — never destroy this\n");

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: ok,
  });

  assertRefusedAsDirtyTarget(out, dir, baseBefore, "conf");
  assert.equal(
    readFileSync(operatorFile, "utf8"),
    "the operator's UNTRACKED note — never destroy this\n",
    "the operator's file is byte-for-byte untouched — forge never deletes, stashes, moves, or checks out over it",
  );
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** AD-3's contract, whichever direction the collision runs in: the NAMED blocker,
 *  and a target nothing has been written to. */
function assertRefusedAsDirtyTarget(
  out: Awaited<ReturnType<typeof publishIntegration>>,
  dir: string,
  baseBefore: string,
  offendingPath: string,
): void {
  assert.equal(
    out.kind,
    "parked",
    "a git file/directory collision with an untracked path is `dirty_publish_target`, refused BEFORE the window — " +
      `not a checkout failure discovered on the far side of the CAS: ${JSON.stringify(out)}`,
  );
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "dirty_publish_target", "AD-3's named blocker, not a fallback refusal");
  assert.match(out.error, /untracked/i, "the blocker must name WHAT it refused on");
  assert.match(out.error, new RegExp(offendingPath.replace(/[/.]/g, "\\$&")), "and it must name the offending path");
  assert.doesNotMatch(
    out.error,
    /could not be updated|ROLLED BACK/,
    "and it must NOT be a CheckoutSyncError in disguise — that one has already advanced the ref",
  );
  assert.equal(
    readTargetSha(localTargetFor(dir)),
    baseBefore,
    "the target ref must be provably UNCHANGED: the collision is refused before ANY mutation",
  );
  assert.equal(
    git(dir, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "the index and the tracked working tree are unchanged — nothing staged, nothing to clean up",
  );
}

/** The one publication attempt this project's lane carries. */
function attemptOf(projectKey: string): string {
  const entry = laneForProject(projectKey)[0];
  assert.ok(entry, "expected the project's lane to carry the publisher's attempt");
  return entry.attemptId;
}

/** Age a lane entry's lease into the past. This is the ONLY thing a takeover keys
 *  on (AD-7: no probe, no signal, no liveness classification) — so writing the
 *  durable timestamp IS the faithful simulation. The alternative, sleeping out a
 *  full 90s TTL, would be a test nobody ever runs. */
function expireLease(attemptId: string): void {
  getDb()
    .prepare(`UPDATE publication_lane SET lease_expires_at_ms = ? WHERE attempt_id = ?`)
    .run(storeNowMs() - 1, attemptId);
}

function markLaneAbandoned(attemptId: string): void {
  getDb().prepare(`UPDATE publication_lane SET state = 'abandoned' WHERE attempt_id = ?`).run(attemptId);
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}
