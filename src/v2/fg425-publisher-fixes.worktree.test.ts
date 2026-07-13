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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  assert.equal(
    readTargetSha(target),
    base,
    "its own ref advance is rolled back by CAS — the target is byte-for-byte where it started, so the attempt " +
      "that took the window is not left publishing on top of a half-applied one",
  );
  assert.equal(
    existsSync(join(dir, "agent-work.txt")),
    false,
    "and the working tree was NEVER updated: the checkout is the write the mutex exists to serialize",
  );
  assert.equal(
    publicationMutexHolder(key)?.attemptId,
    "attempt-thief",
    "releasing our own mutex must not unlink the holder that took it over from us",
  );
});

// ── helpers ───────────────────────────────────────────────────────────────────

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
