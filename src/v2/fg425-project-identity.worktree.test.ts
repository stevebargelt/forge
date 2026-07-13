// FG-425 (AD-2): the publication lane is keyed on CANONICAL project identity.
//
// Every other FG-425 test drives the publisher through ONE spelling of the
// project directory, so they would all still pass if the lane were keyed on the
// raw string it was handed. That is the gap this file closes, and it is a
// correctness gap and not a cosmetic one: canonical identity is the ONLY thing
// that puts two runs on the same repo into the same lane. If it collapses the
// spellings, they serialize. If it does not, they each become head of their own
// lane, capture the SAME base concurrently, and race the CAS — which is the
// moving-HEAD interleave the whole ticket exists to prevent.
//
// The lane is therefore load-bearing on realpath, and realpath's job is not
// tested anywhere by the shape the publisher actually consumes it in: a lane.
//
// THE MECHANICAL DISCRIMINATOR (test 2). Two publications on ONE repo, launched
// concurrently through DIFFERENT spellings (physical path vs symlink):
//
//   collapsed to one identity  → they share a lane → the second captures its base
//                                AFTER the first published
//                                  ⇒ baseSha[2] === publishedSha[1], rebuilds === 0
//   NOT collapsed              → two lanes, both head, both capture the seed as
//                                base, one loses the CAS
//                                  ⇒ rebuilds === 1 (or a churn park)
//
// So `rebuilds === 0 && baseSha[2] === publishedSha[1]` cannot be satisfied by a
// publisher that failed to collapse the spellings. It is not a timing inference.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { laneForProject } from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";
import { publishIntegration } from "./integration-publisher.js";

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

/** mkdtemp hands back a path that may itself be a symlink (/tmp → /private/tmp on
 *  macOS). Canonicalize it here so "the physical path" in these tests really is
 *  the physical one, and the symlink under test is the one WE created. */
function makeRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  git(dir, ["init", "-b", "main"]);
  return dir;
}

function seedRun(runId: string, projectDir: string): void {
  insertRun({
    id: runId,
    workflow: "fg425",
    title: "fg425 identity test",
    status: "active",
    projectDir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
}

test("FG-425 (AD-2): symlink, trailing-slash and relative spellings of ONE repo collapse to ONE project identity", () => {
  const project = makeRepo("fg425-ident-");
  commit(project, "seed.txt", "seed\n");

  // A symlink pointing at the repo — the spelling a second `forge next` gets when
  // the operator runs it from a linked checkout.
  const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "fg425-link-")));
  cleanup.push(linkParent);
  const symlinked = join(linkParent, "project-link");
  symlinkSync(project, symlinked);

  const canonical = projectIdentity(project);

  const spellings: Array<[string, string]> = [
    ["symlink", symlinked],
    ["trailing slash", `${project}/`],
    ["redundant segments", join(project, "..", basename(project))],
    ["dot segment", join(project, ".")],
  ];

  for (const [label, spelling] of spellings) {
    const id = projectIdentity(spelling);
    assert.equal(
      id.key,
      canonical.key,
      `the ${label} spelling must collapse to the SAME lane key — otherwise two runs on one repo get two lanes ` +
        `and publish against each other's moving HEAD`,
    );
    assert.equal(id.canonicalDir, canonical.canonicalDir, `the ${label} spelling must resolve to the physical dir`);
  }
});

test("FG-425 (AD-2): genuinely different repos get DIFFERENT identities — the collapse is not a constant", () => {
  // The negative control. Without it, `projectIdentity` could return a fixed
  // string and every assertion in the test above would still pass.
  const a = makeRepo("fg425-ident-a-");
  const b = makeRepo("fg425-ident-b-");

  assert.notEqual(
    projectIdentity(a).key,
    projectIdentity(b).key,
    "two different projects must NOT share a lane — runs on different projectDirs stay fully parallel",
  );
});

test("FG-425 (AD-2): two concurrent publications on ONE repo through DIFFERENT spellings share ONE lane and cannot interleave", async () => {
  const project = makeRepo("fg425-ident-lane-");
  const seed = commit(project, "seed.txt", "seed\n");

  const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "fg425-lane-link-")));
  cleanup.push(linkParent);
  const symlinked = join(linkParent, "project-link");
  symlinkSync(project, symlinked);

  // Two independent task branches — one per contending run, no content conflict,
  // so anything that goes wrong here is the lane's doing and not a merge's.
  for (const runId of ["run-phys", "run-link"]) {
    git(project, ["checkout", "-q", "-b", `forge/${runId}/task`, seed]);
    commit(project, `${runId}.txt`, `work from ${runId}\n`);
    git(project, ["checkout", "-q", "main"]);
  }
  seedRun("run-phys", project);
  seedRun("run-link", symlinked);

  // Each holds its candidate in validation, so the two attempts genuinely overlap
  // in wall-clock time and the lane has something real to order. `publishIntegration`
  // records its intent (and its durable enqueue key) SYNCHRONOUSLY before its first
  // await, so starting phys-then-link fixes the enqueue order by construction —
  // no sleep, no stagger, no race on process scheduling.
  const publish = (runId: string, projectDir: string): ReturnType<typeof publishIntegration> =>
    publishIntegration({
      runId,
      taskId: `task-${runId}`,
      projectDir,
      sources: [{ branch: `forge/${runId}/task`, label: runId }],
      lane: { pollMs: 10, log: () => {} },
      alsoValidate: async () => {
        await new Promise<void>((r) => setTimeout(r, 250));
        return { ok: true };
      },
    });

  // The physical spelling goes first; the SYMLINK spelling contends.
  const physPromise = publish("run-phys", project);
  const linkPromise = publish("run-link", symlinked);
  const [phys, link] = await Promise.all([physPromise, linkPromise]);

  assert.equal(phys.kind, "published", `run-phys did not publish: ${JSON.stringify(phys)}`);
  assert.equal(link.kind, "published", `run-link did not publish: ${JSON.stringify(link)}`);
  if (phys.kind !== "published" || link.kind !== "published") return;

  // ── ONE lane, keyed on the canonical identity ──────────────────────────────
  const key = projectIdentity(project).key;
  const lane = laneForProject(key);
  assert.equal(
    lane.length,
    2,
    "BOTH attempts must land on the ONE canonical lane — a second lane means the symlink spelling was treated " +
      "as a different project",
  );
  assert.deepEqual(
    lane.map((e) => e.runId),
    ["run-phys", "run-link"],
    "the lane must be ordered by the durable enqueue key assigned at record time",
  );
  assert.deepEqual(lane.map((e) => e.state), ["done", "done"], "no entry is left wedging the lane");

  // ── the mechanical serialization proof ─────────────────────────────────────
  // run-link captured its base AFTER run-phys published. This is only possible if
  // the two spellings shared a lane; with two lanes they would both have captured
  // `seed` and one would have lost the CAS and rebuilt.
  assert.equal(phys.baseSha, seed, "the first attempt in enqueue order started from the seed commit");
  assert.equal(
    link.baseSha,
    phys.publishedSha,
    "the symlink-spelled attempt did not build on the physical-spelled attempt's published commit — the two " +
      "spellings were NOT collapsed to one identity, so their publication windows interleaved",
  );
  assert.equal(link.rebuilds, 0, "run-link had to REBUILD, which means its base moved under it — the lane failed");
  assert.equal(phys.rebuilds, 0, "run-phys had to REBUILD, which means its base moved under it — the lane failed");

  // AD-6, on both attempts.
  assert.equal(phys.publishedSha, phys.candidateSha, "AD-6: publishedSha must be the RECORDED candidateSha");
  assert.equal(link.publishedSha, link.candidateSha, "AD-6: publishedSha must be the RECORDED candidateSha");

  // Both runs' work is on the one target, which is at the last published sha.
  assert.equal(git(project, ["rev-parse", "refs/heads/main"]), link.publishedSha);
  for (const f of ["run-phys.txt", "run-link.txt"]) {
    // `cat-file -e` exits non-zero (and git() throws) if the blob is not reachable
    // from the target — so this asserts BOTH runs' work actually landed.
    git(project, ["cat-file", "-e", `refs/heads/main:${f}`]);
  }
});
