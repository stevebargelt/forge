// FG-425 (AD-5): crash between advancing the local target ref and updating its
// checked-out working tree.
//
// This is the window the ticket singles out, and the reason it exists: after the
// CAS lands, the ref carries the candidate but the working tree does not yet. A
// process that died HERE leaves a tree whose contents match NEITHER the base nor
// the candidate — which is exactly why AD-5 forbids inferring publication state
// from working-tree contents. Recovery must derive from {baseSha, candidateSha,
// currentTargetSha} alone.
//
// The crash is REAL: a separate OS process SIGKILLs itself inside the window. No
// unwinding, no finally block, no chance to write anything — the durable state the
// recovery pass reads is the state a real crash actually leaves.
//
// ON THE FG-530 HARNESS: the step called for registering a KILL_POINT there.
// That harness's registry-coverage guard requires every registered kill point to
// FIRE in at least one crash-matrix cell, and the matrix's scenarios are all
// non-worktree runs that never reach a publication — so registering one would
// fail that guard until a worktree/publication scenario is added to the matrix
// (a guarded shared harness outside this step, and outside FG-425). Rather than
// weaken a guard or fake coverage, the window is opened by an ordinary injected
// callback (publication-target.ts's `afterRefAdvance`), which is the same
// dependency-injection seam run-lock.ts already uses for `isAlive`/`nowMs`, is
// undefined in production, and — unlike a throw-based hook — lets the test kill
// the process for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "../store/db.js";
import {
  publicationAttemptsForProject,
  laneForProject,
  setPublicationClockOffsetForTest,
} from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";
import { publishIntegration, recoverPublicationAttempt } from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";

const V2_DIR = dirname(fileURLToPath(import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Publishes in its own process and SIGKILLs itself inside the AD-5 window — the
 *  ref has advanced, the working tree has not. */
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
  // The ref has advanced. The checked-out tree has not. Die — for real.
  afterRefAdvance: () => { process.kill(process.pid, "SIGKILL"); },
});
process.stdout.write("UNREACHABLE: the process should have been killed\\n");
`,
  );
  return path;
}

test("FG-425 (AD-5): a REAL crash between the ref advance and the checkout update recovers from the three SHAs alone", () => {
  const workdir = mkdtempSync(join(tmpdir(), "fg425-recov-"));
  const project = mkdtempSync(join(tmpdir(), "fg425-recov-proj-"));
  try {
    git(project, ["init", "-b", "main"]);
    const base = commit(project, "seed.txt", "seed\n");
    const runId = "run-crash";
    const branch = `forge/${runId}/task`;
    git(project, ["checkout", "-q", "-b", branch]);
    commit(project, "agent-work.txt", "the agent's output\n");
    git(project, ["checkout", "-q", "main"]);

    getDb(); // materialize the shared on-disk DB before the child opens it

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", writeCrashDriver(workdir), project, runId, branch],
      { encoding: "utf8", env: process.env, timeout: 120_000 },
    );

    // A real death: killed by a signal, no exit code, nothing after it ran.
    assert.equal(child.signal, "SIGKILL", `the driver must have died by SIGKILL (stderr: ${child.stderr})`);
    assert.doesNotMatch(child.stdout ?? "", /UNREACHABLE/);

    // ── the world the crash left ──────────────────────────────────────────────
    const key = projectIdentity(project).key;
    const attempts = publicationAttemptsForProject(key);
    assert.equal(attempts.length, 1, "publication INTENT was recorded BEFORE the mutation, and survived the crash");
    const attempt = attempts[0]!;
    assert.equal(attempt.state, "publishing", "the crash caught it mid-window");
    assert.ok(attempt.baseSha, "the validated base is durable");
    assert.ok(attempt.candidateSha, "the validated candidate sha is durable");
    assert.equal(attempt.baseSha, base);
    assert.equal(attempt.publishedSha, undefined, "the crash left no publication claim");

    const target = localTargetFor(project);
    assert.equal(readTargetSha(target), attempt.candidateSha, "the REF advanced before the crash");
    assert.equal(
      existsSync(join(project, "agent-work.txt")),
      false,
      "precondition: the WORKING TREE did not catch up — this is the ambiguous state AD-5 exists for",
    );

    // ── recovery ──────────────────────────────────────────────────────────────
    // Derived from {baseSha, candidateSha, currentTargetSha}. The working tree is
    // never consulted to decide WHAT HAPPENED — here it would be actively
    // misleading, since it still looks exactly like nothing was published.
    const recovered = recoverPublicationAttempt(attempt.attemptId);
    assert.equal(recovered.kind, "published");
    if (recovered.kind !== "published") return;
    assert.equal(recovered.publishedSha, attempt.candidateSha, "AD-6 holds through recovery too");

    assert.equal(
      readFileSync(join(project, "agent-work.txt"), "utf8"),
      "the agent's output\n",
      "recovery finished the outstanding checkout update",
    );
    assert.deepEqual(
      git(project, ["status", "--porcelain", "--untracked-files=no"]),
      "",
      "and left the target clean",
    );

    // Idempotent: re-running recovery converges and never discards the publication.
    const again = recoverPublicationAttempt(attempt.attemptId);
    assert.equal(again.kind, "published");
    assert.equal(readTargetSha(target), attempt.candidateSha);
    assert.equal(publicationAttemptsForProject(key)[0]?.state, "published");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("FG-425: the crashed attempt's lane entry does NOT wedge the lane — a later attempt takes over on lease expiry, with no liveness probe", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "fg425-wedge-"));
  const project = mkdtempSync(join(tmpdir(), "fg425-wedge-proj-"));
  try {
    git(project, ["init", "-b", "main"]);
    commit(project, "seed.txt", "seed\n");
    const crashedRun = "run-wedger";
    const crashedBranch = `forge/${crashedRun}/task`;
    git(project, ["checkout", "-q", "-b", crashedBranch]);
    commit(project, "first.txt", "first\n");
    git(project, ["checkout", "-q", "main"]);

    const nextRun = "run-next";
    const nextBranch = `forge/${nextRun}/task`;
    git(project, ["checkout", "-q", "-b", nextBranch, "main"]);
    commit(project, "second.txt", "second\n");
    git(project, ["checkout", "-q", "main"]);

    getDb();

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", writeCrashDriver(workdir), project, crashedRun, crashedBranch],
      { encoding: "utf8", env: process.env, timeout: 120_000 },
    );
    assert.equal(child.signal, "SIGKILL");

    const key = projectIdentity(project).key;
    const crashed = publicationAttemptsForProject(key)[0]!;
    // The crashed process never reached its `finally` — its lane entry is still
    // HOLDING, with a lease it can no longer renew.
    assert.equal(laneForProject(key)[0]?.state, "holding", "a killed owner leaves a non-terminal lane entry");

    // Recover the crashed publication first (it DID land — the ref advanced).
    recoverPublicationAttempt(crashed.attemptId);

    // Now time passes: the dead owner's lease expires. Nothing probes it, signals
    // it, or asks whether its pid is alive (AD-7) — the lease simply runs out.
    setPublicationClockOffsetForTest(10 * 60 * 1000);
    try {
      const out = await publishIntegration({
        runId: nextRun,
        taskId: "task-next",
        projectDir: project,
        sources: [{ branch: nextBranch, label: "next" }],
        lane: { pollMs: 10, maxWaitMs: 5_000, log: () => {} },
        alsoValidate: () => ({ ok: true }),
      });

      assert.equal(out.kind, "published", "the next attempt must not be wedged behind a dead owner");
      if (out.kind !== "published") return;
      assert.equal(out.baseSha, crashed.candidateSha, "it builds on the crashed attempt's recovered publication");
      assert.equal(readTargetSha(localTargetFor(project)), out.publishedSha);
      assert.ok(existsSync(join(project, "first.txt")), "the crashed run's work survives");
      assert.ok(existsSync(join(project, "second.txt")), "and the next run's work published on top of it");

      const lane = laneForProject(key);
      assert.equal(lane[0]?.state, "abandoned", "the expired entry was marked terminal, not left to wedge the lane");
      assert.equal(lane[1]?.state, "done");
    } finally {
      setPublicationClockOffsetForTest(0);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
