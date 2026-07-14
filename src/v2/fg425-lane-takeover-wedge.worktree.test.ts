// FG-425 corrective (VERIFY): the interaction between the AC1 lost-mutex invariant,
// the AC2 recovery state-gate, and the LANE's takeover sweep.
//
// AC1's promise is that a publisher which advanced the ref and then lost the window
// leaves behind "the durable {baseSha, candidateSha, target} intent for the current
// mutex owner to converge via AD-5 recovery". AC2 makes recovery refuse to touch a
// TERMINAL record. Both are right on their own. Together they have a seam:
//
//   `laneTick` (src/store/publications.ts) rewrites the ATTEMPT record of every
//   lane entry whose lease it expires:
//
//       UPDATE publication_attempts SET state = 'abandoned'
//        WHERE state NOT IN ('published','failed','parked','abandoned')
//          AND attempt_id IN (SELECT attempt_id FROM publication_lane
//                              WHERE project_key = ? AND state = 'abandoned')
//
//   `publishing` is NOT in that exclusion list. So an attempt that is inside the
//   window — the ONE state in which the target may already carry its candidate — is
//   rewritten to `abandoned` by ANOTHER attempt's ordinary lane poll.
//
// From that moment the durable intent AC1 preserved is unreachable by every
// convergence path forge has:
//
//   - `unfinishedPublications` selects `state = 'publishing'` ONLY, so the run-path
//     sweep (`recoverUnfinishedPublications`, runNext.ts:183) never sees it again;
//   - `recoverPublicationAttempt` now returns `recordedDisposition` for any
//     non-`publishing` record — reporting "not recoverable" and running NO checkout.
//
// The target is then left ref=candidate / tree=base: divergent, permanently. Every
// later publication captures base=candidate from the REF, sees the un-converged tree
// as uncommitted tracked dirt, and parks `dirty_publish_target` — telling the
// operator they have uncommitted changes they never made, about a tree only forge
// touched. Nothing forge can run converges it.
//
// The ordering is the whole point, and it is the ordering the existing suite does
// not have: fg425-publication-recovery.worktree.test.ts's lane-takeover test calls
// recoverPublicationAttempt BEFORE the next attempt ticks the lane. Recovery-first
// works. Tick-first wedges. With two concurrent forge processes — the shape FG-425
// exists to support — tick-first is the ordinary case: runNext sweeps ONCE, at the
// start of the run (runNext.ts:183), long before the OTHER run's publisher crashes
// inside its window.
//
// THE CRASH IS REAL: a separate OS process SIGKILLs itself inside the window, as in
// the AD-5 recovery suite. No unwinding, no finally, no chance to write anything.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "../store/db.js";
import {
  publicationAttemptsForProject,
  setPublicationClockOffsetForTest,
} from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";
import {
  publishIntegration,
  recoverPublicationAttemptForOperator,
  recoverUnfinishedPublications,
} from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";

const V2_DIR = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Publishes in its own process and SIGKILLs itself inside the AD-5 window — the ref
 *  has advanced, the working tree has not. Same technique as the AD-5 recovery suite:
 *  a throw-based hook would run the `finally` blocks a real crash never runs. */
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

test("FG-425 (AC1+AC2 seam): a concurrent run's lane poll must not strand the durable intent of an attempt whose ref advance is ON the target", async () => {
  const workdir = tmp("fg425-wedge-drv-");
  const project = tmp("fg425-wedge-proj-");

  git(project, ["init", "-b", "main"]);
  const base = commit(project, "seed.txt", "seed\n");

  const crashedRun = "run-crashes-in-window";
  const crashedBranch = `forge/${crashedRun}/task`;
  git(project, ["checkout", "-q", "-b", crashedBranch]);
  commit(project, "first.txt", "the crashed run's work\n");
  git(project, ["checkout", "-q", "main"]);

  const nextRun = "run-concurrent";
  const nextBranch = `forge/${nextRun}/task`;
  git(project, ["checkout", "-q", "-b", nextBranch, "main"]);
  commit(project, "second.txt", "the concurrent run's work\n");
  git(project, ["checkout", "-q", "main"]);

  getDb(); // materialize the shared on-disk DB before the child opens it
  const key = projectIdentity(project).key;
  const target = localTargetFor(project);

  // ── the concurrent run starts FIRST ─────────────────────────────────────────
  // runNext sweeps for unfinished publications ONCE, at the top of the run
  // (runNext.ts:183). At that moment nothing is pending: the other run has not
  // crashed yet — it has not even entered its window. This is the ONLY sweep this
  // run will ever perform, and it is a no-op.
  recoverUnfinishedPublications(project, nextRun);

  // ── now the other run crashes INSIDE its window ─────────────────────────────
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", writeCrashDriver(workdir), project, crashedRun, crashedBranch],
    { encoding: "utf8", env: process.env, timeout: 120_000 },
  );
  assert.equal(child.signal, "SIGKILL", `the driver must have died by SIGKILL (stderr: ${child.stderr})`);

  const crashed = publicationAttemptsForProject(key)[0]!;
  assert.equal(crashed.state, "publishing", "precondition: the crash caught it INSIDE the window");
  assert.equal(
    readTargetSha(target),
    crashed.candidateSha,
    "precondition: the ref advance LANDED — the target carries the crashed attempt's candidate",
  );
  assert.equal(
    existsSync(join(project, "first.txt")),
    false,
    "precondition: the checkout did NOT run — the tree is still at the base. This is the AD-5 window, and the " +
      "durable {baseSha, candidateSha, target} intent is what converges it.",
  );

  // Time passes. The dead owner's lane lease lapses — a durable timestamp running
  // out, nothing probed or signalled (AD-7).
  setPublicationClockOffsetForTest(10 * 60 * 1000);

  // ── the concurrent run publishes: its lane poll ticks the lane ──────────────
  // This is an ORDINARY publication. It ticks the lane, finds the dead owner's lease
  // lapsed, and takes the lane over — which is correct and is what keeps the lane
  // unwedgeable. What it must NOT do is rewrite the crashed attempt's `publishing`
  // record, because that record is the durable intent AC1 preserved precisely so the
  // ref advance sitting on the target can still be converged.
  const out = await publishIntegration({
    runId: nextRun,
    taskId: "task-next",
    projectDir: project,
    sources: [{ branch: nextBranch, label: "next" }],
    lane: { pollMs: 10, maxWaitMs: 5_000, log: () => {} },
    alsoValidate: () => ({ ok: true }),
  });

  // ── whatever the concurrent attempt decided, the target must be CONVERGED ───
  // Every convergence path forge has, run in the order a real operator would hit
  // them: the run-path sweep, then `forge publish recover` by hand.
  const sweep = recoverUnfinishedPublications(project, nextRun);
  const byHand = recoverPublicationAttemptForOperator(crashed.attemptId);

  assert.equal(
    git(project, ["status", "--porcelain"]),
    "",
    "THE TARGET IS WEDGED: the ref and the working tree disagree and NOTHING forge can run converges them. The ref " +
      "carries the crashed attempt's candidate; the tree is still at the base. Every later publication captures the " +
      "base from the REF, sees the un-converged diff as uncommitted TRACKED dirt, and parks `dirty_publish_target` " +
      "— telling the operator they have uncommitted changes they never made, about a working tree only forge ever " +
      `touched.\n  the concurrent attempt reported: ${JSON.stringify(out)}\n  the run-path sweep did: ` +
      `${JSON.stringify(sweep) ?? "nothing"}\n  \`forge publish recover\` said: ${JSON.stringify(byHand)}`,
  );
  assert.ok(
    existsSync(join(project, "first.txt")),
    "and the crashed run's published work must be ON the target — its commit is what the ref carries",
  );
  assert.notEqual(readTargetSha(target), base, "the ref carries a published candidate, not the base");

  // ── the mechanism, asserted second because the harm above is the point ──────
  const afterTick = publicationAttemptsForProject(key).find((a) => a.attemptId === crashed.attemptId)!;
  assert.equal(
    afterTick.state,
    "published",
    "the crashed attempt's record must end up telling the truth about the target: its candidate IS on the ref. " +
      "Instead the concurrent attempt's lane tick rewrote it from `publishing` to `abandoned` (laneTick's " +
      "`UPDATE publication_attempts SET state='abandoned' WHERE state NOT IN " +
      "('published','failed','parked','abandoned')` — `publishing` is not excluded), and from that moment the " +
      "durable intent is unreachable: `unfinishedPublications` selects `publishing` ONLY, so the run-path sweep " +
      "never sees it again, and `recoverPublicationAttempt` reports a terminal record as not-recoverable and runs " +
      "no checkout. A lane lease lapsing means the OWNER is gone; it does not mean the owner's ref advance is gone.",
  );
});
