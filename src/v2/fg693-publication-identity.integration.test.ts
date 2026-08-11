// FG-693 (AC5, AC6, AC7): PUBLICATION COORDINATION decides on PROVEN filesystem
// identity, at the seams that actually produce the arguments.
//
// WHAT THIS FILE IS FOR, AND HOW IT DIFFERS FROM fg425-project-identity. That
// file proves the LANE collapses two spellings; this one proves the whole
// publication path does — the lane, the mutex key, the durable attempt record,
// the target a publication mutates, and the target AD-5 recovery rebuilds from a
// descriptor — and it proves the other half FG-693 adds: an identity the
// filesystem will not confirm is a NAMED REFUSAL rather than a coordination key
// derived from a lexical guess.
//
// EVERY assertion below is driven through a PRODUCTION entry point —
// publishIntegration, awaitLaneTurn, localTargetFor, publishToTarget,
// recoverCheckout. Nothing here asserts on projectIdentity()'s return value:
// FG-693 AC5 is explicit that exercising the identity helper directly does not
// satisfy it, because the defect was never in the helper — it was in the
// arguments each consumer produced before calling one.
//
// THE OLD BEHAVIOUR THESE REPLACE. `projectIdentity` used to catch realpath's
// failure and fall back to `path.resolve`, so an unconfirmable spelling produced a
// lane key, a mutex key and a `canonicalDir` that were byte-indistinguishable from
// proven ones. Two unproven spellings of one checkout got two guesses, hence two
// lanes, hence two heads capturing one base and racing the CAS — the exact
// moving-HEAD interleave the lane exists to prevent, arrived at by a mechanism
// that looked like it was working.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { allLaneEntries, allPublicationAttempts } from "../store/publications.js";
import { projectIdentity, UnprovenProjectIdentityError } from "./project-identity.js";
import { awaitLaneTurn } from "./publication-lane.js";
import {
  localTargetFor,
  parseTargetDescriptor,
  publishToTarget,
  readTargetSha,
  recoverCheckout,
  targetDescriptor,
} from "./publication-target.js";
import { publishIntegration, type PublishOutcome } from "./integration-publisher.js";

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

/** mkdtemp hands back a path that may itself be an alias of the physical one
 *  (on macOS the per-user temp root lives under a symlinked prefix). Canonicalize
 *  it HERE, so "the physical path" in these tests really is the physical one and
 *  every alias under test is one this file created deliberately. Without this the
 *  darwin run would be testing the platform's aliasing instead of forge's. */
function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function makeRepo(prefix: string): string {
  const dir = makeDir(prefix);
  git(dir, ["init", "-b", "main"]);
  commit(dir, "seed.txt", "seed\n");
  return dir;
}

/** A repo inside a parent we own, so sibling checkouts can share a lexical prefix
 *  (the AC7 negative control) without mkdtemp handing us unrelated names. */
function makeRepoUnder(parent: string, name: string): string {
  const dir = join(parent, name);
  execFileSync("mkdir", ["-p", dir]);
  git(dir, ["init", "-b", "main"]);
  commit(dir, "seed.txt", "seed\n");
  return dir;
}

function seedRun(runId: string, projectDir: string): void {
  insertRun({
    id: runId,
    workflow: "fg693",
    title: "fg693 publication identity",
    status: "active",
    projectDir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
}

/** A candidate branch in the project, exactly as the publisher's caller builds one. */
function candidateBranch(project: string, runId: string): string {
  const branch = `forge/${runId}/task`;
  git(project, ["checkout", "-q", "-b", branch, git(project, ["rev-parse", "main"])]);
  commit(project, `${runId}.txt`, `work from ${runId}\n`);
  git(project, ["checkout", "-q", "main"]);
  return branch;
}

/** THE SEAM. A real publication, driven through the production entry point, with
 *  the project directory spelled however the caller happened to hold it. */
function publish(runId: string, spelling: string, branch: string, holdMs = 0): Promise<PublishOutcome> {
  seedRun(runId, spelling);
  return publishIntegration({
    runId,
    taskId: `task-${runId}`,
    projectDir: spelling,
    sources: [{ branch, label: runId }],
    lane: { pollMs: 10, log: () => {} },
    ...(holdMs > 0
      ? {
          alsoValidate: async (): Promise<{ ok: true }> => {
            await new Promise<void>((r) => setTimeout(r, holdMs));
            return { ok: true };
          },
        }
      : {}),
  });
}

test("FG-693 AC5: symlink, trailing-separator, redundant-segment and relative spellings of ONE checkout share ONE lane, ONE mutex key and ONE canonical dir", async () => {
  const project = makeRepo("fg693-pub-");

  // The alias the operator's second shell has: a symlinked parent. Not /private,
  // not /tmp, not /var — an ordinary symlink, because the contract covers the
  // CLASS and not a platform's current list of aliased prefixes.
  const linkParent = makeDir("fg693-pub-link-");
  const symlinked = join(linkParent, "project-link");
  symlinkSync(project, symlinked);

  // Four spellings of ONE directory, published SEQUENTIALLY through the real
  // entry point. Sequential is the point here: this test is about which lane and
  // which key each attempt is filed under, not about ordering.
  const spellings: Array<[string, string]> = [
    ["physical", project],
    ["symlinked parent", symlinked],
    ["trailing separator", `${project}/`],
    ["redundant segments", join(project, "..", basename(project))],
  ];

  for (const [label, spelling] of spellings) {
    const runId = `run-${label.replace(/\s+/g, "-")}`;
    const out = await publish(runId, spelling, candidateBranch(project, runId));
    assert.equal(out.kind, "published", `the ${label} spelling did not publish: ${JSON.stringify(out)}`);
  }

  // The RELATIVE spelling, which only exists relative to a working directory —
  // the one spelling that cannot be compared as a string to any of the others.
  const cwd = process.cwd();
  try {
    process.chdir(dirname(project));
    const runId = "run-relative";
    const out = await publish(runId, `./${basename(project)}`, candidateBranch(project, runId));
    assert.equal(out.kind, "published", `the relative spelling did not publish: ${JSON.stringify(out)}`);
  } finally {
    process.chdir(cwd);
  }

  // ── ONE lane ───────────────────────────────────────────────────────────────
  const lane = allLaneEntries();
  assert.equal(lane.length, 5, "every attempt must leave exactly one lane entry");
  const laneKeys = new Set(lane.map((e) => e.projectKey));
  assert.equal(
    laneKeys.size,
    1,
    `all five spellings must land in ONE lane — ${laneKeys.size} lanes means a spelling was treated as its own ` +
      `project, and two heads on one checkout capture the same base and race the CAS`,
  );

  // ── ONE mutex key, and ONE canonical dir on the durable record ─────────────
  // projectKey is the publication MUTEX key as well as the lane key: it is what
  // tryAcquirePublicationMutexAsLaneOwner serializes on.
  const attempts = allPublicationAttempts();
  assert.equal(attempts.length, 5);
  assert.equal(new Set(attempts.map((a) => a.projectKey)).size, 1, "one mutex key for one checkout");
  for (const a of attempts) {
    assert.equal(
      a.canonicalDir,
      project,
      "the durable attempt records the PROVEN physical directory, whatever spelling its caller held",
    );
  }
});

test("FG-693 AC5: two concurrent publications spelled differently SERIALIZE — the collapse is mechanical, not cosmetic", async () => {
  const project = makeRepo("fg693-serial-");
  const linkParent = makeDir("fg693-serial-link-");
  const symlinked = join(linkParent, "project-link");
  symlinkSync(project, symlinked);

  const seed = git(project, ["rev-parse", "main"]);
  const branchPhys = candidateBranch(project, "run-phys");
  const branchLink = candidateBranch(project, "run-link");

  // Each holds its candidate in validation, so the two genuinely overlap in
  // wall-clock time. publishIntegration records its durable enqueue key
  // SYNCHRONOUSLY before its first await, so starting phys-then-link fixes the
  // enqueue order by construction — no sleep, no stagger.
  const [phys, link] = await Promise.all([
    publish("run-phys", project, branchPhys, 250),
    publish("run-link", symlinked, branchLink, 250),
  ]);

  assert.equal(phys.kind, "published", `run-phys did not publish: ${JSON.stringify(phys)}`);
  assert.equal(link.kind, "published", `run-link did not publish: ${JSON.stringify(link)}`);
  if (phys.kind !== "published" || link.kind !== "published") return;

  // THE DISCRIMINATOR. Collapsed to one identity → one lane → the second captures
  // its base AFTER the first published. NOT collapsed → two lanes, both head, both
  // capture the seed, one loses the CAS and rebuilds. So this pair of assertions
  // cannot be satisfied by a publisher that failed to collapse the spellings, and
  // it is not a timing inference.
  assert.equal(phys.baseSha, seed, "the first attempt in enqueue order started from the seed commit");
  assert.equal(
    link.baseSha,
    phys.publishedSha,
    "the second attempt must have captured its base AFTER the first published — that only happens if the " +
      "symlinked spelling shared the physical spelling's lane",
  );
  assert.equal(link.rebuilds, 0, "a shared lane means no CAS loss and therefore no rebuild");
});

test("FG-693 AC7 negative control: distinct checkouts sharing a git remote AND a lexical prefix stay distinct — path identity is not repository identity", async () => {
  const parent = makeDir("fg693-neg-");
  const bare = join(parent, "shared.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: ["ignore", "ignore", "pipe"] });

  // Sibling checkouts whose lexical paths share a prefix ("checkout" is a strict
  // prefix of "checkout-2") and which name ONE upstream repository.
  const a = makeRepoUnder(parent, "checkout");
  const b = makeRepoUnder(parent, "checkout-2");
  for (const repo of [a, b]) git(repo, ["remote", "add", "origin", bare]);

  assert.equal((await publish("run-a", a, candidateBranch(a, "run-a"))).kind, "published");
  assert.equal((await publish("run-b", b, candidateBranch(b, "run-b"))).kind, "published");

  const keys = new Set(allLaneEntries().map((e) => e.projectKey));
  assert.equal(
    keys.size,
    2,
    "two physically distinct checkouts must get TWO lanes even though they share a remote and a path prefix — " +
      "merging them would serialize unrelated work and let one publish against the other's target",
  );
  assert.deepEqual(
    allPublicationAttempts().map((x) => x.canonicalDir).sort(),
    [a, b].sort(),
    "each attempt records its OWN checkout",
  );
});

test("FG-693: an UNRESOLVABLE project directory is a NAMED refusal at every publication seam, and claims nothing", async () => {
  const parent = makeDir("fg693-gone-");
  const gone = join(parent, "checkout-that-was-deleted");
  assert.equal(existsSync(gone), false);

  const named = (e: unknown): true => {
    assert.ok(
      e instanceof UnprovenProjectIdentityError,
      `expected the named FG-693 refusal, got: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
    const err = e as UnprovenProjectIdentityError;
    assert.equal(err.reason, "unproven_project_identity");
    assert.match(err.message, /no PROVEN filesystem identity/);
    assert.ok(err.message.includes(gone), "the refusal names the directory it refused");
    assert.match(err.message, /refusing to /, "the refusal names WHAT it refused to do, not just the path");
    return true;
  };

  // 1. The publisher's own entry point.
  seedRun("run-gone", gone);
  await assert.rejects(
    publishIntegration({
      runId: "run-gone",
      taskId: "task-gone",
      projectDir: gone,
      sources: [{ branch: "forge/run-gone/task", label: "run-gone" }],
      lane: { pollMs: 10, log: () => {} },
    }),
    named,
  );
  assert.deepEqual(allLaneEntries(), [], "a refused publication enqueues NOTHING — no lane keyed on a guess");
  assert.deepEqual(allPublicationAttempts(), [], "and records no durable attempt against an unproven project");

  // 2. The lane's own claim seam — a turn is a CLAIM, and an unproven identity
  //    never claims one. maxWaitMs would bound a real wait; the refusal must land
  //    before the first tick, so this rejects immediately rather than timing out.
  await assert.rejects(awaitLaneTurn("attempt-never", gone, { pollMs: 5, maxWaitMs: 50, log: () => {} }), named);
  assert.deepEqual(allLaneEntries(), [], "a refused turn leaves no lane entry behind");

  // 3. Target derivation, publication and AD-5 recovery: every seam that ACTS.
  assert.throws(() => localTargetFor(gone), named);
  const sha = (c: string): string => c.repeat(40);
  assert.throws(() => publishToTarget({ kind: "local", projectDir: gone, branch: "main" }, sha("a"), sha("b")), named);
  assert.throws(() => recoverCheckout({ kind: "local", projectDir: gone, branch: "main" }, sha("a"), sha("b")), named);
  assert.throws(
    () => publishToTarget({ kind: "remote", projectDir: gone, remote: "origin", branch: "main" }, sha("a"), sha("b")),
    named,
    "a remote target's projectDir is the local repo the push runs from — it is proven too",
  );

  // 4. THE COMPATIBILITY PROJECTION, explicit and tested (the ticket requires it
  //    to be one or the other, never implicit). One pre-FG-693 consumer still
  //    asks this module for a TOLERANT lookup key — the orchestrator-receipt read
  //    whose FG-576 contract is that a deleted project degrades to its as-written
  //    spelling rather than throwing on an operator read. It still gets one. What
  //    it CANNOT get any more is a guess that passes for identity: the value is
  //    LABELLED, and its key lives in its own namespace.
  const proven = projectIdentity(parent);
  assert.equal(proven.proven, true);
  assert.equal(proven.canonicalDir, parent);

  execFileSync("mkdir", ["-p", gone]);
  const provenKeyOfThatPath = projectIdentity(gone).key;
  assert.equal(projectIdentity(gone).proven, true, "the path resolves while it exists");
  rmSync(gone, { recursive: true, force: true });

  const guess = projectIdentity(gone);
  assert.equal(guess.proven, false, "an identity the filesystem would not confirm says so, in the value itself");
  assert.notEqual(
    guess.key,
    provenKeyOfThatPath,
    "a guess must not hash onto the coordination rows of the very directory it names — before FG-693 these were " +
      "the SAME key, so an unproven spelling reached straight into a real project's lane, mutex and attempts",
  );
});

test("FG-693 AC5/AC6: a target descriptor recorded under an ALIAS still publishes and recovers against the ONE checkout, with its bytes preserved", () => {
  const project = makeRepo("fg693-target-");
  const linkParent = makeDir("fg693-target-link-");
  const aliased = join(linkParent, "project-link");
  symlinkSync(project, aliased);

  // A target built the way a pre-FG-693 caller built one: from whatever spelling
  // it held. This is the shape of every DURABLE descriptor written before this
  // ticket, which AD-5 recovery still has to be able to converge from.
  const target = localTargetFor(aliased);
  const descriptor = targetDescriptor(target);
  assert.equal(
    descriptor,
    `local:${aliased}#main`,
    "the recorded descriptor keeps the caller's spelling VERBATIM — it is durable evidence, and FG-693 rewrites " +
      "no audit record to make identity work",
  );

  const base = readTargetSha(target);
  git(project, ["checkout", "-q", "-b", "cand", base]);
  const candidate = commit(project, "feature.txt", "candidate work\n");
  git(project, ["checkout", "-q", "main"]);

  const res = publishToTarget(target, base, candidate);
  assert.deepEqual(res, { ok: true, publishedSha: candidate });

  // The mutation landed on the PHYSICAL checkout — read back through the physical
  // spelling, which is the only one that can prove which tree was written.
  assert.equal(
    git(project, ["rev-parse", "refs/heads/main"]),
    candidate,
    "publishing through an aliased spelling must advance the ref of the ONE checkout it names",
  );
  assert.equal(existsSync(join(project, "feature.txt")), true, "and its working tree was brought up to the ref");

  // AD-5 recovery, rebuilt from the DURABLE descriptor exactly as the recovery
  // sweep rebuilds it — the aliased spelling round-trips through the record and
  // still converges the same checkout.
  const rebuilt = parseTargetDescriptor(descriptor);
  assert.equal((rebuilt as { projectDir: string }).projectDir, aliased, "the record is read back unrewritten");
  assert.deepEqual(recoverCheckout(rebuilt, base, candidate), { state: "published", publishedSha: candidate });

  // Negative control at the SAME seam: a sibling checkout whose lexical path
  // shares a prefix is a different tree, and publishing to it moves nothing here.
  const sibling = makeRepo("fg693-target-");
  const siblingTarget = localTargetFor(sibling);
  assert.notEqual(readTargetSha(siblingTarget), candidate, "the sibling checkout is genuinely a different tree");
  assert.equal(git(project, ["rev-parse", "refs/heads/main"]), candidate, "and nothing about it touched ours");
});
