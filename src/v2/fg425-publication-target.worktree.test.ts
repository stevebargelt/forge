// FG-425: the publication target's ENFORCEMENT half.
//
// These are the negative tests. A publisher that only ever gets exercised on its
// happy path is a wrong-publication trust gate with no gate: what matters here is
// what the target REFUSES — a candidate that does not descend from the base it was
// validated against, a dirty local target, a base that moved out from under a
// validated candidate — and that a refusal mutates NOTHING.
//
// The remote target is tested against a local BARE repo acting as the remote: a
// correctness test must not depend on a network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DirtyPublishTargetError,
  NonFastForwardError,
  dirtyTrackedFiles,
  isAncestor,
  localTargetFor,
  publishToTarget,
  readTargetSha,
  recoverCheckout,
  targetDescriptor,
  type RemoteTarget,
} from "./publication-target.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, body: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `add ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg425-target-"));
  git(dir, ["init", "-b", "main"]);
  commit(dir, "seed.txt", "seed\n");
  return dir;
}

/** A candidate branch built on `base`, exactly as the publisher builds one. */
function buildCandidate(repo: string, base: string, branch: string, file: string): string {
  git(repo, ["checkout", "-q", "-b", branch, base]);
  const sha = commit(repo, file, "candidate work\n");
  git(repo, ["checkout", "-q", "main"]);
  return sha;
}

test("FG-425 target: a local publish lands the RECORDED candidate sha and advances the checked-out tree", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    assert.equal(target.branch, "main");
    assert.equal(targetDescriptor(target), `local:${repo}#main`);

    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");

    const res = publishToTarget(target, base, candidate);
    assert.deepEqual(res, { ok: true, publishedSha: candidate });
    assert.equal(readTargetSha(target), candidate, "the target ref must carry the candidate");
    assert.equal(
      readFileSync(join(repo, "feature.txt"), "utf8"),
      "candidate work\n",
      "the checked-out working tree must have caught up with the ref",
    );
    assert.deepEqual(dirtyTrackedFiles(repo), [], "publishing must leave a clean tree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// AD-6, the load-bearing one. Validation binds to an IMMUTABLE sha. If the
// publisher resolved the candidate from its branch TIP at publish time, this test
// would land the unvalidated commit — which is the entire class of bug the ticket
// exists to close.
test("FG-425 target (AD-6): the candidate BRANCH is mutated after validation — the publish still lands the RECORDED sha, not the new tip", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const validatedSha = buildCandidate(repo, base, "cand", "feature.txt");

    // Someone (an agent, an operator, a retry) moves the candidate branch AFTER
    // validation. The tip now points at a commit nothing has ever tested.
    git(repo, ["checkout", "-q", "cand"]);
    const unvalidatedTip = commit(repo, "sneaky.txt", "never validated\n");
    git(repo, ["checkout", "-q", "main"]);
    assert.notEqual(unvalidatedTip, validatedSha);
    assert.equal(git(repo, ["rev-parse", "cand"]), unvalidatedTip, "the branch tip really did move");

    const res = publishToTarget(target, base, validatedSha);

    assert.equal(res.ok, true);
    assert.equal(res.ok && res.publishedSha, validatedSha, "publishedSha MUST equal the recorded candidateSha");
    assert.equal(readTargetSha(target), validatedSha);
    assert.throws(
      () => readFileSync(join(repo, "sneaky.txt"), "utf8"),
      "the unvalidated commit's content must NOT be on the target",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FG-425 target: the base moved — the CAS is LOST and the target is not touched", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");

    // An external writer advances the target after our base was captured.
    const moved = commit(repo, "external.txt", "someone else\n");
    assert.notEqual(moved, base);

    const res = publishToTarget(target, base, candidate);
    assert.deepEqual(res, { ok: false, kind: "cas_lost", currentSha: moved });
    assert.equal(readTargetSha(target), moved, "a lost CAS must not move the target");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// AD-3. The operator's dirty state is sacred: refuse BEFORE any mutation, and
// never stash / reset / clean / checkout over it.
test("FG-425 target (AD-3): a DIRTY local target is refused before any mutation, and the operator's dirty state is byte-identical afterward", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");

    const dirtyBody = "operator work in progress — DO NOT TOUCH\n";
    writeFileSync(join(repo, "seed.txt"), dirtyBody);
    const before = readFileSync(join(repo, "seed.txt"), "utf8");

    assert.throws(
      () => publishToTarget(target, base, candidate),
      (e: unknown) => {
        assert.ok(e instanceof DirtyPublishTargetError);
        assert.equal(e.reason, "dirty_publish_target", "the blocker must be NAMED");
        assert.match(e.message, /dirty_publish_target/);
        assert.match(e.message, /never stash, reset, or clean/i);
        return true;
      },
    );

    assert.equal(readTargetSha(target), base, "the ref must not have moved — refused BEFORE any mutation");
    assert.equal(readFileSync(join(repo, "seed.txt"), "utf8"), before, "the operator's dirty file must be byte-identical");
    assert.deepEqual(dirtyTrackedFiles(repo), ["M seed.txt"], "the dirt is still there — forge did not 'help'");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FG-425 target (AD-5): recovery derives from {baseSha, candidateSha, currentTargetSha} alone", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");

    assert.deepEqual(recoverCheckout(target, base, candidate), { state: "not_published" });

    // Advance the REF only — precisely the AD-5 window: the ref carries the
    // candidate, the checked-out tree does not yet.
    git(repo, ["update-ref", "refs/heads/main", candidate, base]);
    assert.throws(() => readFileSync(join(repo, "feature.txt"), "utf8"), "precondition: the tree has NOT caught up");

    const rec = recoverCheckout(target, base, candidate);
    assert.deepEqual(rec, { state: "published", publishedSha: candidate });
    assert.equal(
      readFileSync(join(repo, "feature.txt"), "utf8"),
      "candidate work\n",
      "recovery must finish the outstanding checkout update",
    );

    // Idempotent: re-running converges and never discards the publication.
    assert.deepEqual(recoverCheckout(target, base, candidate), { state: "published", publishedSha: candidate });
    assert.equal(readTargetSha(target), candidate);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FG-425 target (AD-5): a target at NEITHER base nor candidate is an external writer, not a publication", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");
    const external = commit(repo, "external.txt", "someone else\n");

    assert.deepEqual(recoverCheckout(target, base, candidate), {
      state: "external_writer",
      currentSha: external,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── the remote target ─────────────────────────────────────────────────────────

function initRemotePair(): { bare: string; work: string } {
  const bare = mkdtempSync(join(tmpdir(), "fg425-bare-"));
  git(bare, ["init", "--bare", "-b", "main"]);
  const work = mkdtempSync(join(tmpdir(), "fg425-work-"));
  git(work, ["init", "-b", "main"]);
  commit(work, "seed.txt", "seed\n");
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);
  return { bare, work };
}

test("FG-425 remote: the happy path pushes the recorded candidate with an EXPLICIT expected-sha lease", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    assert.equal(base, git(work, ["rev-parse", "HEAD"]));

    const candidate = buildCandidate(work, base, "cand", "feature.txt");
    const res = publishToTarget(target, base, candidate);

    assert.deepEqual(res, { ok: true, publishedSha: candidate });
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), candidate, "the remote ref must carry the candidate");
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// THE enforcement test. --force-with-lease carries FORCE semantics: once its CAS
// matches, it will happily push a NON-fast-forward candidate and discard target
// history. The lease constrains the BASE of the update, not its SHAPE. So the
// ancestry proof is a SEPARATE, required check that must run BEFORE any push —
// a naked lease push is not sufficient.
test("FG-425 remote (NEGATIVE): a candidate that does NOT descend from baseSha is refused — no push happens, the remote is untouched", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);

    // An orphan commit: a perfectly valid sha that shares NO history with base.
    // Pushing it under a matching lease would silently discard the target's
    // history — exactly what the lease alone would permit.
    git(work, ["checkout", "-q", "--orphan", "rogue"]);
    git(work, ["rm", "-rq", "--cached", "."]);
    const rogue = commit(work, "rogue.txt", "history rewrite\n");
    git(work, ["checkout", "-q", "-f", "main"]);

    assert.equal(isAncestor(work, base, rogue), false, "precondition: the rogue commit does not descend from base");

    assert.throws(
      () => publishToTarget(target, base, rogue),
      (e: unknown) => {
        assert.ok(e instanceof NonFastForwardError, "must be the named non-fast-forward refusal");
        assert.match(e.message, /does not descend from the validated base/);
        assert.match(e.message, /never authorization for a non-fast-forward update/);
        return true;
      },
    );

    assert.equal(
      git(bare, ["rev-parse", "refs/heads/main"]),
      base,
      "the remote must be untouched — the refusal happens BEFORE any push",
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("FG-425 remote: the lease REJECTS a stale base — the remote moved, so the CAS is lost and nothing is overwritten", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    // A second clone pushes first: the remote moves off the base we validated.
    const other = mkdtempSync(join(tmpdir(), "fg425-other-"));
    git(other, ["clone", "-q", bare, "."]);
    const theirs = commit(other, "theirs.txt", "another writer\n");
    git(other, ["push", "-q", "origin", "main"]);
    rmSync(other, { recursive: true, force: true });

    const res = publishToTarget(target, base, candidate);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.kind, "cas_lost");
    assert.equal(
      git(bare, ["rev-parse", "refs/heads/main"]),
      theirs,
      "the other writer's commit must survive — a lost lease must never clobber it",
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
