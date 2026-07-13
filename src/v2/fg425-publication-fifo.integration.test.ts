// FG-425 (AD-2): FIFO publication ordering across REAL, SEPARATE OS PROCESSES.
//
// This is the test the ticket's testing bar actually asks for, and the reason it
// insists on real processes: two async tasks in one event loop share a heap, so
// they can be serialized by accident — by a shared promise, by a module-level
// variable, by the single-threaded scheduler. None of that is available to two
// `forge next` invocations, which is the situation the defect actually occurs in.
// So the contenders here are separate `node` processes, contending through the
// same on-disk SQLite (WAL) and the same git repo. The harness shape is salvaged
// from the abandoned branch and retargeted at CAS publication.
//
// FIFO is asserted MECHANICALLY, from the DURABLE ENQUEUE KEY — never from
// timing, and never from lock-acquisition order (OS lock grants are unordered, so
// acquisition order can prove nothing).
//
// THE PROOF: each publication captures its base AFTER taking the lane. If the
// lane truly serialized candidate-build → validate → publish, then every attempt
// saw a base equal to the previous attempt's published sha — a strict CHAIN in
// enqueue_seq order — and nobody's base moved under them (rebuilds === 0). If the
// lane had NOT ordered them, a contender would have captured a stale base, lost
// the CAS, and rebuilt (rebuilds > 0) or parked. So `rebuilds === 0 for all` plus
// `baseSha[i] === publishedSha[i-1] in enqueue order` is a mechanical proof of
// both mutual exclusion and ordering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "../store/db.js";
import { publicationAttemptsForProject, laneForProject } from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";

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

/** A driver that runs ONE publication attempt in its own OS process, against the
 *  same FORGE_HOME (hence the same SQLite) as the test. It holds its candidate in
 *  validation for a beat, so the contenders genuinely overlap in wall-clock time
 *  and the lane has something real to order. */
function writeDriver(dir: string): string {
  const path = join(dir, "publish-driver.mjs");
  writeFileSync(
    path,
    `
import { publishIntegration } from ${JSON.stringify(join(V2_DIR, "integration-publisher.ts"))};

const [projectDir, runId, branch, holdMs] = process.argv.slice(2);

const out = await publishIntegration({
  runId,
  taskId: "task-" + runId,
  projectDir,
  sources: [{ branch, label: runId }],
  lane: { pollMs: 25, log: () => {} },
  alsoValidate: async () => {
    await new Promise((r) => setTimeout(r, Number(holdMs)));
    return { ok: true };
  },
});
process.stdout.write(JSON.stringify(out) + "\\n");
process.exit(0);
`,
  );
  return path;
}

type DriverOut = {
  kind: string;
  attemptId: string;
  baseSha?: string;
  candidateSha?: string;
  publishedSha?: string;
  rebuilds?: number;
};

test("FG-425 (AD-2): three REAL forge processes publishing to ONE project cannot interleave, and publish in DURABLE ENQUEUE-KEY order", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "fg425-fifo-"));
  const project = mkdtempSync(join(tmpdir(), "fg425-fifo-proj-"));
  try {
    git(project, ["init", "-b", "main"]);
    const seed = commit(project, "seed.txt", "seed\n");

    // Three independent task branches — one per contending process.
    const runs = ["run-p1", "run-p2", "run-p3"];
    for (const runId of runs) {
      const branch = `forge/${runId}/task`;
      git(project, ["checkout", "-q", "-b", branch, seed]);
      commit(project, `${runId}.txt`, `work from ${runId}\n`);
      git(project, ["checkout", "-q", "main"]);
    }

    // Force the shared on-disk DB to exist (schema + WAL) before the children
    // race to open it. FORGE_HOME is already a per-suite temp dir (test-setup.ts),
    // and the children inherit it — that is how they land in the same world.
    getDb();

    const driver = writeDriver(workdir);

    // Make the ENQUEUE order deterministic BY CONSTRUCTION: launch a child, then
    // wait until its row is actually on the durable lane before launching the next.
    //
    // Deliberately NOT a wall-clock stagger. A stagger would be asserting something
    // about node+tsx process startup (hundreds of ms, and wildly variable under a
    // loaded suite), not about forge: if child 2 happened to boot before child 1,
    // the enqueue order would invert and the test would fail for a reason that has
    // nothing to do with the lane. Waiting on the durable row removes the race
    // entirely rather than trying to out-sleep it.
    //
    // The contention is real regardless: each child then holds its candidate in
    // validation for 700ms, so by the time #3 enqueues, #1 is still validating and
    // all three are on the lane at once with something to order.
    const key = projectIdentity(project).key;
    const outputs: Record<string, string> = {};
    const completions: Promise<void>[] = [];

    for (const runId of runs) {
      completions.push(
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", driver, project, runId, `forge/${runId}/task`, "700"],
            { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          child.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`${runId} exited ${code}: ${stderr}`));
            outputs[runId] = stdout;
            resolve();
          });
          child.on("error", reject);
        }),
      );

      // Wait for THIS child's intent to be durably recorded before starting the next.
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (laneForProject(key).some((e) => e.runId === runId)) break;
        if (Date.now() > deadline) throw new Error(`${runId} never recorded its publication intent`);
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    }
    await Promise.all(completions);

    const results = runs.map((runId) => {
      const line = outputs[runId]?.trim().split("\n").pop() ?? "";
      return { runId, out: JSON.parse(line) as DriverOut };
    });

    // Every one of them published. Nothing was refused, parked, or lost.
    for (const { runId, out } of results) {
      assert.equal(out.kind, "published", `${runId} did not publish: ${JSON.stringify(out)}`);
      assert.equal(out.publishedSha, out.candidateSha, `${runId}: AD-6 — publishedSha must equal candidateSha`);
      assert.equal(
        out.rebuilds,
        0,
        `${runId} had to REBUILD (${out.rebuilds}), which means its base moved while it was validating — ` +
          `the lane failed to serialize the attempts`,
      );
    }

    // ── the mechanical FIFO assertion ──────────────────────────────────────────
    // Read the DURABLE lane from SQLite and order by the enqueue key that was
    // assigned at RECORD time. Not by timing. Not by who got a lock first.
    const lane = laneForProject(key);
    assert.equal(lane.length, 3, "all three attempts are on the durable lane");
    assert.deepEqual(
      lane.map((e) => e.enqueueSeq),
      [...lane.map((e) => e.enqueueSeq)].sort((a, b) => a - b),
      "laneForProject must return entries in durable enqueue order",
    );
    assert.deepEqual(lane.map((e) => e.state), ["done", "done", "done"], "no entry is left wedging the lane");

    const attempts = publicationAttemptsForProject(key);
    const byId = new Map(attempts.map((a) => [a.attemptId, a]));
    const inEnqueueOrder = lane.map((e) => {
      const a = byId.get(e.attemptId);
      assert.ok(a, `no attempt record for lane entry ${e.attemptId}`);
      return a;
    });

    // THE CHAIN: attempt N's base is attempt N-1's published sha. This can only
    // hold if each attempt captured its base AFTER the previous one published —
    // i.e. if the lane serialized them, in the durable order it recorded.
    assert.equal(inEnqueueOrder[0]?.baseSha, seed, "the first attempt in enqueue order started from the seed commit");
    for (let i = 1; i < inEnqueueOrder.length; i++) {
      assert.equal(
        inEnqueueOrder[i]?.baseSha,
        inEnqueueOrder[i - 1]?.publishedSha,
        `attempt ${i} (enqueue #${lane[i]?.enqueueSeq}) did not build on the previous attempt's published commit — ` +
          `the publication windows interleaved`,
      );
    }

    // And the enqueue order matched the launch order, so the lane is FIFO and not
    // merely "some serial order".
    assert.deepEqual(
      lane.map((e) => e.runId),
      runs,
      "the lane must publish in the order attempts were RECORDED, not in the order locks were granted",
    );

    // Every process's work is on the target, and the target is at the last
    // attempt's published sha.
    const head = git(project, ["rev-parse", "refs/heads/main"]);
    assert.equal(head, inEnqueueOrder[2]?.publishedSha);
    for (const runId of runs) {
      assert.ok(existsSync(join(project, `${runId}.txt`)), `${runId}'s work must be on the target`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
