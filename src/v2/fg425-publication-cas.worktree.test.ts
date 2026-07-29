// FG-425: the publisher end-to-end — compare-and-swap publication of a candidate
// validated in isolation.
//
// The properties under test are the ticket's acceptance criteria, in the order
// they matter: validation never touches the publish target; the commit published
// is byte-identical to the commit validated (AD-6); a moved base rebuilds ONCE and
// re-validates rather than publishing an unvalidated merge, and a SECOND move
// parks with evidence (AD-1); a dirty target is refused before any mutation
// (AD-3); the publication mutex is never held across validation.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  getPublicationAttempt,
  publicationMutexHolder,
  laneForProject,
} from "../store/publications.js";
import { insertRun } from "../store/runs.js";
import { projectIdentity } from "./project-identity.js";
import { publishIntegration, finalizePublication, type ValidationResult } from "./integration-publisher.js";
import { readTargetSha, localTargetFor, dirtyTrackedFiles } from "./publication-target.js";

let prevDb: DatabaseInstance | null;
const cleanup: string[] = [];

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
});

afterEach(() => {
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

/** A project with a task branch carrying an agent's committed work — the shape
 *  the publisher is handed at every call site. */
function makeProject(runId: string): { dir: string; branch: string; taskSha: string } {
  // realpathSync at the fixture ROOT, so every path derived from it is canonical on
  // both sides of every comparison below (FG-556). Forge records the project's
  // physical path via projectIdentity()'s realpath, so a fixture spelled through a
  // symlinked tmpdir — macOS /var → /private/var — never matched the durable target
  // it asserts. A no-op wherever tmpdir() is already canonical, not a platform branch.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg425-cas-")));
  cleanup.push(dir);
  git(dir, ["init", "-b", "main"]);
  commit(dir, "seed.txt", "seed\n");
  const branch = `forge/${runId}/task-build-1`;
  git(dir, ["checkout", "-q", "-b", branch]);
  const taskSha = commit(dir, "agent-work.txt", "the agent's output\n");
  git(dir, ["checkout", "-q", "main"]);
  // A run row: the publisher's events are keyed to it.
  insertRun({
    id: runId,
    workflow: "fg425",
    title: "fg425 cas test",
    status: "active",
    projectDir: dir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
  return { dir, branch, taskSha };
}

const ok = (): ValidationResult => ({ ok: true });

test("FG-425: the gate runs against the CANDIDATE worktree, and the exact validated commit is what lands", async () => {
  const runId = "run-a";
  const { dir, branch, taskSha } = makeProject(runId);

  let gatedDir: string | undefined;
  let gatedSha: string | undefined;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (candidateDir, candidateSha) => {
      gatedDir = candidateDir;
      gatedSha = candidateSha;
      return ok();
    },
  });

  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;

  assert.notEqual(gatedDir, dir, "validation must NOT run against the publish target");
  assert.ok(gatedDir?.includes("publications"), "validation runs in the per-attempt publication worktree");
  assert.equal(gatedSha, out.candidateSha, "the gate saw the exact candidate that was published");
  assert.equal(out.publishedSha, out.candidateSha, "AD-6: publishedSha === candidateSha");
  // The candidate fast-forwards the task branch onto an unmoved base, so the
  // published sha is the task branch tip — identical to what the old
  // merge-then-gate path landed. No behavioral drift on the happy path.
  assert.equal(out.publishedSha, taskSha);
  assert.equal(readTargetSha(localTargetFor(dir)), taskSha, "the target ref carries the published commit");
  assert.equal(readFileSync(join(dir, "agent-work.txt"), "utf8"), "the agent's output\n");

  // The durable record (AD-6 + operator visibility).
  const attempt = getPublicationAttempt(out.attemptId);
  assert.equal(attempt?.state, "published");
  assert.equal(attempt?.baseSha, out.baseSha);
  assert.equal(attempt?.candidateSha, out.candidateSha);
  assert.equal(attempt?.publishedSha, out.candidateSha);
  assert.equal(attempt?.target, `local:${dir}#main`);
  assert.ok(attempt?.worktreePath, "the worktree handle FG-356 needs is recorded");
});

// AD-6 through the whole publisher: the SOURCE branch is mutated mid-validation.
// A publisher that re-resolved the candidate from the branch at publish time would
// land a commit nothing ever tested.
test("FG-425 (AD-6): the source branch is mutated DURING validation — the publish still lands the recorded candidateSha", async () => {
  const runId = "run-b";
  const { dir, branch } = makeProject(runId);

  let validatedSha = "";
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_candidateDir, candidateSha) => {
      validatedSha = candidateSha;
      // The branch moves while the gate is running.
      git(dir, ["checkout", "-q", branch]);
      commit(dir, "sneaky.txt", "never validated\n");
      git(dir, ["checkout", "-q", "main"]);
      return ok();
    },
  });

  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;
  assert.notEqual(git(dir, ["rev-parse", branch]), validatedSha, "precondition: the branch tip really moved");
  assert.equal(out.publishedSha, validatedSha, "the RECORDED sha is what published — not the new tip");
  assert.equal(readTargetSha(localTargetFor(dir)), validatedSha);
  assert.equal(existsSync(join(dir, "sneaky.txt")), false, "the unvalidated commit must not be on the target");
});

// The whole reason the mutex exists is that it is SHORT. Holding it across a
// 10-minute test suite is the defect this ticket removes; asserting it mechanically
// is what stops it coming back.
test("FG-425: the publication mutex is NOT held across validation — only across the CAS window", async () => {
  const runId = "run-c";
  const { dir, branch } = makeProject(runId);
  const key = projectIdentity(dir).key;

  let holderDuringValidation: unknown = "unset";
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => {
      holderDuringValidation = publicationMutexHolder(key);
      return ok();
    },
  });

  assert.equal(out.kind, "published");
  assert.equal(holderDuringValidation, undefined, "no publication lock may be held while validation runs");
  assert.equal(publicationMutexHolder(key), undefined, "and it is released after the window closes");
});

// AD-1, first half: ONE rebuild, gates rerun. The merge built against the old base
// is NEVER published — it was validated against a base the target no longer has.
test("FG-425 (AD-1): the base moves once — the candidate is REBUILT on the new base and re-validated, not published unvalidated", async () => {
  const runId = "run-d";
  const { dir, branch } = makeProject(runId);

  const validated: string[] = [];
  let externalSha = "";
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_dir, candidateSha) => {
      validated.push(candidateSha);
      if (validated.length === 1) {
        // An external writer lands on the target while we validate.
        externalSha = commit(dir, "external.txt", "someone else\n");
      }
      return ok();
    },
  });

  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;

  assert.equal(validated.length, 2, "the gate must RE-RUN against the rebuilt candidate");
  assert.equal(out.rebuilds, 1);
  assert.notEqual(validated[0], validated[1], "the rebuild produced a different candidate");
  assert.equal(out.publishedSha, validated[1], "what published is the SECOND, re-validated candidate");
  assert.notEqual(out.publishedSha, validated[0], "the candidate built on the stale base must NEVER publish");
  assert.equal(out.baseSha, externalSha, "the rebuild was based on the external writer's commit");

  // Both the external work and the agent's work are on the target.
  assert.equal(readTargetSha(localTargetFor(dir)), out.publishedSha);
  assert.equal(readFileSync(join(dir, "external.txt"), "utf8"), "someone else\n");
  assert.equal(readFileSync(join(dir, "agent-work.txt"), "utf8"), "the agent's output\n");
  assert.equal(getPublicationAttempt(out.attemptId)?.rebuildCount, 1);
});

// AD-1, second half: bounded. Two full validations, then PARK — never a third
// spin, and never a publish of something the target's current base never saw.
test("FG-425 (AD-1): the base moves TWICE — the attempt PARKS with publish_base_churn and PRESERVES evidence", async () => {
  const runId = "run-e";
  const { dir, branch } = makeProject(runId);

  const validated: string[] = [];
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (_dir, candidateSha) => {
      validated.push(candidateSha);
      // An external writer moves the target on EVERY validation — the shape of a
      // human pushing to the branch mid-run.
      commit(dir, `external-${validated.length}.txt`, "someone else\n");
      return ok();
    },
  });

  assert.equal(out.kind, "parked");
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "publish_base_churn", "the blocker must be NAMED");
  assert.match(out.error, /EXTERNAL writer/, "the park must tell the operator this is external write traffic");
  assert.match(out.error, /Do not respond by raising the rebuild bound/);

  assert.equal(validated.length, 2, "AD-1 bounds this at TWO full validations — no third spin");

  const attempt = getPublicationAttempt(out.attemptId);
  assert.equal(attempt?.state, "parked");
  assert.equal(attempt?.parkReason, "publish_base_churn");
  assert.equal(attempt?.publishedSha, undefined, "nothing was published");

  // Evidence preserved: BOTH candidate worktrees survive the park.
  assert.ok(existsSync(out.candidateWorktree ?? ""), "the candidate worktree is retained as evidence");
  finalizePublication(dir, out.attemptId);
  assert.ok(
    existsSync(out.candidateWorktree ?? ""),
    "finalize must NOT reclaim a parked attempt's evidence — that is what AD-1 requires be preserved",
  );

  // And the lane is not wedged by the park.
  const lane = laneForProject(projectIdentity(dir).key);
  assert.equal(lane.length, 1);
  assert.equal(lane[0]?.state, "done", "a parked attempt still leaves the lane cleanly");
});

// The other half of the moved-base story. A base that moved WITHOUT conflicting is
// rebuilt onto and published (above). A base that moved and genuinely CONFLICTS
// must fail, publish nothing, and retain its evidence — forge never resolves a
// content conflict on the operator's behalf.
test("FG-425: a source that CONFLICTS with the moved base fails the publication, lands nothing, and retains evidence", async () => {
  const runId = "run-conflict";
  const { dir, branch } = makeProject(runId);

  // The agent's branch and the target both change the same file, differently.
  git(dir, ["checkout", "-q", branch]);
  commit(dir, "contested.txt", "the agent's version\n");
  git(dir, ["checkout", "-q", "main"]);
  const targetSha = commit(dir, "contested.txt", "the operator's version\n");

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => {
      assert.fail("validation must NEVER run on a candidate that failed to merge");
    },
  });

  assert.equal(out.kind, "merge_failed");
  if (out.kind !== "merge_failed") return;
  assert.match(out.error, /merging .* into the candidate failed/);

  assert.equal(readTargetSha(localTargetFor(dir)), targetSha, "nothing was published");
  assert.equal(
    readFileSync(join(dir, "contested.txt"), "utf8"),
    "the operator's version\n",
    "the target's content is untouched — forge does not resolve conflicts for you",
  );
  assert.ok(existsSync(out.candidateWorktree), "the candidate worktree is retained for inspection (no-discard)");
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "failed");
  assert.equal(getPublicationAttempt(out.attemptId)?.publishedSha, undefined);
});

test("FG-425 (AD-3): a dirty publish target PARKS with dirty_publish_target, before any mutation, and the dirt survives untouched", async () => {
  const runId = "run-f";
  const { dir, branch } = makeProject(runId);
  const baseBefore = readTargetSha(localTargetFor(dir));

  const dirtyBody = "operator work in progress\n";
  writeFileSync(join(dir, "seed.txt"), dirtyBody);

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ok(),
  });

  assert.equal(out.kind, "parked");
  if (out.kind !== "parked") return;
  assert.equal(out.reason, "dirty_publish_target");

  assert.equal(readTargetSha(localTargetFor(dir)), baseBefore, "the target ref must not have moved");
  assert.equal(readFileSync(join(dir, "seed.txt"), "utf8"), dirtyBody, "the operator's dirty file is byte-identical");
  assert.deepEqual(dirtyTrackedFiles(dir), ["M seed.txt"], "forge did not stash, reset, or clean it");
  assert.equal(getPublicationAttempt(out.attemptId)?.publishedSha, undefined);
});

test("FG-425: finalize is idempotent — repeated cleanup converges and never discards a correct publication", async () => {
  const runId = "run-g";
  const { dir, branch } = makeProject(runId);

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ok(),
  });
  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;

  const published = readTargetSha(localTargetFor(dir));

  finalizePublication(dir, out.attemptId);
  finalizePublication(dir, out.attemptId);
  finalizePublication(dir, out.attemptId);

  assert.equal(existsSync(out.candidateWorktree), false, "the candidate worktree is reclaimed once published");
  assert.equal(readTargetSha(localTargetFor(dir)), published, "cleanup NEVER discards the publication");
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "published");
  assert.equal(getPublicationAttempt(out.attemptId)?.publishedSha, published);

  // A finalize for an attempt that never published, and one for an unknown
  // attempt, must both be silent no-ops rather than throwing on the finalize path.
  finalizePublication(dir, "no-such-attempt");
});

test("FG-425: a leaked candidate worktree never fails a correct publish — cleanup is not a correctness step", async () => {
  const runId = "run-h";
  const { dir, branch } = makeProject(runId);

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: dir,
    sources: [{ branch, label: "task" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: () => ok(),
  });
  assert.equal(out.kind, "published");
  if (out.kind !== "published") return;

  // Rip the worktree out from under git, the way a crashed process or an
  // interrupted `rm -rf` would. Finalize must still converge, and the
  // publication must still stand.
  rmSync(out.candidateWorktree, { recursive: true, force: true });
  finalizePublication(dir, out.attemptId);

  assert.equal(readTargetSha(localTargetFor(dir)), out.publishedSha);
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "published");
});

// AD-2's boundary: the lane is per CANONICAL PROJECT. Two runs on DIFFERENT
// projects must not see each other at all — a global lock would serialize the
// whole machine, which is the regression this pins.
test("FG-425: runs on DIFFERENT projects publish fully in PARALLEL — no lane cross-talk", async () => {
  const a = makeProject("run-i");
  const b = makeProject("run-j");

  let aInside = false;
  let bInside = false;
  let overlapped = false;

  const hold = async (which: "a" | "b"): Promise<void> => {
    if (which === "a") aInside = true;
    else bInside = true;
    for (let i = 0; i < 20; i++) {
      if (aInside && bInside) overlapped = true;
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    if (which === "a") aInside = false;
    else bInside = false;
  };

  const [outA, outB] = await Promise.all([
    publishIntegration({
      runId: "run-i",
      taskId: "task-build-1",
      projectDir: a.dir,
      sources: [{ branch: a.branch, label: "task" }],
      lane: { pollMs: 5, log: () => {} },
      alsoValidate: async () => {
        await hold("a");
        return ok();
      },
    }),
    publishIntegration({
      runId: "run-j",
      taskId: "task-build-1",
      projectDir: b.dir,
      sources: [{ branch: b.branch, label: "task" }],
      lane: { pollMs: 5, log: () => {} },
      alsoValidate: async () => {
        await hold("b");
        return ok();
      },
    }),
  ]);

  assert.equal(outA.kind, "published");
  assert.equal(outB.kind, "published");
  assert.equal(overlapped, true, "independent projects must proceed concurrently — a shared lane would serialize them");
  assert.notEqual(projectIdentity(a.dir).key, projectIdentity(b.dir).key);
});

// AD-2, in-process half: two attempts on ONE project are ordered by the DURABLE
// enqueue key and their publication windows never interleave. (The cross-process
// proof — separate OS processes — is fg425-publication-fifo.integration.test.ts.)
test("FG-425 (AD-2): two attempts on ONE project are FIFO-ordered by the durable enqueue key and never interleave", async () => {
  const runId = "run-k";
  const { dir, branch } = makeProject(runId);

  let inside = 0;
  let maxInside = 0;
  const order: string[] = [];

  const attempt = (label: string): Promise<unknown> =>
    publishIntegration({
      runId,
      taskId: `task-${label}`,
      projectDir: dir,
      sources: [{ branch, label: "task" }],
      lane: { pollMs: 5, log: () => {} },
      alsoValidate: async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        order.push(label);
        await new Promise<void>((r) => setTimeout(r, 40));
        inside--;
        return ok();
      },
    });

  // Sequenced starts so the enqueue ORDER is deterministic; what is under test is
  // that the lane HONORS that recorded order, not that a race resolves a
  // particular way.
  const first = attempt("first");
  await new Promise<void>((r) => setTimeout(r, 25));
  const second = attempt("second");
  await Promise.all([first, second]);

  assert.equal(maxInside, 1, "two attempts on one project must never be in the publication pipeline at once");
  assert.deepEqual(order, ["first", "second"], "the lane runs attempts in enqueue order");

  const lane = laneForProject(projectIdentity(dir).key);
  assert.equal(lane.length, 2);
  assert.ok(
    (lane[0]?.enqueueSeq ?? 0) < (lane[1]?.enqueueSeq ?? 0),
    "ordering derives from the durable enqueue key, assigned at record time",
  );
  assert.deepEqual(lane.map((e) => e.state), ["done", "done"]);
});
