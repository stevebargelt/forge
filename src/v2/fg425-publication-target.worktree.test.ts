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

// The other reason a CAS can fail, and the one that must NOT be reported as a moved
// base: our hold lapsed in the sliver between the window's last renewal and the
// update-ref, and the attempt that TOOK the window is what advanced the ref. Calling
// that `cas_lost` would send the publisher off to rebuild and re-enter a window it no
// longer owns; a lost hold must fail CLOSED.
test("FG-425 target: a CAS lost because the HOLD was lost fails CLOSED — never reported as cas_lost", () => {
  const repo = initRepo();
  try {
    const target = localTargetFor(repo);
    const base = readTargetSha(target);
    const candidate = buildCandidate(repo, base, "cand", "feature.txt");

    class HoldLost extends Error {}
    // The window's renewals, in order: ancestry, tracked-dirt, untracked, ref read,
    // and then the LAST renewal before the CAS. The takeover fires on that last one:
    // the winner advances the ref and our hold is gone from there on.
    const RENEWALS_BEFORE_CAS = 5;
    let calls = 0;
    let stolen = false;
    let winner = "";
    const renewHold = () => {
      if (stolen) throw new HoldLost();
      if (++calls === RENEWALS_BEFORE_CAS) {
        winner = commit(repo, "winner.txt", "the attempt that took the window\n");
        stolen = true;
      }
    };

    assert.throws(() => publishToTarget(target, base, candidate, { renewHold }), HoldLost);
    assert.ok(stolen, "the takeover must have fired INSIDE the window, on the renewal before the CAS");
    assert.equal(readTargetSha(target), winner, "a lost hold must never land the candidate over the winner");
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

// The remote half of AD-5's "target at neither SHA" branch. A candidate that WON its
// lease push and was then fast-forwarded on top of is IN the remote's history — it
// landed. Recovery must fetch that history and say so; parking it as churn tells the
// operator nothing was published while the commit sits on the target (FG-425 AC5).
test("FG-425 remote (AD-5): a candidate the remote FAST-FORWARDED past is published, not parked as churn", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    assert.deepEqual(publishToTarget(target, base, candidate), { ok: true, publishedSha: candidate });

    // A later writer builds ON TOP of our candidate and pushes: the remote is now at
    // D, which descends from C. The publisher crashed before it recorded anything.
    const other = mkdtempSync(join(tmpdir(), "fg425-other-"));
    git(other, ["clone", "-q", bare, "."]);
    const later = commit(other, "later.txt", "built on our candidate\n");
    git(other, ["push", "-q", "origin", "main"]);
    rmSync(other, { recursive: true, force: true });

    assert.equal(readTargetSha(target), later, "precondition: the remote is at neither the base nor the candidate");

    assert.deepEqual(recoverCheckout(target, base, candidate), {
      state: "published",
      publishedSha: candidate,
      superseded: true,
    });
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("FG-425 remote (AD-5): a remote moved off the candidate's history IS an external writer", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    // Someone else pushes a commit on the base — our candidate never landed.
    const other = mkdtempSync(join(tmpdir(), "fg425-other-"));
    git(other, ["clone", "-q", bare, "."]);
    const theirs = commit(other, "theirs.txt", "another writer\n");
    git(other, ["push", "-q", "origin", "main"]);
    rmSync(other, { recursive: true, force: true });

    assert.deepEqual(recoverCheckout(target, base, candidate), { state: "external_writer", currentSha: theirs });
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// ── AD-5 remote recovery classifies from the FETCHED tip, not the pre-fetch read ──
//
// The remote's sha is READ (ls-remote) before recovery fetches its history, and the
// remote can move in that window. Recovery must therefore decide from the tip the
// FETCH observed, never from the sha it read a round trip earlier: a disposition
// derived from an obsolete snapshot of the target — above all a TERMINAL one — is the
// AC5 lie (one truthful final disposition) wearing a different hat.
//
// `renew` is the honest seam for that window: recoverCheckout renews the hold before
// each git op, so the SECOND renewal lands after the ls-remote read and before the
// fetch. `moveRemote` fires exactly once, there.
function movesRemoteAfterTheRead(move: () => void): () => void {
  let calls = 0;
  let moved = false;
  return () => {
    if (++calls >= 2 && !moved) {
      moved = true;
      move();
    }
  };
}

/** A throwaway clone that commits on top of the remote's main and pushes. */
function pushOnTop(bare: string, file: string): string {
  const other = mkdtempSync(join(tmpdir(), "fg425-other-"));
  git(other, ["clone", "-q", bare, "."]);
  const sha = commit(other, file, `${file}\n`);
  git(other, ["push", "-q", "origin", "main"]);
  rmSync(other, { recursive: true, force: true });
  return sha;
}

test("FG-425 remote (AD-5): the ref moves between the READ and the FETCH onto a tip that still contains the candidate — published, not churn", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    assert.deepEqual(publishToTarget(target, base, candidate), { ok: true, publishedSha: candidate });
    const laterD = pushOnTop(bare, "later-d.txt");
    assert.equal(readTargetSha(target), laterD, "precondition: the pre-fetch read sees D");

    // A third writer rewrites the tip onto E — still built on our candidate, but D is
    // no longer in the target's history. Recovery reads D, and the ref becomes E before
    // its fetch. The candidate is in the target's history either way: it is published.
    const rewrite = mkdtempSync(join(tmpdir(), "fg425-rewrite-"));
    git(rewrite, ["clone", "-q", bare, "."]);
    git(rewrite, ["reset", "-q", "--hard", candidate]);
    const tipE = commit(rewrite, "e.txt", "rewritten on top of the candidate\n");

    const outcome = recoverCheckout(
      target,
      base,
      candidate,
      movesRemoteAfterTheRead(() => {
        git(rewrite, ["push", "-q", "--force", "origin", "main"]);
      }),
    );
    rmSync(rewrite, { recursive: true, force: true });

    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), tipE, "precondition: the remote really did move to E");
    assert.deepEqual(
      outcome,
      { state: "published", publishedSha: candidate, superseded: true },
      "the FETCHED tip contains the candidate — recovery must report it published, never external_writer or churn",
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("FG-425 remote (AD-5): the ref moves between the READ and the FETCH onto a tip WITHOUT the candidate — classified from the fetched tip, never the stale sha", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    // Our candidate never landed: an external writer holds the ref at X.
    const staleX = pushOnTop(bare, "theirs-x.txt");
    assert.equal(readTargetSha(target), staleX, "precondition: the pre-fetch read sees X");

    let tipY = "";
    const outcome = recoverCheckout(
      target,
      base,
      candidate,
      movesRemoteAfterTheRead(() => {
        tipY = pushOnTop(bare, "theirs-y.txt");
      }),
    );

    assert.notEqual(tipY, staleX);
    assert.deepEqual(
      outcome,
      { state: "external_writer", currentSha: tipY },
      "the reported target sha must be the tip the FETCH observed, not the sha read before it",
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// The terminalizing shape of the same defect, and the one AC5 exists to forbid: the
// stale sha CONTAINS the candidate (so the stale snapshot says "published" — terminal,
// immutable) while the tip the fetch actually observed does NOT. Deciding from the
// pre-fetch sha here settles the attempt, permanently, on a target state that no longer
// exists.
test("FG-425 remote (AD-5): a stale pre-fetch sha that contains the candidate must NOT terminalize the attempt when the FETCHED tip does not", () => {
  const { bare, work } = initRemotePair();
  try {
    const target: RemoteTarget = { kind: "remote", projectDir: work, remote: "origin", branch: "main" };
    const base = readTargetSha(target);
    const candidate = buildCandidate(work, base, "cand", "feature.txt");

    assert.deepEqual(publishToTarget(target, base, candidate), { ok: true, publishedSha: candidate });
    const staleD = pushOnTop(bare, "later-d.txt");

    // An earlier recovery pass already fetched D into this repo's object store, so D is
    // a perfectly readable local object — which is exactly why "the object exists" is
    // not the question. The question is where the REF is.
    git(work, ["fetch", "-q", "origin", "refs/heads/main"]);
    assert.equal(git(work, ["rev-parse", `${staleD}^{commit}`]), staleD, "precondition: D is a local object");
    assert.ok(isAncestor(work, candidate, staleD), "precondition: the STALE sha contains the candidate");

    // The ref is then force-moved off our candidate entirely, between the read and the
    // fetch. Our commit is NOT in the target's history any more.
    const wiped = commit(work, "wipe.txt", "no candidate here\n");
    git(work, ["reset", "-q", "--hard", "HEAD~1"]);
    assert.ok(!isAncestor(work, candidate, wiped), "precondition: the new tip does NOT contain the candidate");

    const outcome = recoverCheckout(
      target,
      base,
      candidate,
      movesRemoteAfterTheRead(() => {
        git(work, ["push", "-q", "--force", "origin", `${wiped}:refs/heads/main`]);
      }),
    );

    assert.notEqual(readTargetSha(target), staleD, "precondition: the remote really did move off D");
    assert.deepEqual(
      outcome,
      { state: "external_writer", currentSha: wiped },
      "recovery must never settle `published` from a target snapshot the fetch has already disproved",
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
